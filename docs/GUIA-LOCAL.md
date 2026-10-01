# AuraFace en tu propio PC (calidad máxima, gratis)

La web usa la capa gratuita de Hugging Face, que limita la duración y la cuota.
Si tienes una GPU NVIDIA, puedes ejecutar los mismos modelos en local sin límites.

## Requisitos

| GPU (memoria de vídeo) | Qué puedes hacer |
|---|---|
| 6–8 GB | Wan 2.2 5B o FramePack a 480p, clips de 5 s (lento) |
| 12–16 GB | Wan 2.2 14B cuantizado (GGUF) a 480p–720p |
| 24 GB o más | Wan 2.2 14B a 720p con margen |

## Instalación sin código

1. Descarga e instala **Pinokio**: https://pinokio.co
2. En el buscador de Pinokio instala **Wan2GP** (interfaz web sencilla para vídeo)
   y **ComfyUI** (para la imagen con tu cara).
3. Pinokio descarga los modelos la primera vez que los usas.

## Flujo

1. **Imagen con tu cara (ComfyUI):** instala desde el *Manager* el nodo
   `ComfyUI-PuLID-Flux` (o `ComfyUI_InstantID` si usas SDXL), abre su flujo de
   ejemplo, arrastra tu foto y usa el prompt que genera AuraFace (paso 2, «Ver o
   editar el prompt completo»).
2. **Vídeo (Wan2GP):** elige *Wan 2.2 Image to Video 14B*, arrastra la imagen y
   pega el prompt de vídeo de AuraFace (paso 3).
3. **Gestos (opcional):** instala **LivePortrait** desde Pinokio.

## Ajustes recomendados

**PuLID-FLUX:** peso de identidad 0.9–1.0 · 25–30 pasos · guidance 3.5 ·
832×1216 (vertical) o 1216×832 (horizontal).

**InstantID (SDXL):** IP-Adapter 0.8 · ControlNet 0.6–0.7 · CFG 4–5.

**Wan 2.2 I2V:** 1280×720 (o 832×480) · 81 fotogramas (~5 s) · 20–30 pasos ·
CFG 5 · shift 5–8 · con el LoRA de aceleración *lightx2v*: 4–8 pasos y CFG 1.
Semilla fija mientras ajustas el prompt.

**Acabado:** interpolación RIFE ×2 y escalado con Real-ESRGAN a 1080p.
Evita los restauradores de cara agresivos (CodeFormer con fidelidad ≥ 0.7).

## Licencias

FLUX.1-dev (base de PuLID-FLUX) solo permite uso no comercial. Wan 2.2 (Apache 2.0)
y SDXL permiten uso comercial. Revisa la licencia de cada modelo antes de publicar.
