// 接種資訊頁（前端）的純函式與靜態檢查。執行：node --test tests/info-ui.test.mjs
// （管線 scripts/*-info.mjs 的測試在 tests/info.test.mjs，由管線維護）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  safeHref, normalizeInfo, parseCoins, parseCell, splitLinkList, parseInfoHash, buildInfoHash, findSection,
  bareUrl, stripMarker, fileLang, cleanStr, SECTION_KEYS, soleLink, nestList, noBreakHyphen, isVideoHref,
} from '../public/js/info-parse.js';
import { navHref } from '../public/js/nav.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures', f), 'utf8'));

test('safeHref: https + gov.tw / *.gov.tw / *.gov.taipei / www.youtube.com / youtu.be only', () => {
  for (const ok of ['https://www.cdc.gov.tw/File/Get/x', 'https://gov.tw/SWK', 'https://health.gov.taipei/cp.aspx?n=1', 'https://WWW.CDC.GOV.TW/a',
    'https://www.youtube.com/watch?v=i9sFsyunSfw', 'https://youtu.be/i9sFsyunSfw']) assert.ok(safeHref(ok), ok);
  for (const bad of ['http://www.cdc.gov.tw/', 'javascript:alert(1)', 'data:text/html,x', '//www.cdc.gov.tw/', '/File/Get/x',
    'https://evil.example/gov.tw', 'https://cdc.gov.tw.evil.example/', 'https://xgov.tw/', 'https://user:pw@www.cdc.gov.tw/',
    'https://www.cdc.gov.tw:8443/', ' javascript:alert(1)', null, 42,
    // 影片網域只接受完全相符的主機
    'http://www.youtube.com/watch?v=x', 'https://youtube.com/watch?v=x', 'https://m.youtube.com/watch?v=x', 'https://music.youtube.com/x',
    'https://www.youtube.com.evil.example/watch', 'https://youtu.be.evil.example/x', 'https://evil.example/www.youtube.com', 'https://www.youtube.com:444/x',
    'https://user@youtu.be/x', 'https://www.youtube-nocookie.com/embed/x', `https://www.cdc.gov.tw/${'a'.repeat(3000)}`]) {
    assert.equal(safeHref(bad), null, String(bad).slice(0, 60));
  }
});

test('cleanStr strips control / bidi / zero-width characters', () => {
  assert.equal(cleanStr('a‮b​c\u0007d'), 'abcd');
  assert.equal(cleanStr({}), '');
});

test('normalizeInfo: fixture sorts sections by key order and assigns unique anchors', () => {
  const d = normalizeInfo(fixture('info.sample.json'));
  assert.deepEqual(d.sections.map((s) => s.anchor), ['coins', 'eligibility', 'where', 'precautions', 'brands', 'education', 'education-2', 'faq', 'news', 'other']);
  assert.equal(d.meta.sourceUrl, 'https://www.cdc.gov.tw/Category/MPage/S_ZLz0yyc2lAQ9TStMB0uA');
  assert.ok(d.meta.fetchedAt instanceof Date && d.sections[0].updated instanceof Date);
  // 新聞稿去重
  assert.equal(d.sections.find((s) => s.key === 'news').links.length, 5);
  assert.ok(SECTION_KEYS.every((k) => d.sections.some((s) => s.key === k)));
});

test('normalizeInfo: hostile fixture — unknown blocks dropped, hrefs filtered, bad keys → other', () => {
  const d = normalizeInfo(fixture('info.hostile.json'));
  const hrefs = [];
  JSON.stringify(d, (k, v) => { if (k === 'href' || k === 'sourceUrl') hrefs.push(v); return v; });
  assert.ok(hrefs.length > 50);
  assert.deepEqual(hrefs.filter((h) => h !== null && !/^https:\/\/(([a-z0-9-]+\.)*(gov\.tw|gov\.taipei)|www\.youtube\.com|youtu\.be)\//.test(h)), [], 'no dangerous hrefs survive');
  assert.ok(!hrefs.some((h) => h && /evil|m\.youtube|^http:/.test(h)), 'video look-alikes dropped');
  // 惡意字串只會以純文字留下（前端用 textContent）
  assert.ok(JSON.stringify(d).includes('<iframe src=javascript:alert(6)>'));
  assert.ok(!d.sections.some((s) => s.blocks.some((b) => b.type === 'html')));
  const weird = d.sections.find((s) => s.title === 'weird section');
  assert.equal(weird.key, 'other');
  assert.equal(weird.id, '');
  assert.deepEqual(weird.links, []);
  assert.deepEqual(weird.blocks, [{ type: 'list', ordered: false, items: ['ok item'] }]);
  const evilFile = d.sections.find((s) => s.key === 'precautions').files.find((f) => f.text === 'evil file');
  assert.equal(evilFile.href, null);
  assert.equal(evilFile.ext, '');
  assert.equal(normalizeInfo(null), null);
  assert.equal(normalizeInfo({ sections: 'x' }), null);
});

test('parseCoins: zh (number after name), en (number before), ja, fallback', () => {
  const want = { flu: 450, covid: 900, pcv: 600 };
  assert.deepEqual(parseCoins(['自2026年10月1日起，年滿18歲民眾…', '其中，完成指定疫苗接種還可獲得「疫苗加值金」：接種流感疫苗可獲得450幣、新冠疫苗900幣、肺炎鏈球菌疫苗600幣，接種疫苗顧健康！']), want);
  assert.deepEqual(parseCoins(['Completing designated vaccinations also earns a “vaccine bonus”: 450 coins for the flu vaccine, 900 for a COVID-19 vaccine and 600 for a pneumococcal vaccine.']), want);
  assert.deepEqual(parseCoins(['インフルエンザワクチンで450コイン、新型コロナワクチンで900コイン、肺炎球菌ワクチンで600コイン']), want);
  assert.deepEqual(parseCoins(['Get 1,200 coins for flu, 900 coins for COVID-19 and 600 coins for pneumococcal vaccines']), { flu: 1200, covid: 900, pcv: 600 });
  assert.equal(parseCoins(['接種流感疫苗可獲得健康幣，詳情請見網站']), null);
  assert.equal(parseCoins(['2026年10月1日起流感、新冠、肺鏈疫苗開打，18歲以上可累積健康幣']), null);
});

test('parseCell: ● / ✖ / notes', () => {
  assert.deepEqual(parseCell('●'), { mark: 'yes', note: '' });
  assert.deepEqual(parseCell('●(未滿6歲且從未接種新冠疫苗)'), { mark: 'yes', note: '(未滿6歲且從未接種新冠疫苗)' });
  assert.deepEqual(parseCell('✓'), { mark: 'yes', note: '' });
  assert.deepEqual(parseCell('✖'), { mark: 'no', note: '' });
  assert.deepEqual(parseCell('視情況'), { mark: null, note: '視情況' });
});

test('splitLinkList: county paragraphs → items; ordinary paragraphs → null', () => {
  const d = normalizeInfo(fixture('info.sample.json'));
  const where = d.sections.find((s) => s.key === 'where');
  const grids = where.blocks.filter((b) => b.runs).map((b) => splitLinkList(b.runs));
  assert.equal(grids[0], null);
  assert.equal(grids[1].length, 22);
  assert.equal(grids[2].length, 23);
  assert.deepEqual(grids[1][9], { text: '彰化縣', href: null });
  // 來源把右括號放在另一個連結裡
  const odd = [{ text: '臺北市', href: 'https://a.gov.tw/' }, { text: '、' }, { text: '臺中市(成人', href: 'https://b.gov.tw/' }, { text: ')', href: 'https://c.gov.tw/' }, { text: '、' },
    ...['新北市', '基隆市', '宜蘭縣', '桃園市'].flatMap((c, i) => [{ text: c, href: `https://d${i}.gov.tw/` }, { text: '、' }])];
  assert.deepEqual(splitLinkList(odd).slice(0, 2), [{ text: '臺北市', href: 'https://a.gov.tw/' }, { text: '臺中市(成人)', href: 'https://b.gov.tw/' }]);
  assert.equal(splitLinkList([{ text: '更多詳情請查詢' }, { text: '健康幣網站', href: 'https://x.gov.tw/' }]), null);
});

test('hash scheme: #<anchor>[&lang=<lang>]', () => {
  assert.deepEqual(parseInfoHash('#coins&lang=en'), { section: 'coins', lang: 'en' });
  assert.deepEqual(parseInfoHash('#lang=ja&other-2'), { section: 'other-2', lang: 'ja' });
  assert.deepEqual(parseInfoHash('#s=faq'), { section: 'faq', lang: null });
  assert.deepEqual(parseInfoHash('#<img>'), { section: null, lang: null });
  assert.equal(buildInfoHash({ section: 'coins', lang: 'zh-Hant' }), 'coins');
  assert.equal(buildInfoHash({ section: 'coins', lang: 'en' }), 'coins&lang=en');
  assert.equal(buildInfoHash({ lang: 'en' }), 'lang=en');
  const d = normalizeInfo(fixture('info.sample.json'));
  assert.equal(findSection(d.sections, '103065').anchor, 'news');
  assert.equal(findSection(d.sections, 'education-2').id, '103068');
  assert.equal(findSection(d.sections, 'nope'), null);
});

test('navHref carries the language between pages', () => {
  assert.equal(navHref('info', 'zh-Hant'), './info.html');
  assert.equal(navHref('info', 'en'), './info.html#lang=en');
  assert.equal(navHref('map', 'ja', 'g=flu'), './index.html#g=flu&lang=ja');
});

test('misc helpers', () => {
  assert.equal(bareUrl(' https://www.cdc.gov.tw/Category/List/x '), 'https://www.cdc.gov.tw/Category/List/x');
  assert.equal(bareUrl('https://reurl.cc/8Y7kvd'), null);
  assert.equal(bareUrl('https://youtu.be/abc'), 'https://youtu.be/abc');
  assert.deepEqual(stripMarker('▲【公費流感疫苗】'), { marked: true, text: '【公費流感疫苗】' });
  assert.equal(fileLang('接種須知_英文版_1150707'), 'en');
  assert.equal(fileLang('consent form (English)'), 'en');
  assert.equal(fileLang('接種須知_中文版_1150707'), 'zh');
  assert.equal(fileLang('公費流感疫苗接種須知'), null);
});

test('info.html: same CSP as the map (minus tile hosts), Trusted Types on, no inline script/style', () => {
  const info = fs.readFileSync(path.join(ROOT, 'public/info.html'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const csp = (h) => h.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.equal(csp(info), csp(index).replace(/img-src 'self' data:[^;]*;/, "img-src 'self' data:;"));
  assert.match(csp(info), /require-trusted-types-for 'script'; trusted-types default/);
  assert.ok(info.includes('<script src="js/trusted-types.js"></script>'));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(info), 'no inline <script>');
  assert.ok(!/<style|\sstyle="/.test(info), 'no inline styles');
});

test('info page JS never uses innerHTML / insertAdjacentHTML / document.write', () => {
  for (const f of ['info.js', 'info-render.js', 'info-parse.js', 'nav.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8');
    assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|new Function|eval\(/.test(src), f);
  }
});

test('pipeline shapes: runs without links → plain text; list levels → tree; link-only paragraphs', () => {
  const d = normalizeInfo({ meta: {}, sections: [{ id: '1', key: 'brands', title: 't', blocks: [
    { type: 'p', text: '1.建議', runs: [{ text: '1.建議' }] },
    { type: 'p', text: 'Q&A', runs: [{ text: 'Q&A', href: 'https://www.cdc.gov.tw/x' }] },
    { type: 'list', items: ['A', 'a1', 'a2', 'B', 'b1'], levels: [0, 1, 1, 0, 1] },
    { type: 'list', items: ['x', 'y'], levels: [0, 9] },
  ] }] });
  const [p1, p2, l1, l2] = d.sections[0].blocks;
  assert.deepEqual(p1, { type: 'p', text: '1.建議' });
  assert.deepEqual(soleLink(p2), { text: 'Q&A', href: 'https://www.cdc.gov.tw/x' });
  assert.equal(soleLink(p1), null);
  assert.deepEqual(nestList(l1.items, l1.levels).map((n) => [n.text, n.children.map((c) => c.text)]), [['A', ['a1', 'a2']], ['B', ['b1']]]);
  assert.equal(l2.levels, undefined, 'invalid levels ignored');
  assert.deepEqual(nestList(['a', 'b', 'c'], [0, 2, 1]).map((n) => n.children.map((c) => c.text)), [['b', 'c']]);
});

test('noBreakHyphen keeps COVID-19 together but leaves dates and ranges alone', () => {
  assert.equal(noBreakHyphen('2026 Flu & COVID-19 Hub'), '2026 Flu & COVID\u201119 Hub');
  assert.equal(noBreakHyphen('2026-09-23, 55-64'), '2026-09-23, 55-64');
});

test('isVideoHref: only the two whitelisted video hosts', () => {
  assert.equal(isVideoHref('https://www.youtube.com/watch?v=i9sFsyunSfw'), true);
  assert.equal(isVideoHref('https://youtu.be/i9sFsyunSfw'), true);
  assert.equal(isVideoHref('https://www.cdc.gov.tw/Advocacy/SubIndex/x'), false);
  assert.equal(isVideoHref('https://m.youtube.com/watch?v=x'), false);
  assert.equal(isVideoHref('javascript:alert(1)'), false);
  const d = normalizeInfo(fixture('info.sample.json'));
  const edu2 = d.sections.find((s) => s.anchor === 'education-2');
  assert.deepEqual(edu2.links.map((l) => isVideoHref(l.href)), [true, true]);
});
