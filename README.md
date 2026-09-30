# App de Control Remoto (soporte remoto entre tus propios dispositivos)

Panel web para conectar tus **propios** móviles y ver su pantalla, estado y
ubicación desde fuera de casa. Conexión **P2P real** con WebRTC (nada simulado),
cifrada de extremo a extremo. **No necesitas desplegar ningún servidor**: la
señalización usa el broker público gratuito de [PeerJS](https://peerjs.com) y la
conexión atraviesa redes distintas gracias a servidores STUN/TURN públicos.

## Cómo funciona (flujo)

1. Abres el **panel de control** en un móvil y pulsas *"Generar enlace para mi
   otro móvil"* → aparece un enlace + un **QR**.
2. Abres ese enlace (o escaneas el QR) en tu **segundo móvil**.
3. Ese móvil se conecta **solo**. Lo único que tocas es **un toque de "permitir"**
   cuando el navegador pida compartir pantalla o ubicación — es obligatorio por
   seguridad del sistema operativo y no se puede (ni se debe) saltar.
4. En el panel ves en tiempo real: **pantalla**, **batería/red/almacenamiento** y
   **ubicación en un mapa**.

Mientras la sesión está activa, el segundo móvil muestra un **aviso visible** y
puede **detenerla** en cualquier momento.

## Filosofía: soporte remoto legítimo, no vigilancia

Todo lo que se comparte pasa por un **permiso visible del sistema** y el
dispositivo sabe en todo momento que está compartiendo. Deliberadamente **no**
incluye captura oculta de cámara, exfiltración de galería/archivos ni lectura de
mensajes/notificaciones: no son funciones de soporte y convertirían el panel en
software espía.

## Módulos

| Módulo | API del navegador | Consentimiento |
|--------|-------------------|----------------|
| Pantalla en vivo | `getDisplayMedia` (WebRTC) | Prompt del SO + indicador de compartición |
| Batería / red / almacenamiento | `getBattery`, `navigator.connection`, `storage.estimate` | Casilla en el cliente |
| Ubicación en mapa | `navigator.geolocation` | Prompt del SO |

## Estructura

```
public/
  dashboard.html   # Panel de control (genera enlace + QR, muestra pantalla/telemetría)
  device.html      # Cliente del segundo móvil (auto-conexión + consentimiento)
  config.js        # Servidores ICE (STUN/TURN). Edítalo para usar tu propio TURN.
netlify.toml       # Publica public/ como sitio estático
server.js          # (Opcional) señalización propia para modo self-hosted; no hace
                   #  falta con PeerJS. Ver más abajo.
```

## Requisito para que funcionen los permisos: HTTPS

`getDisplayMedia` y la geolocalización solo funcionan en **contexto seguro
(HTTPS)** o en `localhost`. Por eso se publica en un hosting con HTTPS
(GitHub Pages / Netlify). Abierto por `file://` o HTTP no funcionará.

## Fiabilidad de la conexión

- **Misma WiFi:** conexión directa, siempre funciona.
- **Redes distintas (WiFi ↔ datos):** se usa TURN público (Open Relay). Para
  máxima fiabilidad, pon tu propio TURN (coturn) o una cuenta de Metered/Twilio
  en `public/config.js`.
- El broker público de PeerJS es gratuito pero orientado a prototipos; si alguna
  vez falla, puedes autoalojar [PeerServer](https://github.com/peers/peerjs-server)
  y pasarlo en la config del `Peer`.

## Modo self-hosted opcional (sin PeerJS)

Si prefieres no depender de servicios públicos, `server.js` incluye un servidor
de señalización propio (Node + WebSocket). Ejecuta `npm install && npm start` y
sirve la app en `http://localhost:3000`. Tendrías que adaptar los clientes para
usar ese canal en vez de PeerJS.

## Licencia

MIT.
