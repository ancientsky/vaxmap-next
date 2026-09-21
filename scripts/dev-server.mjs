#!/usr/bin/env node
// 零相依的靜態伺服器：node scripts/dev-server.mjs
// 環境變數：PORT（預設 5173）、HOST（預設 127.0.0.1；需要讓區網內手機連線測試時才設 HOST=0.0.0.0）
// 僅供本地開發，不要拿來對外服務。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'));
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const inRoot = (p) => p === ROOT || p.startsWith(ROOT + path.sep);

function send(res, code, text = '', headers = {}) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(text);
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { Allow: 'GET, HEAD' });
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  // 拒絕 NUL（fs 會直接丟例外）、反斜線（Windows 路徑分隔）與控制字元
  if (/[\0-\x1f\x7f\\]/.test(rel)) return send(res, 400, 'Bad request');
  let file = path.resolve(ROOT, '.' + path.posix.normalize('/' + rel));
  if (!inRoot(file)) return send(res, 403, 'Forbidden');
  let st;
  try {
    st = await fs.promises.stat(file);
    if (st.isDirectory()) {
      if (!rel.endsWith('/')) {
        // 由檔案系統路徑重建 Location，避免 //evil.example 這類協定相對網址造成開放式重新導向
        const loc = '/' + path.relative(ROOT, file).split(path.sep).filter(Boolean).map(encodeURIComponent).join('/');
        return send(res, 301, '', { Location: (loc === '/' ? '' : loc) + '/' });
      }
      file = path.join(file, 'index.html');
      st = await fs.promises.stat(file);
    }
    // 符號連結不得指向 public/ 之外
    if (!inRoot(await fs.promises.realpath(file))) return send(res, 403, 'Forbidden');
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!st.isFile()) return send(res, 404, 'Not found');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('dev-server error:', e?.message || e);
    send(res, 500, 'Internal error');
  });
});
server.on('clientError', (_err, socket) => socket.destroy());

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`vaxmap dev server: http://${shown}:${PORT}/  (root: ${ROOT}, bind: ${HOST})`);
});
