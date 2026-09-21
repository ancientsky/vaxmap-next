// 以模擬伺服器驗證 scripts/harvest.mjs：能取回全部院所、不超過表單欄位上限、輸出可被 normalize 使用
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { fileURLToPath } from 'node:url';
import { startMockSource } from './mock-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'data/raw');

test('harvest.mjs 從模擬來源取回全部院所', { timeout: 120000 }, async () => {
  const seed = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.json.gz')).sort().pop();
  const mock = await startMockSource(path.join(RAW_DIR, seed));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-'));
  try {
    fs.mkdirSync(path.join(tmp, 'data/raw'), { recursive: true });
    // 必須用非同步版本：模擬伺服器跑在同一個行程，execFileSync 會卡住事件迴圈
    await execFileAsync('node', [path.join(ROOT, 'scripts/harvest.mjs')], {
      cwd: tmp, env: { ...process.env, VAXMAP_BASE: mock.url, HARVEST_DELAY: '0' },
    });
    const out = fs.readdirSync(path.join(tmp, 'data/raw'));
    assert.equal(out.length, 1);
    assert.match(out[0], /^vaxmap_raw_\d{8}-\d{4}\.json\.gz$/);
    const got = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(tmp, 'data/raw', out[0]))));
    assert.equal(got.hospitals.length, mock.total);
    assert.equal(new Set(got.hospitals.map((h) => h.Id)).size, mock.total);
    assert.ok(got.hospitals.every((h) => !('InfoWindowMessage' in h) && !('DefaultVacc' in h)));
    assert.ok(Array.isArray(got.catalog) && got.catalog.length > 0);
    assert.ok(mock.stats.maxIds <= 1000, `ids[] 最多 ${mock.stats.maxIds}`);
    // 輸出可直接餵給 normalize.mjs
    execFileSync('node', [path.join(ROOT, 'scripts/normalize.mjs')], { cwd: tmp, stdio: 'pipe' });
    const norm = JSON.parse(fs.readFileSync(path.join(tmp, 'public/data/hospitals.json'), 'utf8'));
    assert.ok(norm.hospitals.length > 4000);
    console.log(`# 模擬擷取：${mock.stats.requests} 次請求，ids[] 最多 ${mock.stats.maxIds}`);
  } finally {
    mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
