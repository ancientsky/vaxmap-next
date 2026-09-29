#!/usr/bin/env node
// 接種資訊頁（info.html）Playwright 測試（plain node，不需要 test runner）。
// 執行：node tests/e2e-info.spec.mjs   （npm run test:e2e:info）
//
// 資料檔 public/data/info/<lang>.json 由管線產生；測試一律攔截 /data/info/*.json，改回傳
// tests/fixtures/ 的固定資料（info.sample.json = 繁中、info.sample.en.json = 英文，其中「疫苗廠牌」
// 區塊 translated:false；info.hostile.json = 惡意內容）。需要全域 playwright 與 PLAYWRIGHT_BROWSERS_PATH
// （同 tests/e2e.spec.mjs）。
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN_DIR = path.join(ROOT, 'tests/screenshots');
const FIX_DIR = path.join(ROOT, 'tests/fixtures');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

let playwright;
try {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  playwright = createRequire(path.join(globalRoot, 'package.json'))(path.join(globalRoot, 'playwright'));
} catch (e) {
  console.error('無法載入全域安裝的 playwright 套件。請確認已執行 `npm install -g playwright@1.56` 並設定 PLAYWRIGHT_BROWSERS_PATH。');
  console.error(String(e && e.message || e));
  process.exit(1);
}
const { chromium } = playwright;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.mjs')], {
      cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    child.stdout.on('data', (d) => { if (!done && /listening|dev server/i.test(String(d))) { done = true; resolve(child); } });
    child.stderr.on('data', (d) => process.stderr.write(`[dev-server] ${d}`));
    child.on('error', reject);
    child.on('exit', (code) => { if (!done) reject(new Error(`dev-server exited early with code ${code}`)); });
    setTimeout(() => { if (!done) { done = true; resolve(child); } }, 1500);
  });
}

const failures = [];
let passCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log(`  ok - ${name}`); } else {
    failures.push({ name, detail });
    console.log(`  FAIL - ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

const FIXTURES = { sample: { 'zh-Hant': 'info.sample.json', en: 'info.sample.en.json' }, hostile: { 'zh-Hant': 'info.hostile.json', en: 'info.hostile.json' } };

/** 攔截資料檔：mode = 'sample' | 'hostile' | 'error'；沒有對應 fixture 的語系回 404（測試退回繁中） */
async function routeInfo(page, mode = 'sample') {
  const hits = [];
  await page.route('**/data/info/*.json', (route) => {
    const lang = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop().replace(/\.json$/, ''));
    hits.push(lang);
    if (mode === 'error') return route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
    const f = FIXTURES[mode][lang];
    if (!f) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: fs.readFileSync(path.join(FIX_DIR, f)) });
  });
  return hits;
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // 刻意觸發的 404／500（語系退回、錯誤狀態）不算
    if (/Failed to load resource: the server responded with a status of (404|500)/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return errors;
}

const ready = (page) => page.waitForSelector('body[data-state="ready"]', { timeout: 10000 });

async function main() {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}/`;
  const server = await startServer(port);
  await new Promise((r) => setTimeout(r, 300));
  let browser;
  try {
    browser = await chromium.launch();
    const VIEWPORTS = [
      ['desktop', { viewport: { width: 1440, height: 900 } }],
      ['mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
    ];

    for (const [vpName, vpOpts] of VIEWPORTS) {
      console.log(`\n=== ${vpName}: 繁中 ===`);
      const ctx = await browser.newContext({ ...vpOpts, locale: 'zh-TW' });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await routeInfo(page);
      await page.goto(`${base}info.html`, { waitUntil: 'load' });
      await ready(page);
      await page.waitForTimeout(300);

      const info = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        title: document.title,
        h1: [...document.querySelectorAll('h1')].map((h) => h.textContent),
        sections: [...document.querySelectorAll('#info-sections > section.isec')].map((s) => ({ id: s.id, key: s.dataset.key, h2: s.querySelector('h2')?.textContent })),
        chips: document.querySelectorAll('#toc-list .toc__chip').length,
        navCurrent: document.querySelector('.site-nav [aria-current="page"]')?.dataset.nav,
      }));
      ok(`${vpName}: html[lang]=zh-Hant-TW, title is the info page title`, info.lang === 'zh-Hant-TW' && /^接種資訊｜/.test(info.title), `${info.lang} / ${info.title}`);
      ok(`${vpName}: exactly one h1 (data title)`, info.h1.length === 1 && info.h1[0].includes('疫苗接種專區'), JSON.stringify(info.h1));
      ok(`${vpName}: ≥7 sections rendered from the fixture`, info.sections.length >= 7, `${info.sections.length}`);
      ok(`${vpName}: sections in schema order starting coins → eligibility → where`, info.sections.slice(0, 3).map((s) => s.id).join() === 'coins,eligibility,where', info.sections.map((s) => s.id).join());
      ok(`${vpName}: unique anchors (second "education" → education-2)`, new Set(info.sections.map((s) => s.id)).size === info.sections.length && info.sections.some((s) => s.id === 'education-2'));
      ok(`${vpName}: one chip per section`, info.chips === info.sections.length, `${info.chips}`);
      ok(`${vpName}: header nav marks 接種資訊 as current page`, info.navCurrent === 'info');

      // 健康幣
      const coins = await page.$$eval('#coins .coin__num', (ns) => ns.map((n) => n.textContent));
      ok(`${vpName}: coin badges show 450 / 900 / 600`, coins.join('/') === '450/900/600', coins.join('/'));
      const coinLabels = await page.$$eval('#coins .coin__label', (ns) => ns.map((n) => n.textContent));
      ok(`${vpName}: coin labels`, coinLabels.join('/') === '流感疫苗/新冠疫苗/肺炎鏈球菌疫苗', coinLabels.join('/'));

      // 接種對象：桌機表格、手機卡片
      const elig = await page.evaluate(() => {
        const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
        const t = document.querySelector('#eligibility .itable__scroll');
        const c = document.querySelector('#eligibility .icards');
        return {
          tableVisible: vis(t), cardsVisible: vis(c),
          colHeaders: [...document.querySelectorAll('#eligibility thead th[scope="col"]')].length,
          rowHeaders: [...document.querySelectorAll('#eligibility tbody th[scope="row"]')].length,
          yes: document.querySelectorAll('#eligibility .itable__t .mark--yes[role="img"][aria-label]').length,
          no: document.querySelectorAll('#eligibility .itable__t .mark--no').length,
          yesLabel: document.querySelector('#eligibility .mark--yes')?.getAttribute('aria-label'),
          note: document.querySelector('#eligibility .itable__t .mark__note')?.textContent,
        };
      });
      ok(`${vpName}: eligibility ✓ cells use the green check with aria-label`, elig.yes >= 20 && elig.yesLabel === '公費接種對象', JSON.stringify(elig));
      ok(`${vpName}: eligibility ✖ cells rendered as "not eligible" marks`, elig.no === 2);
      ok(`${vpName}: eligibility table headers have scope`, elig.colHeaders === 6 && elig.rowHeaders === 12, `${elig.colHeaders}/${elig.rowHeaders}`);
      ok(`${vpName}: cell notes kept next to the check`, elig.note === '(未滿6歲且從未接種新冠疫苗)', elig.note);
      if (vpName === 'desktop') ok('desktop: eligibility shows a table, not cards', elig.tableVisible && !elig.cardsVisible);
      else ok('mobile: eligibility table becomes cards', !elig.tableVisible && elig.cardsVisible);

      // 接種地點：地圖按鈕與縣市連結
      const where = await page.evaluate(() => ({
        mapHrefs: [...document.querySelectorAll('#where .mapcta a')].map((a) => a.getAttribute('href')),
        grids: [...document.querySelectorAll('#where .lgrid')].map((g) => g.children.length),
        plain: document.querySelectorAll('#where .lgrid .is-plain').length,
        cols: (() => { const g = document.querySelector('#where .lgrid'); return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0; })(),
      }));
      ok(`${vpName}: where → map buttons link to ./index.html#g=flu / covid / pcv`, where.mapHrefs.join() === './index.html#g=flu,./index.html#g=covid,./index.html#g=pcv', where.mapHrefs.join());
      ok(`${vpName}: county health-bureau links as a grid (22 + 23 items; unlinked kept as text)`, where.grids.join() === '22,23' && where.plain === 2, JSON.stringify(where));
      ok(`${vpName}: county grid columns (desktop 3, mobile 2)`, where.cols === (vpName === 'desktop' ? 3 : 2), `${where.cols}`);

      // 注意事項：檔案卡片
      const files = await page.evaluate(() => [...document.querySelectorAll('#precautions .file')].map((f) => ({
        href: f.getAttribute('href'), target: f.getAttribute('target'), rel: f.getAttribute('rel'),
        ext: f.querySelector('.file__ext')?.textContent, lang: f.querySelector('.tag--lang')?.textContent || null,
        isNew: !!f.querySelector('.tag--new'), dl: f.querySelector('.file__dl')?.textContent,
      })));
      ok(`${vpName}: precautions → 3 PDF file cards`, files.length === 3 && files.every((f) => f.ext === 'PDF' && f.dl === '下載 PDF'), JSON.stringify(files));
      ok(`${vpName}: file cards open in a new tab with noopener noreferrer`, files.every((f) => f.target === '_blank' && f.rel === 'noopener noreferrer' && /^https:\/\/www\.cdc\.gov\.tw\//.test(f.href)));
      ok(`${vpName}: English-version file gets the language badge; New badge shown`, files[2].lang === '英文版' && files[1].lang === '中文版' && files[0].isNew && !files[1].isNew, JSON.stringify(files.map((f) => [f.lang, f.isNew])));

      // 常見問答：標題＋網址 → 連結；新聞稿去重、日期
      const faq = await page.$$eval('#faq a.lrow__a', (as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
      ok(`${vpName}: FAQ title+URL lines become 2 links`, faq.length === 2 && faq[0][0].startsWith('季節性流感疫苗Q&A') && /uu68c_niZ3SPoViEMp72Mg$/.test(faq[0][1]), JSON.stringify(faq));
      const news = await page.evaluate(() => ({ n: document.querySelectorAll('#news .lrow').length, dates: [...document.querySelectorAll('#news .lrow time')].map((t) => t.getAttribute('datetime')), fresh: document.querySelectorAll('#news .tag--new').length }));
      ok(`${vpName}: news list deduplicated (5), dates as <time>, New badges`, news.n === 5 && news.dates.join() === '2026-09-26' && news.fresh === 2, JSON.stringify(news));
      // 影片連結（YouTube）：播放圖示＋「影片」標籤＋外部連結符號，另開視窗；不嵌入
      const vids = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('#education-2 .lrow--video a.lrow__a')].map((a) => ({
          href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'),
          play: !!a.querySelector('.lrow__play svg[aria-hidden="true"]'), ext: !!a.querySelector('svg.lrow__ic'),
          tag: a.querySelector('.tag--video')?.textContent, sr: a.querySelector('.sr-only')?.textContent,
        })),
        embeds: document.querySelectorAll('iframe, embed, object, video').length,
        videoElsewhere: [...document.querySelectorAll('.lrow--video')].filter((r) => !r.closest('#education-2')).length,
      }));
      ok(`${vpName}: education video links render as 影片 rows (play icon, tag, external marker, new tab)`,
        vids.rows.length === 2 && vids.rows.every((r) => /^https:\/\/www\.youtube\.com\/watch\?v=/.test(r.href) && r.target === '_blank' && r.rel === 'noopener noreferrer' && r.play && r.ext && r.tag === '影片' && r.sr === '（另開視窗）'),
        JSON.stringify(vids));
      ok(`${vpName}: no embedded players (iframe/embed/object/video) and no other rows marked as video`, vids.embeds === 0 && vids.videoElsewhere === 0, JSON.stringify(vids));

      // 每個區塊：最後更新、來源
      const meta = await page.evaluate(() => [...document.querySelectorAll('section.isec')].map((s) => ({
        upd: s.querySelector('.isec__upd')?.textContent || '', src: s.querySelector('a.isec__src')?.getAttribute('href') || '',
      })));
      ok(`${vpName}: every section shows 最後更新 {date} + 來源 link to the CDC card`, meta.every((m) => /^最後更新 2026年9月\d+日$/.test(m.upd) && /^https:\/\/www\.cdc\.gov\.tw\/Category\/MPage\/S_ZLz0yyc2lAQ9TStMB0uA#collapseOne\d+$/.test(m.src)), JSON.stringify(meta[0]));
      const heroMeta = await page.locator('#info-meta').innerText();
      ok(`${vpName}: page meta shows source, last change, sync time (Taipei)`, /來源：疾管署官網/.test(heroMeta) && /最後更新 2026年9月23日/.test(heroMeta) && /本站同步時間 2026\/9\/30 05:30/.test(heroMeta), heroMeta);

      // 所有外部連結：https + 政府網域 + noopener
      const links = await page.$$eval('a[href]', (as) => as.map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })));
      const bad = links.filter((l) => /^https?:/i.test(l.href) && (!/^https:\/\/(([a-z0-9-]+\.)*(gov\.tw|gov\.taipei)|www\.youtube\.com|youtu\.be)\//i.test(l.href) || l.target !== '_blank' || l.rel !== 'noopener noreferrer'));
      ok(`${vpName}: every external link is https on a gov domain with target=_blank rel=noopener noreferrer`, bad.length === 0, JSON.stringify(bad.slice(0, 3)));

      // chip 捲動與焦點
      const chip = page.locator('#toc-list .toc__chip[data-anchor="precautions"]');
      if (vpName === 'mobile') await chip.scrollIntoViewIfNeeded();
      await chip.click();
      await page.waitForTimeout(900);
      const afterChip = await page.evaluate(() => {
        const sec = document.getElementById('precautions');
        const tocH = document.getElementById('toc').getBoundingClientRect().height;
        return {
          top: sec.getBoundingClientRect().top, tocH,
          focus: document.activeElement?.id,
          hash: location.hash,
          current: document.querySelector('.toc__chip[aria-current]')?.dataset.anchor,
        };
      });
      ok(`${vpName}: chip click scrolls the section just below the sticky chip row`, Math.abs(afterChip.top - (afterChip.tocH + 12)) <= 6, JSON.stringify(afterChip));
      ok(`${vpName}: chip click moves focus to the section heading`, afterChip.focus === 'precautions-h', afterChip.focus);
      ok(`${vpName}: chip click writes #precautions and marks the chip current`, afterChip.hash === '#precautions' && afterChip.current === 'precautions', JSON.stringify(afterChip));

      // 列印：表格一定出現（即使是手機寬度）
      await page.emulateMedia({ media: 'print' });
      const printVis = await page.evaluate(() => ({
        table: getComputedStyle(document.querySelector('#eligibility .itable__scroll')).display,
        cards: getComputedStyle(document.querySelector('#eligibility .icards')).display,
        toc: getComputedStyle(document.getElementById('toc')).display,
      }));
      ok(`${vpName}: print shows the eligibility table, hides cards and chip row`, printVis.table !== 'none' && printVis.cards === 'none' && printVis.toc === 'none', JSON.stringify(printVis));
      await page.emulateMedia({ media: 'screen' });

      // 截圖（頁首附近 + 全頁）；回到頁首後 chip 列應標示第一個區塊
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      const topCurrent = await page.evaluate(() => document.querySelector('.toc__chip[aria-current]')?.dataset.anchor);
      ok(`${vpName}: scroll-spy marks the first section at the top of the page`, topCurrent === 'coins', topCurrent);
      await page.screenshot({ path: path.join(SCREEN_DIR, `info-zh-${vpName}.png`) });
      await page.screenshot({ path: path.join(SCREEN_DIR, `info-zh-${vpName}-full.png`), fullPage: true });

      // 語言切換 → 英文
      console.log(`\n=== ${vpName}: 切換為 English ===`);
      await page.selectOption('#lang-select', 'en');
      await page.waitForFunction(() => document.documentElement.lang === 'en' && document.getElementById('info-title').textContent.includes('Vaccination Hub'), null, { timeout: 8000 });
      await page.waitForTimeout(300);
      const en = await page.evaluate(() => ({
        title: document.title,
        h2: document.querySelector('#coins h2')?.textContent,
        chip: document.querySelector('.toc__chip[data-anchor="eligibility"]')?.textContent,
        coinLabel: document.querySelector('#coins .coin__label')?.textContent,
        coinAmt: document.querySelector('#coins .coin__amt')?.textContent,
        coins: [...document.querySelectorAll('#coins .coin__num')].map((n) => n.textContent).join('/'),
        brandsNotice: document.querySelector('#brands .untr')?.textContent || null,
        brandsLang: document.querySelector('#brands .isec__body')?.getAttribute('lang'),
        brandsH2Lang: document.querySelector('#brands h2')?.getAttribute('lang'),
        coinsNotice: !!document.querySelector('#coins .untr'),
        coinsLang: document.querySelector('#coins .isec__body')?.getAttribute('lang'),
        pageNotice: document.getElementById('info-notice').hidden ? null : document.getElementById('info-notice').textContent,
        yes: document.querySelector('#eligibility .mark--yes')?.getAttribute('aria-label'),
        mapHref: document.querySelector('#where .mapcta a')?.getAttribute('href'),
        navInfo: document.querySelector('.site-nav a[data-nav="map"]')?.getAttribute('href'),
        hash: location.hash,
        dl: document.querySelector('#precautions .file__dl')?.textContent,
        upd: document.querySelector('#coins .isec__upd')?.textContent,
      }));
      ok(`${vpName}: en re-renders (title, headings, chips, coin labels)`, en.title.startsWith('Vaccination info | ') && en.h2 === 'Earn Health Coins by Getting Vaccinated' && en.chip === 'Who is eligible' && en.coinLabel === 'Flu vaccine' && en.coinAmt === '+450 coins', JSON.stringify(en));
      ok(`${vpName}: en coin badges parsed from English text: 450/900/600`, en.coins === '450/900/600', en.coins);
      ok(`${vpName}: untranslated section shows the notice and lang=zh-Hant-TW`, en.brandsNotice === 'This section hasn’t been translated yet; the original Chinese text follows.' && en.brandsLang === 'zh-Hant-TW' && en.brandsH2Lang === 'zh-Hant-TW', JSON.stringify([en.brandsNotice, en.brandsLang, en.brandsH2Lang]));
      ok(`${vpName}: translated sections have no notice / no lang override`, !en.coinsNotice && en.coinsLang == null);
      ok(`${vpName}: machine-translation note at page level`, /machine-translated/.test(en.pageNotice || ''), en.pageNotice);
      ok(`${vpName}: en strings for marks, downloads, dates`, en.yes === 'Eligible (publicly funded)' && en.dl === 'Download PDF' && en.upd === 'Last updated September 23, 2026', JSON.stringify([en.yes, en.dl, en.upd]));
      ok(`${vpName}: map links carry the language (#g=flu&lang=en)`, en.mapHref === './index.html#g=flu&lang=en' && en.navInfo === './index.html#lang=en', JSON.stringify([en.mapHref, en.navInfo]));
      ok(`${vpName}: hash keeps section and adds lang`, en.hash === '#precautions&lang=en', en.hash);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SCREEN_DIR, `info-en-${vpName}.png`) });
      await page.screenshot({ path: path.join(SCREEN_DIR, `info-en-${vpName}-full.png`), fullPage: true });

      // 地圖連結可用：點「Influenza vaccine」→ 地圖頁、流感已選取、語系仍為英文
      await page.locator('#where .mapcta a[data-map-group="flu"]').click();
      await page.waitForURL(/index\.html#g=flu&lang=en$/, { timeout: 8000 });
      await page.waitForFunction(() => /\d/.test(document.getElementById('results-heading')?.textContent || ''), null, { timeout: 15000 });
      const mapState = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        pressed: [...document.querySelectorAll('.chip--group[aria-pressed="true"]')].map((c) => c.dataset.group || c.textContent.trim()),
        infoLink: document.querySelector('.site-nav a[data-nav="info"]')?.getAttribute('href'),
      }));
      ok(`${vpName}: map CTA opens the map filtered to flu, in English`, mapState.lang === 'en' && mapState.pressed.length === 1 && /flu/i.test(mapState.pressed[0]), JSON.stringify(mapState));
      ok(`${vpName}: map header links back to ./info.html#lang=en`, mapState.infoLink === './info.html#lang=en', mapState.infoLink);
      await page.locator('.site-nav a[data-nav="info"]').click();
      await page.waitForURL(/info\.html#lang=en$/);
      await ready(page);
      ok(`${vpName}: map → info nav keeps English`, (await page.evaluate(() => document.documentElement.lang)) === 'en');

      const ttErrors = errors.filter((e) => /Trusted|TrustedHTML|require-trusted-types/i.test(e));
      ok(`${vpName}: no Trusted Types violations`, ttErrors.length === 0, ttErrors.join(' | '));
      ok(`${vpName}: no console errors`, errors.length === 0, errors.slice(0, 5).join(' | '));
      await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
      await ctx.close();
    }

    /* ---------------- 深層連結、退回、錯誤、深色 ---------------- */
    console.log('\n=== 深層連結／語系退回／錯誤狀態 ===');
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-TW', colorScheme: 'dark' });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await routeInfo(page);
      await page.goto(`${base}info.html#eligibility`, { waitUntil: 'load' });
      await ready(page);
      await page.waitForTimeout(500);
      const deep = await page.evaluate(() => ({
        top: document.getElementById('eligibility').getBoundingClientRect().top,
        tocH: document.getElementById('toc').getBoundingClientRect().height,
        current: document.querySelector('.toc__chip[aria-current]')?.dataset.anchor,
        y: window.scrollY,
      }));
      ok('deep link info.html#eligibility scrolls to the section', deep.y > 100 && Math.abs(deep.top - (deep.tocH + 12)) <= 6, JSON.stringify(deep));
      ok('deep link marks the matching chip current', deep.current === 'eligibility', deep.current);
      await page.screenshot({ path: path.join(SCREEN_DIR, 'info-zh-mobile-dark.png') });

      // 來源卡片 id 也可當錨點；hashchange
      await page.evaluate(() => { location.hash = '103065'; });
      await page.waitForTimeout(900);
      const byId = await page.evaluate(() => ({ top: document.getElementById('news').getBoundingClientRect().top, focus: document.activeElement?.id }));
      ok('hash with the source card id (#103065) scrolls to the news section', byId.top < 200 && byId.focus === 'news-h', JSON.stringify(byId));
      ok('deep link: no console errors', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
    {
      // 語系沒有資料檔（ja：fixture 不提供 → 404）→ 退回繁中、整頁提示、內容標 lang
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW' });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      const hits = await routeInfo(page);
      await page.goto(`${base}info.html#lang=ja`, { waitUntil: 'load' });
      await ready(page);
      const fb = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        notice: document.getElementById('info-notice').hidden ? null : document.getElementById('info-notice').textContent,
        sectionNotices: document.querySelectorAll('.untr').length,
        bodyLang: document.querySelector('#coins .isec__body')?.getAttribute('lang'),
        h1Lang: document.getElementById('info-title').getAttribute('lang'),
        chip: document.querySelector('.toc__chip[data-anchor="coins"]')?.textContent,
      }));
      ok('missing language file falls back to zh-Hant data', hits.join() === 'ja,zh-Hant', hits.join());
      ok('fallback: UI in Japanese, one page-level notice (no per-section noise)', fb.lang === 'ja' && fb.notice === '日本語のコンテンツはまだありません。以下は中国語の原文です。' && fb.sectionNotices === 0, JSON.stringify(fb));
      ok('fallback: Chinese content marked lang=zh-Hant-TW', fb.bodyLang === 'zh-Hant-TW' && fb.h1Lang === 'zh-Hant-TW' && fb.chip === '健康コイン', JSON.stringify(fb));
      ok('fallback: no console errors', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-TW' });
      const page = await ctx.newPage();
      await routeInfo(page, 'error');
      await page.goto(`${base}info.html`, { waitUntil: 'load' });
      await page.waitForSelector('body[data-state="error"]', { timeout: 8000 });
      const err = await page.evaluate(() => ({
        text: document.getElementById('info-status').textContent,
        retry: !!document.querySelector('#info-status button'),
        link: document.querySelector('#info-status a')?.getAttribute('href'),
        toc: document.getElementById('toc').hidden,
      }));
      ok('error state: message, retry button and link to the CDC page', /接種資訊暫時無法載入/.test(err.text) && err.retry && /^https:\/\/www\.cdc\.gov\.tw\//.test(err.link) && err.toc, JSON.stringify(err));
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await routeInfo(page, 'sample');
      await page.locator('#info-status button').click();
      await ready(page);
      ok('error state: retry loads the data', (await page.locator('section.isec').count()) >= 7);
      await ctx.close();
    }

    /* ---------------- 惡意資料 ---------------- */
    console.log('\n=== 惡意資料（hostile fixture） ===');
    for (const lang of ['zh-Hant', 'en']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW' });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      let dialog = false;
      page.on('dialog', (d) => { dialog = true; d.dismiss(); });
      await routeInfo(page, 'hostile');
      await page.goto(`${base}info.html${lang === 'en' ? '#lang=en' : ''}`, { waitUntil: 'load' });
      await ready(page);
      await page.waitForTimeout(300);
      const h = await page.evaluate(() => {
        const root = document.querySelector('main');
        const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
        const onAttrs = [...document.querySelectorAll('*')].flatMap((n) => [...n.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${n.tagName}.${a.name}`));
        return {
          danger: hrefs.filter((x) => /^\s*(javascript|data|vbscript):/i.test(x) || /^\/\//.test(x) || /^http:/i.test(x) || /evil/i.test(x) || /@/.test(x)),
          ext: hrefs.filter((x) => /^https?:/i.test(x) && !/^https:\/\/(([a-z0-9-]+\.)*(gov\.tw|gov\.taipei)|www\.youtube\.com|youtu\.be)\//i.test(x)),
          tags: root.querySelectorAll('script, img, iframe, svg[onload], object, embed, b').length,
          onAttrs,
          titleText: document.getElementById('info-title').textContent,
          coinTitle: document.querySelector('#coins h2')?.textContent,
          literal: root.textContent.includes('<img src=x onerror=alert(2)><b>bold</b>'),
          ids: [...document.querySelectorAll('section.isec')].map((s) => s.id),
          protoKey: document.querySelectorAll('section.isec[data-key="other"]').length,
          fileExt: [...document.querySelectorAll('.file__ext')].map((e) => e.textContent),
          plainLinks: [...document.querySelectorAll('#coins .lrow__a.is-plain .lrow__t')].map((e) => e.textContent),
          fakeVideo: document.querySelectorAll('#coins .lrow--video').length,
        };
      });
      ok(`hostile ${lang}: no javascript:/data:/http:/protocol-relative/off-domain hrefs`, h.danger.length === 0 && h.ext.length === 0, JSON.stringify([h.danger, h.ext]));
      ok(`hostile ${lang}: no injected elements (script/img/iframe/b) in main`, h.tags === 0, `${h.tags}`);
      ok(`hostile ${lang}: no on* attributes anywhere`, h.onAttrs.length === 0, h.onAttrs.join());
      ok(`hostile ${lang}: markup in text rendered literally`, h.literal && h.titleText.startsWith('<img') && h.coinTitle.startsWith('<script>'), JSON.stringify([h.titleText, h.coinTitle]));
      ok(`hostile ${lang}: bad key → "other", bad id/ext ignored`, h.ids.includes('other-2') && h.protoKey === 2 && h.fileExt.every((e) => /^[A-Z0-9]{1,4}$/.test(e)), JSON.stringify([h.ids, h.fileExt]));
      ok(`hostile ${lang}: links with rejected hrefs (javascript:, look-alike video hosts) render as text, not <a>`, h.plainLinks.includes('<svg onload=alert(4)>') && h.plainLinks.includes('fake video') && h.fakeVideo === 0, JSON.stringify(h.plainLinks));
      ok(`hostile ${lang}: no dialog, no errors`, !dialog && errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    /* ---------------- 管線實際輸出（有檔案時才測） ---------------- */
    const realDir = path.join(ROOT, 'public/data/info');
    if (fs.existsSync(path.join(realDir, 'zh-Hant.json')) && fs.existsSync(path.join(realDir, 'en.json'))) {
      console.log('\n=== 管線實際輸出 public/data/info/*.json ===');
      const realEn = JSON.parse(fs.readFileSync(path.join(realDir, 'en.json'), 'utf8'));
      for (const [lang, hash] of [['zh-Hant', ''], ['en', '#lang=en']]) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-TW' });
        const page = await ctx.newPage();
        const errors = watchErrors(page);
        await page.goto(`${base}info.html${hash}`, { waitUntil: 'load' });
        await ready(page);
        const r = await page.evaluate(() => ({
          n: document.querySelectorAll('section.isec').length,
          coins: [...document.querySelectorAll('#coins .coin__num')].map((x) => x.textContent).join('/'),
          elig: document.querySelectorAll('#eligibility .icard').length,
          untr: document.querySelectorAll('.isec__body[lang="zh-Hant-TW"]').length,
          notice: document.getElementById('info-notice').hidden ? '' : document.getElementById('info-notice').textContent,
          empty: [...document.querySelectorAll('.isec__body')].filter((b) => !b.children.length).length,
        }));
        ok(`real ${lang}: renders ≥7 sections, eligibility cards, no empty bodies`, r.n >= 7 && r.elig > 0 && r.empty === 0, JSON.stringify(r));
        ok(`real ${lang}: coin badges parsed (or gracefully absent)`, r.coins === '' || /^\d+\/\d+\/\d+$/.test(r.coins), r.coins);
        if (lang === 'en') {
          const untranslated = realEn.sections.filter((x) => x && x.translated === false).length;
          ok('real en: untranslated sections carry lang=zh-Hant-TW and a notice', r.untr === untranslated && (untranslated === 0 || r.notice.length > 0 || (await page.locator('.untr').count()) > 0), JSON.stringify({ untranslated, ...r }));
        }
        ok(`real ${lang}: no console errors`, errors.length === 0, errors.join(' | '));
        await ctx.close();
      }
    } else {
      console.log('\n(略過：public/data/info/*.json 尚未產生)');
    }

    /* ---------------- 地圖頁頁首 ---------------- */
    console.log('\n=== 地圖頁頁首導覽 ===');
    for (const [vpName, vpOpts] of VIEWPORTS) {
      const ctx = await browser.newContext({ ...vpOpts, locale: 'zh-TW' });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForFunction(() => /\d/.test(document.getElementById('results-heading')?.textContent || ''), null, { timeout: 15000 });
      const nav = await page.evaluate(() => {
        const a = document.querySelector('.site-nav a[data-nav="info"]');
        const r = a.getBoundingClientRect();
        const header = document.querySelector('.app-header').getBoundingClientRect();
        const nav = document.querySelector('.site-nav');
        nav.style.display = 'none';
        const headerWithout = document.querySelector('.app-header').getBoundingClientRect().height;
        nav.style.display = '';
        return { href: a.getAttribute('href'), w: r.width, h: r.height, right: r.right, vw: innerWidth, headerH: header.height, headerWithout, scrollW: document.documentElement.scrollWidth };
      });
      ok(`map ${vpName}: header link to ./info.html, ≥44px, fits in the header`, nav.href === './info.html' && nav.w >= 44 && nav.h >= 44 && nav.right <= nav.vw && nav.scrollW <= nav.vw, JSON.stringify(nav));
      ok(`map ${vpName}: the nav does not make the header taller`, nav.headerH <= nav.headerWithout + 0.5, `${nav.headerH} vs ${nav.headerWithout}`);
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`\n${passCount} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
