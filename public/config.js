// ─────────────────────────────────────────────────────────────────────────
// Configuración del cliente (se carga tanto en el panel como en el dispositivo)
// ─────────────────────────────────────────────────────────────────────────
//
// GitHub Pages solo sirve archivos estáticos, así que NO puede ejecutar el
// servidor de señalización (server.js). Despliega ese servidor en un host que
// ejecute Node (Render / Railway / Fly) y pega aquí su URL con "wss://".
//
// Ejemplo:
//   window.SIGNALING_URL = 'wss://app-control-remoto.onrender.com';
//
// Déjalo vacío ('') para desarrollo local con `npm start` (usa el mismo origen).

window.SIGNALING_URL = '';
