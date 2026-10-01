"""Ajustes de la aplicación, guardados en ~/.vozdual/settings.json.

La clave de la API de Claude NO se guarda en disco: se lee de la variable de
entorno ANTHROPIC_API_KEY o se escribe en la app para la sesión actual.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, fields
from pathlib import Path

log = logging.getLogger(__name__)

CONFIG_DIR = Path.home() / ".vozdual"
CONFIG_FILE = CONFIG_DIR / "settings.json"


@dataclass
class Settings:
    # Dispositivos (se guardan por nombre, que es estable entre reinicios).
    mic_device: str = ""
    virtual_mic_device: str = ""
    call_audio_device: str = ""

    # Voz
    engine: str = "Tono y timbre (DSP)"
    semitones: float = 0.0
    formant: float = 1.0
    rvc_model: str = ""
    contentvec_model: str = ""
    rvc_sample_rate: int = 40000
    rvc_speaker_id: int = 0
    use_gpu: bool = True
    block_ms: int = 200
    noise_gate_db: float = -50.0
    voice_consent: bool = False

    # Agente
    script_path: str = ""
    piper_voice: str = ""
    agent_voice_through_converter: bool = True
    whisper_model: str = "small"
    whisper_device: str = "auto"
    language: str = "es"
    claude_model: str = "claude-opus-5-5"
    claude_effort: str = "low"
    company_name: str = ""

    @classmethod
    def load(cls) -> "Settings":
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return cls()
        except (OSError, ValueError) as e:
            log.warning("No se pudieron leer los ajustes (%s); uso los de por defecto.", e)
            return cls()
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})

    def save(self) -> None:
        try:
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            CONFIG_FILE.write_text(json.dumps(asdict(self), indent=2, ensure_ascii=False), encoding="utf-8")
        except OSError as e:
            log.warning("No se pudieron guardar los ajustes: %s", e)
