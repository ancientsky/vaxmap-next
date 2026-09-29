// data 分支的兩個寫入者（國內機器的 publish-data.sh、GitHub Actions 的 info-update.yml）共用的
// scripts/push-data-branch.sh，以及 scripts/info-update.sh 的完整流程（prepare → harvest → translate → check → publish），
// 全部在本機的暫存 bare repo 上執行，模擬 Gemini API 與疾管署頁面；另外檢查 workflow 檔的安全規則。
// 執行：node --test tests/data-branch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startMockTranslate } from './mock-translate.mjs';
import { validateInfo } from '../scripts/sanitize-info.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUSH = path.join(ROOT, 'scripts/push-data-branch.sh');
const INFO = path.join(ROOT, 'scripts/info-update.sh');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'tests/fixtures/info-mpage.html'), 'utf8');
// 子行程不繼承代理、金鑰、翻譯與 git 相關的環境變數
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(https?_proxy|all_proxy|no_proxy|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_.*|RUNNER_.*|TRANSLATE_.*|INFO_.*|DATA_.*|GIT_.*)$/i.test(k)));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'databranch-'));
const git = (gitDir, ...args) => execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8' }).trim();
const run = (cmd, args, env = {}) => execFileAsync('bash', [cmd, ...args], { env: { ...CHILD_ENV, DATA_PUSH_BACKOFF: '0', ...env } });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const show = (remote, p) => git(remote, 'show', `data:${p}`);

function bareRemote(dir) {
  const r = path.join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', r]);
  return r;
}

test('push-data-branch.sh：第一次建立 data 分支；之後只覆蓋指定的檔案；永遠只有一個提交；內容相同不推送', async () => {
  const dir = tmpdir();
  try {
    const remote = bareRemote(dir);
    const a = path.join(dir, 'a'), b = path.join(dir, 'b');
    write(path.join(a, 'hospitals.json'), '{"v":1}\n');
    write(path.join(b, 'info/en.json'), '{"en":1}\n');
    write(path.join(b, 'info/source.json'), '{"s":1}\n');
    const env = { DATA_REMOTE: remote };
    let r = await run(PUSH, ['-C', a, '-m', 'hosp 1', 'hospitals.json'], env);
    assert.match(r.stdout, /^pushed [0-9a-f]{40}$/m);
    r = await run(PUSH, ['-C', b, '-m', 'info 1', 'info/en.json', 'info/source.json'], env);
    assert.match(r.stdout, /pushed/);
    assert.deepEqual(git(remote, 'ls-tree', '-r', '--name-only', 'data').split('\n'), ['hospitals.json', 'info/en.json', 'info/source.json']);
    assert.equal(show(remote, 'hospitals.json'), '{"v":1}', '院所資料不被接種資訊的推送蓋掉');
    write(path.join(a, 'hospitals.json'), '{"v":2}\n');
    await run(PUSH, ['-C', a, 'hospitals.json'], env);
    assert.equal(show(remote, 'hospitals.json'), '{"v":2}');
    assert.equal(show(remote, 'info/en.json'), '{"en":1}', '接種資訊不被院所資料的推送蓋掉');
    assert.equal(git(remote, 'rev-list', '--count', 'data'), '1', 'data 分支應永遠只有一個提交');
    r = await run(PUSH, ['-C', a, 'hospitals.json'], env);
    assert.match(r.stdout, /^unchanged /m);
    // 不合法的路徑
    for (const bad of ['../x', '/etc/passwd', '.git/config', 'a b.json']) {
      await assert.rejects(run(PUSH, ['-C', a, bad], env), /不合法的路徑|找不到檔案/);
    }
    await assert.rejects(run(PUSH, ['-C', a, 'missing.json'], env), /找不到檔案/);
    await assert.rejects(run(PUSH, ['hospitals.json'], env), /用法/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 模擬「另一個寫入者剛好在這次取回之後、推送之前更新了 data 分支」：以 git 的 pre-push hook（經由
 * GIT_CONFIG_* 環境變數設定 core.hooksPath，不改任何設定檔）在推送前一刻，用同一支腳本推送另一個寫入者的檔案。
 * @param {number} times 前幾次推送要被插隊
 */
function racingHook(dir, remote, otherDir, times) {
  const hooks = path.join(dir, 'hooks');
  const counter = path.join(dir, 'raced');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/usr/bin/env bash
n=$(cat "${counter}" 2>/dev/null || echo 0)
if (( n < ${times} )); then
  echo $((n + 1)) > "${counter}"
  printf '{"v":"other-%s"}\\n' "$n" > "${otherDir}/hospitals.json"
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 \\
    DATA_REMOTE="${remote}" bash "${PUSH}" -C "${otherDir}" -m other hospitals.json >/dev/null
fi
exit 0
`, { mode: 0o755 });
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks, counter };
}

test('push-data-branch.sh：推送前 data 分支被另一個寫入者更新 → 租約失敗 → 重新取回、疊加、再推；兩邊的檔案都保留', async () => {
  const dir = tmpdir();
  try {
    const remote = bareRemote(dir);
    const mine = path.join(dir, 'mine'), other = path.join(dir, 'other');
    fs.mkdirSync(other);
    write(path.join(mine, 'seed/hospitals.json'), '{"v":"seed"}\n');
    await run(PUSH, ['-C', path.join(mine, 'seed'), 'hospitals.json'], { DATA_REMOTE: remote });
    write(path.join(mine, 'info/en.json'), '{"en":"new"}\n');
    const hook = racingHook(dir, remote, other, 2);
    const { counter, ...hookEnv } = hook;
    const r = await run(PUSH, ['-C', mine, '-m', 'info', 'info/en.json'], { DATA_REMOTE: remote, ...hookEnv });
    assert.match(r.stderr, /被拒.*第 1 次重試/);
    assert.match(r.stderr, /第 2 次重試/);
    assert.match(r.stdout, /pushed/);
    assert.equal(fs.readFileSync(counter, 'utf8').trim(), '2', '另一個寫入者插隊了 2 次');
    // 另一個寫入者最後一次寫入的 hospitals.json 仍在，我的 info/en.json 也在
    assert.equal(show(remote, 'hospitals.json'), '{"v":"other-1"}');
    assert.equal(show(remote, 'info/en.json'), '{"en":"new"}');
    assert.equal(git(remote, 'rev-list', '--count', 'data'), '1');
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'data'), 'info');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('push-data-branch.sh：一直被插隊 → 重試 3 次後失敗（結束代碼 1），不會蓋掉對方的資料', async () => {
  const dir = tmpdir();
  try {
    const remote = bareRemote(dir);
    const mine = path.join(dir, 'mine'), other = path.join(dir, 'other');
    fs.mkdirSync(other);
    write(path.join(mine, 'info/en.json'), '{"en":"mine"}\n');
    // 從沒有 data 分支開始：租約為「遠端還沒有這個分支」，被插隊同樣要失敗
    const { counter, ...hookEnv } = racingHook(dir, remote, other, 99);
    await assert.rejects(run(PUSH, ['-C', mine, 'info/en.json'], { DATA_REMOTE: remote, ...hookEnv }),
      (e) => e.code === 1 && /已重試 3 次/.test(e.stderr));
    assert.equal(fs.readFileSync(counter, 'utf8').trim(), '4', '第一次＋3 次重試');
    assert.equal(show(remote, 'hospitals.json'), '{"v":"other-3"}');
    assert.throws(() => show(remote, 'info/en.json'), '失敗的推送不得留下任何內容');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * info-update.sh 全流程（與 .github/workflows/info-update.yml 的 step 相同順序）
 * ------------------------------------------------------------------ */
function servePage() {
  const state = { body: FIXTURE, status: 200, requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    res.statusCode = state.status; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(state.body);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}/page`, state, close: () => server.close() })));
}
const PHASES = ['prepare', 'harvest', 'translate', 'check', 'publish'];
/** 依 workflow 的順序跑各階段；金鑰只給 translate 階段，與 workflow 相同 */
async function runWorkflow(baseEnv, key, extra = {}) {
  const logs = {};
  for (const p of PHASES) {
    const env = { ...baseEnv, ...(p === 'translate' ? { GEMINI_API_KEY: key, ...extra.translate } : {}), ...(p === 'publish' ? extra.publish : {}) };
    const r = await run(INFO, [p], env);
    logs[p] = r.stdout + r.stderr;
  }
  return logs;
}
const readData = (remote, p) => JSON.parse(show(remote, p));

test('info-update.sh：prepare → harvest → translate(Gemini 模擬) → check → publish 全流程；第二天來源沒變 → 0 次 API、不部署；院所資料並存', { timeout: 180000 }, async () => {
  const dir = tmpdir();
  const page = await servePage();
  const mock = await startMockTranslate();
  try {
    const remote = bareRemote(dir);
    // 國內機器先推了院所資料
    write(path.join(dir, 'hosp/hospitals.json'), '{"meta":{"generatedAt":"x"},"hospitals":[]}\n');
    await run(PUSH, ['-C', path.join(dir, 'hosp'), 'hospitals.json'], { DATA_REMOTE: remote });
    const baseEnv = {
      INFO_WORK_DIR: path.join(dir, 'work'), DATA_REPO_URL: remote, SKIP_DEPLOY_TRIGGER: '1',
      INFO_URL: page.url, INFO_RETRY_MS: '10', TRANSLATE_ENDPOINT: mock.geminiUrl, TRANSLATE_BACKOFF_MS: '10',
    };
    // 第 1 天
    const d1 = await runWorkflow(baseEnv, 'test-gemini-key');
    assert.match(d1.prepare, /沒有 data 分支|已取回 data 分支/);
    assert.match(d1.prepare, /合併翻譯快取/);
    assert.match(d1.harvest, /changed$/m);
    assert.match(d1.publish, /pushed/);
    assert.match(d1.publish, /畫面有變動＝1/);
    const firstCalls = mock.stats.requests;
    assert.ok(firstCalls > 0, '第一次應呼叫翻譯 API');
    assert.equal(mock.stats.keyInUrl, 0);
    const files = git(remote, 'ls-tree', '-r', '--name-only', 'data').split('\n');
    for (const f of ['hospitals.json', 'info/source.json', 'info/translations.json', ...['zh-Hant', 'en', 'ja', 'ko', 'id', 'vi', 'th', 'tl'].map((l) => `info/${l}.json`)]) {
      assert.ok(files.includes(f), `data 分支缺少 ${f}`);
    }
    assert.equal(show(remote, 'hospitals.json'), '{"meta":{"generatedAt":"x"},"hospitals":[]}', '院所資料保留');
    for (const l of ['en', 'th']) {
      const d = readData(remote, `info/${l}.json`);
      assert.equal(d.meta.translation, 'machine');
      assert.deepEqual(validateInfo(d), []);
    }
    const fetched1 = readData(remote, 'info/source.json').meta.fetchedAt;
    assert.equal(git(remote, 'rev-list', '--count', 'data'), '1');
    for (const log of Object.values(d1)) assert.ok(!log.includes('test-gemini-key'), '金鑰不得出現在記錄中');

    // 第 2 天：來源沒變 → 不呼叫 API（也不把金鑰交給翻譯程式）、不觸發部署，但 fetchedAt 仍更新
    await new Promise((r) => setTimeout(r, 1100));
    const d2 = await runWorkflow(baseEnv, 'test-gemini-key');
    assert.match(d2.harvest, /unchanged$/m);
    assert.match(d2.translate, /不呼叫翻譯 API/);
    assert.equal(mock.stats.requests, firstCalls, '來源沒變不得呼叫 API');
    assert.match(d2.publish, /畫面有變動＝0/);
    assert.ok(readData(remote, 'info/source.json').meta.fetchedAt > fetched1, 'fetchedAt 應更新（新鮮度檢查依據）');
    assert.ok(readData(remote, 'info/en.json').meta.fetchedAt > fetched1, '語言檔的同步時間也更新');

    // 第 3 天：某區塊內容改變 → 只翻那個區塊×7 語言，觸發部署
    page.state.body = FIXTURE.replace('450幣', '500幣');
    const d3 = await runWorkflow(baseEnv, 'test-gemini-key');
    assert.match(d3.harvest, /changed$/m);
    assert.equal(mock.stats.requests, firstCalls + 7);
    assert.match(d3.publish, /畫面有變動＝1/);

    // 手動 force=title、langs=ja → 只重翻 1 個請求，並觸發部署（這裡以 SKIP 取代）
    const d4 = await runWorkflow(baseEnv, 'test-gemini-key', { translate: { INFO_FORCE: 'title', INFO_FORCE_LANGS: 'ja' }, publish: { INFO_FORCE: 'title' } });
    assert.match(d4.translate, /--force title：丟棄 1 筆快取/);
    assert.equal(mock.stats.requests, firstCalls + 8);

    // 不合法的 force 輸入被拒絕（workflow_dispatch 的輸入視為不可信）
    await assert.rejects(run(INFO, ['translate'], { ...baseEnv, INFO_FORCE: '$(id)' }), /force 只接受/);
    await assert.rejects(run(INFO, ['translate'], { ...baseEnv, INFO_FORCE: 'all', INFO_FORCE_LANGS: 'en;id' }), /langs 格式/);

    // 來源頁面連不上 → harvest 失敗、data 分支維持上一版
    const before = git(remote, 'rev-parse', 'data');
    page.state.status = 503;
    await run(INFO, ['prepare'], baseEnv);
    await assert.rejects(run(INFO, ['harvest'], baseEnv), (e) => e.code === 1);
    assert.equal(git(remote, 'rev-parse', 'data'), before);
  } finally {
    page.close();
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('info-update.sh：沒有 GEMINI_API_KEY → 外語檔為原文（partial）；隔天設定金鑰後，來源沒變也會補翻', { timeout: 120000 }, async () => {
  const dir = tmpdir();
  const page = await servePage();
  const mock = await startMockTranslate();
  try {
    const remote = bareRemote(dir);
    const baseEnv = {
      INFO_WORK_DIR: path.join(dir, 'work'), DATA_REPO_URL: remote, SKIP_DEPLOY_TRIGGER: '1',
      INFO_URL: page.url, INFO_RETRY_MS: '10', TRANSLATE_ENDPOINT: mock.geminiUrl, TRANSLATE_BACKOFF_MS: '10',
    };
    // repo 內的人工譯文不參與這個測試：直接比較「有沒有金鑰」
    baseEnv.INFO_REPO_CACHE = path.join(dir, 'none.json');
    const d1 = await runWorkflow(baseEnv, '');
    assert.match(d1.translate, /未設定 GEMINI_API_KEY/);
    assert.equal(mock.stats.requests, 0);
    for (const l of ['en', 'ja', 'ko', 'id', 'vi', 'th', 'tl']) assert.equal(readData(remote, `info/${l}.json`).meta.translation, 'partial', l);
    const d2 = await runWorkflow(baseEnv, 'k');
    assert.match(d2.harvest, /unchanged$/m);
    assert.match(d2.translate, /尚未翻譯的語言（en,ja,ko,id,vi,th,tl）/);
    assert.ok(mock.stats.requests > 0, '設定金鑰後應補翻');
    assert.match(d2.publish, /畫面有變動＝1/);
    for (const l of ['en', 'ja', 'ko', 'id', 'vi', 'th', 'tl']) assert.equal(readData(remote, `info/${l}.json`).meta.translation, 'machine', l);
  } finally {
    page.close();
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * workflow 檔的安全規則
 * ------------------------------------------------------------------ */
test('workflows：頂層 permissions: {}、action 釘選 SHA、run 內沒有 ${{ }}、金鑰只給翻譯 step', () => {
  const dirW = path.join(ROOT, '.github/workflows');
  const shas = new Map();
  for (const f of fs.readdirSync(dirW).filter((x) => x.endsWith('.yml'))) {
    const y = fs.readFileSync(path.join(dirW, f), 'utf8');
    assert.match(y, /^permissions: \{\}$/m, `${f} 缺少頂層 permissions: {}`);
    for (const m of y.matchAll(/uses: ([\w./-]+)@(\S+)/g)) {
      assert.match(m[2], /^[0-9a-f]{40}$/, `${f}：${m[1]} 未釘選完整 SHA`);
      if (shas.has(m[1])) assert.equal(shas.get(m[1]), m[2], `${m[1]} 在各 workflow 應釘選同一個 SHA`);
      shas.set(m[1], m[2]);
    }
    // run: 區塊（run: | 之後縮排較深的行）不可直接出現 ${{ }}
    const lines = y.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i]);
      if (!m) continue;
      const body = [m[2]];
      const ind = m[1].length;
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > ind); j++) body.push(lines[j]);
      assert.ok(!body.join('\n').includes('${{'), `${f}:${i + 1} run 內直接使用 \${{ }}，請改經由 env:`);
    }
    for (const m of y.matchAll(/persist-credentials: (\w+)/g)) assert.equal(m[1], 'false', `${f} checkout 應 persist-credentials: false`);
  }
  const info = fs.readFileSync(path.join(dirW, 'info-update.yml'), 'utf8');
  assert.equal((info.match(/secrets\./g) || []).length, 1, 'info-update.yml 只應引用一個 secret');
  assert.match(info, /- name: 翻譯有變動的區塊\n\s+env:\n\s+GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  assert.equal((info.match(/github\.token/g) || []).length, 1, 'GITHUB_TOKEN 只給發布 step');
  assert.match(info, /cron: '0 22 \* \* \*'/);
  assert.match(info, /group: data-branch/);
  assert.match(info, /permissions:\n\s+contents: write[^\n]*\n\s+actions: write/);
  // 國內機器不再處理接種資訊、也不再讀金鑰檔
  const pub = fs.readFileSync(path.join(ROOT, 'scripts/publish-data.sh'), 'utf8');
  assert.ok(!/ANTHROPIC_API_KEY|GEMINI_API_KEY|translate-info|harvest-info/.test(pub));
  assert.match(pub, /push-data-branch\.sh/);
  const inst = fs.readFileSync(path.join(ROOT, 'scripts/install-updater.sh'), 'utf8');
  assert.ok(!/EnvironmentFile|ANTHROPIC_API_KEY=/.test(inst));
});
