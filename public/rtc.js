// Minimal WebRTC helper shared by the panel and the device client.
// Uses a public STUN server for NAT traversal. For fully self-hosted
// operation off your home network, run your own TURN server (e.g. coturn)
// and add it to ICE_SERVERS below.

export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // { urls: 'turn:your-turn-host:3478', username: '...', credential: '...' },
];

// Resolve the signaling server URL. On GitHub Pages (a static host that can't
// run server.js) set window.SIGNALING_URL in config.js to your deployed
// signaling server, e.g. "wss://mi-servidor.onrender.com". A ?signal=... query
// param overrides it for quick testing. Falls back to same-origin (local dev).
export function signalingUrl() {
  const override = new URL(location.href).searchParams.get('signal');
  if (override) return override;
  if (window.SIGNALING_URL) return window.SIGNALING_URL;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

export function connectSignaling(onMessage) {
  const ws = new WebSocket(signalingUrl());
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onMessage(msg, ws);
  });
  const send = (msg) => {
    const go = () => ws.send(JSON.stringify(msg));
    if (ws.readyState === WebSocket.OPEN) go();
    else ws.addEventListener('open', go, { once: true });
  };
  return { ws, send };
}

// Wire a peer connection's ICE candidates to the signaling channel and
// forward inbound signaling into the peer connection.
export function attachSignaling(pc, send) {
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) send({ type: 'signal', candidate: e.candidate });
  });
  return async function handleSignal(msg) {
    if (msg.sdp) {
      await pc.setRemoteDescription(msg.sdp);
      if (msg.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'signal', sdp: pc.localDescription });
      }
    } else if (msg.candidate) {
      try { await pc.addIceCandidate(msg.candidate); } catch { /* ignore */ }
    }
  };
}
