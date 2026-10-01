// Modo prueba gratis: un agente simulado SIN inteligencia artificial.
//
// Acepta cualquier guion:
//   - Pasos: líneas numeradas o con guion ("1. Pregunta si…", "- ¿Tiene…?"). Si no
//     hay, cada frase del guion es un paso.
//   - Objeciones: "Si dice que es caro: la visita es gratis…" o
//     "Si pregunta por el precio → depende del estudio…".
//   - Líneas "Empresa:", "Apertura:", "Objetivo:" y "No…" son datos, no pasos.
// Reacciona a palabras clave y recuerda el nombre si se lo dicen, pero no
// entiende de verdad: para eso está el modo con Claude.

const NO_INTEREST = /(no me interesa|no gracias|no, gracias|no quiero|d[ée]jame|no me llam|b[óo]rr[ae]me|qu[íi]tame|adi[óo]s|cuelgo|no tengo inter[ée]s)/i;
const BUSY = /(estoy ocupad|ahora no puedo|ahora mismo no|no puedo hablar|ll[áa]mame (luego|m[áa]s tarde)|ll[áa]meme (luego|m[áa]s tarde)|en otro momento|estoy conduciendo|estoy trabajando|en una reuni[óo]n)/i;
const ARE_YOU_HUMAN = /(eres (una |un )?(persona|humano|humana|robot|m[áa]quina|ia\b)|eres real|una m[áa]quina|un robot|inteligencia artificial)/i;
const NAME = /(?:me llamo|soy|mi nombre es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/;
const QUESTION = /\?\s*$|^(qu[ée]|cu[áa]nto|c[óo]mo|cu[áa]ndo|d[óo]nde|por qu[ée]|y si|hay|tienen|es)\b/i;
const ACKS = ['Entiendo.', 'Perfecto.', 'Claro.', 'Muy bien.', 'Vale, gracias.', 'De acuerdo.'];
const META = /^\s*(empresa|apertura|objetivo|nombre|producto|precio|tono)\s*:/i;
const STOPWORDS = new Set(['que', 'por', 'para', 'con', 'una', 'uno', 'los', 'las', 'del', 'dice', 'pregunta', 'responde', 'esta', 'este', 'muy', 'mas', 'más', 'pero', 'como', 'cómo']);

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Convierte una instrucción del guion ("Pregunta si vive…") en una frase hablada. */
export function stepToSpeech(step) {
  let s = step.replace(/^\s*(\d+[.)-]|[-•*])\s*/, '').trim().replace(/[.;]$/, '').replace(/^hola,?\s*/i, '');
  let m;
  if (/[¿?]/.test(s)) return cap(s.replace(/^¿?/, '¿').replace(/\??$/, '?'));
  if ((m = s.match(/^pregunta(?:le)? (?:si |por |)(.+)$/i))) return `¿${cap(m[1])}?`;
  if ((m = s.match(/^(?:explica|cuenta|di|dile|comenta|indica|menciona)(?:le)? que (.+)$/i))) return cap(m[1]) + '.';
  if ((m = s.match(/^(?:propón|propon|ofrece|sugiere)(?:le)? (.+?)(?: y (?:pide|pregunta) (.+))?$/i))) {
    return `Le propongo ${m[1]}.` + (m[2] ? ` ¿Me dice ${m[2]}?` : '');
  }
  if (/^(confirma|desp[íi]dete|cierra|agradece)/i.test(s)) return 'Perfecto, queda anotado. Muchas gracias por su tiempo y que tenga muy buen día.';
  if ((m = s.match(/^(?:saluda|pres[ée]ntate)(?: y (.+))?$/i))) return m[1] ? stepToSpeech(m[1]) : 'Encantada de saludarle.';
  return cap(s) + '.';
}

/** Lee el guion: pasos y objeciones. */
export function parseScript(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const objections = [];
  const rest = [];
  for (const l of lines) {
    const m = l.match(/^si (?:dice|pregunta|responde|comenta|te dice|le dice|pone)?\s*(?:que |por |si )?(.+?)\s*(?::|→|->|=>)\s*(.+)$/i);
    if (m) {
      const keys = norm(m[1]).split(/[^a-zñ0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
      objections.push({ keys, answer: cap(m[2].trim().replace(/\.?$/, '.')) });
    } else if (!META.test(l) && !/^no\s/i.test(l)) {
      rest.push(l);
    }
  }
  let steps = rest.filter((l) => /^(\d+[.)-]|[-•*])\s+/.test(l));
  if (!steps.length) steps = rest.flatMap((l) => l.split(/(?<=[.!?])\s+/)).filter((s) => s.length > 3);
  return { steps: steps.map(stepToSpeech), objections };
}

export class OfflineAgent {
  constructor(scriptText) {
    const { steps, objections } = parseScript(scriptText);
    this.steps = steps.length ? steps : ['¿Le puedo hacer un par de preguntas rápidas?'];
    this.objections = objections;
    this.i = 0;
    this.turn = 0;
    this.name = '';
    this.lastQuestion = '';
  }

  _objection(text) {
    const t = norm(text);
    let best = null;
    let bestScore = 0;
    for (const o of this.objections) {
      const hits = o.keys.filter((k) => t.includes(k)).length;
      const score = o.keys.length ? hits / o.keys.length : 0;
      if (hits && score > bestScore) { best = o; bestScore = score; }
    }
    return bestScore >= 0.34 ? best : null;
  }

  /** Siguientes frases del guion: avanza hasta incluir una pregunta (si la hay). */
  _advance() {
    const out = [];
    while (this.i < this.steps.length) {
      const s = this.steps[this.i++];
      out.push(s);
      if (s.endsWith('?') || out.length >= 2) { if (s.endsWith('?')) this.lastQuestion = s; break; }
    }
    return out;
  }

  /** Devuelve las frases de la respuesta. La última puede llevar [FIN]. */
  reply(text) {
    this.turn += 1;
    const nm = text.match(NAME);
    if (nm && !this.name) this.name = nm[1];
    if (NO_INTEREST.test(text)) {
      return ['De acuerdo, lo entiendo perfectamente.', 'No le volveremos a llamar. Que tenga buen día. [FIN]'];
    }
    const obj = this._objection(text);
    if (!obj && BUSY.test(text)) {
      return ['Sin problema, no le entretengo.', 'Le llamaremos en otro momento. Que tenga buen día. [FIN]'];
    }
    if (ARE_YOU_HUMAN.test(text)) {
      return ['Soy un asistente virtual, no una persona; ahora mismo en modo de prueba.', this.lastQuestion || '¿Seguimos?'];
    }
    const out = [];
    if (this.name && this.turn <= 2 && nm) out.push(`Encantada, ${this.name}.`);
    if (obj) {
      out.push(obj.answer);
      if (this.lastQuestion) out.push(this.lastQuestion);
      return out;
    }
    if (QUESTION.test(text.trim())) out.push('Buena pregunta. Eso se lo detalla una persona del equipo.');
    else if (!out.length) out.push(ACKS[this.turn % ACKS.length]);
    const next = this._advance();
    if (!next.length) return [...out, `Pues esto es todo${this.name ? ', ' + this.name : ''}. Muchas gracias y que tenga buen día. [FIN]`];
    if (this.i >= this.steps.length && !next[next.length - 1].endsWith('?')) next[next.length - 1] += ' [FIN]';
    return [...out, ...next];
  }
}
