// Marca de agua visible "Generado con IA" en todo lo que se descarga.
// Imágenes: se dibuja en un canvas. Vídeos: se reproduce el clip en un canvas
// con la marca encima y se graba con MediaRecorder.

export const LABEL = 'Generado con IA · AuraFace';

function drawLabel(ctx, w, h) {
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.035));
  ctx.save();
  ctx.font = `600 ${size}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const pad = Math.round(size * 0.6);
  const tw = ctx.measureText(LABEL).width;
  const x = w - tw - pad * 3;
  const y = h - size - pad * 3;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(x, y, tw + pad * 2, size + pad * 1.4, pad);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  ctx.fillText(LABEL, x + pad, y + pad * 0.7);
  ctx.restore();
}

async function fetchBlob(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo descargar el resultado (${r.status})`);
  return r.blob();
}

export async function watermarkImage(url) {
  const blob = await fetchBlob(url);
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  drawLabel(ctx, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

function pickMime() {
  const opts = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

export async function watermarkVideo(url, onProgress = () => {}) {
  const blob = await fetchBlob(url);
  const src = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.src = src;
  v.muted = true;
  v.playsInline = true;
  await new Promise((res, rej) => {
    v.onloadedmetadata = res;
    v.onerror = () => rej(new Error('El navegador no puede leer este vídeo'));
  });
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  const mime = pickMime();
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = res));
  let raf;
  const draw = () => {
    ctx.drawImage(v, 0, 0, c.width, c.height);
    drawLabel(ctx, c.width, c.height);
    if (v.duration) onProgress(v.currentTime / v.duration);
    raf = requestAnimationFrame(draw);
  };
  rec.start();
  draw();
  await v.play();
  await new Promise((res) => (v.onended = res));
  cancelAnimationFrame(raf);
  rec.stop();
  await done;
  URL.revokeObjectURL(src);
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), ext: mime.includes('mp4') ? 'mp4' : 'webm' };
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
