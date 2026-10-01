import { Anthropic } from './vendor/anthropic-sdk-0.131.0.js';
import { OfflineAgent } from './offline-agent.js';

const $ = (id) => document.getElementById(id);
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
const live = { ctx: null, stream: null, node: null, gain: null, dest: null, latency: 0 };

function sendParams() {
  const s = Number($('semi').value), f = Number($('formant').value);
  $('semiOut').value = `${s > 0 ? '+' : ''}${s} semitonos`;
  $('formOut').value = `×${f.toFixed(2)}`;
  live.node?.port.postMessage({ semitones: s, formant: f });
}
$('semi').oninput = sendParams;
$('formant').oninput = sendParams;
// Voces predefinidas: [semitonos, timbre] según si tu voz real es de hombre o de mujer.
// El tono marca lo agudo o grave; el timbre (formantes) el "tamaño" de quien habla.
const PRESETS = {
  original: { name: 'Original', m: [0, 1], f: [0, 1], hint: 'Tu voz sin cambios.' },
  mujer: { name: 'Mujer', m: [5, 1.17], f: [1, 1.03], hint: 'Tono más agudo y timbre más ligero.' },
  nino: { name: 'Niño pequeño', m: [8, 1.3], f: [3, 1.14], hint: 'Agudo y con timbre pequeño. Habla rápido y con frases cortas para que suene más natural.' },
  nina: { name: 'Niña pequeña', m: [10, 1.38], f: [5, 1.2], hint: 'La más aguda. Sube un poco la entonación al hablar.' },
  empresario: { name: 'Empresario', m: [-2, 0.92], f: [-7, 0.83], hint: 'Más grave y con más cuerpo. El aplomo lo pones tú: habla despacio, seguro y sin prisa.' },
  dibujo: { name: 'Dibujo animado', m: [12, 1.45], f: [7, 1.3], hint: 'Exagerado, para jugar.' },
};
let currentPreset = 'original';
function applyPreset(key) {
  currentPreset = key;
  const p = PRESETS[key];
  const [s, f] = p[$('baseVoice').value];
  $('semi').value = s;
  $('formant').value = f;
  document.querySelectorAll('#presets .chip').forEach((c) => c.classList.toggle('on', c.dataset.p === key));
  $('presetHint').textContent = `${p.name}: ${p.hint}`;
  sendParams();
}
document.querySelectorAll('#presets .chip').forEach((c) => (c.onclick = () => applyPreset(c.dataset.p)));
$('baseVoice').onchange = () => applyPreset(currentPreset);
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
  const btn = $('liveStart');
  btn.disabled = true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    live.ctx = new AC({ latencyHint: 'interactive' });
    await live.ctx.resume();
    if (!live.ctx.audioWorklet) throw new Error('Este navegador no admite AudioWorklet. Actualiza iOS o usa Chrome/Safari recientes.');
    await live.ctx.audioWorklet.addModule('voice-worklet.js');
    const mic = $('micSelect').value;
    live.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: mic ? { exact: mic } : undefined, echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    });
    const src = live.ctx.createMediaStreamSource(live.stream);
    live.node = new AudioWorkletNode(live.ctx, 'voice-shifter', { outputChannelCount: [1] });
    live.node.port.onmessage = (e) => {
      if (e.data.latency) live.latency = e.data.latency;
      if (e.data.level != null) $('level').style.width = Math.min(100, e.data.level * 400) + '%';
    };
    live.gain = live.ctx.createGain();
    live.gain.gain.value = $('monitor').checked ? 1 : 0;
    live.dest = live.ctx.createMediaStreamDestination();
    src.connect(live.node);
    live.node.connect(live.gain).connect(live.ctx.destination);
    live.node.connect(live.dest);
    sendParams();
    await fillMics();
    setTimeout(() => {
      const ms = ((live.ctx.baseLatency || 0) + (live.ctx.outputLatency || 0) + live.latency) * 1000;
      status($('liveStatus'), `Micrófono activo · retraso estimado ≈ ${Math.round(ms)} ms · ${live.ctx.sampleRate} Hz`);
    }, 300);
    status($('liveStatus'), 'Micrófono activo.');
    btn.textContent = 'Detener';
    btn.onclick = stopLive;
    $('recBtn').disabled = false;
  } catch (e) {
    status($('liveStatus'), micError(e), true);
    stopLive();
  } finally {
    btn.disabled = false;
  }
}

function stopLive() {
  live.stream?.getTracks().forEach((t) => t.stop());
  live.ctx?.close().catch(() => {});
  Object.assign(live, { ctx: null, stream: null, node: null, gain: null, dest: null });
  $('level').style.width = '0';
  $('recBtn').disabled = true;
  const btn = $('liveStart');
  btn.textContent = 'Activar micrófono';
  btn.onclick = startLive;
  if (!$('liveStatus').classList.contains('error')) status($('liveStatus'), 'Detenido.');
}
$('liveStart').onclick = startLive;

function micError(e) {
  if (e && e.name === 'NotAllowedError') return 'Permiso de micrófono denegado. Actívalo en Ajustes → Safari → Micrófono y recarga.';
  if (e && e.name === 'NotFoundError') return 'No se encontró ningún micrófono.';
  return 'No se pudo iniciar: ' + (e?.message || e);
}

$('recBtn').onclick = async () => {
  if (!live.dest) return;
  const btn = $('recBtn');
  btn.disabled = true;
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported(t));
  const rec = new MediaRecorder(live.dest.stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/mp4' });
    const a = $('playback');
    a.src = URL.createObjectURL(blob);
    a.hidden = false;
    stopLive(); // en iPhone, con el micro abierto el sonido sale muy bajo por el auricular
    a.play().catch(() => {});
    btn.textContent = '● Grabar 5 s y escuchar';
    status($('liveStatus'), 'Grabación lista: así suena tu voz transformada.');
  };
  rec.start();
  for (let s = 5; s > 0; s--) {
    btn.textContent = `Grabando… ${s}`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  rec.stop();
};

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

Cómo conversas (lo más importante):
- Escucha de verdad: responde primero a lo que la persona acaba de decir (su pregunta, su duda, su tono) y solo después avanza en el guion. Nunca ignores lo que te dice para soltar el siguiente paso.
- Habla como una buena comercial al teléfono: cercana, natural, segura y sin sonar a lectura. Usa expresiones normales («claro», «entiendo», «perfecto», «vale») sin abusar.
- Una idea y como mucho una pregunta por turno. Frases cortas: lo que digas se convierte en voz.
- Recuerda lo que te han contado (nombre, situación, horarios) y úsalo después.
- Si te preguntan algo fuera del guion pero razonable, responde con sentido común y vuelve con suavidad al objetivo. Si no sabes un dato, dilo y ofrece que una persona del equipo le llame.
- Si la persona está ocupada, ofrece llamar en otro momento y pregunta cuándo le viene bien.
- Adapta el ritmo: si es breve, sé breve; si tiene dudas, explica con calma.
- Sin listas, sin emojis, sin markdown. Los números y precios, escritos como se dicen.
- Responde en el idioma de la otra persona (por defecto, español).

Límites que no se negocian:
- Eres una IA. Si te preguntan si eres una persona o un robot, di con naturalidad y claridad que eres un asistente virtual con IA. No digas nunca que eres una persona.
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
$('testVoice').onclick = () => {
  speechSynthesis.cancel();
  speak(`Hola, soy ${agentName() || 'tu asistente'}. Así sonará mi voz durante la llamada.`);
};

function speak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const v = currentVoice();
    u.lang = v?.lang || 'es-ES';
    if (v) u.voice = v;
    u.rate = Number($('rate').value) || 1;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

// --- reconocimiento de voz del sistema
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const call = { client: null, messages: [], system: '', active: false, busy: false, rec: null };

// Sin clave guardada, se propone el modo gratis.
$('freeMode').checked = !$('apiKey').value.trim();
$('freeMode').onchange = () => { $('keyBox').hidden = $('freeMode').checked; };
$('keyBox').hidden = $('freeMode').checked;

$('callStart').onclick = () => {
  const free = $('freeMode').checked;
  const key = $('apiKey').value.trim();
  if (!free && !key) {
    status($('agentStatus'), 'Pon tu clave de Claude en «Clave y modelo de Claude» o activa el modo prueba gratis.', true);
    $('keyBox').open = true;
    return;
  }
  if (!free && $('rememberKey').checked) store.set('apiKey', key);
  const text = $('script').value.trim() || EXAMPLE_SCRIPT;
  const opening = openingLine(text);
  call.offline = free ? new OfflineAgent(text) : null;
  call.client = free ? null : new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  call.system = systemPrompt(text, opening);
  call.messages = [];
  call.active = true;
  $('log').innerHTML = '';
  log('info', free ? 'Llamada de prueba (modo gratis, sin IA). El agente descuelga…' : 'Llamada iniciada. El agente descuelga…');
  log('agente', opening);
  emptyTurns = 0;
  speak(opening).then(() => (SR ? listenNext() : status($('agentStatus'), 'Tu turno: escribe tu respuesta.')));
  $('callStart').disabled = true;
  $('callEnd').disabled = false;
  $('talkBtn').disabled = !SR;
  $('typeForm').hidden = !!SR;
  status($('agentStatus'), 'El agente está hablando…');
};

$('callEnd').onclick = () => endCall('Has colgado.');

function endCall(msg) {
  call.active = false;
  call.rec?.abort();
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
  if (SR) listenNext();
  else status($('agentStatus'), 'Tu turno: escribe tu respuesta.');
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
