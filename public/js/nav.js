// 頁首導覽（地圖｜接種資訊）：兩頁共用。切換頁面時帶上目前語系（#lang=），
// 讓從分享連結（#lang=en，不寫入 localStorage）進來的人換頁後仍是同一種語言。
// 只觀察 <html data-lang>（i18n.js 的 applyDocument 會設定），不依賴 app.js／info.js 的內部狀態。
import { DEFAULT_LANG } from './logic.js';

const PAGES = { map: './index.html', info: './info.html' };

export function navHref(page, lang, extra = '') {
  const base = PAGES[page] || PAGES.map;
  const parts = [];
  if (extra) parts.push(extra);
  if (lang && lang !== DEFAULT_LANG) parts.push(`lang=${encodeURIComponent(lang)}`);
  return parts.length ? `${base}#${parts.join('&')}` : base;
}

function update() {
  const lang = document.documentElement.dataset.lang || DEFAULT_LANG;
  for (const a of document.querySelectorAll('a[data-nav]')) {
    a.setAttribute('href', navHref(a.dataset.nav, lang));
  }
}

if (typeof document !== 'undefined') {
  update();
  new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ['data-lang'] });
}
