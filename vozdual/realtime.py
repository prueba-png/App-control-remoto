"""Modo 1: tu micrófono -> conversión de voz -> micrófono virtual, en tiempo real."""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable

import numpy as np
import sounddevice as sd

from .converters import VoiceConverter
from .dsp import Sola, StreamResampler, rms_db

log = logging.getLogger(__name__)


class RingBuffer:
    """FIFO de audio con bloqueo, para pasar audio entre hilos."""

    def __init__(self, capacity: int):
        self.buf = np.zeros(capacity, dtype=np.float32)
        self.capacity = capacity
        self.start = 0
        self.size = 0
        self.lock = threading.Lock()

    def write(self, x: np.ndarray) -> int:
        """Escribe; si no cabe, descarta lo más antiguo. Devuelve muestras descartadas."""
        x = np.asarray(x, dtype=np.float32)
        with self.lock:
            dropped = 0
            if len(x) >= self.capacity:
                dropped = self.size + len(x) - self.capacity
                x = x[-self.capacity :]
                self.start, self.size = 0, 0
            overflow = self.size + len(x) - self.capacity
            if overflow > 0:
                self.start = (self.start + overflow) % self.capacity
                self.size -= overflow
                dropped += overflow
            end = (self.start + self.size) % self.capacity
            first = min(len(x), self.capacity - end)
            self.buf[end : end + first] = x[:first]
            self.buf[: len(x) - first] = x[first:]
            self.size += len(x)
            return dropped

    def read(self, n: int) -> tuple[np.ndarray, int]:
        """Lee n muestras; rellena con ceros si faltan. Devuelve (audio, faltantes)."""
        out = np.zeros(n, dtype=np.float32)
        with self.lock:
            k = min(n, self.size)
            first = min(k, self.capacity - self.start)
            out[:first] = self.buf[self.start : self.start + first]
            out[first:k] = self.buf[: k - first]
            self.start = (self.start + k) % self.capacity
            self.size -= k
        return out, n - k

    def __len__(self) -> int:
        with self.lock:
            return self.size


class BlockProcessor:
    """Lógica de la tubería, independiente de la tarjeta de sonido (testeable).

    feed(audio a in_sr) -> audio convertido a out_sr.
    """

    def __init__(self, converter: VoiceConverter, in_sr: int, out_sr: int, block_ms: int = 200,
                 gate_db: float = -50.0):
        self.conv = converter
        self.in_sr, self.out_sr = in_sr, out_sr
        self.block = int(converter.input_sr * block_ms / 1000)
        self.gate_db = gate_db
        self.to_conv = StreamResampler(in_sr, converter.input_sr)
        self.from_conv = StreamResampler(converter.output_sr, out_sr)
        self.pending = np.zeros(0, dtype=np.float32)
        self.sola = None
        if converter.uses_sola:
            self.sola = Sola(int(converter.output_sr * 0.02), int(converter.output_sr * 0.012))
        self.out_block = int(round(self.block * converter.output_sr / converter.input_sr))
        self.gate_open_until = 0.0
        self.last_infer_ms = 0.0
        self.level_db = -120.0

    def feed(self, x: np.ndarray) -> np.ndarray:
        self.pending = np.concatenate([self.pending, self.to_conv(x)])
        outs = []
        while len(self.pending) >= self.block:
            blk = self.pending[: self.block]
            self.pending = self.pending[self.block :]
            self.level_db = rms_db(blk)
            now = time.monotonic()
            if self.level_db > self.gate_db:
                self.gate_open_until = now + 0.4  # no cortar finales de palabra
            silent = now > self.gate_open_until
            t0 = time.perf_counter()
            if self.sola is not None:
                y = self.conv.process(blk, extra=self.sola.extra(), silent=silent)
                y = self.sola.consume(y, self.out_block)
            else:
                y = self.conv.process(blk, silent=silent)
            self.last_infer_ms = (time.perf_counter() - t0) * 1000
            outs.append(self.from_conv(y))
        return np.concatenate(outs) if outs else np.zeros(0, dtype=np.float32)


class RealtimeVoicePipeline:
    """Abre el micrófono físico y el micrófono virtual y mueve el audio entre ambos."""

    def __init__(self, converter: VoiceConverter, input_device: int, output_device: int,
                 block_ms: int = 200, gate_db: float = -50.0, monitor_device: int | None = None,
                 on_status: Callable[[dict], None] | None = None,
                 on_error: Callable[[str], None] | None = None):
        self.converter = converter
        self.input_device, self.output_device = input_device, output_device
        self.block_ms, self.gate_db = block_ms, gate_db
        self.on_status = on_status or (lambda s: None)
        self.on_error = on_error or (lambda m: None)
        self.in_sr = int(sd.query_devices(input_device)["default_samplerate"])
        self.out_sr = int(sd.query_devices(output_device)["default_samplerate"])
        self.q: queue.Queue[np.ndarray] = queue.Queue(maxsize=200)
        self.out = RingBuffer(self.out_sr * 3)
        self.prefill = int(self.out_sr * block_ms / 1000 * 0.5)
        self.primed = False
        self.underruns = 0
        self.overflows = 0
        self.stop_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.streams: list[sd._StreamBase] = []

    # -- callbacks de PortAudio (hilo de audio: nada pesado aquí) -------------
    def _on_input(self, indata, frames, time_info, status):
        if status.input_overflow:
            self.overflows += 1
        try:
            self.q.put_nowait(indata[:, 0].copy())
        except queue.Full:
            self.overflows += 1

    def _on_output(self, outdata, frames, time_info, status):
        if not self.primed:
            if len(self.out) < self.prefill:
                outdata.fill(0)
                return
            self.primed = True
        data, missing = self.out.read(frames)
        if missing:
            self.underruns += 1
            self.primed = False  # volver a acumular un poco de margen
        outdata[:, 0] = data
        if outdata.shape[1] > 1:
            outdata[:, 1:] = data[:, None]

    # -- hilo de procesado ----------------------------------------------------
    def _work(self):
        proc = BlockProcessor(self.converter, self.in_sr, self.out_sr, self.block_ms, self.gate_db)
        last_status = 0.0
        while not self.stop_event.is_set():
            try:
                x = self.q.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                y = proc.feed(x)
            except Exception as e:  # noqa: BLE001 - se informa en la interfaz
                log.exception("Error en la conversión")
                self.on_error(f"Error en la conversión de voz: {e}")
                self.stop_event.set()
                break
            if len(y):
                self.out.write(y)
            now = time.monotonic()
            if now - last_status > 0.25:
                last_status = now
                buffered_ms = len(self.out) / self.out_sr * 1000
                self.on_status({
                    "level_db": proc.level_db,
                    "infer_ms": proc.last_infer_ms,
                    "latency_ms": self.block_ms + proc.last_infer_ms + buffered_ms,
                    "underruns": self.underruns,
                    "overflows": self.overflows,
                    "realtime_ok": proc.last_infer_ms < self.block_ms * 0.8,
                })

    def start(self):
        self.stop_event.clear()
        self.worker = threading.Thread(target=self._work, name="vc-worker", daemon=True)
        self.worker.start()
        out_ch = min(2, max(1, int(sd.query_devices(self.output_device)["max_output_channels"])))
        blocksize_in = int(self.in_sr * 0.02)
        self.streams = [
            sd.InputStream(device=self.input_device, channels=1, samplerate=self.in_sr,
                           blocksize=blocksize_in, dtype="float32", latency="low",
                           callback=self._on_input),
            sd.OutputStream(device=self.output_device, channels=out_ch, samplerate=self.out_sr,
                            blocksize=int(self.out_sr * 0.02), dtype="float32", latency="low",
                            callback=self._on_output),
        ]
        for s in self.streams:
            s.start()
        log.info("Conversión en vivo: %s Hz -> %s -> %s Hz", self.in_sr, self.converter.name, self.out_sr)

    def stop(self):
        self.stop_event.set()
        for s in self.streams:
            try:
                s.stop()
                s.close()
            except Exception:  # noqa: BLE001
                pass
        self.streams = []
        if self.worker:
            self.worker.join(timeout=2)
