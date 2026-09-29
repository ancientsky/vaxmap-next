// Leaflet 地圖封裝：底圖（依介面語系選擇、含自動備援）、院所標記、群集、定位點。
/* global L */
import { t, tn, closedGlyph, getLang } from './i18n.js';

const TW_BOUNDS = [[21.8, 119.9], [25.4, 122.1]];

// ---------- 底圖 ----------
// 評估與決策見 docs/BASEMAP.md。重點：OSM 圖磚的地名是當地語言（中文）；國土測繪中心 EMAP8
// 是官方英文版電子地圖（全臺、z7–19 皆為英文），免申請、免金鑰，與 EMAP 同一主機（CSP 不需變動）。
// 版權字串是固定 HTML，必須與 trusted-types.js 的 ALLOW 清單逐字相同。
const OSM_LINK = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';
export const ATTRIBUTION = {
  osmZh: `© ${OSM_LINK} 貢獻者`,
  osmEn: `© ${OSM_LINK} contributors`,
  nlsc: '© 內政部國土測繪中心',
  nlscEn: '© NLSC, Ministry of the Interior (Taiwan)',
};
const NLSC = (layer) => `https://wmts.nlsc.gov.tw/wmts/${layer}/default/GoogleMapsCompatible/{z}/{y}/{x}`;
// labels：該圖磚地名使用的文字（用來判斷備援後是否要提醒「地名可能是中文」）
// service：同一個服務（主機）的圖層視為一起失效——某圖層載入失敗後，備援會跳過同服務的其他圖層
const PROVIDERS = {
  osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', labels: 'zh', service: 'osm', options: { maxZoom: 19 } },
  nlsc: { name: '國土測繪中心通用版電子地圖', url: NLSC('EMAP'), labels: 'zh', service: 'nlsc', options: { maxZoom: 19, maxNativeZoom: 19 } },
  nlscEn: { name: 'NLSC e-map (English)', url: NLSC('EMAP8'), labels: 'en', service: 'nlsc', options: { maxZoom: 19, maxNativeZoom: 19 } },
};
// 每種「地名文字」可選的底圖與備援順序。[供應者 id, 版權字串]
// - 第一個是預設；使用者在圖例的「底圖」選了別的，就從那個開始，其餘依此順序備援（跳過已失效的服務）。
// - 使用者可選的項目＝鏈中所有底圖（外文介面也可選中文版 NLSC，讓地名與路牌一致）。
// - zh：NLSC 通用版電子地圖對臺灣使用者載入較快，OSM 為備援。
// ja/ko：目前沒有免金鑰的供應者提供日文／韓文街道名稱（OpenFreeMap 向量圖磚實測 0/800 條道路有
// name:ja／name:ko），因此 ko 與其他外文介面一樣使用英文地名。
export const BASEMAP_CHAINS = {
  zh: [['nlsc', ATTRIBUTION.nlsc], ['osm', ATTRIBUTION.osmZh]],
  latin: [['nlscEn', ATTRIBUTION.nlscEn], ['osm', ATTRIBUTION.osmEn], ['nlsc', ATTRIBUTION.nlscEn]],
};
// 日文使用者看得懂漢字路名，且與路牌一致，沿用中文底圖；其他外語用國土測繪中心英文版
export const basemapKind = (lang) => (lang === 'zh-Hant' || lang === 'ja' ? 'zh' : 'latin');

// 使用者選擇的底圖，依地名文字（zh／latin）分開記住：{"zh":"osm","latin":"nlsc"}
export const BASEMAP_PREF_KEY = 'vaxmap.basemap';
function readBasemapPref() {
  try {
    const o = JSON.parse(window.localStorage.getItem(BASEMAP_PREF_KEY) || 'null');
    const out = {};
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const kind of Object.keys(BASEMAP_CHAINS)) {
        if (typeof o[kind] === 'string' && BASEMAP_CHAINS[kind].some(([id]) => id === o[kind])) out[kind] = o[kind];
      }
    }
    return out;
  } catch { return {}; } // 無痕模式、停用儲存空間、內容損毀時視為沒有偏好
}
function writeBasemapPref(kind, id) {
  try {
    const o = readBasemapPref();
    o[kind] = id;
    window.localStorage.setItem(BASEMAP_PREF_KEY, JSON.stringify(o));
  } catch { /* ignore */ }
}

// 休診符號依語系（'休' 或 '×'，兩者都在 trusted-types.js 的允許清單內）
const glyphFor = (status) => (status === 'closed' ? closedGlyph() : status === 'ok' ? '✓' : '–');
// 視覺尺寸 30/26px，但圖示元素（觸控範圍）一律 44px
const HIT = 44;

function makeIcon(status, active) {
  const s = HIT;
  return L.divIcon({
    className: `mk mk--${status}${active ? ' mk--active' : ''}`,
    html: `<span class="mk__b"><span class="mk__g" aria-hidden="true">${glyphFor(status)}</span></span>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
  });
}

// 依休診符號快取圖示（切換語系時才可能換符號）
const ICON_CACHE = {};
function icons() {
  const g = closedGlyph();
  if (!ICON_CACHE[g]) {
    const set = {};
    for (const st of ['ok', 'nostock', 'closed']) {
      set[st] = makeIcon(st, false);
      set[`${st}:active`] = makeIcon(st, true);
    }
    ICON_CACHE[g] = set;
  }
  return ICON_CACHE[g];
}

const statusText = (s) => t(`status.${s}.text`);

function clusterIcon(cluster) {
  const children = cluster.getAllChildMarkers();
  const n = children.length;
  let ok = 0, no = 0;
  for (const m of children) {
    if (m._vxStatus === 'ok') ok++;
    else if (m._vxStatus === 'nostock') no++;
  }
  const closed = n - ok - no;
  const size = n < 10 ? 38 : n < 100 ? 44 : n < 1000 ? 52 : 58;
  const a = (ok / n) * 100;
  const b = a + (no / n) * 100;

  const root = document.createElement('div');
  const ring = document.createElement('div');
  ring.className = 'cl__ring';
  // CSSOM 設定樣式（不受 CSP style-src 限制）
  ring.style.background =
    `conic-gradient(var(--ok) 0 ${a}%, var(--warn) ${a}% ${b}%, var(--closed) ${b}% 100%)`;
  const num = document.createElement('span');
  num.className = 'cl__n';
  num.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  ring.appendChild(num);
  root.appendChild(ring);
  root.title = tn('map.clusterTitle', n, { ok, no, closed });
  const hit = Math.max(HIT, size);
  if (hit > size) ring.style.inset = `${(hit - size) / 2}px`;
  return L.divIcon({ html: root, className: 'cl', iconSize: [hit, hit] });
}

export function createMap(el, handlers = {}) {
  const map = L.map(el, {
    zoomControl: false,
    preferCanvas: false,
    worldCopyJump: false,
    minZoom: 6,
    maxZoom: 19,
    maxBounds: [[17, 112], [30, 128]],
    maxBoundsViscosity: 0.6,
    keyboard: true,
  });
  L.control.zoom({ position: 'topleft', zoomInTitle: t('map.zoomIn'), zoomOutTitle: t('map.zoomOut') }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.fitBounds(TW_BOUNDS);

  // ---------- 底圖與備援 ----------
  // 依介面語系選底圖鏈（中文地名／英文地名），切換語系時由 relabel() 換鏈，不需重新載入。
  // 起點：網址測試掛勾 → 使用者在圖例選過的底圖（localStorage，依 zh／latin 分開）→ 鏈的第一個。
  // 測試用：?tiles=<供應者 id>（osm、nlsc、nlscEn）若在目前的鏈中就從它開始（不寫入偏好）；
  // ?tiles=fail 讓每條鏈的預設底圖指向無效主機以驗證自動備援；?tiles=fail:<id>[,<id>] 只讓指定的底圖失效。
  let tileMode = null;
  try { tileMode = new URLSearchParams(location.search).get('tiles'); } catch { /* ignore */ }
  const failIds = tileMode === 'fail' ? null : tileMode?.startsWith('fail:') ? tileMode.slice(5).split(',') : [];
  const chains = {};
  for (const [kind, list] of Object.entries(BASEMAP_CHAINS)) {
    chains[kind] = list.map(([id, attribution], i) => {
      const p = PROVIDERS[id];
      const broken = failIds === null ? i === 0 : failIds.includes(id);
      const url = broken ? 'https://tiles.invalid/{z}/{x}/{y}.png' : p.url;
      return { id, name: p.name, labels: p.labels, service: p.service, url, options: { ...p.options, attribution } };
    });
  }
  let chainKind = null;
  let seq = null; // 本次嘗試順序：[選定的底圖, ...其餘依鏈的順序]
  let tileLayer = null;
  /** 從 id 開始的嘗試順序（id 不在鏈中就從預設開始） */
  function sequenceFrom(id) {
    const chain = chains[chainKind];
    const first = chain.find((x) => x.id === id) || chain[0];
    const list = [first, ...chain.filter((x) => x !== first)];
    list.failed = new Set(); // 已失效的服務
    return list;
  }
  function useTiles(i) {
    if (tileLayer) map.removeLayer(tileLayer);
    let errors = 0, loads = 0; // 每個圖層各自計數
    const cur = seq;
    const tl = cur[i];
    const layer = L.tileLayer(tl.url, { ...tl.options, detectRetina: false });
    tileLayer = layer;
    el.dataset.basemap = tl.id; // 供測試與除錯辨識目前底圖
    handlers.onBasemapChange?.(tl.id, chains[chainKind].map((x) => x.id));
    layer.on('tileerror', () => {
      if (tileLayer !== layer) return; // 已被替換的圖層
      errors++;
      if (errors === 4 && errors > loads * 2) {
        cur.failed.add(tl.service);
        let j = i + 1;
        while (j < cur.length && cur.failed.has(cur[j].service)) j++;
        if (j < cur.length) {
          const to = cur[j];
          useTiles(j);
          handlers.onTileStatus?.('fallback', {
            from: tl.name, to: to.name, fromId: tl.id, toId: to.id,
            // 外文介面由英文地名的底圖備援到中文地名的底圖時，提醒使用者地名可能是中文
            localLabels: chainKind !== 'zh' && to.labels === 'zh' && tl.labels !== 'zh',
          });
        } else {
          handlers.onTileStatus?.('failed');
        }
      }
    });
    layer.on('tileload', () => {
      if (tileLayer !== layer) return;
      loads++;
      if (loads === 1) handlers.onTileStatus?.(i === 0 ? 'ok' : 'ok-fallback');
    });
    layer.addTo(map);
  }
  /** 依目前語系選底圖鏈；鏈沒變就不動（避免切換同類語系時重載圖磚） */
  function syncBasemap() {
    const kind = basemapKind(getLang());
    if (kind === chainKind) return;
    chainKind = kind;
    const forced = chains[kind].some((x) => x.id === tileMode) ? tileMode : null;
    seq = sequenceFrom(forced || readBasemapPref()[kind]);
    useTiles(0);
  }
  /** 使用者在圖例選擇底圖：立即切換並記住（依地名文字分開記） */
  function setBasemap(id) {
    if (!chains[chainKind].some((x) => x.id === id)) return;
    writeBasemapPref(chainKind, id);
    if (el.dataset.basemap === id) return;
    seq = sequenceFrom(id);
    useTiles(0);
  }
  syncBasemap();

  // ---------- 院所標記 ----------
  const cluster = L.markerClusterGroup({
    chunkedLoading: true,
    chunkInterval: 120,
    chunkDelay: 16,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    removeOutsideVisibleBounds: true,
    maxClusterRadius: (z) => (z >= 15 ? 40 : 60),
    disableClusteringAtZoom: 17,
    iconCreateFunction: clusterIcon,
  });
  map.addLayer(cluster);

  const markers = new Map(); // id → marker
  let shown = new Set(); // ids currently in cluster group
  let activeId = null; // hovered (from list)
  let selectedId = null;
  let hlCluster = null;

  function iconFor(m) {
    const active = m._vxId === activeId || m._vxId === selectedId;
    return icons()[active ? `${m._vxStatus}:active` : m._vxStatus];
  }

  function getMarker(h) {
    let m = markers.get(h.id);
    if (!m) {
      m = L.marker([h.lat, h.lng], {
        icon: icons().ok,
        title: h.name,
        alt: h.name,
        keyboard: true,
        riseOnHover: true,
      });
      m._vxId = h.id;
      m._vxStatus = 'ok';
      m.on('click', () => handlers.onMarkerClick?.(h.id));
      m.on('mouseover', () => handlers.onMarkerHover?.(h.id));
      m.on('mouseout', () => handlers.onMarkerHover?.(null));
      m.on('add', () => {
        const icon = m.getElement();
        if (icon) {
          icon.setAttribute('role', 'button');
          icon.setAttribute('aria-label', t('map.markerLabel', { name: h.name, status: statusText(m._vxStatus) }));
          if (!icon._vxBound) {
            icon._vxBound = true;
            icon.addEventListener('focus', () => handlers.onMarkerHover?.(h.id));
            icon.addEventListener('blur', () => handlers.onMarkerHover?.(null));
          }
        }
      });
      markers.set(h.id, m);
    }
    return m;
  }

  /**
   * 更新顯示的院所。items: [{h, status}]
   * 狀態有變 → 批次重建（clearLayers + addLayers）；
   * 僅成員變動 → 差異更新（removeLayers / addLayers）。
   * 分批載入進行中時，新的更新會排隊（只保留最新一次），避免舊批次把過期標記加回來。
   * @returns {Promise<void>} 全部標記加入後 resolve
   */
  let busy = false;
  let queued = null;
  function update(items) {
    if (busy) {
      if (queued) queued.resolve();
      return new Promise((resolve) => { queued = { items, resolve }; });
    }
    busy = true;
    return new Promise((resolve) => {
      applyUpdate(items, () => {
        busy = false;
        resolve();
        if (queued) {
          const q = queued;
          queued = null;
          update(q.items).then(q.resolve);
        }
      });
    });
  }

  function addBulk(list, done) {
    if (!list.length) { done(); return; }
    cluster.options.chunkProgress = (p, t) => {
      if (p >= t) { cluster.options.chunkProgress = null; done(); }
    };
    cluster.addLayers(list);
  }

  function applyUpdate(items, done) {
    const next = new Set();
    let statusChanged = false;
    const all = [];
    for (const { h, status } of items) {
      const m = getMarker(h);
      next.add(h.id);
      if (m._vxStatus !== status) {
        m._vxStatus = status;
        applyIcon(m);
        if (shown.has(h.id)) statusChanged = true;
      }
      all.push(m);
    }
    const toRemove = [];
    for (const id of shown) if (!next.has(id)) toRemove.push(markers.get(id));
    const toAdd = [];
    for (const id of next) if (!shown.has(id)) toAdd.push(markers.get(id));
    const prevSize = shown.size;
    shown = next;
    clearClusterHl();
    if (statusChanged || prevSize === 0 || toRemove.length > 1500 || toRemove.length > next.size) {
      cluster.clearLayers();
      addBulk(all, done);
      return;
    }
    if (toRemove.length) cluster.removeLayers(toRemove);
    addBulk(toAdd, done);
  }

  function applyIcon(m) {
    m.setIcon(iconFor(m));
    const el = m.getElement();
    if (el) el.setAttribute('aria-label', t('map.markerLabel', { name: m.options.title, status: statusText(m._vxStatus) }));
  }

  function refreshIcon(id) {
    const m = markers.get(id);
    if (m) applyIcon(m);
  }

  function clearClusterHl() {
    if (hlCluster && hlCluster._icon) hlCluster._icon.classList.remove('is-hl');
    hlCluster = null;
  }

  /** 由清單 hover/focus 觸發：標記放大；若在群集內則強調該群集 */
  function highlight(id) {
    if (activeId === id) return;
    const prev = activeId;
    activeId = id;
    if (prev != null) refreshIcon(prev);
    clearClusterHl();
    if (id == null) return;
    const m = markers.get(id);
    if (!m || !shown.has(id)) return;
    const parent = cluster.getVisibleParent(m);
    if (parent && parent !== m && parent._icon) {
      parent._icon.classList.add('is-hl');
      hlCluster = parent;
    } else {
      applyIcon(m);
      m.setZIndexOffset(1000);
    }
    if (prev != null) markers.get(prev)?.setZIndexOffset(0);
  }

  function select(id) {
    const prev = selectedId;
    selectedId = id;
    if (prev != null) { refreshIcon(prev); markers.get(prev)?.setZIndexOffset(0); }
    if (id != null) { refreshIcon(id); markers.get(id)?.setZIndexOffset(2000); }
  }

  /** 讓座標出現在「可見區域」（扣除底部 bottom sheet 高度）中央附近 */
  function panIntoView(latlng, bottomInset = 0, { force = false } = {}) {
    const size = map.getSize();
    const visH = Math.max(80, size.y - bottomInset);
    const p = map.latLngToContainerPoint(latlng);
    const margin = 48;
    const inside = p.x > margin && p.x < size.x - margin && p.y > margin && p.y < visH - margin;
    if (inside && !force) return;
    const target = L.point(size.x / 2, visH / 2);
    map.panBy(p.subtract(target), { animate: !reducedMotion() });
  }

  /** 顯示單一院所（必要時展開群集／放大），完成後回呼 */
  function reveal(h, bottomInset = 0, cb) {
    const m = getMarker(h);
    const latlng = L.latLng(h.lat, h.lng);
    const finish = () => { panIntoView(latlng, bottomInset); cb?.(); };
    if (!shown.has(h.id)) {
      // 不在目前篩選結果中：直接移過去
      const z = Math.max(map.getZoom(), 16);
      map.setView(latlng, z, { animate: false });
      panIntoView(latlng, bottomInset, { force: true });
      cb?.();
      return;
    }
    const parent = cluster.getVisibleParent(m);
    if (parent === m) { finish(); return; }
    // 在群集內或在畫面外
    if (map.getZoom() < 16 && (!parent || parent !== m)) {
      map.setView(latlng, Math.max(16, map.getZoom()), { animate: false });
    }
    cluster.zoomToShowLayer(m, finish);
  }

  function fitTo(hospitals, { bottomInset = 0, maxZoom = 15 } = {}) {
    if (!hospitals.length) return;
    const b = L.latLngBounds(hospitals.map((h) => [h.lat, h.lng]));
    map.fitBounds(b, {
      paddingTopLeft: [30, 30],
      paddingBottomRight: [30, 30 + bottomInset],
      maxZoom,
      animate: !reducedMotion(),
    });
  }

  function fitTaiwan(bottomInset = 0) {
    map.fitBounds(TW_BOUNDS, { paddingBottomRight: [0, bottomInset], animate: false });
  }

  /** 可見範圍（扣除底部遮擋） */
  function visibleBounds(bottomInset = 0) {
    const size = map.getSize();
    const visH = Math.max(size.y * 0.35, size.y - bottomInset);
    const sw = map.containerPointToLatLng([0, visH]);
    const ne = map.containerPointToLatLng([size.x, 0]);
    return L.latLngBounds(sw, ne);
  }

  function visibleCenter(bottomInset = 0) {
    const size = map.getSize();
    const visH = Math.max(size.y * 0.35, size.y - bottomInset);
    return map.containerPointToLatLng([size.x / 2, visH / 2]);
  }

  // ---------- 使用者位置 ----------
  let meMarker = null;
  let meCircle = null;
  function setUserLocation(lat, lng, accuracy, bottomInset = 0) {
    const ll = L.latLng(lat, lng);
    if (!meMarker) {
      meMarker = L.marker(ll, {
        icon: L.divIcon({
          className: 'me-dot',
          html: '<span class="me-dot__p"></span><span class="me-dot__c"></span>',
          iconSize: [22, 22],
        }),
        keyboard: false,
        interactive: false,
        zIndexOffset: 3000,
      }).addTo(map);
      meCircle = L.circle(ll, {
        radius: accuracy || 50,
        color: '#1a73e8', weight: 1, opacity: 0.5,
        fillColor: '#1a73e8', fillOpacity: 0.08, interactive: false,
      }).addTo(map);
    } else {
      meMarker.setLatLng(ll);
      meCircle.setLatLng(ll).setRadius(accuracy || 50);
    }
    const z = 15;
    // 讓定位點落在可見區域中央
    const target = map.project(ll, z).add([0, bottomInset / 2]);
    const center = map.unproject(target, z);
    if (reducedMotion()) map.setView(center, z, { animate: false });
    else map.flyTo(center, z, { duration: 0.8 });
  }

  function getView() {
    const c = map.getCenter();
    return { lat: c.lat, lng: c.lng, z: map.getZoom() };
  }

  map.on('moveend', () => handlers.onMoveEnd?.());

  /** 切換語系後：底圖地名語言、縮放按鈕、圖釘（休診符號與 aria-label）、群集提示文字 */
  function relabel() {
    syncBasemap();
    const zin = el.querySelector('.leaflet-control-zoom-in');
    const zout = el.querySelector('.leaflet-control-zoom-out');
    for (const [a, key] of [[zin, 'map.zoomIn'], [zout, 'map.zoomOut']]) {
      if (!a) continue;
      a.title = t(key);
      a.setAttribute('aria-label', t(key));
    }
    for (const m of markers.values()) {
      if (m.options.icon !== iconFor(m)) m.setIcon(iconFor(m));
      const e = m.getElement();
      if (e) e.setAttribute('aria-label', t('map.markerLabel', { name: m.options.title, status: statusText(m._vxStatus) }));
    }
    cluster.refreshClusters();
  }

  return {
    map,
    update,
    highlight,
    select,
    reveal,
    fitTo,
    fitTaiwan,
    visibleBounds,
    visibleCenter,
    setUserLocation,
    getView,
    relabel,
    setBasemap,
    getBasemap: () => ({ id: el.dataset.basemap, choices: chains[chainKind].map((x) => x.id) }),
    setView: (v) => map.setView([v.lat, v.lng], v.z, { animate: false }),
    invalidate: () => map.invalidateSize({ pan: false }),
    panIntoView,
  };
}

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
