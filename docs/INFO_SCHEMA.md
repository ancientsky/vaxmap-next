# 接種資訊專區資料格式（`public/data/info/<lang>.json`）

來源：疾管署官網「115年度左流右新護肺顧心 疫苗接種專區」
`https://www.cdc.gov.tw/Category/MPage/S_ZLz0yyc2lAQ9TStMB0uA`（MPage：`div.card` 手風琴，每張卡片一個主題，
卡片內有 `card-title`、`card-body` 正文 HTML、`div.download` 連結／檔案清單、`div.date` 最後更新日期）。

管線：`scripts/harvest-info.mjs`（抓取＋解析＋清理 → `data/info/source.json`，繁中）→
`scripts/translate-info.mjs`（只翻譯內容雜湊有變的區塊，快取於 `data/info/translations.json`）→
`public/data/info/<lang>.json`（八種語言各一檔，前端只讀這些檔）。

## 檔案結構

```jsonc
{
  "meta": {
    "lang": "en",
    "sourceUrl": "https://www.cdc.gov.tw/Category/MPage/S_ZLz0yyc2lAQ9TStMB0uA",
    "sourceTitle": "115年度左流右新護肺顧心 疫苗接種專區",   // 原文標題（各語言檔都保留原文）
    "title": "2026 Flu & COVID-19 Vaccination Hub",          // 翻譯後標題
    "fetchedAt": "2026-09-29T21:30:00.000Z",                   // 上次抓取時間
    "changedAt": "2026-09-23T00:00:00.000Z",                   // 來源內容最近一次變動（任一區塊雜湊改變）
    "translation": "machine" | "source" | "partial",          // 本檔內容：機器翻譯／原文（zh-Hant）／部分區塊尚未翻譯
    "translatedAt": "…"                                        // 選填
  },
  "sections": [
    {
      "id": "103106",                 // 來源卡片 id（collapseOne103106 的數字）；穩定，作為錨點與快取鍵
      "key": "coins",                 // 主題代碼（見下表），由標題比對規則決定；比不到時為 "other"
      "hash": "sha256:…",             // 原文（title+blocks+links+files）的雜湊，翻譯快取鍵
      "title": "Earn Health Coins by Getting Vaccinated",
      "updated": "2026-09-23",        // 來源「最後更新日期」，ISO 日期
      "translated": true,             // false = 此區塊仍是原文（翻譯未完成）
      "blocks": [                     // 正文，依序
        { "type": "p", "text": "…", "runs": [ { "text": "…" }, { "text": "健康幣網站", "href": "https://…" } ] },
        { "type": "list", "ordered": false, "items": [ "…", "…" ] },
        { "type": "table", "caption": "第一階段（2026/10/01 起）", "head": ["對象", "流感", "新冠"], "rows": [["…","✓","✓"]] },
        { "type": "h", "level": 4, "text": "…" },
        { "type": "note", "text": "…" }          // 來源的紅字／備註
      ],
      "links": [ { "text": "…", "href": "https://…", "isNew": false } ],   // div.download「連結」
      "files": [ { "text": "公費流感疫苗接種須知", "href": "https://www.cdc.gov.tw/File/Get/…", "ext": "pdf", "isNew": true } ]
    }
  ]
}
```

## 主題代碼（`key`）與顯示順序

| key | 標題關鍵字（來源） | 前端呈現 |
|---|---|---|
| `coins` | 健康幣 | 醒目卡片：三種疫苗各多少幣（從正文解析數字：流感 450／新冠 900／肺鏈 600，解析失敗則只顯示正文） |
| `eligibility` | 接種對象 | 表格（第一／第二階段），手機改為每列一卡 |
| `where` | 哪裡可以接種／接種地點 | 說明段落＋「開啟地圖」按鈕（本站首頁）＋縣市衛生局連結列表（22 筆，分欄） |
| `precautions` | 注意事項／接種須知 | 檔案卡片（PDF 圖示、語言標示：檔名含「英文」→ EN） |
| `brands` | 廠牌 | 段落＋清單，廠牌名保留原文並附英文（見翻譯詞彙表） |
| `education` | 衛教／宣導 | 連結＋檔案卡片 |
| `faq` | 常見問答／Q&A | 連結列表 |
| `news` | 新聞稿 | 連結列表（標題、日期） |
| `other` | 其他 | 一般段落 |

前端只信任這份 JSON：所有文字以 `textContent` 寫入；`href` 只接受 `https://` 且主機在允許清單，其餘丟棄；外部連結一律 `rel="noopener noreferrer"`。

**連結主機允許清單（管線與前端必須一致）**：`gov.tw`、`*.gov.tw`（含 `www.cdc.gov.tw`、`www.healthtoken.hpa.gov.tw`）、
`*.gov.taipei`（臺北市政府網域）、`www.youtube.com`、`youtu.be`（疾管署官方影片）。短網址（`reurl.cc`）與 `docs.google.com`
等不在清單內，會被丟棄並在解析紀錄中列出。

## 翻譯規則（`translate-info.mjs`）

- 只翻譯 `translated` 為 false 或雜湊改變的區塊；結果快取於 `data/info/translations.json`：`{ "<hash>": { "en": {...section}, "ja": … } }`。
- 翻譯的是結構化 JSON（title、blocks 內 text／items／caption／head／rows、links.text、files.text），不是 HTML；
  `href`、`updated`、`id`、數字與品牌名（Moderna、Novavax、GSK、Sanofi、高端 → "Medigen"、國光 → "Adimmune"、東洋 → "TTY Biopharm"）依詞彙表處理。
- 預設使用 Google Gemini API（`gemini-3.5-flash-lite`；環境變數 `GEMINI_API_KEY`，在 GitHub Actions 由 repo secret 提供），
  可用 `TRANSLATE_PROVIDER=anthropic`＋`ANTHROPIC_API_KEY` 改用 Anthropic；模型以 `TRANSLATE_MODEL` 指定。無金鑰時跳過翻譯：
  各語言檔仍會產生，未翻譯區塊帶原文並標 `translated:false`、`meta.translation:"partial"`，前端顯示「此段尚未翻譯，以下為原文」。
- 翻譯輸出經結構驗證（區塊數、型別、連結數一致）與 `sanitize` 後才寫入。
