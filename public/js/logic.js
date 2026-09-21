// 純函式：不依賴 DOM / Leaflet，可在 Node 下單元測試。
// 資料契約見 docs/DATA_SCHEMA.md

/* ------------------------------------------------------------------ *
 * 時間（Asia/Taipei，UTC+8，無日光節約時間）
 * ------------------------------------------------------------------ */

const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

export const PERIODS = [
  { bit: 1, label: '上午', from: 8, to: 12 },
  { bit: 2, label: '下午', from: 12, to: 18 },
  { bit: 4, label: '晚上', from: 18, to: 22 },
];
export const WEEKDAYS = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];

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

/** 1.234 → "1.2 公里"；0.35 → "350 公尺" */
export function formatDistance(km) {
  if (km == null || !Number.isFinite(km)) return '';
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} 公尺`;
  if (km < 10) return `${km.toFixed(1)} 公里`;
  return `${Math.round(km)} 公里`;
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

const searchCache = new WeakMap();
function searchFields(h) {
  let f = searchCache.get(h);
  if (!f) {
    f = {
      name: normalizeText(h.name),
      area: normalizeText(`${h.city || ''}${h.dist || ''}`),
      addr: normalizeText(h.addr),
    };
    searchCache.set(h, f);
  }
  return f;
}

function tokenScore(fields, token) {
  const direct = plainTokenScore(fields, token);
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

/** 將搜尋字串切成 token（以空白分隔，每個 token 正規化） */
export function tokenizeQuery(query) {
  return String(query ?? '')
    .normalize('NFKC')
    .split(/[\s　,，、]+/)
    .map(normalizeText)
    .filter(Boolean);
}

/**
 * 搜尋分數：每個 token 都必須命中名稱、縣市行政區或地址之一（AND），
 * 分數為各 token 最佳命中分數之和；任何 token 未命中 → 0。空查詢 → 1。
 */
export function searchScore(h, query) {
  const tokens = Array.isArray(query) ? query : tokenizeQuery(query);
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
  };
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
