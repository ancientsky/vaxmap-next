// 單元測試：public/js/logic.js 的純函式
// 執行：node --test tests/logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  taipeiParts,
  todayIndex,
  currentPeriodBit,
  timeContext,
  deriveStatus,
  matchesFilters,
  haversineKm,
  formatDistance,
  normalizeText,
  tokenizeQuery,
  searchScore,
  sortResults,
  encodeState,
  decodeState,
  resolveVaccineIds,
  relevantProducts,
} from '../public/js/logic.js';

/* ------------------------------------------------------------------ *
 * Taipei time helpers — must be correct regardless of the machine's TZ.
 * We only pass explicit Date objects (never rely on `now` defaulting),
 * so these assertions hold no matter what TZ the test runner uses.
 * ------------------------------------------------------------------ */

test('todayIndex: 2026-09-21T00:30:00Z is Monday 08:30 Taipei -> 0', () => {
  const d = new Date('2026-09-21T00:30:00Z');
  assert.equal(todayIndex(d), 0);
  const p = taipeiParts(d);
  assert.equal(p.hour, 8);
  assert.equal(p.minute, 30);
});

test('todayIndex: 2026-09-20T17:00:00Z is already Monday 01:00 Taipei -> 0', () => {
  const d = new Date('2026-09-20T17:00:00Z');
  assert.equal(todayIndex(d), 0);
  const p = taipeiParts(d);
  assert.equal(p.hour, 1);
});

test('todayIndex: full week mapping Mon=0..Sun=6', () => {
  // 2026-09-21 is a Monday (Taipei). Add whole days at 04:00Z (=12:00 Taipei, safely mid-day).
  const base = new Date('2026-09-21T04:00:00Z');
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  labels.forEach((label, i) => {
    const d = new Date(base.getTime() + i * 86400000);
    assert.equal(todayIndex(d), i, `${label} should map to index ${i}`);
  });
});

test('todayIndex: Sunday Taipei maps to 6 (native JS Sunday=0 must be rotated)', () => {
  // 2026-09-27 is a Sunday in Taipei.
  const d = new Date('2026-09-27T04:00:00Z');
  assert.equal(todayIndex(d), 6);
});

test('currentPeriodBit: boundaries — 08:00 in, 07:59 out; 12:00 switches to bit 2; 18:00 switches to bit 4; 22:00 out', () => {
  // Use a Taipei local hour by choosing UTC = local-8h.
  const atTaipeiHour = (h, m = 0) => new Date(Date.UTC(2026, 8, 21, h - 8, m));
  assert.equal(currentPeriodBit(atTaipeiHour(7, 59)), 0);
  assert.equal(currentPeriodBit(atTaipeiHour(8, 0)), 1);
  assert.equal(currentPeriodBit(atTaipeiHour(11, 59)), 1);
  assert.equal(currentPeriodBit(atTaipeiHour(12, 0)), 2);
  assert.equal(currentPeriodBit(atTaipeiHour(17, 59)), 2);
  assert.equal(currentPeriodBit(atTaipeiHour(18, 0)), 4);
  assert.equal(currentPeriodBit(atTaipeiHour(21, 59)), 4);
  assert.equal(currentPeriodBit(atTaipeiHour(22, 0)), 0);
  assert.equal(currentPeriodBit(atTaipeiHour(0, 0)), 0);
});

test('timeContext: passthrough of an already-built {day,period} context', () => {
  const ctx = { day: 3, period: 2 };
  assert.strictEqual(timeContext(ctx), ctx);
});

/* ------------------------------------------------------------------ *
 * resolveVaccineIds / relevantProducts
 * ------------------------------------------------------------------ */

const VACCINES = [
  { id: 'flu', group: 'flu' },
  { id: 'mod_adult', group: 'covid' },
  { id: 'mod_child', group: 'covid' },
  { id: 'novavax', group: 'covid' },
  { id: 'pcv20', group: 'pcv' },
  { id: 'pcv21', group: 'pcv' },
  { id: 'antiviral', group: 'antiviral' },
];

test('resolveVaccineIds: whole group when no sub-products selected', () => {
  const ids = resolveVaccineIds({ groups: ['covid'], products: [] }, VACCINES);
  assert.deepEqual(ids.sort(), ['mod_adult', 'mod_child', 'novavax']);
});

test('resolveVaccineIds: narrowed to selected sub-products within the group', () => {
  const ids = resolveVaccineIds({ groups: ['covid'], products: ['mod_adult'] }, VACCINES);
  assert.deepEqual(ids, ['mod_adult']);
});

test('relevantProducts: no selection -> all stock keys the hospital carries', () => {
  const h = { stock: { flu: 3, pcv20: 0 } };
  assert.deepEqual(relevantProducts(h, []).sort(), ['flu', 'pcv20']);
  assert.deepEqual(relevantProducts(h, undefined).sort(), ['flu', 'pcv20']);
});

test('relevantProducts: selection filtered to ones the hospital actually offers', () => {
  const h = { stock: { flu: 3 } };
  assert.deepEqual(relevantProducts(h, ['flu', 'antiviral']), ['flu']);
});

/* ------------------------------------------------------------------ *
 * deriveStatus
 * ------------------------------------------------------------------ */

const MON_0830 = new Date('2026-09-21T00:30:00Z'); // Mon 08:30 Taipei -> period bit 1

test('deriveStatus: ok when open today and selected product has stock', () => {
  const h = { hours: [1, 0, 0, 0, 0, 0, 0], stock: { flu: 5 } };
  const s = deriveStatus(h, ['flu'], MON_0830);
  assert.equal(s.openToday, true);
  assert.equal(s.status, 'ok');
  assert.equal(s.hasStock, true);
});

test('deriveStatus: nostock when open today but selected product stock is 0', () => {
  const h = { hours: [1, 0, 0, 0, 0, 0, 0], stock: { flu: 0 } };
  const s = deriveStatus(h, ['flu'], MON_0830);
  assert.equal(s.status, 'nostock');
});

test('deriveStatus: nostock when selected product key is missing entirely (treated as 0)', () => {
  const h = { hours: [1, 0, 0, 0, 0, 0, 0], stock: { pcv20: 9 } };
  const s = deriveStatus(h, ['flu'], MON_0830);
  // 'flu' isn't a key in stock at all -> relevantProducts filters it out entirely,
  // so `products` is empty and hasStock is false via .some() on an empty array.
  assert.equal(s.status, 'nostock');
  assert.deepEqual(s.products, []);
});

test('deriveStatus: closed overrides stock — today is closed regardless of stock', () => {
  const h = { hours: [0, 0, 0, 0, 0, 0, 0], stock: { flu: 99 } };
  const s = deriveStatus(h, ['flu'], MON_0830);
  assert.equal(s.openToday, false);
  assert.equal(s.status, 'closed');
});

test('deriveStatus: with no selected products, any offered product with stock -> ok', () => {
  const h = { hours: [1, 0, 0, 0, 0, 0, 0], stock: { flu: 0, pcv20: 4 } };
  const s = deriveStatus(h, [], MON_0830);
  assert.equal(s.status, 'ok');
});

test('deriveStatus: with no selected products and all stock zero -> nostock', () => {
  const h = { hours: [1, 0, 0, 0, 0, 0, 0], stock: { flu: 0, pcv20: 0 } };
  const s = deriveStatus(h, [], MON_0830);
  assert.equal(s.status, 'nostock');
});

test('deriveStatus: does not throw when h.stock is entirely absent (relevantProducts guards with h.stock || {})', () => {
  const h = { hours: [1, 0, 0, 0, 0, 0, 0] }; // no `stock` key at all
  assert.doesNotThrow(() => deriveStatus(h, [], MON_0830));
  assert.doesNotThrow(() => deriveStatus(h, ['flu'], MON_0830));
  const s = deriveStatus(h, ['flu'], MON_0830);
  assert.equal(s.status, 'nostock');
  assert.deepEqual(s.products, []);
});

/* ------------------------------------------------------------------ *
 * matchesFilters
 * ------------------------------------------------------------------ */

function mkHospital(overrides = {}) {
  return {
    id: 1,
    name: '台大醫院',
    city: '臺北市',
    dist: '中正區',
    addr: '臺北市中正區中山南路7號',
    hours: [1, 1, 1, 1, 1, 1, 1],
    stock: { flu: 5, mod_adult: 0 },
    ...overrides,
  };
}

test('matchesFilters: vaccineIds is a union — hospital matches if it carries ANY of them', () => {
  const h = mkHospital({ stock: { pcv20: 0 } });
  assert.equal(matchesFilters(h, { vaccineIds: ['flu', 'pcv20'] }), true);
  assert.equal(matchesFilters(h, { vaccineIds: ['flu', 'antiviral'] }), false);
});

test('matchesFilters: empty vaccineIds means "不限" (unrestricted)', () => {
  const h = mkHospital();
  assert.equal(matchesFilters(h, { vaccineIds: [] }), true);
});

test('matchesFilters: 只看有庫存 (inStock) requires actual stock > 0 among relevant products', () => {
  const h = mkHospital({ stock: { flu: 0 } });
  assert.equal(matchesFilters(h, { inStock: true }), false);
  const h2 = mkHospital({ stock: { flu: 3 } });
  assert.equal(matchesFilters(h2, { inStock: true }), true);
});

test('matchesFilters: 今日有看診 (openToday) — Monday closed vs open', () => {
  const closedMon = mkHospital({ hours: [0, 1, 1, 1, 1, 1, 1] });
  assert.equal(matchesFilters(closedMon, { openToday: true }, MON_0830), false);
  const openMon = mkHospital({ hours: [1, 1, 1, 1, 1, 1, 1] });
  assert.equal(matchesFilters(openMon, { openToday: true }, MON_0830), true);
});

test('matchesFilters: city / dist exact match', () => {
  const h = mkHospital();
  assert.equal(matchesFilters(h, { city: '臺北市' }), true);
  assert.equal(matchesFilters(h, { city: '高雄市' }), false);
  assert.equal(matchesFilters(h, { city: '臺北市', dist: '中正區' }), true);
  assert.equal(matchesFilters(h, { city: '臺北市', dist: '大安區' }), false);
});

test('matchesFilters: search text — 台→臺 normalization', () => {
  const h = mkHospital({ name: '臺灣大學醫學院附設醫院' });
  assert.equal(matchesFilters(h, { q: '台大' }), true);
  assert.equal(matchesFilters(h, { q: '臺大' }), true);
});

test('matchesFilters: search text — full-width vs half-width digits/letters are equivalent (NFKC)', () => {
  const h = mkHospital({ name: 'ABC診所', addr: '臺北市中正區忠孝東路１段１號' });
  // full-width query should match half-width text
  assert.equal(matchesFilters(h, { q: 'ＡＢＣ' }), true);
  // half-width query should match full-width text in address
  assert.equal(matchesFilters(h, { q: '1段1號' }), true);
});

test('matchesFilters: combined filters use AND across categories', () => {
  const h = mkHospital({ city: '臺北市', stock: { flu: 5 }, hours: [1, 1, 1, 1, 1, 1, 1] });
  assert.equal(
    matchesFilters(h, { city: '臺北市', inStock: true, vaccineIds: ['flu'], openToday: true }, MON_0830),
    true,
  );
  assert.equal(
    matchesFilters(h, { city: '高雄市', inStock: true, vaccineIds: ['flu'], openToday: true }, MON_0830),
    false,
  );
});

/* ------------------------------------------------------------------ *
 * haversineKm
 * ------------------------------------------------------------------ */

test('haversineKm: Taipei Main Station to Kaohsiung Station ~297km', () => {
  const km = haversineKm(25.0478, 121.5170, 22.6394, 120.3020);
  assert.ok(Math.abs(km - 297) <= 3, `expected ~297km, got ${km}`);
});

test('haversineKm: distance to self is 0', () => {
  assert.equal(haversineKm(25.0478, 121.5170, 25.0478, 121.5170), 0);
});

test('formatDistance: sub-km in meters, else km', () => {
  assert.equal(formatDistance(0.35), '350 公尺');
  assert.equal(formatDistance(5.5), '5.5 公里');
  assert.equal(formatDistance(12.4), '12 公里');
  assert.equal(formatDistance(null), '');
  assert.equal(formatDistance(NaN), '');
});

/* ------------------------------------------------------------------ *
 * normalizeText / tokenizeQuery / searchScore
 * ------------------------------------------------------------------ */

test('normalizeText: 台 -> 臺, full/half width, case, punctuation stripped', () => {
  assert.equal(normalizeText('台北市'), '臺北市');
  assert.equal(normalizeText('ＡＢＣ'), 'abc');
  assert.equal(normalizeText('ABC'), 'abc');
  assert.equal(normalizeText('中山-南路 1 段'), '中山南路1段');
});

test('tokenizeQuery: splits on whitespace/commas, drops empties', () => {
  assert.deepEqual(tokenizeQuery('台大 醫院'), ['臺大', '醫院']);
  assert.deepEqual(tokenizeQuery('  '), []);
  assert.deepEqual(tokenizeQuery(''), []);
});

test('searchScore: empty query scores 1 (matches everything)', () => {
  const h = mkHospital();
  assert.equal(searchScore(h, ''), 1);
});

test('searchScore: every token must hit (AND); alias 台大->臺灣大學', () => {
  const h = mkHospital({ name: '國立臺灣大學醫學院附設醫院', city: '臺北市', dist: '中正區', addr: '臺北市中正區中山南路7號' });
  assert.ok(searchScore(h, '台大') > 0);
  assert.ok(searchScore(h, '台大 中正') > 0);
  assert.equal(searchScore(h, '台大 不存在區'), 0);
});

/* ------------------------------------------------------------------ *
 * sortResults
 * ------------------------------------------------------------------ */

test('sortResults: without score, sorts by distance then status then name', () => {
  const items = [
    { h: { name: 'B' }, distance: 5, status: 'ok' },
    { h: { name: 'A' }, distance: 1, status: 'closed' },
    { h: { name: 'C' }, distance: 1, status: 'ok' },
  ];
  const sorted = sortResults(items);
  assert.deepEqual(sorted.map((i) => i.h.name), ['C', 'A', 'B']);
});

test('sortResults: missing distance sorts last (treated as Infinity)', () => {
  const items = [
    { h: { name: 'HasDist' }, distance: 2, status: 'ok' },
    { h: { name: 'NoDist' }, status: 'ok' },
  ];
  const sorted = sortResults(items);
  assert.deepEqual(sorted.map((i) => i.h.name), ['HasDist', 'NoDist']);
});

test('sortResults: byScore tiers name-hit results above the rest, ties broken by distance', () => {
  const items = [
    { h: { name: 'FarHit' }, distance: 10, status: 'ok', score: 80 },
    { h: { name: 'NoHit' }, distance: 1, status: 'ok', score: 0 },
    { h: { name: 'NearHit' }, distance: 2, status: 'ok', score: 100 },
  ];
  const sorted = sortResults(items, { byScore: true });
  assert.deepEqual(sorted.map((i) => i.h.name), ['NearHit', 'FarHit', 'NoHit']);
});

test('sortResults: does not mutate the input array', () => {
  const items = [
    { h: { name: 'B' }, distance: 5, status: 'ok' },
    { h: { name: 'A' }, distance: 1, status: 'ok' },
  ];
  const copy = items.slice();
  sortResults(items);
  assert.deepEqual(items, copy);
});

/* ------------------------------------------------------------------ *
 * encodeState / decodeState
 * ------------------------------------------------------------------ */

test('encodeState/decodeState: round trip for a fully populated state', () => {
  const state = {
    groups: ['covid', 'flu'],
    products: ['mod_adult'],
    openToday: true,
    inStock: true,
    city: '臺北市',
    dist: '中正區',
    q: '台大',
    id: 2050,
    view: { lat: 25.0478, lng: 121.517, z: 14 },
  };
  const hash = encodeState(state);
  const decoded = decodeState(hash);
  assert.deepEqual([...decoded.groups].sort(), ['covid', 'flu']);
  assert.deepEqual(decoded.products, ['mod_adult']);
  assert.equal(decoded.openToday, true);
  assert.equal(decoded.inStock, true);
  assert.equal(decoded.city, '臺北市');
  assert.equal(decoded.dist, '中正區');
  assert.equal(decoded.q, '台大');
  assert.equal(decoded.id, 2050);
  assert.ok(decoded.view);
  assert.equal(decoded.view.z, 14);
  assert.ok(Math.abs(decoded.view.lat - 25.0478) < 1e-4);
});

test('decodeState: works with or without leading #', () => {
  const hash = encodeState({ ...decodeState(''), city: '高雄市' });
  const a = decodeState(hash);
  const b = decodeState('#' + hash);
  assert.deepEqual(a, b);
});

test('decodeState: defaults for empty/garbage input', () => {
  const d = decodeState('');
  assert.deepEqual(d.groups, []);
  assert.deepEqual(d.products, []);
  assert.equal(d.openToday, false);
  assert.equal(d.inStock, false);
  assert.equal(d.city, '');
  assert.equal(d.id, null);
  assert.equal(d.view, null);
});

test('decodeState: drops dist when city is empty (dist without city is nonsensical)', () => {
  const d = decodeState('dist=中正區');
  assert.equal(d.city, '');
  assert.equal(d.dist, '');
});

test('decodeState: hostile input — very long strings do not throw and get truncated', () => {
  const long = 'a'.repeat(100000);
  assert.doesNotThrow(() => decodeState(`q=${long}&city=${long}`));
  const d = decodeState(`q=${long}&city=${long}`);
  assert.ok(d.q.length <= 60);
  assert.ok(d.city.length <= 20);
});

test('decodeState: hostile input — <script> in q is kept as inert text (no eval/DOM here), just length-capped', () => {
  const d = decodeState('q=' + encodeURIComponent('<script>alert(1)</script>'));
  assert.equal(typeof d.q, 'string');
  assert.ok(d.q.length <= 60);
});

test('decodeState: hostile input — unknown keys are ignored', () => {
  const d = decodeState('foo=bar&__proto__=x&constructor=y&city=臺北市');
  assert.equal(d.city, '臺北市');
  assert.equal(Object.prototype.hasOwnProperty.call(d, 'foo'), false);
});

test('decodeState: hostile input — NaN / out-of-range map coords are rejected', () => {
  assert.equal(decodeState('map=NaN,NaN,NaN').view, null);
  assert.equal(decodeState('map=999,999,999').view, null);
  assert.equal(decodeState('map=25,121,abc').view, null);
  assert.equal(decodeState('map=25,121').view, null); // wrong arity
});

test('decodeState: hostile input — malformed id (non-numeric, huge, negative) is rejected', () => {
  assert.equal(decodeState('id=abc').id, null);
  assert.equal(decodeState('id=-5').id, null); // regex requires only digits
  assert.equal(decodeState('id=99999999999999999999').id, null); // >10 digits
  assert.equal(decodeState('id=2050').id, 2050);
});

test('decodeState: hostile input — group/product lists filtered by ID_RE, dedup applied', () => {
  const d = decodeState('g=covid,covid,<script>,ok_id,' + 'x'.repeat(200));
  assert.deepEqual(d.groups, ['covid', 'ok_id']);
});

test('encodeState: garbage/partial input merged onto DEFAULT_STATE without throwing', () => {
  assert.doesNotThrow(() => encodeState({}));
  assert.doesNotThrow(() => encodeState({ groups: ['covid'] }));
  const s = encodeState({ view: { lat: NaN, lng: 121, z: 10 } });
  // invalid view (NaN lat) should simply be omitted, not throw or emit "NaN"
  assert.ok(!s.includes('map='));
});

test('searchScore: 俗稱夾在較長的詞中也能命中（台大醫院 → 國立臺灣大學醫學院附設醫院）', async () => {
  const { searchScore } = await import('../public/js/logic.js');
  const ntuh = { name: '國立臺灣大學醫學院附設醫院', city: '臺北市', dist: '中正區', addr: '臺北市中正區中山南路7號' };
  const clinic = { name: '大安診所', city: '臺北市', dist: '大安區', addr: '臺北市大安區信義路1號' };
  assert.ok(searchScore(ntuh, '台大醫院') > 0);
  assert.equal(searchScore(clinic, '台大醫院'), 0);
});
