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
