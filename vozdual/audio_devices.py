"""Listado de dispositivos de audio y detección del micrófono virtual."""

from __future__ import annotations

from dataclasses import dataclass

import sounddevice as sd

# Nombres típicos de cables de audio virtuales gratuitos.
VIRTUAL_HINTS = ("cable input", "vb-audio", "blackhole", "voicemeeter", "virtual", "loopback")


@dataclass(frozen=True)
class Device:
    index: int
    name: str
    hostapi: str
    max_in: int
    max_out: int
    samplerate: int

    @property
    def label(self) -> str:
        return f"{self.name} [{self.hostapi}]"


def list_devices() -> list[Device]:
    apis = [a["name"] for a in sd.query_hostapis()]
    out = []
    for i, d in enumerate(sd.query_devices()):
        out.append(Device(i, d["name"], apis[d["hostapi"]], d["max_input_channels"],
                          d["max_output_channels"], int(d["default_samplerate"])))
    return out


def inputs() -> list[Device]:
    return [d for d in list_devices() if d.max_in > 0]


def outputs() -> list[Device]:
    return [d for d in list_devices() if d.max_out > 0]


def find(label: str, kind: str) -> Device | None:
    """Busca un dispositivo por su etiqueta guardada ('input' u 'output')."""
    pool = inputs() if kind == "input" else outputs()
    for d in pool:
        if d.label == label:
            return d
    for d in pool:  # el índice o la API pueden cambiar: buscar por nombre
        if label and d.name == label.split(" [")[0]:
            return d
    return None


def guess_virtual_output() -> Device | None:
    for d in outputs():
        if any(h in d.name.lower() for h in VIRTUAL_HINTS):
            return d
    return None


def default_label(kind: str) -> str:
    try:
        idx = sd.default.device[0 if kind == "input" else 1]
        if idx is None or idx < 0:
            return ""
        for d in list_devices():
            if d.index == idx:
                return d.label
    except Exception:  # noqa: BLE001 - PortAudio sin dispositivos por defecto
        pass
    return ""
