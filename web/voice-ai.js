// Conversión de voz realista con ElevenLabs (speech-to-speech).
//
// "Speech-to-speech" repite LO QUE TÚ DICES con la voz elegida, conservando tu
// entonación, tus pausas y tu emoción, pero con otro timbre e identidad vocal.
// Las voces son genéricas (de la biblioteca de ElevenLabs o creadas por ti),
// no de una persona real concreta.
//
// La clave se usa solo desde este navegador; nunca se envía a otro sitio que no
// sea la propia API de ElevenLabs.

const BASE = 'https://api.elevenlabs.io/v1';
const STS_MODEL = 'eleven_multilingual_sts_v2';

export class ElevenLabsError extends Error {}

async function readError(res) {
  let detail = `${res.status}`;
  try {
    const j = await res.json();
    detail = j?.detail?.message || j?.detail?.status || JSON.stringify(j?.detail || j);
  } catch { /* sin cuerpo JSON */ }
  if (res.status === 401) return 'La clave de ElevenLabs no es válida.';
  if (res.status === 429) return 'Has llegado al límite de la cuenta gratuita de ElevenLabs por ahora.';
  return 'Error de ElevenLabs: ' + detail;
}

/** Lista las voces de la cuenta. Devuelve [{id, name, group}]. */
export async function listVoices(apiKey) {
  const res = await fetch(`${BASE}/voices`, { headers: { 'xi-api-key': apiKey } });
  if (!res.ok) throw new ElevenLabsError(await readError(res));
  const data = await res.json();
  return (data.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    group: v.category === 'premade' ? 'Biblioteca' : 'Mis voces',
    labels: v.labels || {},
  }));
}

/**
 * Convierte un audio (Blob WAV) a la voz indicada.
 * Devuelve un Blob de audio (mp3) listo para reproducir o descargar.
 */
export async function convert(apiKey, voiceId, wavBlob, { removeNoise = true } = {}) {
  const form = new FormData();
  form.append('audio', wavBlob, 'input.wav');
  form.append('model_id', STS_MODEL);
  form.append('remove_background_noise', String(removeNoise));
  const res = await fetch(`${BASE}/speech-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });
  if (!res.ok) throw new ElevenLabsError(await readError(res));
  return res.blob();
}

// Pistas para agrupar las voces de la biblioteca por el tipo de persona que pediste.
export const PERSONA_HINTS = {
  chicaJoven: ['young', 'female'],
  mujer: ['female', 'middle'],
  mujerMayor: ['female', 'old'],
  chicoJoven: ['young', 'male'],
  hombre: ['male', 'middle'],
  hombreMayor: ['male', 'old'],
  nina: ['child', 'female'],
  nino: ['child', 'male'],
};

// Perfiles de persona → cómo puntuar las voces de la biblioteca para cada uno.
const PERSONAS = {
  hombreGrave: { name: 'Hombre grave', gender: 'male', age: ['old', 'middle'], words: ['deep', 'grave', 'mature', 'strong', 'low'] },
  hombre: { name: 'Hombre', gender: 'male', age: ['middle'], words: [] },
  chicoJoven: { name: 'Chico joven', gender: 'male', age: ['young'], words: ['young'] },
  empresario: { name: 'Empresario', gender: 'male', age: ['middle', 'old'], words: ['confident', 'deep', 'professional', 'authorit', 'news'] },
  mujerGrave: { name: 'Mujer grave', gender: 'female', age: ['old', 'middle'], words: ['deep', 'grave', 'mature', 'warm', 'low'] },
  mujer: { name: 'Mujer', gender: 'female', age: ['middle'], words: [] },
  chicaJoven: { name: 'Chica joven', gender: 'female', age: ['young'], words: ['young'] },
  nino: { name: 'Niño', gender: 'male', age: ['young'], words: ['child', 'kid', 'boy'] },
  nina: { name: 'Niña', gender: 'female', age: ['young'], words: ['child', 'kid', 'girl'] },
};

export function personaList() {
  return Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name }));
}

/** Elige la mejor voz de la lista para una persona. Devuelve {voice, score}. */
export function matchPersona(voices, personaId) {
  const p = PERSONAS[personaId];
  if (!p) return { voice: null, score: 0 };
  const text = (v) => `${v.name} ${Object.values(v.labels || {}).join(' ')}`.toLowerCase();
  let best = null;
  let bestScore = -1;
  for (const v of voices) {
    const g = (v.labels.gender || '').toLowerCase();
    const a = (v.labels.age || '').toLowerCase().replace('_', ' ');
    const t = text(v);
    let score = 0;
    if (g && p.gender) score += g === p.gender ? 3 : -4;
    if (a) score += p.age.some((x) => a.includes(x)) ? 2 : 0;
    for (const w of p.words) if (t.includes(w)) score += 1.5;
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return { voice: best, score: bestScore };
}

// Texto → voz realista (ElevenLabs). Devuelve un Blob de audio (mp3).
// Modelos: eleven_flash_v2_5 (rápido, multilingüe) o eleven_multilingual_v2 (más calidad).
export async function tts(apiKey, voiceId, text, { model = 'eleven_flash_v2_5' } = {}) {
  const res = await fetch(`${BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new ElevenLabsError(await readError(res));
  return res.blob();
}
