"""Motores de conversión de voz.

Todos comparten la misma interfaz de streaming:
    process(block) -> audio
`block` llega a `input_sr`; la salida está a `output_sr` y dura lo mismo que
el bloque (si `uses_sola` es True, trae además `sola_extra` muestras para que
la tubería haga el empalme). `convert_utterance` convierte una frase entera
de una vez (lo usa el agente para pasar la voz sintética por el modelo).
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from .dsp import resample, yin_f0

log = logging.getLogger(__name__)


class VoiceConverter:
    name = "base"
    input_sr = 48000
    output_sr = 48000
    uses_sola = False

    def process(self, block: np.ndarray, extra: int = 0, silent: bool = False) -> np.ndarray:
        raise NotImplementedError

    def convert_utterance(self, audio: np.ndarray, sr: int) -> tuple[np.ndarray, int]:
        """Convierte un audio completo. Por defecto lo pasa por process() a bloques."""
        x = resample(audio, sr, self.input_sr)
        block = int(self.input_sr * 0.1)
        x = np.pad(x, (0, -len(x) % block + block))
        out = [self.process(x[i : i + block]) for i in range(0, len(x), block)]
        y = np.concatenate(out)
        latency = getattr(self, "latency_samples", 0)
        return y[latency:], self.output_sr

    def reset(self) -> None:
        pass


class PassthroughConverter(VoiceConverter):
    """Sin cambios: útil para comprobar dispositivos y latencia."""

    name = "Sin cambios (prueba)"

    def __init__(self, sr: int = 48000):
        self.input_sr = self.output_sr = sr

    def process(self, block, extra=0, silent=False):
        out = np.asarray(block, dtype=np.float32)
        return np.zeros_like(out) if silent else out.copy()


class PitchFormantConverter(VoiceConverter):
    """Cambio de tono y de timbre (formantes) en tiempo real, 100 % local.

    Vocoder de fase con separación fuente-filtro por cepstro: la excitación
    (tono) y la envolvente espectral (timbre) se desplazan por separado, así
    que se puede subir el tono sin efecto "ardilla" o cambiar el timbre sin
    tocar el tono. No clona una voz concreta: para eso está RVC.
    """

    name = "Tono y timbre (DSP)"

    def __init__(self, semitones: float = 0.0, formant: float = 1.0, sr: int = 24000,
                 n_fft: int = 1024, hop: int = 256, lifter: int = 32):
        self.input_sr = self.output_sr = sr
        self.n_fft, self.hop, self.lifter = n_fft, hop, lifter
        self.window = np.hanning(n_fft + 1)[:-1].astype(np.float64)
        self.ola_norm = float(np.sum(self.window ** 2) / hop)
        self.bins = np.arange(n_fft // 2 + 1)
        self.omega = 2 * np.pi * self.bins / n_fft
        self.latency_samples = n_fft  # (n_fft - hop) de la ventana + hop de holgura
        self.set_params(semitones, formant)
        self.reset()

    def set_params(self, semitones: float, formant: float) -> None:
        self.alpha = float(2 ** (semitones / 12.0))
        self.beta = float(formant)

    def reset(self) -> None:
        self.in_buf = np.zeros(self.n_fft - self.hop, dtype=np.float64)
        self.out_buf = np.zeros(self.n_fft, dtype=np.float64)
        self.prev_phase = np.zeros(len(self.bins))
        self.syn_phase = np.zeros(len(self.bins))
        self.pending = np.zeros(0, dtype=np.float64)
        # Holgura de un hop: así siempre hay salida para bloques de cualquier tamaño.
        self.out_fifo = np.zeros(self.hop, dtype=np.float64)

    def _envelope(self, log_mag: np.ndarray) -> np.ndarray:
        cep = np.fft.irfft(log_mag, self.n_fft)
        cep[self.lifter : self.n_fft - self.lifter] = 0.0
        return np.fft.rfft(cep, self.n_fft).real

    def _frame(self, frame: np.ndarray) -> np.ndarray:
        spec = np.fft.rfft(frame * self.window)
        mag = np.abs(spec) + 1e-9
        phase = np.angle(spec)
        dphi = phase - self.prev_phase - self.hop * self.omega
        self.prev_phase = phase
        dphi = (dphi + np.pi) % (2 * np.pi) - np.pi
        inst = self.omega + dphi / self.hop

        if self.alpha == 1.0 and self.beta == 1.0:
            new_mag, new_inst = mag, inst
        else:
            log_env = self._envelope(np.log(mag))
            exc = np.log(mag) - log_env
            src = self.bins / self.alpha
            new_exc = np.interp(src, self.bins, exc, right=-20.0)
            new_inst = self.alpha * np.interp(src, self.bins, inst, right=0.0)
            new_env = np.interp(self.bins / self.beta, self.bins, log_env, right=log_env[-1])
            new_mag = np.exp(new_exc + new_env)

        self.syn_phase = self.syn_phase + self.hop * new_inst
        out = np.fft.irfft(new_mag * np.exp(1j * self.syn_phase), self.n_fft)
        return out * self.window / self.ola_norm

    def process(self, block, extra=0, silent=False):
        x = np.asarray(block, dtype=np.float64)
        self.pending = np.concatenate([self.pending, x])
        produced = []
        while len(self.pending) >= self.hop:
            new = self.pending[: self.hop]
            self.pending = self.pending[self.hop :]
            frame = np.concatenate([self.in_buf, new])
            self.in_buf = frame[self.hop :]
            self.out_buf += self._frame(frame)
            produced.append(self.out_buf[: self.hop].copy())
            self.out_buf = np.concatenate([self.out_buf[self.hop :], np.zeros(self.hop)])
        if produced:
            self.out_fifo = np.concatenate([self.out_fifo, *produced])
        y = self.out_fifo[: len(x)].astype(np.float32)
        self.out_fifo = self.out_fifo[len(x) :]
        return np.zeros_like(y) if silent else y


def _pick_providers(prefer_gpu: bool = True) -> list[str]:
    import onnxruntime as ort

    available = ort.get_available_providers()
    order = ["CUDAExecutionProvider", "DmlExecutionProvider", "CoreMLExecutionProvider"] if prefer_gpu else []
    chosen = [p for p in order if p in available]
    return chosen + ["CPUExecutionProvider"]


class RVCOnnxConverter(VoiceConverter):
    """Voz clonada con un modelo RVC exportado a ONNX (sin PyTorch).

    Necesita dos ficheros:
      - el modelo de la voz (`.onnx`, exportado desde RVC WebUI o w-okada),
      - el extractor de contenido ContentVec en ONNX (p. ej. vec-768-layer-12.onnx).

    Flujo por bloque: audio 16 kHz + contexto -> ContentVec (rasgos 50 fps,
    duplicados a 100 fps) + F0 con YIN (100 fps) -> sintetizador RVC -> cola
    del resultado para empalmar con SOLA.
    """

    name = "Voz clonada (RVC ONNX)"
    input_sr = 16000
    uses_sola = True

    F0_MIN, F0_MAX = 50.0, 1100.0

    def __init__(self, model_path: str | Path, contentvec_path: str | Path,
                 output_sr: int = 40000, semitones: float = 0.0, speaker_id: int = 0,
                 context_s: float = 0.6, prefer_gpu: bool = True):
        import onnxruntime as ort

        providers = _pick_providers(prefer_gpu)
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.vec = ort.InferenceSession(str(contentvec_path), opts, providers=providers)
        self.rvc = ort.InferenceSession(str(model_path), opts, providers=providers)
        self.providers = self.rvc.get_providers()
        self.output_sr = int(output_sr)
        self.semitones = float(semitones)
        self.speaker_id = int(speaker_id)
        self.context = int(context_s * self.input_sr)
        self.hist = np.zeros(self.context, dtype=np.float32)

        self._vec_in = self.vec.get_inputs()[0]
        self._rvc_inputs = {i.name: i for i in self.rvc.get_inputs()}
        names = list(self._rvc_inputs)
        # Nombres estándar del exportador de RVC; si no coinciden, se usa el orden.
        std = ["phone", "phone_lengths", "pitch", "pitchf", "ds", "rnd"]
        if all(n in self._rvc_inputs for n in std):
            self._map = {n: n for n in std}
        elif len(names) >= 6:
            self._map = dict(zip(std, names[:6]))
        else:
            raise ValueError(
                "Este modelo ONNX no parece un modelo RVC con tono (f0). "
                f"Entradas encontradas: {names}"
            )
        phone_shape = self._rvc_inputs[self._map["phone"]].shape
        self.feat_dim = phone_shape[-1] if isinstance(phone_shape[-1], int) else 768
        log.info("RVC ONNX cargado (%s), proveedores: %s", self.feat_dim, self.providers)

    def set_params(self, semitones: float) -> None:
        self.semitones = float(semitones)

    def reset(self) -> None:
        self.hist = np.zeros(self.context, dtype=np.float32)

    # -- piezas del modelo --------------------------------------------------
    def _contentvec(self, x16: np.ndarray) -> np.ndarray:
        rank = len(self._vec_in.shape)
        inp = x16.astype(np.float32)[None, None, :] if rank == 3 else x16.astype(np.float32)[None, :]
        if self._vec_in.type == "tensor(float16)":
            inp = inp.astype(np.float16)
        feats = self.vec.run(None, {self._vec_in.name: inp})[0]
        feats = np.asarray(feats, dtype=np.float32)
        if feats.ndim == 3 and feats.shape[1] == self.feat_dim and feats.shape[2] != self.feat_dim:
            feats = feats.transpose(0, 2, 1)
        if feats.shape[-1] != self.feat_dim:
            raise ValueError(
                f"ContentVec devuelve {feats.shape[-1]} dimensiones y el modelo RVC espera "
                f"{self.feat_dim}. Usa un ContentVec de {self.feat_dim} (v2 = 768, v1 = 256)."
            )
        return np.repeat(feats, 2, axis=1)  # 50 fps -> 100 fps

    @classmethod
    def coarse_pitch(cls, f0: np.ndarray) -> np.ndarray:
        mel_min = 1127 * np.log(1 + cls.F0_MIN / 700)
        mel_max = 1127 * np.log(1 + cls.F0_MAX / 700)
        mel = 1127 * np.log(1 + f0 / 700)
        voiced = mel > 0
        mel[voiced] = (mel[voiced] - mel_min) * 254 / (mel_max - mel_min) + 1
        mel[mel <= 1] = 1
        mel[mel > 255] = 255
        return np.rint(mel).astype(np.int64)

    def _infer(self, x16: np.ndarray) -> np.ndarray:
        feats = self._contentvec(x16)
        f0 = yin_f0(x16, self.input_sr, 160, self.F0_MIN, self.F0_MAX)
        f0 = f0 * float(2 ** (self.semitones / 12.0))
        p_len = min(feats.shape[1], len(f0))
        feats, f0 = feats[:, :p_len], f0[:p_len]
        float_t = np.float16 if self._rvc_inputs[self._map["phone"]].type == "tensor(float16)" else np.float32
        feed = {
            self._map["phone"]: feats.astype(float_t),
            self._map["phone_lengths"]: np.array([p_len], dtype=np.int64),
            self._map["pitch"]: self.coarse_pitch(f0.copy())[None, :],
            self._map["pitchf"]: f0[None, :].astype(float_t),
            self._map["ds"]: np.array([self.speaker_id], dtype=np.int64),
            self._map["rnd"]: np.random.randn(1, 192, p_len).astype(float_t),
        }
        audio = self.rvc.run(None, feed)[0]
        return np.asarray(audio, dtype=np.float32).reshape(-1)

    # -- interfaz -------------------------------------------------------------
    def process(self, block, extra=0, silent=False):
        block = np.asarray(block, dtype=np.float32)
        window = np.concatenate([self.hist, block])
        self.hist = window[-self.context :] if self.context else np.zeros(0, np.float32)
        out_len = int(round(len(block) * self.output_sr / self.input_sr)) + extra
        if silent:
            return np.zeros(out_len, dtype=np.float32)
        y = self._infer(window)
        if len(y) < out_len:
            y = np.pad(y, (out_len - len(y), 0))
        return y[-out_len:]

    def convert_utterance(self, audio, sr):
        x = resample(audio, sr, self.input_sr)
        x = np.pad(x, (1600, 1600))  # pequeño margen para no comerse bordes
        y = self._infer(x)
        m = int(0.1 * self.output_sr)
        return y[m:-m] if len(y) > 2 * m else y, self.output_sr


ENGINES = [PassthroughConverter.name, PitchFormantConverter.name, RVCOnnxConverter.name]


def build_converter(cfg) -> VoiceConverter:
    """Crea el motor elegido a partir de la configuración (vozdual.config.Settings)."""
    if cfg.engine == RVCOnnxConverter.name:
        if not cfg.rvc_model or not Path(cfg.rvc_model).is_file():
            raise FileNotFoundError("Elige el modelo de voz RVC (.onnx) en la pestaña Voz.")
        if not cfg.contentvec_model or not Path(cfg.contentvec_model).is_file():
            raise FileNotFoundError("Elige el modelo ContentVec (.onnx) en la pestaña Voz.")
        return RVCOnnxConverter(cfg.rvc_model, cfg.contentvec_model, output_sr=cfg.rvc_sample_rate,
                                semitones=cfg.semitones, speaker_id=cfg.rvc_speaker_id,
                                prefer_gpu=cfg.use_gpu)
    if cfg.engine == PitchFormantConverter.name:
        return PitchFormantConverter(semitones=cfg.semitones, formant=cfg.formant)
    return PassthroughConverter()
