// Trusted Types 預設政策：只放行 Leaflet 與 map.js 會寫進 innerHTML 的「固定字串」，其餘一律擋下。
// 作用：即使日後有人不小心把資料字串丟進 innerHTML / bindPopup（Leaflet CVE-2025-69993 那一類問題），
// 支援 Trusted Types 的瀏覽器也會直接拒絕。不支援的瀏覽器會忽略這個機制，不影響功能。
// 注意：map.js 若新增或修改 divIcon 的 html、或底圖的 attribution 字串，必須同步加到下面的 ALLOW，
// 否則該圖示會壞掉、主控台會出現 Trusted Types 違規（e2e 測試會因此失敗，藉此提醒）。
(function () {
  if (!window.trustedTypes || !window.trustedTypes.createPolicy) return;
  var mk = function (g) { return '<span class="mk__b"><span class="mk__g" aria-hidden="true">' + g + '</span></span>'; };
  var ALLOW = ['', '<svg/>',
    '<a href="https://leafletjs.com" title="A JavaScript library for interactive maps"><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="12" height="8" viewBox="0 0 12 8" class="leaflet-attribution-flag"><path fill="#4C7BE1" d="M0 0h12v4H0z"/><path fill="#FFD500" d="M0 4h12v3H0z"/><path fill="#E0BC00" d="M0 7h12v1H0z"/></svg> Leaflet</a>',
    '<span aria-hidden="true">+</span>', '<span aria-hidden="true">&#x2212;</span>',
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> 貢獻者',
    '© 內政部國土測繪中心', mk('✓'), mk('–'), mk('休'),
    '<span class="me-dot__p"></span><span class="me-dot__c"></span>'];
  var ok = Object.create(null);
  ALLOW.forEach(function (s) { ok[s] = true; });
  window.trustedTypes.createPolicy('default', { createHTML: function (s) { return ok[s] === true ? s : null; } });
})();
