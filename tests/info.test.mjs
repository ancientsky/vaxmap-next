// 接種資訊專區管線測試：harvest-info.mjs（解析、清理、雜湊、抓取失敗處理）、translate-info.mjs（模擬 API、
// 結構驗證、快取、無金鑰）、sanitize-info.mjs（驗證器）與 keep-live-data.mjs --info-dir。
// 前端的測試在 tests/info-ui.test.mjs。
// 執行：node --test tests/info.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildSource, projectSection, hashSection, normalizeCell } from '../scripts/harvest-info.mjs';
import { sanitizeInfo, validateInfo, cleanInfoHref, isAllowedInfoHost, INFO_LANGS } from '../scripts/sanitize-info.mjs';
import { checkShape, mergeTranslation, buildSystemPrompt, readGlossary, extractJson, DEFAULT_MODEL, PROVIDERS, loadCache, mergeCaches } from '../scripts/translate-info.mjs';
import { SUPPORTED_LANGS } from '../public/js/logic.js';
import { startMockTranslate } from './mock-translate.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'tests/fixtures/info-mpage.html'), 'utf8');
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|all_proxy|no_proxy|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_ACTIONS|TRANSLATE_.*|INFO_.*)$/i.test(k)));
const node = (script, args, opts) => execFileAsync('node', [path.join(ROOT, script), ...args], { ...opts, env: { ...CHILD_ENV, ...(opts?.env || {}) } });
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'info-'));
const NOW = new Date('2026-09-29T00:00:00Z');
// 不可見字元以 String.fromCharCode 產生，避免原始碼內出現這些字元
const RLO = String.fromCharCode(0x202e), ZWSP = String.fromCharCode(0x200b);

/** 以固定時間解析範例頁，產生 source.json 內容 */
const fixtureSource = () => buildSource(FIXTURE, { now: NOW }).doc;
/** 走訪所有 href */
const allHrefs = (doc) => doc.sections.flatMap((s) => [
  ...s.blocks.flatMap((b) => (b.runs || []).map((r) => r.href).filter(Boolean)),
  ...s.links.map((l) => l.href), ...s.files.map((f) => f.href),
]);

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */
test('harvest-info：範例頁解析出所有主題區塊', () => {
  const doc = fixtureSource();
  assert.ok(doc.sections.length >= 7, `只有 ${doc.sections.length} 個區塊`);
  assert.equal(doc.meta.sourceTitle, '115年度左流右新護肺顧心 疫苗接種專區');
  const keys = new Set(doc.sections.map((s) => s.key));
  for (const k of ['coins', 'eligibility', 'where', 'precautions', 'brands', 'education', 'news']) assert.ok(keys.has(k), `缺少 ${k}`);
  for (const s of doc.sections) {
    assert.match(s.id, /^\d+$/);
    assert.match(s.updated, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(s.hash, /^sha256:[0-9a-f]{64}$/);
  }
  assert.deepEqual(validateInfo(doc, { now: NOW.getTime() + 1000 }), []);
});

test('harvest-info：接種對象表格（第一／第二階段），符號統一為 ✓／✗', () => {
  const s = fixtureSource().sections.find((x) => x.key === 'eligibility');
  const tables = s.blocks.filter((b) => b.type === 'table');
  assert.equal(tables.length, 2);
  assert.ok(tables[0].rows.length >= 8, `第一階段只有 ${tables[0].rows.length} 列`);
  assert.match(tables[0].caption, /第一階段/);
  assert.match(tables[1].caption, /第二階段/);
  assert.deepEqual(tables[0].head, ['公費接種對象類別', '流感疫苗', '新冠疫苗']);
  for (const t of tables) for (const r of t.rows) {
    assert.equal(r.length, 3);
    for (const c of r.slice(1)) assert.match(c, /^[✓✗○]/, `儲存格 ${c}`);
  }
  assert.ok(tables[0].rows.some((r) => r[2] === '✗'));
  assert.equal(normalizeCell('●'), '✓');
  assert.equal(normalizeCell('✖'), '✗');
  assert.equal(normalizeCell('●另納入結核病'), '✓ 另納入結核病');
});

test('harvest-info：健康幣金額可從正文解析（流感 450／新冠 900／肺鏈 600）', () => {
  const s = fixtureSource().sections.find((x) => x.key === 'coins');
  const text = s.blocks.filter((b) => b.type === 'p').map((b) => b.text).join('\n');
  const amt = (re) => Number(re.exec(text)?.[1]);
  assert.equal(amt(/流感疫苗[^0-9]{0,10}(\d+)\s*幣/), 450);
  assert.equal(amt(/新冠疫苗[^0-9]{0,10}(\d+)\s*幣/), 900);
  assert.equal(amt(/肺炎鏈球菌疫苗[^0-9]{0,10}(\d+)\s*幣/), 600);
  const link = s.blocks.flatMap((b) => b.runs || []).find((r) => r.href);
  assert.equal(link.href, 'https://www.healthtoken.hpa.gov.tw/');
});

test('harvest-info：連結、附件、New 標記、清單層級、影片連結', () => {
  const secs = fixtureSource().sections;
  const pre = secs.find((x) => x.key === 'precautions');
  assert.equal(pre.files.length, 3);
  assert.ok(pre.files.every((f) => f.ext === 'pdf' && f.href.startsWith('https://www.cdc.gov.tw/File/Get/') && !/\.pdf$/.test(f.text)));
  assert.ok(pre.files.some((f) => f.text.includes('英文')));
  const news = secs.find((x) => x.key === 'news');
  assert.ok(news.links.length >= 5);
  assert.ok(news.links.filter((l) => l.isNew).length >= 1);
  assert.equal(new Set(news.links.map((l) => l.href + l.text)).size, news.links.length, '重複連結應合併');
  assert.ok(news.links.every((l) => !l.text.includes('Facebook')));
  const brands = secs.find((x) => x.key === 'brands');
  const list = brands.blocks.find((b) => b.type === 'list');
  assert.equal(list.levels.length, list.items.length);
  assert.ok(list.items.some((t) => t.includes('國光')));
  const where = secs.find((x) => x.key === 'where');
  const cityLinks = where.blocks.flatMap((b) => b.runs || []).filter((r) => r.href);
  assert.ok(cityLinks.length >= 40, `縣市連結 ${cityLinks.length}`);
  const faq = secs.find((x) => x.key === 'faq');
  assert.ok(faq.blocks.every((b) => b.runs?.[0]?.href), '問答的「說明＋裸網址」應合併為連結');
  // 「其他衛教推廣資源」：兩支 YouTube 影片（允許清單內）
  const videos = secs.find((x) => x.id === '103068');
  assert.equal(videos.links.length, 2);
  assert.ok(videos.links.every((l) => l.href.startsWith('https://www.youtube.com/watch?v=')));
});

test('harvest-info：所有 href 都是 https 且主機在允許清單；臺北市連結保留、短網址與 Google 文件丟棄', () => {
  const doc = fixtureSource();
  const hrefs = allHrefs(doc);
  assert.ok(hrefs.length > 40);
  for (const h of hrefs) {
    const u = new URL(h);
    assert.equal(u.protocol, 'https:');
    assert.ok(isAllowedInfoHost(u.hostname), h);
  }
  const where = doc.sections.find((x) => x.key === 'where');
  const taipei = where.blocks.flatMap((b) => b.runs || []).filter((r) => r.text.includes('臺北市') && r.href);
  assert.equal(taipei.length, 2, '流感與新冠兩份清單的臺北市連結');
  assert.ok(taipei.every((r) => new URL(r.href).hostname === 'health.gov.taipei'));
  const json = JSON.stringify(doc);
  assert.ok(!json.includes('reurl.cc') && !json.includes('docs.google.com'));
  // 彰化縣（短網址）與新竹市（Google 文件）：文字保留、沒有連結
  const runs = where.blocks.flatMap((b) => b.runs || []);
  assert.ok(runs.some((r) => r.text.includes('彰化縣') && !r.href));
});

test('harvest-info：雜湊穩定；內容不變時 changed=false 且 changedAt 沿用', () => {
  const a = buildSource(FIXTURE, { now: NOW }).doc;
  const b = buildSource(FIXTURE, { now: new Date('2026-09-30T00:00:00Z') });
  assert.deepEqual(a.sections.map((s) => s.hash), b.doc.sections.map((s) => s.hash));
  const again = buildSource(FIXTURE, { prev: a, now: new Date('2026-09-30T00:00:00Z') });
  assert.equal(again.changed, false);
  assert.equal(again.doc.meta.changedAt, a.meta.changedAt);
  assert.equal(again.doc.meta.fetchedAt, '2026-09-30T00:00:00.000Z');
  // 第一次：changedAt = 各區塊最後更新日期的最大值（臺北時間 00:00）
  assert.equal(a.meta.changedAt, '2026-09-22T16:00:00.000Z');
  // 改一個字 → 只有該區塊雜湊改變，changedAt = 抓取時間
  const edited = FIXTURE.replace('接種流感疫苗可獲得450幣', '接種流感疫苗可獲得500幣');
  const c = buildSource(edited, { prev: a, now: new Date('2026-10-01T00:00:00Z') });
  assert.equal(c.changed, true);
  assert.equal(c.doc.meta.changedAt, '2026-10-01T00:00:00.000Z');
  const diff = c.doc.sections.filter((s, i) => s.hash !== a.sections[i].hash).map((s) => s.key);
  assert.deepEqual(diff, ['coins']);
  // 只改網址：內容算變動（要重新部署），但雜湊不變（不必重新翻譯）
  const hrefOnly = FIXTURE.replace('https://www.mohw.gov.tw/cp-16-88052-1.html', 'https://www.mohw.gov.tw/cp-16-88052-2.html');
  const d = buildSource(hrefOnly, { prev: a, now: NOW });
  assert.equal(d.changed, true);
  assert.deepEqual(d.doc.sections.map((s) => s.hash), a.sections.map((s) => s.hash));
  assert.equal(hashSection(a.sections[0]), a.sections[0].hash);
});

const HOSTILE = `<!doctype html><html><head><title>t</title><style>.x{background:url(javascript:alert(1))}</style>
<script>window.evilScriptBody = 1</script></head><body>
<h2 class="con-title">惡意 測試頁</h2>
${Array.from({ length: 5 }, (_, i) => `
<div class="card card-default"><div class="card-heading" id="headingOne90${i}"><a href="#collapseOne90${i}"><h3 class="card-title"><span class="word">標題${i}<script>alert('t')</script></span></h3></a></div>
<div class="card-collapse collapse" id="collapseOne90${i}"><div class="card-body">
<p onclick="alert(1)" style="color:blue">正文 <a href="javascript:alert(1)" onmouseover="alert(2)">假連結</a> 與 <a href="data:text/html,<script>alert(1)</script>">資料連結</a>
與 <a href="//evil.example.com/x">協定相對</a> 與 <a href="https://www.cdc.gov.tw.evil.com/">偽裝主機</a> 與 <a href="https://user:pw@www.cdc.gov.tw/">帳密</a>
與 <a href="https://www.cdc.gov.tw:8443/">連接埠</a> 與 <a href="/Category/ok">正常相對</a> 與 <a href="http://www.cdc.gov.tw/">http</a>
與 <a href="https://youtube.com.evil.example/">假影片</a> 與 <a href="https://evilgov.taipei/">假臺北</a></p>
<img src=x onerror="alert(1)"><iframe src="https://evil.example.com/"></iframe><svg><script>alert(1)</script></svg>
<p>&lt;script&gt;alert(1)&lt;/script&gt; 文字${RLO}反轉${ZWSP}零寬</p>
<object data="x.swf"></object><form action="https://evil.example.com"><input name=a value="偷"></form>
<table><tr><th>欄</th></tr><tr><td onclick="x()">格<script>bad()</script></td></tr></table>
<p><span style="color: red">紅字備註</span></p>
<div class="download"><h3>連結</h3><p><a href="javascript:void(0)">壞連結</a></p><p><span style="color:red">New</span><a href="https://www.cdc.gov.tw/ok" onclick="x()">好連結</a></p></div>
<div class="download"><h3>附件</h3><p><a href="/File/Get/abc" title="檔.pdf(另開新視窗)">檔.pdf</a></p><p><a href="https://evil.example.com/a.pdf">外部檔</a></p></div>
<div class="date text-right">最後更新日期 2026/9/7</div>
</div></div></div>`).join('')}
</body></html>`;

test('harvest-info：惡意頁面 → script、事件屬性、javascript:/data: 網址、外部主機全部清掉', () => {
  const { doc } = buildSource(HOSTILE, { now: NOW });
  const json = JSON.stringify(doc);
  assert.equal(doc.sections.length, 5);
  for (const bad of ['javascript', 'data:', 'onclick', 'onerror', 'onmouseover', 'evilScriptBody', 'evil.example', 'cdc.gov.tw.evil', 'user:pw', '8443', 'bad()', '偷', 'http://', 'alert(\'t\')', 'evilgov.taipei']) {
    assert.ok(!json.includes(bad), `輸出含有 ${bad}`);
  }
  assert.ok(!new RegExp(`[<>${RLO}${ZWSP}]`).test(json), '輸出含有 < > 或不可見字元');
  const s = doc.sections[0];
  assert.equal(s.title, '標題0');
  assert.deepEqual(allHrefs({ sections: [s] }).sort(), [
    'https://www.cdc.gov.tw/Category/ok', 'https://www.cdc.gov.tw/File/Get/abc', 'https://www.cdc.gov.tw/ok',
  ]);
  assert.ok(s.blocks.some((b) => b.type === 'note' && b.text === '紅字備註'));
  assert.deepEqual(s.links, [{ text: '好連結', href: 'https://www.cdc.gov.tw/ok', isNew: true }]);
  assert.deepEqual(s.files, [{ text: '檔', href: 'https://www.cdc.gov.tw/File/Get/abc', ext: 'pdf', isNew: false }]);
  assert.ok(s.blocks.find((b) => b.type === 'table').rows[0][0] === '格');
});

test('harvest-info：區塊太少（頁面改版）→ 丟出例外；找不到 h2 標題時退回 <title>', () => {
  assert.throws(() => buildSource('<html><h2 class="con-title">x</h2><div class="card"></div></html>', { now: NOW }), /區塊/);
  assert.equal(buildSource(FIXTURE.replace('con-title', 'zz'), { now: NOW }).doc.meta.sourceTitle, '115年度左流右新護肺顧心 疫苗接種專區');
  assert.throws(() => buildSource(FIXTURE.replace('con-title', 'zz').replace(/<title>[^<]*<\/title>/, ''), { now: NOW }), /標題/);
});

/* ------------------------------------------------------------------ *
 * 抓取（模擬伺服器）
 * ------------------------------------------------------------------ */
function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}/page`, close: () => server.close() })));
}

test('harvest-info.mjs：抓取成功 → changed；再抓一次 → unchanged；失敗時不寫檔', { timeout: 60000 }, async () => {
  let status = 200;
  let body = FIXTURE;
  const srv = await serve((req, res) => { res.statusCode = status; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(body); });
  const dir = tmpdir();
  const env = { INFO_URL: srv.url, INFO_OUT_DIR: dir, INFO_RETRY_MS: '10', INFO_TIMEOUT_MS: '3000' };
  try {
    const a = await node('scripts/harvest-info.mjs', [], { env });
    assert.match(a.stdout.trim().split('\n').pop(), /^changed$/);
    assert.match(a.stdout, /reurl\.cc×1/, '記錄應列出被丟棄的主機');
    const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
    assert.ok(src.sections.length >= 7);
    const b = await node('scripts/harvest-info.mjs', [], { env });
    assert.match(b.stdout.trim().split('\n').pop(), /^unchanged$/);
    const before = fs.readFileSync(path.join(dir, 'source.json'), 'utf8');

    status = 503;
    await assert.rejects(node('scripts/harvest-info.mjs', [], { env }), (e) => /HTTP 503/.test(e.stderr) && e.code === 1);
    assert.equal(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'), before, '失敗時不得改寫 source.json');

    status = 200; body = '<html><body>維護中</body></html>';
    await assert.rejects(node('scripts/harvest-info.mjs', [], { env }), (e) => /結構/.test(e.stderr));
    assert.equal(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'), before);

    body = 'x'.repeat(4 * 1024 * 1024);
    await assert.rejects(node('scripts/harvest-info.mjs', [], { env }), (e) => /過大/.test(e.stderr));

    await assert.rejects(node('scripts/harvest-info.mjs', [], { env: { ...env, INFO_URL: 'http://example.com/' } }), (e) => /https/.test(e.stderr));
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('harvest-info.mjs：逾時 → 失敗且不寫檔', { timeout: 30000 }, async () => {
  const srv = await serve(() => { /* 永不回應 */ });
  const dir = tmpdir();
  try {
    await assert.rejects(node('scripts/harvest-info.mjs', [], { env: { INFO_URL: srv.url, INFO_OUT_DIR: dir, INFO_RETRY_MS: '10', INFO_TIMEOUT_MS: '500' } }),
      (e) => e.code === 1 && /擷取失敗/.test(e.stderr));
    assert.ok(!fs.existsSync(path.join(dir, 'source.json')));
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 翻譯
 * ------------------------------------------------------------------ */
function setupDirs() {
  const dir = tmpdir();
  const data = path.join(dir, 'data');
  const pub = path.join(dir, 'pub');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'source.json'), JSON.stringify(fixtureSource()));
  return { dir, data, pub, env: { INFO_DATA_DIR: data, INFO_PUBLIC_DIR: pub, TRANSLATE_BACKOFF_MS: '10' } };
}
const readLang = (pub, l) => JSON.parse(fs.readFileSync(path.join(pub, `${l}.json`), 'utf8'));

test('translate-info.mjs：沒有金鑰 → 8 個檔都產生，未翻譯區塊帶原文、partial，結束代碼 0', async () => {
  const { dir, pub, env } = setupDirs();
  try {
    const r = await node('scripts/translate-info.mjs', [], { env });
    assert.match(r.stdout, /未設定 GEMINI_API_KEY（TRANSLATE_PROVIDER=gemini）/);
    const files = fs.readdirSync(pub).sort();
    assert.deepEqual(files, INFO_LANGS.map((l) => `${l}.json`).sort());
    const zh = readLang(pub, 'zh-Hant');
    assert.equal(zh.meta.translation, 'source');
    assert.ok(zh.sections.every((s) => s.translated));
    for (const l of INFO_LANGS.filter((x) => x !== 'zh-Hant')) {
      const d = readLang(pub, l);
      assert.equal(d.meta.lang, l);
      assert.equal(d.meta.translation, 'partial');
      assert.equal(d.meta.title, zh.meta.sourceTitle);
      assert.ok(d.sections.every((s) => s.translated === false));
      assert.deepEqual(d.sections.map((s) => s.blocks), zh.sections.map((s) => s.blocks));
      assert.deepEqual(validateInfo(d), []);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translate-info.mjs（anthropic）：模擬 API → 7 種語言全數翻譯、網址不變；第二次執行 0 個請求', { timeout: 60000 }, async () => {
  const mock = await startMockTranslate();
  const { dir, data, pub, env } = setupDirs();
  const e = { ...env, TRANSLATE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-key', TRANSLATE_ENDPOINT: mock.url };
  try {
    const r = await node('scripts/translate-info.mjs', [], { env: e });
    const src = fixtureSource();
    const units = src.sections.length + 1; // + 頁面標題
    assert.equal(mock.stats.requests, units * 7);
    assert.equal(mock.stats.lastBody.model, PROVIDERS.anthropic.model);
    assert.equal(mock.stats.byApi.anthropic, mock.stats.requests);
    assert.deepEqual(mock.stats.lastBody.output_config, { effort: 'low' });
    assert.match(r.stdout, /tokens/);
    for (const l of ['en', 'ja', 'ko', 'id', 'vi', 'th', 'tl']) {
      assert.equal(mock.stats.byLang[l], units);
      const d = readLang(pub, l);
      assert.equal(d.meta.translation, 'machine');
      assert.ok(d.meta.translatedAt);
      assert.equal(d.meta.title, `[${l}] ${src.meta.sourceTitle}`);
      assert.ok(d.sections.every((s) => s.translated && s.title.startsWith(`[${l}] `)));
      assert.deepEqual(allHrefs(d), allHrefs(src));
      assert.deepEqual(d.sections.map((s) => s.hash), src.sections.map((s) => s.hash));
      const elig = d.sections.find((s) => s.key === 'eligibility').blocks[0];
      assert.ok(elig.rows.every((row) => row[1] === '✓'));
      const p = d.sections[0].blocks.find((b) => b.type === 'p');
      assert.equal(p.text, p.runs.map((x) => x.text).join(''));
      assert.deepEqual(validateInfo(d), []);
    }
    const cache = JSON.parse(fs.readFileSync(path.join(data, 'translations.json'), 'utf8'));
    assert.equal(Object.keys(cache).length, units);
    // 第二次：全部命中快取
    const before = mock.stats.requests;
    const r2 = await node('scripts/translate-info.mjs', [], { env: e });
    assert.equal(mock.stats.requests, before);
    assert.match(r2.stdout, /不需呼叫 API/);
    // --force 單一區塊、單一語言 → 只重送 1 個請求
    const id = src.sections[2].id;
    await node('scripts/translate-info.mjs', ['--force', id, '--lang', 'ja'], { env: e });
    assert.equal(mock.stats.requests, before + 1);
    // 來源某區塊改變 → 只有那個區塊（×7 語言）重送
    const changed = buildSource(FIXTURE.replace('450幣', '500幣'), { now: NOW }).doc;
    fs.writeFileSync(path.join(data, 'source.json'), JSON.stringify(changed));
    await node('scripts/translate-info.mjs', [], { env: e });
    assert.equal(mock.stats.requests, before + 1 + 7);
    const cache2 = JSON.parse(fs.readFileSync(path.join(data, 'translations.json'), 'utf8'));
    assert.equal(Object.keys(cache2).length, units, '舊雜湊應被清掉');
  } finally {
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translate-info.mjs：結構不符 → 重試一次，仍不符則保留原文（translated:false）', { timeout: 60000 }, async () => {
  const mock = await startMockTranslate({ mode: 'bad-shape' });
  const { dir, pub, env } = setupDirs();
  try {
    await node('scripts/translate-info.mjs', [], { env: { ...env, TRANSLATE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', TRANSLATE_ENDPOINT: mock.url, TRANSLATE_LANGS: 'en' } });
    const src = fixtureSource();
    assert.equal(mock.stats.requests, (src.sections.length + 1) * 2, '每個區塊應恰好重試一次');
    const en = readLang(pub, 'en');
    assert.equal(en.meta.translation, 'partial');
    assert.ok(en.sections.every((s) => s.translated === false));
    assert.deepEqual(en.sections.map((s) => s.title), src.sections.map((s) => s.title));
  } finally {
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translate-info.mjs：第一次結構錯、重試成功；回覆帶 ``` 圍欄也能解析', { timeout: 60000 }, async () => {
  for (const mode of ['bad-once', 'fence']) {
    const mock = await startMockTranslate({ mode });
    const { dir, pub, env } = setupDirs();
    try {
      await node('scripts/translate-info.mjs', [], { env: { ...env, TRANSLATE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', TRANSLATE_ENDPOINT: mock.url, TRANSLATE_LANGS: 'ko' } });
      const ko = readLang(pub, 'ko');
      assert.ok(ko.sections.every((s) => s.translated), mode);
      assert.equal(ko.meta.translation, 'machine');
      assert.equal(readLang(pub, 'en').meta.translation, 'partial', '未列入 TRANSLATE_LANGS 的語言維持原文');
      if (mode === 'bad-once') assert.equal(mock.stats.retries, fixtureSource().sections.length + 1);
    } finally {
      mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('translate-info.mjs（anthropic）：金鑰無效（401）→ 立即停止、仍輸出原文檔、結束代碼 0', { timeout: 60000 }, async () => {
  const mock = await startMockTranslate({ mode: 'unauthorized' });
  const { dir, pub, env } = setupDirs();
  try {
    const r = await node('scripts/translate-info.mjs', [], { env: { ...env, TRANSLATE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'bad-secret-key', TRANSLATE_ENDPOINT: mock.url, TRANSLATE_CONCURRENCY: '1' } });
    assert.match(r.stderr, /翻譯中止.*ANTHROPIC_API_KEY/);
    assert.ok(mock.stats.requests <= 2);
    assert.equal(fs.readdirSync(pub).length, 8);
    assert.ok(!r.stdout.includes('bad-secret-key') && !r.stderr.includes('bad-secret-key'), '金鑰不得出現在記錄中');
  } finally {
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translate-info.mjs：TRANSLATE_ENDPOINT 只接受 https（本機測試除外）', async () => {
  const { dir, env } = setupDirs();
  try {
    await assert.rejects(node('scripts/translate-info.mjs', [], { env: { ...env, TRANSLATE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', TRANSLATE_ENDPOINT: 'http://example.com/v1/messages' } }), /https/);
    await assert.rejects(node('scripts/translate-info.mjs', [], { env: { ...env, GEMINI_API_KEY: 'k', TRANSLATE_ENDPOINT: 'http://example.com/v1beta' } }), /https/);
    await assert.rejects(node('scripts/translate-info.mjs', [], { env: { ...env, GEMINI_API_KEY: 'k', TRANSLATE_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta?key=abc' } }), /查詢字串/);
    await assert.rejects(node('scripts/translate-info.mjs', [], { env: { ...env, TRANSLATE_PROVIDER: 'openai' } }), /TRANSLATE_PROVIDER/);
    await assert.rejects(node('scripts/translate-info.mjs', [], { env: { ...env, GEMINI_API_KEY: 'k', TRANSLATE_MODEL: '../../x' } }), /TRANSLATE_MODEL/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* Gemini（預設翻譯服務） */
test('translate-info.mjs（gemini，預設）：金鑰只在 x-goog-api-key 標頭、JSON 回應模式；7 語言全數翻譯、快取命中後 0 請求', { timeout: 60000 }, async () => {
  const mock = await startMockTranslate();
  const { dir, data, pub, env } = setupDirs();
  const e = { ...env, GEMINI_API_KEY: 'gem-secret-key-123', TRANSLATE_ENDPOINT: mock.geminiUrl };
  try {
    const r = await node('scripts/translate-info.mjs', [], { env: e });
    const src = fixtureSource();
    const units = src.sections.length + 1;
    assert.equal(DEFAULT_MODEL, 'gemini-3.5-flash-lite');
    assert.equal(mock.stats.byApi.gemini, units * 7);
    assert.equal(mock.stats.byApi.anthropic, undefined);
    assert.equal(mock.stats.keyInUrl, 0, '金鑰不得放在網址');
    assert.deepEqual([...mock.stats.keysSeen], ['gem-secret-key-123']);
    assert.equal(mock.stats.lastPath, '/v1beta/models/gemini-3.5-flash-lite:generateContent');
    const b = mock.stats.lastBody;
    assert.equal(b.generationConfig.responseMimeType, 'application/json');
    assert.equal(b.generationConfig.temperature, undefined, '預設不送 temperature（Gemini 3 建議維持預設值）');
    assert.ok(b.generationConfig.maxOutputTokens > 0);
    assert.match(b.systemInstruction.parts[0].text, /TARGET_LANGUAGE_CODE: \w+/);
    assert.match(b.systemInstruction.parts[0].text, /Health Coins/);
    assert.equal(b.contents.length, 1);
    assert.equal(b.contents[0].role, 'user');
    assert.ok(!('model' in b), 'Gemini 的模型只在網址路徑');
    assert.match(r.stdout, /gemini，模型 gemini-3\.5-flash-lite/);
    assert.match(r.stdout, /US\$/, '有 gemini-3.5-flash-lite 的費用估算');
    assert.ok(!r.stdout.includes('gem-secret-key-123') && !r.stderr.includes('gem-secret-key-123'));
    for (const l of ['en', 'ja', 'ko', 'id', 'vi', 'th', 'tl']) {
      const d = readLang(pub, l);
      assert.equal(d.meta.translation, 'machine');
      assert.deepEqual(allHrefs(d), allHrefs(src));
      assert.deepEqual(validateInfo(d), []);
    }
    const cache = JSON.parse(fs.readFileSync(path.join(data, 'translations.json'), 'utf8'));
    assert.equal(Object.values(cache)[0].en.model, 'gemini-3.5-flash-lite');
    const before = mock.stats.requests;
    const r2 = await node('scripts/translate-info.mjs', [], { env: e });
    assert.equal(mock.stats.requests, before);
    assert.match(r2.stdout, /不需呼叫 API/);
    // TRANSLATE_TEMPERATURE 明確設定時才送出
    await node('scripts/translate-info.mjs', ['--force', 'title', '--lang', 'en'], { env: { ...e, TRANSLATE_TEMPERATURE: '0.2' } });
    assert.equal(mock.stats.lastBody.generationConfig.temperature, 0.2);
  } finally {
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translate-info.mjs（gemini）：結構不符重試一次（contents 帶 model 回覆＋驗證錯誤）；圍欄也能解析', { timeout: 60000 }, async () => {
  for (const mode of ['bad-once', 'bad-shape', 'fence']) {
    const mock = await startMockTranslate({ mode });
    const { dir, pub, env } = setupDirs();
    try {
      await node('scripts/translate-info.mjs', [], { env: { ...env, GEMINI_API_KEY: 'k', TRANSLATE_ENDPOINT: mock.geminiUrl, TRANSLATE_LANGS: 'th' } });
      const th = readLang(pub, 'th');
      const n = fixtureSource().sections.length + 1;
      if (mode === 'bad-shape') {
        assert.equal(mock.stats.requests, n * 2);
        assert.ok(th.sections.every((s) => s.translated === false));
      } else {
        assert.ok(th.sections.every((s) => s.translated), mode);
      }
      if (mode === 'bad-once') {
        assert.equal(mock.stats.retries, n);
        const c = mock.stats.lastBody.contents;
        assert.deepEqual(c.map((x) => x.role), ['user', 'model', 'user']);
        assert.match(c[2].parts[0].text, /rejected by the validator/);
      }
    } finally {
      mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('translate-info.mjs（gemini）：金鑰無效（400 API_KEY_INVALID）／403 → 立即停止並提示 GEMINI_API_KEY；金鑰不入記錄', { timeout: 60000 }, async () => {
  for (const mode of ['unauthorized', 'forbidden']) {
    const mock = await startMockTranslate({ mode });
    const { dir, pub, env } = setupDirs();
    try {
      const r = await node('scripts/translate-info.mjs', [], { env: { ...env, GEMINI_API_KEY: 'bad-gemini-secret', TRANSLATE_ENDPOINT: mock.geminiUrl, TRANSLATE_CONCURRENCY: '1', GITHUB_ACTIONS: 'true' } });
      assert.match(r.stderr, /翻譯中止.*GEMINI_API_KEY.*Actions secret/, mode);
      assert.ok(mock.stats.requests <= 1, `${mode}：${mock.stats.requests} 次請求`);
      assert.equal(fs.readdirSync(pub).length, 8);
      assert.ok(!(r.stdout + r.stderr).includes('bad-gemini-secret'));
    } finally {
      mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // 模型名稱錯誤（404）→ 立即停止並提示 TRANSLATE_MODEL
  const mock = await startMockTranslate();
  const { dir, env } = setupDirs();
  try {
    const r = await node('scripts/translate-info.mjs', [], { env: { ...env, GEMINI_API_KEY: 'k', TRANSLATE_ENDPOINT: mock.geminiUrl, TRANSLATE_MODEL: 'no-such-model', TRANSLATE_CONCURRENCY: '1' } });
    assert.match(r.stderr, /翻譯中止.*404.*TRANSLATE_MODEL/);
    assert.equal(mock.stats.requests, 1);
  } finally {
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translate-info.mjs（gemini）：429 → 依 RetryInfo 退避後成功；一直 429（配額用完）→ 停止其餘請求', { timeout: 60000 }, async () => {
  {
    const mock = await startMockTranslate({ mode: 'rate-once' });
    const { dir, pub, env } = setupDirs();
    try {
      const r = await node('scripts/translate-info.mjs', [], { env: { ...env, GEMINI_API_KEY: 'k', TRANSLATE_ENDPOINT: mock.geminiUrl, TRANSLATE_LANGS: 'en,vi' } });
      assert.equal(mock.stats.rateLimited, 2);
      assert.match(r.stderr, /秒後重試/);
      assert.equal(readLang(pub, 'en').meta.translation, 'machine');
      assert.equal(readLang(pub, 'vi').meta.translation, 'machine');
    } finally {
      mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const mock = await startMockTranslate({ mode: 'quota' });
  const { dir, pub, env } = setupDirs();
  try {
    const r = await node('scripts/translate-info.mjs', [], { env: { ...env, GEMINI_API_KEY: 'k', TRANSLATE_ENDPOINT: mock.geminiUrl, TRANSLATE_CONCURRENCY: '1' } });
    assert.match(r.stderr, /翻譯中止.*429.*配額/);
    assert.equal(mock.stats.requests, 5, '只對第一個區塊試 5 次，其餘不送');
    assert.equal(readLang(pub, 'en').meta.translation, 'partial');
  } finally {
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translate-info.mjs --merge-cache：人工譯文優先、其他只補缺、非法鍵丟棄', async () => {
  const { dir, data, env } = setupDirs();
  try {
    const H = (c) => 'sha256:' + c.repeat(64);
    fs.writeFileSync(path.join(data, 'translations.json'), JSON.stringify({
      [H('a')]: { en: { title: 'machine A', model: 'm' }, ja: { title: 'machine A ja', model: 'm' } },
      [H('b')]: { en: { title: 'machine B', model: 'm' } },
    }));
    const repo = path.join(dir, 'repo-translations.json');
    fs.writeFileSync(repo, `{"${H('a')}":{"en":{"title":"manual A","source":"manual"},"ja":{"title":"old repo ja"}},"${H('c')}":{"vi":{"title":"repo C"}},"__proto__":{"en":{"polluted":1}},"bad":{"en":{}}}`);
    const r = await node('scripts/translate-info.mjs', ['--merge-cache', repo], { env });
    assert.match(r.stdout, /人工譯文 1 筆優先，補上 1 筆/);
    const out = JSON.parse(fs.readFileSync(path.join(data, 'translations.json'), 'utf8'));
    assert.equal(out[H('a')].en.title, 'manual A');
    assert.equal(out[H('a')].ja.title, 'machine A ja', '非人工的項目不覆蓋 data 分支上的譯文');
    assert.equal(out[H('b')].en.title, 'machine B');
    assert.equal(out[H('c')].vi.title, 'repo C');
    assert.deepEqual(Object.keys(out).sort(), [H('a'), H('b'), H('c')]);
    assert.equal({}.polluted, undefined);
    // 函式介面
    const base = loadCache(path.join(data, 'translations.json'));
    assert.deepEqual(mergeCaches(base, new Map()), { manual: 0, added: 0 });
    // data 分支還沒有快取 → 合併結果就是 repo 的那份
    fs.rmSync(path.join(data, 'translations.json'));
    await node('scripts/translate-info.mjs', ['--merge-cache', repo], { env });
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'translations.json'), 'utf8'))[H('a')].en.title, 'manual A');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkShape：區塊數、型別、符號儲存格、數字、網址', () => {
  const src = projectSection(fixtureSource().sections.find((s) => s.key === 'eligibility'));
  assert.equal(checkShape(src, structuredClone(src)), null);
  const drop = structuredClone(src); drop.blocks.pop();
  assert.match(checkShape(src, drop), /blocks 應有 2 項/);
  const type = structuredClone(src); type.blocks[0].type = 'p';
  assert.match(checkShape(src, type), /type/);
  const sym = structuredClone(src); sym.blocks[0].rows[0][1] = 'Yes';
  assert.match(checkShape(src, sym), /符號/);
  const cell = structuredClone(src); cell.blocks[0].rows[0][1] = 7;
  assert.match(checkShape(src, cell), /字串/);
  const extra = structuredClone(src); extra.blocks[0].note = 'x';
  assert.match(checkShape(src, extra), /欄位/);
  assert.match(checkShape({ t: '65歲以上長者' }, { t: 'Seniors aged sixty-five' }), /65/);
  assert.equal(checkShape({ t: '65歲以上長者' }, { t: 'Seniors aged 65+' }), null);
  assert.equal(checkShape({ t: '自12月1日起開放' }, { t: 'From December 1' }), null, '月／日數字可改寫為月份名稱');
  assert.match(checkShape({ t: '每劑0.5mL' }, { t: 'per dose 5 mL' }), /0\.5/);
  assert.equal(checkShape({ t: '每劑0.5mL' }, { t: 'mỗi liều 0,5 mL' }), null, '小數逗號視同小數點');
  assert.match(checkShape({ t: '見 https://www.cdc.gov.tw/a' }, { t: 'see the site' }), /網址/);
  assert.match(checkShape({ t: '文字' }, { t: '<b>x</b>' }), /< 或 >/);
  assert.match(checkShape({ t: '文字' }, { t: '' }), /空字串/);
});

test('mergeTranslation：只換文字，href／id／isNew／ext 取自原文', () => {
  const s = fixtureSource().sections.find((x) => x.key === 'coins');
  const proj = projectSection(s);
  const tr = JSON.parse(JSON.stringify(proj).replace(/"text":"/g, '"text":"T:').replace(/"title":"/, '"title":"T:'));
  const m = mergeTranslation(s, tr);
  assert.equal(m.id, s.id);
  assert.equal(m.hash, s.hash);
  assert.equal(m.translated, true);
  assert.ok(m.title.startsWith('T:'));
  assert.deepEqual(m.links.map((l) => l.href), s.links.map((l) => l.href));
  const p = m.blocks[2];
  assert.equal(p.text, p.runs.map((r) => r.text).join(''));
  assert.equal(p.runs[1].href, s.blocks[2].runs[1].href);
});

test('提示詞：含 docs/I18N.md 詞彙表、品牌、口號與目標語言代碼；extractJson 容錯', () => {
  const g = readGlossary();
  assert.ok(g.length >= 10, `詞彙表只有 ${g.length} 行`);
  assert.ok(g.some((l) => l.includes('publicly funded')));
  const sys = buildSystemPrompt('ja');
  for (const s of ['TARGET_LANGUAGE_CODE: ja', 'Japanese', 'Medigen', 'Adimmune', 'TTY Biopharm', 'Sanofi', 'GSK', 'Moderna', 'Nuvaxovid',
    'Health Coins', 'vaccine bonus', 'publicly funded', 'flu shot in the left arm, COVID-19 in the right', 'pneumococcal']) {
    assert.ok(sys.includes(s), `提示詞缺少 ${s}`);
  }
  assert.deepEqual(extractJson('好的：\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJson('no json'));
});

/* ------------------------------------------------------------------ *
 * 驗證器
 * ------------------------------------------------------------------ */
test('sanitize-info：語言清單與前端一致；主機允許清單與 INFO_SCHEMA 一致', () => {
  assert.deepEqual([...INFO_LANGS], [...SUPPORTED_LANGS]);
  for (const ok of ['https://gov.tw/SWK', 'https://www.healthtoken.hpa.gov.tw/', 'https://health.gov.taipei/cp.aspx?n=1',
    'https://www.youtube.com/watch?v=i9sFsyunSfw', 'https://youtu.be/i9sFsyunSfw']) {
    assert.ok(cleanInfoHref(ok), `應允許 ${ok}`);
  }
  for (const bad of ['https://evilgov.tw/', 'https://www.cdc.gov.tw./', 'https://gov.taipei/', 'https://evilgov.taipei/', 'https://youtube.com/watch?v=x',
    'https://m.youtube.com/watch?v=x', 'https://www.youtube.com.evil.example/', 'https://reurl.cc/8Y7kvd', 'https://docs.google.com/spreadsheets/d/x',
    'http://www.youtube.com/watch?v=x', 'https://www.youtube.com:444/']) {
    assert.equal(cleanInfoHref(bad), undefined, `應拒絕 ${bad}`);
  }
});

test('sanitize-info：驗證器拒絕不合格的檔案', () => {
  const good = () => {
    const d = fixtureSource();
    return { ...d, meta: { ...d.meta, lang: 'en', translation: 'partial' }, sections: d.sections.map((s) => ({ ...s, translated: false })) };
  };
  assert.deepEqual(validateInfo(good()), []);
  const cases = [
    ['文字含 <', (d) => { d.sections[0].title = '<img src=x onerror=alert(1)>'; }],
    ['javascript: 連結', (d) => { d.sections[0].links[0].href = 'javascript:alert(1)'; }],
    ['非允許主機', (d) => { d.sections[0].links[0].href = 'https://evil.example.com/'; }],
    ['段落連結非允許主機', (d) => { d.sections[0].blocks[2].runs[1].href = 'https://evil.example.com/'; }],
    ['http 連結', (d) => { d.sections[0].links[0].href = 'http://www.cdc.gov.tw/'; }],
    ['日期格式', (d) => { d.sections[0].updated = '2026/9/23'; }],
    ['不存在的日期', (d) => { d.sections[0].updated = '2026-02-30'; }],
    ['未來時間', (d) => { d.meta.fetchedAt = '2099-01-01T00:00:00Z'; }],
    ['非 ISO 時間', (d) => { d.meta.changedAt = 'yesterday'; }],
    ['未知 lang', (d) => { d.meta.lang = 'xx'; }],
    ['未知 translation', (d) => { d.meta.translation = 'human'; }],
    ['多出欄位', (d) => { d.sections[0].html = '<b>'; }],
    ['未知區塊型別', (d) => { d.sections[0].blocks.push({ type: 'html', text: 'x' }); }],
    ['hash 格式', (d) => { d.sections[0].hash = 'md5:1'; }],
    ['id 格式', (d) => { d.sections[0].id = '__proto__'; }],
    ['id 重複', (d) => { d.sections[1].id = d.sections[0].id; }],
    ['區塊過多', (d) => { d.sections = Array.from({ length: 61 }, (_, i) => ({ ...d.sections[0], id: String(i) })); }],
    ['文字過長', (d) => { d.sections[0].title = '長'.repeat(400); }],
    ['p.text 與 runs 不一致', (d) => { d.sections[0].blocks[0].text = '別的'; }],
    ['控制字元', (d) => { d.sections[0].title = `a${RLO}b`; }],
    ['translated 不是布林', (d) => { d.sections[0].translated = 'yes'; }],
    ['meta 缺少', (d) => { delete d.meta; }],
  ];
  for (const [what, mutate] of cases) {
    const d = good();
    mutate(d);
    assert.ok(validateInfo(d).length > 0, `應拒絕：${what}`);
  }
  assert.throws(() => sanitizeInfo(good(), { lang: 'ja' }), /預期 ja/);
});

test('sanitize-info.mjs --check：合格結束代碼 0、不合格 1', async () => {
  const dir = tmpdir();
  try {
    const d = fixtureSource();
    fs.writeFileSync(path.join(dir, 'zh-Hant.json'), JSON.stringify(d));
    await node('scripts/sanitize-info.mjs', ['--check', path.join(dir, 'zh-Hant.json')]);
    fs.writeFileSync(path.join(dir, 'en.json'), JSON.stringify(d)); // meta.lang 與檔名不符
    await assert.rejects(node('scripts/sanitize-info.mjs', ['--check', path.join(dir, 'en.json')]), (e) => e.code === 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * keep-live-data.mjs --info-dir（部署時從 data 分支取用）
 * ------------------------------------------------------------------ */
test('keep-live-data.mjs --info-dir：只採用通過驗證且較新的檔案', async () => {
  const dir = tmpdir();
  const repo = path.join(dir, 'repo');
  const incoming = path.join(dir, 'in');
  fs.mkdirSync(path.join(repo, 'public/data/info'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'public/data/hospitals.json'), path.join(repo, 'public/data/hospitals.json'));
  fs.mkdirSync(incoming);
  try {
    const old = fixtureSource();
    const mk = (lang, fetchedAt) => ({ ...old, meta: { ...old.meta, lang, fetchedAt, translation: lang === 'zh-Hant' ? 'source' : 'partial' },
      sections: old.sections.map((s) => ({ ...s, translated: lang === 'zh-Hant' })) });
    for (const l of INFO_LANGS) fs.writeFileSync(path.join(repo, 'public/data/info', `${l}.json`), JSON.stringify(mk(l, '2026-09-28T00:00:00.000Z')));
    fs.writeFileSync(path.join(incoming, 'en.json'), JSON.stringify(mk('en', '2026-09-29T00:00:00.000Z')));      // 較新 → 採用
    fs.writeFileSync(path.join(incoming, 'ja.json'), JSON.stringify(mk('ja', '2026-09-27T00:00:00.000Z')));      // 較舊 → 不採用
    const bad = mk('ko', '2026-09-29T00:00:00.000Z'); bad.sections[0].links[0].href = 'https://evil.example.com/';
    fs.writeFileSync(path.join(incoming, 'ko.json'), JSON.stringify(bad));                                      // 不合格 → 不採用
    fs.writeFileSync(path.join(incoming, 'vi.json'), JSON.stringify(mk('th', '2026-09-29T00:00:00.000Z')));     // 語言不符 → 不採用
    fs.writeFileSync(path.join(incoming, 'evil.json'), '{}');                                                  // 非語言檔 → 忽略
    const r = await node('scripts/keep-live-data.mjs', ['--info-dir', incoming], { cwd: repo });
    const got = (l) => JSON.parse(fs.readFileSync(path.join(repo, 'public/data/info', `${l}.json`), 'utf8'));
    assert.equal(got('en').meta.fetchedAt, '2026-09-29T00:00:00.000Z');
    assert.equal(got('ja').meta.fetchedAt, '2026-09-28T00:00:00.000Z');
    assert.equal(got('ko').meta.fetchedAt, '2026-09-28T00:00:00.000Z');
    assert.equal(got('vi').meta.lang, 'vi');
    assert.ok(!fs.existsSync(path.join(repo, 'public/data/info/evil.json')));
    assert.match(r.stdout, /en/);
    // 資料夾不存在 → 正常結束（尚未有接種資訊）
    await node('scripts/keep-live-data.mjs', ['--info-dir', path.join(dir, 'nope')], { cwd: repo });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 離線翻譯：--export／--import
 * ------------------------------------------------------------------ */
/** 把匯出檔中所有「要翻譯的文字」加上前綴（模擬人工翻譯）；只含符號的儲存格（✓ 等）不動 */
function fakeTranslate(v, tag, key) {
  if (typeof v === 'string') return ['id', 'key', 'hash', 'type'].includes(key) || !/[\p{L}\p{N}]/u.test(v) || /^[✓✗○]/.test(v) ? v : `[${tag}] ${v}`;
  if (Array.isArray(v)) return v.map((x) => fakeTranslate(x, tag, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fakeTranslate(x, tag, k)]));
  return v;
}

test('translate-info.mjs --export → 人工翻譯 → --import：來回一致，語言檔變為已翻譯（manual）', async () => {
  const { dir, data, pub, env } = setupDirs();
  const exp = path.join(dir, 'projections.zh.json');
  try {
    const r = await node('scripts/translate-info.mjs', ['--export', exp], { env });
    assert.match(r.stdout, /已匯出 11 個/);
    assert.ok(!fs.existsSync(pub), '匯出不應產生輸出檔');
    const x = JSON.parse(fs.readFileSync(exp, 'utf8'));
    const src = fixtureSource();
    assert.deepEqual(Object.keys(x), ['title', 'sections']);
    assert.equal(x.title.title, src.meta.sourceTitle);
    assert.match(x.title.hash, /^sha256:/);
    assert.equal(x.sections.length, src.sections.length);
    for (const [i, s] of x.sections.entries()) {
      assert.deepEqual(Object.keys(s), ['id', 'key', 'hash', 'title', 'blocks', 'links', 'files']);
      assert.equal(s.hash, src.sections[i].hash);
      assert.deepEqual({ title: s.title, blocks: s.blocks, links: s.links, files: s.files }, projectSection(src.sections[i]));
      assert.ok(!JSON.stringify(s).includes('https://'), '匯出檔不含網址');
    }
    const tr = path.join(dir, 'vi.json');
    fs.writeFileSync(tr, JSON.stringify(fakeTranslate(x, 'vi')));
    const r2 = await node('scripts/translate-info.mjs', ['--import', 'vi', tr], { env });
    assert.match(r2.stdout, /匯入 vi：11 個單位/);
    const vi = readLang(pub, 'vi');
    assert.ok(vi.sections.every((s) => s.translated && s.title.startsWith('[vi] ')));
    assert.equal(vi.meta.translation, 'machine');
    assert.equal(vi.meta.title, `[vi] ${src.meta.sourceTitle}`);
    assert.deepEqual(allHrefs(vi), allHrefs(src));
    assert.deepEqual(validateInfo(vi), []);
    assert.equal(readLang(pub, 'en').meta.translation, 'partial');
    const cache = JSON.parse(fs.readFileSync(path.join(data, 'translations.json'), 'utf8'));
    const e = cache[src.sections[0].hash].vi;
    assert.equal(e.source, 'manual');
    assert.ok(Date.parse(e.at) > Date.now() - 60000);
    // 匯入的譯文之後一般執行（無金鑰）仍保留
    await node('scripts/translate-info.mjs', [], { env });
    assert.ok(readLang(pub, 'vi').sections.every((s) => s.translated));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translate-info.mjs --import：雜湊過期、結構不符、未知區塊 → 略過並警告，其他區塊照常匯入', async () => {
  const { dir, data, pub, env } = setupDirs();
  const exp = path.join(dir, 'projections.zh.json');
  try {
    await node('scripts/translate-info.mjs', ['--export', exp], { env });
    const x = fakeTranslate(JSON.parse(fs.readFileSync(exp, 'utf8')), 'th');
    // 原文在翻譯期間更新：coins 區塊雜湊改變
    const changed = buildSource(FIXTURE.replace('450幣', '500幣'), { now: NOW }).doc;
    fs.writeFileSync(path.join(data, 'source.json'), JSON.stringify(changed));
    x.sections.find((s) => s.key === 'eligibility').blocks[0].rows.pop();          // 少一列 → 結構不符
    x.sections.find((s) => s.key === 'brands').blocks[0].text = '<b>x</b>';       // 含 < > → 拒絕
    x.sections.find((s) => s.key === 'news').links[0].text = 'Tin tức 115';       // 仍合格
    x.sections.push({ ...x.sections[0], id: '999999' });                          // 不存在的區塊
    const f = path.join(dir, 'th.json');
    fs.writeFileSync(f, JSON.stringify(x));
    const r = await node('scripts/translate-info.mjs', ['--import', 'th', f], { env });
    assert.match(r.stderr, /103106：雜湊與目前原文不符/);
    assert.match(r.stderr, /103059：.*rows 應有/);
    assert.match(r.stderr, /103062：.*< 或 >/);
    assert.match(r.stderr, /999999：目前原文沒有這個區塊/);
    assert.match(r.stdout, /匯入 th：8 個單位.*略過 4 個/);
    const th = readLang(pub, 'th');
    const by = Object.fromEntries(th.sections.map((s) => [s.key === 'education' ? s.id : s.key, s]));
    assert.equal(by.coins.translated, false);
    assert.equal(by.eligibility.translated, false);
    assert.equal(by.brands.translated, false);
    assert.equal(by.news.translated, true);
    assert.equal(th.meta.translation, 'partial');
    assert.deepEqual(validateInfo(th), []);
    await assert.rejects(node('scripts/translate-info.mjs', ['--import', 'xx', f], { env }), /語言只接受/);
    await assert.rejects(node('scripts/translate-info.mjs', ['--import', 'th'], { env }), /用法/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
