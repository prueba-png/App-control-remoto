"""Interfaz gráfica (CustomTkinter)."""

from __future__ import annotations

import logging
import os
import queue
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox

import customtkinter as ctk

from . import audio_devices as ad
from .config import Settings
from .converters import ENGINES, PitchFormantConverter, RVCOnnxConverter, build_converter

log = logging.getLogger(__name__)

MODE_LIVE = "Conversión en vivo (hablo yo)"
MODE_AGENT = "Agente autónomo (habla la IA)"
WHISPER_SIZES = ["tiny", "base", "small", "medium", "large-v3", "turbo"]

# Voces del motor de tono y timbre: tono objetivo (Hz) y timbre (formantes).
# Se aplican sobre tu tono (hombre ~115 Hz, mujer ~205 Hz) para salir a su altura real.
PERSONAS = {
    "mujerGrave": (175, 1.12), "mujer": (205, 1.17), "mujerAguda": (235, 1.20),
    "nina": (300, 1.38), "nino": (275, 1.32),
    "hombreGrave": (95, 0.90), "hombreJoven": (135, 1.03), "empresario": (98, 0.92),
}
PERSONAS_UI = [
    ("hombreGrave", "Hombre grave"), ("empresario", "Empresario"),
    ("hombreJoven", "Hombre joven"), ("mujerGrave", "Mujer grave"),
    ("mujer", "Mujer"), ("mujerAguda", "Mujer aguda"),
    ("nino", "Niño"), ("nina", "Niña"),
]


class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("system")
        ctk.set_default_color_theme("blue")
        self.title("VozDual")
        self.geometry("1100x720")
        self.minsize(900, 600)

        self.cfg = Settings.load()
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.running = None  # pipeline o agente activo
        self.api_key = os.environ.get("ANTHROPIC_API_KEY", "")

        self.grid_columnconfigure(0, weight=0)
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(1, weight=1)

        self._build_header()
        self._build_settings()
        self._build_log()
        self.refresh_devices()
        self._apply_mode()
        self.after(50, self._poll_events)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------------ UI
    def _build_header(self):
        top = ctk.CTkFrame(self, corner_radius=0)
        top.grid(row=0, column=0, columnspan=2, sticky="ew")
        top.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(top, text="VozDual", font=ctk.CTkFont(size=22, weight="bold")).grid(
            row=0, column=0, padx=16, pady=12)
        self.mode = ctk.CTkSegmentedButton(top, values=[MODE_LIVE, MODE_AGENT], command=lambda _: self._apply_mode())
        self.mode.set(MODE_LIVE)
        self.mode.grid(row=0, column=1, padx=8, pady=12, sticky="w")
        self.start_btn = ctk.CTkButton(top, text="▶  Iniciar", width=140, height=36, command=self.toggle)
        self.start_btn.grid(row=0, column=2, padx=16, pady=12)

    def _build_settings(self):
        side = ctk.CTkScrollableFrame(self, width=400)
        side.grid(row=1, column=0, sticky="nsew", padx=(12, 6), pady=12)
        side.grid_columnconfigure(0, weight=1)
        r = 0

        def section(title):
            nonlocal r
            ctk.CTkLabel(side, text=title, font=ctk.CTkFont(size=15, weight="bold"), anchor="w").grid(
                row=r, column=0, sticky="ew", pady=(14, 4))
            r += 1

        def label(text):
            nonlocal r
            ctk.CTkLabel(side, text=text, anchor="w").grid(row=r, column=0, sticky="ew")
            r += 1

        def place(widget, pady=(0, 6)):
            nonlocal r
            widget.grid(row=r, column=0, sticky="ew", pady=pady)
            r += 1
            return widget

        # Dispositivos
        section("Dispositivos de audio")
        self.lbl_mic = ctk.CTkLabel(side, text="Tu micrófono físico", anchor="w")
        self.lbl_mic.grid(row=r, column=0, sticky="ew"); r += 1
        self.mic_menu = place(ctk.CTkOptionMenu(side, values=["—"], dynamic_resizing=False))
        self.lbl_call = ctk.CTkLabel(side, text="Audio de la llamada (lo que dice la otra persona)", anchor="w")
        self.lbl_call.grid(row=r, column=0, sticky="ew"); r += 1
        self.call_menu = place(ctk.CTkOptionMenu(side, values=["—"], dynamic_resizing=False))
        label("Salida → micrófono virtual (p. ej. CABLE Input)")
        self.out_menu = place(ctk.CTkOptionMenu(side, values=["—"], dynamic_resizing=False))
        place(ctk.CTkButton(side, text="Actualizar lista", fg_color="transparent", border_width=1,
                            text_color=("gray10", "gray90"), command=self.refresh_devices))

        # Voz
        section("Voz")
        label("Motor de voz")
        self.engine_menu = place(ctk.CTkOptionMenu(side, values=ENGINES, command=lambda _: self._apply_engine()))
        self.engine_menu.set(self.cfg.engine if self.cfg.engine in ENGINES else ENGINES[1])

        # Voces rápidas (motor de tono y timbre): ajustan tono y timbre en directo.
        self.measured_hz = float(self.cfg.measured_hz or 0)
        self.measure_btn = place(ctk.CTkButton(
            side, text="🎤 Medir mi voz", fg_color="transparent", border_width=1,
            text_color=("gray10", "gray90"), command=self._measure_voice))
        self.measure_lbl = ctk.CTkLabel(side, anchor="w", wraplength=360, justify="left")
        self.measure_lbl.grid(row=r, column=0, sticky="ew"); r += 1
        self.base_voice_lbl = ctk.CTkLabel(side, text="Si no la mides, ¿tu voz es…?", anchor="w")
        self.base_voice_lbl.grid(row=r, column=0, sticky="ew"); r += 1
        self.base_voice = place(ctk.CTkOptionMenu(side, values=["De hombre (grave)", "De mujer (aguda)"],
                                                  command=lambda _: self._apply_persona(self._persona)))
        self.base_voice.set("De mujer (aguda)" if self.cfg.base_voice == "f" else "De hombre (grave)")
        self.persona_frame = ctk.CTkFrame(side, fg_color="transparent")
        self.persona_frame.grid_columnconfigure((0, 1), weight=1)
        place(self.persona_frame)
        self._persona = None
        for i, (key, text) in enumerate(PERSONAS_UI):
            ctk.CTkButton(self.persona_frame, text=text, height=28, fg_color="transparent", border_width=1,
                          text_color=("gray10", "gray90"),
                          command=lambda k=key: self._apply_persona(k)).grid(
                row=i // 2, column=i % 2, sticky="ew", padx=2, pady=2)

        self.semi_label = ctk.CTkLabel(side, anchor="w")
        self.semi_label.grid(row=r, column=0, sticky="ew"); r += 1
        self.semi = place(ctk.CTkSlider(side, from_=-18, to=18, number_of_steps=72,
                                        command=lambda v: self._update_sliders()))
        self.semi.set(self.cfg.semitones)
        self.formant_label = ctk.CTkLabel(side, anchor="w")
        self.formant_label.grid(row=r, column=0, sticky="ew"); r += 1
        self.formant = place(ctk.CTkSlider(side, from_=0.75, to=1.5, number_of_steps=75,
                                           command=lambda v: self._update_sliders()))
        self.formant.set(self.cfg.formant)

        self.rvc_frame = ctk.CTkFrame(side, fg_color="transparent")
        self.rvc_frame.grid_columnconfigure(0, weight=1)
        place(self.rvc_frame)
        self.rvc_model = self._file_row(self.rvc_frame, 0, "Modelo de voz RVC (.onnx)", self.cfg.rvc_model,
                                        [("Modelo ONNX", "*.onnx")])
        self.vec_model = self._file_row(self.rvc_frame, 2, "ContentVec (.onnx)", self.cfg.contentvec_model,
                                        [("Modelo ONNX", "*.onnx")])
        ctk.CTkLabel(self.rvc_frame, text="Frecuencia del modelo", anchor="w").grid(row=4, column=0, sticky="ew")
        self.rvc_sr = ctk.CTkOptionMenu(self.rvc_frame, values=["32000", "40000", "48000"])
        self.rvc_sr.set(str(self.cfg.rvc_sample_rate))
        self.rvc_sr.grid(row=5, column=0, sticky="ew", pady=(0, 6))
        self.gpu = ctk.CTkSwitch(self.rvc_frame, text="Usar GPU si está disponible")
        if self.cfg.use_gpu:
            self.gpu.select()
        self.gpu.grid(row=6, column=0, sticky="w", pady=(0, 6))

        self.block_label = ctk.CTkLabel(side, anchor="w")
        self.block_label.grid(row=r, column=0, sticky="ew"); r += 1
        self.block = place(ctk.CTkSlider(side, from_=80, to=500, number_of_steps=42,
                                         command=lambda v: self._update_sliders()))
        self.block.set(self.cfg.block_ms)
        self.consent = place(ctk.CTkCheckBox(
            side, text="La voz del modelo es la mía o tengo permiso de su dueño"))
        if self.cfg.voice_consent:
            self.consent.select()

        # Agente
        self.agent_frame = ctk.CTkFrame(side, fg_color="transparent")
        self.agent_frame.grid_columnconfigure(0, weight=1)
        place(self.agent_frame)
        af = self.agent_frame
        ctk.CTkLabel(af, text="Agente autónomo", font=ctk.CTkFont(size=15, weight="bold"), anchor="w").grid(
            row=0, column=0, sticky="ew", pady=(14, 4))
        self.script = self._file_row(af, 1, "Guion de ventas (.txt / .json)", self.cfg.script_path,
                                     [("Guion", "*.txt *.json")])
        self.piper = self._file_row(af, 3, "Voz Piper (.onnx)", self.cfg.piper_voice, [("Voz Piper", "*.onnx")])
        self.through_conv = ctk.CTkSwitch(af, text="Pasar la voz del agente por el motor de voz")
        if self.cfg.agent_voice_through_converter:
            self.through_conv.select()
        self.through_conv.grid(row=5, column=0, sticky="w", pady=(0, 6))
        ctk.CTkLabel(af, text="Transcripción (Whisper local)", anchor="w").grid(row=6, column=0, sticky="ew")
        self.whisper = ctk.CTkOptionMenu(af, values=WHISPER_SIZES)
        self.whisper.set(self.cfg.whisper_model)
        self.whisper.grid(row=7, column=0, sticky="ew", pady=(0, 6))
        ctk.CTkLabel(af, text="Idioma (es, en, fr…)", anchor="w").grid(row=8, column=0, sticky="ew")
        self.lang = ctk.CTkEntry(af)
        self.lang.insert(0, self.cfg.language)
        self.lang.grid(row=9, column=0, sticky="ew", pady=(0, 6))
        ctk.CTkLabel(af, text="Empresa (si el guion no la indica)", anchor="w").grid(row=10, column=0, sticky="ew")
        self.company = ctk.CTkEntry(af)
        self.company.insert(0, self.cfg.company_name)
        self.company.grid(row=11, column=0, sticky="ew", pady=(0, 6))
        ctk.CTkLabel(af, text="Modelo de Claude", anchor="w").grid(row=12, column=0, sticky="ew")
        self.claude_model = ctk.CTkEntry(af)
        self.claude_model.insert(0, self.cfg.claude_model)
        self.claude_model.grid(row=13, column=0, sticky="ew", pady=(0, 6))
        ctk.CTkLabel(af, text="Clave API de Claude (no se guarda en disco)", anchor="w").grid(
            row=14, column=0, sticky="ew")
        self.key_entry = ctk.CTkEntry(af, show="•", placeholder_text="sk-ant-… o variable ANTHROPIC_API_KEY")
        if self.api_key:
            self.key_entry.insert(0, self.api_key)
        self.key_entry.grid(row=15, column=0, sticky="ew", pady=(0, 6))

        self._apply_engine()
        self._update_sliders()
        self._show_measure()

    def _file_row(self, parent, row, title, value, types):
        ctk.CTkLabel(parent, text=title, anchor="w").grid(row=row, column=0, sticky="ew")
        fr = ctk.CTkFrame(parent, fg_color="transparent")
        fr.grid(row=row + 1, column=0, sticky="ew", pady=(0, 6))
        fr.grid_columnconfigure(0, weight=1)
        entry = ctk.CTkEntry(fr)
        entry.insert(0, value)
        entry.grid(row=0, column=0, sticky="ew")

        def pick():
            path = filedialog.askopenfilename(filetypes=types + [("Todos", "*.*")])
            if path:
                entry.delete(0, tk.END)
                entry.insert(0, path)

        ctk.CTkButton(fr, text="…", width=36, command=pick).grid(row=0, column=1, padx=(6, 0))
        return entry

    def _build_log(self):
        right = ctk.CTkFrame(self)
        right.grid(row=1, column=1, sticky="nsew", padx=(6, 12), pady=12)
        right.grid_columnconfigure(0, weight=1)
        right.grid_rowconfigure(2, weight=1)
        meters = ctk.CTkFrame(right, fg_color="transparent")
        meters.grid(row=0, column=0, sticky="ew", padx=12, pady=(12, 4))
        meters.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(meters, text="Nivel").grid(row=0, column=0, padx=(0, 8))
        self.level = ctk.CTkProgressBar(meters)
        self.level.set(0)
        self.level.grid(row=0, column=1, sticky="ew")
        self.status = ctk.CTkLabel(right, text="Detenido", anchor="w")
        self.status.grid(row=1, column=0, sticky="ew", padx=12)
        self.log = ctk.CTkTextbox(right, wrap="word", font=ctk.CTkFont(size=14))
        self.log.grid(row=2, column=0, sticky="nsew", padx=12, pady=12)
        self.log.tag_config("cliente", foreground="#2f7de1")
        self.log.tag_config("agente", foreground="#1f9d55")
        self.log.tag_config("error", foreground="#d64545")
        self.log.tag_config("info", foreground="#888888")
        self.log.configure(state="disabled")
        self._log("info", "Elige el modo, los dispositivos y pulsa Iniciar.")

    # ------------------------------------------------------------ helpers
    def _log(self, kind: str, text: str):
        prefix = {"cliente": "Cliente: ", "agente": "Agente: ", "error": "⚠ ", "info": "· "}.get(kind, "")
        self.log.configure(state="normal")
        self.log.insert("end", f"[{time.strftime('%H:%M:%S')}] {prefix}{text}\n", kind)
        self.log.see("end")
        self.log.configure(state="disabled")

    def refresh_devices(self):
        try:
            ins = [d.label for d in ad.inputs()] or ["(sin dispositivos)"]
            outs = [d.label for d in ad.outputs()] or ["(sin dispositivos)"]
        except Exception as e:  # noqa: BLE001
            self._log("error", f"No se pudieron leer los dispositivos de audio: {e}")
            return
        self.mic_menu.configure(values=ins)
        self.call_menu.configure(values=ins)
        self.out_menu.configure(values=outs)
        self.mic_menu.set(self.cfg.mic_device if self.cfg.mic_device in ins else (ad.default_label("input") or ins[0]))
        self.call_menu.set(self.cfg.call_audio_device if self.cfg.call_audio_device in ins else ins[0])
        virt = ad.guess_virtual_output()
        if self.cfg.virtual_mic_device in outs:
            self.out_menu.set(self.cfg.virtual_mic_device)
        elif virt:
            self.out_menu.set(virt.label)
        else:
            self.out_menu.set(outs[0])
            self._log("info", "No encuentro un micrófono virtual. Instala VB-CABLE (Windows), "
                              "BlackHole (macOS) o un sink nulo de PipeWire (Linux). Ver README.")

    def _apply_mode(self):
        agent = self.mode.get() == MODE_AGENT
        for w in (self.lbl_mic, self.mic_menu):
            w.grid() if not agent else w.grid_remove()
        for w in (self.lbl_call, self.call_menu):
            w.grid() if agent else w.grid_remove()
        self.agent_frame.grid() if agent else self.agent_frame.grid_remove()

    def _apply_engine(self):
        eng = self.engine_menu.get()
        self.rvc_frame.grid() if eng == RVCOnnxConverter.name else self.rvc_frame.grid_remove()
        pitch = eng == PitchFormantConverter.name
        self.formant.configure(state="normal" if pitch else "disabled")
        self.persona_frame.grid() if pitch else self.persona_frame.grid_remove()

    def _base_hz(self):
        if self.measured_hz:
            return self.measured_hz
        return 205.0 if self.base_voice.get().startswith("De mujer") else 115.0

    def _show_measure(self):
        if self.measured_hz:
            kind = "voz grave, de hombre" if self.measured_hz < 165 else "voz aguda, de mujer"
            self.measure_lbl.configure(text=f"Tu tono medido: {self.measured_hz:.0f} Hz ({kind}).")
            self.base_voice_lbl.grid_remove()
            self.base_voice.grid_remove()
        else:
            self.measure_lbl.configure(text="Sin medir: se usa un tono típico. Mídela para afinar las voces.")
            self.base_voice_lbl.grid()
            self.base_voice.grid()

    def _measure_voice(self):
        mic = ad.find(self.mic_menu.get(), "input")
        if mic is None:
            self._log("error", "Elige tu micrófono físico antes de medir.")
            return
        if self.running:
            self._log("error", "Detén la conversión antes de medir tu voz.")
            return
        self.measure_btn.configure(state="disabled", text="Habla normal 4 s…")
        threading.Thread(target=self._measure_worker, args=(mic.index,), daemon=True).start()

    def _measure_worker(self, device):
        import sounddevice as sd

        from .dsp import resample, yin_f0

        try:
            sr = int(sd.query_devices(device)["default_samplerate"])
            audio = sd.rec(int(4 * sr), samplerate=sr, channels=1, dtype="float32", device=device)
            sd.wait()
            x = resample(audio[:, 0], sr, 16000)
            f0 = yin_f0(x, 16000, 160, 60.0, 400.0)
            voiced = sorted(float(v) for v in f0 if v > 0)
            hz = voiced[len(voiced) // 2] if len(voiced) >= 10 else 0.0
            self.events.put(("measured", hz))
        except Exception as e:  # noqa: BLE001
            self.events.put(("measure_error", str(e)))

    def _apply_persona(self, key):
        self._persona = key
        if key is None or key not in PERSONAS:
            return
        import math
        hz, formant = PERSONAS[key]
        semis = max(-18, min(18, round(12 * math.log2(hz / self._base_hz()) * 2) / 2))
        self.semi.set(semis)
        self.formant.set(formant)
        self._update_sliders()

    def _update_sliders(self):
        self.semi_label.configure(text=f"Tono: {self.semi.get():+.1f} semitonos")
        self.formant_label.configure(text=f"Timbre (formantes): ×{self.formant.get():.2f}")
        self.block_label.configure(text=f"Tamaño de bloque: {int(self.block.get())} ms "
                                        "(menos = menos retraso, más CPU)")
        # Cambios en caliente mientras se habla.
        conv = getattr(self.running, "converter", None)
        if isinstance(conv, PitchFormantConverter):
            conv.set_params(self.semi.get(), self.formant.get())
        elif isinstance(conv, RVCOnnxConverter):
            conv.set_params(self.semi.get())

    def _collect(self) -> Settings:
        c = self.cfg
        real = lambda v: "" if v.startswith("(") or v == "—" else v  # noqa: E731 - sin marcadores
        c.mic_device = real(self.mic_menu.get())
        c.call_audio_device = real(self.call_menu.get())
        c.virtual_mic_device = real(self.out_menu.get())
        c.engine = self.engine_menu.get()
        c.base_voice = "f" if self.base_voice.get().startswith("De mujer") else "m"
        c.measured_hz = round(self.measured_hz, 1)
        c.semitones = round(float(self.semi.get()), 2)
        c.formant = round(float(self.formant.get()), 3)
        c.rvc_model = self.rvc_model.get().strip()
        c.contentvec_model = self.vec_model.get().strip()
        c.rvc_sample_rate = int(self.rvc_sr.get())
        c.use_gpu = bool(self.gpu.get())
        c.block_ms = int(self.block.get())
        c.voice_consent = bool(self.consent.get())
        c.script_path = self.script.get().strip()
        c.piper_voice = self.piper.get().strip()
        c.agent_voice_through_converter = bool(self.through_conv.get())
        c.whisper_model = self.whisper.get()
        c.language = self.lang.get().strip() or "es"
        c.company_name = self.company.get().strip()
        c.claude_model = self.claude_model.get().strip() or "claude-opus-5-5"
        self.api_key = self.key_entry.get().strip()
        c.save()
        return c

    # ------------------------------------------------------------ start/stop
    def toggle(self):
        if self.running:
            self._stop()
        else:
            self._start()

    def _start(self):
        cfg = self._collect()
        if cfg.engine == RVCOnnxConverter.name and not cfg.voice_consent:
            messagebox.showwarning("VozDual", "Confirma que la voz del modelo es la tuya o que tienes permiso de su dueño.")
            return
        out = ad.find(cfg.virtual_mic_device, "output")
        if out is None:
            messagebox.showerror("VozDual", "Elige el dispositivo de salida (micrófono virtual).")
            return
        self.start_btn.configure(state="disabled", text="Cargando…")
        self._log("info", "Cargando modelos…")
        agent = self.mode.get() == MODE_AGENT
        threading.Thread(target=self._start_agent if agent else self._start_live, args=(cfg, out),
                         daemon=True).start()

    def _start_live(self, cfg: Settings, out):
        from .realtime import RealtimeVoicePipeline

        try:
            mic = ad.find(cfg.mic_device, "input")
            if mic is None:
                raise RuntimeError("Elige tu micrófono físico.")
            if mic.name == out.name:
                raise RuntimeError("La entrada y la salida no pueden ser el mismo dispositivo.")
            conv = build_converter(cfg)
            pipe = RealtimeVoicePipeline(conv, mic.index, out.index, cfg.block_ms, cfg.noise_gate_db,
                                         on_status=lambda s: self.events.put(("status", s)),
                                         on_error=lambda m: self.events.put(("error", m)))
            pipe.start()
            self.events.put(("started", pipe))
            self.events.put(("info", f"Conversión en vivo activa: {mic.name} → {conv.name} → {out.name}"))
            if isinstance(conv, RVCOnnxConverter):
                self.events.put(("info", f"RVC usando: {', '.join(conv.providers)}"))
        except Exception as e:  # noqa: BLE001
            log.exception("No se pudo iniciar")
            self.events.put(("failed", str(e)))

    def _start_agent(self, cfg: Settings, out):
        from .agent import AutonomousAgent
        from .llm import SalesBrain, load_script
        from .stt import Transcriber, UtteranceListener
        from .tts import Speaker

        try:
            call = ad.find(cfg.call_audio_device, "input")
            if call is None:
                raise RuntimeError("Elige el dispositivo con el audio de la llamada.")
            if not cfg.script_path or not Path(cfg.script_path).is_file():
                raise RuntimeError("Elige el guion de ventas (.txt o .json).")
            if not cfg.piper_voice or not Path(cfg.piper_voice).is_file():
                raise RuntimeError("Elige una voz de Piper (.onnx con su .onnx.json al lado).")
            if not self.api_key:
                raise RuntimeError("Falta la clave de la API de Claude.")
            converter = None
            if cfg.agent_voice_through_converter and cfg.engine != ENGINES[0]:
                converter = build_converter(cfg)
            brain = SalesBrain(load_script(cfg.script_path), model=cfg.claude_model, effort=cfg.claude_effort,
                               api_key=self.api_key, company=cfg.company_name, language=cfg.language)
            self.events.put(("info", f"Cargando Whisper «{cfg.whisper_model}» (la primera vez se descarga)…"))
            stt = Transcriber(cfg.whisper_model, cfg.whisper_device, cfg.language)
            speaker = Speaker(cfg.piper_voice, out.index, converter)
            listener = UtteranceListener(call.index)
            agent = AutonomousAgent(brain, stt, listener, speaker,
                                    on_event=lambda k, t: self.events.put(("agent", (k, t))))
            agent.converter = converter
            agent.start()
            self.events.put(("started", agent))
        except Exception as e:  # noqa: BLE001
            log.exception("No se pudo iniciar el agente")
            self.events.put(("failed", str(e)))

    def _stop(self):
        running, self.running = self.running, None
        if running:
            threading.Thread(target=running.stop, daemon=True).start()
        self.start_btn.configure(text="▶  Iniciar", state="normal")
        self.mode.configure(state="normal")
        self.status.configure(text="Detenido")
        self.level.set(0)
        self._log("info", "Detenido.")

    # ------------------------------------------------------------ eventos
    def _poll_events(self):
        try:
            while True:
                kind, data = self.events.get_nowait()
                if kind == "started":
                    self.running = data
                    self.start_btn.configure(text="■  Detener", state="normal")
                    self.mode.configure(state="disabled")
                elif kind == "failed":
                    self._log("error", str(data))
                    self.start_btn.configure(text="▶  Iniciar", state="normal")
                elif kind == "status":
                    s = data
                    self.level.set(min(1.0, max(0.0, (s["level_db"] + 60) / 60)))
                    warn = "" if s["realtime_ok"] else "  ⚠ el equipo no llega a tiempo: sube el bloque o usa GPU"
                    self.status.configure(text=f"Latencia ≈ {s['latency_ms']:.0f} ms · cálculo {s['infer_ms']:.0f} ms"
                                               f" · cortes {s['underruns']}{warn}")
                elif kind == "agent":
                    k, t = data
                    if k == "fin":
                        if self.running is not None:
                            self._stop()
                    else:
                        self._log(k, t)
                elif kind == "measured":
                    self.measure_btn.configure(state="normal", text="🎤 Medir mi voz")
                    if 60 <= float(data) <= 350:
                        self.measured_hz = float(data)
                        self._show_measure()
                        self._apply_persona(self._persona)
                        self._log("info", f"Voz medida: {self.measured_hz:.0f} Hz.")
                    else:
                        self._log("error", "No he podido medir bien tu voz. Inténtalo otra vez, "
                                           "hablando seguido 4 segundos y sin ruido de fondo.")
                elif kind == "measure_error":
                    self.measure_btn.configure(state="normal", text="🎤 Medir mi voz")
                    self._log("error", f"No se pudo medir: {data}")
                elif kind in ("info", "error"):
                    self._log(kind, str(data))
                    if kind == "error" and self.running is not None:
                        self._stop()
        except queue.Empty:
            pass
        self.after(50, self._poll_events)

    def _on_close(self):
        try:
            self._collect()
        except Exception:  # noqa: BLE001
            pass
        if self.running:
            self.running.stop()
        self.destroy()


def run():
    App().mainloop()
