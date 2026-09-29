// 純函式：不依賴 DOM / Leaflet，可在 Node 下單元測試。
// 資料契約見 docs/DATA_SCHEMA.md

/* ------------------------------------------------------------------ *
 * 時間（Asia/Taipei，UTC+8，無日光節約時間）
 * ------------------------------------------------------------------ */

const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

// id 對應語系檔的 key（period.am / period.pm / period.eve）；label 為繁中原文（保留供相容）
export const PERIODS = [
  { bit: 1, id: 'am', label: '上午', from: 8, to: 12 },
  { bit: 2, id: 'pm', label: '下午', from: 12, to: 18 },
  { bit: 4, id: 'eve', label: '晚上', from: 18, to: 22 },
];
export const WEEKDAYS = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
// 週一=0 … 週日=6 對應語系檔的 key（weekday.mon.short …）
export const WEEKDAY_IDS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/* ------------------------------------------------------------------ *
 * 語系（僅清單與比對規則；字串本身在 public/i18n/*.json，由 i18n.js 載入）
 * ------------------------------------------------------------------ */

export const DEFAULT_LANG = 'zh-Hant';
export const SUPPORTED_LANGS = Object.freeze(['zh-Hant', 'en', 'ja', 'ko', 'id', 'vi', 'th', 'tl']);

/**
 * 將 BCP 47 語言標籤（navigator.languages、網址參數）對應到本站支援的語系；不支援 → null。
 * zh / zh-TW / zh-HK / zh-Hant-* / zh-CN 一律 → zh-Hant（本站唯一的中文版本）；fil / tl → tl；in（舊碼）→ id。
 */
export function matchLang(tag) {
  if (typeof tag !== 'string') return null;
  const t = tag.trim().toLowerCase().replace(/_/g, '-');
  if (!t || t.length > 35) return null;
  const exact = SUPPORTED_LANGS.find((l) => l.toLowerCase() === t);
  if (exact) return exact;
  const base = t.split('-')[0];
  if (base === 'zh') return 'zh-Hant';
  if (base === 'fil' || base === 'tl') return 'tl';
  if (base === 'in') return 'id';
  return SUPPORTED_LANGS.find((l) => l === base) || null;
}

/** 依序比對多個偏好語言，回傳第一個支援的；都不支援 → null */
export function pickLang(tags) {
  for (const t of tags || []) {
    const m = matchLang(t);
    if (m) return m;
  }
  return null;
}

function toDate(now) {
  if (now instanceof Date) return now;
  if (typeof now === 'number') return new Date(now);
  return new Date();
}

/** 臺北時間的各欄位（year, month 1–12, day, hour, minute, weekday Sun=0） */
export function taipeiParts(now) {
  const t = new Date(toDate(now).getTime() + TAIPEI_OFFSET_MS);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    weekday: t.getUTCDay(),
  };
}

/** 今天是週幾：週一=0 … 週日=6（臺北時間） */
export function todayIndex(now) {
  return (taipeiParts(now).weekday + 6) % 7;
}

/** 目前時段位元：上午 08–12 → 1、下午 12–18 → 2、晚上 18–22 → 4，其餘 0 */
export function currentPeriodBit(now) {
  const h = taipeiParts(now).hour;
  for (const p of PERIODS) if (h >= p.from && h < p.to) return p.bit;
  return 0;
}

/**
 * 時間情境：一次算好給大量院所共用。接受 Date / 毫秒數 / 已建立的情境物件。
 * @returns {{day:number, period:number}}
 */
export function timeContext(now) {
  if (now && typeof now === 'object' && !(now instanceof Date) && 'day' in now) return now;
  const d = toDate(now);
  return { day: todayIndex(d), period: currentPeriodBit(d) };
}

/** 將 ISO 時間格式化為臺北時間 "2026/9/21 11:28" */
export function formatTaipei(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = taipeiParts(d);
  const mm = String(p.minute).padStart(2, '0');
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${mm}`;
}

/* ------------------------------------------------------------------ *
 * 品項選擇
 * ------------------------------------------------------------------ */

/**
 * 將選取的群組（及群組內細項）展開成品項 id。
 * 群組被選取時：若有勾選該群組的細項 → 只取那些細項；否則取整個群組。
 * @param {{groups?:string[], products?:string[]}} sel
 * @param {{id:string, group:string}[]} vaccines 品項目錄
 * @returns {string[]}
 */
export function resolveVaccineIds(sel, vaccines) {
  const groups = new Set(sel?.groups || []);
  const products = new Set(sel?.products || []);
  const out = [];
  for (const g of groups) {
    const inGroup = vaccines.filter((v) => v.group === g);
    const narrowed = inGroup.filter((v) => products.has(v.id));
    for (const v of narrowed.length ? narrowed : inGroup) out.push(v.id);
  }
  return out;
}

/** 院所的「相關品項」：所選品項中院所有提供者；未選品項時為院所提供的全部品項 */
export function relevantProducts(h, selectedVaccineIds) {
  const stock = h.stock || {};
  if (!selectedVaccineIds || selectedVaccineIds.length === 0) return Object.keys(stock);
  return selectedVaccineIds.filter((id) => Object.prototype.hasOwnProperty.call(stock, id));
}

/* ------------------------------------------------------------------ *
 * 衍生狀態
 * ------------------------------------------------------------------ */

/**
 * @returns {{openToday:boolean, openNow:boolean, hasStock:boolean,
 *            status:'ok'|'nostock'|'closed', products:string[]}}
 */
export function deriveStatus(h, selectedVaccineIds, now) {
  const ctx = timeContext(now);
  const todayBits = (h.hours && h.hours[ctx.day]) || 0;
  const openToday = todayBits !== 0;
  const openNow = ctx.period !== 0 && (todayBits & ctx.period) !== 0;
  const products = relevantProducts(h, selectedVaccineIds);
  const hasStock = products.some((id) => (h.stock[id] || 0) > 0);
  const status = !openToday ? 'closed' : hasStock ? 'ok' : 'nostock';
  return { openToday, openNow, hasStock, status, products };
}

/**
 * 篩選條件：
 *  vaccineIds 已展開的品項 id（聯集；空陣列 = 不限）
 *  openToday  只看今日有看診
 *  inStock    只看所選（或任一）品項有庫存
 *  city, dist 縣市、行政區（空字串 = 不限）
 *  q          搜尋文字（空字串 = 不限）
 */
export function matchesFilters(h, filters, now) {
  const f = filters || {};
  if (f.city && h.city !== f.city) return false;
  if (f.dist && h.dist !== f.dist) return false;
  const ids = f.vaccineIds || [];
  const stock = h.stock || {};
  if (ids.length && !ids.some((id) => Object.prototype.hasOwnProperty.call(stock, id))) return false;
  if (f.openToday) {
    const ctx = timeContext(now);
    if (!h.hours || !h.hours[ctx.day]) return false;
  }
  if (f.inStock) {
    const products = relevantProducts(h, ids);
    if (!products.some((id) => (stock[id] || 0) > 0)) return false;
  }
  if (f.q && searchScore(h, f.q) <= 0) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * 距離
 * ------------------------------------------------------------------ */

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 距離的數值與單位（不含文字，供各語系自行格式化）：
 * 0.35 → {unit:'m', value:350}；1.234 → {unit:'km', value:1.2, digits:1}；12.4 → {unit:'km', value:12, digits:0}
 */
export function distanceParts(km) {
  if (km == null || !Number.isFinite(km)) return null;
  if (km < 1) return { unit: 'm', value: Math.max(10, Math.round((km * 1000) / 10) * 10), digits: 0 };
  if (km < 10) return { unit: 'km', value: Number(km.toFixed(1)), digits: 1 };
  return { unit: 'km', value: Math.round(km), digits: 0 };
}

/** 1.234 → "1.2 公里"；0.35 → "350 公尺"（繁中；其他語系由 i18n.js 的 formatDistanceL 處理） */
export function formatDistance(km) {
  const d = distanceParts(km);
  if (!d) return '';
  return d.unit === 'm' ? `${d.value} 公尺` : `${d.value.toFixed(d.digits)} 公里`;
}

/* ------------------------------------------------------------------ *
 * 搜尋
 * ------------------------------------------------------------------ */

/** 正規化：全半形統一（NFKC）、小寫、台→臺、去除空白與常見標點 */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/台/g, '臺')
    .replace(/[\s　,，、.。·・\-–—_()（）]/g, '');
}

// 常見簡稱 → 院所名稱中實際出現的字（皆為正規化後的形式）
const ALIASES = {
  臺大: ['臺灣大學'],
  榮總: ['榮民總'],
  北榮: ['臺北榮民'],
  中榮: ['臺中榮民'],
  高榮: ['高雄榮民'],
  成大: ['成功大學'],
  北醫: ['臺北醫學大學'],
  中國附醫: ['中國醫藥大學附設'],
  三總: ['三軍總'],
};

/**
 * 拉丁字母的比對形式：去變音符號與隔音號（Ren'ai → renai）、小寫，非字母數字一律視為字界（單一空白）。
 * 用於英文轉寫欄位 nameEn／addrEn／cityEn／distEn（見 docs/DATA_SCHEMA.md）。
 */
export function normalizeLatin(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// 英文轉寫中常見的一般詞：只以「整個字的開頭」比對，不在字中間比對
// （否則輸入 "ENT" 會命中 Dental、Center；輸入 "st" 會命中所有路名）
const LATIN_WORD_ONLY = new Set([
  'ent', 'st', 'rd', 'ln', 'aly', 'no', 'sec', 'blvd', 'ob', 'gyn', 'obgyn', 'clinic', 'hospital', 'dental', 'center',
  'medical', 'general', 'united', 'national', 'city', 'county', 'district', 'township', 'village', 'branch', 'health',
  'public', 'family', 'medicine', 'internal', 'surgery', 'pediatric', 'memorial', 'university', 'municipal', 'and',
]);

function latinField(s) {
  const words = normalizeLatin(s);
  return words ? { words: ` ${words} `, compact: words.replace(/ /g, '') } : null;
}

const searchCache = new WeakMap();
function searchFields(h) {
  let f = searchCache.get(h);
  if (!f) {
    f = {
      name: normalizeText(h.name),
      area: normalizeText(`${h.city || ''}${h.dist || ''}`),
      addr: normalizeText(h.addr),
      // 英文轉寫（舊版資料沒有 → null）：不論介面語言都可搜尋，例如 "Beitou"、"Mingde"、"ENT"、"Lin Wen Zheng"
      nameEn: latinField(h.nameEn),
      areaEn: latinField(`${h.cityEn || ''} ${h.distEn || ''}`),
      addrEn: latinField(h.addrEn),
    };
    searchCache.set(h, f);
  }
  return f;
}

/** 以英文轉寫欄位比對單一 token（token 須為拉丁字母／數字；中文 token → 0） */
function latinTokenScore(fields, token) {
  const tok = normalizeLatin(token).replace(/ /g, '');
  // 含中文等非拉丁字元的 token 不比對英文欄位（normalizeLatin 會把它們當字界丟掉，造成誤中）
  const folded = token.normalize('NFKD').replace(/[\u0300-\u036f'’‘`]/g, '');
  if (!tok || !/[a-z]/.test(tok) || /[^\x00-\x7f]/.test(folded)) return 0;
  const inner = tok.length >= 3 && !LATIN_WORD_ONLY.has(tok); // 允許命中字的中間（拼音連寫：Linwenzheng 的 "wen"）
  let best = 0;
  const n = fields.nameEn;
  if (n) {
    if (n.compact === tok) best = 100;
    else if (n.words.startsWith(` ${tok}`)) best = 80;
    else if (n.words.includes(` ${tok}`)) best = 60;
    else if (inner && n.compact.includes(tok)) best = 20;
  }
  if (fields.areaEn?.words.includes(` ${tok}`)) best = Math.max(best, 40);
  const a = fields.addrEn;
  if (a) {
    if (a.words.includes(` ${tok}`)) best = Math.max(best, 30);
    else if (inner && a.compact.includes(tok)) best = Math.max(best, 10);
  }
  return best;
}

function tokenScore(fields, token) {
  const direct = Math.max(plainTokenScore(fields, token), latinTokenScore(fields, token));
  if (direct > 0) return direct;
  // 俗稱夾在較長的詞中（例如「臺大醫院」）：拆成「俗稱」與其餘部分，各部分都須命中
  for (const key of Object.keys(ALIASES)) {
    const i = token.indexOf(key);
    if (i < 0 || token === key) continue;
    const parts = [token.slice(0, i), key, token.slice(i + key.length)].filter(Boolean);
    const scores = parts.map((part) => plainTokenScore(fields, part));
    if (scores.every((v) => v > 0)) return Math.min(...scores);
  }
  return 0;
}

function plainTokenScore(fields, token) {
  const variants = [token, ...(ALIASES[token] || [])];
  let best = 0;
  for (const t of variants) {
    if (!t) continue;
    if (fields.name === t) best = Math.max(best, 100);
    else if (fields.name.startsWith(t)) best = Math.max(best, 80);
    else if (fields.name.includes(t)) best = Math.max(best, 60);
    if (fields.area.includes(t)) best = Math.max(best, 40);
    if (fields.addr.includes(t)) best = Math.max(best, 30);
  }
  return best;
}

const aliasReCache = new WeakMap();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 將查詢字串中的「外文地名」換成中文（例如 "Taipei City" → "臺北市"），之後才切 token。
 * aliases：{ 小寫外文: 中文 }，由呼叫端注入（本檔不依賴語系檔）。以完整詞比對、長者優先，
 * 所以 "New Taipei" 不會被當成 "Taipei"。
 */
export function applyQueryAliases(query, aliases) {
  const s = String(query ?? '').normalize('NFKC').replace(/\s+/g, ' ');
  if (!aliases || typeof aliases !== 'object') return s;
  let re = aliasReCache.get(aliases);
  if (re === undefined) {
    const keys = Object.keys(aliases).filter((k) => k && typeof aliases[k] === 'string').sort((a, b) => b.length - a.length);
    re = keys.length
      ? new RegExp(`(^|[^\\p{L}\\p{N}])(${keys.map(escapeRe).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'giu')
      : null;
    aliasReCache.set(aliases, re);
  }
  if (!re) return s;
  return s.replace(re, (m, pre, word) => `${pre} ${aliases[word.toLowerCase()] ?? word} `);
}

/**
 * 將搜尋字串切成 token（以空白分隔，每個 token 正規化）。
 * opts.aliases：外文地名對照（見 applyQueryAliases），未提供時行為與原本相同。
 */
export function tokenizeQuery(query, opts) {
  return applyQueryAliases(query, opts?.aliases)
    .split(/[\s　,，、]+/)
    .map(normalizeText)
    .filter(Boolean);
}

/**
 * 搜尋分數：每個 token 都必須命中名稱、縣市行政區或地址之一（AND；中文欄位與英文轉寫欄位皆可），
 * 分數為各 token 最佳命中分數之和；任何 token 未命中 → 0。空查詢 → 1。
 */
export function searchScore(h, query, opts) {
  const tokens = Array.isArray(query) ? query : tokenizeQuery(query, opts);
  if (tokens.length === 0) return 1;
  const fields = searchFields(h);
  let sum = 0;
  for (const t of tokens) {
    const s = tokenScore(fields, t);
    if (s === 0) return 0;
    sum += s;
  }
  return sum;
}

/* ------------------------------------------------------------------ *
 * 排序
 * ------------------------------------------------------------------ */

const STATUS_RANK = { ok: 0, nostock: 1, closed: 2 };

/**
 * 排序結果（回傳新陣列）。items: [{h, distance, status, score?}]
 * 有搜尋時：名稱命中者優先（分數分級），同級再依距離；無搜尋時依距離，
 * 距離相同（或無距離）依狀態、名稱。
 */
export function sortResults(items, { byScore = false } = {}) {
  const tier = (s) => (s >= 60 ? 2 : s > 0 ? 1 : 0);
  return items.slice().sort((a, b) => {
    if (byScore) {
      const d = tier(b.score || 0) - tier(a.score || 0);
      if (d) return d;
    }
    const da = a.distance ?? Infinity;
    const db = b.distance ?? Infinity;
    if (da !== db) return da - db;
    const sa = STATUS_RANK[a.status] ?? 3;
    const sb = STATUS_RANK[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return String(a.h.name).localeCompare(String(b.h.name), 'zh-Hant-TW');
  });
}

/* ------------------------------------------------------------------ *
 * URL hash 狀態（可分享；絕不含使用者定位）
 * ------------------------------------------------------------------ */

export const DEFAULT_STATE = Object.freeze({
  groups: [],
  products: [],
  openToday: false,
  inStock: false,
  city: '',
  dist: '',
  q: '',
  id: null,
  view: null, // {lat, lng, z}
  lang: null, // 介面語系；預設語系（zh-Hant）不寫入網址
});

const ID_RE = /^[a-z0-9_]{1,32}$/i;

/** @returns {string} 不含開頭 '#' */
export function encodeState(state) {
  const s = { ...DEFAULT_STATE, ...state };
  const p = new URLSearchParams();
  if (s.groups.length) p.set('g', s.groups.join(','));
  if (s.products.length) p.set('p', s.products.join(','));
  if (s.openToday) p.set('today', '1');
  if (s.inStock) p.set('stock', '1');
  if (s.city) p.set('city', s.city);
  if (s.dist) p.set('dist', s.dist);
  if (s.q) p.set('q', s.q);
  if (s.id != null && s.id !== '') p.set('id', String(s.id));
  if (s.view && Number.isFinite(s.view.lat) && Number.isFinite(s.view.lng) && Number.isFinite(s.view.z)) {
    p.set('map', `${s.view.lat.toFixed(5)},${s.view.lng.toFixed(5)},${Math.round(s.view.z)}`);
  }
  const lang = matchLang(s.lang);
  if (lang && lang !== DEFAULT_LANG) p.set('lang', lang);
  return p.toString();
}

/** 解析 hash（可含或不含 '#'）；不合法的值一律忽略 */
export function decodeState(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const p = new URLSearchParams(raw);
  const list = (k) =>
    (p.get(k) || '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => ID_RE.test(x));
  const text = (k, max) => (p.get(k) || '').slice(0, max).trim();
  const state = {
    ...DEFAULT_STATE,
    groups: [...new Set(list('g'))],
    products: [...new Set(list('p'))],
    openToday: p.get('today') === '1',
    inStock: p.get('stock') === '1',
    city: text('city', 20),
    dist: text('dist', 20),
    q: text('q', 60),
    id: null,
    view: null,
    lang: null,
  };
  // 只接受支援清單內的語系（大小寫不拘），其餘忽略
  const lang = p.get('lang');
  if (lang && lang.length <= 35) {
    const exact = SUPPORTED_LANGS.find((l) => l.toLowerCase() === lang.trim().toLowerCase());
    if (exact) state.lang = exact;
  }
  const id = p.get('id');
  if (id && /^\d{1,10}$/.test(id)) state.id = Number(id);
  const m = (p.get('map') || '').split(',').map(Number);
  if (
    m.length === 3 && m.every(Number.isFinite) &&
    m[0] >= 10 && m[0] <= 35 && m[1] >= 110 && m[1] <= 130 && m[2] >= 5 && m[2] <= 19
  ) {
    state.view = { lat: m[0], lng: m[1], z: m[2] };
  }
  if (!state.city) state.dist = '';
  return state;
}
