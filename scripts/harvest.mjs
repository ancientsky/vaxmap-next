#!/usr/bin/env node
// 從現站 (vaxmap.cdc.gov.tw) 擷取全國院所資料 → data/raw/vaxmap_raw_YYYYMMDD-HHmm.json.gz
// 作法與限制見 docs/HARVEST.md。這是過渡方案；正式作法是由來源資料庫直接匯出 hospitals.json。
//
// 用法：node scripts/harvest.mjs
// 環境變數：
//   VAXMAP_BASE     來源網址（預設 https://vaxmap.cdc.gov.tw；測試時可指向模擬伺服器）
//   HARVEST_DELAY   每次請求間隔毫秒（預設 300；請勿調低，避免對正式站造成負擔）
//   HARVEST_MIN     最少應取得的院所數，低於此數視為失敗（預設 4000）
//   HARVEST_UA      User-Agent（建議填入可聯絡到維運者的資訊）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE = (process.env.VAXMAP_BASE || 'https://vaxmap.cdc.gov.tw').replace(/\/$/, '');
const DELAY = Math.max(0, Number(process.env.HARVEST_DELAY ?? 300));
const MIN_COUNT = Number(process.env.HARVEST_MIN ?? 4000);
const UA = process.env.HARVEST_UA || 'vaxmap-next-harvester/1.0 (scheduled snapshot; low rate)';
const OUT_DIR = 'data/raw';
const TAIWAN = [21.5, 117.5, 26.5, 122.5]; // [bottom, left, top, right]
const PAGE = 20;            // 現站每次固定回傳 20 筆
const SPLIT_AT = 500;       // 一個格子已知院所達此數就四分（ASP.NET 表單欄位數上限約 1000）
const MAX_REQUESTS = 1500;  // 保險絲
const MAX_MINUTES = 40;
// 來源不可信：限制單次回應大小、總傳輸量、單頁筆數與總院所數，避免異常回應吃光記憶體
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;   // 正常單次約 390 KB
const MAX_TOTAL_BYTES = 600 * 1024 * 1024;    // 正常全量約 97 MB
const MAX_PAGE_ITEMS = 200;                   // 正常固定 20 筆
const MAX_RECORDS = 20000;                    // 正常約 4,700 家（與 sanitize.mjs 的 LIMITS.maxHospitals 一致）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 錯誤訊息可能夾帶來源回應片段：去除控制字元，避免偽造 GitHub Actions 的 ::workflow-command::
const logSafe = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);

/** 讀取回應本文，超過 max 位元組就中止 */
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
const started = Date.now();
let requests = 0;
let bytes = 0;
let cookie = '';

// 與瀏覽器版擷取相同的瘦身規則：去掉伺服器組好的 HTML、空值與 false，保留庫存 0
function prune(v, key) {
  if (v === null || v === undefined || v === false || v === '') return undefined;
  if (typeof v === 'string') { const s = v.replace(/<[^>]*>/g, '').trim(); return s === '' ? undefined : s; }
  if (typeof v === 'number') return v === 0 && key !== 'VaccInventory' ? undefined : v;
  if (Array.isArray(v)) return v.map((x) => { const p = prune(x, key); return p === undefined ? null : p; });
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      if (k === '__proto__') continue; // JSON.parse 會產生這個自有鍵；指定給一般物件會改寫其原型
      if (k === 'InfoWindowMessage' || k === 'DefaultVacc' || /^Day\dStr$/.test(k)) continue;
      if (key && (k === 'HospitalId' || k === 'HospitalName')) continue;
      const p = prune(v[k], k);
      if (p !== undefined) o[k] = p;
    }
    return o;
  }
  return v;
}

async function openSession() {
  // 先取首頁：確認連得到，並帶上伺服器給的 cookie（若有）
  const res = await fetch(BASE + '/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`首頁回應 HTTP ${res.status}`);
  const set = res.headers.getSetCookie?.() || [];
  cookie = set.map((c) => c.split(';')[0]).join('; ');
  await readCapped(res, MAX_RESPONSE_BYTES);
}

async function post(cell, ids) {
  const body = new URLSearchParams();
  for (const id of ids) body.append('ids[]', String(id));
  body.append('bottom', cell[0]); body.append('left', cell[1]);
  body.append('right', cell[3]); body.append('top', cell[2]);
  body.append('vaccKindType', '4'); body.append('matchMode', 'all');
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (requests >= MAX_REQUESTS) throw new Error(`請求數超過上限 ${MAX_REQUESTS}`);
    if (Date.now() - started > MAX_MINUTES * 60000) throw new Error(`執行超過 ${MAX_MINUTES} 分鐘`);
    try {
      requests++;
      const res = await fetch(BASE + '/Home/GetHospitalData', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest', // 少了這個標頭現站會回 404
          'User-Agent': UA, Referer: BASE + '/', Origin: BASE,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body,
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
      const text = await readCapped(res, MAX_RESPONSE_BYTES);
      bytes += text.length;
      if (bytes > MAX_TOTAL_BYTES) throw new Error(`總傳輸量超過上限 ${MAX_TOTAL_BYTES} bytes`);
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('回應不是陣列');
      if (data.length > MAX_PAGE_ITEMS) throw new Error(`單頁 ${data.length} 筆，超過上限 ${MAX_PAGE_ITEMS}`);
      return data;
    } catch (e) {
      lastErr = e;
      if (/上限/.test(e?.message)) break; // 保險絲觸發不重試
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error(`格子 ${cell.join(',')} 擷取失敗：${logSafe(lastErr?.message || lastErr)}`);
}

async function main() {
  console.log(`來源 ${BASE}，間隔 ${DELAY} ms`);
  await openSession();
  const recs = new Map();
  let catalog = null;
  const queue = [TAIWAN];
  const inCell = (x, c) => x.Lat >= c[0] && x.Lat <= c[2] && x.Long >= c[1] && x.Long <= c[3];
  const split = ([b, l, t, r]) => {
    const mb = (b + t) / 2, ml = (l + r) / 2;
    queue.push([b, l, mb, ml], [b, ml, mb, r], [mb, l, t, ml], [mb, ml, t, r]);
  };
  while (queue.length) {
    const cell = queue.shift();
    const ids = [...recs.values()].filter((x) => inCell(x, cell)).map((x) => x.Id);
    if (ids.length >= SPLIT_AT) { split(cell); continue; }
    for (;;) {
      const page = await post(cell, ids);
      for (const x of page) {
        // Id 必須是正整數（會被送回來源的 ids[]）、座標必須是數字（用於切分格子）；否則略過
        if (!x || typeof x !== 'object' || !Number.isSafeInteger(x.Id) || x.Id <= 0 ||
            typeof x.Lat !== 'number' || typeof x.Long !== 'number') continue;
        if (!catalog && Array.isArray(x.DefaultVacc)) catalog = x.DefaultVacc.map((c) => prune(c));
        ids.push(x.Id);
        if (!recs.has(x.Id)) recs.set(x.Id, prune(x));
      }
      if (recs.size > MAX_RECORDS) throw new Error(`院所數 ${recs.size} 超過上限 ${MAX_RECORDS}`);
      if (requests % 25 === 0) console.log(`  ${requests} 次請求，${recs.size} 家，${(bytes / 1e6).toFixed(0)} MB`);
      await sleep(DELAY);
      if (page.length < PAGE) break;
      if (ids.length >= SPLIT_AT + 200) { split(cell); break; }
    }
  }
  if (recs.size < MIN_COUNT) throw new Error(`只取得 ${recs.size} 家，低於門檻 ${MIN_COUNT}，視為失敗`);

  const now = new Date();
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'short' })
    .format(now).replace(/[-:]/g, '').replace(' ', '-');
  const out = { harvestedAt: now.toISOString(), source: BASE, count: recs.size, catalog, hospitals: [...recs.values()] };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `vaxmap_raw_${stamp}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out)));
  console.log(`完成：${recs.size} 家，${requests} 次請求，${(bytes / 1e6).toFixed(0)} MB，` +
    `${((Date.now() - started) / 60000).toFixed(1)} 分鐘 → ${file}`);
}

main().catch((e) => { console.error('擷取失敗：' + logSafe(e?.message || e)); if (e?.cause) console.error('  原因：', logSafe(e.cause?.code || e.cause)); process.exit(1); });
