// 應用程式：狀態、篩選、清單、詳細資料、bottom sheet、URL 狀態。
import {
  DEFAULT_STATE, decodeState, encodeState, deriveStatus, formatDistance, formatTaipei,
  haversineKm, matchesFilters, resolveVaccineIds, searchScore, sortResults, timeContext, tokenizeQuery,
} from './logic.js';
import { loadData } from './data-source.js';
import { createMap } from './map.js';
import { el, card, detail, skeletonCards, fmtNum } from './ui.js';

const PAGE = 50;
const $ = (id) => document.getElementById(id);

const dom = {
  banner: $('banner'), bannerClose: $('banner-close'), bannerMore: $('banner-more'),
  snapshotMap: $('snapshot-map'),
  filterToggle: $('filter-toggle'), filterCount: $('filter-count'), filterCountSr: $('filter-count-sr'),
  panel: $('filter-panel'), panelWrap: $('panel-wrap'), productChoices: $('product-choices'),
  panelClear: $('panel-clear'), filterDone: $('filter-done'), tokens: $('tokens'),
  search: $('search-input'), searchClear: $('search-clear'),
  locate: $('locate-btn'), geoMsg: $('geo-msg'),
  groupChips: $('group-chips'),
  today: $('toggle-today'), stock: $('toggle-stock'),
  city: $('city-select'), dist: $('dist-select'),
  stage: $('stage'), sheet: $('sheet'), handle: $('sheet-handle'),
  viewList: $('view-list'), viewDetail: $('view-detail'),
  count: $('results-heading'), clear: $('clear-btn'), scope: $('scope-line'), snapshot: $('snapshot'),
  listScroll: $('list-scroll'), notice: $('list-notice'), results: $('results'), footer: $('list-footer'),
  back: $('back-btn'), detailScroll: $('detail-scroll'), detail: $('detail'),
  announcer: $('announcer'), mapStatus: $('map-status'), legend: $('legend'),
};

const mqMobile = window.matchMedia('(max-width: 899.98px)');
const isMobile = () => mqMobile.matches;

// ---------------- 狀態 ----------------
const state = { ...DEFAULT_STATE, groups: [], products: [] };
let data = null;
let byId = new Map();
let catalog = [];
let groupsMeta = [];
let ctx = timeContext();
let vaccineIds = [];
let matches = []; // [{h, status, openNow, products, score}]
let listLimit = PAGE;
let userLoc = null; // 僅存在記憶體，不寫入網址
let mapApi = null;
let detailPushed = false;
let lastHash = null;
let returnFocusId = null;
let listScrollTop = 0;
let ready = false;
const cardEls = new Map();
// 效能量測：performance.mark / measure（不暴露全域變數）
function mark(name) { try { performance.mark(name); } catch { /* ignore */ } }
function measure(name, start) { try { performance.measure(name, start); } catch { /* ignore */ } }

// ---------------- 工具 ----------------
function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
function safeStorage(op, key, val) {
  try {
    if (op === 'get') return window.localStorage.getItem(key);
    window.localStorage.setItem(key, val);
  } catch { /* 無痕模式等情況忽略 */ }
  return null;
}

// ---------------- 公告 ----------------
const BANNER_KEY = 'vaxmap.banner.v1';
if (safeStorage('get', BANNER_KEY) !== 'dismissed') dom.banner.hidden = false;
dom.bannerClose.addEventListener('click', () => {
  dom.banner.hidden = true;
  safeStorage('set', BANNER_KEY, 'dismissed');
  dom.search.focus();
  afterLayoutChange();
});
dom.bannerMore.addEventListener('click', () => {
  const open = dom.bannerMore.getAttribute('aria-expanded') !== 'true';
  dom.bannerMore.setAttribute('aria-expanded', String(open));
  dom.bannerMore.textContent = open ? '收合' : '詳情';
  dom.banner.classList.toggle('is-expanded', open);
  afterLayoutChange();
});

// ---------------- 初始化 ----------------
function showLoading() {
  initSheet();
  dom.count.textContent = '資料載入中…';
  dom.results.replaceChildren(...skeletonCards(4));
  dom.notice.hidden = true;
  dom.footer.replaceChildren();
}

function showError(err) {
  dom.count.textContent = '無法載入資料';
  dom.results.replaceChildren();
  dom.footer.replaceChildren();
  dom.notice.hidden = false;
  dom.notice.className = 'notice notice--warn';
  dom.notice.replaceChildren(el('div', { class: 'error-box', role: 'alert' },
    el('h3', { text: '院所資料暫時無法載入' }),
    el('p', { text: `請檢查網路連線後再試一次。${err?.message ? `（${err.message}）` : ''}` }),
    el('button', { type: 'button', class: 'btn btn--primary', onclick: start }, '重新載入')));
  setMapStatus('院所資料載入失敗', 0);
  if (isMobile()) setSheet('half', { animate: false });
}

async function start() {
  showLoading();
  try {
    data = await loadData();
  } catch (err) {
    console.error(err);
    showError(err);
    return;
  }
  mark('vax:data-loaded');
  dom.notice.hidden = true;
  init();
}

function init() {
  catalog = data.vaccines;
  groupsMeta = data.groups;
  byId = new Map(data.hospitals.map((h) => [h.id, h]));
  const snap = formatTaipei(data.meta?.generatedAt);
  // 自動更新若連續失敗，資料會停在舊快照；超過 36 小時就明白告訴使用者
  const ageH = (Date.now() - Date.parse(data.meta?.generatedAt)) / 3600000;
  const stale = Number.isFinite(ageH) && ageH > 36 ? `・已 ${Math.floor(ageH / 24) || 1} 天未更新` : '';
  dom.snapshot.textContent = `資料快照：${snap}（臺北時間）${stale}`;
  dom.snapshotMap.textContent = `資料快照 ${snap}${stale}`;
  buildChips();
  buildCityOptions();

  if (!mapApi) {
    mapApi = createMap(document.getElementById('map'), {
      onMarkerClick: (id) => openDetail(id, { fromMap: true }),
      onMarkerHover: (id) => highlightCard(id),
      onMoveEnd: () => { onMapMoved(); },
      onTileStatus: (s, info) => {
        if (s === 'fallback') setMapStatus(`${info?.from || '預設'}底圖無法載入，已改用${info?.to || '備援'}底圖`, 6000);
        if (s === 'failed') setMapStatus('底圖暫時無法載入，院所標示與清單仍可使用', 0);
        if (s === 'ok') setMapStatus('', 0);
      },
    });
  }

  // 由網址還原
  const initial = decodeState(location.hash);
  applyFilterState(initial);
  syncControls();
  // 分享連結帶有次要條件時保持收合（由標籤列顯示條件）；否則沿用本分頁上次的開合狀態
  if (secondaryCount() === 0 && sessionGet(PANEL_KEY) === '1') setPanel(true, { remember: false });
  initSheet();
  if (!isMobile()) dom.legend.open = true;

  recompute().then(() => {
    mark('vax:markers-rendered');
    measure('vax:initial-markers', 'vax:data-loaded');
  });

  if (initial.view) mapApi.setView(initial.view);
  else if (initial.id && byId.has(initial.id)) { /* reveal 會處理 */ }
  else if (state.city) fitToRegion();
  else mapApi.fitTaiwan(sheetInset());

  if (initial.id && byId.has(initial.id)) openDetail(initial.id, { push: false, reveal: !initial.view });

  ready = true;
  renderList();
  lastHash = location.hash.replace(/^#/, '');
  writeHash();

  // 每分鐘檢查日期/時段是否改變
  setInterval(() => {
    const c = timeContext();
    if (c.day !== ctx.day || c.period !== ctx.period) recompute();
  }, 60000);
}

// ---------------- 篩選 UI ----------------
// 主列 4 等分用的短標籤（完整名稱放在 aria-label）
const SHORT_GROUP = { flu: '流感疫苗', covid: 'COVID-19', pcv: '肺鏈疫苗', antiviral: '流感藥劑' };

function buildChips() {
  dom.groupChips.replaceChildren(...groupsMeta.map((g) => el('button', {
    type: 'button', class: 'chip chip--group', 'aria-pressed': 'false', dataset: { group: g.id },
    'aria-label': g.name, onclick: () => toggleGroup(g.id),
  },
  el('span', { class: 'chip__check', 'aria-hidden': 'true' }),
  el('span', { class: 'chip__label', 'aria-hidden': 'true', text: SHORT_GROUP[g.id] || g.name }))));
  buildProductChoices();
}

/** 面板內：有多個細項的品項群組（COVID-19、肺鏈），依群組分列 */
function buildProductChoices() {
  const sections = [];
  for (const g of groupsMeta) {
    const items = catalog.filter((v) => v.group === g.id);
    if (items.length < 2) continue;
    const labelId = `prod-label-${g.id}`;
    sections.push(el('div', { class: 'panel__sub' },
      el('h4', { class: 'panel__label', id: labelId }, `${g.name}細項`,
        el('span', { class: 'panel__hint', text: '（未選＝全部）' })),
      el('div', { class: 'panel__row', role: 'group', 'aria-labelledby': labelId },
        items.map((v) => el('button', {
          type: 'button', class: 'opt', 'aria-pressed': 'false', dataset: { product: v.id },
          onclick: () => toggleProduct(v.id),
        }, el('span', { class: 'opt__box', 'aria-hidden': 'true' }), v.short)))));
  }
  dom.productChoices.replaceChildren(...sections);
  dom.productChoices.hidden = sections.length === 0;
}

function toggleGroup(gid) {
  if (state.groups.includes(gid)) {
    state.groups = state.groups.filter((g) => g !== gid);
    state.products = state.products.filter((p) => catalog.find((v) => v.id === p)?.group !== gid);
  } else {
    state.groups = [...state.groups, gid];
  }
  onFiltersChanged();
}

function toggleProduct(pid) {
  if (state.products.includes(pid)) {
    state.products = state.products.filter((p) => p !== pid);
  } else {
    state.products = [...state.products, pid];
    // 選了細項就代表要看這個群組
    const g = catalog.find((v) => v.id === pid)?.group;
    if (g && !state.groups.includes(g)) state.groups = [...state.groups, g];
  }
  onFiltersChanged();
}

dom.today.addEventListener('click', () => { state.openToday = !state.openToday; onFiltersChanged(); });
dom.stock.addEventListener('click', () => { state.inStock = !state.inStock; onFiltersChanged(); });

// ---------------- 篩選面板（收合／展開；屬於個人 UI 狀態，不寫入網址） ----------------
const PANEL_KEY = 'vaxmap.filtersOpen';
function sessionGet(k) { try { return window.sessionStorage.getItem(k); } catch { return null; } }
function sessionSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch { /* ignore */ } }

function isPanelOpen() { return dom.filterToggle.getAttribute('aria-expanded') === 'true'; }

function setPanel(open, { focus = false, remember = true } = {}) {
  if (open === isPanelOpen()) return;
  dom.filterToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    clearTimeout(setPanel.t);
    dom.panel.hidden = false;
    void dom.panelWrap.offsetHeight; // 先排版，讓 0fr → 1fr 有動畫
    dom.panelWrap.classList.add('is-open');
  } else {
    dom.panelWrap.classList.remove('is-open');
    // 動畫結束後才真的隱藏（減少動態時立即隱藏）
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    clearTimeout(setPanel.t);
    setPanel.t = setTimeout(() => { if (!isPanelOpen()) dom.panel.hidden = true; afterLayoutChange(); }, reduce ? 0 : 220);
  }
  if (remember) sessionSet(PANEL_KEY, open ? '1' : '0');
  if (focus) (open ? dom.panel.querySelector('button, select') : dom.filterToggle)?.focus();
  afterLayoutChange();
}

dom.filterToggle.addEventListener('click', () => setPanel(!isPanelOpen()));
// 行動版面板浮在地圖上：點地圖或清單時收合（不搶焦點）
document.addEventListener('pointerdown', (e) => {
  if (isPanelOpen() && isMobile() && !e.target.closest('#filters')) setPanel(false);
});
dom.filterDone.addEventListener('click', () => setPanel(false, { focus: true }));
dom.panelClear.addEventListener('click', () => { clearAll({ keepFocus: true }); });
dom.panel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault(); // 不讓全域 Esc 關閉詳細資料
    setPanel(false, { focus: true });
  }
});

/** 次要條件數（細項、今日有看診、只看有庫存、地區） */
function secondaryCount() {
  return state.products.length + (state.openToday ? 1 : 0) + (state.inStock ? 1 : 0) + (state.city ? 1 : 0);
}

/** 已套用條件的可移除標籤列 */
function renderTokens() {
  const tokens = [];
  const add = (label, remove, key) => tokens.push({ label, remove, key });
  for (const v of catalog) {
    if (state.products.includes(v.id)) add(v.short, () => { state.products = state.products.filter((p) => p !== v.id); }, `p:${v.id}`);
  }
  if (state.openToday) add('今日有看診', () => { state.openToday = false; }, 'today');
  if (state.inStock) add('只看有庫存', () => { state.inStock = false; }, 'stock');
  if (state.city) add(`${state.city}${state.dist ? ` ${state.dist}` : ''}`, () => { state.city = ''; state.dist = ''; }, 'region');

  dom.tokens.replaceChildren(...tokens.map((t, i) => el('li', {},
    el('button', {
      type: 'button', class: 'token', 'aria-label': `移除條件：${t.label}`, dataset: { key: t.key },
      onclick: () => {
        t.remove();
        onFiltersChanged();
        // 焦點移到下一個標籤；沒有了就回到「篩選」按鈕
        const btns = dom.tokens.querySelectorAll('.token');
        (btns[Math.min(i, btns.length - 1)] || dom.filterToggle).focus();
      },
    }, el('span', { class: 'token__text', text: t.label }),
    el('span', { class: 'token__x', 'aria-hidden': 'true', text: '×' })))));
}

const CITY_ORDER = ['臺北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '臺中市', '彰化縣', '南投縣',
  '雲林縣', '嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'];
let distsByCity = new Map();

function buildCityOptions() {
  distsByCity = new Map();
  for (const h of data.hospitals) {
    if (!h.city) continue;
    if (!distsByCity.has(h.city)) distsByCity.set(h.city, new Set());
    if (h.dist) distsByCity.get(h.city).add(h.dist);
  }
  const cities = [...distsByCity.keys()].sort((a, b) => {
    const ia = CITY_ORDER.indexOf(a), ib = CITY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'zh-Hant-TW');
  });
  dom.city.replaceChildren(el('option', { value: '', text: '全部縣市' }),
    ...cities.map((c) => el('option', { value: c, text: c })));
}

function buildDistOptions() {
  const dists = state.city ? [...(distsByCity.get(state.city) || [])].sort((a, b) => a.localeCompare(b, 'zh-Hant-TW')) : [];
  dom.dist.replaceChildren(el('option', { value: '', text: '全部行政區' }),
    ...dists.map((d) => el('option', { value: d, text: d })));
  dom.dist.disabled = !state.city;
}

dom.city.addEventListener('change', () => {
  state.city = dom.city.value;
  state.dist = '';
  buildDistOptions();
  onFiltersChanged({ fit: true });
});
dom.dist.addEventListener('change', () => {
  state.dist = dom.dist.value;
  onFiltersChanged({ fit: true });
});

const onSearchInput = debounce(() => {
  const q = dom.search.value.trim();
  if (q === state.q) return;
  state.q = q;
  onFiltersChanged({ fromSearch: true });
}, 220);
dom.search.addEventListener('input', () => {
  dom.searchClear.hidden = !dom.search.value;
  onSearchInput();
});
dom.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    onSearchInput.cancel();
    state.q = dom.search.value.trim();
    onFiltersChanged({ fromSearch: true, submit: true });
  } else if (e.key === 'Escape' && dom.search.value) {
    dom.search.value = '';
    dom.searchClear.hidden = true;
    onSearchInput.cancel();
    state.q = '';
    onFiltersChanged();
  }
});
dom.searchClear.addEventListener('click', () => {
  dom.search.value = '';
  dom.searchClear.hidden = true;
  state.q = '';
  onFiltersChanged();
  dom.search.focus();
});

dom.clear.addEventListener('click', clearAll);
function clearAll({ keepFocus = false } = {}) {
  Object.assign(state, { groups: [], products: [], openToday: false, inStock: false, city: '', dist: '', q: '' });
  dom.search.value = '';
  dom.searchClear.hidden = true;
  syncControls();
  onFiltersChanged();
  if (!keepFocus) dom.count.focus();
}

function hasFilters() {
  return state.groups.length || state.openToday || state.inStock || state.city || state.q;
}

function applyFilterState(s) {
  const validGroups = new Set(groupsMeta.map((g) => g.id));
  const validProducts = new Set(catalog.map((v) => v.id));
  state.groups = s.groups.filter((g) => validGroups.has(g));
  state.products = s.products.filter((p) => validProducts.has(p) && state.groups.includes(catalog.find((v) => v.id === p).group));
  state.openToday = s.openToday;
  state.inStock = s.inStock;
  state.city = distsByCity.has(s.city) ? s.city : '';
  state.dist = state.city && distsByCity.get(state.city).has(s.dist) ? s.dist : '';
  state.q = s.q;
}

function syncControls() {
  for (const b of dom.groupChips.querySelectorAll('[data-group]')) {
    b.setAttribute('aria-pressed', String(state.groups.includes(b.dataset.group)));
  }
  dom.today.setAttribute('aria-pressed', String(state.openToday));
  dom.stock.setAttribute('aria-pressed', String(state.inStock));
  if (dom.search.value.trim() !== state.q) dom.search.value = state.q;
  dom.searchClear.hidden = !dom.search.value;
  dom.city.value = state.city;
  buildDistOptions();
  dom.dist.value = state.dist;
  for (const b of dom.productChoices.querySelectorAll('[data-product]')) {
    b.setAttribute('aria-pressed', String(state.products.includes(b.dataset.product)));
  }
  dom.clear.hidden = !hasFilters();
  const n = secondaryCount();
  dom.filterCount.textContent = String(n);
  dom.filterCount.hidden = n === 0;
  dom.filterCountSr.textContent = n ? `（已套用 ${n} 項）` : '';
  dom.filterToggle.classList.toggle('has-active', n > 0);
  renderTokens();
}

function onFiltersChanged(opts = {}) {
  syncControls();
  listLimit = PAGE;
  mark('vax:filter-start');
  const p = recompute();
  if (opts.fit) fitToRegion();
  if (opts.fromSearch && state.q && matches.length) {
    // 搜尋：按 Enter、結果不多、或目前畫面內沒有結果時，地圖移到搜尋結果
    const b = mapApi.visibleBounds(sheetInset());
    const noneVisible = !matches.some((m) => b.contains([m.h.lat, m.h.lng]));
    if (opts.submit || matches.length <= 100 || noneVisible) {
      const pts = sortResults(matches, { byScore: true }).slice(0, 100).map((m) => m.h);
      mapApi.fitTo(pts, { bottomInset: sheetInset(), maxZoom: 16 });
    }
  }
  renderList();
  measure('vax:filter-sync', 'vax:filter-start');
  p.then(() => measure('vax:filter-markers', 'vax:filter-start'));
  writeHash();
  announce();
  afterLayoutChange();
}

function fitToRegion() {
  if (!state.city) return;
  let pts = matches.map((m) => m.h);
  if (!pts.length) pts = data.hospitals.filter((h) => h.city === state.city && (!state.dist || h.dist === state.dist));
  mapApi.fitTo(pts, { bottomInset: sheetInset(), maxZoom: 16 });
}

// ---------------- 計算 ----------------
function recompute() {
  ctx = timeContext();
  vaccineIds = resolveVaccineIds(state, catalog);
  const tokens = tokenizeQuery(state.q);
  const filters = {
    vaccineIds, openToday: state.openToday, inStock: state.inStock, city: state.city, dist: state.dist,
  };
  const out = [];
  for (const h of data.hospitals) {
    if (!matchesFilters(h, filters, ctx)) continue;
    let score = 0;
    if (tokens.length) {
      score = searchScore(h, tokens);
      if (score <= 0) continue;
    }
    const d = deriveStatus(h, vaccineIds, ctx);
    out.push({ h, status: d.status, openNow: d.openNow, products: d.products, score });
  }
  matches = out;
  return mapApi.update(out);
}

// ---------------- 清單 ----------------
function listAllMode() {
  return !!(state.q || state.city);
}

function origin() {
  if (userLoc) return userLoc;
  const c = mapApi.visibleCenter(sheetInset());
  return { lat: c.lat, lng: c.lng };
}

function renderList() {
  if (!ready) return;
  const all = listAllMode();
  const o = origin();
  let cands = matches;
  if (!all) {
    const b = mapApi.visibleBounds(sheetInset());
    cands = matches.filter((m) => b.contains([m.h.lat, m.h.lng]));
  }
  const items = cands.map((m) => ({ ...m, distance: haversineKm(o.lat, o.lng, m.h.lat, m.h.lng) }));
  const sorted = sortResults(items, { byScore: !!state.q });

  // 摘要
  dom.count.replaceChildren('符合 ', el('span', { class: 'num', text: fmtNum(matches.length) }), ' 家');
  const scopeBits = [];
  if (all) {
    scopeBits.push(el('span', {}, state.q ? '列出所有搜尋結果（不限地圖範圍）' : `列出${state.city}${state.dist}全部結果`));
  } else {
    scopeBits.push(el('span', {}, el('span', { class: 'scope-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'lbl-long', text: '地圖範圍內' }), el('span', { class: 'lbl-short', text: '地圖內' }),
      ` ${fmtNum(cands.length)} 家`));
  }
  scopeBits.push(el('span', { text: userLoc ? '・依與您的距離排序' : '・依地圖中心排序' }));
  if (!userLoc) {
    scopeBits.push(el('button', {
      type: 'button', class: 'btn btn--text btn--cta', onclick: locate,
    }, '定位後可依距離排序'));
  }
  dom.scope.replaceChildren(...scopeBits);

  // 提示
  renderNotice();

  // 清單
  const shown = sorted.slice(0, listLimit);
  cardEls.clear();
  const nodes = shown.map((it) => {
    const li = card(it, { catalog, ctx, onOpen: (id) => openDetail(id), showDistance: !!userLoc });
    li.addEventListener('mouseenter', () => mapApi.highlight(it.h.id));
    li.addEventListener('mouseleave', () => mapApi.highlight(null));
    li.addEventListener('focusin', () => mapApi.highlight(it.h.id));
    li.addEventListener('focusout', () => mapApi.highlight(null));
    cardEls.set(it.h.id, li);
    return li;
  });
  dom.results.replaceChildren(...nodes);

  // 空狀態 / 顯示更多
  const footer = [];
  if (matches.length === 0) {
    footer.push(emptyState());
  } else if (sorted.length === 0) {
    footer.push(el('div', { class: 'empty' },
      el('h3', { text: '目前地圖範圍內沒有符合的院所' }),
      el('p', { text: '請移動或縮小地圖，或直接前往符合條件的院所。' }),
      el('div', { class: 'empty__actions' },
        el('button', {
          type: 'button', class: 'btn btn--primary',
          onclick: () => mapApi.fitTo(matches.map((m) => m.h), { bottomInset: sheetInset(), maxZoom: 14 }),
        }, `顯示全部 ${fmtNum(matches.length)} 家符合院所`))));
  } else if (sorted.length > shown.length) {
    footer.push(el('p', { text: `已顯示 ${fmtNum(shown.length)} / ${fmtNum(sorted.length)} 家` }));
    footer.push(el('button', {
      type: 'button', class: 'btn',
      onclick: () => {
        const focusIdx = shown.length;
        listLimit += PAGE;
        renderList();
        // 將焦點移到新載入的第一筆
        dom.results.children[focusIdx]?.querySelector('.card__btn')?.focus();
      },
    }, `顯示更多（再 ${Math.min(PAGE, sorted.length - shown.length)} 家）`));
  } else if (sorted.length > 3) {
    footer.push(el('p', { text: `共 ${fmtNum(sorted.length)} 家` }));
  }
  dom.footer.replaceChildren(...footer);
  fitPeek();
}

/** 收合狀態的高度依內容（摘要 + 第一張卡片）調整；只改高度，不重繪清單 */
function fitPeek() {
  if (!isMobile() || sheet.state !== 'peek' || sheet.dragging) return;
  const h = sheetHeightFor('peek');
  if (Math.abs(dom.sheet.offsetHeight - h) < 2) return;
  dom.sheet.style.height = `${h}px`;
  dom.stage.style.setProperty('--sheet-h', `${h}px`);
}

function renderNotice() {
  const notes = [];
  if (state.groups.includes('flu')) {
    const n = data.hospitals.filter((h) => h.stock && 'flu' in h.stock).length;
    if (n < 50) {
      notes.push(el('div', {},
        el('strong', { text: '公費流感疫苗 10月1日起開打' }),
        `目前僅 ${fmtNum(n)} 家院所登錄流感疫苗，開打後將陸續增加。`));
    }
  }
  if (!notes.length) { dom.notice.hidden = true; dom.notice.replaceChildren(); return; }
  dom.notice.className = 'notice';
  dom.notice.hidden = false;
  dom.notice.replaceChildren(...notes);
}

function emptyState() {
  const actions = [];
  const btn = (label, fn) => el('button', { type: 'button', class: 'btn', onclick: fn }, label);
  if (state.inStock) actions.push(btn('取消「只看有庫存」', () => { state.inStock = false; onFiltersChanged(); }));
  if (state.openToday) actions.push(btn('取消「今日有看診」', () => { state.openToday = false; onFiltersChanged(); }));
  if (state.q) actions.push(btn('清除搜尋文字', () => { dom.search.value = ''; state.q = ''; onFiltersChanged(); }));
  if (state.dist) actions.push(btn(`改看整個${state.city}`, () => { state.dist = ''; onFiltersChanged({ fit: true }); }));
  else if (state.city) actions.push(btn('不限縣市', () => { state.city = ''; onFiltersChanged(); }));
  if (state.groups.length) actions.push(btn('不限品項', () => { state.groups = []; state.products = []; onFiltersChanged(); }));
  if (actions.length > 1) actions.push(el('button', { type: 'button', class: 'btn btn--primary', onclick: clearAll }, '清除所有條件'));
  return el('div', { class: 'empty' },
    el('h3', { text: '沒有符合條件的院所' }),
    el('p', { text: '可以試著放寬條件：' }),
    el('div', { class: 'empty__actions' }, actions));
}

function highlightCard(id) {
  for (const li of dom.results.querySelectorAll('.card.is-hl')) li.classList.remove('is-hl');
  if (id != null) cardEls.get(id)?.classList.add('is-hl');
}

const announce = debounce(() => {
  if (!ready) return;
  let msg = `符合 ${matches.length} 家院所`;
  if (!listAllMode()) {
    const b = mapApi.visibleBounds(sheetInset());
    msg += `，地圖範圍內 ${matches.filter((m) => b.contains([m.h.lat, m.h.lng])).length} 家`;
  }
  dom.announcer.textContent = msg;
}, 700);

// ---------------- 地圖移動 ----------------
const onMapMoved = debounce(() => {
  if (!ready) return;
  if (!listAllMode() || !userLoc) {
    if (!listAllMode()) listLimit = PAGE;
    if (dom.viewDetail.hidden) renderList();
  }
  writeHash();
}, 120);

function setMapStatus(text, ms) {
  clearTimeout(setMapStatus.t);
  dom.mapStatus.textContent = text;
  dom.mapStatus.hidden = !text;
  if (text && ms) setMapStatus.t = setTimeout(() => { dom.mapStatus.hidden = true; }, ms);
}

// ---------------- 詳細資料 ----------------
function openDetail(id, { push = true, fromMap = false, reveal = true } = {}) {
  const h = byId.get(id);
  if (!h) return;
  const wasOpen = !dom.viewDetail.hidden;
  if (!wasOpen) {
    listScrollTop = dom.listScroll.scrollTop;
    returnFocusId = fromMap ? null : id;
  }
  state.id = id;
  const m = matches.find((x) => x.h.id === id);
  const st = deriveStatus(h, vaccineIds, ctx);
  const item = m || { h, status: st.status, openNow: st.openNow, products: st.products };
  const distLabel = userLoc ? `距您 ${formatDistance(haversineKm(userLoc.lat, userLoc.lng, h.lat, h.lng))}` : '';
  dom.detail.replaceChildren(...detail(item, { catalog, ctx, selectedIds: vaccineIds, distanceLabel: distLabel }));
  dom.viewList.hidden = true;
  dom.viewDetail.hidden = false;

  dom.detailScroll.scrollTop = 0;
  mapApi.select(id);
  highlightCard(null);

  if (isMobile() && (sheet.state === 'peek' || sheet.state === 'full')) setSheet('half');
  if (reveal) {
    // 等 sheet 高度就位再移動地圖
    requestAnimationFrame(() => mapApi.reveal(h, sheetInset()));
  }
  if (push && !wasOpen) {
    writeHash({ push: true });
    detailPushed = true;
  } else {
    writeHash();
  }
  dom.detail.querySelector('#detail-name')?.focus({ preventScroll: true });
  dom.announcer.textContent = '';
}

function closeDetail({ fromHistory = false } = {}) {
  if (dom.viewDetail.hidden) return;
  if (!fromHistory && detailPushed) {
    // 讓瀏覽器「上一頁」與此按鈕行為一致
    history.back();
    return;
  }
  detailPushed = false;
  state.id = null;
  mapApi.select(null);
  dom.viewDetail.hidden = true;
  dom.viewList.hidden = false;

  renderList();
  dom.listScroll.scrollTop = listScrollTop;
  const btn = returnFocusId != null ? document.getElementById(`card-${returnFocusId}`) : null;
  if (btn) btn.focus({ preventScroll: true });
  else dom.count.focus({ preventScroll: true });
  if (!fromHistory) writeHash();
  afterLayoutChange();
}

dom.back.addEventListener('click', () => closeDetail());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !dom.viewDetail.hidden && !e.defaultPrevented) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
    closeDetail();
  }
});

// ---------------- 網址狀態 ----------------
const writeHashDebounced = debounce(() => writeHashNow(false), 300);
function writeHash({ push = false } = {}) {
  if (!ready) return;
  if (push) { writeHashDebounced.cancel(); writeHashNow(true); } else writeHashDebounced();
}
function writeHashNow(push) {
  // 定位後不再把地圖視野寫入網址：視野中心會接近使用者位置，分享連結可能洩漏住處
  const s = encodeState({ ...state, view: userLoc ? null : mapApi.getView() });
  if (s === lastHash) return;
  lastHash = s;
  const url = `${location.pathname}${location.search}${s ? `#${s}` : ''}`;
  try {
    if (push) history.pushState({ vx: 1 }, '', url);
    else history.replaceState(history.state, '', url);
  } catch { /* 部分環境（file://）不允許 */ }
}

function onHistoryNav() {
  const raw = location.hash.replace(/^#/, '');
  if (raw === lastHash) return;
  lastHash = raw;
  const s = decodeState(raw);
  const before = encodeState({ ...state, id: null });
  applyFilterState(s);
  if (encodeState({ ...state, id: null }) !== before) {
    syncControls();
    listLimit = PAGE;
    recompute();
    renderList();
  }
  if (s.view) {
    const v = mapApi.getView();
    if (Math.abs(v.lat - s.view.lat) > 1e-4 || Math.abs(v.lng - s.view.lng) > 1e-4 || v.z !== s.view.z) {
      mapApi.setView(s.view);
    }
  }
  if (s.id != null && byId.has(s.id)) {
    if (state.id !== s.id || dom.viewDetail.hidden) openDetail(s.id, { push: false, reveal: !s.view });
  } else if (!dom.viewDetail.hidden) {
    closeDetail({ fromHistory: true });
  }
}
window.addEventListener('popstate', onHistoryNav);
window.addEventListener('hashchange', onHistoryNav);

// ---------------- 定位 ----------------
function geoMessage(text, info = false) {
  dom.geoMsg.textContent = text;
  dom.geoMsg.hidden = !text;
  dom.geoMsg.classList.toggle('is-info', info);
  afterLayoutChange();
}

dom.locate.addEventListener('click', locate);
function locate() {
  if (!('geolocation' in navigator)) {
    geoMessage('此瀏覽器不支援定位功能。請改用搜尋或「篩選」中的地區。');
    return;
  }
  if (!window.isSecureContext) {
    geoMessage('定位功能需透過安全連線（HTTPS）使用。請改用搜尋或「篩選」中的地區。');
    return;
  }
  dom.locate.setAttribute('aria-busy', 'true');
  geoMessage('正在取得您的位置…', true);
  navigator.geolocation.getCurrentPosition((pos) => {
    dom.locate.removeAttribute('aria-busy');
    dom.locate.classList.add('is-active');
    userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (isMobile() && sheet.state === 'full') setSheet('half');
    mapApi.setUserLocation(userLoc.lat, userLoc.lng, pos.coords.accuracy, sheetInset());
    geoMessage('已定位，清單改依與您的距離排序。', true);
    setTimeout(() => { if (dom.geoMsg.classList.contains('is-info')) geoMessage(''); }, 5000);
    renderList();
  }, (err) => {
    dom.locate.removeAttribute('aria-busy');
    const msg = {
      1: '您未允許網站取得位置。可在瀏覽器設定中開啟定位權限，或改用搜尋、「篩選」中的地區。',
      2: '目前無法取得您的位置（可能是訊號不佳）。請稍後再試，或改用搜尋、「篩選」中的地區。',
      3: '取得位置逾時，請再試一次，或改用搜尋、「篩選」中的地區。',
    }[err.code] || '無法取得您的位置，請改用搜尋或「篩選」中的地區。';
    geoMessage(msg);
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 });
}

// ---------------- Bottom sheet（行動版） ----------------
const sheet = { state: 'peek', dragging: false };
const SHEET_STATES = ['peek', 'half', 'full'];
const SHEET_LABEL = { peek: '收合', half: '半開', full: '全開' };

function stageHeight() { return dom.stage.clientHeight; }

function sheetHeightFor(s) {
  const H = stageHeight();
  if (s === 'full') return H;
  if (s === 'half') return Math.round(H * 0.55);
  // peek：把手 + 摘要（或返回列）+ 一張卡片
  // 把手按鈕 44px 高，但下緣 20px 與摘要列重疊（見 CSS），實際佔用 24px
  const handle = (dom.handle.offsetHeight || 44) - 20;
  let head, body;
  if (!dom.viewDetail.hidden) {
    head = dom.viewDetail.querySelector('.detail-bar').offsetHeight;
    body = 120;
  } else {
    head = dom.viewList.querySelector('.summary').offsetHeight;
    const first = dom.results.firstElementChild || dom.footer.firstElementChild;
    // 只露出第一張卡片的上半部（名稱、距離／地區、今日時段），讓地圖保有約一半畫面
    body = Math.min(first ? first.offsetHeight + 22 : 110, 108);
  }
  return Math.min(Math.round(handle + head + body), Math.round(H * 0.6));
}

function sheetInset() {
  if (!isMobile()) return 0;
  return dom.sheet.offsetHeight || 0;
}

function setSheet(s, { animate = true } = {}) {
  if (!isMobile()) return;
  sheet.state = s;
  dom.sheet.dataset.state = s;
  const h = sheetHeightFor(s);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  dom.sheet.classList.toggle('is-animating', animate && !reduce);
  dom.sheet.style.height = `${h}px`;
  dom.stage.style.setProperty('--sheet-h', `${h}px`);
  dom.handle.setAttribute('aria-label', `調整清單高度（目前：${SHEET_LABEL[s]}；按下切換，或用上下方向鍵）`);
  dom.handle.setAttribute('aria-expanded', String(s !== 'peek'));
  const changed = sheet.lastH !== h;
  sheet.lastH = h;
  clearTimeout(setSheet.t);
  setSheet.t = setTimeout(() => {
    dom.sheet.classList.remove('is-animating');
    if (changed && dom.viewDetail.hidden && ready) { renderList(); announce(); }
  }, animate && !reduce ? 300 : 0);
}

function initSheet() {
  if (isMobile()) setSheet(sheet.state, { animate: false });
}

mqMobile.addEventListener('change', () => {
  if (isMobile()) setSheet(sheet.state, { animate: false });
  else {
    dom.sheet.style.height = '';
    dom.stage.style.removeProperty('--sheet-h');
  }
  mapApi?.invalidate();
  renderList();
});

function afterLayoutChange() {
  requestAnimationFrame(() => {
    mapApi?.invalidate();
    if (isMobile() && !sheet.dragging) setSheet(sheet.state, { animate: false });
  });
}
window.addEventListener('resize', debounce(afterLayoutChange, 150));

dom.handle.addEventListener('click', () => {
  if (sheet.suppressClick) { sheet.suppressClick = false; return; }
  const i = SHEET_STATES.indexOf(sheet.state);
  setSheet(SHEET_STATES[(i + 1) % SHEET_STATES.length]);
});
dom.handle.addEventListener('keydown', (e) => {
  const i = SHEET_STATES.indexOf(sheet.state);
  if (e.key === 'ArrowUp') { e.preventDefault(); setSheet(SHEET_STATES[Math.min(2, i + 1)]); }
  if (e.key === 'ArrowDown') { e.preventDefault(); setSheet(SHEET_STATES[Math.max(0, i - 1)]); }
});

// 拖曳：把手、摘要列、詳細資料的返回列
function bindDrag(target) {
  let startY = 0, startH = 0, lastY = 0, lastT = 0, vel = 0, moved = false, pid = null;
  target.addEventListener('pointerdown', (e) => {
    if (!isMobile() || e.button > 0) return;
    if (target !== dom.handle && e.target.closest('button, a, select, input')) return;
    pid = e.pointerId;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    startH = dom.sheet.offsetHeight;
    moved = false;
    vel = 0;
  });
  target.addEventListener('pointermove', (e) => {
    if (pid !== e.pointerId) return;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dy) < 6) return;
    if (!moved) {
      moved = true;
      sheet.dragging = true;
      target.setPointerCapture?.(pid);
      dom.sheet.classList.remove('is-animating');
    }
    const H = stageHeight();
    const h = Math.max(sheetHeightFor('peek') * 0.7, Math.min(H, startH - dy));
    dom.sheet.style.height = `${h}px`;
    const dt = e.timeStamp - lastT;
    if (dt > 0) vel = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = e.timeStamp;
  });
  const end = (e) => {
    if (pid !== e.pointerId) return;
    pid = null;
    if (!moved) return;
    sheet.dragging = false;
    if (target === dom.handle) sheet.suppressClick = true;
    const projected = dom.sheet.offsetHeight - vel * 180;
    let best = 'peek', bestD = Infinity;
    for (const s of SHEET_STATES) {
      const d = Math.abs(sheetHeightFor(s) - projected);
      if (d < bestD) { bestD = d; best = s; }
    }
    setSheet(best);
  };
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}
bindDrag(dom.handle);
bindDrag(dom.viewList.querySelector('.summary'));
bindDrag(dom.viewDetail.querySelector('.detail-bar'));

// ---------------- 開始 ----------------
start();
