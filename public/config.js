// ─────────────────────────────────────────────────────────────────────────
// Configuración de red (se carga en el panel y en el dispositivo)
// ─────────────────────────────────────────────────────────────────────────
//
// Para que dos móviles en REDES DISTINTAS (WiFi ↔ datos móviles) conecten, hace
// falta un servidor TURN que funcione. Los TURN públicos gratuitos suelen estar
// caídos. La forma fiable y gratuita: crea una cuenta en https://metered.ca
// (plan gratis, 50 GB/mes), copia tu "username" y "credential" TURN y pégalos
// aquí abajo. Con eso funcionará en cualquier red.
//
// Sin credenciales TURN, la app SOLO conectará con los dos móviles en la MISMA
// red WiFi (usando STUN).

const TURN = {
  host: 'global.relay.metered.ca',
  username: '',    // <-- pega aquí tu usuario TURN de metered.ca
  credential: '',  // <-- pega aquí tu credencial TURN de metered.ca
};

const ice = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

if (TURN.username && TURN.credential) {
  for (const urls of [
    `turn:${TURN.host}:80`,
    `turn:${TURN.host}:80?transport=tcp`,
    `turn:${TURN.host}:443`,
    `turns:${TURN.host}:443?transport=tcp`,
  ]) ice.push({ urls, username: TURN.username, credential: TURN.credential });
} else {
  // Fallback público (poco fiable) solo para pruebas rápidas.
  for (const urls of [
    'turn:openrelay.metered.ca:80',
    'turn:openrelay.metered.ca:443',
    'turn:openrelay.metered.ca:443?transport=tcp',
  ]) ice.push({ urls, username: 'openrelayproject', credential: 'openrelayproject' });
}

// Permite inyectar un TURN sin editar este archivo:
//   localStorage.setItem('RTC_TURN', JSON.stringify({urls:'turn:host:443',username:'u',credential:'c'}))
try {
  const t = JSON.parse(localStorage.getItem('RTC_TURN') || 'null');
  if (t && t.urls && t.username) ice.push({ urls: t.urls, username: t.username, credential: t.credential });
} catch {}

window.RTC_CONFIG = { iceServers: ice };
window.HAS_TURN = !!(TURN.username && TURN.credential);
