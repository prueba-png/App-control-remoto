// Adaptador genérico para Spaces de Gradio en Hugging Face.
// Cada Space expone parámetros distintos, así que en vez de fijar su firma
// la descubrimos en tiempo real con view_api() y rellenamos cada parámetro
// según su tipo y su nombre. Todo lo que no reconocemos conserva el valor por
// defecto del propio Space, y el usuario puede editarlo en "Ajustes avanzados".

// Nombres de endpoint que casi nunca son "generar".
const NOISE = /(update|change|clear|reset|random|example|load|toggle|select|upload|lambda|show|hide|cancel|enhance|refresh|preset)/i;
const GOOD = /(generat|infer|run|predict|create|process|submit|video|image|i2v|animate)/i;

export function scoreEndpoint(name, info, want) {
  const params = info.parameters || [];
  const returns = info.returns || [];
  let s = 0;
  if (GOOD.test(name)) s += 3;
  if (NOISE.test(name)) s -= 6;
  if (params.some((p) => /image/i.test(p.component))) s += 4;
  if (params.some((p) => isPrompt(p))) s += 3;
  if (want.needsVideoIn && params.some((p) => /video/i.test(p.component))) s += 4;
  const outKind = want.output; // 'image' | 'video'
  if (returns.some((r) => new RegExp(outKind, 'i').test(r.component))) s += 6;
  if (outKind === 'image' && returns.some((r) => /gallery/i.test(r.component))) s += 5;
  if (params.length === 0) s -= 10;
  return s;
}

export function pickEndpoint(api, want) {
  const named = Object.entries(api.named_endpoints || {});
  if (!named.length) return null;
  return named
    .map(([name, info]) => ({ name, info, score: scoreEndpoint(name, info, want) }))
    .sort((a, b) => b.score - a.score)[0];
}

function text(p) {
  return `${p.parameter_name || ''} ${p.label || ''}`.toLowerCase();
}
export function isNegative(p) {
  return /textbox/i.test(p.component) && /(negative|neg_prompt|neg prompt|negativo)/.test(text(p));
}
export function isPrompt(p) {
  return /textbox/i.test(p.component) && !isNegative(p) && /(prompt|text|descri|caption|instruc)/.test(text(p));
}

// Reglas por nombre de parámetro. Solo tocan valores numéricos y solo cuando
// el nombre deja claro qué significan; si un Space usa otro nombre, se queda
// con su valor por defecto.
const RULES = [
  { re: /(id_weight|id weight|identity|face.?strength|ip_adapter_scale|id_scale)/, key: 'idWeight' },
  { re: /(randomi[sz]e)/, key: 'randomize', bool: true },
  { re: /(^|[^a-z])seed([^a-z]|$)/, key: 'seed' },
  { re: /(duration|seconds|length_s)/, key: 'duration' },
  { re: /(^| )width/, key: 'width' },
  { re: /(^| )height/, key: 'height' },
];

export function defaultFor(p) {
  if (p.parameter_has_default) return p.parameter_default;
  if (p.example_input !== undefined) return p.example_input;
  return null;
}

// inputs: { image: Blob|null, video: Blob|null, prompt, negative, idWeight, seed, duration, width, height }
// Devuelve [{ param, value, source }] en el orden que espera el endpoint.
export function mapParams(info, inputs, handleFile = (x) => x) {
  let imageUsed = false;
  let videoUsed = false;
  let promptUsed = false;
  return (info.parameters || []).map((p) => {
    const comp = (p.component || '').toLowerCase();
    const t = text(p);
    if (comp === 'image' || comp === 'imageeditor' || comp === 'imageslider') {
      if (!imageUsed && inputs.image) {
        imageUsed = true;
        return { param: p, value: handleFile(inputs.image), source: 'image' };
      }
      return { param: p, value: defaultFor(p), source: 'default' };
    }
    if (comp === 'video') {
      if (!videoUsed && inputs.video) {
        videoUsed = true;
        return { param: p, value: { video: handleFile(inputs.video) }, source: 'video' };
      }
      return { param: p, value: defaultFor(p), source: 'default' };
    }
    if (isNegative(p) && inputs.negative != null) {
      return { param: p, value: inputs.negative, source: 'negative' };
    }
    if (isPrompt(p) && !promptUsed && inputs.prompt != null) {
      promptUsed = true;
      return { param: p, value: inputs.prompt, source: 'prompt' };
    }
    for (const r of RULES) {
      if (!r.re.test(t)) continue;
      const v = inputs[r.key];
      if (v === undefined || v === null || v === '') break;
      if (r.bool && typeof defaultFor(p) === 'boolean') return { param: p, value: !!v, source: r.key };
      if (!r.bool && /(slider|number)/.test(comp)) return { param: p, value: Number(v), source: r.key };
      break;
    }
    return { param: p, value: defaultFor(p), source: 'default' };
  });
}

// Busca en la respuesta del Space la primera URL de imagen o vídeo.
const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i;
const VID_EXT = /\.(mp4|webm|mov|mkv|m4v)(\?|$)/i;

export function extractMedia(data, kind) {
  const found = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      if (/^https?:\/\//.test(v) || v.startsWith('data:')) found.push(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') {
      if (typeof v.url === 'string') found.push(v.url);
      for (const k of Object.keys(v)) if (k !== 'url') walk(v[k]);
    }
  };
  walk(data);
  const ext = kind === 'video' ? VID_EXT : IMG_EXT;
  const pref = kind === 'video' ? 'data:video' : 'data:image';
  const matches = found.filter((u) => ext.test(u) || u.startsWith(pref));
  return matches.length ? matches : found.filter((u) => !(kind === 'video' ? IMG_EXT : VID_EXT).test(u));
}

// Prompt de realismo: se añade a lo que escribe el usuario.
export const REALISM_SUFFIX =
  'raw documentary photograph, natural skin texture with visible pores and fine imperfections, ' +
  'subsurface scattering, individual hair strands, accurate anatomy, 50mm lens at f/1.8, ' +
  'shallow depth of field, soft natural light, subtle film grain, true-to-life colors';

export const NEGATIVE_IMAGE =
  'plastic skin, airbrushed, waxy, cartoon, illustration, 3d render, oversaturated, ' +
  'asymmetric eyes, deformed hands, extra fingers, blurry face, text, watermark, logo';

export const NEGATIVE_VIDEO =
  'face morphing, changing facial features, identity drift, flicker, warping, distorted hands, ' +
  'jitter, fast motion, shaky camera, blurry, low quality, cartoon, text, watermark';

export function buildImagePrompt({ subject, outfit, scene, light, framing }) {
  const parts = [
    subject || 'portrait of the person from the reference photo',
    outfit && `wearing ${outfit}`,
    scene && `in ${scene}`,
    light,
    framing,
    REALISM_SUFFIX,
  ];
  return parts.filter(Boolean).join(', ');
}

export function buildVideoPrompt({ action, camera }) {
  return [
    action,
    camera,
    'the face stays identical to the first frame, consistent identity, natural subtle micro-expressions, ' +
      'realistic blinking, smooth physically plausible motion, stable lighting, cinematic, photorealistic',
  ]
    .filter(Boolean)
    .join('. ');
}
