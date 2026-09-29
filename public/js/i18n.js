// 多語系：語系偵測、字串查詢、靜態 HTML 套用。字串放在 public/i18n/<lang>.json（扁平 key → 字串）。
// 所有字串一律以 textContent / setAttribute 寫入，絕不經過 innerHTML（見 trusted-types.js）。
// 規則與完整 key 清單見 docs/I18N.md。
import { DEFAULT_LANG, SUPPORTED_LANGS, matchLang, pickLang, decodeState, distanceParts } from './logic.js';

const STORE_KEY = 'vaxmap.lang';
// 地圖圖釘的「今日休診」符號由 innerHTML 固定字串產生（Trusted Types 允許清單），只能是這兩個之一
const CLOSED_GLYPHS = ['休', '×'];
// data-i18n-attr 只允許寫入這些屬性（避免語系檔被拿來寫入 on* 事件屬性等）
const ATTRS = new Set(['aria-label', 'placeholder', 'title', 'alt', 'content']);

const pending = new Map(); // lang → Promise<catalog>
const loaded = new Map(); // lang → catalog
let lang = DEFAULT_LANG;
let cur = Object.create(null);
let base = Object.create(null);
const listeners = new Set();
const warned = new Set();
const DEV = (() => {
  try { return ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname); } catch { return false; }
})();

function warnOnce(msg) {
  if (!DEV || warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[i18n] ${msg}`);
}

function storage(op, val) {
  try {
    if (op === 'get') return window.localStorage.getItem(STORE_KEY);
    window.localStorage.setItem(STORE_KEY, val);
  } catch { /* 無痕模式、停用儲存空間時忽略 */ }
  return null;
}

/** 只保留「字串 → 字串」的項目，放進無原型物件（語系檔視為資料，不信任其結構） */
function clean(obj) {
  const out = Object.create(null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k === 'string' && typeof v === 'string' && k.length <= 80 && v.length <= 600) out[k] = v;
  }
  return out;
}

function loadCatalog(l) {
  if (loaded.has(l)) return Promise.resolve(loaded.get(l));
  if (!pending.has(l)) {
    const url = new URL(`../i18n/${l}.json`, import.meta.url);
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`i18n ${l}: HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        const c = clean(json);
        loaded.set(l, c);
        return c;
      })
      .finally(() => pending.delete(l));
    pending.set(l, p);
  }
  return pending.get(l);
}

/** 語系偵測：網址 #lang= → localStorage → navigator.languages → zh-Hant */
export function detectLang() {
  let fromHash = null;
  try { fromHash = decodeState(location.hash).lang; } catch { /* ignore */ }
  if (fromHash) return fromHash;
  const stored = matchLang(storage('get'));
  if (stored) return stored;
  let nav = null;
  try {
    const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    nav = pickLang(list);
  } catch { /* ignore */ }
  return nav || DEFAULT_LANG;
}

async function activate(l) {
  // 非預設語系一併載入英文：供外文地名搜尋使用（見 cityAliases）
  const [c] = await Promise.all([loadCatalog(l), l !== DEFAULT_LANG && l !== 'en' ? loadCatalog('en').catch(() => null) : null]);
  lang = l;
  cur = c;
  aliasCache = null;
}

/** 啟動時呼叫一次；不會丟出例外（載入失敗時退回繁中，再失敗則只剩 HTML 內的繁中原文） */
export async function initI18n() {
  const want = detectLang();
  try {
    base = await loadCatalog(DEFAULT_LANG);
  } catch (e) {
    console.error(e);
  }
  try {
    if (want === DEFAULT_LANG) { lang = DEFAULT_LANG; cur = base; } else await activate(want);
  } catch (e) {
    console.error(e);
    lang = DEFAULT_LANG;
    cur = base;
  }
  applyDocument();
  return lang;
}

export function getLang() { return lang; }
export function getLangs() { return SUPPORTED_LANGS; }
/** 語系檔的審閱狀態（"placeholder" 表示尚待翻譯，內容為英文） */
export function getStatus() { return cur._status || 'reviewed'; }

/**
 * 切換語系（不重新載入頁面）：更新 <html lang>、標題、所有 [data-i18n] 節點，再通知 app 重繪。
 * persist=false 時不寫入 localStorage（例如由分享連結的 #lang= 帶入）。
 */
export async function setLang(next, { persist = true } = {}) {
  const l = matchLang(next);
  if (!l) return lang;
  if (persist) storage('set', l);
  if (l === lang) return lang;
  try {
    if (l === DEFAULT_LANG) { lang = l; cur = base; aliasCache = null; } else await activate(l);
  } catch (e) {
    console.error(e);
    return lang;
  }
  applyDocument();
  for (const fn of listeners) {
    try { fn(lang); } catch (e) { console.error(e); }
  }
  return lang;
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function lookup(key) {
  let s = cur[key];
  if (s == null) {
    s = base[key];
    if (s != null) warnOnce(`${lang}: missing "${key}", using ${DEFAULT_LANG}`);
  }
  return s;
}

export function has(key) {
  return cur[key] != null || base[key] != null;
}

/** 目前語系的 BCP 47 地區設定（用於 Intl 與 <html lang>） */
export function getLocale() {
  const l = lookup('meta.locale') || 'zh-Hant-TW';
  try { return Intl.getCanonicalLocales(l)[0]; } catch { return 'zh-Hant-TW'; }
}

let numFmt = null;
let numFmtLocale = null;
export function fmtNum(n) {
  const loc = getLocale();
  if (numFmtLocale !== loc) { numFmt = new Intl.NumberFormat(loc); numFmtLocale = loc; }
  return numFmt.format(Number(n));
}

function fmtParam(v) {
  return typeof v === 'number' ? fmtNum(v) : String(v ?? '');
}

/** t('results.count', {n: 12}) → "符合 12 家"；數字參數依語系加千分位。缺字時退回繁中，再缺則回傳 key。 */
export function t(key, params) {
  const s = lookup(key);
  if (s == null) {
    warnOnce(`unknown key "${key}"`);
    return key;
  }
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) ? fmtParam(params[k]) : m));
}

/** 單複數：n === 1 且有 "<key>.one" 時使用它，否則用 "<key>"。params 會自動帶入 n。 */
export function tn(key, n, params) {
  const k = n === 1 && has(`${key}.one`) ? `${key}.one` : key;
  return t(k, { n, ...params });
}

/**
 * 回傳字串與節點交錯的陣列，讓參數可以是 DOM 節點（例如把數字包在 <span class="num">、把電話做成連結）。
 * 供 el(tag, attrs, ...tParts(...)) 使用，全程不需要 innerHTML。
 */
export function tParts(key, params = {}, { plural } = {}) {
  let k = key;
  if (plural != null && plural === 1 && has(`${key}.one`)) k = `${key}.one`;
  const s = lookup(k) ?? k;
  const out = [];
  let last = 0;
  s.replace(/\{(\w+)\}/g, (m, name, idx) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return m;
    if (idx > last) out.push(s.slice(last, idx));
    const v = params[name];
    out.push(v && typeof v === 'object' && 'nodeType' in v ? v : fmtParam(v));
    last = idx + m.length;
    return m;
  });
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** 品項名稱：繁中沿用資料檔（fallback）；其他語系用 vaccine.<id>.<field>，沒有則退回資料檔 */
export function tVaccine(id, field = 'name', fallback) {
  const key = `vaccine.${id}.${field}`;
  if (lang === DEFAULT_LANG && fallback) return fallback;
  return cur[key] ?? (fallback || base[key] || id);
}

/** 品項群組：field = 'name'（完整名稱）或 'chip'（主列短標籤） */
export function tGroup(id, field = 'name', fallback) {
  const key = `group.${id}.${field}`;
  if (lang === DEFAULT_LANG && fallback && field === 'name') return fallback;
  return cur[key] ?? base[key] ?? fallback ?? id;
}

/** 縣市名稱翻譯；未知縣市原樣回傳 */
export function tCity(zh) {
  if (!zh) return '';
  return cur[`city.${zh}`] ?? zh;
}

/* ---------------- 院所資料的顯示文字（中文原文／英文轉寫） ---------------- */

// 資料檔的院所名稱、地址、行政區是中文；hospitals.json 另附英文轉寫 nameEn、addrEn、cityEn、distEn
// （scripts/romanize.mjs 產生，見 docs/DATA_SCHEMA.md）。語系檔的 meta.script 決定畫面以哪一種為主：
//   "han"   （zh-Hant、ja）：中文為主；ja 另以英文為第二行（名稱）
//   "latin" （其他語系）：英文為主，中文放第二行（給計程車司機、櫃檯看）
// 舊版資料沒有英文欄位時一律退回中文。
const ZH_TAG = 'zh-Hant-TW';
const distEnMap = new Map(); // "臺北市|北投區" → "Beitou District"（由 learnPlaceNames 從資料建立）

/** 目前語系的資料文字系統：'han' | 'latin' */
export function getScript() {
  return lookup('meta.script') === 'latin' ? 'latin' : 'han';
}

/** 載入資料後呼叫一次：記下行政區的英文名稱，供 placeLabel()、行政區選單使用 */
export function learnPlaceNames(hospitals) {
  distEnMap.clear();
  for (const h of hospitals || []) {
    if (h && typeof h.distEn === 'string' && h.distEn && h.city && h.dist) distEnMap.set(`${h.city}|${h.dist}`, h.distEn);
  }
}

/** 行政區名稱：latin 語系用英文（Beitou District），其餘維持中文 */
export function tDist(city, dist) {
  if (!dist) return '';
  return (getScript() === 'latin' && distEnMap.get(`${city}|${dist}`)) || dist;
}

/**
 * 院所名稱或地址的顯示文字。
 * @param {object} h 院所（hospitals.json 的一筆）
 * @param {'name'|'addr'} field
 * @returns {{text: string, lang: string|null, alt: string, altLang: string|null}}
 *   text：主要顯示文字；alt：第二行（沒有則為 ''）；lang／altLang：與頁面語言不同時應設定的 lang 屬性（null = 沿用頁面）
 */
export function displayParts(h, field = 'name') {
  const zh = String(h?.[field] ?? '');
  const en = typeof h?.[`${field}En`] === 'string' ? h[`${field}En`] : '';
  if (lang === DEFAULT_LANG || !en) return { text: zh, lang: lang === DEFAULT_LANG ? null : ZH_TAG, alt: '', altLang: null };
  if (getScript() === 'latin') return { text: en, lang: null, alt: zh, altLang: ZH_TAG };
  // han（ja）：漢字可讀，中文為主；名稱另附英文，地址只顯示中文
  return { text: zh, lang: ZH_TAG, alt: field === 'name' ? en : '', altLang: 'en' };
}

/** 院所名稱（主要顯示文字）：清單、詳細資料標題、地圖圖釘的 aria-label／title 都用這個 */
export function displayName(h) {
  return displayParts(h, 'name').text;
}

/** 院所地址（主要顯示文字） */
export function displayAddr(h) {
  return displayParts(h, 'addr').text;
}

/**
 * 院所所在地：繁中「臺北市北投區」；ja「台北市北投區」（日文縣市名＋中文行政區）；
 * latin 語系「Taipei City · Beitou District」（資料的 cityEn、distEn，與英文地址一致）
 */
export function displayArea(h) {
  if (!h) return '';
  if (lang !== DEFAULT_LANG && getScript() === 'latin' && h.cityEn) {
    return h.distEn ? t('place.cityDist', { city: h.cityEn, dist: h.distEn }) : h.cityEn;
  }
  return placeLabel(h.city, h.dist);
}

/** 「縣市 行政區」（篩選標籤等）：繁中為「臺北市中正區」，latin 語系為「Taipei City · Zhongzheng District」 */
export function placeLabel(city, dist) {
  if (!city) return dist || '';
  if (!dist) return tCity(city);
  return t('place.cityDist', { city: tCity(city), dist: tDist(city, dist) });
}

/** 距離：依語系的單位字樣與數字格式 */
export function formatDistanceL(km) {
  const d = distanceParts(km);
  if (!d) return '';
  const nf = new Intl.NumberFormat(getLocale(), { minimumFractionDigits: d.digits, maximumFractionDigits: d.digits });
  return d.unit === 'm' ? t('dist.m', { m: nf.format(d.value) }) : t('dist.km', { km: nf.format(d.value) });
}

/** ISO 時間 → 臺北時間，依語系格式（一律用西曆） */
export function formatTaipeiL(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(getLocale(), {
      timeZone: 'Asia/Taipei', calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** 地圖與狀態徽章的「今日休診」符號（只能是固定清單中的字元） */
export function closedGlyph() {
  const g = lookup('glyph.closed');
  return CLOSED_GLYPHS.includes(g) ? g : '×';
}

/* ---------------- 外文地名搜尋 ---------------- */

let aliasCache = null;
/**
 * { 小寫外文縣市名: 中文 }，供 logic.js 的 tokenizeQuery({aliases}) 使用。繁中介面 → null。
 * 含目前語系與英文的完整名稱（"Taipei City"），以及去掉 City／County 的簡稱（"Taipei"）；
 * 簡稱同時對應兩個縣市時（Chiayi、Hsinchu）改對應共同的字首（嘉義、新竹）。
 */
export function cityAliases() {
  if (lang === DEFAULT_LANG) return null;
  if (aliasCache) return aliasCache;
  const full = Object.create(null);
  const bare = new Map();
  for (const c of [cur, loaded.get('en')]) {
    if (!c) continue;
    for (const [k, v] of Object.entries(c)) {
      if (!k.startsWith('city.')) continue;
      const zh = k.slice(5);
      const name = v.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!name || name === zh) continue;
      full[name] = zh;
      const short = name.replace(/\s+(city|county)$/, '');
      if (short !== name) {
        if (!bare.has(short)) bare.set(short, new Set());
        bare.get(short).add(zh);
      }
    }
  }
  for (const [short, set] of bare) {
    if (full[short]) continue;
    const zhs = [...set];
    if (zhs.length === 1) { full[short] = zhs[0]; continue; }
    let p = zhs[0];
    for (const z of zhs) while (!z.startsWith(p)) p = p.slice(0, -1);
    if (p.length >= 2) full[short] = p;
  }
  aliasCache = full;
  return full;
}

/* ---------------- 靜態 HTML ---------------- */

/** 將目前語系套用到 index.html 的靜態節點：data-i18n（文字）、data-i18n-attr（"屬性:key;屬性:key"） */
export function applyDocument(root = document) {
  const html = document.documentElement;
  html.lang = getLocale();
  html.dir = lookup('meta.dir') === 'rtl' ? 'rtl' : 'ltr';
  html.dataset.lang = lang;
  // 各頁面可用 <html data-i18n-title="…" data-i18n-desc="…"> 指定自己的標題與描述 key（預設為地圖頁）
  document.title = t(html.dataset.i18nTitle || 'meta.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t(html.dataset.i18nDesc || 'meta.description'));
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n;
    node.textContent = key === 'glyph.closed' ? closedGlyph() : t(key);
  }
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((x) => x && x.trim());
      if (attr && key && ATTRS.has(attr)) node.setAttribute(attr, t(key));
    }
  }
}
