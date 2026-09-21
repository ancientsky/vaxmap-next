// 資料來源 adapter。之後改接即時 API 時只需替換此檔，輸出同樣的結構
// （見 docs/DATA_SCHEMA.md）：{ meta, vaccines, groups, hospitals }。

const DATA_URL = './data/hospitals.json';

export async function loadData({ signal } = {}) {
  const res = await fetch(DATA_URL, { signal, cache: 'no-cache' });
  if (!res.ok) throw new Error(`資料載入失敗（HTTP ${res.status}）`);
  const data = await res.json();
  if (!data || !Array.isArray(data.hospitals) || !Array.isArray(data.vaccines)) {
    throw new Error('資料格式不正確');
  }
  // 最後一道防線：欄位型別不對的紀錄直接捨棄，避免單筆壞資料讓整個畫面壞掉
  const s = (v) => typeof v === 'string';
  data.vaccines = data.vaccines.filter((v) => v && s(v.id) && s(v.group) && s(v.name) && s(v.short));
  data.groups = (Array.isArray(data.groups) ? data.groups : []).filter((g) => g && s(g.id) && s(g.name));
  data.hospitals = data.hospitals.filter((h) => h && Number.isSafeInteger(h.id) && s(h.name) && s(h.addr) && s(h.tel)
    && s(h.city) && s(h.dist) && Number.isFinite(h.lat) && Number.isFinite(h.lng) && Array.isArray(h.hours)
    && h.stock && typeof h.stock === 'object' && !Array.isArray(h.stock)
    && [h.code, h.apptUrl, h.apptTel, h.note].every((v) => v === undefined || s(v)));
  return data;
}
