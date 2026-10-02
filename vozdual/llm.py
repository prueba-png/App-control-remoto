"""Cerebro del agente: guion de ventas + Claude, con respuesta en streaming por frases."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterator
from pathlib import Path

import anthropic

log = logging.getLogger(__name__)

END_TOKEN = "[FIN]"
DEFAULT_DISCLOSURE = "Hola, le habla un asistente virtual con inteligencia artificial{empresa}."

_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+|\n+")


def load_script(path: str | Path) -> dict:
    """Carga un guion .txt (texto libre) o .json (estructurado)."""
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if p.suffix.lower() == ".json":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("El guion JSON debe ser un objeto con campos como 'empresa', 'objetivo', 'pasos'…")
        return data
    return {"guion": text}


def opening_line(script: dict, company: str = "") -> str:
    """Primera frase del agente. Siempre incluye que es una IA."""
    empresa = script.get("empresa") or company
    opening = (script.get("apertura") or "").strip()
    disclosure = DEFAULT_DISCLOSURE.format(empresa=f" de {empresa}" if empresa else "")
    mentions_ai = re.search(r"\b(asistente virtual|inteligencia artificial|\bIA\b|robot|automátic)", opening, re.I)
    if not opening:
        return disclosure + " ¿Tiene un momento?"
    return opening if mentions_ai else f"{disclosure} {opening}"


def build_system_prompt(script: dict, company: str = "", language: str = "es") -> str:
    empresa = script.get("empresa") or company or "la empresa"
    body = json.dumps(script, ensure_ascii=False, indent=2) if set(script) != {"guion"} else script["guion"]
    return f"""Eres un asistente de voz con inteligencia artificial que atiende una llamada telefónica en nombre de {empresa}.
Tu objetivo y la información que puedes usar están en el guion de abajo.

Sigue el guion (esto es lo más importante):
- Céntrate en el objetivo y los pasos del guion, en su orden. No te desvíes a otros temas ni cambies de asunto por tu cuenta.
- Escucha lo que la persona acaba de decir y respóndele primero; luego sigue con el paso del guion que toca. No te saltes pasos ni te adelantes varios a la vez.
- Si la persona se va por las ramas o pregunta algo fuera del guion, contéstale breve y con educación y vuelve enseguida al paso en el que estabas.
- No inventes contenido nuevo que no esté en el guion: cíñete a lo que dice.

Cómo hablas:
- Como un buen comercial al teléfono: cercano, natural, seguro y sin sonar a lectura. Usa expresiones normales («claro», «entiendo», «perfecto») sin abusar.
- Una idea y como mucho una pregunta por turno. Frases cortas: lo que digas se convierte en voz.
- Recuerda lo que te han contado (nombre, situación, horarios) y úsalo después.
- Sin listas, sin emojis, sin markdown, sin URLs largas. Los números, escritos como se dicen.
- Idioma de la conversación: {language}. Si la otra persona cambia de idioma, síguela.

Límites que no se negocian:
- Eres una IA. Ya lo has dicho en la apertura, una vez y de forma natural; no hace falta repetirlo salvo que te pregunten. Si te preguntan si eres una persona o un robot, dilo con naturalidad («soy un asistente virtual»). No digas nunca que eres una persona.
- No inventes datos, precios, plazos ni condiciones que no estén en el guion. Si no lo sabes, ofrece que una persona del equipo le contacte.
- Si la persona dice que no le interesa, pide que no la llamen más o quiere colgar, despídete con amabilidad, confirma que se respetará y termina.
- No presiones, no uses urgencias falsas y no pidas contraseñas, códigos ni datos bancarios completos.
- Cuando la conversación haya terminado (despedida hecha), escribe {END_TOKEN} al final de tu última respuesta.

Guion:
{body}
"""


def split_sentences(buffer: str) -> tuple[list[str], str]:
    """Separa las frases completas del texto acumulado. Devuelve (frases, resto)."""
    parts = _SENTENCE_END.split(buffer)
    if len(parts) <= 1:
        return [], buffer
    done = [p.strip() for p in parts[:-1] if p.strip()]
    return done, parts[-1]


class SalesBrain:
    def __init__(self, script: dict, model: str = "claude-opus-5-5", effort: str = "low",
                 api_key: str | None = None, company: str = "", language: str = "es",
                 client: anthropic.Anthropic | None = None):
        self.client = client or (anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic())
        self.model = model
        self.effort = effort
        self.opening = opening_line(script, company)
        self.system = build_system_prompt(script, company, language) + (
            f"\nYa has dicho esta apertura al descolgar: «{self.opening}»\n"
        )
        self.messages: list[dict] = []
        self.finished = False

    def reply(self, user_text: str) -> Iterator[str]:
        """Envía lo que dijo la otra persona y va devolviendo frases para sintetizar."""
        self.messages.append({"role": "user", "content": user_text})
        buffer = ""
        try:
            with self.client.beta.messages.stream(
                model=self.model,
                max_tokens=1024,  # respuestas habladas, deliberadamente cortas
                system=self.system,
                messages=self.messages,
                output_config={"effort": self.effort},
                cache_control={"type": "ephemeral"},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            ) as stream:
                for text in stream.text_stream:
                    buffer += text
                    sentences, buffer = split_sentences(buffer)
                    for s in sentences:
                        yield from self._emit(s)
                final = stream.get_final_message()
        except anthropic.AuthenticationError:
            self.messages.pop()
            raise RuntimeError("La clave de la API de Claude no es válida (ANTHROPIC_API_KEY).") from None
        except anthropic.RateLimitError:
            self.messages.pop()
            yield "Disculpe, un momento por favor."
            return
        except anthropic.APIConnectionError:
            self.messages.pop()
            yield "Perdone, tengo problemas de conexión. ¿Me lo puede repetir?"
            return
        except anthropic.APIStatusError as e:
            self.messages.pop()
            raise RuntimeError(f"Error de la API de Claude ({e.status_code}): {e.message}") from None

        if buffer.strip():
            yield from self._emit(buffer.strip())

        if final.stop_reason == "refusal":
            yield "Lo siento, con eso no puedo ayudarle. Si quiere, le paso con una persona del equipo."
            self.messages.append({"role": "assistant", "content": "Lo siento, con eso no puedo ayudarle."})
            return
        content = final.content
        if any(b.type == "fallback" for b in content):
            # Tras un relevo de modelo solo se reenvía el texto (ver docs de fallbacks).
            content = [{"type": "text", "text": "".join(b.text for b in content if b.type == "text") or "…"}]
        self.messages.append({"role": "assistant", "content": content})

    def _emit(self, sentence: str) -> Iterator[str]:
        if END_TOKEN in sentence:
            self.finished = True
            sentence = sentence.replace(END_TOKEN, "").strip()
        if sentence:
            yield sentence
