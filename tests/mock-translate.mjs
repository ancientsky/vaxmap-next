// 模擬翻譯 API 的小型伺服器（只供測試使用），依路徑分成兩種：
//   POST /v1/messages                                   Anthropic Messages API（x-api-key、anthropic-version 標頭）
//   POST /v1beta/models/<模型>:generateContent          Google Gemini API（x-goog-api-key 標頭；網址帶 ?key= 一律拒絕）
// 回傳與輸入相同結構的 JSON，每個含文字的字串前加上 "[xx] "（xx = 系統提示中的 TARGET_LANGUAGE_CODE），
// 只含符號的字串（✓ 等）原樣回傳；藉此實際走過 translate-info.mjs 的結構驗證、合併與快取。
//
// mode：
//   'ok'           正常
//   'bad-shape'    永遠少回一個區塊（或多一個欄位）→ 驗證失敗、重試一次後仍失敗 → 該區塊保留原文
//   'bad-once'     每個請求第一次回錯誤結構，重試時回正確結構
//   'fence'        正常內容但包在 ```json 圍欄裡、前面多一句話
//   'unauthorized' 一律回 401（Gemini 路徑則回 400 API_KEY_INVALID，與真實 API 相同）
//   'forbidden'    一律回 403 PERMISSION_DENIED
//   'rate-once'    每個語言的第一個請求回 429（帶 Retry-After: 0 或 RetryInfo），之後正常
//   'quota'        一律回 429 RESOURCE_EXHAUSTED
import http from 'node:http';

export function startMockTranslate({ mode = 'ok' } = {}) {
  const stats = { requests: 0, byLang: {}, retries: 0, lastBody: null, lastPath: null, rateLimited: 0, keyInUrl: 0, keysSeen: new Set(), byApi: {} };
  const seenLang = new Set();
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
  /** 共同的「翻譯」邏輯：回傳要放進回覆的文字 */
  const translate = (srcText, lang, isRetry) => {
    const src = JSON.parse(srcText);
    let out = prefix(src, lang);
    if (mode === 'bad-shape' || (mode === 'bad-once' && !isRetry)) {
      out = structuredClone(out);
      if (Array.isArray(out.blocks) && out.blocks.length) out.blocks.pop(); else out.extra = 'x';
    }
    if (mode === 'fence') return 'Here is the translation:\n```json\n' + JSON.stringify(out, null, 2) + '\n```';
    return JSON.stringify(out);
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stats.requests++;
      const u = new URL(req.url, 'http://127.0.0.1');
      stats.lastPath = u.pathname;
      const send = (code, obj, headers = {}) => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json');
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.end(JSON.stringify(obj));
      };
      const gm = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(u.pathname);
      const api = req.method === 'POST' && u.pathname === '/v1/messages' ? 'anthropic' : req.method === 'POST' && gm ? 'gemini' : null;
      if (!api) return send(404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
      stats.byApi[api] = (stats.byApi[api] || 0) + 1;
      let req0;
      try { req0 = JSON.parse(body); } catch { return send(400, { error: { code: 400, message: 'bad json', status: 'INVALID_ARGUMENT' } }); }
      stats.lastBody = req0;

      if (api === 'anthropic') {
        const aerr = (code, type, message) => send(code, { type: 'error', error: { type, message } });
        if (!req.headers['x-api-key'] || req.headers['anthropic-version'] !== '2023-06-01') return aerr(401, 'authentication_error', 'missing key');
        stats.keysSeen.add(req.headers['x-api-key']);
        if (mode === 'unauthorized') return aerr(401, 'authentication_error', 'invalid x-api-key');
        if (mode === 'forbidden') return aerr(403, 'permission_error', 'forbidden');
        const sys = Array.isArray(req0.system) ? req0.system.map((s) => s.text).join('\n') : String(req0.system || '');
        const lang = /TARGET_LANGUAGE_CODE: ([\w-]+)/.exec(sys)?.[1] || 'xx';
        if (mode === 'quota' || (mode === 'rate-once' && !seenLang.has(lang))) {
          seenLang.add(lang); stats.rateLimited++;
          return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }, { 'retry-after': '0' });
        }
        stats.byLang[lang] = (stats.byLang[lang] || 0) + 1;
        const isRetry = req0.messages.length > 1;
        if (isRetry) stats.retries++;
        const text = translate(req0.messages[0].content, lang, isRetry);
        return send(200, {
          id: 'msg_mock', type: 'message', role: 'assistant', model: req0.model, stop_reason: 'end_turn',
          content: [{ type: 'text', text }],
          usage: { input_tokens: Math.ceil(body.length / 3), output_tokens: Math.ceil(text.length / 3) },
        });
      }

      // Gemini：錯誤格式 { error: { code, message, status, details } }
      const gerr = (code, status, message, details, headers) => send(code, { error: { code, message, status, ...(details ? { details } : {}) } }, headers);
      if (u.searchParams.has('key')) { stats.keyInUrl++; return gerr(400, 'INVALID_ARGUMENT', 'test mock: API key must not be sent in the URL'); }
      const key = req.headers['x-goog-api-key'];
      if (!key) return gerr(403, 'PERMISSION_DENIED', 'Method doesn\'t allow unregistered callers.');
      stats.keysSeen.add(key);
      if (mode === 'unauthorized') {
        return gerr(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.',
          [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }]);
      }
      if (mode === 'forbidden') return gerr(403, 'PERMISSION_DENIED', 'Permission denied on resource project.');
      if (decodeURIComponent(gm[1]) === 'no-such-model') return gerr(404, 'NOT_FOUND', 'models/no-such-model is not found for API version v1beta');
      const sys = (req0.systemInstruction?.parts || []).map((p) => p.text).join('\n');
      const lang = /TARGET_LANGUAGE_CODE: ([\w-]+)/.exec(sys)?.[1] || 'xx';
      if (mode === 'quota' || (mode === 'rate-once' && !seenLang.has(lang))) {
        seenLang.add(lang); stats.rateLimited++;
        return gerr(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.',
          [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }]);
      }
      if (req0.generationConfig?.responseMimeType !== 'application/json') return gerr(400, 'INVALID_ARGUMENT', 'test mock: expected responseMimeType application/json');
      stats.byLang[lang] = (stats.byLang[lang] || 0) + 1;
      const contents = req0.contents || [];
      const isRetry = contents.length > 1;
      if (isRetry) stats.retries++;
      const text = translate(contents[0].parts.map((p) => p.text).join(''), lang, isRetry);
      return send(200, {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: Math.ceil(body.length / 3), candidatesTokenCount: Math.ceil(text.length / 3), totalTokenCount: 0 },
        modelVersion: decodeURIComponent(gm[1]),
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ url: `${base}/v1/messages`, geminiUrl: `${base}/v1beta`, stats, close: () => server.close() });
  }));
}
