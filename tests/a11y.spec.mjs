#!/usr/bin/env node
// 無障礙檢查（不使用外部函式庫）。執行：node tests/a11y.spec.mjs
// 只回報問題，不修改 public/ 底下的檔案。
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let playwright;
try {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const req = createRequire(path.join(globalRoot, 'package.json'));
  playwright = req(path.join(globalRoot, 'playwright'));
} catch (e) {
  console.error('無法載入全域安裝的 playwright 套件。');
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
    child.stdout.on('data', (d) => { if (!done && /listening|dev server/i.test(String(d))) { done = true; resolve(child); } });
    child.stderr.on('data', (d) => process.stderr.write(`[dev-server] ${d}`));
    child.on('error', reject);
    child.on('exit', (code) => { if (!done) reject(new Error(`dev-server exited early with code ${code}`)); });
    setTimeout(() => { if (!done) { done = true; resolve(child); } }, 1500);
  });
}

const findings = [];
function report(category, detail) {
  findings.push({ category, detail });
  console.log(`  [${category}] ${detail}`);
}

/* ------------------------------------------------------------------ *
 * Contrast helpers (WCAG relative luminance / contrast ratio)
 * ------------------------------------------------------------------ */
function srgbToLin(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]) {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function parseColor(str) {
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
  return parts;
}
function contrastRatio(fg, bg) {
  const L1 = luminance(fg);
  const L2 = luminance(bg);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}
// Composite a possibly-transparent foreground/background pair over white,
// approximating what the browser actually paints (used when bg has alpha<1).
function compositeOverWhite([r, g, b, a = 1]) {
  if (a >= 1) return [r, g, b];
  return [r * a + 255 * (1 - a), g * a + 255 * (1 - a), b * a + 255 * (1 - a)];
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const server = await startServer(port);
  await new Promise((r) => setTimeout(r, 300));

  let browser;
  try {
    browser = await chromium.launch();

    /* ---------------- Desktop pass: names, lang, h1, images, tab order, contrast ---------------- */
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#results-heading');
    await page.waitForFunction(() => /\d/.test(document.getElementById('results-heading')?.textContent || ''));

    console.log('\n=== 靜態結構檢查 ===');

    const lang = await page.evaluate(() => document.documentElement.getAttribute('lang'));
    if (!lang) report('lang', 'html 元素缺少 lang 屬性');
    else console.log(`  ok - html[lang]="${lang}"`);

    const h1Count = await page.locator('h1').count();
    if (h1Count !== 1) report('h1', `頁面上有 ${h1Count} 個 h1（應恰好 1 個）`);
    else console.log('  ok - exactly one h1');

    // Accessible names for every button/link/input via the accessibility tree.
    const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
    const unnamed = [];
    function walk(node) {
      if (!node) return;
      if (['button', 'link', 'textbox', 'combobox', 'searchbox'].includes(node.role)) {
        if (!node.name || !node.name.trim()) unnamed.push(node.role);
      }
      (node.children || []).forEach(walk);
    }
    walk(snapshot);
    if (unnamed.length) report('accessible-name', `${unnamed.length} 個互動元素缺少可存取名稱：${unnamed.slice(0, 10).join(', ')}`);
    else console.log('  ok - every button/link/input has an accessible name (via a11y tree)');

    // Chips / panel options expose aria-pressed.
    const chipCount = await page.locator('.chip--group, .opt').count();
    const chipsMissingPressed = await page.evaluate(() => {
      const chips = document.querySelectorAll('.chip--group, .opt');
      return [...chips].filter((c) => !c.hasAttribute('aria-pressed')).length;
    });
    if (chipsMissingPressed > 0) report('aria-pressed', `${chipsMissingPressed}/${chipCount} 個 chip 缺少 aria-pressed`);
    else console.log(`  ok - all ${chipCount} chips expose aria-pressed`);

    // Filter disclosure: button with aria-expanded + aria-controls → labelled region; tokens are a list.
    const disclosure = await page.evaluate(() => {
      const btn = document.getElementById('filter-toggle');
      const target = btn && document.getElementById(btn.getAttribute('aria-controls') || '');
      const labelledBy = target && target.getAttribute('aria-labelledby');
      const tokens = document.getElementById('tokens');
      return {
        hasBtn: !!btn,
        expanded: btn?.getAttribute('aria-expanded'),
        controlsExists: !!target,
        regionLabelled: !!(target && target.tagName === 'SECTION' && labelledBy && document.getElementById(labelledBy)?.textContent.trim()),
        tokensIsList: tokens?.tagName === 'UL' && !!tokens.getAttribute('aria-label'),
      };
    });
    if (!disclosure.hasBtn || !['true', 'false'].includes(disclosure.expanded) || !disclosure.controlsExists) {
      report('disclosure', `篩選按鈕需有 aria-expanded 與指向存在元素的 aria-controls：${JSON.stringify(disclosure)}`);
    } else console.log('  ok - 篩選 disclosure button has aria-expanded + aria-controls');
    if (!disclosure.regionLabelled) report('disclosure', '篩選面板應為具名稱的 region（section + aria-labelledby）');
    else console.log('  ok - filter panel is a labelled region');
    if (!disclosure.tokensIsList) report('tokens', '已套用條件標籤列應為具 aria-label 的清單 (ul)');
    else console.log('  ok - active-filter tokens are a labelled list');

    // Images / SVG icons: aria-hidden or labelled.
    const badIcons = await page.evaluate(() => {
      const svgs = [...document.querySelectorAll('svg')];
      const imgs = [...document.querySelectorAll('img')];
      const bad = [];
      for (const svg of svgs) {
        const hidden = svg.getAttribute('aria-hidden') === 'true';
        const labelled = svg.hasAttribute('aria-label') || svg.hasAttribute('aria-labelledby') || svg.querySelector('title');
        if (!hidden && !labelled) bad.push(svg.outerHTML.slice(0, 80));
      }
      for (const img of imgs) {
        // alt="" (present but empty) is the correct, intentional way to mark a
        // decorative image — only flag images with NO alt attribute at all.
        const hasAlt = img.hasAttribute('alt');
        const hidden = img.getAttribute('aria-hidden') === 'true';
        if (!hasAlt && !hidden) bad.push(img.outerHTML.slice(0, 80));
      }
      return bad;
    });
    if (badIcons.length) report('icon-labelling', `${badIcons.length} 個圖示/圖片既未 aria-hidden 也未提供替代文字，例如：${badIcons[0]}`);
    else console.log('  ok - all SVG icons / images are aria-hidden or labelled');

    // Tab order reaches search -> chips -> list (roughly, in document order).
    await page.locator('#search-input').focus();
    const order = [];
    for (let i = 0; i < 15; i++) {
      const id = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className));
      order.push(id);
      await page.keyboard.press('Tab');
    }
    const searchIdx = order.findIndex((x) => x === 'search-input');
    const filterIdx = order.indexOf('filter-toggle');
    const locateIdx = order.indexOf('locate-btn');
    const chipIdx = order.findIndex((x, i) => i > searchIdx && typeof x === 'string' && x.includes('chip'));
    if (!(searchIdx < filterIdx && filterIdx < locateIdx && locateIdx < chipIdx)) {
      report('tab-order', `預期順序 search → 篩選 → 定位 → 品項 chip：${JSON.stringify(order.slice(0, 8))}`);
    } else {
      console.log('  ok - tab order: search → 篩選 → 定位 → group chips');
    }
    const cardBtnIdx = order.findIndex((x, i) => i > chipIdx && typeof x === 'string' && x.includes('card__btn'));
    if (searchIdx === -1 || chipIdx === -1) {
      report('tab-order', `Tab 順序未能在前 15 站內從 search-input 到達 chip：${JSON.stringify(order)}`);
    } else if (cardBtnIdx === -1) {
      console.log(`  info - tab order reaches search -> chip within 15 tabs (${JSON.stringify(order)}); list card not reached in this window (may need more tabs since filter controls come first)`);
    } else {
      console.log('  ok - tab order reaches search -> chips -> list');
    }

    /* ---------------- Contrast: light + dark, main text styles ---------------- */
    console.log('\n=== 色彩對比 (WCAG) ===');
    // 讓標籤列與徽章出現，一併檢查對比
    await page.evaluate(() => { location.hash = 'g=covid&stock=1'; });
    await page.waitForSelector('#tokens .token');
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      // chip 有 .15s 顏色轉場；等轉場結束再取樣，避免量到中間色
      await page.waitForTimeout(400);
      const samples = await page.evaluate(() => {
        function pick(sel) {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { selector: sel, color: cs.color, background: cs.backgroundColor, bgAncestor: (() => {
            let n = el;
            while (n) {
              const c = getComputedStyle(n).backgroundColor;
              if (c && !/rgba\(0, 0, 0, 0\)/.test(c) && c !== 'transparent') return c;
              n = n.parentElement;
            }
            return 'rgb(255,255,255)';
          })() };
        }
        return [
          pick('body'),
          pick('#results-heading'),
          pick('.card__meta'),
          pick('.brand__sub'),
          pick('.chip'),
          pick('.chip[aria-pressed="true"]'),
          pick('.token'),
          pick('.count-badge'),
        ].filter(Boolean);
      });
      for (const s of samples) {
        const fg = parseColor(s.color);
        let bgRaw = parseColor(s.background);
        if (!bgRaw || bgRaw[3] === 0) bgRaw = parseColor(s.bgAncestor) || [255, 255, 255];
        if (!fg) continue;
        const fgComposited = compositeOverWhite(fg);
        const bgComposited = compositeOverWhite(bgRaw);
        const ratio = contrastRatio(fgComposited, bgComposited);
        const pass = ratio >= 4.5;
        console.log(`  ${pass ? 'ok' : 'FAIL'} - [${scheme}] ${s.selector}: ${ratio.toFixed(2)}:1 (fg ${s.color} on ${s.background !== 'rgba(0, 0, 0, 0)' ? s.background : s.bgAncestor})`);
        if (!pass) report('contrast', `[${scheme}] ${s.selector} 對比僅 ${ratio.toFixed(2)}:1（需 ≥4.5:1）`);
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await context.close();

    /* ---------------- Mobile pass: tap target sizes ---------------- */
    console.log('\n=== Mobile 最小點擊區域 (>=44x44 CSS px) ===');
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mpage = await mctx.newPage();
    await mpage.goto(baseUrl, { waitUntil: 'load' });
    await mpage.waitForSelector('#results-heading');
    await mpage.waitForFunction(() => /\d/.test(document.getElementById('results-heading')?.textContent || ''));
    await mpage.waitForTimeout(300);

    // 有效觸控範圍 = 元素本身 ∪ 絕對定位的 ::before/::after（常見的「延伸點擊區」與
    // 「整張卡片可點」stretched-link 手法）。Leaflet 版權列的行內連結適用 WCAG 2.5.8 的
    // inline 例外，另行列為 info。
    const measureTargets = () => mpage.evaluate(() => {
      const px = (v) => (v === 'auto' ? null : parseFloat(v));
      function hitRect(el) {
        const r = el.getBoundingClientRect();
        let { left, top, right, bottom } = r;
        for (const pseudo of ['::before', '::after']) {
          const ps = getComputedStyle(el, pseudo);
          if (ps.content === 'none' || ps.position !== 'absolute') continue;
          const selfPositioned = getComputedStyle(el).position !== 'static';
          const cb = selfPositioned ? r : (el.offsetParent || document.body).getBoundingClientRect();
          const l = px(ps.left), t = px(ps.top), rr = px(ps.right), b = px(ps.bottom);
          if ([l, t, rr, b].some((x) => x == null || Number.isNaN(x))) continue;
          left = Math.min(left, cb.left + l); top = Math.min(top, cb.top + t);
          right = Math.max(right, cb.right - rr); bottom = Math.max(bottom, cb.bottom - b);
        }
        return { w: right - left, h: bottom - top };
      }
      const els = [...document.querySelectorAll('button, a[href], select, input, [role="button"]')];
      const bad = [], inline = [];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const sel = el.id ? `#${el.id}` : el.className ? `.${String(el.className).split(' ').filter(Boolean).join('.')}` : el.tagName;
        const { w, h } = hitRect(el);
        if (w >= 44 - 0.5 && h >= 44 - 0.5) continue;
        if (el.closest('.leaflet-control-attribution')) { inline.push(sel); continue; }
        bad.push({ sel, w: Math.round(w), h: Math.round(h) });
      }
      return { bad, inline };
    });
    const passes = [['initial', null], ['tokens shown', 'g=covid&p=mod_adult&stock=1&city=%E8%87%BA%E5%8C%97%E5%B8%82'], ['panel open', 'OPEN']];
    let offenderTotal = 0;
    for (const [label, hash] of passes) {
      if (hash === 'OPEN') { await mpage.locator('#filter-toggle').tap(); await mpage.waitForTimeout(350); }
      else if (hash) { await mpage.evaluate((h) => { location.hash = h; }, hash); await mpage.waitForTimeout(500); }
      const { bad, inline } = await measureTargets();
      offenderTotal += bad.length;
      if (bad.length) {
        report('tap-target', `[${label}] ${bad.length} 個互動元素在手機寬度下小於 44x44px`);
        for (const o of bad.slice(0, 30)) console.log(`    - ${o.sel}: ${o.w}x${o.h}`);
      } else {
        console.log(`  ok - [${label}] no tap targets under 44x44px`);
      }
      if (inline.length) console.log(`  info - [${label}] ${inline.length} 個地圖版權列行內連結適用 WCAG 2.5.8 inline 例外：${inline.join(', ')}`);
    }
    await mctx.close();
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  console.log(`\n=== 總結：${findings.length} 項發現 ===`);
  for (const f of findings) console.log(`  - [${f.category}] ${f.detail}`);
  // This is a reporting-only pass (per task spec: "Report findings; don't fix"),
  // so it exits non-zero only when findings exist, to be usable in CI while
  // still surfacing everything above for a human to triage.
  process.exit(findings.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
