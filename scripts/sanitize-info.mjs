#!/usr/bin/env node
// 接種資訊專區資料（docs/INFO_SCHEMA.md：data/info/source.json、public/data/info/<lang>.json）的白名單清理與驗證。
// 來源是疾管署官網的 HTML，翻譯是機器產生，兩者都視為不可信：寫檔前、部署前都必須經過這裡。
//
// 原則（與 sanitize.mjs 相同）：
//   - 物件一律重新建立，只輸出契約內欄位；未知欄位、未知區塊型別丟棄。
//   - 文字：去除控制字元、bidi／零寬字元與 < >（前端只用 textContent，這是縱深防禦），限制長度。
//   - 網址：只接受 https、無帳密、無連接埠，且主機在允許清單（gov.tw、*.gov.tw、*.gov.taipei、
//     www.youtube.com、youtu.be；見 INFO_ALLOWED_HOSTS）；不合格的連結整筆丟棄，段落內的連結改為純文字。
//   - 日期：updated 為 ISO 日期（YYYY-MM-DD），fetchedAt／changedAt 為 ISO 時間且不晚於現在 + 1 小時。
//   - 結構性錯誤（非物件、數量超過上限、必要欄位不合格）→ 丟出例外，整份不予發布。
//
// 用法（命令列）：node scripts/sanitize-info.mjs --check <檔案…>   不合格（或清理後內容會改變）時結束代碼 1
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cleanHttpsUrl, cleanTimestamp } from './sanitize.mjs';

export const INFO_LANGS = Object.freeze(['zh-Hant', 'en', 'ja', 'ko', 'id', 'vi', 'th', 'tl']);
export const INFO_KEYS = Object.freeze(['coins', 'eligibility', 'where', 'precautions', 'brands', 'education', 'faq', 'news', 'other']);
export const INFO_SOURCE_URL = 'https://www.cdc.gov.tw/Category/MPage/S_ZLz0yyc2lAQ9TStMB0uA';
export const INFO_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024, // 單一語言檔上限（正常約 40–80 KB）
  sections: 60,
  blocks: 300,
  runs: 500,
  items: 500,
  rows: 300,
  cells: 12,
  links: 200,
  files: 200,
  title: 300,
  text: 10000, // p.text（整段）
  run: 3000,
  item: 3000,
  cell: 1000,
  short: 300, // caption、head、h、links/files 的 text
  note: 3000,
});
const TRANSLATION = new Set(['machine', 'source', 'partial']);

// eslint-disable-next-line no-control-regex
const STRIP_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB<>]/g;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 清理文字：空白類字元（含換行、全形空白）合併為一個空白、去除危險字元；trim 為 false 時保留前後空白（段落 runs 用） */
export function cleanInfoText(v, max, { trim = true } = {}) {
  if (typeof v !== 'string') return undefined;
  let s = v.replace(STRIP_RE, '').replace(/[\s\u00a0\u3000]+/g, ' ');
  if (trim) s = s.trim();
  if (s.length > max) s = [...s].slice(0, max).join('');
  return trim ? s.trim() : s;
}

/** 允許的主機（docs/INFO_SCHEMA.md「連結主機允許清單」，前端必須一致）：
 *  gov.tw、*.gov.tw、*.gov.taipei（臺北市政府）、www.youtube.com、youtu.be（疾管署官方影片）。
 *  短網址（reurl.cc 等）與 docs.google.com 不在清單內。 */
export const INFO_ALLOWED_HOSTS = Object.freeze(['gov.tw', '*.gov.tw', '*.gov.taipei', 'www.youtube.com', 'youtu.be']);
export function isAllowedInfoHost(hostname) {
  const host = String(hostname).toLowerCase();
  return INFO_ALLOWED_HOSTS.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));
}

/** 連結白名單：https、無帳密、無連接埠、主機在 INFO_ALLOWED_HOSTS。回傳正規化後的網址或 undefined */
export function cleanInfoHref(v) {
  const s = cleanHttpsUrl(v);
  if (!s) return undefined;
  let u;
  try { u = new URL(s); } catch { return undefined; }
  if (u.port) return undefined;
  if (!isAllowedInfoHost(u.hostname)) return undefined;
  return u.href.length <= 500 ? u.href : undefined;
}

/** ISO 日期（YYYY-MM-DD），須為實際存在的日期且在 2020–2100 之間 */
export function cleanIsoDate(v) {
  if (typeof v !== 'string') return undefined;
  const m = DATE_RE.exec(v);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2020 || y > 2100 || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return undefined;
  return v;
}

function arr(v, max, what) {
  if (!Array.isArray(v)) throw new Error(`${what} 不是陣列`);
  if (v.length > max) throw new Error(`${what} 有 ${v.length} 筆，超過上限 ${max}`);
  return v;
}

/** 清理一個正文區塊；不合格回傳 null（由呼叫端記錄） */
export function sanitizeBlock(b, warn = () => {}) {
  if (!isPlainObject(b)) { warn('區塊不是物件'); return null; }
  switch (b.type) {
    case 'p': {
      const runs = [];
      for (const r of arr(b.runs, INFO_LIMITS.runs, 'runs')) {
        if (!isPlainObject(r)) continue;
        const text = cleanInfoText(r.text, INFO_LIMITS.run, { trim: false });
        if (!text) continue;
        const o = { text };
        if (r.href !== undefined) {
          const href = cleanInfoHref(r.href);
          if (href) o.href = href; else warn(`段落連結不在允許清單，改為純文字：${String(r.href).slice(0, 80)}`);
        }
        // 相鄰且連結相同的片段合併
        const last = runs[runs.length - 1];
        if (last && last.href === o.href) last.text += o.text; else runs.push(o);
      }
      // 去掉整段前後的空白（只剩空白的首尾片段整個移除）
      let kept = runs;
      for (;;) {
        kept = kept.filter((r) => r.text !== '');
        if (!kept.length) break;
        const a = kept[0].text.replace(/^\s+/, '');
        const z = kept[kept.length - 1].text.replace(/\s+$/, '');
        if (a === kept[0].text && z === kept[kept.length - 1].text) break;
        kept[0].text = a;
        kept[kept.length - 1].text = kept.length === 1 ? a.replace(/\s+$/, '') : z;
      }
      const text = kept.map((r) => r.text).join('');
      if (!text.trim()) return null;
      if (text.length > INFO_LIMITS.text) throw new Error(`段落長度 ${text.length} 超過上限 ${INFO_LIMITS.text}`);
      return { type: 'p', text, runs: kept };
    }
    case 'list': {
      const items = [];
      const levels = [];
      const srcLevels = Array.isArray(b.levels) ? b.levels : null;
      arr(b.items, INFO_LIMITS.items, 'items').forEach((it, i) => {
        const s = cleanInfoText(it, INFO_LIMITS.item);
        if (!s) return;
        items.push(s);
        const lv = srcLevels?.[i];
        levels.push(Number.isSafeInteger(lv) && lv >= 0 && lv <= 5 ? lv : 0);
      });
      if (!items.length) return null;
      const o = { type: 'list', ordered: b.ordered === true, items };
      if (levels.some((x) => x > 0)) o.levels = levels; // 巢狀清單的層級（選填；0 = 最外層）
      return o;
    }
    case 'table': {
      const o = { type: 'table' };
      const cap = cleanInfoText(b.caption, INFO_LIMITS.short);
      if (cap) o.caption = cap;
      if (b.head !== undefined) {
        const head = arr(b.head, INFO_LIMITS.cells, 'head').map((c) => cleanInfoText(c, INFO_LIMITS.short) ?? '');
        if (head.some((c) => c)) o.head = head;
      }
      const rows = [];
      for (const r of arr(b.rows, INFO_LIMITS.rows, 'rows')) {
        const row = arr(r, INFO_LIMITS.cells, 'row').map((c) => cleanInfoText(c, INFO_LIMITS.cell) ?? '');
        if (row.some((c) => c)) rows.push(row);
      }
      if (!rows.length) return null;
      o.rows = rows;
      return o;
    }
    case 'h': {
      const text = cleanInfoText(b.text, INFO_LIMITS.short);
      if (!text) return null;
      const level = Number.isSafeInteger(b.level) && b.level >= 2 && b.level <= 6 ? b.level : 4;
      return { type: 'h', level, text };
    }
    case 'note': {
      const text = cleanInfoText(b.text, INFO_LIMITS.note);
      return text ? { type: 'note', text } : null;
    }
    default:
      warn(`未知的區塊型別 ${JSON.stringify(String(b.type)).slice(0, 30)}，已略過`);
      return null;
  }
}

function sanitizeLinkList(list, max, what, isFile, warn) {
  const out = [];
  for (const l of arr(list ?? [], max, what)) {
    if (!isPlainObject(l)) continue;
    const text = cleanInfoText(l.text, INFO_LIMITS.short);
    const href = cleanInfoHref(l.href);
    if (!text || !href) { warn(`${what} 捨棄（文字空白或網址不在允許清單）：${String(l.href).slice(0, 80)}`); continue; }
    const o = { text, href };
    if (isFile) o.ext = typeof l.ext === 'string' && /^[a-z0-9]{1,5}$/.test(l.ext) ? l.ext : '';
    o.isNew = l.isNew === true;
    out.push(o);
  }
  return out;
}

/** 清理一個區塊（section）；必要欄位不合格丟出例外 */
export function sanitizeSection(s, warn = () => {}) {
  if (!isPlainObject(s)) throw new Error('section 不是物件');
  const id = typeof s.id === 'string' && /^\d{1,12}$/.test(s.id) ? s.id : null;
  if (!id) throw new Error(`section id 不合格：${String(s.id).slice(0, 20)}`);
  const key = INFO_KEYS.includes(s.key) ? s.key : 'other';
  const hash = typeof s.hash === 'string' && /^sha256:[0-9a-f]{64}$/.test(s.hash) ? s.hash : null;
  if (!hash) throw new Error(`section ${id} 的 hash 不合格`);
  const title = cleanInfoText(s.title, INFO_LIMITS.title);
  if (!title) throw new Error(`section ${id} 沒有標題`);
  const o = { id, key, hash, title };
  if (s.updated !== undefined) {
    const u = cleanIsoDate(s.updated);
    if (u) o.updated = u; else warn(`section ${id} 的 updated 不是 ISO 日期，已略過`);
  }
  o.translated = s.translated === true;
  o.blocks = [];
  for (const b of arr(s.blocks ?? [], INFO_LIMITS.blocks, `section ${id} blocks`)) {
    const c = sanitizeBlock(b, (m) => warn(`section ${id}：${m}`));
    if (c) o.blocks.push(c);
  }
  o.links = sanitizeLinkList(s.links, INFO_LIMITS.links, `section ${id} links`, false, warn);
  o.files = sanitizeLinkList(s.files, INFO_LIMITS.files, `section ${id} files`, true, warn);
  return o;
}

/**
 * 清理整份接種資訊檔（source.json 或 <lang>.json）；結構性錯誤丟出例外。
 * @param {object} d
 * @param {{ now?: number, warn?: (msg:string)=>void, lang?: string }} [opts] lang：若指定，meta.lang 必須相符
 */
export function sanitizeInfo(d, { now = Date.now(), warn = () => {}, lang } = {}) {
  if (!isPlainObject(d)) throw new Error('資料不是物件');
  const m = isPlainObject(d.meta) ? d.meta : null;
  if (!m) throw new Error('缺少 meta');
  if (!INFO_LANGS.includes(m.lang)) throw new Error(`meta.lang 不合格：${String(m.lang).slice(0, 20)}`);
  if (lang && m.lang !== lang) throw new Error(`meta.lang 為 ${m.lang}，預期 ${lang}`);
  const sourceUrl = cleanInfoHref(m.sourceUrl);
  if (!sourceUrl) throw new Error('meta.sourceUrl 不合格');
  const sourceTitle = cleanInfoText(m.sourceTitle, INFO_LIMITS.title);
  if (!sourceTitle) throw new Error('meta.sourceTitle 不合格');
  const title = cleanInfoText(m.title, INFO_LIMITS.title) || sourceTitle;
  const fetchedAt = cleanTimestamp(m.fetchedAt, now);
  if (!fetchedAt) throw new Error(`meta.fetchedAt 不合格：${String(m.fetchedAt).slice(0, 40)}`);
  const changedAt = cleanTimestamp(m.changedAt, now);
  if (!changedAt) throw new Error(`meta.changedAt 不合格：${String(m.changedAt).slice(0, 40)}`);
  if (!TRANSLATION.has(m.translation)) throw new Error(`meta.translation 不合格：${String(m.translation).slice(0, 20)}`);
  const meta = { lang: m.lang, sourceUrl, sourceTitle, title, fetchedAt, changedAt, translation: m.translation };
  if (m.translatedAt !== undefined) {
    const t = cleanTimestamp(m.translatedAt, now);
    if (t) meta.translatedAt = t; else warn('meta.translatedAt 不合格，已略過');
  }
  const sections = [];
  const ids = new Set();
  for (const s of arr(d.sections, INFO_LIMITS.sections, 'sections')) {
    const c = sanitizeSection(s, warn);
    if (ids.has(c.id)) throw new Error(`section id ${c.id} 重複`);
    ids.add(c.id);
    sections.push(c);
  }
  if (!sections.length) throw new Error('沒有任何 section');
  return { meta, sections };
}

/** 找出兩個 JSON 值第一個不同的位置（驗證訊息用） */
function firstDiff(a, b, p = '$') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null || typeof a !== 'object') {
    return `${p}：${JSON.stringify(a)?.slice(0, 60)} → ${JSON.stringify(b)?.slice(0, 60)}`;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  if (Array.isArray(a) && a.length !== b.length) return `${p}：長度 ${a.length} → ${b.length}`;
  for (const k of keys) {
    if (!(k in b)) return `${p}.${k}：會被移除`;
    if (!(k in a)) return `${p}.${k}：會被加入`;
    const d = firstDiff(a[k], b[k], `${p}.${k}`);
    if (d) return d;
  }
  if (JSON.stringify(Object.keys(a)) !== JSON.stringify(Object.keys(b))) return `${p}：欄位順序不同`;
  return null;
}

/**
 * 嚴格驗證：檔案必須「已是清理後的樣子」（清理不會改變任何內容）。回傳錯誤訊息陣列，空陣列 = 合格。
 * 用於部署前檢查、測試；harvest／translate 產生的檔案本身就是 sanitizeInfo 的輸出，所以必然合格。
 */
export function validateInfo(d, opts = {}) {
  let clean;
  const warns = [];
  try {
    clean = sanitizeInfo(d, { ...opts, warn: (w) => warns.push(w) });
  } catch (e) {
    return [e.message];
  }
  const diff = firstDiff(d, clean);
  return diff ? [`內容未通過清理（${diff}）`, ...warns.slice(0, 5)] : [];
}

/** 讀檔並驗證（含大小上限）；回傳 { data, errors } */
export function readInfoFile(file, opts = {}) {
  try {
    const st = fs.statSync(file);
    if (st.size > INFO_LIMITS.maxBytes) return { data: null, errors: [`檔案過大（${st.size} bytes）`] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { data, errors: validateInfo(data, opts) };
  } catch (e) {
    return { data: null, errors: [String(e?.message || e)] };
  }
}

const logSafe = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] !== '--check' || args.length < 2) {
    console.error('用法：node scripts/sanitize-info.mjs --check <檔案…>');
    process.exit(2);
  }
  let bad = 0;
  for (const f of args.slice(1)) {
    const base = f.split('/').pop().replace(/\.json$/, '');
    const { errors } = readInfoFile(f, INFO_LANGS.includes(base) ? { lang: base } : {});
    if (errors.length) { bad++; console.error(`✗ ${logSafe(f)}：${errors.map(logSafe).join('；')}`); } else console.log(`✓ ${logSafe(f)}`);
  }
  process.exit(bad ? 1 : 0);
}
