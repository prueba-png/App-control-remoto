// Cambio de tono y timbre en tiempo real dentro del navegador (AudioWorklet).
// Es el mismo algoritmo que el motor "Tono y timbre (DSP)" de la app de
// escritorio: vocoder de fase + envolvente espectral por cepstro, para mover
// el tono (excitación) y el timbre (formantes) por separado.

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function interp(arr, pos, outside) {
  if (pos < 0 || pos > arr.length - 1) return outside;
  const i = Math.floor(pos), f = pos - i;
  return i + 1 < arr.length ? arr[i] * (1 - f) + arr[i + 1] * f : arr[i];
}

class VoiceShifter extends AudioWorkletProcessor {
  constructor() {
    super();
    const N = sampleRate > 30000 ? 2048 : 1024;
    this.N = N;
    this.H = N / 4;
    this.B = N / 2 + 1;
    this.lifter = Math.round(32 * N / 1024);
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    let s = 0;
    for (let i = 0; i < N; i++) s += this.win[i] * this.win[i];
    this.olaNorm = s / this.H;
    this.omega = new Float64Array(this.B);
    for (let k = 0; k < this.B; k++) this.omega[k] = 2 * Math.PI * k / N;

    this.inRing = new Float64Array(N);        // últimas N muestras (anillo)
    this.inPos = 0;                           // posición de la más antigua
    this.newCount = 0;
    this.outAcc = new Float64Array(N);        // acumulador de solapamiento
    this.outFifo = new Float32Array(N * 4);   // salida lista para enviar
    this.outRead = 0;
    this.outWrite = this.H;                   // holgura inicial de un hop
    this.prevPhase = new Float64Array(this.B);
    this.synPhase = new Float64Array(this.B);
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.cr = new Float64Array(N); this.ci = new Float64Array(N);
    this.mag = new Float64Array(this.B); this.inst = new Float64Array(this.B);
    this.logEnv = new Float64Array(this.B); this.exc = new Float64Array(this.B);

    this.alpha = 1; this.beta = 1; this.bypass = false; this.gain = 1;
    this.levelSum = 0; this.levelN = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if ('semitones' in d) this.alpha = Math.pow(2, d.semitones / 12);
      if ('formant' in d) this.beta = d.formant;
      if ('bypass' in d) this.bypass = d.bypass;
      if ('gain' in d) this.gain = d.gain;
      if ('capture' in d) {
        if (!d.capture && this.capBuf && this.capN) this.port.postMessage({ raw: this.capBuf.slice(0, this.capN) });
        this.capBuf = d.capture ? new Float32Array(4096) : null;
        this.capN = 0;
      }
    };
    this.capBuf = null;
    this.capN = 0;
    this.port.postMessage({ ready: true, latency: (this.N + this.H) / sampleRate });
  }

  frame() {
    const { N, H, B, re, im, win } = this;
    for (let i = 0; i < N; i++) { re[i] = this.inRing[(this.inPos + i) % N] * win[i]; im[i] = 0; }
    fft(re, im, false);
    for (let k = 0; k < B; k++) {
      const m = Math.hypot(re[k], im[k]) + 1e-9;
      const ph = Math.atan2(im[k], re[k]);
      let d = ph - this.prevPhase[k] - H * this.omega[k];
      this.prevPhase[k] = ph;
      d = d - 2 * Math.PI * Math.round(d / (2 * Math.PI));
      this.mag[k] = m;
      this.inst[k] = this.omega[k] + d / H;
    }
    const shift = !(this.alpha === 1 && this.beta === 1);
    if (shift) {
      // Envolvente espectral (timbre) por cepstro.
      const { cr, ci } = this;
      for (let k = 0; k < B; k++) { const l = Math.log(this.mag[k]); cr[k] = l; ci[k] = 0; this.exc[k] = l; }
      for (let k = B; k < N; k++) { cr[k] = cr[N - k]; ci[k] = 0; }
      fft(cr, ci, true);
      for (let i = this.lifter; i < N - this.lifter; i++) { cr[i] = 0; ci[i] = 0; }
      fft(cr, ci, false);
      for (let k = 0; k < B; k++) { this.logEnv[k] = cr[k]; this.exc[k] -= cr[k]; }
    }
    for (let k = 0; k < B; k++) {
      let m, f;
      if (shift) {
        const src = k / this.alpha;
        const e = interp(this.exc, src, -20);
        f = this.alpha * interp(this.inst, src, 0);
        const env = interp(this.logEnv, k / this.beta, this.logEnv[B - 1]);
        m = Math.exp(e + env);
      } else {
        m = this.mag[k]; f = this.inst[k];
      }
      this.synPhase[k] += H * f;
      re[k] = m * Math.cos(this.synPhase[k]);
      im[k] = m * Math.sin(this.synPhase[k]);
    }
    for (let k = 1; k < B - 1; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    im[0] = 0; im[B - 1] = 0;
    fft(re, im, true);
    for (let i = 0; i < N; i++) this.outAcc[i] += re[i] * win[i] / this.olaNorm;
    // Las primeras H muestras ya están completas: a la cola de salida.
    const L = this.outFifo.length;
    for (let i = 0; i < H; i++) this.outFifo[(this.outWrite + i) % L] = this.outAcc[i];
    this.outWrite += H;
    this.outAcc.copyWithin(0, H);
    this.outAcc.fill(0, N - H);
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0];
    const n = out[0].length;
    if (!input) { for (const ch of out) ch.fill(0); return true; }
    if (this.capBuf) {
      // Grabación del audio original para la conversión de alta calidad.
      for (let i = 0; i < input.length; i++) {
        this.capBuf[this.capN++] = input[i];
        if (this.capN === this.capBuf.length) {
          this.port.postMessage({ raw: this.capBuf });
          this.capBuf = new Float32Array(4096);
          this.capN = 0;
        }
      }
    }
    for (let i = 0; i < input.length; i++) {
      this.levelSum += input[i] * input[i];
      this.inRing[this.inPos] = input[i];
      this.inPos = (this.inPos + 1) % this.N;
      if (++this.newCount === this.H) { this.newCount = 0; this.frame(); }
    }
    if (++this.levelN >= 40) {
      const rms = Math.sqrt(this.levelSum / (40 * input.length));
      this.port.postMessage({ level: rms });
      this.levelSum = 0; this.levelN = 0;
    }
    const L = this.outFifo.length;
    const ch0 = out[0];
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (this.bypass) v = input[i];
      else if (this.outRead < this.outWrite) v = this.outFifo[this.outRead++ % L];
      ch0[i] = v * this.gain;
    }
    if (this.bypass) this.outRead = this.outWrite;
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    return true;
  }
}

registerProcessor('voice-shifter', VoiceShifter);
