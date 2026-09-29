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
      "note": "…",                // 選填
      // 英文（拉丁字母）轉寫：由 scripts/romanize.mjs 產生，供非中文介面顯示與搜尋（見下節）
      "nameEn": "Kaohsiung Municipal United Hospital",
      "addrEn": "No. 976, Zhonghua 1st Rd., Gushan District, Kaohsiung City",
      "cityEn": "Kaohsiung City",
      "distEn": "Gushan District"
    }
  ]
}
```

## 英文轉寫欄位（nameEn、addrEn、cityEn、distEn）

由 `scripts/normalize.mjs` 呼叫 `scripts/romanize.mjs` 產生；規則式、完全確定性、不連網（拼音用 devDependency
`pinyin-pro` 的本機字典）。**這是機器轉寫，不是官方譯名**，目標是「外國人看得懂、叫車 App 查得到」。

| 欄位 | 內容 | 規則 |
|---|---|---|
| `cityEn` | 縣市官方英文（`Taipei City`、`Hsinchu County`） | 一律查 `data/districts-en.json`，不以拼音產生 |
| `distEn` | 行政區官方英文（`Beitou District`、`Tamsui District`、`Puli Township`） | 同上，以「縣市\|行政區」查表 |
| `nameEn` | 院所名稱（`Linwenzheng ENT Clinic`） | 醫療／組織用語查 `romanize.mjs` 內的詞彙表譯成英文（診所 Clinic、耳鼻喉科 ENT、衛生所 Public Health Center、榮民總醫院 Veterans General Hospital、長庚 Chang Gung…）；名稱中的縣市、行政區用官方拼法；其餘專有名詞以漢語拼音連寫成一字、首字母大寫（a/o/e 開頭的音節前加 `'`，ü 寫作 yu）；去除「○○醫療財團法人」等法人前綴與「（委託○○經營）」說明；「衛生福利部○○醫院」→ `○○ Hospital, Ministry of Health and Welfare` |
| `addrEn` | 郵局英文地址順序：`樓層, No. 門牌, Aly. 弄, Ln. 巷, Sec. 段, 路名, 行政區, 縣市` | 路 Rd.、街 St.、大道 Blvd.；方位 東西南北 → E./W./S./N.；序數路名 中華一路 → `Zhonghua 1st Rd.`；中文數字轉阿拉伯數字；之 → `-`（`No. 240-7`）；地下一樓 → `B1`、樓層範圍 `B2-4F`；有路名時省略村里、鄰，沒有路名時保留（`Zaoqiao Village`）；慣用英文路名（羅斯福 Roosevelt、基隆 Keelung、臺灣大道 Taiwan Blvd.）查表；只取第一個門牌 |

- 四個欄位只含 ASCII 字母、數字、空白與 `' . , - ( )`；`sanitize.mjs` 以白名單檢查（拉丁字母、長度上限
  `nameEn` 160、`addrEn` 240、`cityEn`／`distEn` 40），不合格的欄位會被捨棄。
- 對前端而言四個欄位是**選填**：舊版資料沒有時一律退回顯示中文。但 `normalize.mjs` 產生的資料每筆都必須有
  （`tests/data.test.mjs` 檢查），`keep-live-data.mjs` 也不採用缺少英文欄位的舊版線上檔案。
- 若日後改由伺服器端直接匯出資料，可沿用 `scripts/romanize.mjs`（`romanizeHospital(h)`）產生這四個欄位。

## 前端衍生欄位（執行期計算，不寫入檔案）

- `openToday`：`hours[今天] !== 0`（以 Asia/Taipei 計）
- `openNow`：目前時段（上午 08–12、下午 12–18、晚上 18–22，其餘視為非看診時段）對應位元為 1。
  時段邊界是近似值，畫面文字用「本時段有看診」並提醒先電洽。
- `status`（圖釘/清單狀態，依目前篩選的品項判定；未選品項時以任一品項判定）
  - `ok`：今日有看診且所選品項有庫存
  - `nostock`：今日有看診但所選品項皆無庫存
  - `closed`：今日休診
- `distance`：使用者定位或地圖中心到院所的距離
