# 資料格式（前端唯一依賴的契約）

前端只讀 `public/data/hospitals.json`，不直接接觸現站 API 的原始格式。
原始 → 正規化由 `scripts/normalize.mjs` 負責；日後若改接即時 API，只需在
`src/data-source.js` 換一個 adapter，輸出同樣的結構即可。

```jsonc
{
  "meta": {
    "generatedAt": "2026-09-21T10:30:00+08:00", // 快照產生時間（顯示在畫面上）
    "source": "https://vaxmap.cdc.gov.tw/",
    "count": 4321
  },
  // 品項目錄；hospitals[].stock 的 key 對應這裡的 id
  "vaccines": [
    { "id": "flu",        "group": "flu",       "name": "流感疫苗",                      "short": "流感疫苗" },
    { "id": "mod_adult",  "group": "covid",     "name": "Moderna LP.8.1(滿12歲以上)",     "short": "莫德納 12歲以上" },
    { "id": "mod_child",  "group": "covid",     "name": "Moderna LP.8.1(滿6個月未滿12歲)", "short": "莫德納 6個月–11歲" },
    { "id": "novavax",    "group": "covid",     "name": "Novavax JN.1(≧12歲)",           "short": "Novavax 12歲以上" },
    { "id": "pcv20",      "group": "pcv",       "name": "20價結合型肺炎鏈球菌疫苗",        "short": "肺鏈 PCV20" },
    { "id": "pcv21",      "group": "pcv",       "name": "21價結合型肺炎鏈球菌疫苗",        "short": "肺鏈 PCV21" },
    { "id": "antiviral",  "group": "antiviral", "name": "抗病毒藥劑",                     "short": "流感抗病毒藥劑" }
  ],
  "groups": [
    { "id": "flu", "name": "流感疫苗" }, { "id": "covid", "name": "COVID-19 疫苗" },
    { "id": "pcv", "name": "肺炎鏈球菌疫苗" }, { "id": "antiviral", "name": "流感抗病毒藥劑" }
  ],
  "hospitals": [
    {
      "id": 2050,                 // 現站內部 Id
      "code": "0102020011",       // 醫事機構代碼
      "name": "高雄市立聯合醫院",
      "city": "高雄市", "dist": "鼓山區",
      "addr": "高雄市鼓山區中華一路976號",
      "tel": "07-5552565",
      "lat": 22.654924, "lng": 120.291698,
      // 週一..週日 的看診時段位元遮罩：1=上午 2=下午 4=晚上（0=休診）
      "hours": [7, 7, 7, 7, 7, 1, 0],
      // 只列出該院所「有提供」的品項；值為 1（有庫存）或 0（有提供但目前無庫存）。
      // 原始庫存數量不發布，畫面只顯示「有／無庫存」
      "stock": { "pcv20": 1, "mod_adult": 1, "mod_child": 1, "antiviral": 1 },
      "apptTel": "(07)5552565",   // 選填：預約電話（與 tel 不同時才有）
      "apptUrl": "https://…",     // 選填：預約網址
      "note": "…"                 // 選填
    }
  ]
}
```

## 前端衍生欄位（執行期計算，不寫入檔案）

- `openToday`：`hours[今天] !== 0`（以 Asia/Taipei 計）
- `openNow`：目前時段（上午 08–12、下午 12–18、晚上 18–22，其餘視為非看診時段）對應位元為 1。
  時段邊界是近似值，畫面文字用「本時段有看診」並提醒先電洽。
- `status`（圖釘/清單狀態，依目前篩選的品項判定；未選品項時以任一品項判定）
  - `ok`：今日有看診且所選品項有庫存
  - `nostock`：今日有看診但所選品項皆無庫存
  - `closed`：今日休診
- `distance`：使用者定位或地圖中心到院所的距離
