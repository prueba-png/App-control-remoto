"""Escucha y transcripción local (faster-whisper) del audio de la llamada."""

from __future__ import annotations

import logging
import queue
import threading

import numpy as np
import sounddevice as sd

from .dsp import EnergyVAD, StreamResampler

log = logging.getLogger(__name__)

STT_SR = 16000


class Transcriber:
    def __init__(self, model_size: str = "small", device: str = "auto", language: str = "es"):
        from faster_whisper import WhisperModel

        compute = "int8" if device == "cpu" else "default"
        self.model = WhisperModel(model_size, device=device, compute_type=compute)
        self.language = language or None

    def transcribe(self, audio16k: np.ndarray, context: str = "") -> str:
        segments, _info = self.model.transcribe(
            audio16k.astype(np.float32),
            language=self.language,
            beam_size=1,
            condition_on_previous_text=False,
            vad_filter=False,
            initial_prompt=context or None,
        )
        return " ".join(s.text.strip() for s in segments).strip()


class UtteranceListener:
    """Captura un dispositivo de entrada y entrega frases completas (audio 16 kHz).

    Mientras `paused` está activo (el agente está hablando) se descarta lo que
    entra, para que el agente no se escuche a sí mismo.
    """

    def __init__(self, device: int):
        self.device = device
        self.sr = int(sd.query_devices(device)["default_samplerate"])
        self.resampler = StreamResampler(self.sr, STT_SR)
        self.vad = EnergyVAD(STT_SR)
        self.utterances: queue.Queue[np.ndarray] = queue.Queue()
        self.paused = threading.Event()
        self.level_db = -120.0
        self.stream: sd.InputStream | None = None
        self._raw: queue.Queue[np.ndarray] = queue.Queue(maxsize=500)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _cb(self, indata, frames, t, status):
        try:
            self._raw.put_nowait(indata[:, 0].copy())
        except queue.Full:
            pass

    def _loop(self):
        while not self._stop.is_set():
            try:
                x = self._raw.get(timeout=0.1)
            except queue.Empty:
                continue
            y = self.resampler(x)
            if self.paused.is_set():
                self.vad.reset()
                continue
            for utt in self.vad.feed(y):
                if len(utt) > STT_SR * 0.3:
                    self.utterances.put(utt)

    def start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="stt-listener", daemon=True)
        self._thread.start()
        self.stream = sd.InputStream(device=self.device, channels=1, samplerate=self.sr,
                                     blocksize=int(self.sr * 0.03), dtype="float32", callback=self._cb)
        self.stream.start()

    def stop(self):
        self._stop.set()
        if self.stream:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:  # noqa: BLE001
                pass
            self.stream = None
        if self._thread:
            self._thread.join(timeout=2)
