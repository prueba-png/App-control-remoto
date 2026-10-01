// Modo prueba gratis: un agente simulado SIN inteligencia artificial.
// Sigue los pasos numerados del guion en orden y reacciona a unas pocas
// palabras clave (no, ocupado, preguntas…). Sirve para probar la voz, el
// dictado y el ritmo de la llamada sin pagar la API; no entiende de verdad.

const NO_INTEREST = /\b(no me interesa|no gracias|no, gracias|no quiero|déjame|dejame|no me llam|borra|quitad|quítame|adiós|adios|cuelgo)\b/i;
const BUSY = /\b(ocupad|ahora no|no puedo|luego|más tarde|mas tarde|otro momento|conduciendo|trabajando)\b/i;
const ARE_YOU_HUMAN = /\b(eres (una )?(persona|humano|humana|robot|máquina|maquina|ia)|eres real|hablo con una máquina|me llama un robot)\b/i;
const YES = /^\s*(sí|si|vale|claro|ok|de acuerdo|perfecto|bueno|dígame|digame|adelante|venga)\b/i;
const ACKS = ['Entiendo.', 'Perfecto.', 'Claro.', 'Muy bien.', 'Vale, gracias.'];

/** Convierte una instrucción del guion ("Pregunta si vive…") en una frase hablada. */
export function stepToSpeech(step) {
  let s = step.replace(/^\s*\d+[.)-]\s*/, '').trim().replace(/\.$/, '');
  let m;
  if ((m = s.match(/^pregunta (?:si |)(.+)$/i))) return `¿${cap(m[1])}?`;
  if ((m = s.match(/^(?:explica|cuenta|di|comenta|indica) que (.+)$/i))) return cap(m[1]) + '.';
  if ((m = s.match(/^(?:propón|propon|ofrece) (.+?)(?: y pide (.+))?$/i))) {
    return `Le propongo ${m[1]}.` + (m[2] ? ` ¿Me dice ${m[2]}?` : '');
  }
  if (/^(confirma|despídete|despidete|cierra)/i.test(s)) return 'Perfecto, queda anotado. Muchas gracias por su tiempo y que tenga muy buen día.';
  return cap(s) + '.';
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class OfflineAgent {
  constructor(scriptText) {
    this.steps = scriptText
      .split('\n')
      .filter((l) => /^\s*\d+[.)-]\s+/.test(l))
      .map(stepToSpeech);
    if (!this.steps.length) {
      this.steps = ['¿Le puedo hacer un par de preguntas rápidas?', 'Perfecto, muchas gracias por su tiempo. Que tenga buen día.'];
    }
    this.i = 0;
    this.turn = 0;
  }

  /** Devuelve las frases de la respuesta. La última puede llevar [FIN]. */
  reply(text) {
    this.turn += 1;
    if (NO_INTEREST.test(text)) {
      return ['De acuerdo, lo entiendo perfectamente.', 'No le volveremos a llamar. Que tenga buen día. [FIN]'];
    }
    if (BUSY.test(text)) {
      return ['Sin problema, no le entretengo.', '¿Le parece bien que le llamemos en otro momento? [FIN]'];
    }
    if (ARE_YOU_HUMAN.test(text)) {
      return ['Soy un asistente virtual, no una persona.', 'Ahora mismo estoy en modo de prueba, sin inteligencia artificial.', this.steps[this.i] ?? '¿Seguimos?'];
    }
    const out = [];
    if (/\?\s*$/.test(text) || /^(qué|que|cuánto|cuanto|cómo|como|cuándo|cuando|dónde|donde|por qué)\b/i.test(text)) {
      out.push('Buena pregunta. Eso se lo explica con detalle una persona del equipo.');
    } else {
      out.push(YES.test(text) && this.turn === 1 ? 'Muchas gracias.' : ACKS[this.turn % ACKS.length]);
    }
    const next = this.steps[this.i++];
    if (!next) return [...out, 'Pues esto es todo por mi parte. Muchas gracias y que tenga buen día. [FIN]'];
    const last = this.i >= this.steps.length;
    out.push(last ? next + ' [FIN]' : next);
    return out;
  }
}
