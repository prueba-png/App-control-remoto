# VozDual

Aplicación de escritorio en Python con dos modos:

1. **Conversión en vivo (hablo yo):** captura tu micrófono, transforma tu voz en tiempo real
   (cambio de tono y timbre, o tu voz clonada con un modelo RVC) y la envía a un **micrófono
   virtual** que eliges en Zoom, Meet, Teams, Discord, WhatsApp de escritorio, etc.
2. **Agente autónomo (habla la IA):** escucha a la otra persona, la transcribe en local con
   Whisper, responde con Claude siguiendo tu guion de ventas y habla con voz sintética (Piper,
   opcionalmente pasada por tu modelo RVC) a través del micrófono virtual.

Todo funciona en tu ordenador y es gratuito **excepto la API de Claude**, que se paga por uso
(una llamada típica cuesta céntimos). El resto (Whisper, Piper, RVC, la app) es de código
abierto y no tiene coste.

## Demo en el navegador (también en iPhone)

https://prueba-png.github.io/AuraFace/ — prueba el cambio de voz en tiempo real y el agente
(con tu clave de Claude) desde el navegador. Es una demo: el resultado se oye en el propio
dispositivo, porque un navegador no puede crear un micrófono virtual para otras apps. Su
código está en `web/`.

## Estructura

```
main.py                  arranque (python main.py)
requirements.txt         dependencias
guiones/ejemplo.json     guion de ventas de ejemplo (estructurado)
guiones/ejemplo.txt      el mismo guion en texto libre
modelos/                 aquí guardas tus modelos (no se suben a git)
vozdual/
  gui.py                 interfaz (CustomTkinter)
  realtime.py            modo 1: micro -> conversión -> micro virtual
  converters.py          motores de voz: sin cambios, tono/timbre (DSP), RVC ONNX
  dsp.py                 resampleo, detección de tono (YIN), empalme SOLA, detector de voz
  agent.py               modo 2: escuchar -> transcribir -> Claude -> hablar
  stt.py                 transcripción local con faster-whisper
  tts.py                 síntesis local con Piper
  llm.py                 guion + Claude (respuesta en streaming, frase a frase)
  audio_devices.py       dispositivos y detección del micrófono virtual
  config.py              ajustes en ~/.vozdual/settings.json
tests/                   pruebas automáticas
```

## Instalación

Necesitas **Python 3.10, 3.11 o 3.12**.

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

- **Linux:** instala antes `sudo apt install libportaudio2 python3-tk`.
- **GPU (recomendado para RVC):** sustituye `onnxruntime` por `onnxruntime-gpu` (NVIDIA con CUDA)
  o por `onnxruntime-directml` (Windows, cualquier GPU). La app la usa sola si está disponible.

## Micrófono virtual (gratis)

La app escribe tu voz transformada en un **cable de audio virtual**. En la aplicación de la
llamada eliges el otro extremo de ese cable como micrófono.

| Sistema | Instala | En VozDual, salida | En la app de llamadas, micrófono |
|---|---|---|---|
| Windows | [VB-CABLE](https://vb-audio.com/Cable/) | `CABLE Input` | `CABLE Output` |
| macOS | [BlackHole 2ch](https://existential.audio/blackhole/) | `BlackHole 2ch` | `BlackHole 2ch` |
| Linux | PipeWire/PulseAudio (ver abajo) | `vozdual` | `vozdual_mic` |

Linux:

```bash
pactl load-module module-null-sink sink_name=vozdual sink_properties=device.description=vozdual
pactl load-module module-remap-source master=vozdual.monitor source_name=vozdual_mic
```

Para comprobar qué ve la app: `python main.py --dispositivos`.

### Audio de la llamada (solo modo agente)

El agente necesita **oír a la otra persona**. Para eso, la app de llamadas debe sacar su sonido
por un **segundo** cable virtual, que en VozDual eliges como «Audio de la llamada»:

- **Windows:** instala un segundo cable (por ejemplo *Hi-Fi Cable* de VB-Audio o VoiceMeeter) y ponlo
  como altavoz en la app de llamadas. Para oírlo tú también: Configuración de sonido → ese
  dispositivo → *Escuchar este dispositivo*.
- **macOS:** instala también *BlackHole 16ch*, ponlo como altavoz de la llamada y crea un
  *Dispositivo de salida múltiple* en «Configuración de Audio MIDI» si quieres oírlo.
- **Linux:** crea otro `null-sink` (p. ej. `llamada`) y elige su `.monitor` en VozDual.

No uses el mismo cable para las dos cosas: el agente se escucharía a sí mismo.

## Motores de voz

| Motor | Qué hace | Necesita |
|---|---|---|
| Sin cambios (prueba) | Pasa tu voz tal cual | Nada. Útil para probar dispositivos y latencia |
| Tono y timbre (DSP) | Sube o baja el tono y cambia el timbre por separado | Nada. ~2 % de CPU |
| Voz clonada (RVC ONNX) | Convierte tu voz en la de un modelo RVC | Un modelo RVC exportado a ONNX + ContentVec ONNX; GPU recomendada |

### Preparar una voz RVC

1. Entrena el modelo de **tu propia voz** (o de alguien que te haya dado permiso) con
   [RVC WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) o
   [Applio](https://github.com/IAHispano/Applio). Ambos son gratuitos y funcionan en local o en
   Google Colab. Con 10–20 minutos de audio limpio basta.
2. Exporta el modelo a ONNX (en RVC WebUI: pestaña de exportación ONNX) y guárdalo en `modelos/`.
3. Descarga el extractor **ContentVec en ONNX** (`vec-768-layer-12.onnx` para modelos v2,
   `vec-256-layer-9.onnx` para v1). Se distribuye en Hugging Face junto a los paquetes de
   modelos de w-okada voice-changer y MoeVoiceStudio; búscalo por su nombre.
4. En la pestaña Voz elige los dos ficheros y la frecuencia del modelo (32, 40 o 48 kHz,
   según con cuál lo entrenaste).

El fichero `.index` de RVC no se usa: la voz sale algo menos fiel en el acento, a cambio de no
necesitar PyTorch ni faiss.

## Modo agente: qué necesitas

- **Guion:** un `.txt` libre o un `.json` como `guiones/ejemplo.json` (campos `empresa`,
  `apertura`, `objetivo`, `pasos`, `objeciones`, `no_hacer`… todos opcionales).
- **Voz Piper:** descarga una voz (fichero `.onnx` y su `.onnx.json`), por ejemplo:
  `python -m piper.download_voices es_ES-davefx-medium` (lista completa en
  [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)).
  Si activas «Pasar la voz del agente por el motor de voz», la voz de Piper se convierte con tu
  modelo RVC antes de enviarse.
- **Whisper:** se descarga solo la primera vez. `small` va bien en CPU; con GPU, `large-v3` o `turbo`.
- **Clave de Claude:** crea una en [platform.claude.com](https://platform.claude.com) y
  ponla en la variable de entorno `ANTHROPIC_API_KEY` (o pégala en la app; no se guarda en disco).
  El modelo por defecto es `claude-opus-5-5` con esfuerzo bajo para responder rápido; puedes
  cambiarlo en la pestaña del agente.

Cómo funciona una llamada: el agente dice la apertura → espera a que la otra persona termine de
hablar (detector de silencios) → transcribe → pide la respuesta a Claude en streaming → empieza a
hablar en cuanto tiene la primera frase. Mientras habla deja de escuchar para no oírse a sí mismo.

## Latencia esperable

«Al milisegundo» no es posible con ningún sistema de conversión neuronal: la voz necesita algo
de contexto para convertirse. Valores reales:

- Tono y timbre (DSP): ~100–250 ms en total.
- RVC con GPU: ~200–400 ms. Con CPU solo funciona en equipos potentes y con bloques grandes.
- Agente: 1–3 s desde que la otra persona deja de hablar hasta que el agente empieza a responder.

La barra de estado muestra la latencia y avisa si el equipo no llega a tiempo. Ajusta el
«Tamaño de bloque»: menos = menos retraso pero más CPU.

## Uso responsable

- Usa voces propias o con permiso expreso de su dueño. La app lo pide antes de usar un modelo RVC.
- El agente **siempre se presenta como asistente con inteligencia artificial** en su primera
  frase y lo confirma si se lo preguntan; esto viene fijado en el código. Respeta a quien
  pida no ser llamado de nuevo.
- Las llamadas comerciales tienen reglas propias. En España, desde 2023 hace falta el
  consentimiento previo de la persona para llamarla con fines comerciales. Llama solo a
  contactos que lo hayan dado.

## Pruebas

```bash
pip install -r requirements-dev.txt
pytest
```

Las pruebas comprueban la detección de tono, el cambio de tono, el empalme SOLA, el detector de
voz, la tubería en tiempo real y la integración RVC ONNX con modelos de prueba, además del
guion y la conversación con Claude (con un cliente simulado, sin gastar API).
