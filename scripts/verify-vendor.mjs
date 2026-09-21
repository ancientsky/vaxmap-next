#!/usr/bin/env node
// 檢查 public/vendor/ 底下的第三方檔案沒有被改動：
//   1) 與下方釘選的 SHA-256 相符（leaflet.js／leaflet.css 的值與 leafletjs.com 公布的 SRI 相同）；
//   2) 若已執行 npm ci（npm 會依 package-lock.json 的 sha512 驗證 tarball），再逐位元組比對 node_modules 內的原檔。
// 用法：node scripts/verify-vendor.mjs　（升級函式庫時請同步更新 EXPECTED 與 package-lock.json）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [public/ 內路徑, node_modules 內對應檔, sha256(base64)]
export const EXPECTED = [
  ['vendor/leaflet/leaflet.js', 'leaflet/dist/leaflet.js', '20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='],
  ['vendor/leaflet/leaflet.css', 'leaflet/dist/leaflet.css', 'p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='],
  // markercluster 沒有官方公布的雜湊值：以 npm ci 取得的 1.5.3 tarball（package-lock 的 sha512 已驗證）內檔案計算
  ['vendor/markercluster/leaflet.markercluster.js', 'leaflet.markercluster/dist/leaflet.markercluster.js', 'Hk4dIpcqOSb0hZjgyvFOP+cEmDXUKKNE/tT542ZbNQg='],
  ['vendor/markercluster/MarkerCluster.css', 'leaflet.markercluster/dist/MarkerCluster.css', 'YU3qCpj/P06tdPBJGPax0bm6Q1wltfwjsho5TR4+TYc='],
];

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64');
}

export function verifyVendor({ log = console.log } = {}) {
  const problems = [];
  for (const [rel, nm, pinned] of EXPECTED) {
    const file = path.join(ROOT, 'public', rel);
    if (!fs.existsSync(file)) { problems.push(`${rel} 不存在`); continue; }
    const got = sha256(file);
    if (got !== pinned) problems.push(`${rel} 的 SHA-256 為 ${got}，預期 ${pinned}`);
    const orig = path.join(ROOT, 'node_modules', nm);
    if (fs.existsSync(orig)) {
      if (!fs.readFileSync(orig).equals(fs.readFileSync(file))) problems.push(`${rel} 與 node_modules/${nm} 不同`);
    } else {
      log(`（略過與 node_modules/${nm} 的比對：尚未執行 npm ci）`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = verifyVendor();
  if (problems.length) { problems.forEach((p) => console.error('✗ ' + p)); process.exit(1); }
  console.log('✓ public/vendor 內的第三方檔案未被改動');
}
