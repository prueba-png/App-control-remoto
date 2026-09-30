// ─────────────────────────────────────────────────────────────────────────
// Configuración de red (se carga en el panel y en el dispositivo)
// ─────────────────────────────────────────────────────────────────────────
//
// La app usa PeerJS con su broker de señalización público gratuito, así que
// NO necesitas desplegar ningún servidor. Para que la conexión P2P funcione
// también entre redes distintas (WiFi ↔ datos móviles) se añaden servidores
// TURN/STUN públicos gratuitos.
//
// Si algún día quieres máxima fiabilidad, sustituye el TURN por uno propio
// (coturn) o una cuenta de Metered/Twilio.

window.RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};
