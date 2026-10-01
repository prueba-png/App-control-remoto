# AuraFace

Crea vídeos hiperrealistas **con tu propio rostro** a partir de una foto y un texto.
Gratis, sin instalar nada y pensado para principiantes.

**Abrir la app:** https://prueba-png.github.io/AuraFace/

## Cómo se usa

1. **Rostro:** arrastra una foto tuya (o un vídeo y elige un fotograma) y confirma
   que es tu cara o que tienes el permiso de la persona.
2. **Escena y ropa:** describe la ropa y el lugar, elige luz y encuadre. AuraFace
   genera una imagen fija tuya con PuLID-FLUX. Genera varias y elige la mejor.
3. **Vídeo:** describe la acción y el movimiento de cámara. Wan 2.2 anima la
   imagen elegida conservando la cara.
4. **Gestos (opcional):** sube un vídeo tuyo hablando y LivePortrait traslada tus
   expresiones reales.

Todo lo que se descarga lleva la marca visible «Generado con IA · AuraFace».

## Cuota gratuita

Los modelos se ejecutan en la capa gratuita de Hugging Face (ZeroGPU). Sin cuenta
hay pocos minutos de GPU al día; con un **token gratuito** (Ajustes → token, tipo
*Read*, creado en https://huggingface.co/settings/tokens) tienes bastante más.
El token solo se guarda en tu navegador.

Si un motor deja de funcionar, en **Ajustes → Motores** puedes cambiarlo por otro
Space compatible. AuraFace detecta automáticamente sus parámetros.

| Paso | Motor por defecto |
|---|---|
| Imagen con tu cara | `yanze/PuLID-FLUX` |
| Imagen → vídeo | `zerogpu-aoti/wan2-2-fp8da-aoti-faster` (Wan 2.2 14B) |
| Gestos | `KwaiVGI/LivePortrait` |

## Calidad máxima en tu propio PC

Para clips más largos, 720p y sin límites de cuota, sigue
[docs/GUIA-LOCAL.md](docs/GUIA-LOCAL.md) (Pinokio + Wan2GP / ComfyUI, sin código).

## Desarrollo

La web es estática (`public/`) y se publica en GitHub Pages con cada push a
`main` (`.github/workflows/deploy-pages.yml`). Pruebas: `npm test`.

## Uso responsable

Usa solo tu propia cara o la de personas que te hayan dado su consentimiento
expreso. Crear vídeos de otras personas sin permiso puede vulnerar su derecho a la
propia imagen y constituir delito; el Reglamento europeo de IA obliga a indicar
que este contenido está generado artificialmente.
