// Leaflet 地圖封裝：底圖（含自動備援）、院所標記、群集、定位點。
/* global L */

const TW_BOUNDS = [[21.8, 119.9], [25.4, 122.1]];

// 順序即優先順序：第一個是預設底圖，載入失敗時自動換下一個
const TILES = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> 貢獻者',
    },
  },
  {
    id: 'nlsc',
    name: '國土測繪中心通用版電子地圖',
    url: 'https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}',
    options: { maxZoom: 19, maxNativeZoom: 19, attribution: '© 內政部國土測繪中心' },
  },
];

const GLYPH = { ok: '✓', nostock: '–', closed: '休' };
// 視覺尺寸 30/26px，但圖示元素（觸控範圍）一律 44px
const HIT = 44;

function makeIcon(status, active) {
  const s = HIT;
  return L.divIcon({
    className: `mk mk--${status}${active ? ' mk--active' : ''}`,
    html: `<span class="mk__b"><span class="mk__g" aria-hidden="true">${GLYPH[status]}</span></span>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
  });
}

const ICONS = {};
for (const st of ['ok', 'nostock', 'closed']) {
  ICONS[st] = makeIcon(st, false);
  ICONS[`${st}:active`] = makeIcon(st, true);
}

const STATUS_TEXT = { ok: '有庫存', nostock: '無庫存', closed: '今日休診' };

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
  root.title = `${n} 家院所：有庫存 ${ok}、無庫存 ${no}、今日休診 ${closed}（點擊放大）`;
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
  L.control.zoom({ position: 'topleft', zoomInTitle: '放大', zoomOutTitle: '縮小' }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.fitBounds(TW_BOUNDS);

  // ---------- 底圖與備援 ----------
  // 測試用：?tiles=nlsc 直接使用備援底圖；?tiles=fail 讓預設底圖指向無效主機以驗證自動備援
  let tileMode = null;
  try { tileMode = new URLSearchParams(location.search).get('tiles'); } catch { /* ignore */ }
  const tiles = TILES.map((t) => ({ ...t }));
  if (tileMode === 'fail') tiles[0] = { ...tiles[0], url: 'https://tiles.invalid/{z}/{x}/{y}.png' };
  let tileIdx = 0;
  let tileLayer = null;
  function useTiles(i) {
    if (tileLayer) map.removeLayer(tileLayer);
    tileIdx = i;
    let errors = 0, loads = 0; // 每個圖層各自計數
    const t = tiles[i];
    const layer = L.tileLayer(t.url, { ...t.options, detectRetina: false });
    tileLayer = layer;
    layer.on('tileerror', () => {
      if (tileLayer !== layer) return; // 已被替換的圖層
      errors++;
      if (errors === 4 && errors > loads * 2) {
        if (tileIdx + 1 < tiles.length) {
          const from = tiles[tileIdx].name;
          useTiles(tileIdx + 1);
          handlers.onTileStatus?.('fallback', { from, to: tiles[tileIdx].name });
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
  useTiles(tileMode === 'nlsc' ? 1 : 0);

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
    return ICONS[active ? `${m._vxStatus}:active` : m._vxStatus];
  }

  function getMarker(h) {
    let m = markers.get(h.id);
    if (!m) {
      m = L.marker([h.lat, h.lng], {
        icon: ICONS.ok,
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
          icon.setAttribute('aria-label', `${h.name}，${STATUS_TEXT[m._vxStatus]}`);
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
    if (el) el.setAttribute('aria-label', `${m.options.title}，${STATUS_TEXT[m._vxStatus]}`);
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
    setView: (v) => map.setView([v.lat, v.lng], v.z, { animate: false }),
    invalidate: () => map.invalidateSize({ pan: false }),
    panIntoView,
  };
}

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
