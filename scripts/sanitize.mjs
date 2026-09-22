// 發布前的最後一道關卡：把 hospitals.json（docs/DATA_SCHEMA.md 格式）逐欄以白名單重建。
// 來源資料是從別的網站擷取的，一律視為不可信；線上既有的 hospitals.json 也可能是舊版流程產生的，
// 所以 normalize.mjs 與 keep-live-data.mjs 都必須經過這裡，才寫入 public/data/hospitals.json。
//
// 原則：
//   - 只輸出契約內的欄位（未知欄位丟棄），物件一律重新建立（不沿用輸入物件，避免 __proto__ 等鍵）。
//   - 字串：必須是 string；去除控制字元、雙向文字控制字元（bidi override）、零寬字元與 < >；限制長度。
//   - 數字：必須是有限整數且在合理範圍。
//   - 網址：只接受 https，不得含帳密。
//   - 電話：只保留數字、空白、+ - ( ) # ~ , 、 / 與「轉」「分機」「或」「ext」。
//   - 必要欄位不合格 → 捨棄該院所（記入 warn）；選填欄位不合格 → 捨棄該欄位。
//   - 結構性錯誤（非物件、數量超過上限、時間不合理）→ 丟出例外，整份資料不予發布。

export const LIMITS = Object.freeze({
  maxHospitals: 20000, // 全國約 4,700 家，留 4 倍餘裕
  maxVaccines: 50,
  maxGroups: 20,
  maxStock: 1_000_000,
  name: 100,
  addr: 200,
  area: 12, // 縣市、行政區
  tel: 60,
  note: 300,
  url: 500,
  short: 60,
});

// C0/C1 控制字元、軟連字號、阿拉伯字母標記、零寬字元、行／段分隔、bidi embedding/override/isolate、
// 詞連接字元等不可見格式字元、BOM、interlinear annotation，以及 < >（純粹縱深防禦：前端只用 textContent）
// eslint-disable-next-line no-control-regex
const STRIP_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB<>]/g;
// eslint-disable-next-line no-control-regex
const SPACE_CTRL_RE = /[\t\n\r]/g;
const ID_RE = /^[a-z0-9_]{1,32}$/;
// 會與 Object.prototype 成員同名的 id（__proto__、constructor…）一律不接受
const isSafeId = (v) => typeof v === 'string' && ID_RE.test(v) && !(v in Object.prototype) && v !== 'prototype';
const CODE_RE = /^[0-9A-Za-z]{1,20}$/;
const TEL_WORDS_RE = /轉|分機|或|ext\.?/gi;
// eslint-disable-next-line no-control-regex
const TEL_DISALLOWED_RE = /[^0-9 +\-()#~,、/\u0001]/g; // \u0001 為允許字詞的暫時佔位字元
// eslint-disable-next-line no-control-regex
const UNSAFE_URL_RE = /[\s\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB<>"'`]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/; // 只接受 ISO 8601
const EARLIEST = Date.parse('2020-01-01T00:00:00Z');
const BBOX = { latMin: 21, latMax: 27, lngMin: 117, lngMax: 123 }; // 與 normalize.mjs 相同（含金門、馬祖、澎湖）

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 清理文字；不是字串回傳 undefined；清理後為空字串回傳 ''。超過長度截斷。 */
export function cleanText(v, max) {
  if (typeof v !== 'string') return undefined;
  let s = v.replace(SPACE_CTRL_RE, ' ').replace(STRIP_RE, '').trim();
  if (s.length > max) s = [...s].slice(0, max).join('').trim();
  return s;
}

/** 電話：去除不允許的字元；至少要有 3 個數字，否則回傳 undefined */
export function cleanTel(v) {
  const s = cleanText(v, LIMITS.tel * 4);
  if (s === undefined) return undefined;
  // 先把允許的中文／英文字詞暫時換成佔位字元，去除其他字元後再換回
  const words = [];
  const kept = s.replace(TEL_WORDS_RE, (w) => { words.push(w); return '\u0001'; })
    .replace(TEL_DISALLOWED_RE, '')
    .replace(/\u0001/g, () => words.shift())
    .replace(/ {2,}/g, ' ')
    .trim();
  if ((kept.match(/\d/g) || []).length < 3 || kept.length > LIMITS.tel) return undefined;
  return kept;
}

/** 只接受 https、不含帳密、主機名稱需含「.」、不含空白／控制／不可見字元與引號的網址；原樣回傳 */
export function cleanHttpsUrl(v) {
  if (typeof v !== 'string' || v.length > LIMITS.url || UNSAFE_URL_RE.test(v)) return undefined;
  let u;
  try { u = new URL(v); } catch { return undefined; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return undefined;
  return v;
}

/** 有限整數且在 [min, max] 內 */
export function cleanInt(v, min, max) {
  return Number.isSafeInteger(v) && v >= min && v <= max ? v : undefined;
}

function cleanCoord(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v > min && v < max ? +v.toFixed(6) : undefined;
}

/** ISO 時間：可解析、不早於 2020、不晚於 now + 1 小時 */
export function cleanTimestamp(v, now = Date.now()) {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < EARLIEST || t > now + 3600_000) return undefined;
  return v;
}

/**
 * 清理一筆院所；必要欄位不合格回傳 null。
 * @param {object} h
 * @param {Set<string>} vaccineIds 合法的品項 id
 * @param {(msg:string)=>void} warn
 */
export function sanitizeHospital(h, vaccineIds, warn = () => {}) {
  if (!isPlainObject(h)) { warn('院所資料不是物件'); return null; }
  const id = cleanInt(h.id, 1, 1e9);
  const tag = `院所 ${typeof h.id === 'number' ? h.id : '?'}`;
  const code = cleanText(h.code, 20);
  const name = cleanText(h.name, LIMITS.name);
  const addr = cleanText(h.addr, LIMITS.addr);
  const tel = cleanTel(h.tel);
  const lat = cleanCoord(h.lat, BBOX.latMin, BBOX.latMax);
  const lng = cleanCoord(h.lng, BBOX.lngMin, BBOX.lngMax);
  const bad = [];
  if (id === undefined) bad.push('id');
  if (!code || !CODE_RE.test(code)) bad.push('code');
  if (!name) bad.push('name');
  if (!addr) bad.push('addr');
  if (!tel) bad.push('tel');
  if (lat === undefined || lng === undefined) bad.push('座標');
  if (bad.length) { warn(`${tag} 捨棄：欄位不合格 ${bad.join('、')}`); return null; }

  const city = cleanText(h.city, LIMITS.area) ?? '';
  const dist = cleanText(h.dist, LIMITS.area) ?? '';
  let hours = Array.isArray(h.hours) && h.hours.length === 7 ? h.hours.map((x) => cleanInt(x, 0, 7)) : null;
  if (!hours || hours.includes(undefined)) {
    warn(`${tag} 看診時段格式不合格，視為全週休診`);
    hours = [0, 0, 0, 0, 0, 0, 0];
  }
  const stock = {};
  if (isPlainObject(h.stock)) {
    for (const k of Object.keys(h.stock)) {
      if (!vaccineIds.has(k)) { warn(`${tag} 未知品項 ${JSON.stringify(k).slice(0, 40)}`); continue; }
      const q = h.stock[k];
      if (!Number.isSafeInteger(q)) { warn(`${tag} ${k} 庫存不是整數`); continue; }
      if (q > LIMITS.maxStock) { warn(`${tag} ${k} 庫存 ${q} 超過上限`); continue; }
      stock[k] = q > 0 ? 1 : 0; // 只發布有（1）／無（0），原始數量一律不放進公開檔案
    }
  } else if (h.stock !== undefined) {
    warn(`${tag} stock 不是物件`);
  }

  const o = { id, code, name, city, dist, addr, tel, lat, lng, hours, stock };
  if (h.apptTel !== undefined) {
    const t = cleanTel(h.apptTel);
    if (t) o.apptTel = t; else warn(`${tag} 預約電話不合格，已略過`);
  }
  if (h.apptUrl !== undefined) {
    const u = cleanHttpsUrl(h.apptUrl);
    if (u) o.apptUrl = u; else warn(`${tag} 預約網址不合格（僅接受 https），已略過`);
  }
  if (h.note !== undefined) {
    const n = cleanText(h.note, LIMITS.note);
    if (n) o.note = n;
  }
  return o;
}

function sanitizeCatalog(list, max, fields, what) {
  if (!Array.isArray(list) || list.length === 0 || list.length > max) throw new Error(`${what} 必須是 1–${max} 筆的陣列`);
  const out = [];
  const seen = new Set();
  for (const v of list) {
    if (!isPlainObject(v) || !isSafeId(v.id) || seen.has(v.id)) throw new Error(`${what} 含不合格的 id`);
    seen.add(v.id);
    const o = { id: v.id };
    for (const f of fields) {
      if (f === 'group') {
        if (!isSafeId(v.group)) throw new Error(`${what} ${v.id} 的 group 不合格`);
        o.group = v.group;
      } else {
        const s = cleanText(v[f], LIMITS.short);
        if (!s) throw new Error(`${what} ${v.id} 的 ${f} 不合格`);
        o[f] = s;
      }
    }
    out.push(o);
  }
  return out;
}

/**
 * 清理整份資料集；結構性錯誤丟出例外。
 * @param {object} d { meta, vaccines, groups, hospitals }
 * @param {{ now?: number, warn?: (msg:string)=>void }} [opts]
 */
export function sanitizeDataset(d, { now = Date.now(), warn = () => {} } = {}) {
  if (!isPlainObject(d)) throw new Error('資料不是物件');
  if (!Array.isArray(d.hospitals)) throw new Error('hospitals 不是陣列');
  if (d.hospitals.length > LIMITS.maxHospitals) throw new Error(`院所數 ${d.hospitals.length} 超過上限 ${LIMITS.maxHospitals}`);
  const meta = isPlainObject(d.meta) ? d.meta : {};
  const generatedAt = cleanTimestamp(meta.generatedAt, now);
  if (!generatedAt) throw new Error(`meta.generatedAt 不合格：${String(meta.generatedAt).slice(0, 40)}`);

  const vaccines = sanitizeCatalog(d.vaccines, LIMITS.maxVaccines, ['group', 'name', 'short'], 'vaccines');
  const groups = sanitizeCatalog(d.groups, LIMITS.maxGroups, ['name'], 'groups');
  const groupIds = new Set(groups.map((g) => g.id));
  for (const v of vaccines) if (!groupIds.has(v.group)) throw new Error(`vaccines ${v.id} 的 group 不存在`);
  const vaccineIds = new Set(vaccines.map((v) => v.id));

  const hospitals = [];
  const ids = new Set();
  for (const h of d.hospitals) {
    const c = sanitizeHospital(h, vaccineIds, warn);
    if (!c) continue;
    if (ids.has(c.id)) { warn(`院所 ${c.id} 重複，捨棄後者`); continue; }
    ids.add(c.id);
    hospitals.push(c);
  }

  const outMeta = {
    generatedAt,
    source: cleanHttpsUrl(meta.source) || 'https://vaxmap.cdc.gov.tw/',
    count: hospitals.length,
  };
  const rawCount = cleanInt(meta.rawCount, 0, 10 * LIMITS.maxHospitals);
  if (rawCount !== undefined) outMeta.rawCount = rawCount;
  return { meta: outMeta, vaccines, groups, hospitals };
}
