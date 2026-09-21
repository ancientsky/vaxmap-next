// 模擬現站 API 的小型伺服器（只供 tests/harvest.test.mjs 使用）：
// 每次回 20 筆、依 bbox 過濾、排除 ids[]、少了 X-Requested-With 回 404。
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';

export function startMockSource(rawPath) {
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(rawPath)));
  const stats = { requests: 0, maxIds: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.setHeader('Set-Cookie', 'sid=mock; Path=/'); res.end('<html>mock</html>'); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stats.requests++;
      if (req.url !== '/Home/GetHospitalData' || req.headers['x-requested-with'] !== 'XMLHttpRequest') {
        res.statusCode = 404; res.end('<!DOCTYPE html>404'); return;
      }
      const p = new URLSearchParams(body);
      const ids = new Set(p.getAll('ids[]').map(Number));
      stats.maxIds = Math.max(stats.maxIds, ids.size);
      if (ids.size > 1000) { res.statusCode = 500; res.end('too many form keys'); return; }
      const [b, l, r, t] = ['bottom', 'left', 'right', 'top'].map((k) => Number(p.get(k)));
      const page = raw.hospitals
        .filter((h) => h.Lat >= b && h.Lat <= t && h.Long >= l && h.Long <= r && !ids.has(h.Id))
        .slice(0, 20)
        .map((h) => ({ ...h, DefaultVacc: raw.catalog, InfoWindowMessage: '<div>html</div>' }));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(page));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, stats, total: raw.hospitals.length, close: () => server.close() })));
}
