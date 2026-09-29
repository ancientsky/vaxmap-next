# 底圖：地名語言評估與決策

問題：介面切到英文／韓文／越南文／泰文／印尼文／菲律賓文時，地圖上的街道與地名仍是中文
（OSM 官方圖磚一律用當地名稱）。條件：免 API key、免帳號、可從 GitHub Pages 使用、
符合供應者對低流量公開原型的使用規範。

評估日期 2026-09-29。方法：經沙盒代理實際抓取臺北（中正／大安一帶）z7–z19 圖磚、拼接後以肉眼檢視
標籤文字；向量圖磚以 `@mapbox/vector-tile` 解碼、統計各 `name:*` 欄位；MapLibre 在與本站相同的
CSP＋Trusted Types 下以 Playwright 實測。

## 結論

**維持 Leaflet＋點陣圖磚，依介面語系選底圖鏈**（`public/js/map.js` 的 `BASEMAP_CHAINS`），並在圖例提供「底圖」切換：

| 介面語系 | 預設 | 備援 | 備援時的提示 | 圖例「底圖」可選 |
|---|---|---|---|---|
| 繁體中文 | NLSC 通用版電子地圖 `EMAP`（中文地名；臺灣使用者載入較快） | OpenStreetMap（中文地名） | `map.tileFallback` | 通用版電子地圖／OpenStreetMap |
| ja | 同 zh-Hant（日文使用者看得懂漢字路名，且與路牌一致） | 同上 | 同上 | 同上 |
| 其他 6 種（en、ko、id、vi、th、tl） | NLSC 英文版電子地圖 `EMAP8`（英文地名） | OpenStreetMap（中文地名） | `map.tileFallbackLocal`（提醒地名可能是中文） | NLSC (English)／NLSC 中文版（地名與路牌一致）／OpenStreetMap |

- **使用者選擇**：圖例（左下「圖例」，手機在右上、預設收合）內的「底圖」單選按鈕（`<fieldset>`＋`<legend>`，原生
  `<input type=radio>`），選了立即換圖、版權列跟著換。選擇存在 localStorage `vaxmap.basemap`（讀寫都包 try/catch），
  **依地名文字分開記**：`{"zh":"osm","latin":"nlsc"}`——中文／日文介面的選擇不影響外文介面，反之亦然；切換語系時各自套用。
  只切換語系不會寫入偏好。
- **自動備援仍有效**：不論是預設或使用者選的底圖，連續載入失敗就依鏈的順序換下一個並顯示提示；**同一服務（主機）的
  圖層視為一起失效**，例如外文介面選了 NLSC 中文版而 NLSC 失效時，直接跳到 OSM，不會再試 EMAP8。
  備援後單選按鈕會改勾實際顯示的底圖，但**不改寫使用者存下的選擇**（下次載入仍先試他選的）。
  外文介面只有「英文地名 → 中文地名」時才用 `map.tileFallbackLocal`；使用者自己選了中文版 NLSC 再備援到 OSM 時用一般提示。
- 切換語系時由 `relabel()` 換鏈，不重新載入頁面；同一條鏈內的語系互切（例如 en → ko）不會重抓圖磚。

EMAP8 與 EMAP 同一主機，**CSP 不需變動**；Trusted Types 只多放行 3 個固定的版權字串，沒有新增任何
第三方程式碼。切換器的文字全部經由 `data-i18n`（textContent）寫入，沒有使用 innerHTML。

## 候選與實測證據

| 候選 | 臺北標籤語言（實測） | 條件／規範 | 判定 |
|---|---|---|---|
| OSM 官方 `tile.openstreetmap.org/{z}/{x}/{y}.png` | 全中文 | 免金鑰；[圖磚政策](https://operations.osmfoundation.org/policies/tiles/) 允許低流量、需標示 | 各語系備援＋可選（2026-09-29 起繁中／日文預設改為 EMAP） |
| **NLSC `EMAP8`**「臺灣通用電子地圖EN」 `wmts.nlsc.gov.tw/wmts/EMAP8/default/GoogleMapsCompatible/{z}/{y}/{x}` | **全英文**，z7（Taipei、Kaohsiung…）到 z19（Ln. 13, Linyi St.、Metro Exit 2）皆是；全臺（高雄 z14 亦同）；道路拼寫與臺灣官方路牌一致（Sec. 3, Civic Blvd.、Xinsheng S. Rd.） | NLSC WMTS 說明頁：「使用者無需申請，即可利用符合OGC WMTS軟體介接」；列於官方清單「臺灣通用電子地圖EN，JPG，最大層級 19」 | **外文主底圖** |
| NLSC `EMAP97`「Taiwan e-Map(new)」 | 英文，但字距錯亂（“S hi min Blvd”）、POI 圖示極多 | 同上 | 不採用 |
| NLSC `EMAP`「通用版電子地圖」 | 中文 | 同上 | **繁中／日文主底圖**（臺灣使用者載入較快）；外文介面可選 |
| Carto `basemaps.cartocdn.com`（voyager、voyager_labels_under、light_all） | 三種樣式都回傳同一張 2 KB 圖片，內容為「**API KEY REQUIRED** carto.com/basemaps/apikey」 | 現已需要金鑰 | 淘汰 |
| Esri `server.arcgisonline.com/.../World_Street_Map`、`World_Topo_Map` | 以中文為主，只有部分里名／道路附機器拼音（“Zhu Yuan Li”、“Guo Li Tai Bei Ke Ji Da Xue”） | Esri 已[呼籲改用新版 basemap 服務](https://www.esri.com/arcgis-blog/products/developers/developers/open-source-developers-time-to-upgrade-to-the-new-arcgis-basemap-layer-service)（需 ArcGIS 帳號與 API key）；舊端點條款未能確認 | 淘汰（標籤也不合用） |
| Wikimedia Maps `maps.wikimedia.org/osm-intl` | —（HTTP 403） | 回應：“Map tiles are restricted to Wikimedia and affiliated sites only” | 淘汰 |
| OpenFreeMap 向量圖磚 `tiles.openfreemap.org`＋MapLibre GL | 見下 | 免金鑰、免帳號；[條款](https://openfreemap.org/tos/)無流量上限但「不保證可用、可隨時終止」 | 不採用（理由見下） |

### OpenFreeMap（向量）細節

解碼 `planet/20260913_164504_pt/14/13723/7014.pbf`（臺北市中心，單一圖磚 **940 KB**）：

| 圖層 | 有名稱的要素 | `name:en` | `name:ja` | `name:ko` | `name:vi` | `name:th` |
|---|---|---|---|---|---|---|
| transportation_name（道路） | 800 | 599（75%） | 0 | 0 | 0 | 0 |
| place | 172 | 71 | 20 | 13 | 7 | 3 |
| poi | 6,278 | 2,022 | 243 | 45 | 14 | 4 |

- 約 25% 的道路沒有英文名，外文介面下仍會顯示中文（實際渲染也看得到「忠孝東路入口匝道」「信義路出口」等只有中文的標籤）。
- **沒有任何道路有日文或韓文名稱**，所以「ja/ko 顯示母語地名」即使換成向量圖也做不到；只有少數地名、車站有。
- MapLibre GL 5.24.0：主程式 1.06 MB（gzip 276 KB），CSP 版 972 KB＋worker 458 KB；需要 WebGL。
- **Trusted Types 實測**：原封不動會失敗（`Failed to construct 'Worker': This document requires 'TrustedScriptURL'`）。
  另加「只放行同源 `maplibre-gl-csp-worker.js`」的 `createScriptURL` 規則後可以顯示，但它還會把版權 HTML 送進
  `DOMParser.parseFromString`，需要再放行該字串。可行，但要放寬 TT、要改寫整套圖釘／群集（markercluster 是 Leaflet 專用），
  換來的只是 75% 的英文道路名——不如 EMAP8 的 100%。

## 使用規範與正式上線注意事項

- **NLSC**：官方說明 WMTS「無需申請」即可介接；版權標示為「© 內政部國土測繪中心」（英文介面顯示
  “© NLSC, Ministry of the Interior (Taiwan)”）。注意 data.gov.tw 上明確以「政府資料開放授權條款」釋出的是
  `EMAP5_OPENDATA`／`EMAP6_OPENDATA`（最大層級 15）；EMAP／EMAP8 的全層級圖磚屬「免申請介接」服務，
  **沒有公開的流量上限或 SLA**。自 2026-09-29 起**所有語系的預設底圖都在 NLSC**（EMAP／EMAP8），OSM 只在備援或使用者選擇時才用到，
  因此正式上線、流量變大前，更需要以疾管署名義向國土測繪中心確認使用方式與流量。
  EMAP8 圖面上有很淡的「NLSC 202608」浮水印（版本標記），不影響閱讀。
- **OSM**：見 README「底圖」。大流量不得依賴官方圖磚。
- 兩個主機都在 CSP `img-src` 內；新增供應者時要同步 `index.html` 的 CSP 與 `trusted-types.js` 的版權字串
  （`npm test` 的 security 測試會檢查版權字串是否在 TT 允許清單）。

## 測試掛勾

- `?tiles=fail`：每條鏈的**預設**底圖改指向無效主機，驗證備援（繁中／日文 → OSM；外文 → OSM＋「地名可能是中文」提示）。
- `?tiles=fail:<id>[,<id>]`：只讓指定底圖失效，例如先選 OSM 再加 `?tiles=fail:osm`，驗證「使用者選的底圖失效」時的備援。
- `?tiles=<id>`（`osm`、`nlsc`、`nlscEn`）：若該底圖在目前語系的鏈中，就從它開始（優先於使用者的選擇，且不寫入偏好）。
- `#map` 元素的 `data-basemap` 屬性為目前底圖 id，供 e2e 檢查。截圖：`tests/screenshots/basemap-{zh,en,ja,ko,th}-desktop.png`、
  `basemap-en-fallback-desktop.png`、`basemap-switcher-{desktop,mobile}.png`。

## 日後可再評估

- 日文介面目前走中文地名鏈（`basemapKind()`）；若回饋偏好英文地名，把 `ja` 改走 `latin` 鏈即可（使用者也可在圖例自行切換到 OSM，但 ja 目前不提供英文版選項）。
- 若 OSM 臺灣的 `name:en` 覆蓋率大幅提高、或需要離線／自架，可再評估 OpenFreeMap／自架向量圖磚＋MapLibre（見上方 TT 需求）。
