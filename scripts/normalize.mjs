#!/usr/bin/env node
// 原始擷取檔 (data/raw/*.json.gz) → public/data/hospitals.json
// 格式契約見 docs/DATA_SCHEMA.md
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sanitizeDataset, cleanHttpsUrl, LIMITS } from './sanitize.mjs';

const RAW_DIR = 'data/raw';
const OUT = 'public/data/hospitals.json';

const VACCINES = [
  { id: 'flu', srcId: '流感疫苗', group: 'flu', name: '流感疫苗', short: '流感疫苗' },
  { id: 'mod_adult', srcId: 'Moderna_Adult_LP81', group: 'covid', name: 'Moderna LP.8.1(滿12歲以上)', short: '莫德納 12歲以上' },
  { id: 'mod_child', srcId: 'Moderna_Child_LP81', group: 'covid', name: 'Moderna LP.8.1(滿6個月未滿12歲)', short: '莫德納 6個月–11歲' },
  { id: 'novavax', srcId: 'COVID-19疫苗(Novavax)', group: 'covid', name: 'Novavax JN.1(≧12歲)', short: 'Novavax 12歲以上' },
  { id: 'pcv20', srcId: '20價結合型肺炎鏈球菌疫苗', group: 'pcv', name: '20價結合型肺炎鏈球菌疫苗', short: '肺鏈 PCV20' },
  { id: 'pcv21', srcId: '21價結合型肺炎鏈球菌疫苗', group: 'pcv', name: '21價結合型肺炎鏈球菌疫苗', short: '肺鏈 PCV21' },
  { id: 'antiviral', srcId: '抗病毒藥劑', group: 'antiviral', name: '抗病毒藥劑', short: '流感抗病毒藥劑' },
];
const GROUPS = [
  { id: 'flu', name: '流感疫苗' },
  { id: 'covid', name: 'COVID-19 疫苗' },
  { id: 'pcv', name: '肺炎鏈球菌疫苗' },
  { id: 'antiviral', name: '流感抗病毒藥劑' },
];
const CITIES = ['臺北市','新北市','基隆市','桃園市','新竹市','新竹縣','苗栗縣','臺中市','彰化縣','南投縣','雲林縣','嘉義市','嘉義縣','臺南市','高雄市','屏東縣','宜蘭縣','花蓮縣','臺東縣','澎湖縣','金門縣','連江縣'];

const rawFile = process.argv[2] ||
  fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.json.gz') || f.endsWith('.json')).sort().pop();
if (!rawFile) { console.error('找不到原始檔'); process.exit(1); }
const rawPath = fs.existsSync(rawFile) ? rawFile : path.join(RAW_DIR, rawFile);
const buf = fs.readFileSync(rawPath);
// 上限：正常原始檔解壓後約 10 MB；防止異常／惡意壓縮檔（zip bomb）吃光記憶體
const raw = JSON.parse(rawPath.endsWith('.gz') ? zlib.gunzipSync(buf, { maxOutputLength: 200 * 1024 * 1024 }) : buf);
if (!raw || !Array.isArray(raw.hospitals)) { console.error('原始檔格式不正確：hospitals 不是陣列'); process.exit(1); }
if (raw.hospitals.length > LIMITS.maxHospitals) { console.error(`原始檔院所數 ${raw.hospitals.length} 超過上限 ${LIMITS.maxHospitals}`); process.exit(1); }

const bySrc = new Map(VACCINES.map(v => [v.srcId, v.id]));
const str = s => (typeof s === 'string' ? s : ''); // 來源欄位型別不可信：非字串一律視為空字串
const digits = s => str(s).replace(/\D/g, '');
const warn = [];

function cityDist(h) {
  const addr = str(h.Address).replace(/^\d{3,6}/, '').replace(/台/g, '臺').trim();
  let city = str(h.City).trim();
  let dist = str(h.Dist).trim().replace(/第.+$/, ''); // 來源偶有「鳳山區第二」這類值
  if (!city) city = CITIES.find(c => addr.startsWith(c)) || '';
  if (!dist && city) {
    const m = addr.slice(addr.startsWith(city) ? city.length : 0).match(/^(.{1,4}?[區鄉鎮市])/);
    if (m) dist = m[1];
  }
  return { city: city.replace(/台/g, '臺'), dist: dist.replace(/台/g, '臺') }; // 官方行政區名一律用「臺」
}

const hospitals = [];
for (const h of raw.hospitals) {
  if (!h || typeof h !== 'object') { warn.push('院所資料不是物件'); continue; }
  if (!(typeof h.Lat === 'number' && typeof h.Long === 'number' && h.Lat > 21 && h.Lat < 27 && h.Long > 117 && h.Long < 123)) { warn.push(`座標異常: ${h.HospitalName}`); continue; }
  const { city, dist } = cityDist(h);
  if (!city) warn.push(`無法判定縣市: ${h.HospitalName} ${h.Address}`);
  const t = h.FluOperationTimeData || {};
  const hours = [1, 2, 3, 4, 5, 6, 7].map(d => t['Day' + d] || 0);
  const stock = {};
  let apptTel, apptUrl;
  for (const v of Array.isArray(h.VaccData) ? h.VaccData : []) {
    if (!v || typeof v !== 'object') continue;
    const id = bySrc.get(v.VaccineId);
    if (!id) { warn.push(`未知品項: ${v.VaccineId}`); continue; }
    // 型別與範圍由 sanitize.mjs 檢查（非整數會被捨棄）；此處只把缺值視為 0、負數視為 0
    // 只發布「有／無」：1 = 有庫存、0 = 無庫存，原始數量不放進公開檔案
    stock[id] = typeof v.VaccInventory === 'number' ? (v.VaccInventory > 0 ? 1 : 0) : v.VaccInventory ?? 0;
    if (typeof v.AppointmentPhone === 'string' && v.AppointmentPhone && digits(v.AppointmentPhone) !== digits(h.Phone)) apptTel = v.AppointmentPhone;
    // 只接受 https（javascript:、data:、http: 等一律捨棄）
    if (cleanHttpsUrl(v.AppointmentUrl)) apptUrl = v.AppointmentUrl;
  }
  const o = {
    id: h.Id, code: h.HospitalId, name: h.HospitalName, city, dist,
    addr: h.Address, tel: h.Phone,
    lat: +h.Lat.toFixed(6), lng: +h.Long.toFixed(6),
    hours, stock,
  };
  if (apptTel) o.apptTel = apptTel;
  if (apptUrl) o.apptUrl = apptUrl;
  if (h.Note) o.note = h.Note;
  hospitals.push(o);
}
hospitals.sort((a, b) => a.id - b.id);

// 來源資料中，同一醫事機構代碼偶有兩筆（名稱含亂碼「?」或新舊名稱並存，地址與庫存完全相同）。
// 保留 Id 較大（較新）的一筆，避免地圖上同一地點出現兩個圖釘。
const byCode = new Map();
for (const h of hospitals) {
  const prev = byCode.get(h.code);
  if (prev) warn.push(`重複醫事機構代碼 ${h.code}: 捨棄「${prev.name}」(${prev.id})，保留「${h.name}」(${h.id})`);
  byCode.set(h.code, h);
}
const deduped = [...byCode.values()].sort((a, b) => a.id - b.id);

const draft = {
  meta: { generatedAt: raw.harvestedAt, source: raw.source || 'https://vaxmap.cdc.gov.tw/', count: deduped.length, rawCount: raw.hospitals.length },
  vaccines: VACCINES.map(({ srcId, ...v }) => v),
  groups: GROUPS,
  hospitals: deduped,
};
// 最後一道關卡：逐欄白名單重建（字串去控制／bidi 字元並限長、數字範圍、https 網址、電話字元），見 sanitize.mjs
let out;
try {
  out = sanitizeDataset(draft, { warn: (m) => warn.push(m) });
} catch (e) {
  console.error(`資料未通過檢查，不寫入 ${OUT}：${e.message}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const size = fs.statSync(OUT).size;
console.log(`輸入 ${raw.hospitals.length} 筆 → 輸出 ${out.hospitals.length} 筆，${(size / 1024).toFixed(0)} KB (gzip ${(zlib.gzipSync(fs.readFileSync(OUT)).length / 1024).toFixed(0)} KB)`);
// 警告內容含來源資料：去除控制字元再印出，避免換行後偽造 GitHub Actions 的 ::workflow-command::
const logSafe = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);
if (warn.length) { console.log(`警告 ${warn.length} 則：`); [...new Set(warn)].slice(0, 20).forEach(w => console.log('  - ' + logSafe(w))); }
