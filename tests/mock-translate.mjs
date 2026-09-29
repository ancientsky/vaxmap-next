// 模擬 Anthropic Messages API 的小型伺服器（只供 tests/info.test.mjs 使用）。
// 回傳與輸入相同結構的 JSON，每個含文字的字串前加上 "[xx] "（xx = 系統提示中的 TARGET_LANGUAGE_CODE），
// 只含符號的字串（✓ 等）原樣回傳；藉此實際走過 translate-info.mjs 的結構驗證、合併與快取。
//
// mode：
//   'ok'        正常
//   'bad-shape' 永遠少回一個區塊（或多一個欄位）→ 驗證失敗、重試一次後仍失敗 → 該區塊保留原文
//   'bad-once'  每個請求第一次回錯誤結構，重試時回正確結構
//   'fence'     正常內容但包在 ```json 圍欄裡、前面多一句話
//   'unauthorized' 一律回 401
import http from 'node:http';

export function startMockTranslate({ mode = 'ok' } = {}) {
  const stats = { requests: 0, byLang: {}, retries: 0, lastBody: null };
  const prefix = (v, tag) => {
    if (typeof v === 'string') return /[\p{L}\p{N}]/u.test(v) && !/^[✓✗○]/.test(v) ? `[${tag}] ${v}` : v;
    if (Array.isArray(v)) return v.map((x) => prefix(x, tag));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = k === 'type' ? v[k] : prefix(v[k], tag);
      return o;
    }
    return v;
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stats.requests++;
      const send = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
      if (req.method !== 'POST' || req.url !== '/v1/messages') return send(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
      if (!req.headers['x-api-key'] || req.headers['anthropic-version'] !== '2023-06-01') return send(401, { type: 'error', error: { type: 'authentication_error', message: 'missing key' } });
      if (mode === 'unauthorized') return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      let req0;
      try { req0 = JSON.parse(body); } catch { return send(400, { type: 'error', error: { message: 'bad json' } }); }
      stats.lastBody = req0;
      const sys = Array.isArray(req0.system) ? req0.system.map((s) => s.text).join('\n') : String(req0.system || '');
      const lang = /TARGET_LANGUAGE_CODE: ([\w-]+)/.exec(sys)?.[1] || 'xx';
      stats.byLang[lang] = (stats.byLang[lang] || 0) + 1;
      const isRetry = req0.messages.length > 1;
      if (isRetry) stats.retries++;
      const src = JSON.parse(req0.messages[0].content);
      let out = prefix(src, lang);
      if (mode === 'bad-shape' || (mode === 'bad-once' && !isRetry)) {
        out = structuredClone(out);
        if (Array.isArray(out.blocks) && out.blocks.length) out.blocks.pop(); else out.extra = 'x';
      }
      let text = JSON.stringify(out);
      if (mode === 'fence') text = 'Here is the translation:\n```json\n' + JSON.stringify(out, null, 2) + '\n```';
      send(200, {
        id: 'msg_mock', type: 'message', role: 'assistant', model: req0.model, stop_reason: 'end_turn',
        content: [{ type: 'text', text }],
        usage: { input_tokens: Math.ceil(body.length / 3), output_tokens: Math.ceil(text.length / 3) },
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}/v1/messages`, stats, close: () => server.close() })));
}
