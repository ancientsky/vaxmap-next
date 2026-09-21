#!/usr/bin/env node
// 若線上（已部署的 Pages）的 hospitals.json 比 repo 內的新，就沿用線上那份。
// 用途：排程擷取的資料不提交進 repo（避免 repo 逐日膨脹），所以「只改程式」的部署
// 或「擷取失敗」的部署，都要避免把線上資料蓋回 repo 裡較舊的快照。
// 用法：node scripts/keep-live-data.mjs <Pages 網址>
//
// 安全：線上檔案同樣視為不可信（可能是舊版流程產生、或遭竄改），必須通過與 normalize.mjs 相同的
// sanitize.mjs 檢查，且以清理後重新序列化的內容寫入，而不是原樣轉存；否則一份有問題的線上檔
// 會在每次部署、每月快照時被自己延續下去。
import fs from 'node:fs';
import { sanitizeDataset, LIMITS } from './sanitize.mjs';

const LOCAL = 'public/data/hospitals.json';
const MAX_BYTES = 20 * 1024 * 1024; // 正常約 1.2 MB
const MIN_HOSPITALS = 4000;
const base = (process.argv[2] || '').replace(/\/$/, '');
const local = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
const logSafe = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);
const keepLocal = (why) => { console.log(`沿用 repo 內的快照（${logSafe(local.meta?.generatedAt)}）：${logSafe(why)}`); process.exit(0); };

let url;
try { url = new URL(`${base}/data/hospitals.json`); } catch { keepLocal('未提供 Pages 網址'); }
if (url.protocol !== 'https:' || url.username || url.password) keepLocal('Pages 網址必須是 https');

async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new Error(`線上檔案過大（${len} bytes）`);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); throw new Error(`線上檔案過大（超過 ${max} bytes）`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
  if (new URL(res.url).protocol !== 'https:') keepLocal('線上檔案被轉址到非 https 網址');
  if (!res.ok) keepLocal(`線上檔案 HTTP ${res.status}（第一次部署屬正常）`);
  const live = JSON.parse(await readCapped(res, MAX_BYTES));
  let clean;
  try {
    clean = sanitizeDataset(live); // 時間晚於現在 1 小時以上、結構不符、數量超過上限 → 丟出例外
  } catch (e) {
    keepLocal(`線上檔案未通過檢查：${e.message}`);
  }
  const n = clean.hospitals.length;
  if (n < MIN_HOSPITALS || n > LIMITS.maxHospitals) keepLocal(`線上檔案內容不合理（${n} 家）`);
  if (!(Date.parse(clean.meta.generatedAt) > Date.parse(local.meta?.generatedAt))) keepLocal('線上資料沒有比較新');
  fs.writeFileSync(LOCAL, JSON.stringify(clean));
  console.log(`沿用線上資料（${clean.meta.generatedAt}，${n} 家）`);
} catch (e) {
  keepLocal(`讀取線上檔案失敗：${e?.message || e}`);
}
