# 疫苗及流感藥劑地圖（vaxmap-next）

這是衛生福利部疾病管制署「疫苗及流感抗病毒藥劑地圖」（vaxmap.cdc.gov.tw）的**概念原型（Proof of Concept）**，
用來示範一套較現行網站更快、更好用的前端體驗。**這不是官方網站**，未部署在任何政府網域，資料也
**不是即時資料**，而是 2026-09-21 從現站擷取的一次性快照（見下方「資料如何更新」）。若接手本專案，
建議先讀 `docs/DATA_SCHEMA.md`（前端資料契約）與 `docs/HARVEST.md`（快照怎麼來的、有什麼限制）。

## 這是什麼、不是什麼

- 是：一個純靜態網站原型，讀取單一 JSON 檔即可運作，展示新的篩選、清單、地圖互動與可分享網址設計。
- 不是：正式上線系統、即時資料來源、或現站的替代品。距離、庫存、看診時段皆為快照當下資料，
  **實際接種前務必先電洽院所**。

## 資料夾結構

```
public/                 網站本體（唯一需要部署的目錄）
  index.html
  css/app.css
  js/
    app.js              主流程／狀態管理／畫面組裝
    ui.js               DOM 產生器（純函式，不含商業邏輯）
    map.js              Leaflet 地圖封裝
    logic.js            純函式（時間、篩選、排序、URL 狀態）— 無 DOM 相依，可單元測試
    data-source.js       資料來源 adapter（目前讀本地 JSON；換即時 API 只改這個檔）
  data/hospitals.json   正規化後的院所資料（前端唯一讀取的資料檔）
  vendor/leaflet, vendor/markercluster   第三方地圖函式庫（打包好的靜態檔，隨 public/ 一起部署）

data/raw/               原始擷取檔（.json.gz），僅用於產生 public/data/hospitals.json，不隨網站部署
scripts/
  dev-server.mjs        本地開發用零相依靜態伺服器
  harvest.mjs           從現站擷取全國院所資料 → data/raw/*.json.gz（過渡作法，見 docs/HARVEST.md）
  normalize.mjs         data/raw/*.json.gz → public/data/hospitals.json 的轉換腳本
  keep-live-data.mjs    部署時若線上資料較新就沿用（供 GitHub Actions 使用）
.github/workflows/
  deploy.yml            部署到 GitHub Pages＋每日兩次自動更新資料
  snapshot.yml          每月把線上資料存回 repo
docs/
  DATA_SCHEMA.md        public/data/hospitals.json 的格式契約
  HARVEST.md            2026-09-21 快照的擷取方式與已知限制
tests/
  logic.test.mjs        logic.js 單元測試（node:test）
  data.test.mjs         hospitals.json 資料品質測試，並對照 data/raw 交叉驗證
  e2e.spec.mjs          Playwright 端對端煙霧測試（桌面＋手機）
  a11y.spec.mjs         無障礙檢查（僅回報，不修正）
  harvest.test.mjs      以模擬來源伺服器（mock-source.mjs）驗證 harvest.mjs
```

## 本地執行

開發伺服器預設只綁定本機（127.0.0.1）；要讓同網路的手機連進來測試，請以 `HOST=0.0.0.0 npm run dev` 啟動。

需求：Node.js 18 以上（`"type": "module"`，使用 ES modules 與 `node:test`）。本專案**沒有建置流程**——
`public/` 底下就是可直接部署的成品，`leaflet`／`leaflet.markercluster` 僅列於 `devDependencies`，
是給日後要重新產生 `public/vendor/` 底下打包檔時用的，正式運行不需要 `npm install`。

```bash
npm run dev        # 啟動 http://localhost:5173/（PORT 環境變數可覆寫）
```

## 執行測試

```bash
npm test           # 單元測試 + 資料品質測試（node --test）
npm run test:e2e   # Playwright 端對端煙霧測試（桌面 1440x900、手機 390x844）
npm run test:a11y  # 無障礙檢查（僅回報問題，不會修改任何檔案）
```

`test:e2e` 與 `test:a11y` 需要環境已全域安裝 `playwright`（本專案假設版本 1.56）且瀏覽器已預先安裝
（`PLAYWRIGHT_BROWSERS_PATH` 指向已安裝好 Chromium 的目錄）；這兩支腳本會自行啟動
`scripts/dev-server.mjs` 在一個隨機可用連接埠上，測試結束後自動關閉，**不需要另外手動啟動伺服器**。

## 部署

`public/` 是唯一需要上線的目錄，複製到任何靜態主機（Nginx、IIS、S3+CDN、GitHub Pages 等）即可，
不需要任何伺服器端程式或資料庫。

### IIS 部署注意事項

- **MIME 類型**：確認 `.json` 對應到 `application/json`（IIS 預設通常已內建；若無則於
  `web.config` 新增 `<staticContent><mimeMap fileExtension=".json" mimeType="application/json" /></staticContent>`）。
- **靜態壓縮**：啟用 IIS 的 Static Compression（`httpCompression`／`urlCompression`），
  `hospitals.json` 未壓縮約 1.2 MB，啟用 gzip 後可降至約 240 KB，對行動網路使用者體驗影響很大。
- **建議 HTTP 標頭**：
  | 標頭 | 建議值 | 原因 |
  |---|---|---|
  | `Content-Security-Policy` | 依 `public/index.html` 內既有的 `<meta http-equiv>` 設定同步到伺服器層（`frame-ancestors 'none'` 需在 HTTP 標頭層設定，`<meta>` 標籤無法宣告 `frame-ancestors`） | 防止被嵌入 iframe（clickjacking）、限制指令碼／樣式來源 |
  | `X-Content-Type-Options` | `nosniff` | 避免瀏覽器猜測 MIME 類型造成的風險 |
  | `Referrer-Policy` | `strict-origin-when-cross-origin` | 已於 `<meta name="referrer">` 設定，伺服器層可再加一道 |
  | `X-Frame-Options` | `DENY`（若不使用 CSP `frame-ancestors`） | 同上，較舊瀏覽器的保險做法 |
- **快取策略**：
  | 路徑 | 建議快取 | 原因 |
  |---|---|---|
  | `data/hospitals.json` | 短快取（例如 `Cache-Control: no-cache` 或 `max-age=60~300`） | 資料會定期更新，太長的快取會讓使用者看到過期庫存 |
  | `vendor/**`、`css/**`、`js/**` | 長快取＋版本化（例如 `max-age=31536000, immutable`，搭配檔名或查詢字串加版本號） | 內容變動時才需要失效，可大幅減少重複下載 |
  | `index.html` | 短快取或不快取 | 確保使用者能拿到最新的資源參照 |

  目前 `scripts/dev-server.mjs`（僅供本地開發）對所有檔案都回傳 `Cache-Control: no-cache`；正式環境
  請依上表在 IIS／CDN 層另行設定，不需要修改 `public/` 內容本身。

## 資料如何更新（目前作法）

`npm run update-data` 會依序執行三件事：`scripts/harvest.mjs` 從現站擷取全國院所資料，存成
`data/raw/vaxmap_raw_YYYYMMDD-HHmm.json.gz`；`scripts/normalize.mjs` 把最新的原始檔轉成
`public/data/hospitals.json`（格式契約見 `docs/DATA_SCHEMA.md`）；最後跑資料檢查。任何一步失敗就會中止，
不會留下半套資料上線。擷取的細節與限制見 `docs/HARVEST.md`。

一次完整擷取約對現站發出 280 次請求、傳輸近 100 MB，需時 10–15 分鐘。來源資料本身是院所每日回報，
**一天更新 1–2 次就足夠，請勿調高頻率或調低請求間隔**。若在 GitHub Pages 上自動更新，見下一節。

這仍是**過渡作法**；正式作法是由伺服器端直接匯出資料（見「建議的正式資料串接方式」）。

## 部署到 GitHub Pages（含每日自動更新資料）

專案內已附兩個 GitHub Actions 工作流程。

`.github/workflows/deploy.yml`（部署與資料更新）在三種情況下執行：推送到 `main`、每天臺北時間 05:30 與
12:30 的排程、以及在 Actions 頁面手動執行。排程與手動執行時會先重新擷取資料，通過檢查後連同網站一起部署；
推送程式碼時不擷取，只部署。**擷取到的資料不會提交進 repo**（否則每天會多出約 1 MB 的歷史紀錄），
而是直接隨該次部署上線。為了避免「只改程式的部署」或「擷取失敗的部署」把線上資料蓋回 repo 裡較舊的快照，
流程會用 `scripts/keep-live-data.mjs` 比對線上現有的 `hospitals.json`，線上那份比較新就沿用。
擷取失敗時網站仍會照常部署（沿用上一份資料），但該次執行會標示為失敗，GitHub 會寄信通知 repo 擁有者；
畫面上的「資料快照」時間超過 36 小時也會顯示「已 N 天未更新」。

`.github/workflows/snapshot.yml`（每月快照存檔）每月把線上資料提交回 repo 一次，讓 repo 內的備援快照不至於太舊；
另一個作用是保持 repo 有活動——公開 repo 連續 60 天沒有活動時，GitHub 會自動停用排程。

第一次設定的步驟：

1. 在 GitHub 建立 repo，把本專案整個推上去（預設分支需為 `main`）。
2. 到 repo 的 Settings → Pages，把 Source 設為 **GitHub Actions**。
3. 推送後 `deploy.yml` 會自動執行並部署；網址會顯示在該次執行的 deploy 工作上。
4. 到 Actions 頁面手動執行一次「部署與資料更新」（保持勾選重新擷取），確認 GitHub 的執行機器
   **連得到現站**。GitHub 的機器都在國外，現站若阻擋境外連線，擷取步驟會失敗並顯示原因。

若第 4 步確認境外連不到現站，有兩個替代作法，前端與流程都不用改：在署內或任何一台國內機器上註冊
GitHub 的自架執行機器（self-hosted runner），並把 `deploy.yml` 裡 build 工作的 `runs-on` 改成
`self-hosted`；或是在國內機器上用排程執行 `npm run update-data`，再把 `public/data/hospitals.json`
提交推送（此時請把 `deploy.yml` 的 `schedule` 區段移除）。

使用 GitHub Pages 需注意：免費方案的 Pages 需要公開的 repo；Pages 無法自訂 HTTP 標頭，
因此上方 IIS 一節建議的標頭中，只有 `index.html` 內 `<meta>` 能表達的部分會生效（`frame-ancestors` 不會）；
Pages 對所有檔案固定快取約 10 分鐘，資料更新後最多 10 分鐘才會被使用者看到；使用自訂網域時，請在
Settings → Secrets and variables → Actions → Variables 新增 `PAGES_URL`（例如 `https://vaxmap.example.tw`），
供每月快照流程使用。

## 建議的正式資料串接方式

現站的 `POST /Home/GetHospitalData` API 有以下限制，使其不適合前端直接呼叫：

- 每次呼叫只回傳 **20 筆**院所資料，要取得全部約 4,660 筆需要約 **280 次**分頁呼叫；
- 每次回應約 390 KB，且**內含伺服器端算繪好的 HTML**（不是乾淨的資料格式），換算下來抓完全量
  資料要傳輸接近 **97 MB**；
- 需要帶 `X-Requested-With: XMLHttpRequest` 標頭才會被接受；
- **沒有開放 CORS**，瀏覽器端無法跨網域直接呼叫。

**建議做法**：在後端（現站所在的伺服器或有權限存取來源資料庫的環境）建立一個**排程工作**，
每隔 N 分鐘（例如 5–15 分鐘，依資料更新頻率決定）直接從資料庫匯出並輸出符合
`docs/DATA_SCHEMA.md` 格式的 `hospitals.json`（正規化後約 1.2 MB，gzip 壓縮後約 240 KB），
發布到靜態檔案主機或 CDN。

另一個可行方案是由現站團隊新增一支**回傳全量資料的 JSON 端點**（分頁或不分頁皆可，但需開放
CORS 或部署在同網域），效果等同於上述排程匯出。

無論採用哪一種，前端只需要更換 `public/js/data-source.js` 這一個檔案（把 `fetch('./data/hospitals.json')`
換成呼叫新端點，並確保回傳的物件仍符合 `{ meta, vaccines, groups, hospitals }` 結構），
其餘程式碼完全不需異動。

## 資安

**第三方函式庫**（2026-09-21 檢查）：Leaflet 1.9.4 與 leaflet.markercluster 1.5.3 都是 npm 上最新的穩定版
（Leaflet 2.0 仍在 alpha，且改為純 ESM、移除全域 `L`，markercluster 尚不相容，暫不建議升級）。
`public/vendor/` 內的檔案與 npm 套件逐位元組相同，`npm run verify-vendor` 會以 sha256 驗證，`npm test` 也包含這項檢查。
`npm audit` 為 0 項。Leaflet 有一則尚無修補版本的通報 CVE-2025-69993（`bindPopup()` 會把傳入字串當 HTML 渲染，
維護者認定為文件記載的既有行為）；本站**沒有使用** popup／tooltip，所有資料字串都以 `textContent` 或屬性寫入，不受影響。

**前端防護**：`index.html` 的 CSP 不允許行內指令碼與樣式，只開放兩個底圖網域的圖片；另外啟用 Trusted Types
（`public/js/trusted-types.js`），只放行 Leaflet 與 `map.js` 的固定 HTML 字串——日後若修改圖釘的 HTML 或底圖的
版權字串，必須同步更新該檔的允許清單，否則 e2e 測試會因主控台錯誤而失敗。外部連結一律 `rel="noopener noreferrer"`，
預約網址只接受 https。使用者的定位只存在記憶體，不會寫入網址、儲存空間或任何請求（但放大地圖時，底圖伺服器可由圖磚請求推知大略區域）。

**資料管線**：來源網站的回應一律視為不可信。`scripts/sanitize.mjs` 以白名單重建每個要發布的欄位
（去除控制字元與雙向文字控制字元、限制長度、數值範圍與座標範圍檢查、電話與網址格式檢查），
`normalize.mjs` 與 `keep-live-data.mjs` 都以它作為最後一關；`harvest.mjs` 對單次回應、總傳輸量、單頁筆數與總筆數都設有上限。
相關測試在 `tests/security.test.mjs`。

**GitHub Actions**：各工作採最小權限（只有 deploy 有 `pages: write`，只有每月快照有 `contents: write`），
所有 action 釘選到完整 commit SHA，`${{ }}` 一律經由 `env:` 傳入而不直接寫進指令，checkout 不保留憑證。
升級 action 版本時請重新查證並更新 SHA。建議到 repo 的 Settings → Environments → github-pages，確認只允許 `main` 分支部署。

**GitHub Pages 的限制**：無法設定 HTTP 標頭，因此沒有 `frame-ancestors`／`X-Frame-Options`（防止被別的網站嵌入）。
本站沒有登入狀態或可被誘導點擊的敏感操作，風險低；若改部署到可設定標頭的主機，請補上。

## 底圖

預設底圖為 OpenStreetMap 官方圖磚，連續載入失敗時自動改用國土測繪中心（NLSC）「通用版電子地圖」
WMTS 圖磚。順序由 `public/js/map.js` 開頭的 `TILES` 陣列決定（第一個是預設，其後依序備援）；
`index.html` 的 CSP `img-src` 也對應開放了這兩個網域。測試時可在網址加 `?tiles=nlsc` 直接使用備援底圖，
或加 `?tiles=fail` 模擬預設底圖失效。**正式上線前**請務必：

- 確認 [OSM 圖磚使用政策](https://operations.osmfoundation.org/policies/tiles/)。OSM 官方圖磚伺服器
  由捐款維運、不保證可用性，政策明訂大流量用途不得依賴它，違反時可能被無預警封鎖。
  原型與低流量展示沒有問題；若要作為正式對外服務的預設底圖，建議改用自建圖磚或商業圖磚供應商
  （MapTiler、Stadia、Mapbox 等，多數仍以 OSM 資料製圖），或把順序換回 NLSC 優先；
- 確認 NLSC 電子地圖的[使用規範](https://maps.nlsc.gov.tw/)是否需要申請或標示來源。

## 瀏覽器支援

採用現代瀏覽器 API（`fetch`、ES modules、CSS Grid、`<details>`、`prefers-color-scheme`），
目標為近兩年內的 Chrome、Edge、Firefox、Safari（含 iOS Safari）。不支援 IE11，也未做相關 polyfill。

## 已知限制

- 資料為單一時間點快照，非即時；接種前請務必先電洽院所確認。
- 看診時段以中央健保署資料換算的位元遮罩表示上午／下午／晚上，僅為近似時段，非精確門診表。
- 少數院所地址無法自動判斷縣市／行政區、少數院所名稱／地址仍含半形「台」字未正規化為「臺」
  （上游擷取或 `normalize.mjs` 轉換的已知資料品質問題，詳見 `tests/data.test.mjs` 內標記為
  `KNOWN ISSUE` 的測試與其註解）。
- 定位、地圖範圍等狀態不會寫入可分享的網址（URL hash）中，僅篩選條件與所選院所會分享。
- 尚未實測 IE／舊版 Android WebView；地圖圖磚在網路不穩定環境下可能載入失敗（已有 NLSC 備援）。

## 與現站的差異

| 現站問題 | 本原型的作法 |
|---|---|
| 進站需先關閉阻擋式公告視窗 | 公告改為可關閉的頁首橫幅（banner），不阻擋操作 |
| 資料以「每 20 筆」同步 XHR 分批索取 | 一次載入單一 JSON（約 240 KB gzip），前端在本地端篩選／排序 |
| 地圖圖釘只顯示「有看診／休診」 | 圖釘以形狀＋顏色同時表達「今日有看診」與「所選品項是否有庫存」三種狀態 |
| 沒有清單，只能點地圖上的圖釘 | 提供依距離排序的院所清單，與地圖同步互動 |
| 篩選為單選式彈出視窗 | 篩選改為可複選的 chips（品項、群組、地區、只看有庫存、今日有看診等） |
| 庫存僅顯示「有／無」 | 直接顯示實際庫存數量 |
| 沒有導航功能 | 詳細頁提供撥打電話（`tel:`）與 Google 地圖路線連結 |
| 篩選狀態無法分享 | 篩選條件與選取院所會編碼進網址（URL hash），可直接分享、書籤、上一頁/下一頁還原 |
