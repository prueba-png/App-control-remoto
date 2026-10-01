import { Client, handle_file } from './vendor/gradio-client-2.7.1.js';
import {
  pickEndpoint, mapParams, extractMedia, buildImagePrompt, buildVideoPrompt,
  NEGATIVE_IMAGE, NEGATIVE_VIDEO,
} from './engine.js';
import { watermarkImage, watermarkVideo, download, LABEL } from './watermark.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_SPACES = {
  image: 'yanze/PuLID-FLUX',
  video: 'zerogpu-aoti/wan2-2-fp8da-aoti-faster',
  gestures: 'KwaiVGI/LivePortrait',
};

const ASPECTS = {
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
  square: { width: 1024, height: 1024 },
};

// ---------- almacenamiento local (solo comodidades de este navegador) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('auraface:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('auraface:' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

const state = {
  face: null,          // Blob de la foto de referencia
  keyframe: null,      // Blob del fotograma elegido
  keyframeSize: null,  // { width, height }
  lastVideoUrl: null,
  driving: null,       // Blob del vídeo de gestos
  overrides: store.get('overrides', {}), // { kind: { paramName: value } }
  apiCache: {},        // spaceId -> { endpoint, info }
};

function spaces() { return { ...DEFAULT_SPACES, ...store.get('spaces', {}) }; }
function token() { const t = store.get('token', ''); return t && t.startsWith('hf_') ? t : undefined; }

// ---------- pasos ----------
function go(step) {
  for (let i = 1; i <= 4; i++) $('step' + i).hidden = i !== step;
  document.querySelectorAll('#steps li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('active', n === step);
    li.classList.toggle('done', n < step);
  });
  $('step' + step).scrollIntoView({ behavior: 'smooth', block: 'start' });
}
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.back))));

// ---------- arrastrar y soltar ----------
function setupDrop(label, input, onFile) {
  ['dragenter', 'dragover'].forEach((ev) => label.addEventListener(ev, (e) => { e.preventDefault(); label.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => label.addEventListener(ev, (e) => { e.preventDefault(); label.classList.remove('over'); }));
  label.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
  input.addEventListener('change', () => { const f = input.files[0]; if (f) onFile(f); });
}

// ---------- paso 1: rostro ----------
function setFace(blob) {
  state.face = blob;
  const img = $('facePreview');
  img.src = URL.createObjectURL(blob);
  img.hidden = false;
  $('faceDrop').querySelector('.drop-empty').hidden = true;
  updateStep1();
}

setupDrop($('faceDrop'), $('faceInput'), (file) => {
  if (file.type.startsWith('video/')) {
    const v = $('faceVideo');
    v.src = URL.createObjectURL(file);
    $('frameGrab').hidden = false;
  } else if (file.type.startsWith('image/')) {
    $('frameGrab').hidden = true;
    setFace(file);
  }
});

$('useFrame').addEventListener('click', () => {
  const v = $('faceVideo');
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  c.toBlob((b) => b && setFace(b), 'image/png');
});

function updateStep1() { $('toStep2').disabled = !(state.face && $('consent').checked); }
$('consent').addEventListener('change', updateStep1);
$('toStep2').addEventListener('click', () => { refreshImagePrompt(); go(2); });

// ---------- paso 2: fotograma clave ----------
let imgPromptEdited = false;
function refreshImagePrompt() {
  if (!imgPromptEdited) {
    $('imgPrompt').value = buildImagePrompt({
      outfit: $('outfit').value.trim(),
      scene: $('scene').value.trim(),
      light: $('light').value,
      framing: $('framing').value,
    });
  }
  if (!$('imgNeg').value) $('imgNeg').value = NEGATIVE_IMAGE;
}
['outfit', 'scene', 'light', 'framing'].forEach((id) => $(id).addEventListener('input', refreshImagePrompt));
$('imgPrompt').addEventListener('input', () => { imgPromptEdited = true; });
$('idWeight').addEventListener('input', () => { $('idWeightOut').value = Number($('idWeight').value).toFixed(2); });

$('genImage').addEventListener('click', async () => {
  refreshImagePrompt();
  const { width, height } = ASPECTS[$('aspect').value];
  const url = await runJob('image', $('imgJob'), {
    image: state.face,
    prompt: $('imgPrompt').value,
    negative: $('imgNeg').value,
    idWeight: Number($('idWeight').value),
    seed: Math.floor(Math.random() * 2 ** 31),
    randomize: false,
    width, height,
  }, $('genImage'));
  if (url) addImageResult(url);
});

$('ownKeyframe').addEventListener('change', () => {
  const f = $('ownKeyframe').files[0];
  if (f) addImageResult(URL.createObjectURL(f), f);
});

function addImageResult(url, blob) {
  const box = document.createElement('div');
  box.className = 'result';
  box.innerHTML = `<img alt="Imagen generada"><span class="badge">${LABEL}</span>
    <div class="row"><button type="button" class="pick">Elegir</button><button type="button" class="ghost dl">Descargar</button></div>`;
  box.querySelector('img').src = url;
  box.querySelector('.pick').addEventListener('click', async () => {
    document.querySelectorAll('#imgResults .result').forEach((r) => r.classList.remove('selected'));
    box.classList.add('selected');
    try {
      state.keyframe = blob || await (await fetch(url)).blob();
    } catch {
      state.keyframe = null;
      showJob($('imgJob'), 'No se pudo leer esta imagen desde el navegador. Descárgala y súbela con «Ya tengo una imagen».', 'error');
      return;
    }
    const bmp = await createImageBitmap(state.keyframe);
    state.keyframeSize = { width: bmp.width, height: bmp.height };
    $('toStep3').disabled = false;
  });
  box.querySelector('.dl').addEventListener('click', () => saveImage(url));
  $('imgResults').prepend(box);
  box.querySelector('.pick').click();
}

async function saveImage(url) {
  try { download(await watermarkImage(url), `auraface-${Date.now()}.png`); }
  catch (e) { alert('No se pudo preparar la descarga: ' + e.message); }
}

$('toStep3').addEventListener('click', () => {
  $('keyframePreview').src = URL.createObjectURL(state.keyframe);
  refreshVideoPrompt();
  go(3);
});

// ---------- paso 3: vídeo ----------
let vidPromptEdited = false;
function refreshVideoPrompt() {
  if (!vidPromptEdited) {
    $('vidPrompt').value = buildVideoPrompt({
      action: $('action').value.trim() || 'the person turns their head slowly toward the camera and gives a slight natural smile, blinks once',
      camera: $('camera').value,
    });
  }
  if (!$('vidNeg').value) $('vidNeg').value = NEGATIVE_VIDEO;
}
['action', 'camera'].forEach((id) => $(id).addEventListener('input', refreshVideoPrompt));
$('vidPrompt').addEventListener('input', () => { vidPromptEdited = true; });
$('duration').addEventListener('input', () => { $('durationOut').value = $('duration').value + ' s'; });

// Wan 2.2 trabaja a 480p: mantenemos la proporción del fotograma, múltiplos de 16.
function videoDims() {
  const s = state.keyframeSize || { width: 832, height: 1216 };
  const long = 832;
  const r = s.width / s.height;
  const w = r >= 1 ? long : Math.round((long * r) / 16) * 16;
  const h = r >= 1 ? Math.round(long / r / 16) * 16 : long;
  return { width: w, height: h };
}

$('genVideo').addEventListener('click', async () => {
  refreshVideoPrompt();
  const url = await runJob('video', $('vidJob'), {
    image: state.keyframe,
    prompt: $('vidPrompt').value,
    negative: $('vidNeg').value,
    duration: Number($('duration').value),
    seed: Math.floor(Math.random() * 2 ** 31),
    randomize: false,
    ...videoDims(),
  }, $('genVideo'));
  if (url) {
    state.lastVideoUrl = url;
    addVideoResult($('vidResults'), url);
    $('toStep4').disabled = false;
  }
});
$('toStep4').addEventListener('click', () => go(4));

function addVideoResult(container, url) {
  const box = document.createElement('div');
  box.className = 'result';
  box.innerHTML = `<video controls playsinline loop muted autoplay></video><span class="badge">${LABEL}</span>
    <div class="row"><button type="button" class="dl">Descargar con marca IA</button></div>`;
  box.querySelector('video').src = url;
  const btn = box.querySelector('.dl');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const { blob, ext } = await watermarkVideo(url, (p) => { btn.textContent = `Preparando ${Math.round(p * 100)} %`; });
      download(blob, `auraface-${Date.now()}.${ext}`);
    } catch (e) {
      alert('No se pudo preparar la descarga: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Descargar con marca IA';
    }
  });
  container.prepend(box);
}

// ---------- paso 4: gestos ----------
setupDrop($('drivingDrop'), $('drivingInput'), (file) => {
  if (!file.type.startsWith('video/')) return;
  state.driving = file;
  const v = $('drivingPreview');
  v.src = URL.createObjectURL(file);
  v.hidden = false;
  $('drivingDrop').querySelector('.drop-empty').hidden = true;
  $('genGestures').disabled = false;
});

$('genGestures').addEventListener('click', async () => {
  const url = await runJob('gestures', $('gesJob'), { image: state.keyframe, video: state.driving }, $('genGestures'));
  if (url) addVideoResult($('gesResults'), url);
});

// ---------- motor genérico ----------
function showJob(el, msg, kind = '', progress = null) {
  el.hidden = false;
  el.className = 'job' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  if (progress != null) {
    const p = document.createElement('progress');
    if (progress >= 0) { p.max = 1; p.value = progress; }
    el.append(p);
  }
}

async function getEngine(kind, el) {
  const id = spaces()[kind];
  const key = `${id}|${token() ? 't' : 'a'}`;
  if (state.apiCache[key]) return state.apiCache[key];
  showJob(el, `Conectando con el motor ${id}… (si estaba dormido puede tardar 1–3 min en despertar)`, '', -1);
  const client = await Client.connect(id, {
    token: token(),
    status_callback: (s) => {
      if (s.status === 'sleeping' || s.status === 'building' || s.stage === 'pending') {
        showJob(el, `El motor ${id} se está iniciando… ${s.message || ''}`, '', -1);
      }
    },
  });
  const api = await client.view_api();
  const want = { output: kind === 'image' ? 'image' : 'video', needsVideoIn: kind === 'gestures' };
  const best = pickEndpoint(api, want);
  if (!best) throw new Error(`El Space ${id} no expone ninguna API utilizable.`);
  const engine = { id, client, endpoint: best.name, info: best.info, api };
  state.apiCache[key] = engine;
  return engine;
}

async function runJob(kind, el, inputs, button) {
  button.disabled = true;
  try {
    const eng = await getEngine(kind, el);
    const mapped = mapParams(eng.info, inputs, handle_file);
    const ov = state.overrides[`${eng.id}${eng.endpoint}`] || {};
    const data = mapped.map((m) => (m.param.parameter_name in ov ? ov[m.param.parameter_name] : m.value));
    renderParamPanel(kind, eng, mapped);

    showJob(el, 'En cola…', '', -1);
    const job = eng.client.submit(eng.endpoint, data);
    let result = null;
    for await (const msg of job) {
      if (msg.type === 'status') {
        if (msg.stage === 'error') throw new Error(cleanError(msg.message));
        if (msg.stage === 'pending' && msg.position != null) {
          showJob(el, `En cola: posición ${msg.position + 1}${msg.eta ? `, unos ${Math.round(msg.eta)} s` : ''}`, '', -1);
        } else if (msg.stage === 'generating' || msg.stage === 'pending') {
          const pd = msg.progress_data && msg.progress_data[0];
          const frac = pd && pd.length ? pd.index / pd.length : -1;
          showJob(el, kind === 'image' ? 'Generando la imagen…' : 'Generando el vídeo… (suele tardar entre 1 y 4 minutos)', '', frac);
        }
      } else if (msg.type === 'data') {
        result = msg.data;
        break;
      }
    }
    const urls = extractMedia(result, kind === 'image' ? 'image' : 'video');
    if (!urls.length) throw new Error('El motor terminó pero no devolvió ningún archivo.');
    showJob(el, 'Listo.', '');
    return urls[0];
  } catch (e) {
    showJob(el, explain(e), 'error');
    return null;
  } finally {
    button.disabled = false;
  }
}

function cleanError(m) {
  if (Array.isArray(m)) return m.map((x) => x.message || JSON.stringify(x)).join('; ');
  return m || 'error desconocido';
}

function explain(e) {
  const m = String(e && e.message || e);
  if (/quota|exceeded|ZeroGPU|GPU duration|limit/i.test(m)) {
    return `Se ha agotado la cuota gratuita de GPU por ahora. ${token() ? 'Espera un rato (se renueva cada día) o' : 'Añade tu token gratuito de Hugging Face en Ajustes para tener más cuota, o'} prueba otro motor.\n\nDetalle: ${m}`;
  }
  if (/fetch|network|Could not resolve|not found|404|Space metadata/i.test(m)) {
    return `No se pudo conectar con el motor. Puede estar caído o haber cambiado de nombre: cambia el Space en Ajustes.\n\nDetalle: ${m}`;
  }
  return 'Error: ' + m;
}

// ---------- ajustes ----------
function loadSettings() {
  const s = spaces();
  $('hfToken').value = store.get('token', '');
  $('spaceImage').value = s.image;
  $('spaceVideo').value = s.video;
  $('spaceGestures').value = s.gestures;
}
$('openSettings').addEventListener('click', () => { loadSettings(); $('settings').showModal(); });
$('settings').addEventListener('close', () => {
  store.set('token', $('hfToken').value.trim());
  store.set('spaces', {
    image: $('spaceImage').value.trim() || DEFAULT_SPACES.image,
    video: $('spaceVideo').value.trim() || DEFAULT_SPACES.video,
    gestures: $('spaceGestures').value.trim() || DEFAULT_SPACES.gestures,
  });
  state.apiCache = {};
});
$('resetSpaces').addEventListener('click', () => {
  $('spaceImage').value = DEFAULT_SPACES.image;
  $('spaceVideo').value = DEFAULT_SPACES.video;
  $('spaceGestures').value = DEFAULT_SPACES.gestures;
});

const KIND_NAMES = { image: 'Imagen con tu cara', video: 'Imagen → vídeo', gestures: 'Gestos' };
function renderParamPanel(kind, eng, mapped) {
  const key = `${eng.id}${eng.endpoint}`;
  let panel = document.querySelector(`[data-panel="${kind}"]`);
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'param-panel';
    panel.dataset.panel = kind;
    $('paramPanels').append(panel);
  }
  panel.innerHTML = '';
  const h = document.createElement('h4');
  h.textContent = `${KIND_NAMES[kind]} — ${eng.id} ${eng.endpoint}`;
  panel.append(h);
  const sel = document.createElement('select');
  for (const name of Object.keys(eng.api.named_endpoints)) {
    const o = document.createElement('option');
    o.value = o.textContent = name;
    o.selected = name === eng.endpoint;
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    eng.endpoint = sel.value;
    eng.info = eng.api.named_endpoints[sel.value];
  });
  panel.append(sel);
  const ov = state.overrides[key] || {};
  for (const m of mapped) {
    const p = m.param;
    if (['image', 'video', 'prompt', 'negative'].includes(m.source)) continue;
    if (/(image|video|gallery|file|audio)/i.test(p.component)) continue;
    const row = document.createElement('label');
    row.className = 'param';
    const span = document.createElement('span');
    span.textContent = `${p.label || p.parameter_name} (${p.parameter_name})`;
    const input = document.createElement('input');
    const cur = p.parameter_name in ov ? ov[p.parameter_name] : m.value;
    input.value = typeof cur === 'object' ? JSON.stringify(cur) : String(cur ?? '');
    input.addEventListener('change', () => {
      let v = input.value;
      try { v = JSON.parse(v); } catch { /* texto */ }
      state.overrides[key] = { ...(state.overrides[key] || {}), [p.parameter_name]: v };
      store.set('overrides', state.overrides);
    });
    row.append(span, input);
    panel.append(row);
  }
}

// La versión anterior de esta web (control remoto) registró un service worker.
// Lo retiramos para que no sirva archivos antiguos.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
}
