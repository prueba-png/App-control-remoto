"""Modo 2: escucha la llamada -> transcribe -> Claude -> voz sintética -> micrófono virtual."""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable

from .llm import SalesBrain
from .stt import Transcriber, UtteranceListener
from .tts import Speaker

log = logging.getLogger(__name__)


class AutonomousAgent:
    def __init__(self, brain: SalesBrain, transcriber: Transcriber, listener: UtteranceListener,
                 speaker: Speaker, on_event: Callable[[str, str], None]):
        """on_event(tipo, texto): tipo es 'cliente', 'agente', 'info' o 'error'."""
        self.brain, self.stt, self.listener, self.speaker = brain, transcriber, listener, speaker
        self.on_event = on_event
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self):
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, name="agent", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.speaker.stop()
        self.listener.stop()
        if self.thread:
            self.thread.join(timeout=3)

    def _speak(self, sentence: str) -> bool:
        self.on_event("agente", sentence)
        self.listener.paused.set()
        try:
            return self.speaker.say(sentence)
        finally:
            time.sleep(0.15)  # que no se cuele la cola del propio audio
            self.listener.paused.clear()

    def _run(self):
        try:
            self.listener.start()
            self.on_event("info", "Agente escuchando la llamada.")
            self._speak(self.brain.opening)
            last_heard = ""
            while not self.stop_event.is_set():
                try:
                    audio = self.listener.utterances.get(timeout=0.2)
                except queue.Empty:
                    continue
                t0 = time.perf_counter()
                text = self.stt.transcribe(audio, context=last_heard[-200:])
                if not text or len(text) < 2:
                    continue
                last_heard = text
                self.on_event("cliente", text)
                first = True
                for sentence in self.brain.reply(text):
                    if self.stop_event.is_set():
                        break
                    if first:
                        self.on_event("info", f"Primera respuesta en {time.perf_counter() - t0:.1f} s")
                        first = False
                    if not self._speak(sentence):
                        break
                if self.brain.finished:
                    self.on_event("info", "El agente ha cerrado la conversación.")
                    break
        except Exception as e:  # noqa: BLE001 - se muestra en la interfaz
            log.exception("Fallo del agente")
            self.on_event("error", str(e))
        finally:
            self.listener.stop()
            self.on_event("fin", "")
