"""Bloques de procesado de señal reutilizables (sin dependencias pesadas).

- StreamResampler: cambio de frecuencia de muestreo por bloques sin cortes.
- yin_f0: estimación de tono (F0) vectorizada con el algoritmo YIN.
- Sola: empalme de bloques convertidos sin "clics" (crossfade con búsqueda).
- EnergyVAD: detector de voz por energía con suelo de ruido adaptativo.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import soxr


def rms_db(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return 20.0 * np.log10(max(rms, 1e-6))


class StreamResampler:
    """Resampler con estado: los bloques consecutivos se unen sin discontinuidades."""

    def __init__(self, in_rate: int, out_rate: int):
        self.in_rate = int(in_rate)
        self.out_rate = int(out_rate)
        self._stream = None
        if self.in_rate != self.out_rate:
            self._stream = soxr.ResampleStream(self.in_rate, self.out_rate, 1, dtype="float32")

    def __call__(self, x: np.ndarray, last: bool = False) -> np.ndarray:
        x = np.ascontiguousarray(x, dtype=np.float32)
        if self._stream is None:
            return x
        return self._stream.resample_chunk(x, last=last)


def resample(x: np.ndarray, in_rate: int, out_rate: int) -> np.ndarray:
    """Cambio de frecuencia de un audio completo (no streaming)."""
    if int(in_rate) == int(out_rate):
        return np.asarray(x, dtype=np.float32)
    return soxr.resample(np.asarray(x, dtype=np.float32), int(in_rate), int(out_rate)).astype(np.float32)


def yin_f0(
    x: np.ndarray,
    sr: int,
    hop: int,
    fmin: float = 50.0,
    fmax: float = 1100.0,
    threshold: float = 0.15,
    silence_db: float = -50.0,
) -> np.ndarray:
    """F0 por trama con YIN. Devuelve len(x)//hop + 1 valores; 0 = sordo/silencio."""
    x = np.asarray(x, dtype=np.float32)
    n_frames = len(x) // hop + 1
    tau_min = max(2, int(sr / fmax))
    tau_max = int(sr / fmin)
    w = tau_max  # ventana de integración
    frame_len = w + tau_max + 1
    pad = frame_len // 2
    xp = np.pad(x, (pad, pad + frame_len))
    idx = np.arange(n_frames)[:, None] * hop + np.arange(frame_len)[None, :]
    frames = xp[idx].astype(np.float64)

    # Función diferencia d(tau) = r(0)+r_tau(0)-2 r(tau), calculada con FFT.
    n_fft = 1 << int(np.ceil(np.log2(2 * frame_len)))
    a = frames[:, :w]
    fa = np.fft.rfft(a, n_fft)
    fb = np.fft.rfft(frames, n_fft)
    cross = np.fft.irfft(np.conj(fa) * fb, n_fft)[:, : tau_max + 1]
    sq = np.square(frames)
    csum = np.concatenate([np.zeros((n_frames, 1)), np.cumsum(sq, axis=1)], axis=1)
    taus = np.arange(tau_max + 1)
    energy_a = csum[:, w][:, None]
    energy_b = csum[:, taus + w] - csum[:, taus]
    d = energy_a + energy_b - 2.0 * cross
    d[:, 0] = 0.0

    # Diferencia normalizada acumulada.
    cmnd = np.ones_like(d)
    cums = np.cumsum(d[:, 1:], axis=1)
    cmnd[:, 1:] = d[:, 1:] * np.arange(1, tau_max + 1)[None, :] / np.maximum(cums, 1e-12)

    f0 = np.zeros(n_frames, dtype=np.float32)
    level = 10 * np.log10(np.mean(a * a, axis=1) + 1e-12)
    for i in range(n_frames):
        if level[i] < silence_db:
            continue
        c = cmnd[i]
        below = np.where(c[tau_min:] < threshold)[0]
        if below.size == 0:
            continue
        t = below[0] + tau_min
        while t + 1 <= tau_max and c[t + 1] < c[t]:
            t += 1
        # Interpolación parabólica para afinar el periodo.
        if 1 <= t < tau_max:
            s0, s1, s2 = c[t - 1], c[t], c[t + 1]
            denom = s0 - 2 * s1 + s2
            shift = 0.5 * (s0 - s2) / denom if abs(denom) > 1e-12 else 0.0
            period = t + float(np.clip(shift, -1, 1))
        else:
            period = float(t)
        f0[i] = sr / period
    return f0


class Sola:
    """Empalma bloques convertidos buscando el desfase de mejor correlación.

    Cada bloque recibido debe tener len = salida + crossfade + search muestras;
    devuelve exactamente `salida` muestras.
    """

    def __init__(self, crossfade: int, search: int):
        self.cf = int(crossfade)
        self.search = int(search)
        t = np.linspace(0.0, np.pi / 2, self.cf, dtype=np.float32)
        self.fade_in = np.sin(t) ** 2
        self.fade_out = np.cos(t) ** 2
        self.prev_tail: np.ndarray | None = None

    def extra(self) -> int:
        return self.cf + self.search

    def consume(self, chunk: np.ndarray, out_len: int) -> np.ndarray:
        chunk = np.asarray(chunk, dtype=np.float32)
        need = out_len + self.cf + self.search
        if len(chunk) < need:
            chunk = np.pad(chunk, (need - len(chunk), 0))
        if self.prev_tail is None:
            o = self.search
        else:
            o = self._best_offset(chunk)
        seg = chunk[o : o + out_len + self.cf].copy()
        if self.prev_tail is not None and self.cf:
            seg[: self.cf] = self.prev_tail * self.fade_out + seg[: self.cf] * self.fade_in
        self.prev_tail = seg[out_len : out_len + self.cf].copy()
        return seg[:out_len]

    def _best_offset(self, chunk: np.ndarray) -> int:
        if self.search == 0 or self.cf == 0:
            return 0
        ref = self.prev_tail
        win = chunk[: self.search + self.cf]
        num = np.correlate(win, ref, mode="valid")
        energy = np.convolve(np.square(win), np.ones(self.cf, dtype=np.float32), mode="valid")
        score = num / np.sqrt(energy + 1e-8)
        return int(np.argmax(score))


@dataclass
class VADConfig:
    frame_ms: int = 30
    start_ms: int = 150        # voz continua necesaria para empezar
    end_silence_ms: int = 700  # silencio que cierra la frase
    preroll_ms: int = 300
    max_utterance_s: float = 20.0
    min_db: float = -45.0      # nunca se considera voz por debajo de esto
    ratio_db: float = 10.0     # dB por encima del ruido de fondo


class EnergyVAD:
    """Detector de frases por energía. Alimentar con audio mono a `sr`.

    feed() devuelve una lista (normalmente vacía) de frases completas.
    """

    def __init__(self, sr: int, cfg: VADConfig | None = None):
        self.sr = sr
        self.cfg = cfg or VADConfig()
        self.frame = int(sr * self.cfg.frame_ms / 1000)
        self.noise_db = -60.0
        self._pending = np.zeros(0, dtype=np.float32)
        self._preroll: list[np.ndarray] = []
        self._speech: list[np.ndarray] = []
        self._in_speech = False
        self._voiced_run = 0
        self._silence_run = 0

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    def reset(self) -> None:
        self._pending = np.zeros(0, dtype=np.float32)
        self._preroll.clear()
        self._speech.clear()
        self._in_speech = False
        self._voiced_run = self._silence_run = 0

    def feed(self, x: np.ndarray) -> list[np.ndarray]:
        c = self.cfg
        out: list[np.ndarray] = []
        self._pending = np.concatenate([self._pending, np.asarray(x, dtype=np.float32)])
        n_pre = max(1, c.preroll_ms // c.frame_ms)
        n_start = max(1, c.start_ms // c.frame_ms)
        n_end = max(1, c.end_silence_ms // c.frame_ms)
        n_max = int(c.max_utterance_s * 1000 / c.frame_ms)
        while len(self._pending) >= self.frame:
            f = self._pending[: self.frame]
            self._pending = self._pending[self.frame :]
            db = rms_db(f)
            voiced = db > max(c.min_db, self.noise_db + c.ratio_db)
            if not voiced:
                # El suelo de ruido sigue lentamente al nivel de los silencios.
                self.noise_db = 0.95 * self.noise_db + 0.05 * db
            if not self._in_speech:
                self._preroll.append(f)
                if len(self._preroll) > n_pre + n_start:
                    self._preroll.pop(0)
                self._voiced_run = self._voiced_run + 1 if voiced else 0
                if self._voiced_run >= n_start:
                    self._in_speech = True
                    self._speech = list(self._preroll)
                    self._preroll.clear()
                    self._silence_run = 0
            else:
                self._speech.append(f)
                self._silence_run = 0 if voiced else self._silence_run + 1
                if self._silence_run >= n_end or len(self._speech) >= n_max:
                    keep = len(self._speech) - max(0, self._silence_run - 3)
                    out.append(np.concatenate(self._speech[:keep]))
                    self._speech = []
                    self._in_speech = False
                    self._voiced_run = 0
        return out
