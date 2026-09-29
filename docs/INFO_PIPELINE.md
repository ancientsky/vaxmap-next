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
  │ scripts/translate-info.mjs    只把「雜湊不在快取裡」的區塊送 Google Gemini API 翻譯（每區塊×每語言一個請求）
  │                               結果快取在 data/info/translations.json（鍵：區塊雜湊＋語言）
  ▼
public/data/info/<lang>.json      8 個語言檔（zh-Hant、en、ja、ko、id、vi、th、tl），前端只讀這些檔
  │
  │ scripts/sanitize-info.mjs --check   嚴格驗證（型別、長度、網址白名單、無 < >、ISO 日期）
  ▼
data 分支 info/*.json（含 source.json 與 translations.json；scripts/push-data-branch.sh 寫入）
  → deploy.yml 取用並再驗證一次 → GitHub Pages
```

以上全部在 **GitHub Actions** 上執行（`.github/workflows/info-update.yml`，每天臺北時間 06:00）：`www.cdc.gov.tw`
境外連得到（2026-09-29 實測海外主機 HTTP 200；不接受境外連線的只有 `vaxmap.cdc.gov.tw`），所以接種資訊不需要國內機器，
翻譯金鑰也只放在 GitHub。國內機器的 `publish-data.sh` 只負責院所資料。

指令：

| 指令 | 作用 |
|---|---|
| `npm run harvest-info` | 抓取＋解析，寫 `data/info/source.json`；最後一行印 `changed` 或 `unchanged` |
| `npm run translate-info` | 翻譯缺少的區塊，輸出 8 個語言檔（沒有金鑰也會輸出，外語檔為原文） |
| `npm run update-info` | 以上兩步＋驗證全部檔案（在 repo 的 `data/info`、`public/data/info` 執行，不推送） |
| `scripts/info-update.sh <階段>` | workflow 的各個 step：`prepare`、`harvest`、`translate`、`check`、`publish`（或 `all` 依序全部） |
| `scripts/push-data-branch.sh -C <資料夾> 檔案…` | 把檔案疊到 data 分支（兩個寫入者共用，見下方「data 分支的兩個寫入者」） |
| `node scripts/harvest-info.mjs --file 某頁.html` | 解析本機存下的頁面（離線除錯用） |
| `node scripts/sanitize-info.mjs --check 檔案…` | 驗證任意接種資訊檔，不合格結束代碼 1 |
| `node scripts/translate-info.mjs --export 檔案` ／ `--import <lang> 檔案` | 離線／人工翻譯的匯出與匯入（見下方「離線／人工翻譯」） |

## 每日排程（`.github/workflows/info-update.yml`）

每天臺北時間 06:00（`cron: '0 22 * * *'`，UTC）與手動觸發時執行，每個 step 是 `scripts/info-update.sh` 的一個階段，
各階段以工作資料夾（`$RUNNER_TEMP/info-work`）交接：

| step | 做什麼 | 拿得到的機密 |
|---|---|---|
| `prepare` | 取回 data 分支上一版（`info/source.json`、`info/translations.json`、8 個語言檔），再以 `translate-info.mjs --merge-cache` 併入 repo（`main`）內的 `data/info/translations.json`（`source:"manual"` 的人工譯文優先，其餘只補缺）。連不上 repo 時失敗（不會誤當成第一次執行而遺失快取） | 無 |
| `harvest` | `harvest-info.mjs`；最後一行 `changed`／`unchanged`。失敗（連不上、改版）→ 整個執行失敗、GitHub 寄信給 repo 擁有者，data 分支維持上一版 | 無 |
| `translate` | `translate-info.mjs`，只翻譯快取裡沒有的區塊。**來源 `unchanged`、上一版 7 種語言都已完整翻譯、且沒有 force 時，不把金鑰交給翻譯程式**（保證 0 次 API 呼叫），只以快取重建語言檔，讓 `meta.fetchedAt`（網站上的「同步時間」）更新 | `GEMINI_API_KEY`（只有這一步） |
| `check` | `sanitize-info.mjs --check` 驗證 `source.json` 與 8 個語言檔 | 無 |
| `publish` | `push-data-branch.sh` 把 `info/*.json` 疊到 data 分支（`hospitals.json` 不動）；語言檔有「會影響畫面」的變動（忽略 `fetchedAt`）或手動 force 時 `gh workflow run deploy.yml` | `GITHUB_TOKEN`（只有這一步） |

「`unchanged` 就提早結束」的實際作法：不呼叫翻譯 API、不觸發部署，但**仍然推送**更新過 `fetchedAt` 的檔案——
`freshness.yml` 看的是 data 分支 `info/source.json` 的 `fetchedAt`，如果來源沒變就完全不推送，疾管署頁面幾天沒改就會被誤報為停止更新；
網站上的「同步時間」也會停在上次內容變動時。data 分支只有一個提交，多推一次不會讓 repo 變大。
例外：上一版有任何語言標示 `partial`（先前沒有金鑰、配額用完或驗證失敗），來源沒變也會補翻缺少的區塊。

### 手動觸發／強制重翻

GitHub repo → Actions →「接種資訊更新」→ **Run workflow**，兩個輸入欄：

| `force` | 效果 |
|---|---|
| 留白 | 與排程相同（例如剛設定好金鑰，想立刻補翻） |
| `deploy` | 來源沒變也觸發部署 |
| `all` | 丟棄全部翻譯快取、全部重翻（約 US$0.11），並觸發部署 |
| `title` | 只重翻頁面標題 |
| 區塊 id（例如 `103106`，見 data 分支 `info/source.json` 的 `sections[].id`） | 只重翻這個區塊 |

`langs`（選填）：搭配 `all`／`title`／區塊 id，只重翻這些語言（例如 `en,ja`）；留白＝全部 7 種。兩個輸入都以白名單檢查
（`force` 只接受上表的值、`langs` 只接受「兩個小寫字母,…」），其他內容一律拒絕。

### data 分支的兩個寫入者

data 分支現在由兩方更新：國內機器的 `publish-data.sh`（`hospitals.json`，每天 05:30、12:30）與這個 workflow（`info/*.json`）。
兩者都只呼叫 `scripts/push-data-branch.sh`：

1. 取回 data 分支目前的提交（sha S）與它的檔案樹；
2. 只把自己負責的檔案疊到那棵樹上，其他檔案原樣保留；
3. 以整棵樹建立**一個沒有上一代的提交**（data 分支永遠只有一個提交，repo 不會因每天更新而變大）；
4. `git push --force-with-lease=refs/heads/data:S`——只有遠端仍是 S 才覆蓋。若另一方剛好在這之間推送，
   推送被拒 → 重新取回、重新疊加、再推，最多重試 3 次；仍失敗就結束代碼 1（不會蓋掉對方的資料，下一次排程再試）。

`tests/data-branch.test.mjs` 以本機 bare repo 模擬另一個寫入者在推送前一刻插隊（git pre-push hook），驗證雙方的檔案都保留。
workflow 另設 `concurrency: data-branch`，避免同一 repo 內的執行彼此重疊。

注意：GitHub 的 `contents: write` 權限無法限定在單一分支（分支保護規則也無法把 `GITHUB_TOKEN` 限制成「只能推 data」），
「只寫 data 分支」是由程序（這支腳本）保證，而不是由 GitHub 保證。建議在 Settings → Rules 為 `main` 設定分支保護
（要求 pull request），讓這個權杖至少不能直接改 `main`。

### 在本機跑一次（重現 workflow）

```bash
export INFO_WORK_DIR=/tmp/info-work DATA_REPO_URL=https://github.com/<帳號>/<repo> SKIP_DEPLOY_TRIGGER=1
scripts/info-update.sh prepare && scripts/info-update.sh harvest
GEMINI_API_KEY=… scripts/info-update.sh translate     # 金鑰只給這一步
scripts/info-update.sh check
ls /tmp/info-work/pub                                # 檢查結果；確定要推送才執行 publish（需要 data 分支的推送權限）
```

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

- **翻譯服務**：`TRANSLATE_PROVIDER`＝`gemini`（預設）或 `anthropic`。兩者都以 `fetch` 直接呼叫（不使用 SDK，沒有新增相依套件），
  提示詞、結構驗證、重試、快取完全相同；快取項目記錄產生它的 `model`。
- **Gemini（預設）**：模型 `gemini-3.5-flash-lite`（2026-09-29 查 Google AI for Developers 的模型頁：「Gemini 3.5 Flash-Lite —
  Our fastest, most cost-effective 3.5 model for high-throughput execution. **Stable**」，代碼 `gemini-3.5-flash-lite`，2026-07 更新；
  價格頁付費層級每百萬 token 輸入 US$0.30／輸出 US$2.50，免費層級不收費）。請求：
  `POST https://generativelanguage.googleapis.com/v1beta/models/<模型>:generateContent`，金鑰只放在 **`x-goog-api-key` 標頭**
  （不用 `?key=`，網址可能出現在代理或錯誤記錄中；`TRANSLATE_ENDPOINT` 含查詢字串或帳密會被拒絕），
  `systemInstruction`＝系統提示（含詞彙表），`contents`＝區塊 JSON（重試時加上模型上一次的回覆〔role `model`〕與驗證錯誤），
  `generationConfig.responseMimeType: "application/json"`、`maxOutputTokens` 依原文長度計算。
  回應取 `candidates[0].content.parts[].text`（略過 `thought` 部分）；`finishReason` 為 `MAX_TOKENS` 視為截斷、`SAFETY` 等其他值視為未完成，都走「重試一次」。
  用量取 `usageMetadata.promptTokenCount`（輸入）與 `candidatesTokenCount`＋`thoughtsTokenCount`（輸出，思考 token 以輸出價計費）。
- **溫度**：預設**不送** `temperature`（使用模型預設值）。Google 的 Gemini 3 說明寫明「For all Gemini 3 models, we strongly recommend keeping
  the temperature parameter at its default value of 1.0」，調低可能造成重複迴圈或品質下降；翻譯的一致性由結構驗證與快取保證（同一區塊不會重翻）。
  需要時以 `TRANSLATE_TEMPERATURE`（0–2）指定。
- **Anthropic（備用）**：`TRANSLATE_PROVIDER=anthropic`、`ANTHROPIC_API_KEY`，預設模型 `claude-sonnet-5-5`（每百萬 token 輸入 US$2／輸出 US$10），
  `TRANSLATE_EFFORT`（預設 `low`）對應 `output_config.effort`，系統提示使用提示快取。
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
  30 分鐘（`TRANSLATE_MAX_MINUTES`）。錯誤處理：
  - **429（速率限制）／5xx**：每個請求最多試 5 次，等待時間依序取 `Retry-After` 標頭、Gemini 錯誤內容的 `RetryInfo.retryDelay`，
    否則指數退避（2、4、8、16 秒，加少量隨機）；記錄中印「N 秒後重試」。
  - **連續 5 次都是 429**：視為配額用完（例如每日請求數 RPD，太平洋時間午夜重置，或帳單上限）→ 停止其餘請求，已翻好的照常保存，
    未翻的留待下次（隔天來源沒變也會補翻）。
  - **401／403，或 Gemini 的 400 `API_KEY_INVALID`**（金鑰錯誤、停用、沒有權限）：立即停止其餘請求，訊息提示檢查 `GEMINI_API_KEY`
    （在 GitHub 上會加註「GitHub repo 的 Actions secret」）。**400／404**（模型名稱錯誤）：立即停止並提示檢查 `TRANSLATE_MODEL`。
  - 以上情況都不會讓這一步失敗：8 個語言檔照樣輸出（未翻的區塊帶原文），`freshness.yml` 會以 notice 提示英文版有未翻譯區塊。
  - 金鑰不會出現在記錄中：只經由環境變數讀取，不放進網址，任何要印出的錯誤訊息都會先把金鑰字串遮蔽。
  每個請求與總計的 token 用量、估計費用都會印在記錄中。
- **沒有金鑰**：不呼叫 API，8 個檔照樣產生；外語檔的區塊帶繁中原文、`translated:false`，`meta.translation` 為 `"partial"`；
  結束代碼 0。前端據此顯示「此段尚未翻譯，以下為原文」。
- **離線測試**：`TRANSLATE_ENDPOINT` 可指向本機模擬伺服器（`tests/mock-translate.mjs`，依路徑同時模擬 Gemini 的
  `/v1beta/models/<模型>:generateContent` 與 Anthropic 的 `/v1/messages`，回傳相同結構並在每段文字前加 `[xx] `；
  也模擬 400 `API_KEY_INVALID`、403、404、429 與配額用完）；只接受 https 或 `http://127.0.0.1`／`localhost`。
  Gemini 時 `TRANSLATE_ENDPOINT` 是 API 根網址（預設 `https://generativelanguage.googleapis.com/v1beta`），Anthropic 時是完整網址。

## 費用估算

以 2026-09-29 實際頁面計算（沒有實際呼叫 API，以下以字元數估算：中文約 1 token／字、ASCII 約 3.5 字元／token；
系統提示約 1,400 tokens；Gemini 的分詞與 Claude 不同，實際 token 數可能差 ±30%）。價格為 `gemini-3.5-flash-lite` 付費層級
（每百萬 token 輸入 US$0.30、輸出 US$2.50，2026-09-29 查 Google 價格頁）：

| 情境 | 請求數 | 輸入 tokens | 輸出 tokens | 費用（Gemini 3.5 Flash-Lite） | 參考：Sonnet 5.5 |
|---|---|---|---|---|---|
| 頁面沒有變動（大多數日子） | 0 | 0 | 0 | US$0 | US$0 |
| 典型變動：一個區塊改了（例如「最新新聞稿資訊」多一則），×7 種語言 | 7 | 約 12,000 | 約 3,200 | 約 US$0.012 | 約 US$0.06 |
| 最大的區塊改了（「哪裡可以接種」，含兩份縣市清單），×7 | 7 | 約 16,000 | 約 7,500 | 約 US$0.024 | 約 US$0.11 |
| 第一次全部翻譯（11 個單位×7 種語言） | 77 | 約 127,000 | 約 28,000 | 約 US$0.11 | 約 US$0.55 |

原文總量約 2,000 個中文字＋2,900 個結構字元；輸出以英文約 1.2 token／原文字、泰文約 2.5 token／原文字估算。
驗證失敗重試會使該區塊費用加倍。模型若使用思考，思考 token 以輸出價另計（本程式不設定 thinking level；Google 文件寫 Gemini 3.1 Flash-Lite 預設為 `minimal`，
3.5 Flash-Lite 的預設值文件未載明），記錄中的用量已含在內——第一次實際執行後請以記錄中的 tokens 校正上表。即使來源每天都改一個區塊，每月也約 US$0.40 以內。

**免費層級**：`gemini-3.5-flash-lite` 有免費層級（不收費），但 Google 價格頁寫明免費層級的內容「Used to improve our products: Yes」
（付費層級為 No），且速率上限較低（依帳號而定，在 Google AI Studio 的 Rate limit 頁查看）。本管線送出的只有疾管署公開網頁的文字，
沒有個資；但若機關規定不得讓送出的內容被用於改進產品，請替該專案啟用帳單（付費層級）。第一次全部翻譯約 77 個請求，
免費層級若觸發 429，程式會退避重試，仍不夠時留待隔天補翻。

## 常見狀況與處理

| 狀況 | 結果 | 處理 |
|---|---|---|
| 疾管署頁面連不上、逾時、非 200 | `harvest` 這一步失敗，後面的 step 不執行，data 分支維持上一版；排程失敗 GitHub 會寄信給 repo 擁有者 | 通常隔天就恢復，也可手動 Run workflow。超過 36 小時 `freshness.yml` 會出現警告 |
| 頁面改版（區塊 < 5 或找不到標題） | 同上 | 用瀏覽器存下頁面 → `node scripts/harvest-info.mjs --file 頁面.html` 看解析結果 → 修改解析器並把新頁面加進 `tests/fixtures/` |
| 某些連結消失 | 主機不在白名單（例如短網址 reurl.cc、docs.google.com） | 如需開放新主機，同時修改 `sanitize-info.mjs` 的 `INFO_ALLOWED_HOSTS`、`INFO_SCHEMA.md` 與前端的允許清單（`tests/info.test.mjs` 有允許／拒絕的範例） |
| 金鑰未設定或無效 | 外語檔為原文（partial）；記錄中有「未設定 GEMINI_API_KEY」或「翻譯中止…請檢查 GEMINI_API_KEY」 | 到 repo 的 Settings → Secrets and variables → Actions 設定或更新 `GEMINI_API_KEY`，再手動 Run workflow（force 留白即可補翻） |
| 配額用完（連續 429） | 已翻好的保存，其餘留待下次；記錄中有「配額或速率上限已用完」 | 通常隔天自動補完；急的話到 Google AI Studio 查看用量、提高上限或啟用帳單 |
| 排程沒有執行 | GitHub 會停用公開 repo 中「60 天沒有活動」的排程 workflow；Actions 頁面會顯示已停用 | 到 Actions →「接種資訊更新」按 Enable workflow。`freshness.yml` 也是排程，可能一起被停用，請一併確認 |
| data 分支推送一直被拒 | `publish` 失敗（「已重試 3 次」），data 分支維持另一方寫入的版本 | 極少見（兩個寫入者剛好同時且反覆衝突）；手動 Run workflow 即可 |
| 某區塊一直翻譯失敗（驗證不過） | 該區塊維持原文；記錄中有「結構驗證未通過」與原因 | 多半是數字被改寫；可在 workflow 的翻譯 step 加上 `TRANSLATE_MODEL`（例如較強的 Gemini 模型），或改用 `TRANSLATE_PROVIDER: anthropic`（需另設 `ANTHROPIC_API_KEY` secret 並加進翻譯 step 的 `env:`，同時更新 `tests/data-branch.test.mjs` 對 secret 數量的檢查），或調整 `buildSystemPrompt` |
| 譯文品質有問題 | — | 見下節「強制重新翻譯」 |
| 翻譯快取損壞 | 損壞的項目視為沒有，會重新翻譯 | 不需處理；或手動 Run workflow，`force` 填 `all` 全部重翻（約 US$0.11） |

## 強制重新翻譯某個區塊

最簡單：GitHub repo → Actions →「接種資訊更新」→ Run workflow，`force` 填區塊 id（或 `title`、`all`），`langs` 選填
（見上方「手動觸發／強制重翻」）。重翻結果由 workflow 寫回 data 分支的快取並觸發部署。

在自己的電腦上重翻（例如想先看結果）：

```bash
export INFO_WORK_DIR=/tmp/info-work DATA_REPO_URL=https://github.com/<帳號>/<repo> SKIP_DEPLOY_TRIGGER=1
scripts/info-update.sh prepare && scripts/info-update.sh harvest
GEMINI_API_KEY=… INFO_FORCE=103106 INFO_FORCE_LANGS=en,ja scripts/info-update.sh translate
# 或直接呼叫：INFO_DATA_DIR=/tmp/info-work/data INFO_PUBLIC_DIR=/tmp/info-work/pub node scripts/translate-info.mjs --force title
```

本機的結果不會自動保留（每次執行都從 data 分支取回快取）；要保留請改用 workflow，或把譯文以「離線／人工翻譯」匯入並提交到 `main`。

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
workflow 的 `prepare` 階段（`translate-info.mjs --merge-cache`）會把 repo 內的快取併入 data 分支上的快取，`source:"manual"` 的項目優先於機器翻譯。原文之後若再改動，
該區塊的雜湊改變，人工譯文不再適用（有金鑰時改由機器翻譯，否則顯示原文），需重新匯出、翻譯、匯入。

## 新增一種語言

1. 前端：依 `docs/I18N.md`「新增語系」完成（`SUPPORTED_LANGS`、`public/i18n/<lang>.json`、語言選單）。
2. `scripts/sanitize-info.mjs`：`INFO_LANGS` 加入代碼（`tests/info.test.mjs` 會檢查它與 `SUPPORTED_LANGS` 一致）。
3. `scripts/translate-info.mjs`：`LANG_NAMES` 加入「英文名稱（本地名稱）」，必要時在 `buildSystemPrompt` 加該語言的特殊規則。
4. `scripts/info-update.sh`（`LANGS`）與 `.github/workflows/deploy.yml`（從 data 分支取檔的語言清單）、`info-update.yml`（摘要的語言清單）加入代碼。
5. `npm test`；下一次排程會自動翻譯新語言的所有區塊（上一版沒有該語言檔＝視為尚未翻譯，約 US$0.02／語言）。

## 與 INFO_SCHEMA 的補充

- `list` 區塊可有選填的 `levels`（與 `items` 等長的整數陣列，0 = 最外層），表示來源的巢狀清單／縮排；全部為 0 時省略。
- `hash` 涵蓋的是翻譯投影（不含 `href`、`isNew`），不是整個區塊。
- 表格儲存格：來源的 `●`／`✖` 已統一為 `✓`／`✗`。
- `files[].text` 不含副檔名（副檔名在 `ext`）；翻譯後檔名中的「英文」等字樣會被譯掉，前端若依檔名判斷語言，請以 zh-Hant 檔的
  同一筆（相同 `href`）判斷。
- 區塊內容可能為空（例如來源某張卡片的連結全部不在白名單），前端可略過沒有 `blocks`、`links`、`files` 的區塊。
