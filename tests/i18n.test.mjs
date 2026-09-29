// 語系檔檢查：public/i18n/*.json 與繁中原文（zh-Hant.json）的一致性。
// 執行：node --test tests/i18n.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LANGS, DEFAULT_LANG } from '../public/js/logic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'public/i18n');
const read = (l) => JSON.parse(fs.readFileSync(path.join(DIR, `${l}.json`), 'utf8'));
const src = read(DEFAULT_LANG);
const en = read('en');
const keys = (o) => Object.keys(o).filter((k) => k !== '_status').sort();
const params = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

test('exactly one catalog per supported language, and nothing else', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  assert.deepEqual(files, [...SUPPORTED_LANGS].sort());
});

for (const lang of SUPPORTED_LANGS) {
  const c = read(lang);

  test(`${lang}: same key set as zh-Hant (no missing, no extra)`, () => {
    const want = keys(src);
    const got = keys(c);
    assert.deepEqual(want.filter((k) => !got.includes(k)), [], 'missing keys');
    assert.deepEqual(got.filter((k) => !want.includes(k)), [], 'extra keys');
  });

  test(`${lang}: every value is a non-empty string`, () => {
    for (const [k, v] of Object.entries(c)) {
      assert.equal(typeof v, 'string', k);
      if (k === 'notice.after') continue; // 泰文等語言在連結後不需要句點，允許空字串
      assert.ok(v.trim().length > 0, `empty string: ${k}`);
    }
  });

  test(`${lang}: every {param} in zh-Hant appears in the translation (and no unknown params)`, () => {
    for (const k of keys(src)) {
      if (c[k] == null) continue;
      assert.deepEqual(params(c[k]), params(src[k]), `${k}: "${c[k]}"`);
    }
  });

  test(`${lang}: _status and meta keys are valid`, () => {
    assert.ok(['source', 'reviewed', 'placeholder', 'draft'].includes(c._status), `_status=${c._status}`);
    if (lang === DEFAULT_LANG) assert.equal(c._status, 'source');
    else assert.notEqual(c._status, 'source');
    assert.ok(['ltr', 'rtl'].includes(c['meta.dir']));
    // 院所資料的顯示文字系統：han = 中文為主（zh-Hant、ja），latin = 英文轉寫為主（見 i18n.js displayParts）
    assert.ok(['han', 'latin'].includes(c['meta.script']), `meta.script=${c['meta.script']}`);
    if (lang === DEFAULT_LANG) assert.equal(c['meta.script'], 'han');
    assert.doesNotThrow(() => Intl.getCanonicalLocales(c['meta.locale']));
    assert.doesNotThrow(() => new Intl.DateTimeFormat(c['meta.locale'], { timeZone: 'Asia/Taipei' }));
    assert.ok(c['meta.short'].length <= 4, 'meta.short must fit the mobile switcher');
    // 圖釘的休診符號走 Trusted Types 允許清單，只能是這兩個
    assert.ok(['休', '×'].includes(c['glyph.closed']), `glyph.closed=${c['glyph.closed']}`);
  });

  test(`${lang}: no markup in strings (all strings are inserted as text)`, () => {
    for (const [k, v] of Object.entries(c)) assert.ok(!/[<>]/.test(v), `${k}: "${v}"`);
  });

  if (c._status === 'placeholder') {
    test(`${lang}: placeholder file holds English (allowed to equal en except meta.*)`, () => {
      for (const k of keys(en)) {
        if (k.startsWith('meta.')) continue;
        assert.equal(c[k], en[k], `${k} should be the English placeholder until translated`);
      }
    });
  }
}

test('non-default catalogs translate the cities and products (not left in Chinese) — en', () => {
  for (const k of keys(en)) {
    if (/^(city|vaccine|group)\./.test(k)) assert.ok(!/[一-鿿]/.test(en[k]), `${k}: "${en[k]}"`);
  }
});

test('index.html: switcher options = supported languages, labelled with each meta.langName', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const sel = html.match(/<select id="lang-select"[\s\S]*?<\/select>/)[0];
  const opts = [...sel.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(opts.map((o) => o[0]), [...SUPPORTED_LANGS]);
  for (const [l, name] of opts) assert.equal(name, read(l)['meta.langName'], l);
});

test('every key referenced by index.html and the JS modules exists in zh-Hant', () => {
  const used = new Set();
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(';')) used.add(pair.split(':')[1]);
  }
  for (const f of ['app.js', 'ui.js', 'map.js', 'i18n.js']) {
    const js = fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8');
    for (const m of js.matchAll(/\b(?:t|tn|tParts)\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 60, `found ${used.size}`);
  for (const k of used) assert.ok(k in src, `missing key: ${k}`);
});

test('catalog covers the data: every vaccine, group and city in hospitals.json', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/hospitals.json'), 'utf8'));
  for (const v of data.vaccines) {
    assert.ok(`vaccine.${v.id}.name` in src && `vaccine.${v.id}.short` in src, v.id);
    assert.equal(src[`vaccine.${v.id}.name`], v.name, `zh-Hant vaccine.${v.id}.name mirrors the data file`);
  }
  for (const g of data.groups) assert.ok(`group.${g.id}.name` in src && `group.${g.id}.chip` in src, g.id);
  for (const city of new Set(data.hospitals.map((h) => h.city))) assert.ok(`city.${city}` in src, city);
  assert.equal(keys(src).filter((k) => k.startsWith('city.')).length, 22);
});
