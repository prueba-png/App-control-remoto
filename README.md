# Remote Support Panel

Panel de soporte remoto **autoalojado** y **basado en consentimiento** para
gestionar tus propios dispositivos desde fuera de casa. Comunicación P2P cifrada
mediante WebRTC; el servidor solo hace de señalización y nunca ve la pantalla,
la telemetría ni la ubicación.

## Filosofía de diseño

Este proyecto hace soporte remoto **legítimo y visible**, no vigilancia. En la
práctica eso significa:

- Todo lo que se comparte pasa por un **prompt de permiso del sistema operativo**
  (compartir pantalla, ubicación) que el navegador impone y que no se puede
  esquivar.
- El dispositivo muestra un **banner visible** mientras la sesión está activa y
  puede **detenerla en cualquier momento**.
- Los enlaces de vinculación son **de un solo uso** y caducan a los 10 minutos.

Deliberadamente **no** incluye —y no se debe añadir— captura remota encubierta
de cámara, exfiltración de la galería/archivos, ni lectura de notificaciones o
mensajes: no son funciones de soporte remoto y convierten cualquier panel en
software de vigilancia.

## Módulos incluidos

| Módulo | API usada | Consentimiento |
|--------|-----------|----------------|
| Screen mirroring | `getDisplayMedia` (WebRTC) | Prompt del SO + indicador de compartición |
| Telemetría (batería/red/almacenamiento) | `getBattery`, `navigator.connection`, `storage.estimate` | Casilla en el cliente |
| Geolocalización | `navigator.geolocation` | Prompt del SO |

## Arquitectura

```
┌────────────┐   WebSocket (señalización)   ┌────────────┐
│  Panel web │◀────────────────────────────▶│  Servidor  │
│ (dashboard)│                               │  Node.js   │
└─────┬──────┘                               └─────┬──────┘
      │            WebRTC P2P (E2E)                │
      │     pantalla + datos + ubicación           │
      └──────────────◀──────────────▶ ─────────────┘
                    ┌────────────┐
                    │  Cliente   │
                    │ dispositivo│  ← abre el enlace de vinculación
                    └────────────┘
```

- `server.js` — servidor HTTP + señalización WebSocket. Sirve los clientes,
  emite tokens de un solo uso y retransmite SDP/ICE. No almacena ni ve medios.
- `public/dashboard.html` — panel de control (React-less, Tailwind por CDN).
- `public/device.html` — cliente que se abre en el dispositivo, con la barrera
  de consentimiento.
- `public/rtc.js` — helper WebRTC compartido.

## Uso

```bash
npm install
npm start
# Panel:  http://localhost:3000
```

1. Abre el panel y pulsa **Generar enlace de soporte**.
2. Abre ese enlace en tu propio dispositivo (misma red, o expón el servidor con
   HTTPS — ver abajo).
3. Elige qué compartir y pulsa iniciar. Acepta los prompts del navegador.

### HTTPS / fuera de tu red

`getDisplayMedia` y la geolocalización requieren un **contexto seguro (HTTPS)**
salvo en `localhost`. Para usarlo fuera de casa:

- Pon el servidor detrás de un reverse proxy con TLS (Caddy, nginx, Traefik), o
- Usa un túnel como `cloudflared` / `tailscale funnel` durante las pruebas.

### TURN (redes restrictivas)

Para conexiones fiables entre redes distintas, añade tu propio servidor TURN
(p. ej. [coturn](https://github.com/coturn/coturn)) en `ICE_SERVERS` dentro de
`public/rtc.js`.

## Despliegue en producción (URL permanente)

El sistema tiene **dos piezas** que se despliegan por separado:

### 1. Frontend → GitHub Pages (automático)

Cada push a `main` publica la carpeta `public/` en GitHub Pages mediante
`.github/workflows/deploy-pages.yml`. La URL es permanente y con HTTPS (lo que
habilita los permisos de pantalla y ubicación en el navegador):

```
https://<usuario>.github.io/<repo>/
```

### 2. Servidor de señalización → host con Node

Pages **no** ejecuta `server.js`. Despliega el servidor en un host de Node:

- **Render:** conecta el repo en https://dashboard.render.com/blueprints — el
  `render.yaml` incluido lo configura solo.
- **Railway / Fly.io:** usa el `Dockerfile` incluido.

Cuando tengas la URL del servidor (p. ej. `https://algo.onrender.com`), edita
`public/config.js`:

```js
window.SIGNALING_URL = 'wss://algo.onrender.com'; // https → wss
```

Haz commit → Pages se actualiza y el panel ya conecta con tu servidor.

> Para pruebas rápidas también puedes añadir `?signal=wss://tu-servidor` a la
> URL del panel sin tocar `config.js`.

## Migración a Next.js

El panel está hecho como HTML+Tailwind para que funcione sin build. Si quieres
Next.js/React: mueve la lógica de `dashboard.html` a un componente cliente
(`'use client'`), reutiliza `public/rtc.js` tal cual y mantén `server.js` como
servicio de señalización aparte.

## Próximos pasos sugeridos

- [ ] Autenticación real del panel (login + sesiones) antes de exponerlo.
- [ ] Servidor TURN propio para conectividad fuera de la LAN.
- [ ] Empaquetar el cliente de dispositivo como PWA instalable.
- [ ] Cifrado a nivel de aplicación sobre el canal de datos (además del DTLS de WebRTC).

## Licencia

MIT.
