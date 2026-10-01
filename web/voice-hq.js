// Conversión de voz de alta calidad (no en tiempo real) y medición del tono.
//
// Método "cambio de género" de Praat:
//   1. Se remuestrea el audio por un factor β: sube (o baja) los formantes,
//      que es lo que hace que una voz suene a persona más pequeña o más grande.
//   2. Con PSOLA (solapamiento síncrono con el tono) se lleva el tono al
//      objetivo y se recupera la duración original.
// Conserva la entonación natural de quien habla y suena mucho menos
// "metálico" que el cambio de tono por espectro.

/** F0 con YIN sobre audio ya a 16 kHz. Devuelve {f0: Float32Array, hop}. 0 = sordo. */
export function yinTrack(x16, hop = 160, fmin = 60, fmax = 600, threshold = 0.15) {
  const sr = 16000;
  const tauMin = Math.floor(sr / fmax);
  const tauMax = Math.floor(sr / fmin);
  const W = tauMax;
  const nFrames = Math.max(0, Math.floor((x16.length - W - tauMax - 1) / hop) + 1);
  const f0 = new Float32Array(nFrames);
  const d = new Float64Array(tauMax + 1);
  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hop;
    let energy = 0;
    for (let j = 0; j < W; j++) energy += x16[start + j] * x16[start + j];
    if (energy / W < 1e-5) continue; // silencio
    d[0] = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const diff = x16[start + j] - x16[start + j + tau];
        s += diff * diff;
      }
      d[tau] = s;
    }
    let cum = 0;
    let found = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      cum += d[tau];
      d[tau] = cum > 0 ? (d[tau] * tau) / cum : 1;
      if (found < 0 && tau >= tauMin && d[tau] < threshold) found = tau;
      if (found >= 0 && tau > found && d[tau] >= d[tau - 1]) { found = tau - 1; break; }
    }
    if (found < 0) continue;
    let period = found;
    if (found > 1 && found < tauMax) {
      const a = d[found - 1], b = d[found], c = d[found + 1];
      const den = a - 2 * b + c;
      if (Math.abs(den) > 1e-12) period += Math.max(-1, Math.min(1, (0.5 * (a - c)) / den));
    }
    f0[fi] = sr / period;
  }
  // Limpieza: quita valores sueltos (octavas erróneas) con una mediana de 5.
  const out = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const win = [];
    for (let k = -2; k <= 2; k++) if (f0[i + k] > 0) win.push(f0[i + k]);
    out[i] = f0[i] > 0 && win.length >= 3 ? win.sort((p, q) => p - q)[win.length >> 1] : f0[i] > 0 && win.length ? f0[i] : 0;
  }
  return { f0: out, hop };
}

/** Remuestreo lineal: y[n] = x(n * step). */
export function resampleLinear(x, step) {
  const n = Math.floor((x.length - 1) / step);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const k = Math.floor(p);
    const f = p - k;
    y[i] = x[k] * (1 - f) + x[k + 1] * f;
  }
  return y;
}

/** Remuestreo con filtro paso bajo previo cuando se reduce la frecuencia (anti-aliasing). */
export function resample(x, fromSr, toSr) {
  if (fromSr === toSr) return x;
  const step = fromSr / toSr;
  let src = x;
  if (step > 1) src = lowpass(x, (0.45 * toSr) / fromSr);
  return resampleLinear(src, step);
}

/** Paso bajo FIR (ventana de Hann). cutoff relativo a la frecuencia de muestreo (0–0.5). */
function lowpass(x, cutoff, taps = 63) {
  const h = new Float32Array(taps);
  const m = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - m;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    h[i] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const y = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const idx = n + k - m;
      if (idx >= 0 && idx < x.length) acc += h[k] * x[idx];
    }
    y[n] = acc;
  }
  return y;
}

/** Tono medio (mediana) de quien habla, en Hz, o 0 si no hay voz suficiente. */
export function medianPitch(x, sr) {
  const { f0 } = yinTrack(resample(x, sr, 16000));
  const v = Array.from(f0).filter((f) => f > 0).sort((a, b) => a - b);
  return v.length >= 10 ? v[v.length >> 1] : 0;
}

/**
 * Cambia la voz.
 * @param {Float32Array} x  audio mono
 * @param {number} sr       frecuencia de muestreo
 * @param {{pitchRatio:number, formant:number, intonation?:number}} o
 *   pitchRatio: multiplicador del tono (2 = una octava arriba)
 *   formant:    multiplicador de formantes (1.2 = voz de persona más pequeña)
 *   intonation: 1 = conserva la melodía de la frase; <1 la aplana, >1 la exagera
 */
export function changeVoice(x, sr, { pitchRatio, formant, intonation = 1 }) {
  const beta = formant;
  // Contorno de F0 del original (a 100 fps) e interpolación en el tiempo.
  const { f0, hop } = yinTrack(resample(x, sr, 16000));
  const fps = 16000 / hop;
  const voicedVals = Array.from(f0).filter((f) => f > 0).sort((a, b) => a - b);
  const median = voicedVals.length ? voicedVals[voicedVals.length >> 1] : 120;
  const f0At = (t) => {
    const p = t * fps;
    const i = Math.floor(p);
    if (i < 0 || i + 1 >= f0.length) return 0;
    const a = f0[i], b = f0[i + 1];
    if (a <= 0 || b <= 0) return a > 0 && p - i < 0.5 ? a : b > 0 && p - i >= 0.5 ? b : 0;
    return a + (b - a) * (p - i);
  };
  const targetF0 = (t) => {
    const f = f0At(t);
    if (!f) return 0;
    const shaped = median * Math.pow(f / median, intonation);
    return shaped * pitchRatio;
  };

  // 1) Formantes: y(t') = x(t'·β). En y el tono es β·f0 y la duración, /β.
  const y = resampleLinear(x, beta);

  // 2) PSOLA sobre y, con escala de tiempo β para volver a la duración original.
  const N = x.length;
  const out = new Float32Array(N + sr);
  const norm = new Float32Array(N + sr);
  const unvoicedStep = Math.round(0.005 * sr);

  // Marcas de análisis en y (síncronas con el tono en tramos sonoros).
  const marks = [];
  for (let m = 0; m < y.length; ) {
    marks.push(m);
    const tOrig = (m * beta) / sr;
    const f = f0At(tOrig);
    m += f ? Math.max(8, Math.round(sr / (f * beta))) : unvoicedStep;
  }
  const nearestMark = (pos) => {
    let lo = 0, hi = marks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid] < pos) lo = mid + 1; else hi = mid;
    }
    return lo > 0 && pos - marks[lo - 1] < marks[lo] - pos ? marks[lo - 1] : marks[lo];
  };

  // Marcas de síntesis en la salida, separadas por el periodo objetivo.
  for (let s = 0; s < N; ) {
    const t = s / sr;
    const ft = targetF0(t);
    const fo = f0At(t);
    const m = nearestMark(s / beta);
    // Medio grano = periodo de análisis en y (o 5 ms si es sordo).
    const half = fo ? Math.max(8, Math.round(sr / (fo * beta))) : unvoicedStep;
    for (let k = -half; k <= half; k++) {
      const src = m + k;
      const dst = s + k;
      if (src < 0 || src >= y.length || dst < 0) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / half);
      out[dst] += y[src] * w;
      norm[dst] += w;
    }
    s += ft ? Math.max(8, Math.round(sr / ft)) : unvoicedStep;
  }
  const res = new Float32Array(N);
  let peak = 0;
  for (let i = 0; i < N; i++) {
    res[i] = norm[i] > 0.1 ? out[i] / norm[i] : out[i];
    peak = Math.max(peak, Math.abs(res[i]));
  }
  if (peak > 0.98) for (let i = 0; i < N; i++) res[i] *= 0.98 / peak;
  return res;
}
