import { Anthropic } from './vendor/anthropic-sdk-0.131.0.js';
import { OfflineAgent } from './offline-agent.js';
import { changeVoice, medianPitch } from './voice-hq.js';
import { listVoices, convert as elConvert, tts as elTts, ElevenLabsError, matchPersona } from './voice-ai.js';

const $ = (id) => document.getElementById(id);

// Si algo falla en segundo plano, que se vea en la transcripción en vez de quedarse mudo.
window.addEventListener('error', (e) => { try { log('error', 'Fallo: ' + (e.message || e.error || e)); } catch {} });
window.addEventListener('unhandledrejection', (e) => { try { log('error', 'Fallo: ' + (e.reason?.message || e.reason || e)); } catch {} });
const store = {
  get(k, d = '') { try { return localStorage.getItem('vozdual:' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vozdual:' + k, v); } catch { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem('vozdual:' + k); } catch { /* idem */ } },
};

// ---------------------------------------------------------------- pestañas
function showTab(agent) {
  $('tabLive').setAttribute('aria-selected', String(!agent));
  $('tabAgent').setAttribute('aria-selected', String(agent));
  $('live').hidden = agent;
  $('agent').hidden = !agent;
}
$('tabLive').onclick = () => showTab(false);
$('tabAgent').onclick = () => showTab(true);

// ---------------------------------------------------------------- registro
function log(kind, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + kind;
  const who = { cliente: 'Cliente (tú)', agente: 'Agente (IA)' }[kind];
  if (who) {
    const b = document.createElement('b');
    b.textContent = who;
    d.append(b);
  }
  d.append(document.createTextNode(text));
  $('log').append(d);
  $('log').scrollTop = $('log').scrollHeight;
}
function status(el, text, error = false) {
  el.textContent = text;
  el.classList.toggle('error', error);
}

// ====================================================== MODO 1: conversión
const live = { ctx: null, stream: null, node: null, gain: null, latency: 0, capture: null };

// Voces: tono objetivo real (Hz) y timbre (formantes). El cambio se calcula a
// partir de TU tono medido, así una voz de mujer suena a mujer partas de donde partas.
const VOICES = {
  original: { name: 'Original', hz: null, formant: 1, intonation: 1, hint: 'Tu voz sin cambios.' },
  mujerAguda: { name: 'Mujer, voz aguda', hz: 235, formant: 1.2, intonation: 1.1, hint: 'Voz femenina joven y clara.' },
  mujer: { name: 'Mujer, voz media', hz: 205, formant: 1.17, intonation: 1.05, hint: 'Voz femenina adulta, la más neutra.' },
  mujerGrave: { name: 'Mujer, voz grave', hz: 175, formant: 1.12, intonation: 1, hint: 'Voz femenina madura y profunda.' },
  nina: { name: 'Niña pequeña', hz: 300, formant: 1.38, intonation: 1.2, hint: 'Habla con frases cortas y entonación alegre.' },
  nino: { name: 'Niño pequeño', hz: 275, formant: 1.32, intonation: 1.15, hint: 'Habla rápido y con frases sencillas.' },
  hombreJoven: { name: 'Hombre joven', hz: 135, formant: 1.03, intonation: 1, hint: 'Voz masculina clara y ligera.' },
  empresario: { name: 'Empresario', hz: 98, formant: 0.93, intonation: 0.85, hint: 'Grave, con cuerpo y entonación firme. Habla despacio y seguro.' },
};
let selectedVoice = 'original';
let userHz = Number(store.get('userHz', '0')) || 0;

function baseHz() {
  return userHz || ($('baseVoice').value === 'f' ? 205 : 115);
}

function showCalibration() {
  $('calibOut').textContent = userHz
    ? `Tu tono medido: ${Math.round(userHz)} Hz (${userHz < 165 ? 'voz grave, de hombre' : 'voz aguda, de mujer'}).`
    : 'Sin medir: se usa un tono típico. Mide tu voz para que las voces salgan más reales.';
  $('baseVoiceRow').hidden = !!userHz;
}

function sendParams() {
  const s = Number($('semi').value), f = Number($('formant').value);
  $('semiOut').value = `${s > 0 ? '+' : ''}${s} semitonos`;
  $('formOut').value = `×${f.toFixed(2)}`;
  live.node?.port.postMessage({ semitones: s, formant: f });
}
$('semi').oninput = sendParams;
$('formant').oninput = sendParams;

function applyVoice(key) {
  selectedVoice = key;
  const v = VOICES[key];
  const semis = v.hz ? 12 * Math.log2(v.hz / baseHz()) : 0;
  $('semi').value = Math.max(-18, Math.min(18, Math.round(semis * 2) / 2));
  $('formant').value = v.formant;
  document.querySelectorAll('#presets .chip').forEach((c) => c.classList.toggle('on', c.dataset.p === key));
  $('presetHint').textContent = `${v.name}: ${v.hint}`;
  sendParams();
}
document.querySelectorAll('#presets .chip').forEach((c) => (c.onclick = () => applyVoice(c.dataset.p)));
$('baseVoice').onchange = () => applyVoice(selectedVoice);
$('monitor').onchange = () => { if (live.gain) live.gain.gain.value = $('monitor').checked ? 1 : 0; };

async function fillMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const sel = $('micSelect');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Micrófono por defecto</option>';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Micrófono ${i + 1}`;
      sel.append(o);
    });
    sel.value = cur;
  } catch { /* sin permiso todavía */ }
}

async function startLive() {
  if (live.ctx) return true;
  const btn = $('liveStart');
  btn.disabled = true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    live.ctx = new AC({ latencyHint: 'interactive' });
    await live.ctx.resume();
    if (!live.ctx.audioWorklet) throw new Error('Este navegador no admite AudioWorklet. Actualiza iOS o usa Chrome/Safari recientes.');
    await live.ctx.audioWorklet.addModule('voice-worklet.js?v=3');
    const mic = $('micSelect').value;
    live.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: mic ? { exact: mic } : undefined, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    const src = live.ctx.createMediaStreamSource(live.stream);
    live.node = new AudioWorkletNode(live.ctx, 'voice-shifter', { outputChannelCount: [1] });
    live.node.port.onmessage = (e) => {
      if (e.data.latency) live.latency = e.data.latency;
      if (e.data.level != null) $('level').style.width = Math.min(100, e.data.level * 400) + '%';
      if (e.data.raw && live.capture) live.capture.push(e.data.raw);
    };
    live.gain = live.ctx.createGain();
    live.gain.gain.value = $('monitor').checked ? 1 : 0;
    src.connect(live.node);
    live.node.connect(live.gain).connect(live.ctx.destination);
    sendParams();
    await fillMics();
    setTimeout(() => {
      if (!live.ctx) return;
      const ms = ((live.ctx.baseLatency || 0) + (live.ctx.outputLatency || 0) + live.latency) * 1000;
      status($('liveStatus'), `Micrófono activo · retraso en directo ≈ ${Math.round(ms)} ms`);
    }, 300);
    status($('liveStatus'), 'Micrófono activo.');
    btn.textContent = 'Detener micrófono';
    btn.onclick = stopLive;
    return true;
  } catch (e) {
    status($('liveStatus'), micError(e), true);
    stopLive();
    return false;
  } finally {
    btn.disabled = false;
  }
}

function stopLive() {
  live.stream?.getTracks().forEach((t) => t.stop());
  live.ctx?.close().catch(() => {});
  Object.assign(live, { ctx: null, stream: null, node: null, gain: null, capture: null });
  $('level').style.width = '0';
  const btn = $('liveStart');
  btn.textContent = 'Activar micrófono';
  btn.onclick = startLive;
  if (!$('liveStatus').classList.contains('error')) status($('liveStatus'), 'Micrófono apagado.');
}
$('liveStart').onclick = startLive;

function micError(e) {
  if (e && e.name === 'NotAllowedError') return 'Permiso de micrófono denegado. Actívalo en Ajustes → Safari → Micrófono y recarga.';
  if (e && e.name === 'NotFoundError') return 'No se encontró ningún micrófono.';
  return 'No se pudo iniciar: ' + (e?.message || e);
}

/** Graba `seconds` de audio original del micrófono. Devuelve {audio, sr}. */
async function recordRaw(seconds, onTick) {
  if (!(await startLive())) return null;
  live.capture = [];
  live.node.port.postMessage({ capture: true });
  for (let s = seconds; s > 0; s--) {
    onTick(s);
    await new Promise((r) => setTimeout(r, 1000));
  }
  live.node?.port.postMessage({ capture: false });
  await new Promise((r) => setTimeout(r, 150));
  const chunks = live.capture || [];
  const sr = live.ctx?.sampleRate || 48000;
  live.capture = null;
  const audio = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { audio.set(c, o); o += c.length; }
  return { audio, sr };
}

$('calibBtn').onclick = async () => {
  const btn = $('calibBtn');
  btn.disabled = true;
  const rec = await recordRaw(4, (s) => { btn.textContent = `Habla normal… ${s}`; });
  btn.disabled = false;
  btn.textContent = '🎤 Medir mi voz';
  if (!rec) return;
  const hz = medianPitch(rec.audio, rec.sr);
  if (!hz || hz < 70 || hz > 350) {
    status($('liveStatus'), 'No he podido medir bien tu voz. Prueba otra vez hablando de forma continua 4 segundos, sin ruido de fondo.', true);
    return;
  }
  userHz = hz;
  store.set('userHz', String(Math.round(hz)));
  showCalibration();
  applyVoice(selectedVoice);
  status($('liveStatus'), 'Voz medida. Elige una voz y graba.');
};

/** Ecualización suave según la voz (más brillo en mujer/niños, más cuerpo en hombre). */
async function finish(audio, sr, key) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC || key === 'original') return audio;
  const ctx = new OAC(1, audio.length, sr);
  const buf = ctx.createBuffer(1, audio.length, sr);
  buf.copyToChannel(audio, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  const shelf = ctx.createBiquadFilter();
  const v = VOICES[key];
  if (v.formant >= 1.1) {
    hp.frequency.value = 160;
    shelf.type = 'highshelf'; shelf.frequency.value = 3500; shelf.gain.value = 3;
  } else if (v.formant < 1) {
    hp.frequency.value = 60;
    shelf.type = 'lowshelf'; shelf.frequency.value = 180; shelf.gain.value = 3;
  } else {
    hp.frequency.value = 80;
    shelf.type = 'peaking'; shelf.gain.value = 0;
  }
  src.connect(hp).connect(shelf).connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

function toWav(audio, sr) {
  const buf = new ArrayBuffer(44 + audio.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + audio.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, audio.length * 2, true);
  for (let i = 0; i < audio.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, audio[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

$('recBtn').onclick = async () => {
  const btn = $('recBtn');
  btn.disabled = true;
  const rec = await recordRaw(Number($('recSecs').value), (s) => { btn.textContent = `Grabando… ${s}`; });
  btn.textContent = 'Convirtiendo…';
  stopLive(); // en iPhone, con el micrófono abierto el sonido sale muy bajo
  try {
    if (!rec || !rec.audio.length) throw new Error('No se grabó audio.');
    const v = VOICES[selectedVoice];
    let out = rec.audio;
    const pitchRatio = Math.pow(2, Number($('semi').value) / 12);
    const formant = Number($('formant').value);
    if (Math.abs(pitchRatio - 1) > 0.01 || Math.abs(formant - 1) > 0.01) {
      out = changeVoice(rec.audio, rec.sr, { pitchRatio, formant, intonation: v.intonation });
    }
    out = await finish(out, rec.sr, selectedVoice);
    const a = $('playback');
    a.src = URL.createObjectURL(toWav(out, rec.sr));
    a.hidden = false;
    a.play().catch(() => {});
    status($('liveStatus'), `Listo: así suena «${v.name}». Puedes volver a escucharlo o descargarlo desde el reproductor.`);
  } catch (e) {
    status($('liveStatus'), 'No se pudo convertir: ' + (e?.message || e), true);
  }
  btn.textContent = '● Grabar y convertir';
  btn.disabled = false;
};

// ---- Voz realista con IA (ElevenLabs) --------------------------------------
$('elKey').value = store.get('elKey', '');
$('elRemember').checked = !!store.get('elKey');
$('elRemember').onchange = () => { if (!$('elRemember').checked) store.del('elKey'); else store.set('elKey', $('elKey').value.trim()); };
$('elKey').onchange = () => { if ($('elRemember').checked) store.set('elKey', $('elKey').value.trim()); };

let elVoices = [];

document.querySelectorAll('#elPersonas .chip').forEach((c) => (c.onclick = () => {
  if (!elVoices.length) { status($('elStatus'), 'Pulsa «Cargar mis voces» primero.', true); return; }
  const { voice, score } = matchPersona(elVoices, c.dataset.p);
  if (!voice) { status($('elStatus'), 'No encuentro una voz para eso.', true); return; }
  $('elVoice').value = voice.id;
  store.set('elVoiceId', voice.id);
  document.querySelectorAll('#elPersonas .chip').forEach((x) => x.classList.toggle('on', x === c));
  const warn = score < 3 ? ' (tu biblioteca no tiene una voz muy parecida; prueba a añadir una en ElevenLabs)' : '';
  status($('elStatus'), `Voz elegida: ${voice.name}.${warn}`);
}));

$('elLoad').onclick = async () => {
  const key = $('elKey').value.trim();
  if (!key) { status($('elStatus'), 'Pon tu clave de ElevenLabs.', true); return; }
  if ($('elRemember').checked) store.set('elKey', key);
  const btn = $('elLoad');
  btn.disabled = true; btn.textContent = 'Cargando…';
  try {
    const voices = await listVoices(key);
    elVoices = voices;
    const sel = $('elVoice');
    sel.innerHTML = '';
    const groups = {};
    for (const v of voices) (groups[v.group] ||= []).push(v);
    for (const [g, list] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = g;
      for (const v of list) {
        const o = document.createElement('option');
        o.value = v.id;
        const tag = [v.labels.gender, v.labels.age].filter(Boolean).join(', ');
        o.textContent = tag ? `${v.name} (${tag})` : v.name;
        og.append(o);
      }
      sel.append(og);
    }
    const saved = store.get('elVoiceId');
    if (saved && voices.some((v) => v.id === saved)) sel.value = saved;
    $('elPersonas').hidden = false;
    status($('elStatus'), `${voices.length} voces cargadas. Toca una persona o elige una voz y graba.`);
  } catch (e) {
    status($('elStatus'), e instanceof ElevenLabsError ? e.message : 'No se pudieron cargar las voces: ' + (e?.message || e), true);
  } finally {
    btn.disabled = false; btn.textContent = 'Cargar mis voces';
  }
};
$('elVoice').onchange = () => store.set('elVoiceId', $('elVoice').value);

$('elRec').onclick = async () => {
  const key = $('elKey').value.trim();
  const voiceId = $('elVoice').value;
  if (!key) { status($('elStatus'), 'Pon tu clave de ElevenLabs.', true); return; }
  if (!voiceId) { status($('elStatus'), 'Pulsa «Cargar mis voces» y elige una voz.', true); return; }
  const btn = $('elRec');
  btn.disabled = true;
  const rec = await recordRaw(Number($('elSecs').value), (sec) => { btn.textContent = `Grabando… ${sec}`; });
  stopLive();
  btn.textContent = 'Convirtiendo con IA…';
  status($('elStatus'), 'Enviando a ElevenLabs… (unos segundos)');
  try {
    if (!rec || !rec.audio.length) throw new Error('No se grabó audio.');
    const wav = toWav(rec.audio, rec.sr);
    const out = await elConvert(key, voiceId, wav);
    const a = $('elOut');
    a.src = URL.createObjectURL(out);
    a.hidden = false;
    a.play().catch(() => {});
    status($('elStatus'), 'Listo. Puedes volver a escucharlo o descargarlo desde el reproductor.');
  } catch (e) {
    status($('elStatus'), e instanceof ElevenLabsError ? e.message : 'No se pudo convertir: ' + (e?.message || e), true);
  } finally {
    btn.disabled = false; btn.textContent = '● Grabar y convertir con IA';
  }
};

showCalibration();
applyVoice('original');

// ====================================================== MODO 2: agente
const EXAMPLE_SCRIPT = `Empresa: Energía Clara.
Apertura: Le llamo porque pidió información en nuestra web sobre placas solares. ¿Tiene dos minutos?
Objetivo: agendar una visita técnica gratuita sobre placas solares.

1. Pregunta si vive en una casa con tejado propio y cuánto paga de luz al mes.
2. Explica que el ahorro típico es de un 40 a un 60 % en la factura.
3. Propón una visita técnica gratuita y sin compromiso y pide día y franja horaria.
4. Confirma y despídete.

Si dice que es caro: la visita y el estudio son gratis; el asesor calcula el ahorro real.
No des precios cerrados ni pidas datos bancarios.`;

$('script').value = store.get('script', EXAMPLE_SCRIPT);
$('script').onchange = () => store.set('script', $('script').value);
$('apiKey').value = store.get('apiKey');
$('rememberKey').checked = !!store.get('apiKey');
$('rememberKey').onchange = () => (!$('rememberKey').checked ? store.del('apiKey') : store.set('apiKey', $('apiKey').value.trim()));
$('apiKey').onchange = () => $('rememberKey').checked && store.set('apiKey', $('apiKey').value.trim());

const END = '[FIN]';

function scriptCompany(text) {
  const m = text.match(/^\s*empresa\s*:\s*(.+)$/im);
  return m ? m[1].trim().replace(/\.$/, '') : '';
}

function agentName() {
  return $('agentName').value.trim();
}

function openingLine(text) {
  const company = scriptCompany(text);
  const m = text.match(/^\s*apertura\s*:\s*(.+)$/im);
  const who = agentName() ? `soy ${agentName()}, asistente virtual` : 'le habla un asistente virtual';
  const disclosure = `Hola, ${who} con inteligencia artificial${company ? ' de ' + company : ''}.`;
  if (!m) return disclosure + ' ¿Tiene un momento?';
  const opening = m[1].trim();
  return /(asistente virtual|inteligencia artificial|\bIA\b)/i.test(opening) ? opening : `${disclosure} ${opening}`;
}

function systemPrompt(text, opening) {
  const company = scriptCompany(text) || 'la empresa';
  const name = agentName() || 'el asistente';
  return `Eres ${name}, asistente de voz con inteligencia artificial, y estás en una llamada telefónica en nombre de ${company}.
Tu objetivo y la información que puedes usar están en el guion de abajo.

Sigue el guion (esto es lo más importante):
- Céntrate en el objetivo y los pasos del guion, en su orden. No te desvíes a otros temas ni cambies de asunto por tu cuenta.
- Escucha lo que la persona acaba de decir y respóndele primero; luego sigue con el paso del guion que toca. No te saltes pasos ni te adelantes varios a la vez.
- Si la persona se va por las ramas o pregunta algo fuera del guion, contéstale breve y con educación y vuelve enseguida al paso en el que estabas.
- No inventes contenido nuevo que no esté en el guion: cíñete a lo que el guion dice.

Cómo hablas:
- Como una buena comercial al teléfono: cercana, natural y segura, sin sonar a lectura. Usa expresiones normales («claro», «entiendo», «perfecto») sin abusar.
- Una idea y como mucho una pregunta por turno. Frases cortas: esto se convierte en voz.
- Recuerda lo que te cuentan (nombre, situación, horarios) y úsalo después.
- Adapta el ritmo: si es breve, sé breve; si tiene dudas, explica con calma.
- Sin listas, sin emojis, sin markdown. Los números y precios, escritos como se dicen.
- Responde en el idioma de la otra persona (por defecto, español).

Límites que no se negocian:
- Eres una IA. Ya lo has dicho en la apertura, una vez y de forma natural; no hace falta repetirlo salvo que te pregunten. Si te preguntan si eres una persona o un robot, dilo con naturalidad («soy un asistente virtual»). No digas nunca que eres una persona.
- No inventes datos, precios ni condiciones que no estén en el guion.
- Si la persona dice que no le interesa o pide que no la llamen más, despídete con amabilidad, confirma que se respetará y termina.
- No presiones, no uses urgencias falsas y no pidas contraseñas ni datos bancarios.
- Cuando la conversación haya terminado, escribe ${END} al final de tu última respuesta.

Ya has dicho esta apertura al descolgar: «${opening}»

Guion:
${text}`;
}

// --- voz sintética del sistema
// Puntúa las voces: primero las de mayor calidad (Premium/Mejorada) y de España.
function voiceScore(v) {
  let sc = 0;
  if (/premium/i.test(v.name)) sc += 30;
  if (/enhanced|mejorada|neural|natural/i.test(v.name)) sc += 20;
  if (v.lang === 'es-ES') sc += 5;
  if (!v.localService) sc += 2;
  return sc;
}
function esVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('es')).sort((a, b) => voiceScore(b) - voiceScore(a));
}
function fillVoices() {
  const sel = $('voiceSelect');
  const voices = esVoices();
  const saved = store.get('voice');
  sel.innerHTML = '';
  if (!voices.length) {
    sel.innerHTML = '<option value="">Voz por defecto del sistema</option>';
    return;
  }
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.name;
    const q = /premium/i.test(v.name) ? ' · Premium' : /enhanced|mejorada/i.test(v.name) ? ' · Mejorada' : '';
    o.textContent = `${v.name} (${v.lang})${q}`;
    sel.append(o);
  }
  sel.value = voices.some((v) => v.name === saved) ? saved : voices[0].name;
}
function currentVoice() {
  return esVoices().find((v) => v.name === $('voiceSelect').value) || null;
}
if ('speechSynthesis' in window) {
  fillVoices();
  speechSynthesis.onvoiceschanged = fillVoices;
}
$('voiceSelect').onchange = () => store.set('voice', $('voiceSelect').value);
$('rate').value = store.get('rate', '1');
$('rateOut').value = `×${Number($('rate').value).toFixed(2)}`;
$('rate').oninput = () => { $('rateOut').value = `×${Number($('rate').value).toFixed(2)}`; store.set('rate', $('rate').value); };
$('agentName').value = store.get('agentName', 'Laura');
$('agentName').onchange = () => store.set('agentName', $('agentName').value.trim());

// ---- Voz del agente: realista (ElevenLabs) o del sistema -------------------
const agentAudio = new Audio(); // un solo elemento, se desbloquea al pulsar
function useElevenVoice() {
  return $('voiceEngine').value === 'eleven' && $('elAgentKey').value.trim() && $('elAgentVoice').value;
}
function applyVoiceEngine() {
  const el = $('voiceEngine').value === 'eleven';
  $('elAgentBox').hidden = !el;
  $('sysAgentBox').hidden = el;
  store.set('voiceEngine', $('voiceEngine').value);
}
$('voiceEngine').value = store.get('voiceEngine', 'eleven');
$('voiceEngine').onchange = applyVoiceEngine;
applyVoiceEngine();

$('elAgentKey').value = store.get('elKey', '');
$('elAgentKey').onchange = () => store.set('elKey', $('elAgentKey').value.trim());
$('elAgentLoad').onclick = async () => {
  const key = $('elAgentKey').value.trim();
  if (!key) { status($('agentStatus'), 'Pon tu clave de ElevenLabs.', true); return; }
  store.set('elKey', key);
  const btn = $('elAgentLoad');
  btn.disabled = true; btn.textContent = 'Cargando…';
  try {
    const voices = await listVoices(key);
    const sel = $('elAgentVoice');
    sel.innerHTML = '';
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.id;
      const tag = [v.labels.gender, v.labels.age].filter(Boolean).join(', ');
      o.textContent = tag ? `${v.name} (${tag})` : v.name;
      sel.append(o);
    }
    const saved = store.get('agentVoiceId');
    if (saved && voices.some((v) => v.id === saved)) sel.value = saved;
    status($('agentStatus'), `${voices.length} voces cargadas. Elige la voz del agente.`);
  } catch (e) {
    status($('agentStatus'), e instanceof ElevenLabsError ? e.message : 'No se pudieron cargar las voces: ' + (e?.message || e), true);
  } finally {
    btn.disabled = false; btn.textContent = 'Cargar voces';
  }
};
$('elAgentVoice').onchange = () => store.set('agentVoiceId', $('elAgentVoice').value);

$('testVoice').onclick = () => {
  unlockSpeech();
  try { agentAudio.play().catch(() => {}); agentAudio.pause(); } catch { /* nada */ }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  speak(`Hola, soy ${agentName() || 'tu asistente'}. Así sonará mi voz durante la llamada.`);
};

async function speakEleven(text) {
  const blob = await elTts($('elAgentKey').value.trim(), $('elAgentVoice').value, text);
  await new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    agentAudio.src = url;
    agentAudio.onended = agentAudio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
    agentAudio.play().catch(() => resolve());
  });
}

function speakSystem(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const u = new SpeechSynthesisUtterance(text);
    const v = currentVoice();
    u.lang = v?.lang || 'es-ES';
    if (v) u.voice = v;
    u.rate = Number($('rate').value) || 1;
    u.onend = u.onerror = finish;
    const maxMs = Math.min(30000, 2500 + text.length * 120);
    const timer = setTimeout(finish, maxMs);
    try {
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      speechSynthesis.resume();
    } catch { finish(); }
  });
}

async function speak(text) {
  if (!text) return;
  if (useElevenVoice()) {
    try { await speakEleven(text); return; }
    catch (e) { log('error', 'Voz realista no disponible, uso la del sistema: ' + (e?.message || e)); }
  }
  await speakSystem(text);
}

// --- reconocimiento de voz del sistema
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const call = { client: null, messages: [], system: '', active: false, busy: false, rec: null };

// Selector Con Claude / Gratis. Por defecto, Con Claude (la clave siempre visible).
function setAgentMode(free) {
  $('freeMode').checked = free;
  document.querySelectorAll('#agentMode button').forEach((b) =>
    b.setAttribute('aria-selected', String((b.dataset.mode === 'free') === free)));
  $('claudeBox').hidden = free;
  $('freeHint').hidden = !free;
}
document.querySelectorAll('#agentMode button').forEach((b) =>
  (b.onclick = () => setAgentMode(b.dataset.mode === 'free')));
setAgentMode(false);

$('callStart').onclick = () => {
  try {
    const free = $('freeMode').checked;
    const key = $('apiKey').value.trim();
    if (!free && !key) {
      status($('agentStatus'), 'Pega tu clave de Claude (sk-ant-…) en el recuadro de arriba, o pulsa «Gratis».', true);
      return;
    }
    if (!free && !/^sk-ant-/.test(key)) {
      status($('agentStatus'), 'Esa clave no parece de Claude (debe empezar por sk-ant-).', true);
      return;
    }
    if (!free && $('rememberKey').checked) store.set('apiKey', key);
    // Desbloquea la voz del sistema dentro del toque del usuario (obligatorio en iPhone).
    unlockSpeech();
    const text = $('script').value.trim() || EXAMPLE_SCRIPT;
    const opening = openingLine(text);
    call.offline = free ? new OfflineAgent(text) : null;
    call.client = free ? null : new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    call.system = systemPrompt(text, opening);
    call.messages = [];
    call.active = true;
    call.busy = false;
    $('log').innerHTML = '';
    log('info', free ? 'Llamada de prueba (modo gratis, sin IA). El agente descuelga…' : 'Llamada iniciada. El agente descuelga…');
    log('agente', opening);
    emptyTurns = 0;
    $('callStart').disabled = true;
    $('callEnd').disabled = false;
    $('talkBtn').hidden = !SR;
    $('talkBtn').disabled = !SR;
    $('typeForm').hidden = !!SR;
    status($('agentStatus'), 'El agente está hablando…');
    speak(opening).then(() => {
      if (!call.active) return;
      if (SR) listenNext();
      else status($('agentStatus'), 'Tu turno: escribe tu respuesta abajo y pulsa «Decir».');
    });
  } catch (e) {
    log('error', 'No se pudo empezar la llamada: ' + (e?.message || e));
    status($('agentStatus'), 'No se pudo empezar la llamada: ' + (e?.message || e), true);
    $('callStart').disabled = false;
  }
};

// En iPhone la voz del sistema solo "despierta" si se llama dentro de un toque.
let speechUnlocked = false;
const SILENT_MP3 = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
function unlockSpeech() {
  // Audio de ElevenLabs: hay que "despertar" el reproductor dentro del toque.
  try {
    agentAudio.src = SILENT_MP3;
    agentAudio.play().then(() => agentAudio.pause()).catch(() => {});
  } catch { /* nada */ }
  if (speechUnlocked || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
    speechUnlocked = true;
  } catch { /* nada */ }
}

$('callEnd').onclick = () => endCall('Has colgado.');

function endCall(msg) {
  call.active = false;
  call.rec?.abort();
  try { agentAudio.pause(); } catch {}
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  $('callStart').disabled = false;
  $('callEnd').disabled = true;
  $('talkBtn').disabled = true;
  $('talkBtn').classList.remove('listening');
  $('talkBtn').textContent = '🎙 Hablar';
  log('info', msg);
  status($('agentStatus'), 'Llamada terminada.');
}

let emptyTurns = 0;

function listenNext() {
  if (!call.active || call.busy || !SR) return;
  if ($('handsFree').checked) startListening(true);
  else status($('agentStatus'), 'Tu turno: pulsa «Hablar».');
}

function startListening(auto = false) {
  if (call.rec || !call.active || call.busy) return;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const rec = new SR();
  rec.lang = 'es-ES';
  rec.interimResults = true;
  rec.continuous = false; // termina sola cuando dejas de hablar
  let finalText = '';
  let denied = false;
  rec.onresult = (e) => {
    let interim = '';
    for (const r of e.results) (r.isFinal ? (finalText = r[0].transcript) : (interim += r[0].transcript));
    status($('agentStatus'), '🎙 ' + (finalText || interim || 'Escuchando…'));
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      denied = true;
      status($('agentStatus'), auto
        ? 'Safari no deja escuchar solo: pulsa «Hablar» en cada turno (o activa Siri y Dictado en Ajustes).'
        : 'Safari no permite el dictado. Activa Siri y Dictado en Ajustes, o escribe tu respuesta.', true);
      if (!auto) $('typeForm').hidden = false;
    }
  };
  rec.onend = () => {
    call.rec = null;
    $('talkBtn').classList.remove('listening');
    $('talkBtn').textContent = '🎙 Hablar';
    if (finalText.trim()) {
      emptyTurns = 0;
      handleUser(finalText.trim());
    } else if (call.active && !call.busy && !denied) {
      emptyTurns += 1;
      if (auto && $('handsFree').checked && emptyTurns < 3) startListening(true);
      else status($('agentStatus'), 'No te he oído. Pulsa «Hablar» cuando quieras contestar.');
    }
  };
  call.rec = rec;
  $('talkBtn').classList.add('listening');
  $('talkBtn').textContent = '■ Terminar de hablar';
  status($('agentStatus'), '🎙 Te escucho… habla cuando quieras.');
  try {
    rec.start();
  } catch {
    call.rec = null;
    $('talkBtn').classList.remove('listening');
    $('talkBtn').textContent = '🎙 Hablar';
    status($('agentStatus'), 'Pulsa «Hablar» para contestar.');
  }
}

$('talkBtn').onclick = () => {
  if (call.rec) { call.rec.stop(); return; }
  emptyTurns = 0;
  startListening(false);
};

$('typeForm').onsubmit = (e) => {
  e.preventDefault();
  const t = $('typeInput').value.trim();
  if (t && call.active && !call.busy) { $('typeInput').value = ''; handleUser(t); }
};

function splitSentences(buf) {
  const parts = buf.split(/(?<=[.!?…])\s+|\n+/);
  return { done: parts.slice(0, -1).map((s) => s.trim()).filter(Boolean), rest: parts[parts.length - 1] };
}

async function handleUser(text) {
  if (!call.active || call.busy) return;
  call.busy = true;
  $('talkBtn').disabled = true;
  log('cliente', text);
  status($('agentStatus'), 'El agente piensa…');
  call.messages.push({ role: 'user', content: text });
  let speaking = Promise.resolve();
  let finished = false;
  const say = (s) => {
    if (s.includes(END)) { finished = true; s = s.replace(END, '').trim(); }
    if (!s) return;
    log('agente', s);
    status($('agentStatus'), 'El agente está hablando…');
    speaking = speaking.then(() => (call.active ? speak(s) : null));
  };
  const t0 = performance.now();
  if (call.offline) {
    await new Promise((r) => setTimeout(r, 400)); // pausa breve, como alguien que piensa
    call.offline.reply(text).forEach(say);
    call.messages.pop();
  } else try {
    const stream = call.client.beta.messages.stream({
      model: $('model').value.trim() || 'claude-opus-5-5',
      max_tokens: 1024, // respuestas habladas, deliberadamente cortas
      system: call.system,
      messages: call.messages,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    let buf = '';
    let first = true;
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        if (first) { log('info', `Primera palabra en ${((performance.now() - t0) / 1000).toFixed(1)} s`); first = false; }
        buf += ev.delta.text;
        const { done, rest } = splitSentences(buf);
        done.forEach(say);
        buf = rest;
      }
    }
    if (buf.trim()) say(buf.trim());
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      say('Lo siento, con eso no puedo ayudarle. Si quiere, le paso con una persona del equipo.');
      call.messages.push({ role: 'assistant', content: 'Lo siento, con eso no puedo ayudarle.' });
    } else if (final.content.some((b) => b.type === 'fallback')) {
      const t = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('') || '…';
      call.messages.push({ role: 'assistant', content: t });
    } else {
      call.messages.push({ role: 'assistant', content: final.content });
    }
  } catch (e) {
    call.messages.pop();
    log('error', apiError(e));
  }
  await speaking;
  call.busy = false;
  if (!call.active) return;
  if (finished) return endCall('El agente ha cerrado la conversación.');
  $('talkBtn').disabled = !SR;
  if (SR) { listenNext(); }
  else { $('typeForm').hidden = false; status($('agentStatus'), 'Tu turno: escribe tu respuesta y pulsa «Decir».'); }
}

function apiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'La clave de Claude no es válida.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Tu clave no tiene permiso para este modelo.';
  if (e instanceof Anthropic.NotFoundError) return 'Ese modelo no existe. Revisa el nombre del modelo.';
  if (e instanceof Anthropic.RateLimitError) return 'Demasiadas peticiones o sin saldo. Espera un momento o revisa tu cuenta.';
  if (e instanceof Anthropic.APIConnectionError) return 'Sin conexión con la API de Claude.';
  if (e instanceof Anthropic.APIError) return `Error de la API de Claude (${e.status ?? '?'}): ${e.message}`;
  return 'Error: ' + (e?.message || e);
}
