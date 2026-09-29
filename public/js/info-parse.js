// 接種資訊頁的純函式（不碰 DOM，可在 node 直接測試：tests/info.test.mjs）。
// 資料契約見 docs/INFO_SCHEMA.md；這裡把 public/data/info/<lang>.json 視為不可信資料：
// 型別不對的欄位一律丟棄，網址只接受 https 且主機屬於政府網域。

/** 主題代碼與顯示順序（docs/INFO_SCHEMA.md） */
export const SECTION_KEYS = Object.freeze(['coins', 'eligibility', 'where', 'precautions', 'brands', 'education', 'faq', 'news', 'other']);

// 允許的主機（與 docs/INFO_SCHEMA.md 一致）：
//   尾碼：*.gov.tw（含 gov.tw 短網址）、臺北市政府的 *.gov.taipei（臺北市衛生局 health.gov.taipei）
//   完全相符：www.youtube.com、youtu.be（疾管署官方影片；只做外部連結，不嵌入——CSP frame-src 'none'）
const HOST_SUFFIXES = ['gov.tw', 'gov.taipei'];
const VIDEO_HOSTS = ['www.youtube.com', 'youtu.be'];
// 雙向覆寫、零寬、控制字元（顯示前再清一次，管線已清過）
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;

/** 文字欄位：非字串 → ''；去除控制與 bidi 字元、限制長度 */
export function cleanStr(v, max = 4000) {
  if (typeof v !== 'string') return '';
  return v.replace(BAD_CHARS, '').slice(0, max);
}

/**
 * 連結白名單：只接受 https、沒有帳密、主機為 gov.tw／*.gov.tw／*.gov.taipei；回傳正規化後的網址，否則 null。
 * （管線 scripts/ 已過濾一次，這裡是前端的第二道防線。）
 */
export function safeHref(v) {
  if (typeof v !== 'string' || v.length > 2048) return null;
  const s = v.trim();
  if (!/^https:\/\//i.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!VIDEO_HOSTS.includes(host) && !HOST_SUFFIXES.some((suf) => host === suf || host.endsWith(`.${suf}`))) return null;
  return u.href;
}

/** 已通過 safeHref 的網址是否為影片（YouTube）連結 */
export function isVideoHref(v) {
  const href = safeHref(v);
  if (!href) return false;
  return VIDEO_HOSTS.includes(new URL(href).hostname.toLowerCase());
}

/** ISO 日期（YYYY-MM-DD 或完整時間）→ Date；不合法 → null */
export function parseDate(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y >= 2000 && y <= 2100 ? d : null;
}

/* ---------------- 結構清理 ---------------- */

function cleanRuns(runs) {
  if (!Array.isArray(runs)) return null;
  const out = [];
  for (const r of runs.slice(0, 400)) {
    if (!r || typeof r !== 'object') continue;
    const text = cleanStr(r.text, 2000);
    if (!text) continue;
    const href = safeHref(r.href);
    out.push(href ? { text, href } : { text });
  }
  return out.length ? out : null;
}

function cleanBlock(b) {
  if (!b || typeof b !== 'object') return null;
  switch (b.type) {
    case 'p':
    case 'note': {
      let runs = cleanRuns(b.runs);
      const text = runs ? runs.map((r) => r.text).join('') : cleanStr(b.text);
      if (!text.trim()) return null;
      if (runs && !runs.some((r) => r.href)) runs = null; // 沒有連結的 runs 等同純文字
      return runs ? { type: b.type, text, runs } : { type: b.type, text };
    }
    case 'h': {
      const text = cleanStr(b.text, 400);
      if (!text.trim()) return null;
      const level = Number.isInteger(b.level) && b.level >= 1 && b.level <= 6 ? b.level : 4;
      return { type: 'h', level, text };
    }
    case 'list': {
      // levels（選填）：與 items 等長的巢狀層級 0～3；不合格就整個忽略
      const raw = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
      const lv = Array.isArray(b.levels) && b.levels.length === raw.length && b.levels.every((x) => Number.isInteger(x) && x >= 0 && x <= 3) ? b.levels : null;
      const items = [];
      const levels = [];
      raw.forEach((x, i) => {
        const t = cleanStr(x);
        if (!t.trim()) return;
        items.push(t);
        levels.push(lv ? lv[i] : 0);
      });
      if (!items.length) return null;
      const out = { type: 'list', ordered: b.ordered === true, items };
      if (levels.some((x) => x > 0)) out.levels = levels;
      return out;
    }
    case 'table': {
      const head = Array.isArray(b.head) ? b.head.slice(0, 12).map((x) => cleanStr(x, 200)) : [];
      const rows = (Array.isArray(b.rows) ? b.rows : [])
        .filter(Array.isArray)
        .slice(0, 200)
        .map((r) => r.slice(0, 12).map((x) => cleanStr(x, 600)))
        .filter((r) => r.some((c) => c.trim()));
      if (!rows.length) return null;
      return { type: 'table', caption: cleanStr(b.caption, 300), head, rows };
    }
    default:
      return null; // 未知型別（含任何 html 欄位）一律忽略
  }
}

function cleanLink(l) {
  if (!l || typeof l !== 'object') return null;
  const text = cleanStr(l.text, 600).trim();
  if (!text) return null;
  const href = safeHref(l.href);
  const out = { text, href, isNew: l.isNew === true };
  const d = parseDate(l.date);
  if (d) out.date = d;
  return out;
}

function cleanFile(f) {
  const l = cleanLink(f);
  if (!l) return null;
  const ext = typeof f.ext === 'string' && /^[a-z0-9]{1,5}$/i.test(f.ext) ? f.ext.toLowerCase() : '';
  return { ...l, ext };
}

/** 去除重複（來源的新聞稿清單常重複列出同一則） */
function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => {
    const k = `${x.href || ''}\u0000${x.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 整份資料清理：回傳 { meta, sections }；結構不對 → null。
 * sections 已依 SECTION_KEYS 順序排好（同 key 維持來源順序），並附上唯一的 anchor。
 */
export function normalizeInfo(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.sections)) return null;
  const m = json.meta && typeof json.meta === 'object' ? json.meta : {};
  const meta = {
    lang: cleanStr(m.lang, 20),
    sourceUrl: safeHref(m.sourceUrl),
    sourceTitle: cleanStr(m.sourceTitle, 300),
    title: cleanStr(m.title, 300),
    fetchedAt: parseDate(m.fetchedAt),
    changedAt: parseDate(m.changedAt),
    translation: ['machine', 'source', 'partial'].includes(m.translation) ? m.translation : 'source',
  };
  const sections = [];
  json.sections.slice(0, 60).forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    const title = cleanStr(s.title, 300).trim();
    if (!title) return;
    const key = SECTION_KEYS.includes(s.key) ? s.key : 'other';
    const id = typeof s.id === 'string' && /^\d{1,12}$/.test(s.id) ? s.id : '';
    sections.push({
      id,
      key,
      order: i,
      title,
      updated: parseDate(s.updated),
      translated: s.translated !== false,
      blocks: (Array.isArray(s.blocks) ? s.blocks : []).slice(0, 300).map(cleanBlock).filter(Boolean),
      links: dedupe((Array.isArray(s.links) ? s.links : []).slice(0, 200).map(cleanLink).filter(Boolean)),
      files: dedupe((Array.isArray(s.files) ? s.files : []).slice(0, 200).map(cleanFile).filter(Boolean)),
    });
  });
  sections.sort((a, b) => SECTION_KEYS.indexOf(a.key) - SECTION_KEYS.indexOf(b.key) || a.order - b.order);
  assignAnchors(sections);
  return { meta, sections };
}

/** 錨點：同 key 的第一個區塊用 key（#coins），之後的加序號（#other-2） */
export function assignAnchors(sections) {
  const count = Object.create(null);
  for (const s of sections) {
    count[s.key] = (count[s.key] || 0) + 1;
    s.anchor = count[s.key] === 1 ? s.key : `${s.key}-${count[s.key]}`;
  }
  return sections;
}

/* ---------------- 網址 hash：#<錨點>&lang=<語系> ---------------- */

/** "#coins&lang=en" → { section: 'coins', lang: 'en' }；也接受 "#lang=en&coins"、"#s=coins" */
export function parseInfoHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '').slice(0, 200);
  let section = null;
  let lang = null;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) { if (!section && /^[a-z0-9-]{1,40}$/i.test(part)) section = part; continue; }
    const k = part.slice(0, eq);
    let v = '';
    try { v = decodeURIComponent(part.slice(eq + 1)); } catch { continue; }
    if (k === 'lang') lang = v;
    else if (k === 's' && /^[a-z0-9-]{1,40}$/i.test(v)) section = v;
  }
  return { section, lang };
}

export function buildInfoHash({ section, lang, defaultLang = 'zh-Hant' } = {}) {
  const parts = [];
  if (section) parts.push(section);
  if (lang && lang !== defaultLang) parts.push(`lang=${encodeURIComponent(lang)}`);
  return parts.join('&');
}

/** hash 的 section 可以是錨點（coins、other-2）或來源卡片 id（103106） */
export function findSection(sections, name) {
  if (!name) return null;
  return sections.find((s) => s.anchor === name) || sections.find((s) => s.id && s.id === name) || null;
}

/* ---------------- 健康幣：從正文解析三種疫苗的幣值 ---------------- */

// 各語言的疫苗名稱（翻譯後的正文也要找得到）
const VAX_PATTERNS = {
  flu: /流感|インフルエンザ|인플루엔자|독감|influenza|\bflu\b|grippe|cúm|ไข้หวัดใหญ่|trangkaso|\bflu\b/i,
  covid: /新冠|コロナ|코로나|covid/i,
  pcv: /肺炎鏈球菌|肺鏈|肺炎球菌|폐렴구균|pneumo|phế cầu|นิวโมคอคคัส|ปอดอักเสบ|pulmonya/i,
};
// 會出現「幣」概念的字（用來挑出健康幣那一段）
const COIN_WORD = /幣|コイン|코인|coin|koin|xu\b|เหรียญ|barya/i;

function firstMatch(re, text) {
  const m = re.exec(text);
  return m ? m.index : -1;
}

/** 候選數字：2～5 位整數，排除年份、日期、年齡、百分比等 */
function numberCandidates(text) {
  const out = [];
  const re = /\d[\d,]*/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0].replace(/,$/, '');
    const n = Number(raw.replace(/,/g, ''));
    const before = text.slice(Math.max(0, m.index - 1), m.index);
    const after = text.slice(m.index + raw.length, m.index + raw.length + 6);
    if (!Number.isFinite(n) || n < 10 || n > 99999) continue;
    if (/^(19|20)\d\d$/.test(raw)) continue; // 年份
    if (/[/.\-–:]/.test(before) || /^\s*[/.\-–:]\d/.test(after)) continue; // 日期、時間、小數
    if (/^\s*(年|歲|岁|月|日|%|％|個月|years?|yrs?|months?|mL|ml|歳|세|살|tahun|tuổi|ปี)/i.test(after)) continue;
    out.push({ n, start: m.index, end: m.index + raw.length });
  }
  return out;
}

/**
 * 從健康幣區塊的正文解析 { flu, covid, pcv } 幣值（任何語言）；解析不出三個不同的數字 → null。
 * 規則：找同時提到三種疫苗與「幣」的段落；數字可能在疫苗名稱之後（中文「流感疫苗可獲得450幣」）
 * 或之前（英文「450 coins for the flu vaccine」）。兩個方向都試，數字不可跨過另一個疫苗名稱。
 */
export function parseCoins(texts) {
  for (const text of texts || []) {
    if (typeof text !== 'string' || !COIN_WORD.test(text)) continue;
    const pos = Object.entries(VAX_PATTERNS).map(([id, re]) => ({ id, at: firstMatch(re, text) }));
    if (pos.some((p) => p.at < 0)) continue;
    pos.sort((a, b) => a.at - b.at);
    const nums = numberCandidates(text);
    if (nums.length < 3) continue;
    const tryDir = (dir) => {
      const res = {};
      let dist = 0;
      for (let i = 0; i < pos.length; i++) {
        const lo = dir === 'after' ? pos[i].at : (i > 0 ? pos[i - 1].at : -1);
        const hi = dir === 'after' ? (i + 1 < pos.length ? pos[i + 1].at : Infinity) : pos[i].at;
        const inRange = nums.filter((x) => x.start > lo && x.end <= hi);
        if (!inRange.length) return null;
        const pick = dir === 'after' ? inRange[0] : inRange[inRange.length - 1];
        dist += dir === 'after' ? pick.start - pos[i].at : pos[i].at - pick.end;
        res[pos[i].id] = pick.n;
      }
      return new Set(Object.values(res)).size === 3 ? { res, dist } : null;
    };
    const cands = [tryDir('after'), tryDir('before')].filter(Boolean).sort((a, b) => a.dist - b.dist);
    if (cands.length) return cands[0].res;
  }
  return null;
}

/* ---------------- 接種對象表格的儲存格 ---------------- */

const YES = /^\s*[●✓✔☑✅◎]\s*/;
const NO = /^\s*[✖✗✘×❌╳]\s*/;

/** "●" → {mark:'yes'}；"●(未滿6歲…)" → {mark:'yes', note:'(未滿6歲…)'}；"✖" → {mark:'no'}；其他 → {mark:null, note} */
export function parseCell(v) {
  const s = String(v ?? '');
  if (YES.test(s)) return { mark: 'yes', note: s.replace(YES, '').trim() };
  if (NO.test(s)) return { mark: 'no', note: s.replace(NO, '').trim() };
  return { mark: null, note: s.trim() };
}

/* ---------------- 縣市衛生局連結段落 ---------------- */

const SEP = /[、，,;；]\s*/;

/**
 * 把「臺北市、新北市、…」這種大量連結的段落拆成項目 [{text, href|null}]；不像清單 → null。
 * 條件：至少 6 項、至少一半有連結、每項不長（≤ 40 字）。
 */
export function splitLinkList(runs) {
  if (!Array.isArray(runs) || runs.length < 6) return null;
  const items = [];
  let cur = { parts: [], href: null };
  const flush = () => {
    // 來源偶有把右括號放在另一個連結裡（「臺中市(成人」＋「)」）：去掉孤立的右括號、補齊未閉合的左括號
    let text = cur.parts.join('').trim().replace(/^[)）]\s*/, '').replace(/\s*[(（]\s*$/, '');
    if (/[(（][^)）]*$/.test(text)) text += /（[^）]*$/.test(text) ? '）' : ')';
    if (text) items.push({ text, href: cur.href });
    cur = { parts: [], href: null };
  };
  for (const r of runs) {
    if (r.href) {
      cur.parts.push(r.text);
      if (!cur.href) cur.href = r.href;
      continue;
    }
    const pieces = r.text.split(SEP);
    pieces.forEach((p, i) => {
      if (i > 0) flush();
      cur.parts.push(p);
    });
  }
  flush();
  const linked = items.filter((x) => x.href).length;
  if (items.length < 6 || linked < items.length / 2) return null;
  if (items.some((x) => x.text.length > 40)) return null;
  return items;
}

/** 整段只有一個連結（例如常見問答「季節性流感疫苗Q&A」）→ { text, href }，否則 null */
export function soleLink(b) {
  if (!b || b.type !== 'p' || !b.runs) return null;
  const links = b.runs.filter((r) => r.href);
  if (links.length !== 1) return null;
  const rest = b.runs.filter((r) => !r.href).map((r) => r.text).join('').replace(/[\s▲►•:：]/g, '');
  return rest ? null : { text: links[0].text.trim(), href: links[0].href };
}

/** 巢狀清單：items + levels → 樹 [{ text, children: [...] }]（層級跳躍時接在最近的上層） */
export function nestList(items, levels) {
  const root = { children: [] };
  const stack = [{ node: root, level: -1 }];
  items.forEach((text, i) => {
    const level = levels ? levels[i] : 0;
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    const node = { text, children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, level });
  });
  return root.children;
}

/** 純文字的網址（常見於「常見問答」：一行標題、一行網址）→ 安全網址或 null */
export function bareUrl(text) {
  const s = String(text ?? '').trim();
  return /^https:\/\/\S+$/.test(s) ? safeHref(s) : null;
}

/** 標題用：COVID-19 等「字母-數字」不在連字號處斷行（改用不斷行連字號 U+2011） */
export function noBreakHyphen(text) {
  return String(text ?? '').replace(/\b([A-Za-z]{2,})-(\d{1,3})\b/g, '$1\u2011$2');
}

/** 開頭的 ▲■◆★● 等標記：回傳 { marked, text } */
export function stripMarker(text) {
  const m = String(text ?? '').match(/^\s*[▲△■□◆◇★☆▶►•]\s*/);
  return m ? { marked: true, text: text.slice(m[0].length) } : { marked: false, text: String(text ?? '') };
}

/** 檔名 → 檔案語言：'en'（英文／English）、'zh'（中文版）或 null */
export function fileLang(name) {
  const s = String(name ?? '');
  if (/英文|英語|\bEnglish\b/i.test(s)) return 'en';
  if (/中文版|\(Chinese\)|（Chinese）|\bChinese version\b/i.test(s)) return 'zh';
  return null;
}
