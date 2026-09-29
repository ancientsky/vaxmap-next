#!/usr/bin/env node
// 把 data/info/source.json（繁中）翻成其他 7 種語言 → public/data/info/<lang>.json（共 8 檔，含 zh-Hant）。
// 只翻譯「雜湊不在快取裡」的區塊：快取在 data/info/translations.json，鍵為 區塊雜湊＋語言，
// 內容沒變的區塊永遠不會重送。流程與費用見 docs/INFO_PIPELINE.md，格式見 docs/INFO_SCHEMA.md。
//
// 用法：node scripts/translate-info.mjs
//       node scripts/translate-info.mjs --force <區塊 id|title|all> [--lang en,ja]   丟棄快取、強制重新翻譯
//       node scripts/translate-info.mjs --export <檔案>          匯出繁中「翻譯投影」（送 API 的內容），供離線／人工翻譯
//       node scripts/translate-info.mjs --import <lang> <檔案>   匯入同格式的譯文：逐區塊驗證後存入快取（source:"manual"），
//                                                                 再重建 public/data/info/*.json；不呼叫 API
//       node scripts/translate-info.mjs --merge-cache <檔案>     把另一份 translations.json（通常是 repo 內含人工譯文的那份）
//                                                                 併入 INFO_DATA_DIR/translations.json：source:"manual" 的項目優先，
//                                                                 其餘只補缺；不呼叫 API、不輸出語言檔
// 環境變數：
//   TRANSLATE_PROVIDER  翻譯服務：gemini（預設，Google Gemini API）或 anthropic（Anthropic Messages API）
//   GEMINI_API_KEY      provider=gemini 的金鑰（以 x-goog-api-key 標頭送出，絕不放進網址）
//   ANTHROPIC_API_KEY   provider=anthropic 的金鑰
//                       對應的金鑰沒有設定（或空白）時不翻譯：8 個檔案照樣產生，未翻譯區塊帶原文、translated:false，結束代碼 0
//   TRANSLATE_MODEL     模型（預設 gemini：gemini-3.5-flash-lite；anthropic：claude-sonnet-5-5）
//   TRANSLATE_TEMPERATURE  取樣溫度（預設不送出，使用模型預設值；Google 建議 Gemini 3 系列維持預設 1.0）
//   TRANSLATE_EFFORT    anthropic 專用：output_config.effort（預設 low；翻譯不需要長推理）
//   TRANSLATE_ENDPOINT  API 網址。gemini：API 根網址（預設 https://generativelanguage.googleapis.com/v1beta，
//                       實際請求 <根網址>/models/<模型>:generateContent）；anthropic：Messages API 完整網址
//                       （預設 https://api.anthropic.com/v1/messages）。測試時指向 tests/mock-translate.mjs
//   TRANSLATE_LANGS     要翻譯的語言（逗號分隔，預設 en,ja,ko,id,vi,th,tl）
//   TRANSLATE_CONCURRENCY  同時請求數（預設 3）
//   TRANSLATE_MAX_CHARS    單一區塊原文字數上限，超過不送（成本保險絲，預設 20000）
//   TRANSLATE_MAX_MINUTES  整次執行時間上限（預設 30；逾時未開始的區塊留待下次）
//   INFO_DATA_DIR       source.json／translations.json 所在資料夾（預設 data/info）
//   INFO_PUBLIC_DIR     輸出資料夾（預設 public/data/info）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sanitizeInfo, INFO_LANGS, INFO_LIMITS } from './sanitize-info.mjs';
import { projectSection } from './harvest-info.mjs';

/** 各翻譯服務的預設值。金鑰變數名稱也在這裡，錯誤訊息據此提示該檢查哪個變數 */
export const PROVIDERS = Object.freeze({
  gemini: Object.freeze({ model: 'gemini-3.5-flash-lite', endpoint: 'https://generativelanguage.googleapis.com/v1beta', keyVar: 'GEMINI_API_KEY' }),
  anthropic: Object.freeze({ model: 'claude-sonnet-5-5', endpoint: 'https://api.anthropic.com/v1/messages', keyVar: 'ANTHROPIC_API_KEY' }),
});
export const DEFAULT_PROVIDER = 'gemini';
export const DEFAULT_MODEL = PROVIDERS[DEFAULT_PROVIDER].model;
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_CACHE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// 每百萬 token 美元（輸入, 輸出；付費層級標準價），只用於記錄檔中的費用估算
const PRICES = {
  'gemini-3.5-flash-lite': [0.30, 2.50], 'gemini-3.1-flash-lite': [0.25, 1.50],
  'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-haiku-4-5': [1, 5],
};
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/; // 模型名稱會放進 Gemini 的網址路徑，只允許這些字元
export const LANG_NAMES = Object.freeze({
  en: 'English', ja: 'Japanese (日本語)', ko: 'Korean (한국어)', id: 'Indonesian (Bahasa Indonesia)',
  vi: 'Vietnamese (Tiếng Việt)', th: 'Thai (ภาษาไทย)', tl: 'Filipino (Tagalog)',
});
const TARGETS = INFO_LANGS.filter((l) => l !== 'zh-Hant');
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const logSafe = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * 結構驗證
 * ------------------------------------------------------------------ */
const FIXED_KEYS = new Set(['type']); // 值必須原樣保留的鍵
const SYMBOL_ONLY = /^[^\p{L}\p{N}]*$/u; // 沒有字母也沒有數字（✓、✗、○、—…）
/** 原文中必須在譯文出現的數字（2 位以上；「12月1日」這種月／日數字除外，因為會被寫成月份名稱） */
function requiredNumbers(s) {
  const out = new Set();
  for (const m of s.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const after = s[m.index + m[0].length];
    if (after === '月' || after === '日') continue;
    const n = m[0].replace(',', '.').replace(/^0+(?=\d)/, '');
    if (n.replace('.', '').length >= 2) out.add(n);
  }
  return out;
}
const numbersIn = (s) => new Set([...s.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(',', '.').replace(/^0+(?=\d)/, '')));

/**
 * 檢查譯文與原文結構完全相同：同樣的鍵、陣列長度、type 值；字串仍是字串；
 * 只含符號的字串（✓ 等）原樣保留；原文的數字與網址在譯文中仍出現。回傳錯誤訊息或 null。
 */
export function checkShape(src, out, p = '$') {
  if (typeof src === 'string') {
    if (typeof out !== 'string') return `${p} 應為字串`;
    if (src.trim() && !out.trim()) return `${p} 不可為空字串`;
    if (SYMBOL_ONLY.test(src) && out.trim() !== src.trim()) return `${p} 只含符號，必須原樣保留（${src}）`;
    if (/^[✓✗○]/.test(src) && !out.startsWith(src[0])) return `${p} 開頭的 ${src[0]} 必須保留`;
    const have = numbersIn(out);
    const missing = [...requiredNumbers(src)].filter((n) => !have.has(n));
    if (missing.length) return `${p} 缺少原文的數字 ${missing.join(', ')}（數字必須以阿拉伯數字原樣保留）`;
    for (const u of src.match(/https:\/\/[^\s]+/g) || []) if (!out.includes(u)) return `${p} 缺少網址 ${u}`;
    if (/[<>]/.test(out)) return `${p} 不可含 < 或 >`;
    return null;
  }
  if (Array.isArray(src)) {
    if (!Array.isArray(out)) return `${p} 應為陣列`;
    if (out.length !== src.length) return `${p} 應有 ${src.length} 項，實際 ${out.length} 項`;
    for (let i = 0; i < src.length; i++) { const e = checkShape(src[i], out[i], `${p}[${i}]`); if (e) return e; }
    return null;
  }
  if (isPlainObject(src)) {
    if (!isPlainObject(out)) return `${p} 應為物件`;
    const a = Object.keys(src).sort().join(','), b = Object.keys(out).sort().join(',');
    if (a !== b) return `${p} 的欄位應為 {${a}}，實際 {${b}}`;
    for (const k of Object.keys(src)) {
      if (FIXED_KEYS.has(k)) { if (out[k] !== src[k]) return `${p}.${k} 必須是 ${JSON.stringify(src[k])}`; continue; }
      const e = checkShape(src[k], out[k], `${p}.${k}`);
      if (e) return e;
    }
    return null;
  }
  return Object.is(src, out) ? null : `${p} 應為 ${JSON.stringify(src)}`;
}

/** 把翻譯後的投影（只有文字）套回原文區塊的骨架：href、updated、id、isNew、ext 等一律取自原文 */
export function mergeTranslation(section, proj) {
  const s = structuredClone(section);
  s.title = proj.title;
  s.blocks = s.blocks.map((b, i) => {
    const t = proj.blocks[i];
    switch (b.type) {
      case 'p': {
        const runs = b.runs.map((r, j) => ({ ...r, text: t.runs[j].text }));
        return { ...b, text: runs.map((r) => r.text).join(''), runs };
      }
      case 'list': return { ...b, items: [...t.items] };
      case 'table': {
        const o = { ...b, rows: t.rows.map((r) => [...r]) };
        if (b.caption !== undefined) o.caption = t.caption;
        if (b.head !== undefined) o.head = [...t.head];
        return o;
      }
      default: return { ...b, text: t.text };
    }
  });
  s.links = s.links.map((l, i) => ({ ...l, text: proj.links[i].text }));
  s.files = s.files.map((f, i) => ({ ...f, text: proj.files[i].text }));
  s.translated = true;
  return s;
}

const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : isPlainObject(v) ? Object.values(v).flatMap(strings) : []);
export const textLength = (proj) => strings(proj).reduce((n, s) => n + s.length, 0);
const titleProj = (t) => ({ title: t });
const titleHash = (t) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(titleProj(t))).digest('hex');

/* ------------------------------------------------------------------ *
 * 提示詞
 * ------------------------------------------------------------------ */
/** 從 docs/I18N.md 取出「醫療用語對照」表（繁中｜English｜備註） */
export function readGlossary(file = path.join(ROOT, 'docs/I18N.md')) {
  try {
    const md = fs.readFileSync(file, 'utf8');
    const start = md.indexOf('## 醫療用語對照');
    if (start < 0) return [];
    const end = md.indexOf('\n## ', start + 5);
    return md.slice(start, end < 0 ? undefined : end).split('\n')
      .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l) && !l.includes('| English |'))
      .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
      .filter((c) => c.length >= 2 && c[0] && c[1])
      .map(([zh, en, note]) => `- ${zh} → ${en}${note ? `（${note}）` : ''}`);
  } catch {
    return [];
  }
}

export function buildSystemPrompt(lang, glossary = readGlossary()) {
  const name = LANG_NAMES[lang];
  const coins = lang === 'en'
    ? '健康幣 → "Health Coins"'
    : `健康幣 → translate as the ${name} equivalent of "Health Coins"; at the first occurrence in a section add "(Health Coins)" after it`;
  return `You are a professional medical translator working for Taiwan CDC (Taiwan Centers for Disease Control).
You translate the official public vaccination information page from Traditional Chinese (Taiwan) into ${name}.
TARGET_LANGUAGE_CODE: ${lang}
Audience: the general public in Taiwan, including foreign residents and migrant workers. Use clear, plain, accurate language.

FORMAT (strict)
- The user message is one JSON object: one section of the page, with "title", "blocks", "links" and "files".
- Reply with ONLY the translated JSON object. No Markdown code fences, no comments, no explanations before or after.
- Keep exactly the same structure: the same keys; the same number of blocks, in the same order, with the same "type" values;
  the same number of "runs" in each paragraph, "items" in each list, "rows" and cells in each table, and entries in "links" and "files".
- Translate only string values. Never translate or change a "type" value.
- The "runs" of a paragraph are consecutive pieces of ONE sentence (some pieces are link texts). Translate so that the pieces joined
  together read naturally, keep each piece's meaning in the same run, and put spaces at run boundaries where ${name} needs them.
- Table cells that contain only a symbol (✓, ✗, ○) are copied unchanged. A cell that starts with ✓ keeps the ✓ at the start.
- Numbers stay as Arabic digits exactly as written: ages, coin amounts, doses (0.5 mL), counts, version codes (1150707, XFG),
  and dates written with slashes (2026/10/01, keep them exactly). 115 is the ROC (Minguo) calendar year = 2026: keep "115" and you may add (2026).
- Keep URLs, brand names, product codes and e-mail addresses unchanged. Do not add or omit information. No HTML, no Markdown.
- Title-like strings (headings, file names, link texts) stay short. Drop file extensions only if the source has none.

TERMINOLOGY (use consistently; for languages other than English, use the equivalent term in ${name})
${glossary.join('\n')}
- ${coins}
- 疫苗加值金 → "vaccine bonus" (bonus Health Coins for getting vaccinated)
- 公費 → "publicly funded" (paid by the government; never translate as "free")
- 左流右新 → the campaign slogan. At its first occurrence in a section render it as "flu shot in the left arm, COVID-19 in the right"
  (in ${name}); afterwards use a short form. 護肺顧心 → "protect your lungs and heart".
- 疾管署 → Taiwan CDC; 國民健康署／國健署 → Health Promotion Administration; 衛生福利部 → Ministry of Health and Welfare;
  衛生局 → local (county/city) health bureau; 合約院所 → contracted clinics; 量販店 → hypermarket; 接種站 → vaccination station.
- 新世代新冠疫苗 → next-generation COVID-19 vaccine; 加強型流感疫苗 → enhanced influenza vaccine; 標準型 → standard;
  三價 → trivalent; 單劑型 → single-dose; 多劑型 → multi-dose; 高劑量 → high-dose; 肺炎鏈球菌 → pneumococcal; 高風險 → high-risk.
- Companies / brands (always in Latin script): 高端 → Medigen; 國光 → Adimmune; 台灣東洋 → TTY Biopharm; 賽諾菲 → Sanofi;
  葛蘭素史克 → GSK; 莫德納 → Moderna; Novavax and Nuvaxovid unchanged.
- Chinese vaccine trade names (安定伏, 福喜健, 菲流達, 伏流感, 輔流威護, 輔流禦, 菲優達): keep the Chinese name as written;
  never invent a foreign trade name.
- Taiwan counties and cities: official English names in Latin-script languages (臺北市 → Taipei City, 連江縣 → Lienchiang County);
  in Japanese keep the kanji.`;
}

/* ------------------------------------------------------------------ *
 * API 呼叫
 * ------------------------------------------------------------------ */
async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) { await res.body?.cancel(); throw new Error(`回應過大（${len} bytes）`); }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); throw new Error('回應過大'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class FatalApiError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 把金鑰從任何要印出的字串中移除（API 的錯誤訊息理論上不會回顯金鑰，這裡再保險一次） */
const redact = (s, key) => (key && key.length >= 4 ? String(s).split(key).join('***') : String(s));

/** Gemini 429 回應的 details 可能帶 RetryInfo.retryDelay（例如 "12s"）；回傳毫秒或 NaN */
function geminiRetryDelay(errObj) {
  for (const d of errObj?.details || []) {
    const m = typeof d?.retryDelay === 'string' && /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay);
    if (m) return Number(m[1]) * 1000;
  }
  return NaN;
}

/**
 * 依翻譯服務組出請求。messages 為 [{ role: 'user'|'assistant', text }]。
 * @returns {{ url: string, headers: object, body: object }}
 */
function buildRequest(cfg, system, messages, maxTokens) {
  if (cfg.provider === 'gemini') {
    const generationConfig = { responseMimeType: 'application/json', maxOutputTokens: maxTokens };
    if (Number.isFinite(cfg.temperature)) generationConfig.temperature = cfg.temperature;
    return {
      // 金鑰只放在 x-goog-api-key 標頭，不用 ?key=（網址可能出現在代理伺服器或錯誤記錄中）
      url: `${cfg.endpoint.replace(/\/+$/, '')}/models/${encodeURIComponent(cfg.model)}:generateContent`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.key },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
        generationConfig,
      },
    };
  }
  const body = {
    model: cfg.model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: messages.map((m) => ({ role: m.role, content: m.text })),
  };
  if (cfg.effort) body.output_config = { effort: cfg.effort };
  if (Number.isFinite(cfg.temperature)) body.temperature = cfg.temperature;
  return { url: cfg.endpoint, headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': ANTHROPIC_VERSION }, body };
}

/** 把成功回應轉成共同格式 { text, usage: { in, out }, stop: 'end'|'max_tokens'|其他原因 } */
function parseResponse(cfg, data) {
  if (cfg.provider === 'gemini') {
    const c = (data.candidates || [])[0];
    if (!c) {
      const why = data.promptFeedback?.blockReason || '沒有候選回覆';
      return { text: '', usage: geminiUsage(data), stop: `blocked:${why}` };
    }
    const text = (c.content?.parts || []).filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
    const fr = c.finishReason || 'STOP';
    return { text, usage: geminiUsage(data), stop: fr === 'STOP' ? 'end' : fr === 'MAX_TOKENS' ? 'max_tokens' : `blocked:${fr}` };
  }
  const u = data.usage || {};
  return {
    text: (data.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join(''),
    usage: { in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens || 0 },
    stop: data.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
  };
}
// Gemini 的思考 token（thoughtsTokenCount）以輸出價計費，一併算進輸出
const geminiUsage = (d) => ({ in: d.usageMetadata?.promptTokenCount || 0, out: (d.usageMetadata?.candidatesTokenCount || 0) + (d.usageMetadata?.thoughtsTokenCount || 0) });

/** 呼叫一次翻譯 API（含 429／5xx 退避重試）；回傳 parseResponse 的結果 */
async function callApi(cfg, system, messages, maxTokens) {
  const { url, headers, body } = buildRequest(cfg, system, messages, maxTokens);
  const keyVar = PROVIDERS[cfg.provider].keyVar;
  const attempts = cfg.maxAttempts ?? 5;
  let lastErr;
  let rateLimited = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
    } catch (e) {
      lastErr = new Error(`連線失敗：${e?.cause?.code || e?.name || 'error'}`);
      await sleep(cfg.backoffMs * (attempt + 1));
      continue;
    }
    const raw = await readCapped(res, MAX_RESPONSE_BYTES);
    if (res.ok) {
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('API 回應不是 JSON'); }
      return parseResponse(cfg, data);
    }
    let errObj = null;
    try { errObj = JSON.parse(raw)?.error || null; } catch { /* 非 JSON */ }
    const apiMsg = redact(typeof errObj?.message === 'string' ? errObj.message : '', cfg.key).slice(0, 200);
    const msg = `HTTP ${res.status}${errObj?.status ? ` ${errObj.status}` : ''}${apiMsg ? '：' + apiMsg : ''}`;
    // Gemini 對無效金鑰回 400 + API_KEY_INVALID；兩家對未授權都回 401／403
    const badKey = [401, 403].includes(res.status) || JSON.stringify(errObj?.details || []).includes('API_KEY_INVALID');
    if (badKey) throw new FatalApiError(`${msg}（金鑰無效、已停用或沒有權限：請檢查 ${keyVar}${cfg.ci ? '（GitHub repo 的 Actions secret）' : ''}）`);
    if (res.status === 404 || res.status === 400) throw new FatalApiError(`${msg}（請檢查 TRANSLATE_MODEL「${cfg.model}」／TRANSLATE_ENDPOINT）`);
    lastErr = new Error(msg);
    if (![408, 409, 429, 500, 502, 503, 504, 529].includes(res.status)) break;
    if (res.status === 429) rateLimited++;
    if (attempt === attempts - 1) break;
    // 退避：優先用伺服器指定的等待時間（retry-after 標頭，或 Gemini 的 RetryInfo），否則指數退避加少量隨機
    const ra = Number(res.headers.get('retry-after'));
    const hinted = Number.isFinite(ra) && ra > 0 ? ra * 1000 : geminiRetryDelay(errObj);
    const wait = Number.isFinite(hinted) && hinted > 0 ? hinted : cfg.backoffMs * 2 ** attempt * (1 + Math.random() * 0.25);
    console.warn(`  速率限制或暫時錯誤（${msg.slice(0, 80)}），${Math.round(wait / 1000)} 秒後重試`);
    await sleep(Math.min(90000, wait));
  }
  if (rateLimited === attempts) {
    // 一直 429：多半是每日配額（RPD，太平洋時間午夜重置）或帳單上限用完——停止其餘請求，明天自動再試
    throw new FatalApiError(`${lastErr.message}（連續 ${attempts} 次 429：配額或速率上限已用完，其餘區塊留待下次執行；` +
      `可到 Google AI Studio 查看此金鑰的用量與上限）`);
  }
  throw lastErr;
}

/** 從模型回覆取出 JSON 物件（容許前後多餘文字或 ``` 圍欄） */
export function extractJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('回覆中找不到 JSON 物件');
  return JSON.parse(t.slice(a, b + 1));
}

/**
 * 翻譯一個投影（section 或頁面標題）：形狀不符時帶錯誤訊息重試一次，仍不符回傳 { proj: null }。
 * @returns {Promise<{ proj: object|null, usage: {in:number,out:number}, requests: number, error?: string }>}
 */
export async function translateProjection(cfg, lang, src, system) {
  const usage = { in: 0, out: 0 };
  const maxTokens = Math.min(32000, 2048 + Math.ceil(textLength(src) * 4));
  const messages = [{ role: 'user', text: JSON.stringify(src) }];
  let error;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callApi(cfg, system, messages, maxTokens);
    usage.in += r.usage.in;
    usage.out += r.usage.out;
    let out;
    try {
      if (r.stop === 'max_tokens') throw new Error('回覆超過輸出上限被截斷');
      if (r.stop !== 'end') throw new Error(`模型未完成回覆（${r.stop}）`);
      out = extractJson(r.text);
      error = checkShape(src, out);
    } catch (e) {
      error = e.message;
    }
    if (!error) return { proj: out, usage, requests: attempt + 1 };
    messages.push({ role: 'assistant', text: String(r.text).slice(0, 60000) || '(empty)' });
    messages.push({ role: 'user', text: `Your reply was rejected by the validator: ${error}\nReturn the complete corrected JSON object only, with exactly the same structure as the original.` });
  }
  return { proj: null, usage, requests: 2, error };
}

async function pool(tasks, n, fn) {
  let i = 0;
  const worker = async () => { while (i < tasks.length) { const t = tasks[i++]; await fn(t); } };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
}

/* ------------------------------------------------------------------ *
 * 快取與輸出
 * ------------------------------------------------------------------ */
/** 讀取快取；格式不對的項目丟棄。回傳 Map<hash, Map<lang, entry>> */
export function loadCache(file) {
  const cache = new Map();
  try {
    if (!fs.existsSync(file)) return cache;
    if (fs.statSync(file).size > MAX_CACHE_BYTES) { console.warn('translations.json 過大，忽略'); return cache; }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(raw)) return cache;
    for (const h of Object.keys(raw)) {
      if (!HASH_RE.test(h) || !isPlainObject(raw[h])) continue;
      const m = new Map();
      for (const l of Object.keys(raw[h])) if (TARGETS.includes(l) && isPlainObject(raw[h][l])) m.set(l, raw[h][l]);
      if (m.size) cache.set(h, m);
    }
  } catch (e) {
    console.warn(`translations.json 無法讀取，視為空白：${logSafe(e?.message || e)}`);
  }
  return cache;
}

function saveCache(file, cache, keep = null) {
  const out = {};
  for (const h of [...cache.keys()].sort()) {
    if (keep && !keep.has(h)) continue; // 來源已不存在的區塊不再保留
    const langs = cache.get(h);
    out[h] = {};
    for (const l of TARGETS) if (langs.has(l)) out[h][l] = langs.get(l);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(out, null, 1) + '\n');
  fs.renameSync(file + '.tmp', file);
}

/** 取出快取中與原文形狀相符的譯文投影；不符（例如來源結構改變或快取遭竄改）回傳 null */
function cached(cache, hash, lang, src) {
  const e = cache.get(hash)?.get(lang);
  if (!e) return null;
  const proj = {};
  for (const k of Object.keys(src)) proj[k] = e[k];
  return checkShape(src, proj) ? null : { proj, at: e.at };
}

/**
 * 把 extra（例如 repo 內含人工譯文的快取）併入 base（例如 data 分支上的快取），直接修改 base。
 * extra 中 source:"manual" 的項目一律覆蓋；其他項目只在 base 沒有時補上。兩者都應是 loadCache 的結果（已過濾鍵）。
 * @returns {{ manual: number, added: number }}
 */
export function mergeCaches(base, extra) {
  let manual = 0, added = 0;
  for (const [h, langs] of extra) {
    if (!base.has(h)) base.set(h, new Map());
    const b = base.get(h);
    for (const [l, e] of langs) {
      if (e?.source === 'manual') { b.set(l, e); manual++; } else if (!b.has(l)) { b.set(l, e); added++; }
    }
  }
  return { manual, added };
}

/** 產生一個語言的輸出檔內容（尚未清理） */
export function buildLangDoc(source, lang, cache) {
  const m = source.meta;
  if (lang === 'zh-Hant') {
    return {
      meta: { lang, sourceUrl: m.sourceUrl, sourceTitle: m.sourceTitle, title: m.sourceTitle, fetchedAt: m.fetchedAt, changedAt: m.changedAt, translation: 'source' },
      sections: source.sections.map((s) => ({ ...s, translated: true })),
    };
  }
  let latest = null;
  const bump = (at) => { if (typeof at === 'string' && (!latest || at > latest)) latest = at; };
  const sections = source.sections.map((s) => {
    const hit = cached(cache, s.hash, lang, projectSection(s));
    if (!hit) return { ...structuredClone(s), translated: false };
    bump(hit.at);
    return mergeTranslation(s, hit.proj);
  });
  const t = cached(cache, titleHash(m.sourceTitle), lang, titleProj(m.sourceTitle));
  if (t) bump(t.at);
  const all = sections.every((s) => s.translated);
  const meta = {
    lang, sourceUrl: m.sourceUrl, sourceTitle: m.sourceTitle, title: t ? t.proj.title : m.sourceTitle,
    fetchedAt: m.fetchedAt, changedAt: m.changedAt, translation: all ? 'machine' : 'partial',
  };
  if (latest) meta.translatedAt = latest;
  return { meta, sections };
}

/* ------------------------------------------------------------------ *
 * 離線翻譯：匯出／匯入
 * ------------------------------------------------------------------ */
/** 匯出檔內容：{ title: { hash, title }, sections: [ { id, key, hash, title, blocks, links, files } ] }（繁中） */
export function buildExport(source) {
  const t = source.meta.sourceTitle;
  return {
    title: { hash: titleHash(t), ...titleProj(t) },
    sections: source.sections.map((s) => ({ id: s.id, key: s.key, hash: s.hash, ...projectSection(s) })),
  };
}

/**
 * 把匯入檔（buildExport 格式，文字已翻譯）逐區塊驗證後寫入快取。
 * 雜湊與目前原文不符（原文已更新）或結構不符 → 略過並記錄原因。
 * @returns {{ imported: string[], skipped: string[] }}
 */
export function applyImport(source, cache, lang, data, now = new Date()) {
  if (!TARGETS.includes(lang)) throw new Error(`--import 的語言只接受 ${TARGETS.join(',')}`);
  if (!isPlainObject(data)) throw new Error('匯入檔不是 JSON 物件');
  const at = now.toISOString();
  const imported = [];
  const skipped = [];
  const put = (hash, proj, id) => {
    if (!cache.has(hash)) cache.set(hash, new Map());
    cache.get(hash).set(lang, { ...proj, source: 'manual', at });
    imported.push(id);
  };
  if (data.title !== undefined) {
    const t = data.title;
    const src = titleProj(source.meta.sourceTitle);
    if (!isPlainObject(t) || t.hash !== titleHash(source.meta.sourceTitle)) skipped.push('title：雜湊與目前原文不符（原文已更新），請重新匯出');
    else {
      const proj = { title: t.title };
      const err = checkShape(src, proj);
      if (err) skipped.push(`title：${err}`); else put(t.hash, proj, 'title');
    }
  }
  const list = data.sections;
  if (list !== undefined && !Array.isArray(list)) throw new Error('匯入檔的 sections 不是陣列');
  if ((list || []).length > INFO_LIMITS.sections) throw new Error('匯入檔的 sections 過多');
  const byId = new Map(source.sections.map((s) => [s.id, s]));
  for (const e of list || []) {
    const id = isPlainObject(e) && typeof e.id === 'string' ? e.id : '?';
    const s = byId.get(id);
    if (!s) { skipped.push(`${logSafe(id)}：目前原文沒有這個區塊`); continue; }
    if (e.hash !== s.hash) { skipped.push(`${id}：雜湊與目前原文不符（原文已更新），請重新匯出這個區塊`); continue; }
    const src = projectSection(s);
    const proj = {};
    for (const k of Object.keys(e)) if (!['id', 'key', 'hash'].includes(k)) proj[k] = e[k];
    const err = checkShape(src, proj);
    if (err) { skipped.push(`${id}：${err}`); continue; }
    put(s.hash, proj, id);
  }
  return { imported, skipped };
}

/* ------------------------------------------------------------------ *
 * 主程式
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const o = { force: null, langs: null, exportFile: null, importLang: null, importFile: null, mergeFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') o.force = argv[++i];
    else if (argv[i] === '--lang') o.langs = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--export') o.exportFile = argv[++i];
    else if (argv[i] === '--import') { o.importLang = argv[++i]; o.importFile = argv[++i]; }
    else if (argv[i] === '--merge-cache') { o.mergeFile = argv[++i]; if (!o.mergeFile) throw new Error('用法：--merge-cache <檔案>'); }
    else throw new Error(`不認得的參數 ${logSafe(argv[i])}`);
  }
  if (o.exportFile === undefined || (o.importLang !== null && !o.importFile)) throw new Error('用法：--export <檔案>、--import <lang> <檔案>');
  if (o.importLang !== null && !TARGETS.includes(o.importLang)) throw new Error(`--import 的語言只接受 ${TARGETS.join(',')}`);
  if (o.force !== null && !/^(all|title|\d{1,12})$/.test(o.force || '')) throw new Error('--force 需要區塊 id、title 或 all');
  if (o.langs && o.langs.some((l) => !TARGETS.includes(l))) throw new Error(`--lang 只接受 ${TARGETS.join(',')}`);
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = process.env.INFO_DATA_DIR || 'data/info';
  const pubDir = process.env.INFO_PUBLIC_DIR || 'public/data/info';
  const srcFile = path.join(dataDir, 'source.json');
  const cacheFile = path.join(dataDir, 'translations.json');
  if (args.mergeFile) {
    // 只合併快取，不需要 source.json；來源已不存在的雜湊留給下一次正常執行清除
    const base = loadCache(cacheFile);
    const { manual, added } = mergeCaches(base, loadCache(args.mergeFile));
    saveCache(cacheFile, base);
    console.log(`合併翻譯快取：${logSafe(args.mergeFile)} → ${logSafe(cacheFile)}（人工譯文 ${manual} 筆優先，補上 ${added} 筆）`);
    return;
  }
  if (!fs.existsSync(srcFile)) throw new Error(`找不到 ${srcFile}，請先執行 node scripts/harvest-info.mjs`);
  if (fs.statSync(srcFile).size > INFO_LIMITS.maxBytes) throw new Error('source.json 過大');
  const source = sanitizeInfo(JSON.parse(fs.readFileSync(srcFile, 'utf8')), { lang: 'zh-Hant' });

  const provider = (process.env.TRANSLATE_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error(`TRANSLATE_PROVIDER 只接受 ${Object.keys(PROVIDERS).join('、')}`);
  const P = PROVIDERS[provider];
  const key = (process.env[P.keyVar] || '').trim();
  const endpoint = process.env.TRANSLATE_ENDPOINT || P.endpoint;
  const eu = new URL(endpoint);
  if (eu.protocol !== 'https:' && !(eu.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(eu.hostname))) {
    throw new Error('TRANSLATE_ENDPOINT 必須是 https');
  }
  if (eu.username || eu.password || eu.search) throw new Error('TRANSLATE_ENDPOINT 不可含帳密或查詢字串（金鑰只經由環境變數傳入）');
  const model = process.env.TRANSLATE_MODEL || P.model;
  if (!MODEL_RE.test(model)) throw new Error('TRANSLATE_MODEL 格式不正確');
  const temp = process.env.TRANSLATE_TEMPERATURE;
  const cfg = {
    provider, key, endpoint, model,
    temperature: temp === undefined || temp === '' ? NaN : Number(temp),
    effort: provider === 'anthropic' ? (process.env.TRANSLATE_EFFORT ?? 'low') : '',
    backoffMs: Number(process.env.TRANSLATE_BACKOFF_MS ?? 2000),
    ci: process.env.GITHUB_ACTIONS === 'true',
  };
  if (temp && !(cfg.temperature >= 0 && cfg.temperature <= 2)) throw new Error('TRANSLATE_TEMPERATURE 必須介於 0 與 2');
  const langs = (process.env.TRANSLATE_LANGS || TARGETS.join(',')).split(',').map((s) => s.trim()).filter((l) => TARGETS.includes(l));
  const concurrency = Math.max(1, Math.min(8, Number(process.env.TRANSLATE_CONCURRENCY ?? 3)));
  const maxChars = Number(process.env.TRANSLATE_MAX_CHARS ?? 20000);
  const deadline = Date.now() + Number(process.env.TRANSLATE_MAX_MINUTES ?? 30) * 60000;

  const cache = loadCache(cacheFile);
  const units = [
    { id: 'title', hash: titleHash(source.meta.sourceTitle), src: titleProj(source.meta.sourceTitle) },
    ...source.sections.map((s) => ({ id: s.id, hash: s.hash, src: projectSection(s) })),
  ];
  if (args.exportFile) {
    fs.mkdirSync(path.dirname(args.exportFile) || '.', { recursive: true });
    fs.writeFileSync(args.exportFile, JSON.stringify(buildExport(source), null, 2) + '\n');
    console.log(`已匯出 ${units.length} 個翻譯單位（頁面標題＋${source.sections.length} 個區塊）→ ${logSafe(args.exportFile)}`);
    return;
  }
  if (args.importFile) {
    if (fs.statSync(args.importFile).size > INFO_LIMITS.maxBytes) throw new Error('匯入檔過大');
    const data = JSON.parse(fs.readFileSync(args.importFile, 'utf8'));
    const { imported, skipped } = applyImport(source, cache, args.importLang, data);
    for (const m of skipped) console.warn(`  [${args.importLang}] 略過 ${logSafe(m)}`);
    console.log(`匯入 ${args.importLang}：${imported.length} 個單位（${imported.join('、') || '無'}），略過 ${skipped.length} 個`);
  }
  if (args.force) {
    const fl = args.langs || TARGETS;
    let n = 0;
    for (const u of units) {
      if (args.force !== 'all' && args.force !== u.id) continue;
      for (const l of fl) if (cache.get(u.hash)?.delete(l)) n++;
    }
    console.log(`--force ${args.force}：丟棄 ${n} 筆快取`);
  }

  const tasks = [];
  if (!args.importFile) for (const lang of langs) {
    for (const u of units) if (!cached(cache, u.hash, lang, u.src)) tasks.push({ lang, u });
  }
  const total = { in: 0, out: 0, requests: 0, ok: 0, failed: 0, skipped: 0 };
  if (args.importFile) {
    // 匯入模式不呼叫 API，只重建輸出檔
  } else if (!tasks.length) {
    console.log('所有區塊都已有譯文（快取），不需呼叫 API');
  } else if (!key) {
    console.log(`注意：未設定 ${P.keyVar}（TRANSLATE_PROVIDER=${provider}），略過翻譯（${tasks.length} 個區塊×語言待翻譯）。` +
      '各語言檔仍會產生，未翻譯的區塊帶繁中原文並標示 translated:false、meta.translation:"partial"。');
  } else {
    console.log(`翻譯 ${tasks.length} 個區塊×語言（${provider}，模型 ${cfg.model}，同時 ${concurrency} 個請求）`);
    let fatal = null;
    const systems = new Map(langs.map((l) => [l, buildSystemPrompt(l)]));
    await pool(tasks, concurrency, async ({ lang, u }) => {
      if (fatal) { total.skipped++; return; }
      if (Date.now() > deadline) { total.skipped++; console.warn(`  [${lang}] ${u.id} 略過：超過執行時間上限`); return; }
      const chars = textLength(u.src);
      if (chars > maxChars) { total.skipped++; console.warn(`  [${lang}] ${u.id} 略過：原文 ${chars} 字，超過上限 ${maxChars}`); return; }
      try {
        const r = await translateProjection(cfg, lang, u.src, systems.get(lang));
        total.in += r.usage.in; total.out += r.usage.out; total.requests += r.requests;
        if (!r.proj) {
          total.failed++;
          console.warn(`  [${lang}] ${u.id} 結構驗證未通過，保留原文：${logSafe(r.error)}`);
          return;
        }
        if (!cache.has(u.hash)) cache.set(u.hash, new Map());
        cache.get(u.hash).set(lang, { ...r.proj, model: cfg.model, at: new Date().toISOString() });
        total.ok++;
        console.log(`  [${lang}] ${u.id} ✓ ${chars} 字，輸入 ${r.usage.in}／輸出 ${r.usage.out} tokens${r.requests > 1 ? '（重試 1 次）' : ''}`);
      } catch (e) {
        total.failed++;
        if (e instanceof FatalApiError) fatal = e;
        console.warn(`  [${lang}] ${u.id} 翻譯失敗：${logSafe(redact(e?.message || e, key))}`);
      }
    });
    const price = PRICES[cfg.model];
    const cost = price ? `，約 US$${((total.in * price[0] + total.out * price[1]) / 1e6).toFixed(3)}` : '';
    console.log(`翻譯完成：成功 ${total.ok}、失敗 ${total.failed}、略過 ${total.skipped}；${total.requests} 次請求，` +
      `輸入 ${total.in}／輸出 ${total.out} tokens${cost}`);
    if (fatal) console.error(`翻譯中止：${logSafe(redact(fatal.message, key))}`);
  }

  saveCache(cacheFile, cache, new Set(units.map((u) => u.hash)));
  fs.mkdirSync(pubDir, { recursive: true });
  const summary = [];
  for (const lang of INFO_LANGS) {
    const warns = [];
    const doc = sanitizeInfo(buildLangDoc(source, lang, cache), { lang, warn: (w) => warns.push(w) });
    for (const w of warns.slice(0, 5)) console.warn(`  [${lang}] 注意：${logSafe(w)}`);
    const f = path.join(pubDir, `${lang}.json`);
    fs.writeFileSync(f + '.tmp', JSON.stringify(doc) + '\n');
    fs.renameSync(f + '.tmp', f);
    summary.push(`${lang} ${doc.sections.filter((s) => s.translated).length}/${doc.sections.length}`);
  }
  console.log(`已輸出 ${pubDir}/*.json（已翻譯區塊：${summary.join('、')}）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('接種資訊翻譯失敗：' + logSafe(e?.message || e));
    process.exit(1);
  });
}
