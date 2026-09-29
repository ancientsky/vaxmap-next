#!/usr/bin/env node
// 擷取疾管署「疫苗接種專區」頁面（MPage 手風琴，每張 div.card 一個主題）→ 結構化 → data/info/source.json（繁中）。
// 格式契約見 docs/INFO_SCHEMA.md，流程說明見 docs/INFO_PIPELINE.md。
//
// 用法：node scripts/harvest-info.mjs              抓取線上頁面
//       node scripts/harvest-info.mjs --file x.html 解析本機檔案（離線測試用）
// 輸出：最後一行印出 "changed" 或 "unchanged"（內容與上一版 source.json 相同；僅 meta.fetchedAt 會更新），結束代碼 0。
//       頁面無法取得、結構異常、區塊太少 → 結束代碼 1，不寫任何檔案。
// 環境變數：
//   INFO_URL       來源網址（預設為疾管署專區頁；只接受 https，測試時可用 http://127.0.0.1）
//   INFO_OUT_DIR   輸出資料夾（預設 data/info）
//   INFO_MIN_SECTIONS  最少應解析出的區塊數，低於此數視為頁面結構改變（預設 5）
//   INFO_TIMEOUT_MS／INFO_RETRY_MS  單次請求逾時（預設 30000）與重試間隔（預設 2000，共試 3 次）
//   HARVEST_UA     User-Agent
//
// 解析器：不引入第三方套件，以 Node 內建功能實作一個小型、容錯的 HTML 斷詞＋建樹器。只取白名單內的
// 結構（段落、清單、表格、標題、紅字備註、連結、附件），script／style／iframe／表單等整段丟棄，屬性只讀
// href、class、id、style、title、color，所以 on* 事件屬性、javascript: 網址等不會進入輸出。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sanitizeInfo, cleanInfoHref, INFO_SOURCE_URL, INFO_LIMITS, INFO_ALLOWED_HOSTS } from './sanitize-info.mjs';

const MAX_RESPONSE_BYTES = 3 * 1024 * 1024; // 正常約 270 KB
const MAX_NODES = 200000;
const TIMEOUT_MS = Number(process.env.INFO_TIMEOUT_MS ?? 30000);
const RETRY_MS = Number(process.env.INFO_RETRY_MS ?? 2000);
const SITE = 'https://www.cdc.gov.tw/'; // 相對網址一律以正式站解析（不論實際抓取的網址）
const logSafe = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);

/* ------------------------------------------------------------------ *
 * HTML 斷詞與建樹
 * ------------------------------------------------------------------ */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen']);
// 內容為原始文字的元素：直接跳到結束標籤，內容丟棄
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template', 'iframe', 'noembed', 'noframes', 'plaintext']);
const BLOCKISH = new Set(['p', 'div', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'dl', 'hr', 'section', 'article', 'header', 'footer', 'form', 'figure', 'address', 'nav', 'aside', 'main']);
const KEEP_ATTRS = new Set(['href', 'class', 'id', 'style', 'title', 'color']);
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', middot: '·', bull: '•', times: '×', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', le: '≤', ge: '≥', rarr: '→', larr: '←', uarr: '↑', darr: '↓', yen: '¥',
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});?/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function parseAttrs(src, start) {
  // 回傳 { attrs, end }，end 指向 '>' 之後
  const attrs = Object.create(null);
  let i = start;
  const n = src.length;
  while (i < n) {
    while (i < n && /[\s/]/.test(src[i])) i++;
    if (i >= n) break;
    if (src[i] === '>') return { attrs, end: i + 1 };
    let j = i;
    while (j < n && !/[\s=>/]/.test(src[j])) j++;
    const name = src.slice(i, j).toLowerCase();
    i = j;
    while (i < n && /\s/.test(src[i])) i++;
    let value = '';
    if (src[i] === '=') {
      i++;
      while (i < n && /\s/.test(src[i])) i++;
      const q = src[i];
      if (q === '"' || q === "'") {
        const k = src.indexOf(q, i + 1);
        const e = k < 0 ? n : k;
        value = src.slice(i + 1, e);
        i = e + 1;
      } else {
        j = i;
        while (j < n && !/[\s>]/.test(src[j])) j++;
        value = src.slice(i, j);
        i = j;
      }
    }
    if (name && KEEP_ATTRS.has(name) && !(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return { attrs, end: n };
}

/** 容錯的 HTML → 樹（{ tag, attrs, children, parent } 與文字節點 { text }） */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: Object.create(null), children: [], parent: null };
  let cur = root;
  let i = 0;
  let count = 0;
  const n = html.length;
  const add = (node) => {
    if (++count > MAX_NODES) throw new Error(`HTML 節點數超過上限 ${MAX_NODES}`);
    node.parent = cur;
    cur.children.push(node);
  };
  const closeTo = (pred, stop) => {
    for (let e = cur; e && e !== root; e = e.parent) {
      if (stop && stop.has(e.tag)) return false;
      if (pred(e)) { cur = e.parent; return true; }
    }
    return false;
  };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { add({ text: html.slice(i) }); break; }
    if (lt > i) add({ text: html.slice(i, lt) });
    i = lt;
    if (html.startsWith('<!--', i)) {
      const e = html.indexOf('-->', i + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const e = html.indexOf('>', i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const close = /^<\/([a-zA-Z][\w:-]*)[^>]*>?/.exec(html.slice(i, i + 200));
    if (close) {
      const tag = close[1].toLowerCase();
      i += close[0].length;
      if (tag === 'br') { add({ tag: 'br', attrs: Object.create(null), children: [] }); continue; }
      closeTo((e) => e.tag === tag);
      continue;
    }
    const open = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i, i + 100));
    if (!open) { add({ text: '<' }); i++; continue; }
    const tag = open[1].toLowerCase();
    const { attrs, end } = parseAttrs(html, i + open[0].length);
    const selfClosing = html[end - 2] === '/';
    i = end;
    if (RAW.has(tag)) {
      const re = new RegExp(`</${tag}\\s*>`, 'ig');
      re.lastIndex = i;
      const m = re.exec(html);
      i = m ? m.index + m[0].length : n;
      continue; // 內容整段丟棄
    }
    // 隱含的結束標籤
    if (BLOCKISH.has(tag) && cur.tag === 'p') cur = cur.parent;
    if (tag === 'li') closeTo((e) => e.tag === 'li', new Set(['ul', 'ol', 'table']));
    if (tag === 'tr') closeTo((e) => e.tag === 'tr', new Set(['table', 'thead', 'tbody', 'tfoot']));
    if (tag === 'td' || tag === 'th') closeTo((e) => e.tag === 'td' || e.tag === 'th', new Set(['tr', 'table']));
    if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') closeTo((e) => ['thead', 'tbody', 'tfoot'].includes(e.tag), new Set(['table']));
    if (tag === 'dt' || tag === 'dd') closeTo((e) => e.tag === 'dt' || e.tag === 'dd', new Set(['dl']));
    const node = { tag, attrs, children: [] };
    add(node);
    if (!VOID.has(tag) && !selfClosing) cur = node;
  }
  return root;
}

const classes = (el) => (el.attrs?.class || '').split(/\s+/).filter(Boolean);
const hasClass = (el, c) => classes(el).includes(c);
function* walkEls(el) {
  for (const c of el.children || []) {
    if (c.tag) { yield c; yield* walkEls(c); }
  }
}
const find = (el, pred) => { for (const e of walkEls(el)) if (pred(e)) return e; return null; };
const findAll = (el, pred) => [...walkEls(el)].filter(pred);
const ws = (s) => s.replace(/[\s\u00a0\u3000\u2002\u2003\u2009]+/g, ' ');
/** 元素的純文字（br → 空白），空白合併 */
export function textOf(el, { skip } = {}) {
  let out = '';
  const rec = (e) => {
    for (const c of e.children || []) {
      if (c.text !== undefined) out += decodeEntities(c.text);
      else if (c.tag === 'br') out += ' ';
      else if (!DROP.has(c.tag) && !(skip && skip(c))) rec(c);
    }
  };
  rec(el);
  return ws(out).trim();
}

/* ------------------------------------------------------------------ *
 * 卡片 → 結構化區塊
 * ------------------------------------------------------------------ */
// 整段丟棄的元素（除了 RAW 以外）：嵌入物、表單、圖片、媒體
const DROP = new Set(['svg', 'math', 'object', 'embed', 'form', 'button', 'input', 'select', 'option', 'img', 'video', 'audio', 'canvas', 'map', 'picture', 'head', 'link', 'meta', 'base']);
const INLINE = new Set(['span', 'font', 'em', 'i', 'u', 'sup', 'sub', 'small', 'big', 'abbr', 'cite', 'code', 'mark', 'q', 's', 'del', 'ins', 'label', 'time', 'bdi', 'bdo', 'nobr']);
const RED_RE = /(?:^|;)\s*color\s*:\s*(?:red\b|#f00\b|#ff0000\b|rgba?\(\s*255\s*,\s*0\s*,\s*0\b)/i;
const isRed = (el) => RED_RE.test(el.attrs?.style || '') || /^(red|#f00|#ff0000)$/i.test(el.attrs?.color || '') || hasClass(el, 'red') || hasClass(el, 'text-danger');
const H_MAX = 40; // 整行粗體且不超過此長度 → 視為小標題
const URL_IN_TEXT = /https:\/\/[^\s<>"'，。、）)】]+/g;

/** 表格儲存格的符號統一：來源用 ●／✖，契約用 ✓／✗ */
export function normalizeCell(s) {
  const t = s.trim();
  if (/^[●◎✓✔Ｖ]$/.test(t)) return '✓';
  if (/^[✖✕✗×Ｘ]$/.test(t)) return '✗';
  if (/^[○◯]$/.test(t)) return '○';
  if (/^[●✓✔]\s*\S/.test(t)) return '✓ ' + t.slice(1).trim();
  return t;
}

export function resolveHref(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let u;
  try { u = new URL(raw.trim(), SITE); } catch { return undefined; }
  return cleanInfoHref(u.href);
}

function convertBody(nodes, stats) {
  const blocks = [];
  let line = [];
  const pushRun = (text, fmt) => {
    if (!text) return;
    // 文字中的裸網址（例如「民眾常見問答」卡片）轉成連結片段
    if (!fmt.href && text.includes('https://')) {
      let last = 0;
      for (const m of text.matchAll(URL_IN_TEXT)) {
        if (m.index > last) line.push({ text: text.slice(last, m.index), ...fmt });
        const href = resolveHref(m[0]);
        line.push({ text: m[0], ...fmt, href });
        last = m.index + m[0].length;
      }
      if (last < text.length) line.push({ text: text.slice(last), ...fmt });
      return;
    }
    line.push({ text, ...fmt });
  };
  const flush = () => {
    const content = line.filter((r) => ws(r.text).trim());
    const allRed = content.length > 0 && content.every((r) => r.red);
    const allBold = content.length > 0 && content.every((r) => r.bold);
    const runs = [];
    for (const r of line) {
      const text = ws(r.text);
      const last = runs[runs.length - 1];
      if (last && last.href === r.href) last.text += text; else runs.push({ text, href: r.href });
    }
    // 全形標點前後的空白（來源的 &nbsp;）去掉
    for (const r of runs) r.text = r.text.replace(/([、，。：；！？）】」』])\s+/g, '$1').replace(/\s+([、，。：；！？（【「『])/g, '$1');
    line = [];
    const full = ws(runs.map((r) => r.text).join('')).trim();
    if (!full) return;
    const hasLink = runs.some((r) => r.href);
    if (!hasLink && allRed) { blocks.push({ type: 'note', text: full }); return; }
    if (!hasLink && allBold && full.length <= H_MAX) {
      blocks.push({ type: 'h', level: 4, text: full.replace(/^[▲△■□◆◇●★☆]\s*/, '') });
      return;
    }
    blocks.push({ type: 'p', runs: runs.map((r) => (r.href ? { text: r.text, href: r.href } : { text: r.text })) });
  };
  const walk = (node, fmt) => {
    if (node.text !== undefined) { pushRun(decodeEntities(node.text), fmt); return; }
    const tag = node.tag;
    if (DROP.has(tag)) return;
    if (tag === 'br' || tag === 'hr') { flush(); return; }
    if (tag === 'a') {
      const href = resolveHref(node.attrs.href);
      if (node.attrs.href && !href) stats.droppedHrefs.push(String(node.attrs.href).slice(0, 120));
      for (const c of node.children) walk(c, { ...fmt, href: fmt.href || href });
      return;
    }
    if (tag === 'strong' || tag === 'b') { for (const c of node.children) walk(c, { ...fmt, bold: true }); return; }
    if (INLINE.has(tag)) { const f = isRed(node) ? { ...fmt, red: true } : fmt; for (const c of node.children) walk(c, f); return; }
    if (/^h[1-6]$/.test(tag)) {
      flush();
      const text = textOf(node);
      if (text) blocks.push({ type: 'h', level: Math.min(6, Math.max(3, Number(tag[1]) + 1)), text });
      return;
    }
    if (tag === 'ul' || tag === 'ol') { flush(); const b = convertList(node); if (b) blocks.push(b); return; }
    if (tag === 'table') {
      flush();
      const t = convertTable(node);
      if (!t) return;
      // 表格前緊接的小標題作為表格標題（例如「▲2026/10/01起 第一階段對象」）
      const prev = blocks[blocks.length - 1];
      if (!t.caption && prev?.type === 'h') { blocks.pop(); t.caption = prev.text; }
      blocks.push(t);
      return;
    }
    if (tag === 'div' && (hasClass(node, 'download') || hasClass(node, 'date'))) return; // 由區塊層處理
    // 其他容器（p、div、section、font…）：前後斷行
    const f = isRed(node) ? { ...fmt, red: true } : fmt;
    const block = !INLINE.has(tag);
    if (block) flush();
    for (const c of node.children) walk(c, f);
    if (block) flush();
  };
  for (const n of nodes) walk(n, { bold: false, red: false });
  flush();
  // 「說明文字」下一行是裸網址（例如「季節性流感疫苗Q&A」＋網址）→ 合併成一個連結段落
  const out = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    const rs = b.type === 'p' ? b.runs.filter((r) => r.text.trim()) : [];
    const only = rs.length === 1 && rs[0].href && rs[0].text.trim() === rs[0].href;
    if (only && prev?.type === 'p' && prev.runs.every((r) => !r.href) && prev.runs.map((r) => r.text).join('').trim().length <= 60) {
      out[out.length - 1] = { type: 'p', runs: [{ text: prev.runs.map((r) => r.text).join('').trim(), href: rs[0].href }] };
    } else out.push(b);
  }
  return out;
}

function convertList(el) {
  const items = [];
  const levels = [];
  const rec = (list, depth) => {
    for (const c of list.children) {
      if (!c.tag) continue;
      if (c.tag === 'ul' || c.tag === 'ol') { rec(c, depth + 1); continue; }
      if (c.tag !== 'li') continue;
      const indent = /margin-left\s*:\s*(\d+)/i.exec(c.attrs.style || '');
      const lv = depth + (indent && Number(indent[1]) >= 20 ? 1 : 0);
      const text = textOf(c, { skip: (e) => e.tag === 'ul' || e.tag === 'ol' || e.tag === 'table' });
      if (text) { items.push(text); levels.push(Math.min(5, lv)); }
      for (const sub of c.children) if (sub.tag === 'ul' || sub.tag === 'ol') rec(sub, lv + 1);
    }
  };
  rec(el, 0);
  if (!items.length) return null;
  const b = { type: 'list', ordered: el.tag === 'ol', items };
  if (levels.some((x) => x > 0)) b.levels = levels;
  return b;
}

function convertTable(el) {
  const rows = [];
  let head = null;
  const cap = find(el, (e) => e.tag === 'caption');
  const trs = findAll(el, (e) => e.tag === 'tr');
  for (const tr of trs) {
    // 只取這張表的列（不含巢狀表格）
    let p = tr.parent;
    while (p && p.tag !== 'table') p = p.parent;
    if (p !== el) continue;
    const cells = tr.children.filter((c) => c.tag === 'td' || c.tag === 'th');
    if (!cells.length) continue;
    const texts = cells.map((c) => normalizeCell(textOf(c)));
    const inThead = tr.parent?.tag === 'thead';
    if (!head && !rows.length && (inThead || cells.every((c) => c.tag === 'th'))) head = texts;
    else rows.push(texts);
  }
  if (!rows.length) return null;
  const t = { type: 'table' };
  const caption = cap ? textOf(cap) : '';
  if (caption) t.caption = caption;
  if (head) t.head = head;
  t.rows = rows;
  return t;
}

function convertDownload(div, stats, out) {
  const h = find(div, (e) => /^h[1-6]$/.test(e.tag));
  const kind = h ? textOf(h) : '';
  for (const p of div.children.filter((c) => c.tag === 'p' || c.tag === 'li' || c.tag === 'div')) {
    const a = find(p, (e) => e.tag === 'a');
    if (!a) continue;
    const href = resolveHref(a.attrs.href);
    if (!href) { stats.droppedHrefs.push(String(a.attrs.href || '').slice(0, 120)); continue; }
    const isNew = findAll(p, (e) => e.tag === 'span').some((s) => /^new$/i.test(textOf(s)));
    let text = textOf(a)
      .replace(/\s*Facebook分享至Facebook.*$/, '') // 來源標題偶爾夾帶分享列文字
      .trim();
    const isFile = /附件|檔案/.test(kind) || (!/連結/.test(kind) && /\/File\/Get\//i.test(href));
    if (isFile) {
      const m = /\.([a-z0-9]{1,5})(?:\s*[(（]另開新?視窗[)）])?\s*$/i.exec(a.attrs.title || '') || /\.([a-z0-9]{1,5})$/i.exec(text);
      const ext = m ? m[1].toLowerCase() : '';
      if (ext) text = text.replace(new RegExp(`\\.${ext}$`, 'i'), '');
      out.files.push({ text, href, ext, isNew });
    } else {
      out.links.push({ text, href, isNew });
    }
  }
}

function parseDate(s) {
  const m = /(\d{3,4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/.exec(s || '');
  if (!m) return undefined;
  let y = Number(m[1]);
  if (y < 1000) y += 1911; // 民國年
  return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

// 主題代碼：依序比對標題關鍵字（見 docs/INFO_SCHEMA.md）
const KEY_RULES = [
  ['coins', /健康幣/],
  ['eligibility', /接種對象/],
  ['where', /哪裡可以接種|接種地點|接種站/],
  ['precautions', /注意事項|接種須知/],
  ['brands', /廠牌/],
  ['faq', /常見問答|Q\s*&\s*A|問與答/i],
  ['news', /新聞稿/],
  ['education', /衛教|宣導/],
];
export const classifyTitle = (title) => (KEY_RULES.find(([, re]) => re.test(title)) || ['other'])[0];

/** 翻譯的單位：只有要翻譯的文字與結構，不含網址、日期、New 標記。雜湊與翻譯快取都以此為準。 */
export function projectSection(s) {
  return {
    title: s.title,
    blocks: s.blocks.map((b) => {
      switch (b.type) {
        case 'p': return { type: 'p', runs: b.runs.map((r) => ({ text: r.text })) };
        case 'list': return { type: 'list', items: [...b.items] };
        case 'table': {
          const o = { type: 'table' };
          if (b.caption !== undefined) o.caption = b.caption;
          if (b.head !== undefined) o.head = [...b.head];
          o.rows = b.rows.map((r) => [...r]);
          return o;
        }
        default: return { type: b.type, text: b.text };
      }
    }),
    links: s.links.map((l) => ({ text: l.text })),
    files: s.files.map((f) => ({ text: f.text })),
  };
}
export const hashSection = (s) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(projectSection(s))).digest('hex');

/**
 * 解析整頁 HTML → { sourceTitle, sections, stats }（sections 已清理並附 hash；尚未含 meta）
 */
export function parseInfoPage(html) {
  const root = parseHtml(html);
  const stats = { droppedHrefs: [], cards: 0 };
  const h2 = find(root, (e) => e.tag === 'h2' && hasClass(e, 'con-title'));
  let sourceTitle = h2 ? textOf(h2) : '';
  if (!sourceTitle) {
    const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
    sourceTitle = t ? ws(decodeEntities(t[1])).replace(/\s*-\s*衛生福利部疾病管制署\s*$/, '').trim() : '';
  }
  const cards = findAll(root, (e) => e.tag === 'div' && hasClass(e, 'card'));
  stats.cards = cards.length;
  const sections = [];
  for (const card of cards) {
    const idEl = find(card, (e) => /^(?:collapseOne|headingOne)\d+$/.test(e.attrs.id || ''));
    const id = idEl ? /\d+$/.exec(idEl.attrs.id)[0] : null;
    const titleEl = find(card, (e) => hasClass(e, 'card-title'));
    const wordEl = titleEl && find(titleEl, (e) => hasClass(e, 'word'));
    const title = wordEl ? textOf(wordEl) : titleEl ? textOf(titleEl).replace(/\s*New$/i, '') : '';
    const body = find(card, (e) => hasClass(e, 'card-body'));
    if (!id || !title || !body) continue;
    const dateEl = find(body, (e) => e.tag === 'div' && hasClass(e, 'date'));
    const out = { links: [], files: [] };
    for (const d of findAll(body, (e) => e.tag === 'div' && hasClass(e, 'download'))) convertDownload(d, stats, out);
    // 同一區塊內重複的連結（來源常見）只留第一筆
    const dedupe = (list) => { const seen = new Set(); return list.filter((l) => !seen.has(l.href + '\n' + l.text) && seen.add(l.href + '\n' + l.text)); };
    const s = {
      id,
      key: classifyTitle(title),
      hash: '',
      title,
      updated: dateEl ? parseDate(textOf(dateEl)) : undefined,
      translated: true,
      blocks: convertBody(body.children, stats),
      links: dedupe(out.links),
      files: dedupe(out.files),
    };
    if (s.updated === undefined) delete s.updated;
    sections.push(s);
  }
  return { sourceTitle, sections, stats };
}

/**
 * 解析＋清理＋比對上一版，產生 source.json 內容。
 * @returns {{ doc: object, changed: boolean, stats: object, warnings: string[] }}
 */
export function buildSource(html, { prev = null, now = new Date(), minSections = 5 } = {}) {
  const { sourceTitle, sections, stats } = parseInfoPage(html);
  if (!sourceTitle) throw new Error('找不到頁面標題（h2.con-title），頁面結構可能已改變');
  if (sections.length < minSections) {
    throw new Error(`只解析出 ${sections.length} 個區塊（div.card ${stats.cards} 個），低於門檻 ${minSections}，頁面結構可能已改變`);
  }
  const warnings = [];
  const fetchedAt = now.toISOString();
  // 先清理（清理可能改變文字，例如去掉 < >），再以清理後的內容計算雜湊
  const draft = sanitizeInfo({
    meta: { lang: 'zh-Hant', sourceUrl: INFO_SOURCE_URL, sourceTitle, title: sourceTitle, fetchedAt, changedAt: fetchedAt, translation: 'source' },
    sections: sections.map((s) => ({ ...s, hash: 'sha256:' + '0'.repeat(64) })),
  }, { warn: (w) => warnings.push(w), now: now.getTime() });
  for (const s of draft.sections) s.hash = hashSection(s);

  const strip = (d) => JSON.stringify({ t: d.meta.sourceTitle, s: d.sections });
  const changed = !prev || strip(prev) !== strip(draft);
  if (!changed) draft.meta.changedAt = prev.meta.changedAt;
  else if (!prev) {
    // 第一次：以各區塊「最後更新日期」的最大值（臺北時間當天 00:00）為變動時間
    const max = draft.sections.map((s) => s.updated).filter(Boolean).sort().pop();
    draft.meta.changedAt = max ? new Date(`${max}T00:00:00+08:00`).toISOString() : fetchedAt;
  }
  return { doc: draft, changed, stats, warnings };
}

/* ------------------------------------------------------------------ *
 * 抓取
 * ------------------------------------------------------------------ */
async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) { await res.body?.cancel(); throw new Error(`回應過大（${len} bytes，超過上限 ${max}）`); }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); throw new Error(`回應過大（超過上限 ${max} bytes）`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchPage(url, { ua } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('INFO_URL 不是合法網址'); }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('INFO_URL 必須是 https');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(u, {
        headers: { 'User-Agent': ua, Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const final = new URL(res.url || u);
      if (final.protocol !== 'https:' && !local) { await res.body?.cancel(); throw new Error('被轉址到非 https 網址'); }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
      return await readCapped(res, MAX_RESPONSE_BYTES);
    } catch (e) {
      lastErr = e;
      if (/上限|https/.test(e?.message)) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, RETRY_MS * (attempt + 1)));
    }
  }
  throw lastErr;
}

function loadPrev(file) {
  try {
    if (!fs.existsSync(file)) return null;
    if (fs.statSync(file).size > INFO_LIMITS.maxBytes) return null;
    return sanitizeInfo(JSON.parse(fs.readFileSync(file, 'utf8')), { lang: 'zh-Hant' });
  } catch (e) {
    console.warn(`上一版 source.json 無法使用（視為第一次）：${logSafe(e?.message || e)}`);
    return null;
  }
}

async function main() {
  const outDir = process.env.INFO_OUT_DIR || 'data/info';
  const outFile = path.join(outDir, 'source.json');
  const minSections = Number(process.env.INFO_MIN_SECTIONS ?? 5);
  const ua = process.env.HARVEST_UA || 'vaxmap-next-info-harvester/1.0 (scheduled; twice daily)';
  const args = process.argv.slice(2);
  let html;
  if (args[0] === '--file') {
    if (!args[1]) throw new Error('用法：--file <html 檔>');
    if (fs.statSync(args[1]).size > MAX_RESPONSE_BYTES) throw new Error('檔案過大');
    html = fs.readFileSync(args[1], 'utf8');
    console.log(`來源檔案 ${logSafe(args[1])}`);
  } else {
    const url = process.env.INFO_URL || INFO_SOURCE_URL;
    console.log(`來源 ${logSafe(url)}`);
    html = await fetchPage(url, { ua });
  }
  const prev = loadPrev(outFile);
  const { doc, changed, stats, warnings } = buildSource(html, { prev, minSections });
  for (const w of warnings.slice(0, 20)) console.warn('  注意：' + logSafe(w));
  if (stats.droppedHrefs.length) {
    const hosts = {};
    for (const h of stats.droppedHrefs) { let k; try { k = new URL(h, SITE).hostname || h; } catch { k = h.slice(0, 40); } hosts[k] = (hosts[k] || 0) + 1; }
    console.log(`  ${stats.droppedHrefs.length} 個連結不在允許清單 ${INFO_ALLOWED_HOSTS.join(' ')}（改為純文字或略過）：` +
      Object.entries(hosts).map(([h, n]) => `${logSafe(h)}×${n}`).join('、'));
  }
  for (const s of doc.sections) {
    console.log(`  ${s.id} ${s.key.padEnd(11)} ${String(s.updated || '—').padEnd(10)} 區塊 ${s.blocks.length}、連結 ${s.links.length}、附件 ${s.files.length}  ${logSafe(s.title)}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = outFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n');
  fs.renameSync(tmp, outFile);
  console.log(`完成：${doc.sections.length} 個區塊 → ${outFile}（changedAt ${doc.meta.changedAt}）`);
  console.log(changed ? 'changed' : 'unchanged');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('接種資訊擷取失敗：' + logSafe(e?.message || e));
    if (e?.cause) console.error('  原因：', logSafe(e.cause?.code || e.cause));
    process.exit(1);
  });
}
