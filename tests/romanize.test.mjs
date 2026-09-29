// 英文（拉丁字母）轉寫：scripts/romanize.mjs 的人工核對範例與邊界情況。
// 執行：node --test tests/romanize.test.mjs
// 範例皆經人工核對（官方英文名稱、郵局英文地址寫法）；修改規則後若輸出改變，請確認新輸出仍合理再更新這裡。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  romanizeName, romanizeAddress, romanizeHospital, cityEn, distEn, cnToInt, pinyinWord, asciiClean,
} from '../scripts/romanize.mjs';

const ASCII = /^[A-Za-z0-9 '.,\-()]+$/;

/* ---------------- 名稱 ---------------- */

const NAMES = [
  // [中文, 縣市, 預期英文]
  ['林文正耳鼻喉科診所', '臺北市', 'Linwenzheng ENT Clinic'],
  ['高雄市立聯合醫院', '高雄市', 'Kaohsiung Municipal United Hospital'],
  ['國立臺灣大學醫學院附設醫院', '臺北市', 'National Taiwan University Hospital'],
  ['國立臺灣大學醫學院附設醫院新竹臺大分院生醫醫院', '新竹縣', 'National Taiwan University Hospital Hsinchu Branch Biomedical Hospital'],
  ['國立成功大學醫學院附設醫院斗六分院', '雲林縣', 'National Cheng Kung University Hospital Douliu Branch'],
  ['長庚醫療財團法人林口長庚紀念醫院', '桃園市', 'Linkou Chang Gung Memorial Hospital'],
  ['臺北榮民總醫院', '臺北市', 'Taipei Veterans General Hospital'],
  ['三軍總醫院北投分院附設民眾診療服務處', '臺北市', 'Tri-Service General Hospital Beitou Branch Civilian Clinic'],
  ['國軍高雄總醫院岡山分院附設民眾診療服務處', '高雄市', 'Kaohsiung Armed Forces General Hospital Gangshan Branch Civilian Clinic'],
  ['衛生福利部桃園醫院新屋分院', '桃園市', 'Taoyuan Hospital Xinwu Branch, Ministry of Health and Welfare'],
  ['財團法人私立高雄醫學大學附設中和紀念醫院', '高雄市', 'Kaohsiung Medical University Chung-Ho Memorial Hospital'],
  ['中國醫藥大學新竹附設醫院', '新竹縣', 'China Medical University Hsinchu Hospital'],
  ['臺北市立聯合醫院仁愛院區', '臺北市', "Taipei City Hospital Ren'ai Branch"],
  ['臺北市立聯合醫院附設松山門診部', '臺北市', 'Taipei City Hospital Songshan Outpatient Department'],
  ['佛教慈濟醫療財團法人台北慈濟醫院', '新北市', 'Taipei Tzu Chi Hospital'],
  ['台灣基督長老教會馬偕醫療財團法人淡水馬偕紀念醫院', '新北市', 'Tamsui MacKay Memorial Hospital'],
  ['新竹市立馬偕兒童醫院(委託台灣基督長老教會馬偕醫療財團法人興建經營)', '新竹市', "Hsinchu Municipal MacKay Children's Hospital"],
  ['臺北市立萬芳醫院委託財團法人臺北醫學大學辦理', '臺北市', 'Taipei Municipal Wan Fang Hospital'],
  // 衛生所：縣市、行政區用官方英文（淡水 → Tamsui，不是拼音 Danshui）
  ['新北市淡水區衛生所', '新北市', 'New Taipei City Tamsui District Public Health Center'],
  ['台東縣台東巿衛生所', '臺東縣', 'Taitung County Taitung City Public Health Center'], // 台、巿（U+5DFF）異體
  ['澎湖縣馬公市第一衛生所', '澎湖縣', 'Penghu County Magong City First Public Health Center'],
  ['連江縣立醫院', '連江縣', 'Lienchiang County Hospital'],
  // 名稱開頭的地名用官方拼法；人名中間的地名不拆（陳大安 ≠ 陳 + 大安區）
  ['大安婦幼醫院', '臺北市', "Da'an Women and Children's Hospital"],
  ['陳大安診所', '臺北市', "Chenda'an Clinic"],
  // 姓氏讀音、ü → yu
  ['曾政峰耳鼻喉科診所', '高雄市', 'Zengzhengfeng ENT Clinic'],
  ['呂怡璋小兒科診所', '臺南市', 'Lyuyizhang Pediatric Clinic'],
  // 括號內的聯合診所名稱也轉寫
  ['康庭小兒科診所（樂恩聯合診所）', '臺中市', "Kangting Pediatric Clinic (Le'en United Clinic)"],
  ['建良耳鼻喉科診所(新)', '新北市', 'Jianliang ENT Clinic (New)'],
  // 品牌在名稱中間也辨識
  ['本堂澄清醫院', '臺中市', 'Bentang Cheng Ching Hospital'],
  ['吳昆哲婦產小兒科醫院', '桃園市', 'Wukunzhe OB-GYN Pediatric Hospital'],
];

for (const [zh, city, want] of NAMES) {
  test(`name: ${zh}`, () => assert.equal(romanizeName(zh, { city }), want));
}

/* ---------------- 地址 ---------------- */

const ADDRS = [
  // [中文, 縣市, 行政區, 預期英文]
  ['臺北市北投區明德路92號1樓', '臺北市', '北投區', '1F, No. 92, Mingde Rd., Beitou District, Taipei City'],
  ['臺北市松山區南京東路5段251巷24弄27號', '臺北市', '松山區', 'No. 27, Aly. 24, Ln. 251, Sec. 5, Nanjing E. Rd., Songshan District, Taipei City'],
  ['臺南市安南區長和路二段66號', '臺南市', '安南區', 'No. 66, Sec. 2, Changhe Rd., Annan District, Tainan City'], // 段：中文數字
  ['高雄市鼓山區中華一路976號', '高雄市', '鼓山區', 'No. 976, Zhonghua 1st Rd., Gushan District, Kaohsiung City'], // 序數路名
  ['高雄市鼓山區美術東二路177號地下2樓-11樓', '高雄市', '鼓山區', 'B2-11F, No. 177, Meishu E. 2nd Rd., Gushan District, Kaohsiung City'],
  ['新竹縣竹北市光明1路392之1號', '新竹縣', '竹北市', 'No. 392-1, Guangming 1st Rd., Zhubei City, Hsinchu County'],
  // 之
  ['新北市永和區中正路455之1號', '新北市', '永和區', 'No. 455-1, Zhongzheng Rd., Yonghe District, New Taipei City'],
  ['臺北市內湖區民權東路6段99號之1(1樓)', '臺北市', '內湖區', '1F, No. 99-1, Sec. 6, Minquan E. Rd., Neihu District, Taipei City'],
  ['臺北市大安區忠孝東路4段250號2樓之1', '臺北市', '大安區', "2F-1, No. 250, Sec. 4, Zhongxiao E. Rd., Da'an District, Taipei City"],
  // 地下、多樓層
  ['高雄市路竹區中山路627號地下2層至地上4層', '高雄市', '路竹區', 'B2-4F, No. 627, Zhongshan Rd., Luzhu District, Kaohsiung City'],
  ['新北市泰山區貴子路69號(地下4層、地上1至13層、15層)', '新北市', '泰山區', 'B4, 1F-13F, 15F, No. 69, Guizi Rd., Taishan District, New Taipei City'],
  ['臺中市北區漢口路四段322號1樓、2樓', '臺中市', '北區', '1F, 2F, No. 322, Sec. 4, Hankou Rd., North District, Taichung City'],
  ['基隆市七堵區光明路21號1樓之1、2樓', '基隆市', '七堵區', '1F-1, 2F, No. 21, Guangming Rd., Qidu District, Keelung City'],
  ['臺南市中西區中山路19、21、21-1號1樓', '臺南市', '中西區', '1F, No. 19, 21, 21-1, Zhongshan Rd., Zhongxi District, Tainan City'],
  ['高雄市楠梓區德民路1002之12,1樓', '高雄市', '楠梓區', '1F, No. 1002-12, Demin Rd., Nanzi District, Kaohsiung City'], // 缺「號」
  // 門牌、樓層用中文數字（含 Ｏ）
  ['高雄市楠梓區後昌路八六二之一號一樓', '高雄市', '楠梓區', '1F, No. 862-1, Houchang Rd., Nanzi District, Kaohsiung City'],
  ['臺中市西屯區大墩十九街二Ｏ八之一號一樓、二Ｏ八之二號一樓', '臺中市', '西屯區', '1F, No. 208-1, Dadun 19th St., Xitun District, Taichung City'],
  // 慣用英文路名、以地名命名的路
  ['臺北市中正區羅斯福路1段1號', '臺北市', '中正區', 'No. 1, Sec. 1, Roosevelt Rd., Zhongzheng District, Taipei City'],
  ['臺北市信義區基隆路1段1號', '臺北市', '信義區', 'No. 1, Sec. 1, Keelung Rd., Xinyi District, Taipei City'],
  ['新北市淡水區淡水路1號', '新北市', '淡水區', 'No. 1, Tamsui Rd., Tamsui District, New Taipei City'],
  ['臺北市北投區北投路2段1號', '臺北市', '北投區', 'No. 1, Sec. 2, Beitou Rd., Beitou District, Taipei City'],
  ['臺中市西屯區臺灣大道三段99號', '臺中市', '西屯區', 'No. 99, Sec. 3, Taiwan Blvd., Xitun District, Taichung City'],
  ['臺北市大安區仁愛路4段1號', '臺北市', '大安區', "No. 1, Sec. 4, Ren'ai Rd., Da'an District, Taipei City"],
  // 村里、鄰：有路名時略去，沒有路名時保留
  ['南投縣埔里鎮蜈蚣里榮光路1號', '南投縣', '埔里鎮', 'No. 1, Rongguang Rd., Puli Township, Nantou County'],
  ['苗栗縣造橋鄉造橋村14鄰8-2號', '苗栗縣', '造橋鄉', 'No. 8-2, Neighborhood 14, Zaoqiao Village, Zaoqiao Township, Miaoli County'],
  // 舊縣名、漏寫縣市
  ['桃園縣龜山鄉萬壽路二段988號', '桃園市', '龜山區', 'No. 988, Sec. 2, Wanshou Rd., Guishan District, Taoyuan City'],
  ['臺北中山區林森北路530號', '臺北市', '中山區', 'No. 530, Linsen N. Rd., Zhongshan District, Taipei City'],
];

for (const [zh, city, dist, want] of ADDRS) {
  test(`addr: ${zh}`, () => assert.equal(romanizeAddress(zh, { city, dist }), want));
}

/* ---------------- 縣市、行政區與工具 ---------------- */

test('cityEn / distEn come from data/districts-en.json (never pinyin)', () => {
  assert.equal(cityEn('臺北市'), 'Taipei City');
  assert.equal(cityEn('台北市'), 'Taipei City'); // 台 → 臺
  assert.equal(cityEn('基隆市'), 'Keelung City'); // 拼音會是 Jilong
  assert.equal(distEn('新北市', '淡水區'), 'Tamsui District'); // 拼音會是 Danshui
  assert.equal(distEn('臺中市', '東區'), 'East District');
  assert.equal(distEn('嘉義縣', '阿里山鄉'), 'Alishan Township');
  assert.equal(cityEn('火星市'), '');
});

test('cnToInt: Chinese numerals incl. digit-by-digit and mixed forms', () => {
  assert.equal(cnToInt('一'), 1);
  assert.equal(cnToInt('十'), 10);
  assert.equal(cnToInt('十九'), 19);
  assert.equal(cnToInt('二十'), 20);
  assert.equal(cnToInt('五四一'), 541);
  assert.equal(cnToInt('二Ｏ八'.normalize('NFKC')), 208);
  assert.equal(cnToInt('八0七'), 807);
  assert.equal(cnToInt('12'), 12);
  assert.equal(cnToInt('中'), null);
});

test("pinyinWord: syllables joined, apostrophe before a/o/e, capitalised", () => {
  assert.equal(pinyinWord('仁愛'), "Ren'ai");
  assert.equal(pinyinWord('林文正'), 'Linwenzheng');
  assert.equal(pinyinWord('重慶'), 'Chongqing'); // 繁體多音詞補正
});

test('asciiClean strips everything outside the whitelist', () => {
  assert.equal(asciiClean('Tiếng  Việt , (x)'), 'Tieng Viet, (x)');
  assert.equal(asciiClean('a/b<c>'), 'a b c');
});

test('romanizeHospital returns the four fields, ASCII only, deterministic', () => {
  const h = { name: '林文正耳鼻喉科診所', addr: '臺北市北投區明德路92號1樓', city: '臺北市', dist: '北投區' };
  const r = romanizeHospital(h);
  assert.deepEqual(r, {
    nameEn: 'Linwenzheng ENT Clinic',
    addrEn: '1F, No. 92, Mingde Rd., Beitou District, Taipei City',
    cityEn: 'Taipei City',
    distEn: 'Beitou District',
  });
  assert.deepEqual(romanizeHospital(h), r);
  for (const v of Object.values(r)) assert.match(v, ASCII);
});

test('hostile / degenerate input still yields non-empty ASCII', () => {
  for (const name of ['<img src=x onerror=alert(1)>診所', '???', '', '‮診所', 'ABC診所']) {
    const s = romanizeName(name, { city: '臺北市' });
    assert.ok(s.length > 0, JSON.stringify(name));
    assert.match(s, ASCII);
  }
  const a = romanizeAddress('一些無法解析的文字', { city: '臺北市', dist: '北投區' });
  assert.match(a, ASCII);
  assert.ok(a.endsWith('Beitou District, Taipei City'));
});
