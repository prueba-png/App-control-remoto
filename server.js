// Remote Support Panel — signaling server
//
// Responsibilities:
//   1. Serve the two static web clients (control panel + device client).
//   2. Mint single-use pairing tokens for a support session.
//   3. Relay WebRTC signaling (SDP / ICE) between the panel and the device.
//
// It does NOT see or store any media, telemetry or location: those flow
// peer-to-peer over the encrypted WebRTC connection. The server only brokers
// the initial handshake, then gets out of the way.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = join(__dirname, 'public');

// --- Session registry -------------------------------------------------------
// A session ties together one panel ("controller") and one device ("agent").
// The token is single-use for the device: once the device consumes it to join,
// it can't be reused to pair a second device.
const sessions = new Map(); // token -> { controller, agent, createdAt, consumed }
const TOKEN_TTL_MS = 10 * 60 * 1000; // pairing link valid for 10 minutes

function newToken() {
  return randomBytes(24).toString('base64url');
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > TOKEN_TTL_MS && !s.agent) {
      sessions.delete(token);
    }
  }
}
setInterval(pruneSessions, 60 * 1000).unref();

// --- Static file serving ----------------------------------------------------
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/') pathname = '/dashboard.html';
    // The pairing link points here: /device?token=...
    if (pathname === '/device') pathname = '/device.html';

    // Prevent path traversal.
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(PUBLIC_DIR, safePath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const data = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

// --- WebSocket signaling ----------------------------------------------------
const wss = new WebSocketServer({ server });

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  ws.role = null;
  ws.token = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      // Panel asks the server to create a fresh pairing token.
      case 'create-session': {
        const token = newToken();
        sessions.set(token, {
          controller: ws,
          agent: null,
          createdAt: Date.now(),
          consumed: false,
        });
        ws.role = 'controller';
        ws.token = token;
        send(ws, { type: 'session-created', token, ttlMs: TOKEN_TTL_MS });
        break;
      }

      // Device opens the pairing link and joins with the token.
      case 'join-session': {
        const s = sessions.get(msg.token);
        if (!s) {
          send(ws, { type: 'error', reason: 'invalid-or-expired-token' });
          return;
        }
        if (s.consumed || s.agent) {
          send(ws, { type: 'error', reason: 'token-already-used' });
          return;
        }
        s.agent = ws;
        s.consumed = true; // single-use: no second device can join
        ws.role = 'agent';
        ws.token = msg.token;
        send(ws, { type: 'joined' });
        send(s.controller, { type: 'device-online' });
        break;
      }

      // Relay signaling + control between the two peers of a session.
      case 'signal': // { sdp | candidate }
      case 'control': // e.g. { action: 'stop' } from the panel
      case 'telemetry-request': {
        const s = sessions.get(ws.token);
        if (!s) return;
        const peer = ws.role === 'controller' ? s.agent : s.controller;
        send(peer, msg);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const s = ws.token && sessions.get(ws.token);
    if (!s) return;
    const peer = ws.role === 'controller' ? s.agent : s.controller;
    send(peer, { type: 'peer-left' });
    // Tearing down the controller ends the whole session.
    if (ws.role === 'controller') sessions.delete(ws.token);
  });
});

server.listen(PORT, () => {
  console.log(`Remote Support Panel running at http://localhost:${PORT}`);
  console.log(`  Control panel : http://localhost:${PORT}/`);
  console.log(`  Device client : opened via the pairing link you generate`);
});
