#!/usr/bin/env node
// Playwright 煙霧測試（不需要 test runner，plain node）。
// 執行：node tests/e2e.spec.mjs
//
// 需要全域安裝的 playwright（v1.56）與 /opt/pw-browsers 下的 Chromium
// （PLAYWRIGHT_BROWSERS_PATH 環境變數已設定，勿執行 `playwright install`）。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const EXPECTED_TOTAL = JSON.parse(fs.readFileSync(new URL('../public/data/hospitals.json', import.meta.url), 'utf8')).hospitals.length;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN_DIR = path.join(ROOT, 'tests/screenshots');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

let playwright;
try {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const req = createRequire(path.join(globalRoot, 'package.json'));
  playwright = req(path.join(globalRoot, 'playwright'));
} catch (e) {
  console.error('無法載入全域安裝的 playwright 套件。請確認已執行 `npm install -g playwright@1.56` 並設定 PLAYWRIGHT_BROWSERS_PATH。');
  console.error(String(e && e.message || e));
  process.exit(1);
}
const { chromium } = playwright;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.mjs')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    const onData = (d) => {
      if (!done && /listening|dev server/i.test(String(d))) {
        done = true;
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => process.stderr.write(`[dev-server] ${d}`));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!done) reject(new Error(`dev-server exited early with code ${code}`));
    });
    // Fallback: give it a moment even if no matching stdout line was printed.
    setTimeout(() => {
      if (!done) { done = true; resolve(child); }
    }, 1500);
  });
}

const failures = [];
let passCount = 0;

function ok(name, cond, detail) {
  if (cond) {
    passCount++;
    console.log(`  ok - ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL - ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

async function countFromResultsHeading(page) {
  const text = await page.locator('#results-heading').innerText();
  const m = text.replace(/,/g, '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function badgeCount(page) {
  const badge = page.locator('#filter-count');
  if (!(await badge.isVisible().catch(() => false))) return 0;
  return Number(await badge.innerText());
}

async function panelState(page) {
  return page.evaluate(() => ({
    expanded: document.getElementById('filter-toggle').getAttribute('aria-expanded'),
    controls: document.getElementById('filter-toggle').getAttribute('aria-controls'),
    hidden: document.getElementById('filter-panel').hidden,
  }));
}

async function openPanel(page) {
  if ((await panelState(page)).expanded !== 'true') {
    await page.locator('#filter-toggle').click();
    await page.waitForTimeout(300);
  }
}

async function collectConsoleErrors(page, ignoreTiles) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (ignoreTiles && /tile|wmts|openstreetmap|nlsc/i.test(text)) return;
      errors.push(`console.error: ${text}`);
    }
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (ignoreTiles && /tile|wmts\.nlsc\.gov\.tw|openstreetmap\.org/i.test(url)) return;
    // Only count failed requests as errors if they aren't tile requests.
    errors.push(`requestfailed: ${url} (${req.failure()?.errorText})`);
  });
  return errors;
}

async function runDesktopFlow(browser, baseUrl) {
  console.log('\n=== Desktop 1440x900 ===');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = await collectConsoleErrors(page, true);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('#results-heading', { timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('results-heading');
    return el && /\d/.test(el.textContent || '');
  }, { timeout: 15000 });

  const initialCount = await countFromResultsHeading(page);
  ok(`initial result count is ${EXPECTED_TOTAL}`, initialCount === EXPECTED_TOTAL, `got ${initialCount}`);
  await page.screenshot({ path: path.join(SCREEN_DIR, 'e2e-desktop-01-initial.png') });

  // COVID-19 chip
  const covidChip = page.locator('.chip--group', { hasText: 'COVID-19' }).first();
  await covidChip.click();
  await page.waitForTimeout(300);
  const covidCount = await countFromResultsHeading(page);
  ok('COVID-19 chip reduces the count', covidCount != null && covidCount < initialCount, `initial=${initialCount} covid=${covidCount}`);
  ok('COVID-19 chip sets aria-pressed=true', (await covidChip.getAttribute('aria-pressed')) === 'true');
  await page.screenshot({ path: path.join(SCREEN_DIR, 'e2e-desktop-02-covid.png') });

  // 次要條件面板：預設收合，徽章為 0
  const p0 = await panelState(page);
  ok('filter panel is collapsed by default', p0.expanded === 'false' && p0.hidden === true, JSON.stringify(p0));
  ok('filter toggle has aria-controls=filter-panel', p0.controls === 'filter-panel');
  ok('badge hidden (0) with no secondary filters', (await badgeCount(page)) === 0);
  ok('token row empty with no secondary filters', (await page.locator('#tokens .token').count()) === 0);
  const tokensH = await page.evaluate(() => document.getElementById('tokens').getBoundingClientRect().height);
  ok('token row has zero height when empty', tokensH === 0, `height=${tokensH}`);
  const filtersH = await page.evaluate(() => document.getElementById('filters').getBoundingClientRect().height);
  ok('desktop filter block ≤ 150px with panel collapsed', filtersH <= 150, `height=${filtersH}`);

  // 開啟面板 → 只看有庫存
  await openPanel(page);
  ok('panel opens (aria-expanded=true, not hidden)', (await panelState(page)).expanded === 'true' && !(await panelState(page)).hidden);
  const stockToggle = page.locator('#toggle-stock');
  await stockToggle.click();
  await page.waitForTimeout(300);
  const stockCount = await countFromResultsHeading(page);
  ok('只看有庫存 reduces or keeps the count equal', stockCount != null && stockCount <= covidCount, `covid=${covidCount} stock=${stockCount}`);
  ok('只看有庫存 sets aria-pressed=true', (await stockToggle.getAttribute('aria-pressed')) === 'true');
  ok('badge shows 1 after 只看有庫存', (await badgeCount(page)) === 1, `badge=${await badgeCount(page)}`);

  // 縣市 = 臺北市: compute expected count from the JSON directly.
  const dataUrl = new URL('data/hospitals.json', baseUrl).toString();
  const json = await page.evaluate(async (u) => (await fetch(u)).json(), dataUrl);
  const expectedTaipei = json.hospitals.filter((h) => {
    if (h.city !== '臺北市') return false;
    // still constrained by COVID-19 group + inStock from the two toggles above
    const covidIds = json.vaccines.filter((v) => v.group === 'covid').map((v) => v.id);
    const stock = h.stock || {};
    const hasAnyCovid = covidIds.some((id) => Object.prototype.hasOwnProperty.call(stock, id));
    if (!hasAnyCovid) return false;
    const hasStock = covidIds.some((id) => (stock[id] || 0) > 0);
    return hasStock;
  }).length;

  // 縣市/行政區 在面板內
  await page.locator('#city-select').selectOption({ label: '臺北市' });
  await page.waitForTimeout(300);
  const taipeiCount = await countFromResultsHeading(page);
  ok('城市=臺北市 count matches JSON-computed expectation', taipeiCount === expectedTaipei, `page=${taipeiCount} expected=${expectedTaipei}`);
  ok('badge shows 2 after adding 縣市', (await badgeCount(page)) === 2, `badge=${await badgeCount(page)}`);

  // Esc 收合面板，焦點回到「篩選」按鈕
  await page.locator('#city-select').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  const afterEsc = await panelState(page);
  const focusId = await page.evaluate(() => document.activeElement?.id);
  ok('Esc collapses the panel', afterEsc.expanded === 'false' && afterEsc.hidden === true, JSON.stringify(afterEsc));
  ok('focus returns to the 篩選 button after Esc', focusId === 'filter-toggle', `focus=${focusId}`);
  ok('detail/list untouched by Esc on panel (list still visible)', await page.locator('#view-list').isVisible());

  // 收合後以標籤列顯示條件
  const tokenLabels = await page.locator('#tokens .token').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  ok('tokens show 只看有庫存 and 臺北市', tokenLabels.includes('移除條件：只看有庫存') && tokenLabels.includes('移除條件：臺北市'), JSON.stringify(tokenLabels));
  await page.screenshot({ path: path.join(SCREEN_DIR, 'e2e-desktop-03-taipei.png') });

  // 移除「臺北市」標籤 → 結果數與徽章回到前一步
  await page.locator('#tokens .token[aria-label="移除條件：臺北市"]').click();
  await page.waitForTimeout(300);
  const afterRemove = await countFromResultsHeading(page);
  ok('removing the 臺北市 token restores the previous count', afterRemove === stockCount, `after=${afterRemove} expected=${stockCount}`);
  ok('removing a token decrements the badge', (await badgeCount(page)) === 1, `badge=${await badgeCount(page)}`);
  ok('focus stays on a token (or the 篩選 button) after removal', await page.evaluate(() => {
    const a = document.activeElement;
    return !!a && (a.classList.contains('token') || a.id === 'filter-toggle');
  }));

  // 分享連結：帶次要條件的 hash 開啟時面板收合、以標籤顯示
  const shareCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sharePage = await shareCtx.newPage();
  await sharePage.goto(`${baseUrl}#g=covid&p=mod_adult&stock=1&city=${encodeURIComponent('臺北市')}&dist=${encodeURIComponent('中山區')}`, { waitUntil: 'load' });
  await sharePage.waitForFunction(() => /\d/.test(document.getElementById('results-heading')?.textContent || ''), { timeout: 15000 });
  const sp = await panelState(sharePage);
  const shareTokens = await sharePage.locator('#tokens .token').count();
  ok('hash restore keeps the panel collapsed', sp.expanded === 'false' && sp.hidden === true, JSON.stringify(sp));
  ok('hash restore shows 3 tokens (細項, 庫存, 地區)', shareTokens === 3, `tokens=${shareTokens}`);
  ok('hash restore badge = 3', (await badgeCount(sharePage)) === 3, `badge=${await badgeCount(sharePage)}`);
  await shareCtx.close();

  // reset filters via clear button if present, else reload for a clean search test
  const clearBtn = page.locator('#clear-btn');
  if (await clearBtn.isVisible().catch(() => false)) {
    await clearBtn.click();
    await page.waitForTimeout(200);
  }

  // Search 台大 -> finds a card containing 臺灣大學
  await page.locator('#search-input').fill('台大');
  await page.waitForTimeout(400);
  const cardTexts = await page.locator('.card__title').allInnerTexts();
  ok('search 台大 finds a card containing 臺灣大學', cardTexts.some((t) => t.includes('臺灣大學')), cardTexts.slice(0, 5).join(' | '));
  await page.screenshot({ path: path.join(SCREEN_DIR, 'e2e-desktop-04-search.png') });

  // Click first card -> detail view with tel: link and google maps dir link
  const firstCardBtn = page.locator('.card__btn').first();
  const firstName = await firstCardBtn.innerText();
  await firstCardBtn.click();
  await page.waitForSelector('#detail-name', { timeout: 5000 });
  const detailName = await page.locator('#detail-name').innerText();
  ok('detail view shows the clicked hospital name', detailName === firstName, `${detailName} vs ${firstName}`);
  const telHref = await page.locator('a[href^="tel:"]').first().getAttribute('href').catch(() => null);
  ok('detail view has a tel: link', !!telHref, telHref);
  const mapsHref = await page.locator('a[href*="google.com/maps/dir"]').first().getAttribute('href').catch(() => null);
  ok('detail view has a google.com/maps/dir link', !!mapsHref, mapsHref);
  await page.screenshot({ path: path.join(SCREEN_DIR, 'e2e-desktop-05-detail.png') });

  // Capture a shareable hash before going back, to test restore later.
  const hashUrl = page.url();

  // Browser back returns to list
  await page.goBack();
  await page.waitForTimeout(300);
  const backVisible = await page.locator('#view-list').isVisible();
  ok('browser Back returns to the list view', backVisible);
  await page.screenshot({ path: path.join(SCREEN_DIR, 'e2e-desktop-06-back.png') });

  // Loading the URL hash captured earlier restores the same count
  await page.goto(hashUrl, { waitUntil: 'load' });
  await page.waitForSelector('#detail-name', { timeout: 8000 });
  const restoredName = await page.locator('#detail-name').innerText();
  ok('loading captured hash restores the same detail view', restoredName === firstName, `${restoredName} vs ${firstName}`);
  await page.screenshot({ path: path.join(SCREEN_DIR, 'e2e-desktop-07-hash-restore.png') });

  const filteredErrors = errors;
  ok('no console errors / pageerrors on desktop (ignoring flaky map tile failures)', filteredErrors.length === 0, filteredErrors.slice(0, 5).join(' || '));

  await context.close();
}

async function runMobileFlow(browser, baseUrl) {
  console.log('\n=== Mobile 390x844 ===');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = await collectConsoleErrors(page, true);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('#results-heading', { timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('results-heading');
    return el && /\d/.test(el.textContent || '');
  }, { timeout: 15000 });

  const initialCount = await countFromResultsHeading(page);
  ok(`mobile initial result count is ${EXPECTED_TOTAL}`, initialCount === EXPECTED_TOTAL, `got ${initialCount}`);
  await page.screenshot({ path: path.join(SCREEN_DIR, 'e2e-mobile-01-initial.png') });

  const covidChip = page.locator('.chip--group', { hasText: 'COVID-19' }).first();
  await covidChip.tap();
  await page.waitForTimeout(300);
  const covidCount = await countFromResultsHeading(page);
  ok('mobile COVID-19 chip reduces the count', covidCount != null && covidCount < initialCount, `initial=${initialCount} covid=${covidCount}`);
  ok('mobile COVID-19 chip sets aria-pressed=true', (await covidChip.getAttribute('aria-pressed')) === 'true');
  await page.screenshot({ path: path.join(SCREEN_DIR, 'e2e-mobile-02-covid.png') });

  // 主列 4 個品項在同一行
  const chipTops = await page.locator('.chip--group').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  ok('mobile: 4 group chips on one line', chipTops.length === 4 && new Set(chipTops).size === 1, JSON.stringify(chipTops));
  const filtersH = await page.evaluate(() => document.getElementById('filters').getBoundingClientRect().height);
  ok('mobile filter block ≤ 130px with panel collapsed', filtersH <= 130, `height=${filtersH}`);

  // 面板收合時，地圖在 peek 狀態至少佔視窗 45%
  const mapPct = await page.evaluate(() => {
    const m = document.getElementById('map').getBoundingClientRect();
    const sh = document.getElementById('sheet').getBoundingClientRect();
    return (sh.top - m.top) / window.innerHeight * 100;
  });
  ok('mobile: map keeps ≥45% of the viewport at peek (panel collapsed)', mapPct >= 45, `map=${mapPct.toFixed(1)}%`);

  // 面板在行動版浮在地圖上，不改變地圖/清單高度
  const sheetBefore = await page.evaluate(() => document.getElementById('sheet').getBoundingClientRect().height);
  await openPanel(page);
  const sheetAfter = await page.evaluate(() => document.getElementById('sheet').getBoundingClientRect().height);
  ok('mobile: opening the panel does not resize the bottom sheet', Math.abs(sheetAfter - sheetBefore) < 2, `${sheetBefore} → ${sheetAfter}`);
  await page.locator('#toggle-stock').tap();
  await page.waitForTimeout(250);
  ok('mobile: badge = 1 after 只看有庫存', (await badgeCount(page)) === 1);
  await page.locator('#filter-done').tap();
  await page.waitForTimeout(350);
  const mp = await panelState(page);
  ok('mobile: 完成 collapses the panel', mp.expanded === 'false' && mp.hidden === true, JSON.stringify(mp));
  ok('mobile: focus returns to 篩選 after 完成', (await page.evaluate(() => document.activeElement?.id)) === 'filter-toggle');
  ok('mobile: token 只看有庫存 visible', (await page.locator('#tokens .token').count()) === 1);

  ok('no console errors / pageerrors on mobile (ignoring flaky map tile failures)', errors.length === 0, errors.slice(0, 5).join(' || '));

  await context.close();
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  console.log(`starting dev server on ${baseUrl}`);
  const server = await startServer(port);
  // give the server a brief moment to actually accept connections
  await new Promise((r) => setTimeout(r, 300));

  let browser;
  try {
    browser = await chromium.launch();
    await runDesktopFlow(browser, baseUrl);
    await runMobileFlow(browser, baseUrl);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  console.log(`\n${passCount} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
