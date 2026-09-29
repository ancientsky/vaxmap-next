// 院所名稱、地址、縣市、行政區的英文（拉丁字母）呈現，供非中文使用者閱讀。
// 由 normalize.mjs 在產生 public/data/hospitals.json 時呼叫（keep-live-data 不呼叫，前端也不呼叫）。
//
// 原則：
//   - 完全確定性、不連網：同樣的輸入永遠得到同樣的輸出（pinyin-pro 為本機字典）。
//   - 縣市、行政區一律用 data/districts-en.json 的官方英文（不以拼音產生），
//     名稱或路名中出現的地名（高雄、北投、淡水…）也優先用官方拼法。
//   - 名稱：醫療／組織用語查下方詞彙表（GLOSSARY）翻成英文，其餘專有名詞以漢語拼音
//     連寫成一個字、首字母大寫（林文正耳鼻喉科診所 → Linwenzheng ENT Clinic）。
//   - 地址：依郵局英文地址順序「樓層, 號, 弄, 巷, 段, 路, 行政區, 縣市」。
//   - 輸出只含 ASCII 字母、數字、空白與 ' . , - ( )（sanitize.mjs 會再檢查一次）。
// 這是規則式轉寫，不會完美；目標是「外國人看得懂、叫車 App 查得到」。
import fs from 'node:fs';
import { pinyin, customPinyin } from 'pinyin-pro';

const TABLE = JSON.parse(fs.readFileSync(new URL('../data/districts-en.json', import.meta.url), 'utf8'));
const CITY_EN = TABLE.cities; // { 臺北市: 'Taipei City' }
const DIST_EN = TABLE.districts; // { '臺北市|北投區': 'Beitou District' }

// pinyin-pro 的詞組字典以簡體為主，部分繁體多音詞讀音會錯；在此補上（只影響本程序）
customPinyin({
  重慶: 'chóng qìng',
  廈門: 'xià mén',
  單: 'shàn', // 姓氏（臺灣院所名稱中幾乎只作姓氏用）
  柏: 'bó', // 臺灣讀音（柏林、柏仁）
});

/* ------------------------------------------------------------------ *
 * 基本工具
 * ------------------------------------------------------------------ */

const HAN = /\p{Script=Han}/u;
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文數字（一～九十九）→ 整數；不是中文數字回傳 null。阿拉伯數字字串原樣轉為整數。 */
export function cnToInt(s) {
  if (/^\d+$/.test(s)) return Number(s);
  // 逐位寫法可混用阿拉伯數字與 ○／O（八0七、二Ｏ八）
  if (!/^[零〇○O0-9一二兩三四五六七八九十]+$/.test(s)) return null;
  if (s === '十') return 10;
  const i = s.indexOf('十');
  if (i < 0) return Number([...s].map((c) => (/\d/.test(c) ? c : c === '○' || c === 'O' ? 0 : CN_DIGIT[c])).join(''));
  if (/[○O0-9]/.test(s) || s.indexOf('十', i + 1) >= 0 || s.length > 3) return null;
  const tens = i === 0 ? 1 : CN_DIGIT[s[i - 1]];
  const ones = i === s.length - 1 ? 0 : CN_DIGIT[s[i + 1]];
  return tens * 10 + ones;
}

const ordinal = (n) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
};

/** 前處理：全半形統一、台→臺、巿（U+5DFF）→市、各式括號統一為半形 () */
function prep(s) {
  return (typeof s === 'string' ? s : '')
    .normalize('NFKC')
    .replace(/台/g, '臺')
    .replace(/巿/g, '市')
    .replace(/[〈《【［「]/g, '(')
    .replace(/[〉》】］」]/g, ')')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

/** 漢字 → 拼音音節陣列（無聲調、ü → yu；例如 綠 → lyu，與臺灣護照拼法一致） */
function syllables(zh, { surname = false } = {}) {
  return pinyin(zh, { toneType: 'none', type: 'array', surname: surname ? 'head' : 'off' })
    .map((p) => p.toLowerCase().replace(/ü/g, 'yu').replace(/v/g, 'yu'))
    .filter((p) => /^[a-z]+$/.test(p));
}

/** 音節連寫成一個字：a/o/e 開頭的非首音節前加隔音號（仁愛 → Ren'ai），首字母大寫 */
function joinSyllables(syl) {
  let w = '';
  for (const s of syl) w += w && /^[aoe]/.test(s) ? `'${s}` : s;
  return w ? w[0].toUpperCase() + w.slice(1) : '';
}

/** 漢字 → 一個拼音字（例如 林文正 → Linwenzheng） */
export function pinyinWord(zh, opts) {
  return joinSyllables(syllables(zh, opts));
}

/** 最後一道：只留 ASCII 字母數字與 ' . , - ( ) 空白，整理多餘空白與逗號 */
export function asciiClean(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[^A-Za-z0-9 '.,\-()]/g, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/,(\s*,)+/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
}

/* ------------------------------------------------------------------ *
 * 縣市、行政區
 * ------------------------------------------------------------------ */

const norm = (s) => prep(s);

/** 縣市英文；未知縣市回傳 '' */
export function cityEn(city) {
  return CITY_EN[norm(city)] || '';
}

/** 行政區英文（以「縣市|行政區」查表）；表中沒有時以拼音 + District/Township 補上 */
export function distEn(city, dist) {
  const c = norm(city);
  const d = norm(dist);
  if (!d) return '';
  const hit = DIST_EN[`${c}|${d}`];
  if (hit) return hit;
  for (const [k, v] of Object.entries(DIST_EN)) if (k.endsWith(`|${d}`)) return v;
  const m = d.match(/^(.+?)(區|鄉|鎮|市)$/);
  if (!m) return pinyinWord(d);
  return `${pinyinWord(m[1])} ${m[2] === '區' ? 'District' : m[2] === '市' ? 'City' : 'Township'}`;
}

// 地名 → 英文：{ full: 含「區鄉鎮市縣」的全名, bare: 去掉字尾的簡稱 }；同名時以院所所在縣市優先
const PLACE_FULL = new Map(); // 北投區 → [{city, en}]
const PLACE_BARE = new Map(); // 北投 → [{city, en}]
function addPlace(map, zh, city, en) {
  if (!map.has(zh)) map.set(zh, []);
  const list = map.get(zh);
  if (!list.some((x) => x.city === city && x.en === en)) list.push({ city, en });
}
for (const [zh, en] of Object.entries(CITY_EN)) {
  addPlace(PLACE_FULL, zh, zh, en);
  addPlace(PLACE_BARE, zh.slice(0, -1), zh, en.replace(/ (City|County)$/, ''));
}
for (const [k, en] of Object.entries(DIST_EN)) {
  const [city, d] = k.split('|');
  addPlace(PLACE_FULL, d, city, en);
  const bare = d.replace(/(區|鄉|鎮|市)$/, '');
  // 「東區」→「東」這種單字簡稱太容易誤判，不收
  if (bare.length >= 2 && bare !== d) addPlace(PLACE_BARE, bare, city, en.replace(/ (District|Township|City)$/, ''));
}
addPlace(PLACE_BARE, '馬祖', '連江縣', 'Matsu');
const OLD_COUNTIES = ['臺北縣', '桃園縣', '臺中縣', '臺南縣', '高雄縣']; // 2010 年前的縣名，舊地址仍常見
const CITY_BARE = [...new Set(Object.keys(CITY_EN).map((zh) => zh.slice(0, -1)))];
// 簡稱「新竹」「嘉義」在縣、市都有：兩者英文相同（Hsinchu、Chiayi），取第一筆即可

function pickPlace(list, city) {
  return (list.find((x) => x.city === city) || list[0]).en;
}
const MAX_PLACE = Math.max(...[...PLACE_FULL.keys(), ...PLACE_BARE.keys()].map((k) => k.length));

/* ------------------------------------------------------------------ *
 * 名稱
 * ------------------------------------------------------------------ */

// 詞彙表：中文 → 英文。'' 表示略去不譯。
// kind: 'term'（醫療／組織用語，名稱中任何位置都比對）
//       'brand'（院所品牌、大學；只在專有名詞片段的開頭比對，避免從人名中間切出來）
// 以最長者優先比對；新增詞彙時請同步在 tests/romanize.test.mjs 加例子。
const TERMS = {
  // 院所類別
  診所: 'Clinic', 醫院: 'Hospital', 病院: 'Hospital', 總醫院: 'General Hospital', 綜合醫院: 'General Hospital',
  紀念醫院: 'Memorial Hospital', 兒童醫院: "Children's Hospital", 醫務室: 'Clinic', 醫務所: 'Clinic',
  衛生所: 'Public Health Center', 衛生室: 'Health Station', 健康服務中心: 'Health Center', 療養院: 'Psychiatric Center',
  門診部: 'Outpatient Department', 門診中心: 'Outpatient Center', 民眾診療服務處: 'Civilian Clinic',
  分院: 'Branch', 院區: 'Branch', 醫療中心: 'Medical Center', 國際機場: 'International Airport', 醫學中心: 'Medical Center', 中心: 'Center',
  藥局: 'Pharmacy', 防治所: 'Control Center', 慢性病防治所: 'Chronic Disease Control Center',
  胸腔病防治所: 'Chest Disease Control Center', 胸腔病院: 'Chest Hospital', 榮譽國民之家: 'Veterans Home',
  榮民之家: 'Veterans Home', 監獄: 'Prison', 農會: "Farmers' Association", 農民醫院: "Farmers' Hospital",
  // 組織、屬性
  醫療社團法人: '', 醫療財團法人: '', 財團法人: '', 社團法人: '', 附設: '', 附屬: '', 委託: '',
  醫學院附設醫院: 'Hospital', 醫學院附設: '', 附設醫院: 'Hospital', 附屬醫院: 'Hospital',
  聯合: 'United', 綜合: 'General', 紀念: 'Memorial', 市立: 'Municipal', 縣立: 'County', 國立: 'National',
  私立: 'Private', 大學: 'University', 醫學大學: 'Medical University', 醫學院: 'College of Medicine',
  科技大學: 'University of Science and Technology', 專科: 'Specialist', 衛生福利部: 'Ministry of Health and Welfare',
  國軍: 'Armed Forces', 國軍退除役官兵輔導委員會: '', 法務部矯正署: '', 第一: 'First', 第二: 'Second', 第三: 'Third',
  基督教: 'Christian', 天主教: 'Catholic', 佛教: 'Buddhist', 基督長老教會: 'Presbyterian Church', 臺灣基督長老教會: '',
  耳鼻咽喉科: 'ENT', 內外科: 'Internal Medicine and Surgery', 外婦科: 'Surgery and Gynecology', 婦科: 'Gynecology',
  醫師: '', 家庭: 'Family', 健康: 'Health', 管理: 'Management', 醫療: 'Medical', 員工: 'Employee', 科學工業園區: 'Science Park', 股份有限公司: '',
  煉製事業部: 'Refining Division', 社區: 'Community', 南西北區: 'Nanxibei District', 聯合門診: 'United Outpatient', 門診: 'Outpatient',
  // 科別
  耳鼻喉科: 'ENT', 耳鼻喉: 'ENT', 小兒科: 'Pediatric', 兒科: 'Pediatric', 小兒: 'Pediatric',
  內兒科: 'Internal Medicine and Pediatric', 家庭醫學科: 'Family Medicine', 家庭醫學: 'Family Medicine',
  家醫科: 'Family Medicine', 家醫: 'Family Medicine', 內科: 'Internal Medicine', 外科: 'Surgery',
  婦產科: 'OB-GYN', 婦產: 'OB-GYN', 皮膚科: 'Dermatology', 眼科: 'Ophthalmology', 骨科: 'Orthopedics',
  泌尿科: 'Urology', 泌尿: 'Urology', 復健科: 'Rehabilitation', 復健: 'Rehabilitation', 精神科: 'Psychiatry',
  身心科: 'Psychiatry', 神經科: 'Neurology', 心臟科: 'Cardiology', 胃腸科: 'Gastroenterology',
  腸胃科: 'Gastroenterology', 胸腔科: 'Chest Medicine', 感染科: 'Infectious Disease', 新陳代謝科: 'Metabolism',
  中醫: 'Traditional Chinese Medicine', 牙醫: 'Dental', 牙科: 'Dental', 脊椎: 'Spine', 骨外科: 'Orthopedic Surgery',
  婦幼: "Women and Children's", 婦兒: "Women and Children's", 婦女: "Women's", 兒童: "Children's",
  親子: 'Family', 老人: 'Geriatric', 慢性: 'Chronic', 癌症: 'Cancer', 治癌中心: 'Cancer Center',
  癌醫中心醫院: 'Cancer Center', 癌醫中心: 'Cancer Center', 癌治療醫院: 'Cancer Hospital',
  旅遊醫院: 'Hospital', 原住民: 'Indigenous', 礦工: "Miners'",
  榮民總醫院: 'Veterans General Hospital', 三軍總醫院: 'Tri-Service General Hospital',
  臺北市立聯合醫院: 'Taipei City Hospital', 中和紀念醫院: 'Chung-Ho Memorial Hospital',
  和信治癌中心醫院: 'Koo Foundation Sun Yat-Sen Cancer Center',
};
const BRANDS = {
  // 大學（「國立」另譯為 National，重複的 National 會被合併）
  臺灣大學: 'National Taiwan University', 臺大: 'National Taiwan University', 臺大分院: 'Branch',
  成功大學: 'National Cheng Kung University', 陽明交通大學: 'National Yang Ming Chiao Tung University',
  中山大學: 'National Sun Yat-sen University', 中國醫藥大學: 'China Medical University',
  高雄醫學大學: 'Kaohsiung Medical University', 高醫: 'Kaohsiung Medical University',
  臺北醫學大學: 'Taipei Medical University', 中山醫學大學: 'Chung Shan Medical University',
  亞洲大學: 'Asia University', 輔仁大學: 'Fu Jen Catholic University', 輔英科技大學: 'Fooyin University',
  // 醫療體系
  台灣中油: 'CPC', 臺灣中油: 'CPC', 亞東: 'Far Eastern', 新光: 'Shin Kong', 國泰: 'Cathay',
  義大: 'E-Da', 童綜合: "Tungs' General", 振興: 'Cheng Hsin',
  臺安: 'Taiwan Adventist', 萬芳: 'Wan Fang', 雙和: 'Shuang Ho', 恩主公: 'En Chu Kong', 若瑟: "St. Joseph's",
  聖馬爾定: 'St. Martin De Porres', 聖保祿: "St. Paul's", 聖母: "St. Mary's", 博愛: 'Poh-Ai',
  門諾: 'Mennonite', 生醫: 'Biomedical', 彰濱: 'Changbin', 為恭: 'Weigong', 郵政: 'Postal', 臺灣: 'Taiwan',
  工業技術研究院: 'Industrial Technology Research Institute', 中華汽車工業股份有限公司: 'China Motor Corporation',
  中華民國防癆協會: 'Taiwan Anti-Tuberculosis Association',
};
// 名稱中任何位置都可比對的品牌（字面夠獨特，不會出現在人名中）：「本堂澄清醫院」→ Bentang Cheng Ching Hospital
const BRANDS_ANYWHERE = {
  長庚: 'Chang Gung', 馬偕: 'MacKay', 慈濟: 'Tzu Chi', 奇美: 'Chi Mei', 秀傳: 'Show Chwan', 耕莘: 'Cardinal Tien',
  澄清: 'Cheng Ching', 光田: 'Kuang Tien', 敏盛: 'Min-Sheng', 聯新國際: 'Landseed International',
};
const GLOSS = new Map([
  ...Object.entries(BRANDS_ANYWHERE).map(([k, v]) => [k, { en: v, kind: 'brand', anywhere: true }]),
  ...Object.entries(TERMS).map(([k, v]) => [k, { en: v, kind: 'term' }]),
  ...Object.entries(BRANDS).map(([k, v]) => [k, { en: v, kind: 'brand' }]),
]);
const MAX_GLOSS = Math.max(...[...GLOSS.keys()].map((k) => k.length));

/** 去除經營委託說明與法人前綴，只留民眾認得的院所名稱 */
function stripCorporate(s) {
  let out = s
    .replace(/\(\s*委託[^)]*\)/g, '')
    .replace(/-?\s*委託.*$/, '')
    .trim();
  // 「X醫療財團法人Y醫院」→「Y醫院」；法人之後的「臺灣省私立」「私立」一併去除
  const corp = out.match(/^.*?(?:醫療)?(?:財團|社團)法人(?:臺灣省)?(?:私立)?/);
  if (corp && out.length - corp[0].length >= 2) out = out.slice(corp[0].length);
  // 「辜公亮基金會和信治癌中心醫院」→「和信治癌中心醫院」
  const fnd = out.match(/^[^()]*?基金會/);
  if (fnd && out.length - fnd[0].length >= 2) out = out.slice(fnd[0].length);
  // 「東勢區農會附設農民醫院」「高雄仁愛之家附設慈惠醫院」→ 附設的醫院本身
  // （大學、醫院、分院之下的附設單位則保留上層名稱，例如「三軍總醫院附設民眾診療服務處」）
  const sub = out.match(/^([^()]+?)附設([^()]*醫院)$/);
  if (sub && !/(大學|醫學院|醫院|分院)/.test(sub[1])) out = sub[2];
  return out;
}

/** 把名稱切成 [{zh, en, kind}]；kind: term | brand | place | run（拼音片段）| ascii | paren */
function tokenizeName(s, city) {
  const tokens = [];
  let run = '';
  const flush = () => {
    if (run) tokens.push({ zh: run, en: null, kind: 'run' });
    run = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') {
      const j = s.indexOf(')', i + 1);
      const inner = s.slice(i + 1, j < 0 ? s.length : j);
      flush();
      tokens.push({ zh: inner, en: null, kind: 'paren' });
      i = j < 0 ? s.length : j + 1;
      continue;
    }
    if (!HAN.test(ch)) {
      if (/[A-Za-z0-9]/.test(ch)) {
        flush();
        const m = s.slice(i).match(/^[A-Za-z0-9]+(?:[.'-][A-Za-z0-9]+)*/);
        tokens.push({ zh: m[0], en: m[0], kind: 'ascii' });
        i += m[0].length;
      } else {
        flush();
        i += 1;
      }
      continue;
    }
    // 找最長的詞彙／地名
    let best = null;
    const atBoundary = run === '';
    const maxLen = Math.min(Math.max(MAX_GLOSS, MAX_PLACE + 1), s.length - i);
    for (let L = maxLen; L >= 1 && !best; L--) {
      const w = s.slice(i, i + L);
      const g = GLOSS.get(w);
      if (g && (g.kind === 'term' || g.anywhere || atBoundary)) { best = { zh: w, en: g.en, kind: g.kind }; break; }
      // 「高雄市立」「連江縣立」：市／縣之後接「立」→ 簡稱 + Municipal／County
      if (L >= 3 && /[市縣]立$/.test(w) && PLACE_FULL.has(w.slice(0, -1)) && CITY_EN[w.slice(0, -1)]) {
        const pre = { zh: w.slice(0, -2), en: pickPlace(PLACE_BARE.get(w.slice(0, -2)), city), kind: 'place' };
        best = { zh: w.slice(-2), en: w.endsWith('市立') ? 'Municipal' : 'County', kind: 'term', pre, consumed: L };
        break;
      }
      if (L >= 2 && PLACE_FULL.has(w)) { best = { zh: w, en: pickPlace(PLACE_FULL.get(w), city), kind: 'place' }; break; }
      if (L >= 2 && atBoundary && PLACE_BARE.has(w)) { best = { zh: w, en: pickPlace(PLACE_BARE.get(w), city), kind: 'place' }; break; }
    }
    if (best) {
      flush();
      const { consumed, pre, ...tok } = best;
      if (pre) tokens.push(pre);
      tokens.push(tok);
      i += consumed || best.zh.length;
    } else {
      run += ch;
      i += 1;
    }
  }
  flush();
  return tokens;
}

function renderTokens(tokens, city, depth) {
  const words = [];
  const seenBrands = new Set();
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    let en;
    if (t.kind === 'run') {
      // 名稱開頭的專有名詞多半是人名（姓氏讀音：曾 Zeng、單 Shan…）
      en = pinyinWord(t.zh, { surname: k === 0 });
    } else if (t.kind === 'paren') {
      const inner = t.zh.trim() === '新' ? 'New' : depth < 2 ? romanizeName(t.zh, { city, depth: depth + 1 }) : '';
      en = inner ? `(${inner})` : '';
    } else {
      en = t.en;
    }
    if (t.kind === 'brand' && en) {
      if (seenBrands.has(en)) continue; // 「高雄醫學大學附設高醫岡山醫院」：高醫不再重複
      seenBrands.add(en);
    }
    if (en) words.push(en);
  }
  return words;
}

/**
 * 院所名稱 → 英文。
 * @param {string} name 中文名稱
 * @param {{city?: string, depth?: number}} [ctx] city：院所所在縣市（同名地名以此縣市優先）
 */
export function romanizeName(name, { city = '', depth = 0 } = {}) {
  let s = prep(name).replace(/\?/g, '');
  if (depth === 0) s = stripCorporate(s);
  const tokens = tokenizeName(s, norm(city));

  // 「國軍高雄總醫院」→ Kaohsiung Armed Forces General Hospital（地名移到前面）
  for (let k = 0; k + 1 < tokens.length; k++) {
    if (tokens[k].zh === '國軍' && tokens[k + 1].kind === 'place') [tokens[k], tokens[k + 1]] = [tokens[k + 1], tokens[k]];
  }
  // 「衛生福利部臺北醫院」→ Taipei Hospital, Ministry of Health and Welfare
  let suffix = '';
  if (tokens[0]?.zh === '衛生福利部' && tokens.length > 1) {
    tokens.shift();
    suffix = ', Ministry of Health and Welfare';
  }
  const words = renderTokens(tokens, norm(city), depth);
  let out = words.join(' ').replace(/\s+/g, ' ');
  // 相鄰重複字（National National、Hospital Hospital）合併
  out = out.replace(/\b([A-Za-z][A-Za-z'-]*)(?: \1\b)+/g, '$1');
  out = asciiClean(out + suffix);
  if (!out && depth === 0) out = asciiClean(pinyinWord(s)) || 'Clinic';
  return out;
}

/* ------------------------------------------------------------------ *
 * 地址
 * ------------------------------------------------------------------ */

// 路名中常見、拼音會錯或有慣用英文的詞（整個路名核心相符時使用）
const ROAD_NAMES = {
  忠孝: 'Zhongxiao', 復興: 'Fuxing', 敦化: 'Dunhua', 羅斯福: 'Roosevelt', 中華: 'Zhonghua', 民生: 'Minsheng',
  民權: 'Minquan', 民族: 'Minzu', 南京: 'Nanjing', 松江: 'Songjiang', 信義: 'Xinyi', 仁愛: "Ren'ai", 承德: 'Chengde',
  重慶: 'Chongqing', 基隆: 'Keelung', 臺灣: 'Taiwan', 市民: 'Civic', 中山: 'Zhongshan', 中正: 'Zhongzheng',
  和平: 'Heping', 長安: "Chang'an", 長春: 'Changchun', 長沙: 'Changsha', 長榮: 'Changrong', 長庚: 'Changgeng',
  重新: 'Chongxin', 重陽: 'Chongyang', 重光: 'Chongguang', 重安: "Chong'an", 重義: 'Chongyi', 重興: 'Chongxing',
  臺中港: 'Taichung Port', 樂群: 'Lequn', 樂業: 'Leye', 樂利: 'Leli', 覺民: 'Juemin', 行善: 'Xingshan',
  大埔: 'Dapu', 廈門: 'Xiamen', 汀州: 'Tingzhou', 文化: 'Wenhua', 環河: 'Huanhe', 環中: 'Huanzhong',
  科學園: 'Kexueyuan', 縣民: 'Xianmin', 公園: 'Gongyuan', 捷運: 'MRT',
};
const DIR = { 東: 'E.', 西: 'W.', 南: 'S.', 北: 'N.' };
const ROAD_TYPE = { 路: 'Rd.', 街: 'St.', 大道: 'Blvd.' };

/** 路名核心（不含 路／街／大道）→ 英文，例如 中華一 → Zhonghua 1st；南京東 → Nanjing E. */
function roadCore(core, city) {
  let rest = core;
  let dir = '';
  let ord = '';
  // 方位只在剩下至少兩字時才拆（「新生南」→ Xinsheng S.；「河北」「屏東」不拆）
  const takeDir = () => {
    if (!dir && rest.length >= 3 && DIR[rest.slice(-1)]) { dir = DIR[rest.slice(-1)]; rest = rest.slice(0, -1); }
  };
  takeDir();
  // 「中華一」→ Zhonghua 1st；序數前至少兩字（「一心」「十全」不拆）
  const m = rest.match(/^(.{2,}?)([一二三四五六七八九十]{1,2}|\d{1,2})$/);
  if (m && cnToInt(m[2]) > 0) { ord = ordinal(cnToInt(m[2])); rest = m[1]; }
  takeDir();
  let name;
  if (ROAD_NAMES[rest]) name = ROAD_NAMES[rest];
  else if (PLACE_BARE.has(rest)) name = pickPlace(PLACE_BARE.get(rest), city);
  else {
    // 以縣市簡稱開頭的路名（基隆港…）：地名用官方拼法，其餘拼音
    const head = CITY_BARE.find((k) => rest.startsWith(k) && rest.length > k.length);
    name = head ? `${pickPlace(PLACE_BARE.get(head), city)} ${pinyinWord(rest.slice(head.length))}` : pinyinWord(rest);
  }
  return [name, dir, ord].filter(Boolean).join(' '); // 美術東二路 → Meishu E. 2nd Rd.（郵局寫法）
}

/** 樓層字串（號之後的部分）→ ['1F', 'B1-4F']；遇到下一個「號」即停止 */
function parseFloors(rest) {
  const s = rest
    .replace(/地上/g, '')
    .replace(/地下室/g, 'B1樓')
    .replace(/地下\s*([零〇一二三四五六七八九十\d]+)/g, (m, n) => `B${cnToInt(n) ?? n}`)
    .replace(/[零〇一二三四五六七八九十]+/g, (m) => String(cnToInt(m) ?? m))
    .replace(/[()]/g, ' ');
  const toks = [];
  const re = /\s*(B?\d+|[樓層]|[Ff](?![a-z])|[-~～至]|[、,，及和&]|之\d+|.)/gy;
  let m;
  while ((m = re.exec(s)) && m[0] !== '') {
    const x = m[1];
    if (/^B?\d+$/.test(x)) toks.push(Number(x.replace('B', '')) > 120 ? { t: 'other', v: x } : { t: 'num', v: x }); // 大數字是門牌不是樓層
    else if (/^[樓層Ff]$/.test(x)) toks.push({ t: 'unit' });
    else if (/^[-~～至]$/.test(x)) toks.push({ t: 'range' });
    else if (/^[、,，及和&]$/.test(x)) toks.push({ t: 'sep' });
    else if (/^之\d+$/.test(x)) toks.push({ t: 'sub', v: x.slice(1) });
    else if (/^\s*$/.test(x)) continue;
    else toks.push({ t: 'other', v: x });
    if (re.lastIndex >= s.length) break;
  }
  const fmt = (v) => (v.startsWith('B') ? v : `${v}F`);
  const out = [];
  let group = []; // 待定的樓層：[[a], [a, b]（範圍）]
  let pendingRange = false;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'num') {
      // 「2號」：下一個門牌，停止
      if (toks[k + 1]?.t === 'other' && toks[k + 1].v === '號') break;
      if (pendingRange && group.length) group[group.length - 1].push(t.v);
      else group.push([t.v]);
      pendingRange = false;
    } else if (t.t === 'unit') {
      for (const g of group) out.push(g.length === 2 ? `${fmt(g[0])}-${fmt(g[1])}` : fmt(g[0]));
      group = [];
      if (toks[k + 1]?.t === 'sub' && out.length) { out[out.length - 1] += `-${toks[k + 1].v}`; k++; }
    } else if (t.t === 'range') {
      // 「B2層至4層」：前一組已輸出，把範圍接在最後一個已輸出的樓層後
      if (!group.length && out.length && toks[k + 1]?.t === 'num') {
        const nxt = toks[k + 1].v;
        const unitAfter = toks[k + 2]?.t === 'unit';
        if (unitAfter) { out[out.length - 1] = `${out[out.length - 1]}-${fmt(nxt)}`; k += 2; continue; }
      }
      pendingRange = true;
    } else if (t.t === 'sep') {
      pendingRange = false;
    } else if (t.t === 'other') {
      if (group.length) group = [];
      if (out.length || /[號路街巷弄]/.test(t.v)) break;
    }
  }
  return [...new Set(out)];
}

/**
 * 地址 → 英文（郵局順序）。
 * @param {string} addr 中文地址
 * @param {{city: string, dist: string}} ctx 院所的縣市、行政區（已正規化，以此輸出英文縣市／行政區）
 */
export function romanizeAddress(addr, { city = '', dist = '' } = {}) {
  const c = norm(city);
  const d = norm(dist);
  let s = prep(addr)
    .replace(/^\d{3,6}(-\d+)?\s*/, '') // 郵遞區號
    .replace(/\s+/g, '')
    .replace(/[‐-―−─━]/g, '-') // 各式破折號、框線字元 → -
    .replace(/[～〜]/g, '~')
    .replace(/\([^)\d]*\)/g, '') // 不含數字的括號說明，例如「(巷)」
    // 門牌、巷弄的中文數字：明誠二路五四一號 → 541號、八六二之一號 → 862之1號、二Ｏ八 → 208
    .replace(/(?<=[路街段巷弄道里村鄰之、])([零〇○O0-9一二三四五六七八九十]+)(?=[號之巷弄、])/g,
      (m) => (/[零〇○一二三四五六七八九十O]/.test(m) ? String(cnToInt(m) ?? m) : m));

  // 去掉開頭的縣市、行政區（英文縣市／行政區一律以院所的 city／dist 欄位為準）。
  // 來源偶有舊縣名（桃園縣龜山鄉）、漏字（臺北中山區、東縣臺東市）、異體字（溪洲鄉）。
  const dBare = d.replace(/(區|鄉|鎮|市)$/, '');
  const dIdx = d ? s.indexOf(d) : -1;
  const dOld = dBare.length >= 2 ? s.match(new RegExp(`^.{0,5}?${dBare}[區鄉鎮市]`)) : null;
  if (dIdx >= 0 && dIdx <= 5) s = s.slice(dIdx + d.length);
  else if (dOld) s = s.slice(dOld[0].length);
  else {
    const cityHit = [...Object.keys(CITY_EN), ...OLD_COUNTIES].find((k) => s.startsWith(k));
    if (cityHit) s = s.slice(cityHit.length);
    // 地址中的行政區與院所資料不同（資料本身的不一致）：仍去掉地址中的行政區，英文以院所資料為準
    const known = [...PLACE_FULL.keys()].filter((k) => /[區鄉鎮市]$/.test(k) && !CITY_EN[k] && s.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const other = known ? [known] : s.match(/^[\p{Script=Han}]{1,3}?[區鄉鎮](?![路街巷])(?=[\p{Script=Han}]{2})/u);
    if (other) s = s.slice(other[0].length);
  }
  const p = { village: '', lin: '', road: '', sec: '', lane: '', alley: '', no: '', extra: '' };
  const take = (re, fn) => {
    const m = s.match(re);
    if (!m) return false;
    s = s.slice(m[0].length);
    fn(m);
    return true;
  };
  const num = (x) => String(cnToInt(x) ?? x);

  // 村里（「蜈蚣里」「仁里村」；後面必須還有門牌或路名，避免把「萬里路」當成村里）
  const vil = s.match(/^([\p{Script=Han}]{1,3})([里村])(?!路|街|大道|巷|段)(?=[\p{Script=Han}\d])/u);
  if (vil && /[號路街巷弄鄰\d]/.test(s.slice(vil[0].length))) {
    p.village = `${pinyinWord(vil[1])} Village`;
    s = s.slice(vil[0].length);
  }
  take(/^([零〇一二三四五六七八九十\d]+)鄰/, (m) => { p.lin = `Neighborhood ${num(m[1])}`; });
  // 路／街／大道（路名可含阿拉伯數字序數：光明1路、東橋10街）
  take(/^([^\d()、,，]+?\d{0,2})(大道|路|街)/, (m) => {
    // 「科學園區力行一路」「祥和新村祥和二路」：園區／新村名稱另列，不併入路名
    const area = m[1].match(/^(.+?(?:科學園區|園區|新村|新邨|社區))(.+)$/);
    if (area) p.extra = area[1].endsWith('科學園區') ? 'Science Park' : roadCore(area[1], c);
    p.road = `${roadCore(area ? area[2] : m[1], c)} ${ROAD_TYPE[m[2]]}`;
  });
  take(/^([零〇一二三四五六七八九十\d]+)段/, (m) => { p.sec = `Sec. ${num(m[1])}`; }) ||
    take(/^([\p{Script=Han}]{1,3}?)([一二三四五六七八九十]{0,2})段/u, (m) => { // 「芳苑段」「斗苑五段」
      p.sec = `${pinyinWord(m[1])} Sec.${m[2] ? ` ${cnToInt(m[2])}` : ''}`;
    });
  // 路名之後夾雜的鄰、村里、多打的「號」「臨」（健康路十三鄰143號、福建路安樂里72號、彰南路4段臨201號）
  take(/^[零〇一二三四五六七八九十\d]+鄰(?=\d)/, () => {});
  if (p.road) take(/^[\p{Script=Han}]{1,3}[里村](?=\d)/u, () => {});
  take(/^[號臨](?=\d)/, () => {});
  take(/^(\d+(?:之\d+)?|[\p{Script=Han}]{1,4}?)巷/u, (m) => {
    p.lane = /^\d/.test(m[1]) ? `Ln. ${m[1].replace('之', '-')}` : `${roadCore(m[1], c)} Ln.`;
  });
  take(/^(\d+(?:之\d+)?)[弄衖]/, (m) => { p.alley = `Aly. ${m[1].replace('之', '-')}`; });
  // 沒有路名的鄉村地址：「石麻園38號」「石平25鄰51之1號」—— 地名轉拼音
  if (!p.road) {
    take(/^([\p{Script=Han}]+?)(?=\d)/u, (m) => { p.extra = roadCore(m[1], c); });
    if (!p.lin) take(/^(\d+)鄰/, (m) => { p.lin = `Neighborhood ${m[1]}`; });
  }
  // 門牌：「19、21、21-1號」「240之7號」「5號之1」「1002之12,1樓」（缺「號」）
  const no = s.match(/^(\d+(?:[之-]\d+)?(?:[、,，及和]\d+(?:[之-]\d+)?)*)(號(?:之(\d+))?)?/);
  if (no) {
    const list = no[1].split(/[、,，及和]/);
    s = s.slice(no[0].length);
    // 缺「號」且最後一段緊接樓層（1002之12,1樓）：最後一段是樓層，不是門牌
    if (!no[2] && list.length > 1 && /^[樓層Ff]/.test(s)) s = list.pop() + s;
    p.no = `No. ${list.map((x) => x.replace(/之/g, '-')).join(', ')}${no[3] ? `-${no[3]}` : ''}`;
  } else if (!p.road && !p.extra) {
    take(/^[\p{Script=Han}]+/u, (m) => { p.extra = pinyinWord(m[0]); });
  }
  const floors = parseFloors(s);

  const out = [
    floors.join(', '),
    p.no, p.alley, p.lane, p.sec, p.road, p.extra,
    p.road ? '' : p.lin,
    p.road ? '' : p.village,
    distEn(c, d),
    cityEn(c),
  ].filter(Boolean);
  return asciiClean(out.join(', '));
}

/** 一筆院所的四個英文欄位 */
export function romanizeHospital(h) {
  const str = (v) => (typeof v === 'string' ? v : ''); // 來源欄位型別不可信
  const [name, addr, city, dist] = [str(h?.name), str(h?.addr), str(h?.city), str(h?.dist)];
  return {
    nameEn: romanizeName(name, { city }),
    addrEn: romanizeAddress(addr, { city, dist }),
    // 無法判定縣市／行政區的院所（normalize.mjs 會另外警告）：退回拼音或 Taiwan，確保欄位不為空
    cityEn: cityEn(city) || asciiClean(pinyinWord(city)) || 'Taiwan',
    distEn: distEn(city, dist) || cityEn(city) || asciiClean(pinyinWord(city)) || 'Taiwan',
  };
}
