// 安全性測試：資料清理（scripts/sanitize.mjs）、normalize／harvest／keep-live-data 對惡意來源的處理、
// 以及本地開發伺服器（scripts/dev-server.mjs）的路徑處理。
// 執行：node --test tests/security.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  cleanText, cleanTel, cleanHttpsUrl, cleanInt, cleanTimestamp, sanitizeDataset, sanitizeHospital, LIMITS,
} from '../scripts/sanitize.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/hospitals.json'), 'utf8'));
// 子行程不走代理（本測試只連本機）
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)));

// 不可見／控制字元以 String.fromCharCode 產生，避免原始碼內出現這些字元
const ch = (...codes) => String.fromCharCode(...codes);
const RLO = ch(0x202e), PDF = ch(0x202c), LRI = ch(0x2066), ZWSP = ch(0x200b), BOM = ch(0xfeff), NUL = ch(0), BEL = ch(7), ESC = ch(0x1b), LS = ch(0x2028);
const BAD_CHARS = new RegExp(`[${ch(0)}-${ch(0x1f)}${ch(0x7f)}-${ch(0x9f)}${ch(0x200b)}-${ch(0x200f)}${ch(0x2028)}-${ch(0x202e)}${ch(0x2066)}-${ch(0x2069)}${ch(0xfeff)}<>]`);

const vaccineIds = new Set(REAL.vaccines.map((v) => v.id));
const baseHospital = () => structuredClone(REAL.hospitals[0]);
const baseDataset = () => ({
  meta: { ...REAL.meta },
  vaccines: structuredClone(REAL.vaccines),
  groups: structuredClone(REAL.groups),
  hospitals: REAL.hospitals.slice(0, 5).map((h) => structuredClone(h)),
});

/* ------------------------------------------------------------------ *
 * sanitize.mjs：欄位層級
 * ------------------------------------------------------------------ */

test('cleanText：去除控制、bidi override、零寬字元與 < >，並限制長度', () => {
  assert.equal(cleanText(`EVIL${RLO}exe.txt${PDF}`, 100), 'EVILexe.txt');
  assert.equal(cleanText(`a${NUL}b${BEL}c${ESC}[31md`, 100), 'abc[31md');
  assert.equal(cleanText(`${BOM}${ZWSP}名稱${LRI}`, 100), '名稱');
  assert.equal(cleanText('a\nb\tc', 100), 'a b c');
  assert.equal(cleanText(`x${LS}y`, 100), 'xy');
  assert.equal(cleanText('<img src=x onerror=alert(1)>', 100), 'img src=x onerror=alert(1)');
  assert.equal(cleanText('臺'.repeat(500), 100).length, 100);
  assert.equal(cleanText(123, 10), undefined);
  assert.equal(cleanText({ toString: () => 'x' }, 10), undefined);
  assert.equal(cleanText(['a'], 10), undefined);
});

test('cleanTel：只留電話字元；javascript: 等無法湊出 3 位數字者丟棄；保留現有資料格式', () => {
  assert.equal(cleanTel('javascript:alert(1)'), undefined);
  assert.equal(cleanTel('javascript:alert(123)//'), '(123)//');
  assert.equal(cleanTel('07-5552565'), '07-5552565');
  assert.equal(cleanTel('(07)3485317~8'), '(07)3485317~8');
  assert.equal(cleanTel('02-2835-3456#5131或5132'), '02-2835-3456#5131或5132');
  assert.equal(cleanTel('02-1234-5678 分機 12'), '02-1234-5678 分機 12');
  assert.equal(cleanTel('02-1234-5678 轉 12'), '02-1234-5678 轉 12');
  assert.equal(cleanTel(`02${RLO}-1234<b>5678</b>`), '02-12345678/');
  assert.equal(cleanTel('1'.repeat(200)), undefined, '過長');
  assert.equal(cleanTel(null), undefined);
  // 現有資料的每一個電話都必須原樣保留
  for (const h of REAL.hospitals) {
    assert.equal(cleanTel(h.tel), h.tel, `tel ${h.id}`);
    if (h.apptTel) assert.equal(cleanTel(h.apptTel), h.apptTel, `apptTel ${h.id}`);
  }
});

test('cleanHttpsUrl：只接受 https、不含帳密與不可見字元', () => {
  assert.equal(cleanHttpsUrl('https://booking.example.tw/a?b=1'), 'https://booking.example.tw/a?b=1');
  for (const bad of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'http://example.tw/', '//evil.example/x',
    'https://user:pass@evil.example/', 'https://localhost/', `https://evil.example/${RLO}gpj.exe`,
    'https://evil.example/"><script>', 'https://ex ample.tw/', 'ftp://example.tw/', 'https://' + 'a'.repeat(600) + '.tw/',
    42, null, undefined, {},
  ]) assert.equal(cleanHttpsUrl(bad), undefined, String(bad));
});

test('cleanInt / cleanTimestamp：有限整數、合理時間', () => {
  assert.equal(cleanInt(5, 0, 7), 5);
  for (const bad of [NaN, Infinity, -1, 8, 1.5, '5', null, 2 ** 60]) assert.equal(cleanInt(bad, 0, 7), undefined, String(bad));
  const now = Date.parse('2026-09-21T00:00:00Z');
  assert.equal(cleanTimestamp('2026-09-20T00:00:00Z', now), '2026-09-20T00:00:00Z');
  assert.equal(cleanTimestamp('9999-12-31T00:00:00Z', now), undefined, '未來時間（會讓線上檔案永遠「比較新」）');
  assert.equal(cleanTimestamp('1999-01-01T00:00:00Z', now), undefined);
  assert.equal(cleanTimestamp('<img>', now), undefined);
  assert.equal(cleanTimestamp(1726000000000, now), undefined);
});

test('sanitizeHospital：必要欄位型別錯誤 → 捨棄；選填欄位不合格 → 略過；庫存與時段範圍', () => {
  const warns = [];
  const w = (m) => warns.push(m);
  assert.equal(sanitizeHospital({ ...baseHospital(), name: { $gt: '' } }, vaccineIds, w), null);
  assert.equal(sanitizeHospital({ ...baseHospital(), id: '1; DROP' }, vaccineIds, w), null);
  assert.equal(sanitizeHospital({ ...baseHospital(), lat: 'NaN' }, vaccineIds, w), null);
  assert.equal(sanitizeHospital({ ...baseHospital(), lng: 200 }, vaccineIds, w), null);
  assert.equal(sanitizeHospital({ ...baseHospital(), code: '<svg onload=1>' }, vaccineIds, w), null);
  assert.equal(sanitizeHospital({ ...baseHospital(), tel: 'javascript:alert(1)' }, vaccineIds, w), null);
  assert.equal(sanitizeHospital('not an object', vaccineIds, w), null);

  const h = sanitizeHospital({
    ...baseHospital(),
    name: `正常診所${RLO}txt.exe`,
    apptUrl: 'javascript:alert(1)',
    apptTel: 'javascript:alert(1)',
    note: `<b>備註</b>${NUL}`,
    hours: [7, 7, 7, 7, 7, 1, 99],
    stock: JSON.parse('{"__proto__":{"polluted":1},"flu":-5,"pcv20":1e12,"mod_adult":"12","antiviral":3.5,"evil<>":1,"novavax":10}'),
    extra: 'dropped',
  }, vaccineIds, w);
  assert.equal(h.name, '正常診所txt.exe');
  assert.equal(h.apptUrl, undefined);
  assert.equal(h.apptTel, undefined);
  assert.equal(h.note, 'b備註/b');
  assert.deepEqual(h.hours, [0, 0, 0, 0, 0, 0, 0], '任一時段不合格 → 全週視為休診');
  assert.deepEqual({ ...h.stock }, { flu: 0, novavax: 10 });
  assert.equal(Object.getPrototypeOf(h.stock), Object.prototype);
  assert.equal(({}).polluted, undefined);
  assert.equal('extra' in h, false);
  assert.ok(warns.length > 5);
});

/* ------------------------------------------------------------------ *
 * sanitize.mjs：資料集層級
 * ------------------------------------------------------------------ */

test('sanitizeDataset：現有 hospitals.json 清理後完全不變（冪等）', () => {
  assert.deepEqual(sanitizeDataset(REAL, { now: Date.parse(REAL.meta.generatedAt) + 1000 }), REAL);
});

test('sanitizeDataset：結構性錯誤整份拒絕', () => {
  const now = Date.parse(REAL.meta.generatedAt) + 1000;
  const cases = {
    notObject: () => sanitizeDataset('x', { now }),
    noHospitals: () => sanitizeDataset({ ...baseDataset(), hospitals: {} }, { now }),
    tooMany: () => sanitizeDataset({ ...baseDataset(), hospitals: new Array(LIMITS.maxHospitals + 1).fill({}) }, { now }),
    futureDate: () => sanitizeDataset({ ...baseDataset(), meta: { generatedAt: '2999-01-01T00:00:00Z' } }, { now }),
    badVaccineId: () => sanitizeDataset({ ...baseDataset(), vaccines: [{ id: '"><img src=x>', group: 'flu', name: 'x', short: 'x' }] }, { now }),
    protoVaccineId: () => sanitizeDataset({ ...baseDataset(), vaccines: [{ id: '__proto__', group: 'flu', name: 'x', short: 'x' }] }, { now }),
    unknownGroup: () => sanitizeDataset({ ...baseDataset(), vaccines: [{ id: 'x', group: 'nope', name: 'x', short: 'x' }] }, { now }),
    emptyVaccineName: () => sanitizeDataset({ ...baseDataset(), vaccines: [{ id: 'flu', group: 'flu', name: RLO, short: 'x' }] }, { now }),
  };
  for (const [k, fn] of Object.entries(cases)) assert.throws(fn, Error, k);
});

test('sanitizeDataset：只輸出契約內欄位，meta.count 重新計算，source 必須是 https', () => {
  const d = baseDataset();
  d.meta = { generatedAt: REAL.meta.generatedAt, source: 'javascript:alert(1)', count: 999999, evil: 1 };
  d.evil = '<script>';
  d.hospitals.push(null, { id: 'x' });
  const out = sanitizeDataset(d, { now: Date.parse(REAL.meta.generatedAt) + 1000 });
  assert.deepEqual(Object.keys(out), ['meta', 'vaccines', 'groups', 'hospitals']);
  assert.equal(out.meta.count, 5);
  assert.equal(out.meta.source, 'https://vaxmap.cdc.gov.tw/');
  assert.equal('evil' in out.meta, false);
});

/* ------------------------------------------------------------------ *
 * normalize.mjs：惡意原始檔
 * ------------------------------------------------------------------ */

function hostileRaw() {
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data/raw',
    fs.readdirSync(path.join(ROOT, 'data/raw')).filter((f) => f.endsWith('.json.gz')).sort().pop()))));
  const hs = raw.hospitals;
  hs[0].HospitalName = `<img src=x onerror=alert(1)>${RLO}診所`;
  hs[0].Address = { toString: 'x' };
  hs[1].Phone = 'javascript:alert(1)';
  hs[2].VaccData = [{ VaccineId: '流感疫苗', VaccInventory: 'NaN', AppointmentUrl: 'javascript:alert(1)', AppointmentPhone: 'javascript:alert(1)' }];
  hs[3].VaccData = [{ VaccineId: '流感疫苗', VaccInventory: 10, AppointmentUrl: 'JaVaScRiPt:alert(1)' }];
  hs[4].VaccData = [{ VaccineId: '流感疫苗', VaccInventory: 10, AppointmentUrl: 'http://insecure.example.tw/' }];
  hs[5].VaccData = [{ VaccineId: '流感疫苗', VaccInventory: 10, AppointmentUrl: 'https://booking.example.tw/ok' }];
  hs[6].Note = `注意${NUL}${ESC}[2J\n::error::fake`;
  hs[7].Lat = '25.0';
  hs[8].Lat = Infinity;
  hs[9].FluOperationTimeData = { Day1: 'seven', Day2: 7 };
  hs[10].VaccData = [{ VaccineId: '流感疫苗', VaccInventory: 1e15 }];
  hs[11].Id = '12<script>';
  hs.push(JSON.parse('{"__proto__":{"polluted":true},"Id":999999,"HospitalId":"9999999999","HospitalName":"x","Address":"臺北市中正區","Phone":"02-1234567","Lat":25.04,"Long":121.5}'));
  return raw;
}

test('normalize.mjs：惡意原始檔不會把危險內容寫進 hospitals.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-sec-'));
  try {
    fs.mkdirSync(path.join(tmp, 'data/raw'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'data/raw/vaxmap_raw_20990101-0000.json.gz'), zlib.gzipSync(JSON.stringify(hostileRaw())));
    const log = execFileSync('node', [path.join(ROOT, 'scripts/normalize.mjs')], { cwd: tmp, encoding: 'utf8' });
    assert.ok(!log.split('\n').some((l) => l.trimStart().startsWith('::')), '日誌中不得出現可被解讀為 workflow command 的行');
    const text = fs.readFileSync(path.join(tmp, 'public/data/hospitals.json'), 'utf8');
    const out = JSON.parse(text);
    assert.ok(!/javascript:|data:text|<img|<script/i.test(text), '輸出含危險字串（標籤與危險網址；純文字的 onerror= 無害，前端只用 textContent）');
    for (const h of out.hospitals) {
      for (const k of ['name', 'addr', 'tel', 'city', 'dist', 'code', 'apptTel', 'note']) {
        if (h[k] !== undefined) {
          assert.equal(typeof h[k], 'string', `${h.id}.${k}`);
          assert.ok(!BAD_CHARS.test(h[k]), `${h.id}.${k} 含控制／bidi 字元`);
        }
      }
      if (h.apptUrl !== undefined) assert.match(h.apptUrl, /^https:\/\//);
      assert.ok(Number.isSafeInteger(h.id));
      assert.ok(h.hours.every((x) => Number.isInteger(x) && x >= 0 && x <= 7));
      assert.ok(Object.values(h.stock).every((x) => Number.isSafeInteger(x) && x >= 0 && x <= LIMITS.maxStock));
    }
    assert.ok(out.hospitals.some((h) => h.apptUrl === 'https://booking.example.tw/ok'), 'https 預約網址應保留');
    assert.ok(!out.hospitals.some((h) => h.apptUrl?.startsWith('http:')), 'http 預約網址應捨棄');
    assert.ok(out.hospitals.length > 4000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('normalize.mjs：院所數超過上限時拒絕輸出', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-sec-'));
  try {
    fs.mkdirSync(path.join(tmp, 'data/raw'), { recursive: true });
    const raw = { harvestedAt: '2026-09-21T00:00:00Z', hospitals: new Array(LIMITS.maxHospitals + 1).fill({}) };
    fs.writeFileSync(path.join(tmp, 'data/raw/r.json.gz'), zlib.gzipSync(JSON.stringify(raw)));
    assert.throws(() => execFileSync('node', [path.join(ROOT, 'scripts/normalize.mjs')], { cwd: tmp, stdio: 'pipe' }));
    assert.equal(fs.existsSync(path.join(tmp, 'public/data/hospitals.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * harvest.mjs：惡意來源伺服器
 * ------------------------------------------------------------------ */

function startHostileSource(handler) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.end('<html>ok</html>'); return; }
    req.resume();
    req.on('end', () => handler(req, res));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); server.close(); } })));
}

async function runHarvest(url) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-sec-'));
  try {
    await execFileAsync('node', [path.join(ROOT, 'scripts/harvest.mjs')], {
      cwd: tmp, env: { ...CHILD_ENV, VAXMAP_BASE: url, HARVEST_DELAY: '0', HARVEST_MIN: '1' }, timeout: 60000,
    });
    const files = fs.existsSync(path.join(tmp, 'data/raw')) ? fs.readdirSync(path.join(tmp, 'data/raw')) : [];
    return { ok: true, raw: files.length ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(tmp, 'data/raw', files[0])))) : null };
  } catch (e) {
    return { ok: false, stderr: String(e.stderr || e.message) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('harvest.mjs：過大的回應（串流超過上限）會中止而不是整包讀進記憶體', { timeout: 90000 }, async () => {
  const src = await startHostileSource((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); // 不給 Content-Length，持續送資料
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let sent = 0;
    const pump = () => {
      while (sent < 64 && res.write(chunk)) sent++;
      if (sent < 64 && !res.destroyed) res.once('drain', pump); else res.end();
    };
    res.write('['); pump();
  });
  try {
    const r = await runHarvest(src.url);
    assert.equal(r.ok, false);
    assert.match(r.stderr, /回應過大/);
  } finally { src.close(); }
});

test('harvest.mjs：單頁筆數異常（遠超 20 筆）視為失敗', { timeout: 60000 }, async () => {
  const src = await startHostileSource((req, res) => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ Id: i + 1, Lat: 25, Long: 121.5 }));
    res.end(JSON.stringify(page));
  });
  try {
    const r = await runHarvest(src.url);
    assert.equal(r.ok, false);
    assert.match(r.stderr, /超過上限/);
  } finally { src.close(); }
});

test('harvest.mjs：__proto__ 鍵、非整數 Id、錯誤型別座標不會進入原始檔', { timeout: 60000 }, async () => {
  let served = false;
  const src = await startHostileSource((req, res) => {
    if (served) { res.end('[]'); return; }
    served = true;
    res.end('[{"Id":1,"Lat":25,"Long":121.5,"HospitalName":"ok","__proto__":{"Lat":0,"polluted":1}},' +
      '{"Id":"2<x>","Lat":25,"Long":121.5},{"Id":3,"Lat":"25","Long":121.5},{"Id":-4,"Lat":25,"Long":121.5}]');
  });
  try {
    const r = await runHarvest(src.url);
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.raw.hospitals.map((h) => h.Id), [1]);
    assert.equal(Object.getPrototypeOf(r.raw.hospitals[0]), Object.prototype);
    assert.equal('polluted' in r.raw.hospitals[0], false);
  } finally { src.close(); }
});

/* ------------------------------------------------------------------ *
 * keep-live-data.mjs：線上檔案同樣要清理
 * ------------------------------------------------------------------ */

function haveOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('keep-live-data.mjs：未來時間戳拒絕、危險欄位清掉後才寫入、非 https 網址拒絕', { skip: !haveOpenssl() && '沒有 openssl', timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-live-'));
  const key = path.join(tmp, 'k.pem'), cert = path.join(tmp, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  let body = '';
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${server.address().port}`;
  const localDir = path.join(tmp, 'public/data');
  fs.mkdirSync(localDir, { recursive: true });
  const localFile = path.join(localDir, 'hospitals.json');
  const older = { ...REAL, meta: { ...REAL.meta, generatedAt: '2026-01-01T00:00:00.000Z' } };
  const run = (arg) => execFileAsync('node', [path.join(ROOT, 'scripts/keep-live-data.mjs'), arg],
    { cwd: tmp, env: { ...CHILD_ENV, NODE_EXTRA_CA_CERTS: cert } });
  try {
    // 1) 未來時間戳：沿用本地
    fs.writeFileSync(localFile, JSON.stringify(older));
    body = JSON.stringify({ ...REAL, meta: { ...REAL.meta, generatedAt: '2999-01-01T00:00:00Z' } });
    let r = await run(base);
    assert.match(r.stdout, /沿用 repo 內的快照/);
    assert.equal(JSON.parse(fs.readFileSync(localFile, 'utf8')).meta.generatedAt, older.meta.generatedAt);

    // 2) 較新但含危險欄位：沿用線上，但以清理後內容寫入
    const poisoned = structuredClone(REAL);
    poisoned.hospitals[0].apptUrl = 'javascript:alert(1)';
    poisoned.hospitals[1].name = `<img src=x onerror=alert(1)>${RLO}`;
    poisoned.hospitals[2].stock = JSON.parse('{"__proto__":{"x":1},"flu":"9"}');
    poisoned.extra = 'x';
    body = JSON.stringify(poisoned);
    r = await run(base);
    assert.match(r.stdout, /沿用線上資料/);
    const written = fs.readFileSync(localFile, 'utf8');
    assert.ok(!/javascript:|<img|__proto__/.test(written));
    assert.ok(!BAD_CHARS.test(JSON.parse(written).hospitals[1].name));
    assert.equal('extra' in JSON.parse(written), false);

    // 3) 非 https 網址：不發出請求
    fs.writeFileSync(localFile, JSON.stringify(older));
    r = await run(base.replace('https:', 'http:'));
    assert.match(r.stdout, /必須是 https/);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * dev-server.mjs
 * ------------------------------------------------------------------ */

function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

function rawGet(port, rawPath) {
  // 用 net 直接送出請求行，確保 ..、%00、%2f 等不被用戶端正規化
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => {
      const [head] = buf.split('\r\n\r\n');
      const status = Number(head.split(' ')[1]);
      const loc = /\r\nlocation: *([^\r\n]*)/i.exec(head)?.[1];
      resolve({ status, loc, body: buf.slice(head.length + 4) });
    });
    sock.on('error', reject);
  });
}

test('dev-server.mjs：路徑穿越、NUL、反斜線、開放式轉址；預設只綁定 127.0.0.1；異常請求不會讓伺服器當掉', { timeout: 30000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.mjs')], {
    cwd: ROOT, env: { ...CHILD_ENV, PORT: String(port), HOST: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  try {
    const banner = await new Promise((resolve, reject) => {
      child.stdout.once('data', (d) => resolve(String(d)));
      child.once('exit', (c) => reject(new Error(`dev-server exited ${c}`)));
    });
    assert.match(banner, /bind: 127\.0\.0\.1/);
    const secret = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json',
      '/js/..%2f..%2fpackage.json', '/..%5cpackage.json', '/%5c..%5cpackage.json', '/index.html%00.png', '/%00',
      '//etc/passwd', '/%2fetc%2fpasswd', '/%ff', '/%0d%0aX-Injected:%201']) {
      const r = await rawGet(port, p);
      assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
      assert.ok(!r.body.includes(secret.slice(0, 40)), `${p} 洩漏 public/ 以外的檔案`);
      assert.ok(!/X-Injected/i.test(r.loc || ''), `${p} header injection`);
    }
    const redir = await rawGet(port, '/%2fevil.example%2f..%2fjs');
    assert.equal(redir.status, 301);
    assert.equal(redir.loc, '/js/', '不得產生 //evil.example 這類協定相對轉址');
    assert.equal((await rawGet(port, '/')).status, 200);
    assert.equal(exited, false, '伺服器不應因異常請求而結束');
  } finally {
    child.kill();
  }
});

/* ------------------------------------------------------------------ *
 * 第三方函式庫完整性
 * ------------------------------------------------------------------ */

test('public/vendor 內的 Leaflet／markercluster 與釘選的雜湊值（及 node_modules 原檔）一致', async () => {
  const { verifyVendor } = await import('../scripts/verify-vendor.mjs');
  assert.deepEqual(verifyVendor({ log: () => {} }), []);
});
