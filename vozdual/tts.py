"""Síntesis de voz local con Piper, opcionalmente pasada por el modelo de voz clonada."""

from __future__ import annotations

import logging
import threading

import numpy as np
import sounddevice as sd

from .converters import VoiceConverter
from .dsp import resample

log = logging.getLogger(__name__)


class Speaker:
    def __init__(self, piper_model: str, output_device: int, converter: VoiceConverter | None = None,
                 use_cuda: bool = False):
        from piper import PiperVoice

        self.voice = PiperVoice.load(piper_model, use_cuda=use_cuda)
        self.output_device = output_device
        self.out_sr = int(sd.query_devices(output_device)["default_samplerate"])
        self.out_ch = min(2, max(1, int(sd.query_devices(output_device)["max_output_channels"])))
        self.converter = converter
        self.stop_event = threading.Event()

    def render(self, text: str) -> np.ndarray:
        """Texto -> audio listo para el dispositivo de salida (a out_sr)."""
        parts = []
        sr = None
        for chunk in self.voice.synthesize(text):
            sr = chunk.sample_rate
            parts.append(chunk.audio_float_array.astype(np.float32))
        if not parts:
            return np.zeros(0, dtype=np.float32)
        audio = np.concatenate(parts)
        if self.converter is not None:
            audio, sr = self.converter.convert_utterance(audio, sr)
        audio = resample(audio, sr, self.out_sr)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak > 0.98:
            audio = audio * (0.98 / peak)
        return audio

    def play(self, audio: np.ndarray) -> bool:
        """Reproduce en el micrófono virtual. Devuelve False si se interrumpió."""
        self.stop_event.clear()
        chunk = int(self.out_sr * 0.1)
        with sd.OutputStream(device=self.output_device, samplerate=self.out_sr,
                             channels=self.out_ch, dtype="float32") as stream:
            for i in range(0, len(audio), chunk):
                if self.stop_event.is_set():
                    return False
                block = audio[i : i + chunk]
                stream.write(np.repeat(block[:, None], self.out_ch, axis=1))
        return True

    def say(self, text: str) -> bool:
        return self.play(self.render(text))

    def stop(self):
        self.stop_event.set()
