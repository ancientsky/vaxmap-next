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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW' });
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
  const shareCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW' });
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
    locale: 'zh-TW',
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

// ---------------- 多語系 ----------------
const waitCount = (page) => page.waitForFunction(() => /\d/.test(document.getElementById('results-heading')?.textContent || ''), { timeout: 15000 });
const htmlLang = (page) => page.evaluate(() => document.documentElement.lang);

async function runI18nFlow(browser, baseUrl) {
  console.log('\n=== i18n ===');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW' });
  const page = await context.newPage();
  const errors = await collectConsoleErrors(page, true);
  await page.goto(`${baseUrl}#g=covid&stock=1&city=${encodeURIComponent('臺北市')}`, { waitUntil: 'load' });
  await waitCount(page);
  ok('zh-TW browser starts in zh-Hant (<html lang>)', (await htmlLang(page)) === 'zh-Hant-TW', await htmlLang(page));
  ok('switcher has an accessible name', !!(await page.locator('#lang-select').getAttribute('aria-label')));
  const zhCount = await countFromResultsHeading(page);
  ok('zh-Hant hash has no lang=', !page.url().includes('lang='), page.url());

  // 切換為英文：不重新載入頁面
  await page.evaluate(() => { window.__noReload = 1; });
  await page.locator('#lang-select').selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.waitForTimeout(400);
  ok('switching to en does not reload the page', await page.evaluate(() => window.__noReload === 1));
  ok('<html lang> becomes en', (await htmlLang(page)) === 'en');
  ok('document.title is English', /Vaccine/.test(await page.title()), await page.title());
  const head = await page.locator('#results-heading').innerText();
  ok('result-count text is English and the count is unchanged', /results?/.test(head) && (await countFromResultsHeading(page)) === zhCount, head);
  const badge = await page.locator('.card .badge').first().innerText();
  ok('card status label is English', /In stock|Out of stock|Closed today/.test(badge), badge);
  ok('card place shows English city + English district', /Taipei City · \S+ District/.test(await page.locator('.card__meta').first().innerText()));
  const tokenLabels = await page.locator('#tokens .token').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  ok('token labels are English', tokenLabels.includes('Remove filter: In stock only') && tokenLabels.includes('Remove filter: Taipei City'), JSON.stringify(tokenLabels));
  ok('chips are English', (await page.locator('.chip--group').first().innerText()).includes('Flu'));
  ok('filter button label is English', (await page.locator('#filter-toggle').innerText()).includes('Filters'));
  ok('placeholder is English', (await page.locator('#search-input').getAttribute('placeholder')) === 'Clinic, address, city');
  await page.waitForTimeout(400);
  ok('hash gets lang=en', page.url().includes('lang=en'), page.url());
  ok('snapshot uses the English label', (await page.locator('#snapshot').innerText()).startsWith('Data snapshot'));
  ok('announcement link is preserved', (await page.locator('#banner-detail a').getAttribute('href')) === 'https://vaxmap.cdc.gov.tw/'
    && (await page.locator('#banner-detail a').innerText()) === 'Taiwan CDC official map');

  // 外文縣市名搜尋
  await page.locator('#clear-btn').click();
  await page.locator('#search-input').fill('Kaohsiung');
  await page.waitForTimeout(500);
  const khCount = await countFromResultsHeading(page);
  const metas = await page.locator('.card__meta').allInnerTexts();
  ok('searching "Kaohsiung" finds 高雄市 clinics', khCount > 0 && metas.length > 0 && metas.every((m) => m.includes('Kaohsiung City')), `${khCount} ${metas.slice(0, 3)}`);
  await page.locator('#search-clear').click();
  await page.waitForTimeout(300);

  // 詳細資料開著時切換語系
  await page.locator('.card__btn').first().click();
  await page.waitForSelector('#detail-name');
  ok('detail actions are English', (await page.locator('.actions').innerText()).includes('Directions'));
  await page.locator('#lang-select').selectOption('zh-Hant');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Hant-TW');
  await page.waitForTimeout(400);
  ok('open detail re-renders in zh-Hant', (await page.locator('.actions').innerText()).includes('Google 地圖導航'));
  ok('back to zh-Hant drops lang= from the hash', !page.url().includes('lang='), page.url());
  await page.locator('#lang-select').selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.waitForTimeout(400);

  // 重新整理後維持英文（網址 + localStorage）
  await page.reload({ waitUntil: 'load' });
  await waitCount(page);
  ok('reload keeps English', (await htmlLang(page)) === 'en' && (await page.locator('#lang-select').inputValue()) === 'en');
  await page.goto(baseUrl, { waitUntil: 'load' });
  await waitCount(page);
  ok('language persists without the hash (localStorage)', (await htmlLang(page)) === 'en');
  ok('no console errors during language switching', errors.length === 0, errors.slice(0, 5).join(' || '));
  await context.close();

  // 分享連結 #lang=en 在繁中瀏覽器中還原英文
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW' });
  const p2 = await c2.newPage();
  await p2.goto(`${baseUrl}#lang=en`, { waitUntil: 'load' });
  await waitCount(p2);
  ok('hash lang=en restores English in a zh-TW browser', (await htmlLang(p2)) === 'en' && /results?/.test(await p2.locator('#results-heading').innerText()));
  await c2.close();

  // 瀏覽器語言偵測（無網址、無儲存）
  const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const p3 = await c3.newPage();
  await p3.goto(baseUrl, { waitUntil: 'load' });
  await waitCount(p3);
  ok('navigator.languages en-US → English', (await htmlLang(p3)) === 'en');
  await c3.close();

  // 待翻譯的語系檔（英文佔位）能正常載入
  for (const l of ['ja', 'ko', 'id', 'vi', 'th', 'tl']) {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', isMobile: true, hasTouch: true });
    const p = await c.newPage();
    const errs = await collectConsoleErrors(p, true);
    await p.goto(`${baseUrl}#lang=${l}`, { waitUntil: 'load' });
    await waitCount(p);
    const info = await p.evaluate(() => ({ lang: document.documentElement.lang, sel: document.getElementById('lang-select').value }));
    ok(`${l} placeholder loads without errors`, info.sel === l && !!info.lang && errs.length === 0, `${JSON.stringify(info)} ${errs.slice(0, 3).join(' || ')}`);
    await c.close();
  }
}

async function i18nScreenshots(browser, baseUrl) {
  console.log('\n=== i18n screenshots ===');
  const hash = `#g=covid&stock=1&city=${encodeURIComponent('臺北市')}`;
  for (const [lang, locale] of [['zh', 'zh-TW'], ['en', 'en-US']]) {
    for (const [dev, opts] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
      const c = await browser.newContext({ ...opts, locale });
      const p = await c.newPage();
      await p.goto(`${baseUrl}${hash}`, { waitUntil: 'load' });
      await waitCount(p);
      await p.waitForTimeout(800);
      await p.screenshot({ path: path.join(SCREEN_DIR, `i18n-${lang}-${dev}-initial.png`) });
      // 版面檢查：主列 chip 與「篩選」按鈕的文字不可溢出
      // 量文字元素本身（控制項的 ::before 觸控延伸區與 ✓ 徽章是刻意超出的，不算）：
      // 文字不可被截斷（scrollWidth > clientWidth），也不可超出所屬按鈕的外框
      const overflow = await p.evaluate(() => {
        const bad = [];
        const sel = '.chip__label, .btn--filter__label, #filter-toggle .count-badge, .token__text, .card .badge, .lang__name, .lang__short';
        for (const e of document.querySelectorAll(sel)) {
          const r = e.getBoundingClientRect();
          if (!r.width) continue;
          const box = (e.closest('button, .lang') || e).getBoundingClientRect();
          const clipped = e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).display !== 'inline';
          const outside = r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1;
          if (clipped || outside) bad.push(`${e.className}: "${e.textContent}"`);
        }
        return bad;
      });
      ok(`${lang}/${dev}: no text overflow in chips / filter button / tokens / badges / switcher`, overflow.length === 0, JSON.stringify(overflow));
      const tops = await p.locator('.chip--group').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      ok(`${lang}/${dev}: 4 group chips stay on one row`, new Set(tops).size === 1, JSON.stringify(tops));
      await p.locator('.card__btn').first().click();
      await p.waitForSelector('#detail-name');
      await p.waitForTimeout(600);
      await p.screenshot({ path: path.join(SCREEN_DIR, `i18n-${lang}-${dev}-detail.png`) });
      await c.close();
    }
  }
}

// ---------------- 底圖（地名語言與備援） ----------------
// 臺北市中心 z15（網址 hash 的 map=lat,lng,z）
const TPE_VIEW = 'map=25.04180,121.53200,15';
const basemapId = (p) => p.evaluate(() => document.getElementById('map').dataset.basemap);
const attribution = (p) => p.evaluate(() => document.querySelector('.leaflet-control-attribution')?.textContent || '');
const mapStatus = (p) => p.evaluate(() => { const e = document.getElementById('map-status'); return e.hidden ? '' : e.textContent; });
const tileHost = { osm: /tile\.openstreetmap\.org\//, nlsc: /wmts\.nlsc\.gov\.tw\/wmts\/EMAP\//, nlscEn: /wmts\.nlsc\.gov\.tw\/wmts\/EMAP8\// };

/** 等到目前底圖的圖磚都載完（或逾時），供截圖用 */
async function waitTilesSettled(p, timeout = 20000) {
  await p.waitForFunction(() => {
    const all = document.querySelectorAll('.leaflet-tile-container img.leaflet-tile');
    const done = document.querySelectorAll('.leaflet-tile-container img.leaflet-tile-loaded');
    return all.length > 0 && done.length === all.length;
  }, { timeout }).catch(() => {});
  await p.waitForTimeout(400);
}

/** 圖例內的底圖切換：可見選項（依序）與目前勾選的值 */
const basemapSwitch = (p) => p.evaluate(() => {
  const fs = document.getElementById('basemap-switch');
  const opts = [...fs.querySelectorAll('[data-basemap-opt]')].filter((o) => !o.hidden);
  return {
    visible: opts.map((o) => o.dataset.basemapOpt),
    labels: opts.map((o) => o.textContent.trim()),
    checked: fs.querySelector('input[name="basemap"]:checked')?.value || null,
    disabled: fs.disabled,
  };
});
const storedPref = (p) => p.evaluate(() => { try { return JSON.parse(localStorage.getItem('vaxmap.basemap') || 'null'); } catch { return 'ERR'; } });
const waitBasemap = (p, id, timeout = 15000) => p.waitForFunction((x) => document.getElementById('map').dataset.basemap === x, id, { timeout }).catch(() => {});
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 網址 hash 的 lang 是延遲寫入的；重新載入前先等它跟上目前語系，免得 reload 帶回舊語系 */
const hashSettled = (p) => p.waitForFunction(() => {
  const l = document.documentElement.dataset.lang;
  const m = location.hash.match(/(?:^#|&)lang=([^&]+)/);
  return l === 'zh-Hant' ? !m : !!m && m[1] === l;
}, null, { timeout: 5000 }).catch(() => {});

async function runBasemapFlow(browser, baseUrl) {
  console.log('\n=== basemap (defaults per language, switcher, fallback) ===');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW' });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, true);
  const reqs = [];
  page.on('request', (r) => { if (/openstreetmap|nlsc|tiles\.invalid/.test(r.url())) reqs.push(r.url()); });

  // 繁中預設：NLSC 通用版電子地圖（EMAP），不抓 OSM
  const emapReq = page.waitForRequest((r) => tileHost.nlsc.test(r.url()), { timeout: 15000 }).catch(() => null);
  await page.goto(`${baseUrl}#${TPE_VIEW}`, { waitUntil: 'load' });
  await waitCount(page);
  ok('zh-Hant: default basemap is NLSC EMAP', (await basemapId(page)) === 'nlsc' && !!(await emapReq), await basemapId(page));
  ok('zh-Hant: NLSC attribution in Chinese', /內政部國土測繪中心/.test(await attribution(page)), await attribution(page));
  ok('zh-Hant: no OSM / English-map tile requested by default', !reqs.some((u) => tileHost.osm.test(u) || tileHost.nlscEn.test(u)));
  let sw = await basemapSwitch(page);
  ok('zh-Hant: switcher offers 通用版電子地圖 / OpenStreetMap, NLSC checked',
    sameList(sw.visible, ['nlsc', 'osm']) && sw.checked === 'nlsc' && !sw.disabled && sameList(sw.labels, ['通用版電子地圖', 'OpenStreetMap']), JSON.stringify(sw));

  // 切到英文：換成 NLSC 英文版電子地圖，不重新載入；三個選項
  await page.evaluate(() => { window.__noReload = 1; });
  const enReq = page.waitForRequest((r) => tileHost.nlscEn.test(r.url()), { timeout: 15000 }).catch(() => null);
  await page.locator('#lang-select').selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  ok('en: tiles now come from NLSC EMAP8 (English labels)', !!(await enReq) && (await basemapId(page)) === 'nlscEn', await basemapId(page));
  ok('en: attribution credits NLSC in English', /NLSC, Ministry of the Interior/.test(await attribution(page)), await attribution(page));
  ok('en: basemap switched without a page reload', await page.evaluate(() => window.__noReload === 1));
  sw = await basemapSwitch(page);
  ok('en: switcher offers NLSC (English) / NLSC (Chinese) / OpenStreetMap, English checked',
    sameList(sw.visible, ['nlscEn', 'nlsc', 'osm']) && sw.checked === 'nlscEn' && sameList(sw.labels, ['NLSC (English)', 'NLSC (Chinese)', 'OpenStreetMap']), JSON.stringify(sw));

  // en → ko：同一條英文地名鏈，不應重建底圖
  const before = reqs.length;
  await page.locator('#lang-select').selectOption('ko');
  await page.waitForFunction(() => document.documentElement.lang.startsWith('ko'));
  await page.waitForTimeout(600);
  ok('en → ko keeps the English-label basemap (no tile reload)', (await basemapId(page)) === 'nlscEn' && reqs.length === before, `${await basemapId(page)} +${reqs.length - before} requests`);

  // 回到繁中：換回 NLSC 中文
  await page.locator('#lang-select').selectOption('zh-Hant');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Hant-TW');
  ok('back to zh-Hant restores NLSC EMAP', (await basemapId(page)) === 'nlsc' && /內政部國土測繪中心/.test(await attribution(page)), await basemapId(page));
  ok('switching languages does not store a basemap preference', (await storedPref(page)) === null, JSON.stringify(await storedPref(page)));

  // 切換器：繁中選 OSM → 立即換圖、版權換成 OSM、記住（只記 zh）
  const osmReq = page.waitForRequest((r) => tileHost.osm.test(r.url()), { timeout: 15000 }).catch(() => null);
  await page.locator('#basemap-switch input[value="osm"]').check();
  await waitBasemap(page, 'osm');
  ok('switcher: choosing OpenStreetMap swaps the tiles immediately', (await basemapId(page)) === 'osm' && !!(await osmReq), await basemapId(page));
  ok('switcher: attribution follows the map (OSM, Chinese)', /OpenStreetMap 貢獻者/.test(await attribution(page)) && !/國土測繪中心/.test(await attribution(page)), await attribution(page));
  ok('switcher: zh preference stored in vaxmap.basemap', sameList(await storedPref(page), { zh: 'osm' }), JSON.stringify(await storedPref(page)));
  await hashSettled(page);
  await page.reload({ waitUntil: 'load' });
  await waitCount(page);
  sw = await basemapSwitch(page);
  ok('switcher: zh choice persists across reload', (await basemapId(page)) === 'osm' && sw.checked === 'osm', `${await basemapId(page)} ${JSON.stringify(sw)}`);

  // 外文的偏好分開記：英文仍是 EMAP8；在英文選中文版 NLSC
  await page.locator('#lang-select').selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  ok('switcher: latin languages keep their own default (zh choice does not leak)', (await basemapId(page)) === 'nlscEn', await basemapId(page));
  const emapReq2 = page.waitForRequest((r) => tileHost.nlsc.test(r.url()), { timeout: 15000 }).catch(() => null);
  await page.locator('#basemap-switch input[value="nlsc"]').check();
  await waitBasemap(page, 'nlsc');
  ok('switcher (en): NLSC (Chinese) loads EMAP tiles', (await basemapId(page)) === 'nlsc' && !!(await emapReq2), await basemapId(page));
  ok('switcher (en): NLSC attribution stays in English', /NLSC, Ministry of the Interior/.test(await attribution(page)), await attribution(page));
  ok('switcher: both preferences stored separately', sameList(await storedPref(page), { zh: 'osm', latin: 'nlsc' }), JSON.stringify(await storedPref(page)));
  await hashSettled(page);
  await page.reload({ waitUntil: 'load' });
  await waitCount(page);
  sw = await basemapSwitch(page);
  ok('switcher: latin choice persists across reload', (await basemapId(page)) === 'nlsc' && sw.checked === 'nlsc' && (await page.evaluate(() => document.documentElement.lang)) === 'en', `${await basemapId(page)} ${JSON.stringify(sw)}`);
  await page.locator('#lang-select').selectOption('zh-Hant');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Hant-TW');
  ok('switcher: back to zh-Hant uses the zh choice (OSM)', (await basemapId(page)) === 'osm' && (await basemapSwitch(page)).checked === 'osm', await basemapId(page));
  ok('no console errors (incl. Trusted Types) while switching basemaps', errors.length === 0, errors.slice(0, 5).join(' || '));
  await ctx.close();

  // ja 預設與繁中相同
  {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ja-JP' });
    const p = await c.newPage();
    await p.goto(`${baseUrl}#lang=ja&${TPE_VIEW}`, { waitUntil: 'load' });
    await waitCount(p);
    const s = await basemapSwitch(p);
    ok('ja: default basemap is NLSC EMAP, two options (通用版電子地図 / OpenStreetMap)',
      (await basemapId(p)) === 'nlsc' && sameList(s.visible, ['nlsc', 'osm']) && s.checked === 'nlsc', `${await basemapId(p)} ${JSON.stringify(s)}`);
    await c.close();
  }

  // ?tiles=fail：預設底圖失效 → 繁中 NLSC → OSM；英文 NLSC 英文版 → OSM 並提示地名可能是中文；單選鈕跟著更新
  // ?tiles=fail:osm＋已選 OSM：使用者選的底圖失效 → 改用 NLSC
  for (const [label, lang, locale, query, pref, want, statusRe] of [
    ['zh-Hant ?tiles=fail', 'zh-Hant', 'zh-TW', 'fail', null, 'osm', /底圖「國土測繪中心通用版電子地圖」無法載入，已自動改用「OpenStreetMap」$/],
    ['en ?tiles=fail', 'en', 'en-US', 'fail', null, 'osm', /Couldn’t load the “NLSC \(Taiwan\) English” base map; switched to “OpenStreetMap”, so street and place names may be in Chinese/],
    ['zh-Hant chosen OSM fails', 'zh-Hant', 'zh-TW', 'fail:osm', { zh: 'osm' }, 'nlsc', /底圖「OpenStreetMap」無法載入，已自動改用「國土測繪中心通用版電子地圖」$/],
    ['en chosen NLSC (Chinese) fails', 'en', 'en-US', 'fail:nlsc', { latin: 'nlsc' }, 'osm', /^Couldn’t load the “NLSC \(Taiwan\) e-map” base map; switched to “OpenStreetMap”$/],
  ]) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale });
    if (pref) await c.addInitScript((v) => { try { localStorage.setItem('vaxmap.basemap', v); } catch { /* ignore */ } }, JSON.stringify(pref));
    const p = await c.newPage();
    const errs = await collectConsoleErrors(p, true);
    const hashLang = lang === 'zh-Hant' ? '' : `lang=${lang}&`;
    await p.goto(`${baseUrl}?tiles=${query}#${hashLang}${TPE_VIEW}`, { waitUntil: 'load' });
    await waitCount(p);
    await waitBasemap(p, want);
    await p.waitForFunction(() => !document.getElementById('map-status').hidden, null, { timeout: 5000 }).catch(() => {});
    const st = await mapStatus(p);
    const s = await basemapSwitch(p);
    ok(`${label}: falls back to ${want}`, (await basemapId(p)) === want, await basemapId(p));
    ok(`${label}: radio follows the fallback (${want} checked)`, s.checked === want, JSON.stringify(s));
    ok(`${label}: shows the fallback notice`, statusRe.test(st), st);
    if (pref) ok(`${label}: fallback does not overwrite the stored choice`, sameList(await storedPref(p), pref), JSON.stringify(await storedPref(p)));
    if (label === 'en ?tiles=fail') {
      ok('en fallback: OSM attribution in English', /OpenStreetMap contributors/.test(await attribution(p)), await attribution(p));
      await waitTilesSettled(p);
      await p.screenshot({ path: path.join(SCREEN_DIR, 'basemap-en-fallback-desktop.png') });
    }
    ok(`${label}: no console errors`, errs.length === 0, errs.slice(0, 3).join(' || '));
    await c.close();
  }

  // ?tiles=osm 測試掛勾仍可用（且不寫入偏好）
  {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW' });
    const p = await c.newPage();
    await p.goto(`${baseUrl}?tiles=osm#${TPE_VIEW}`, { waitUntil: 'load' });
    await waitCount(p);
    ok('?tiles=osm starts on OpenStreetMap (radio checked, not stored)',
      (await basemapId(p)) === 'osm' && (await basemapSwitch(p)).checked === 'osm' && (await storedPref(p)) === null, await basemapId(p));
    await c.close();
  }

  // 截圖：桌面（繁中，圖例展開）與手機（英文三個選項，展開圖例）
  {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW' });
    const p = await c.newPage();
    await p.goto(`${baseUrl}#${TPE_VIEW}`, { waitUntil: 'load' });
    await waitCount(p);
    await waitTilesSettled(p);
    ok('desktop: legend (with basemap switcher) open by default', await p.evaluate(() => document.getElementById('legend').open));
    await p.screenshot({ path: path.join(SCREEN_DIR, 'basemap-switcher-desktop.png') });
    await c.close();
  }
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US' });
    const p = await c.newPage();
    await p.goto(`${baseUrl}#lang=en&${TPE_VIEW}`, { waitUntil: 'load' });
    await waitCount(p);
    ok('mobile: legend collapsed by default', !(await p.evaluate(() => document.getElementById('legend').open)));
    await p.locator('#legend > summary').tap();
    await p.waitForTimeout(300);
    const m = await p.evaluate(() => {
      const lg = document.getElementById('legend').getBoundingClientRect();
      const sheetTop = document.getElementById('sheet').getBoundingClientRect().top;
      const segs = [...document.querySelectorAll('#basemap-switch .seg:not([hidden]) input')].map((i) => i.getBoundingClientRect());
      return { h: Math.round(lg.height), bottom: Math.round(lg.bottom), sheetTop: Math.round(sheetTop), right: lg.right, vw: innerWidth, minW: Math.min(...segs.map((r) => r.width)), minH: Math.min(...segs.map((r) => r.height)), n: segs.length };
    });
    ok('mobile: switcher options are ≥44px tap targets', m.n === 3 && m.minW >= 44 && m.minH >= 44, JSON.stringify(m));
    ok('mobile: open legend stays above the results sheet and inside the viewport', m.bottom <= m.sheetTop && m.right <= m.vw, JSON.stringify(m));
    const osmReq2 = p.waitForRequest((r) => tileHost.osm.test(r.url()), { timeout: 15000 }).catch(() => null);
    await p.locator('#basemap-switch .seg[data-basemap-opt="osm"]').tap();
    await waitBasemap(p, 'osm');
    ok('mobile: tapping a switcher option changes the basemap', (await basemapId(p)) === 'osm' && !!(await osmReq2), await basemapId(p));
    await p.locator('#basemap-switch .seg[data-basemap-opt="nlscEn"]').tap();
    await waitBasemap(p, 'nlscEn');
    await waitTilesSettled(p);
    await p.screenshot({ path: path.join(SCREEN_DIR, 'basemap-switcher-mobile.png') });
    await c.close();
  }

  // 各語系臺北 z15 截圖（人工檢查地名是否為該語言可讀的文字）
  for (const [lang, locale] of [['zh', 'zh-TW'], ['en', 'en-US'], ['ja', 'ja-JP'], ['ko', 'ko-KR'], ['th', 'th-TH']]) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale });
    const p = await c.newPage();
    const hashLang = lang === 'zh' ? '' : `lang=${lang}&`;
    await p.goto(`${baseUrl}#${hashLang}${TPE_VIEW}`, { waitUntil: 'load' });
    await waitCount(p);
    await waitTilesSettled(p);
    await p.screenshot({ path: path.join(SCREEN_DIR, `basemap-${lang}-desktop.png`) });
    await c.close();
  }
}

// ---------------- 院所名稱／地址的英文轉寫（meta.script：latin／han） ----------------
const CJK = /\p{Script=Han}/u;
const ASCII_TEXT = /^[\x20-\x7e]+$/;

/** 卡片標題、第二行名稱、地址不可溢出卡片／詳細資料（水平方向），且卡片不可超出視窗 */
async function latinOverflow(p) {
  return p.evaluate(() => {
    const bad = [];
    const vw = document.documentElement.clientWidth;
    for (const e of document.querySelectorAll('.card__title, .card__alt, .card__meta, .detail__name, .detail__alt, .detail__addr, .detail__addr-alt, .detail__sub')) {
      const r = e.getBoundingClientRect();
      if (!r.width) continue;
      const box = (e.closest('.card, .detail') || document.body).getBoundingClientRect();
      if (e.scrollWidth > e.clientWidth + 1 || r.right > box.right + 1 || r.right > vw + 1) bad.push(`${e.className}: "${e.textContent.slice(0, 40)}"`);
    }
    return bad;
  });
}

async function runLatinFlow(browser, baseUrl) {
  console.log('\n=== Latin-script data (nameEn / addrEn) ===');
  const taipei = encodeURIComponent('臺北市');
  const beitou = encodeURIComponent('北投區');
  const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  const open = async (opts, locale, hash) => {
    const c = await browser.newContext({ ...opts, locale });
    const p = await c.newPage();
    const errs = await collectConsoleErrors(p, true);
    await p.goto(`${baseUrl}#${hash}`, { waitUntil: 'load' });
    await waitCount(p);
    await p.waitForTimeout(600);
    return { c, p, errs };
  };
  // 手機：把清單拉到全高再截圖（點把手循環 peek → half → full）
  const expandSheet = async (p) => {
    for (let i = 0; i < 3 && (await p.locator('#sheet').getAttribute('data-state')) !== 'full'; i++) {
      await p.locator('#sheet-handle').tap();
      await p.waitForTimeout(450);
    }
  };
  const cardInfo = (p) => p.locator('.card').evaluateAll((els) => els.slice(0, 8).map((e) => ({
    title: e.querySelector('.card__title')?.innerText || '',
    titleLang: e.querySelector('.card__title')?.getAttribute('lang'),
    alt: e.querySelector('.card__alt')?.innerText || '',
    altLang: e.querySelector('.card__alt')?.getAttribute('lang'),
    meta: e.querySelector('.card__meta')?.innerText || '',
  })));

  // en（桌機）：北投區清單 → 詳細資料
  {
    const { c, p, errs } = await open({ viewport: { width: 1440, height: 900 } }, 'en-US', `lang=en&city=${taipei}&dist=${beitou}`);
    const cards = await cardInfo(p);
    ok('en: card titles are Latin (nameEn)', cards.length > 0 && cards.every((x) => ASCII_TEXT.test(x.title)), JSON.stringify(cards.slice(0, 2)));
    ok('en: Chinese name shown underneath, tagged lang=zh-Hant-TW', cards.every((x) => CJK.test(x.alt) && x.altLang === 'zh-Hant-TW'), JSON.stringify(cards.slice(0, 2)));
    ok('en: area line is "Taipei City · Beitou District"', cards.every((x) => x.meta.includes('Taipei City · Beitou District')), cards[0]?.meta);
    ok('en: district dropdown lists English names', (await p.locator('#dist-select option:checked').innerText()) === 'Beitou District',
      await p.locator('#dist-select option:checked').innerText());
    ok('en: district filter token is English', (await p.locator('#tokens').innerText()).includes('Beitou District'), await p.locator('#tokens').innerText());
    await p.locator('.card__btn').first().click();
    await p.waitForSelector('#detail-name');
    await p.waitForTimeout(500);
    const d = await p.evaluate(() => ({
      name: document.querySelector('.detail__name')?.textContent, alt: document.querySelector('.detail__alt')?.textContent,
      addr: document.querySelector('.detail__addr')?.textContent, addrAlt: document.querySelector('.detail__addr-alt')?.textContent,
      addrAltLang: document.querySelector('.detail__addr-alt')?.getAttribute('lang'), sub: document.querySelector('.detail__sub')?.textContent,
    }));
    ok('en detail: English name + Chinese name', ASCII_TEXT.test(d.name || '') && CJK.test(d.alt || ''), JSON.stringify(d));
    ok('en detail: English address, then Chinese address (lang=zh-Hant-TW)', /^.*No\. .*Beitou District, Taipei City$/.test(d.addr || '')
      && CJK.test(d.addrAlt || '') && d.addrAltLang === 'zh-Hant-TW', JSON.stringify(d));
    const of = await latinOverflow(p);
    ok('en desktop detail: no horizontal overflow', of.length === 0, JSON.stringify(of));
    await p.screenshot({ path: path.join(SCREEN_DIR, 'latin-en-desktop-detail.png') });
    // 英文關鍵字搜尋（北投、明德路、耳鼻喉科）
    await p.goto(`${baseUrl}#lang=en`, { waitUntil: 'load' });
    await waitCount(p);
    for (const [q, want] of [['Beitou', 'Beitou District'], ['Mingde ENT', 'ENT']]) {
      await p.locator('#search-input').fill(q);
      await p.waitForTimeout(500);
      const n = await countFromResultsHeading(p);
      const texts = await p.locator('.card').evaluateAll((els) => els.slice(0, 10).map((e) => e.innerText));
      ok(`en: search "${q}" finds clinics via the English fields`, n > 0 && texts.every((x) => x.includes(want)), `${n} ${texts[0]}`);
    }
    ok('en: no console errors', errs.length === 0, errs.slice(0, 3).join(' || '));
    await c.close();
  }

  // 繁中介面也能以英文搜尋；卡片不顯示英文
  {
    const { c, p } = await open({ viewport: { width: 1440, height: 900 } }, 'zh-TW', '');
    await p.locator('#search-input').fill('Linwenzheng');
    await p.waitForTimeout(500);
    const cards = await cardInfo(p);
    ok('zh-Hant: Latin query "Linwenzheng" finds 林文正耳鼻喉科診所', cards.some((x) => x.title.includes('林文正')), JSON.stringify(cards.slice(0, 2)));
    ok('zh-Hant: no secondary (English) line on cards', cards.every((x) => !x.alt), JSON.stringify(cards.slice(0, 2)));
    await c.close();
  }

  // en（手機）清單
  {
    const { c, p, errs } = await open(mobile, 'en-US', `lang=en&g=covid&city=${taipei}`);
    const cards = await cardInfo(p);
    ok('en mobile: cards show nameEn + Chinese name', cards.length > 0 && cards.every((x) => ASCII_TEXT.test(x.title) && CJK.test(x.alt)), JSON.stringify(cards.slice(0, 2)));
    const of = await latinOverflow(p);
    ok('en mobile list: no horizontal overflow', of.length === 0, JSON.stringify(of));
    await expandSheet(p);
    await p.screenshot({ path: path.join(SCREEN_DIR, 'latin-en-mobile-list.png') });
    ok('en mobile: no console errors', errs.length === 0, errs.slice(0, 3).join(' || '));
    await c.close();
  }

  // ja（手機）清單：中文名稱為主、英文為第二行；縣市用日文、行政區用中文
  {
    const { c, p, errs } = await open(mobile, 'ja-JP', `lang=ja&g=covid&city=${taipei}`);
    const cards = await cardInfo(p);
    ok('ja: Chinese name primary (lang=zh-Hant-TW), English second line (lang=en)', cards.length > 0
      && cards.every((x) => CJK.test(x.title) && x.titleLang === 'zh-Hant-TW' && ASCII_TEXT.test(x.alt) && x.altLang === 'en'), JSON.stringify(cards.slice(0, 2)));
    ok('ja: area uses the Japanese city name + Chinese district', cards.every((x) => /台北市\S+區/.test(x.meta)), cards[0]?.meta);
    const of = await latinOverflow(p);
    ok('ja mobile list: no horizontal overflow', of.length === 0, JSON.stringify(of));
    await expandSheet(p);
    await p.screenshot({ path: path.join(SCREEN_DIR, 'latin-ja-mobile-list.png') });
    ok('ja: no console errors', errs.length === 0, errs.slice(0, 3).join(' || '));
    await c.close();
  }

  // vi（手機）詳細資料
  {
    const { c, p, errs } = await open(mobile, 'vi-VN', `lang=vi&g=covid&city=${taipei}`);
    await p.locator('.card__btn').first().click();
    await p.waitForSelector('#detail-name');
    await p.waitForTimeout(700);
    const d = await p.evaluate(() => ({
      name: document.querySelector('.detail__name')?.textContent, alt: document.querySelector('.detail__alt')?.textContent,
      addr: document.querySelector('.detail__addr')?.textContent, addrAlt: document.querySelector('.detail__addr-alt')?.textContent,
      sub: document.querySelector('.detail__sub')?.textContent,
    }));
    ok('vi detail: English name/address primary (address ends "… District, Taipei City"), Chinese underneath',
      ASCII_TEXT.test(d.name || '') && CJK.test(d.alt || '') && /District, Taipei City$/.test(d.addr || '') && CJK.test(d.addrAlt || ''), JSON.stringify(d));
    const of = await latinOverflow(p);
    ok('vi mobile detail: no horizontal overflow', of.length === 0, JSON.stringify(of));
    await p.screenshot({ path: path.join(SCREEN_DIR, 'latin-vi-mobile-detail.png') });
    ok('vi: no console errors', errs.length === 0, errs.slice(0, 3).join(' || '));
    await c.close();
  }
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
    await runI18nFlow(browser, baseUrl);
    await i18nScreenshots(browser, baseUrl);
    await runLatinFlow(browser, baseUrl);
    await runBasemapFlow(browser, baseUrl);
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
