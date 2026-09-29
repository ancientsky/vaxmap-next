# 接種資訊專區資料管線（擷取 → 翻譯 → 檢查 → 發布）

本文件說明 `public/data/info/<lang>.json` 是怎麼產生、怎麼更新、出錯時怎麼處理。檔案格式契約見
[`INFO_SCHEMA.md`](INFO_SCHEMA.md)；院所資料的管線見 README「資料如何更新」與 [`HARVEST.md`](HARVEST.md)。

## 概觀

```
疾管署「115年度左流右新護肺顧心 疫苗接種專區」頁面（www.cdc.gov.tw/Category/MPage/S_ZLz0yyc2lAQ9TStMB0uA）
  │
  │ scripts/harvest-info.mjs      抓取 → 解析每張 div.card → 白名單清理 → 計算每個區塊的雜湊
  ▼
data/info/source.json             繁中原文（結構化），meta.fetchedAt／changedAt
  │
  │ scripts/translate-info.mjs    只把「雜湊不在快取裡」的區塊送 Anthropic API 翻譯（每區塊×每語言一個請求）
  │                               結果快取在 data/info/translations.json（鍵：區塊雜湊＋語言）
  ▼
public/data/info/<lang>.json      8 個語言檔（zh-Hant、en、ja、ko、id、vi、th、tl），前端只讀這些檔
  │
  │ scripts/sanitize-info.mjs --check   嚴格驗證（型別、長度、網址白名單、無 < >、ISO 日期）
  ▼
data 分支 info/*.json（含 source.json 與 translations.json）→ deploy.yml 取用並再驗證一次 → GitHub Pages
```

指令：

| 指令 | 作用 |
|---|---|
| `npm run harvest-info` | 抓取＋解析，寫 `data/info/source.json`；最後一行印 `changed` 或 `unchanged` |
| `npm run translate-info` | 翻譯缺少的區塊，輸出 8 個語言檔（沒有金鑰也會輸出，外語檔為原文） |
| `npm run update-info` | 以上兩步＋驗證全部檔案 |
| `node scripts/harvest-info.mjs --file 某頁.html` | 解析本機存下的頁面（離線除錯用） |
| `node scripts/sanitize-info.mjs --check 檔案…` | 驗證任意接種資訊檔，不合格結束代碼 1 |
| `node scripts/translate-info.mjs --export 檔案` ／ `--import <lang> 檔案` | 離線／人工翻譯的匯出與匯入（見下方「離線／人工翻譯」） |

每日排程（國內更新機器，臺北時間 05:30、12:30）由 `scripts/publish-data.sh` 在擷取院所資料之後接著執行，
兩者互不影響：其中一項失敗時，另一項照常發布，失敗的那項沿用 `data` 分支上一版。

## 擷取與解析（`harvest-info.mjs`）

- **不引入第三方套件**：以 Node 內建功能寫了一個小型、容錯的 HTML 斷詞＋建樹器（處理未閉合的 `<p>`／`<li>`／`<td>`、
  註解、實體字元）。只讀 `href`、`class`、`id`、`style`、`title`、`color` 六種屬性；`<script>`、`<style>`、`<iframe>`、
  `<svg>`、`<object>`、表單、圖片整段丟棄，所以 `on*` 事件屬性與內嵌程式不可能進入輸出。
- **每張 `div.card` 一個區塊**：`id` 取自 `collapseOne<數字>`；標題取 `.card-title .word`；「最後更新日期 2026/9/23」轉成
  `2026-09-23`；`div.download` 依小標題分成「連結」（`links`）與「附件」（`files`，副檔名取自檔名，文字去掉副檔名），
  紅字 `New` 標記轉為 `isNew`；同一區塊重複的連結只留第一筆。
- **正文轉成區塊**：`<br>` 與區塊元素斷行；整行粗體且不超過 40 字 → 小標題（`h`，去掉開頭的 ▲）；整行紅字 → `note`；
  緊接在表格前的小標題改為表格的 `caption`（例如「2026/10/01起 第一階段對象」）；清單攤平為字串陣列，巢狀層級另存在
  選填的 `levels`（見下方「與 INFO_SCHEMA 的補充」）；文字中的裸網址轉為連結；「說明文字」下一行是裸網址時合併為一個連結段落。
- **表格符號統一**：來源用 `●`（有）／`✖`（無），輸出統一為 `✓`／`✗`（`○` 保留）；「●另納入…」→「✓ 另納入…」。
- **主題代碼 `key`**：依標題關鍵字比對（健康幣→`coins`、接種對象→`eligibility`、哪裡可以接種／接種地點→`where`、
  注意事項／接種須知→`precautions`、廠牌→`brands`、常見問答／Q&A→`faq`、新聞稿→`news`、衛教／宣導→`education`，其餘 `other`）。
- **網址白名單**（與 `INFO_SCHEMA.md` 的「連結主機允許清單」一致，定義在 `sanitize-info.mjs` 的 `INFO_ALLOWED_HOSTS`）：只留 `https`、
  無帳密、無連接埠，且主機為 `gov.tw`、`*.gov.tw`、`*.gov.taipei`（臺北市政府）、`www.youtube.com` 或 `youtu.be`（疾管署官方影片）的連結
  （相對網址以 `https://www.cdc.gov.tw/` 解析）。短網址（`reurl.cc`）、`docs.google.com` 等不在清單內：段落連結改為純文字（文字保留），
  `links`／`files` 中的則整筆略過；執行時會列出允許清單與被略過的主機。
- **雜湊**：`sha256` 對象是「要翻譯的內容」——標題、各區塊的文字與結構、連結／附件的文字；**不含** `href`、`updated`、`isNew`。
  所以只改網址或 New 標記不會觸發重新翻譯，但仍算內容變動（會重新部署）。
- **`changedAt`**：第一次執行時為各區塊最後更新日期的最大值（臺北時間當天 00:00）；之後只要任一區塊內容（含網址、New 標記、
  區塊增減或順序）與上一版 `source.json` 不同，就設為本次抓取時間；完全相同則沿用上一版的值並印出 `unchanged`。
  `fetchedAt` 每次成功抓取都會更新（新鮮度檢查看的是它），所以來源頁面幾天沒改不會被誤判為「停止更新」。
- **保險絲**：單次回應上限 3 MB（正常約 270 KB）、逾時 30 秒、最多試 3 次、HTML 節點上限 20 萬、只接受 https；
  解析出的區塊少於 5 個（`INFO_MIN_SECTIONS`）或找不到頁面標題 → 視為頁面改版，**不寫任何檔案**並以結束代碼 1 失敗。

2026-09-29 實際抓取結果：10 個區塊——`coins`（3 段正文、1 連結）、`eligibility`（2 張表：第一階段 11 列、第二階段 1 列；1 附件）、
`where`（4 個小標題＋7 段，段落內 43 個連結：流感地圖 1 個與流感／新冠兩份縣市衛生局清單）、`precautions`（3 個 PDF）、`brands`（2 個小標題、1 段、2 個清單）、`education`（2 連結、4 附件）、
`news`（6 則，2 則 New）、`faq`（2 個連結段落）、`education`（其他衛教推廣資源：2 支 YouTube 影片連結）、`other`（2 連結）。
被略過的連結只有 2 個：reurl.cc ×1（彰化縣流感清單，改為純文字）、docs.google.com ×1（新竹市新冠清單，改為純文字）；
臺北市兩份清單的連結（health.gov.taipei）保留。

## 翻譯（`translate-info.mjs`）

- **模型**：預設 `claude-sonnet-5-5`（Claude Sonnet 5.5，2026-09 Anthropic 文件列為速度與能力的最佳平衡；價格每百萬 token
  輸入 US$2／輸出 US$10）。以環境變數 `TRANSLATE_MODEL` 更換；`TRANSLATE_EFFORT`（預設 `low`）對應 API 的 `output_config.effort`。
  以 `fetch` 直接呼叫 Messages API（不使用 SDK，沒有新增相依套件）。
- **送出什麼**：每個區塊×每種語言一個請求。使用者訊息是區塊的「投影」JSON（只有 `title`、`blocks` 的文字與 `type`、
  `links`／`files` 的 `text`；**不含網址**），系統提示包含目標語言、`docs/I18N.md` 的「醫療用語對照」表（執行時讀取）、
  品牌對照（高端 Medigen、國光 Adimmune、台灣東洋 TTY Biopharm、賽諾菲 Sanofi、GSK、莫德納 Moderna、Novavax／Nuvaxovid 保留）、
  健康幣＝Health Coins、疫苗加值金＝vaccine bonus、公費＝publicly funded（不譯為 free）、「左流右新」口號的譯法、
  中文疫苗商品名（安定伏、福喜健…）保留原文不自創外文名，以及「只回傳相同結構的 JSON」的規則。頁面標題另外當作一個小單位翻譯。
- **結構驗證**（`checkShape`）：鍵、陣列長度（區塊數、runs、items、rows、儲存格、links、files）與 `type` 必須完全相同；
  只含符號的儲存格（✓ ✗ ○）原樣保留、✓ 開頭的儲存格保留 ✓；原文中 2 位以上的數字（年齡、金額、劑量、民國年、版本碼；
  「12月1日」這類月／日數字除外）必須出現在譯文；原文中的網址必須保留；不得含 `<` `>`。不合格 → 把錯誤訊息回給模型重試一次；
  仍不合格 → 該區塊保留原文（`translated:false`），下次執行會再試。
- **合併**：譯文只替換文字；`href`、`id`、`updated`、`isNew`、`ext`、`levels`、`hash` 一律取自原文。輸出前整份再經 `sanitize-info` 清理。
- **快取**：`data/info/translations.json`，`{ "<區塊雜湊>": { "en": { title, blocks, links, files, model, at }, … } }`。
  讀取時逐筆驗證形狀，不符就當作沒有；來源已不存在的雜湊會被清掉。內容沒變的區塊永遠不會重送。
- **保險絲**：單一區塊原文超過 20,000 字不送（`TRANSLATE_MAX_CHARS`）；同時 3 個請求（`TRANSLATE_CONCURRENCY`）；整次執行上限
  30 分鐘（`TRANSLATE_MAX_MINUTES`）；429／5xx 依 `retry-after` 退避重試；401／403（金鑰錯誤）、400／404（模型名稱錯誤）立即停止
  其餘請求。每個請求與總計的 token 用量、估計費用都會印在記錄中。
- **沒有金鑰**：不呼叫 API，8 個檔照樣產生；外語檔的區塊帶繁中原文、`translated:false`，`meta.translation` 為 `"partial"`；
  結束代碼 0。前端據此顯示「此段尚未翻譯，以下為原文」。
- **離線測試**：`TRANSLATE_ENDPOINT` 可指向本機模擬伺服器（`tests/mock-translate.mjs`，回傳相同結構並在每段文字前加 `[xx] `）；
  只接受 https 或 `http://127.0.0.1`／`localhost`。

## 費用估算

以 2026-09-29 實際頁面計算（沒有金鑰無法呼叫 token 計數 API，以下以字元數估算：中文約 1 token／字、ASCII 約 3.5 字元／token；
系統提示約 1,400 tokens，未計入提示快取折扣）：

| 情境 | 請求數 | 輸入 tokens | 輸出 tokens | 費用（Sonnet 5.5） |
|---|---|---|---|---|
| 頁面沒有變動（大多數日子） | 0 | 0 | 0 | US$0 |
| 典型變動：一個區塊改了（例如「最新新聞稿資訊」多一則），×7 種語言 | 7 | 約 12,000 | 約 3,200 | 約 US$0.06 |
| 最大的區塊改了（「哪裡可以接種」，含兩份縣市清單），×7 | 7 | 約 16,000 | 約 7,500 | 約 US$0.11 |
| 第一次全部翻譯（11 個單位×7 種語言） | 77 | 約 127,000 | 約 28,000 | 約 US$0.55 |

原文總量約 2,000 個中文字＋2,900 個結構字元；輸出以英文約 1.2 token／原文字、泰文約 2.5 token／原文字估算。
驗證失敗重試會使該區塊費用加倍。即使來源每天都改一個區塊，每月也在 US$2 以內。

## 常見狀況與處理

| 狀況 | 結果 | 處理 |
|---|---|---|
| 疾管署頁面連不上、逾時、非 200 | `harvest-info` 失敗、不寫檔；`publish-data.sh` 沿用 data 分支上一版的接種資訊，院所資料照常發布，結束代碼 1 | 通常下一次排程就恢復。超過 36 小時 `freshness.yml` 會出現警告 |
| 頁面改版（區塊 < 5 或找不到標題） | 同上 | 用瀏覽器存下頁面 → `node scripts/harvest-info.mjs --file 頁面.html` 看解析結果 → 修改解析器並把新頁面加進 `tests/fixtures/` |
| 某些連結消失 | 主機不在白名單（例如短網址 reurl.cc、docs.google.com） | 如需開放新主機，同時修改 `sanitize-info.mjs` 的 `INFO_ALLOWED_HOSTS`、`INFO_SCHEMA.md` 與前端的允許清單（`tests/info.test.mjs` 有允許／拒絕的範例） |
| 金鑰未設定或無效 | 外語檔為原文（partial）；記錄中有「翻譯中止」 | 編輯更新機器上的 `~/.config/vaxmap-updater/env` |
| 某區塊一直翻譯失敗（驗證不過） | 該區塊維持原文；記錄中有「結構驗證未通過」與原因 | 多半是數字被改寫；可改用較強的模型（`TRANSLATE_MODEL`），或調整 `buildSystemPrompt` |
| 譯文品質有問題 | — | 見下節「強制重新翻譯」 |
| 翻譯快取損壞 | 損壞的項目視為沒有，會重新翻譯 | 不需處理；或刪掉 data 分支上的 `info/translations.json` 讓它全部重翻（約 US$0.55） |

## 強制重新翻譯某個區塊

在有金鑰的機器（更新機器的專用資料夾 `~/.local/share/vaxmap-updater`，或您自己的資料夾）：

```bash
# 先取回 data 分支上的原文與快取
git fetch origin data && git show FETCH_HEAD:info/source.json > data/info/source.json \
  && git show FETCH_HEAD:info/translations.json > data/info/translations.json
export ANTHROPIC_API_KEY=…                                   # 或寫在 ~/.config/vaxmap-updater/env
node scripts/translate-info.mjs --force 103106 --lang en,ja   # 區塊 id（見 source.json 的 sections[].id）
node scripts/translate-info.mjs --force title                 # 頁面標題
node scripts/translate-info.mjs --force all                   # 全部（約 US$0.55）
```

之後執行 `npm run publish-data`（會重新擷取並推送），或等下一次排程。注意：排程每次都從 data 分支取回快取，
所以要把重新翻譯的結果推送到 data 分支才會保留——最簡單的作法是在更新機器上執行
`systemctl --user start vaxmap-updater.service` 之前，先在專用資料夾以 `--force` 跑一次（快取會被 publish-data.sh 一起推送）。
若只是想讓排程在下一次自動重翻某區塊，也可以直接從 data 分支的 `info/translations.json` 刪除該區塊雜湊的該語言項目。

## 離線／人工翻譯（匯出 → 翻譯 → 匯入）

沒有 API 金鑰、或想由人工（或其他工具）翻譯時：

```bash
node scripts/translate-info.mjs --export data/info/projections.zh.json   # 匯出繁中翻譯投影（就是送 API 的內容，不含網址）
# 複製成 vi.json 之類的檔案，只翻譯文字欄位後：
node scripts/translate-info.mjs --import vi vi.json                     # 逐區塊驗證 → 存入快取（source:"manual"）→ 重建 public/data/info/*.json
```

匯出檔格式：`{ "title": { "hash", "title" }, "sections": [ { "id", "key", "hash", "title", "blocks", "links", "files" } ] }`。
匯入時每個區塊的 `hash` 必須與**目前**的 `data/info/source.json` 相同（原文在翻譯期間更新過的區塊會被略過並警告，需重新匯出該區塊），
結構必須與原文完全相同（驗證規則同機器翻譯），不合格的區塊略過，其他照常匯入。匯入不呼叫 API。

**給譯者的規則**

- 只翻譯這些欄位的字串：`title`、`blocks[].runs[].text`（段落）、`blocks[].text`（`h` 小標題、`note` 備註）、`blocks[].items[]`（清單）、
  `blocks[].caption`、`blocks[].head[]`、`blocks[].rows[][]`（表格）、`links[].text`、`files[].text`。
- 不可修改：`id`、`key`、`hash`、`type`；不可新增或刪除任何欄位。
- 所有陣列長度不變：區塊數與順序、每段的 `runs` 數、清單項目數、表格列數與每列儲存格數、`links`／`files` 筆數。
- 一段的 `runs` 是同一句話的連續片段（其中某些是連結文字，網址不在檔案中、會自動套回）：譯文依序填回同樣數目的片段，
  片段交界需要空格時請把空格放在片段內。
- 只有符號的儲存格（`✓`、`✗`、`○`）原樣保留；以 `✓` 開頭的儲存格保留開頭的 `✓`，後面的說明文字可翻譯。
- 數字以阿拉伯數字原樣保留（年齡、幣值、劑量 0.5 mL、民國年 115、版本碼 1150707、斜線日期 2026/10/01）；「12月1日」這類月日可寫成當地格式。
  小數點可用當地的小數逗號。
- 文字中不可有 `<`、`>`，不要加 HTML 或 Markdown；原文中出現的網址（文字形式）要保留。
- 詞彙依本文件「翻譯」一節與 `docs/I18N.md` 的醫療用語對照（品牌名、健康幣、公費＝publicly funded 等）。

**保留人工譯文**：匯入的項目存在 `data/info/translations.json`。要讓每日排程使用，請把這個檔案提交到 `main`：
`publish-data.sh` 會把 repo 內的快取併入 data 分支上的快取，`source:"manual"` 的項目優先於機器翻譯。原文之後若再改動，
該區塊的雜湊改變，人工譯文不再適用（有金鑰時改由機器翻譯，否則顯示原文），需重新匯出、翻譯、匯入。

## 新增一種語言

1. 前端：依 `docs/I18N.md`「新增語系」完成（`SUPPORTED_LANGS`、`public/i18n/<lang>.json`、語言選單）。
2. `scripts/sanitize-info.mjs`：`INFO_LANGS` 加入代碼（`tests/info.test.mjs` 會檢查它與 `SUPPORTED_LANGS` 一致）。
3. `scripts/translate-info.mjs`：`LANG_NAMES` 加入「英文名稱（本地名稱）」，必要時在 `buildSystemPrompt` 加該語言的特殊規則。
4. `scripts/publish-data.sh`（比對變動的語言清單）與 `.github/workflows/deploy.yml`（從 data 分支取檔的語言清單）加入代碼。
5. `npm test`；下一次排程會自動翻譯新語言的所有區塊（約 US$0.08／語言）。

## 與 INFO_SCHEMA 的補充

- `list` 區塊可有選填的 `levels`（與 `items` 等長的整數陣列，0 = 最外層），表示來源的巢狀清單／縮排；全部為 0 時省略。
- `hash` 涵蓋的是翻譯投影（不含 `href`、`isNew`），不是整個區塊。
- 表格儲存格：來源的 `●`／`✖` 已統一為 `✓`／`✗`。
- `files[].text` 不含副檔名（副檔名在 `ext`）；翻譯後檔名中的「英文」等字樣會被譯掉，前端若依檔名判斷語言，請以 zh-Hant 檔的
  同一筆（相同 `href`）判斷。
- 區塊內容可能為空（例如來源某張卡片的連結全部不在白名單），前端可略過沒有 `blocks`、`links`、`files` 的區塊。
