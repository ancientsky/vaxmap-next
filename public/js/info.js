// 接種資訊頁（info.html）：載入 public/data/info/<lang>.json（見 docs/INFO_SCHEMA.md）並以 DOM API 繪製。
// 網址：info.html#<錨點>[&lang=<語系>]，例如 #coins、#eligibility&lang=en；錨點也可用來源卡片 id（#103106）。
import { initI18n, t, tParts, setLang, getLang, onLangChange, formatTaipeiL } from './i18n.js';
import { DEFAULT_LANG } from './logic.js';
import { el } from './ui.js';
import { normalizeInfo, parseInfoHash, buildInfoHash, findSection, noBreakHyphen } from './info-parse.js';
import { sectionCard, tocItems, extLink, fmtDate, svgIcon } from './info-render.js';
import { navHref } from './nav.js';

const $ = (id) => document.getElementById(id);
const dom = {
  title: $('info-title'),
  meta: $('info-meta'),
  notice: $('info-notice'),
  status: $('info-status'),
  sections: $('info-sections'),
  toc: $('toc'),
  tocList: $('toc-list'),
  langSelect: $('lang-select'),
  footSource: $('footer-source'),
  footSynced: $('footer-synced'),
  footHotline: $('footer-hotline'),
};

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let current = null; // { data, lang, fallback }
let loadSeq = 0;
let activeAnchor = null;

/* ---------------- 資料 ---------------- */

async function fetchInfo(lang) {
  const res = await fetch(`data/info/${encodeURIComponent(lang)}.json`, { cache: 'no-cache' });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = normalizeInfo(await res.json());
  if (!data) throw new Error('format');
  return data;
}

/** 目前語系的檔案；沒有時退回繁中原文（fallback=true） */
async function loadInfo(lang) {
  try {
    return { data: await fetchInfo(lang), lang, fallback: false };
  } catch (e) {
    if (lang === DEFAULT_LANG) throw e;
    console.warn(`[info] ${lang}: ${e.message}; falling back to ${DEFAULT_LANG}`);
    return { data: await fetchInfo(DEFAULT_LANG), lang: DEFAULT_LANG, fallback: true };
  }
}

/* ---------------- 狀態 ---------------- */

function setState(state) {
  document.body.dataset.state = state;
}

function showLoading() {
  setState('loading');
  dom.status.hidden = false;
  dom.status.replaceChildren(el('p', { class: 'info__loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), t('info.loading')));
}

function showError(e) {
  setState('error');
  dom.sections.replaceChildren();
  dom.toc.hidden = true;
  dom.status.hidden = false;
  dom.status.replaceChildren(el('div', { class: 'info__error' },
    svgIcon('alert', 'ic info__error-ic'),
    el('div', null,
      el('p', { class: 'info__error-t', text: t('info.error.title') }),
      el('p', { text: t('error.body') }),
      e && e.message ? el('p', { class: 'info__error-d', text: t('error.detail', { message: e.message }) }) : null,
      el('p', { class: 'info__error-actions' },
        el('button', { type: 'button', class: 'btn btn--primary', onclick: () => start(getLang()) }, t('error.retry')),
        extLink(SOURCE_FALLBACK, t('info.more'), { class: 'btn' })))));
}

const SOURCE_FALLBACK = 'https://www.cdc.gov.tw/Category/MPage/S_ZLz0yyc2lAQ9TStMB0uA';

/* ---------------- 繪製 ---------------- */

function mapHref(extra) {
  return navHref('map', getLang(), extra);
}

function render() {
  const { data, fallback } = current;
  const uiLang = getLang();
  const { meta, sections } = data;
  const nonZhUi = uiLang !== DEFAULT_LANG;
  const allUntranslated = fallback || (nonZhUi && sections.length > 0 && sections.every((s) => !s.translated));

  // 標題：資料的 meta.title（翻譯後）；若與原文相同且介面不是中文 → 標示為中文
  const title = meta.title || meta.sourceTitle || t('info.title');
  dom.title.textContent = noBreakHyphen(title);
  if (nonZhUi && (fallback || title === meta.sourceTitle)) dom.title.setAttribute('lang', 'zh-Hant-TW');
  else dom.title.removeAttribute('lang');

  // 來源、最後更新、本站同步時間
  const sourceUrl = meta.sourceUrl || SOURCE_FALLBACK;
  const metaParts = [extLink(sourceUrl, t('info.source'), { class: 'info__src' })];
  if (meta.changedAt) metaParts.push(el('span', null, tParts('info.updated', { date: el('time', { datetime: meta.changedAt.toISOString().slice(0, 10), text: fmtDate(meta.changedAt) }) })));
  if (meta.fetchedAt) metaParts.push(el('span', null, t('info.synced', { time: formatTaipeiL(meta.fetchedAt.toISOString()) })));
  dom.meta.replaceChildren(...metaParts.flatMap((n, i) => (i ? [el('span', { class: 'dot', 'aria-hidden': 'true', text: '·' }), n] : [n])));

  // 頁面層級的提示：整份未翻譯（或此語言沒有檔案）／機器翻譯
  let notice = null;
  if (allUntranslated) notice = [svgIcon('translate', 'ic'), el('span', { text: t(fallback ? 'info.fallbackLang' : 'info.untranslatedAll') })];
  else if (nonZhUi) notice = [svgIcon('translate', 'ic'), el('span', { text: t('info.machine') })];
  dom.notice.hidden = !notice;
  dom.notice.classList.toggle('is-warn', !!allUntranslated);
  if (notice) dom.notice.replaceChildren(...notice);

  // 區塊
  const cards = sections.map((s) => {
    const untranslated = nonZhUi && (fallback || !s.translated);
    return sectionCard(s, {
      contentLang: untranslated ? 'zh' : null,
      showNotice: untranslated && !allUntranslated,
      sourceUrl,
      mapHref,
    });
  });
  dom.sections.replaceChildren(...cards);
  dom.tocList.replaceChildren(...tocItems(sections));
  dom.toc.hidden = sections.length < 2;

  if (!sections.length) {
    setState('empty');
    dom.status.hidden = false;
    dom.status.replaceChildren(el('p', { class: 'info__empty' }, t('info.empty'), ' ', extLink(sourceUrl, t('info.more'), { class: 'ilink' })));
  } else {
    dom.status.hidden = true;
    dom.status.replaceChildren();
    setState('ready');
  }

  // 頁尾
  dom.footSource.replaceChildren(extLink(sourceUrl, [
    t('info.more'),
    meta.sourceTitle ? el('span', { class: 'info-footer__src', lang: nonZhUi ? 'zh-Hant-TW' : null, text: `「${meta.sourceTitle}」` }) : null,
  ], { class: 'ilink' }));
  dom.footSynced.textContent = meta.fetchedAt ? t('info.synced', { time: formatTaipeiL(meta.fetchedAt.toISOString()) }) : '';
  dom.footHotline.replaceChildren(...tParts('detail.hotline', { tel: el('a', { href: 'tel:1922', class: 'ilink', text: '1922' }) }));

  observeSections();
}

/* ---------------- 捲動、chip 列、目前區塊 ---------------- */

function tocHeight() {
  return dom.toc.hidden ? 0 : dom.toc.getBoundingClientRect().height;
}

function syncTocHeight() {
  document.documentElement.style.setProperty('--toc-h', `${Math.round(tocHeight())}px`);
}

function setActive(anchor) {
  if (!anchor || anchor === activeAnchor) return;
  activeAnchor = anchor;
  let chip = null;
  for (const a of dom.tocList.querySelectorAll('.toc__chip')) {
    const on = a.dataset.anchor === anchor;
    if (on) { a.setAttribute('aria-current', 'location'); chip = a; } else a.removeAttribute('aria-current');
  }
  // 只捲動 chip 列本身（水平），不動整頁
  if (chip) {
    const box = dom.tocList;
    const left = chip.offsetLeft - (box.clientWidth - chip.offsetWidth) / 2;
    box.scrollTo({ left: Math.max(0, left), behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
}

// 目前區塊（scroll-spy）：上緣已捲過 chip 列的最後一個區塊；捲到頁底時為最後一個已進入畫面的區塊。
// 由 chip／網址捲動時先鎖定目標，避免平滑捲動途中或頁底無法再捲時被改成別的區塊。
let spyLock = null; // { anchor, until }
let spyQueued = false;

function computeActive() {
  const secs = dom.sections.querySelectorAll('.isec');
  if (!secs.length) return;
  if (spyLock && performance.now() < spyLock.until) return;
  const line = tocHeight() + 24;
  let pick = secs[0];
  for (const s of secs) {
    if (s.getBoundingClientRect().top <= line) pick = s; else break;
  }
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  if (atBottom) {
    if (spyLock && document.getElementById(spyLock.anchor)) return; // 頁底：維持剛才跳轉的區塊
    for (const s of secs) if (s.getBoundingClientRect().top < window.innerHeight * 0.6) pick = s;
  }
  spyLock = null;
  setActive(pick.id);
}

function onScrollSpy() {
  if (spyQueued) return;
  spyQueued = true;
  requestAnimationFrame(() => { spyQueued = false; computeActive(); });
}

function observeSections() {
  activeAnchor = null;
  spyLock = null;
  computeActive();
}

window.addEventListener('scroll', onScrollSpy, { passive: true });
// 捲動結束就解除時間鎖（頁底時仍保留剛才跳轉的區塊）
window.addEventListener('scrollend', () => { if (spyLock) spyLock.until = 0; onScrollSpy(); }, { passive: true });
window.addEventListener('wheel', () => { spyLock = null; }, { passive: true });
window.addEventListener('touchmove', () => { spyLock = null; }, { passive: true });
window.addEventListener('keydown', (e) => { if (/^(Arrow|Page|Home|End| )/.test(e.key)) spyLock = null; });

function scrollToSection(anchor, { focus = false, smooth = true } = {}) {
  if (!current) return false;
  const s = findSection(current.data.sections, anchor);
  const node = s && document.getElementById(s.anchor);
  if (!node) return false;
  syncTocHeight();
  node.scrollIntoView({ behavior: smooth && !reducedMotion() ? 'smooth' : 'auto', block: 'start' });
  if (focus) node.querySelector('h2')?.focus({ preventScroll: true });
  spyLock = { anchor: s.anchor, until: performance.now() + 1200 };
  activeAnchor = null;
  setActive(s.anchor);
  return s.anchor;
}

function writeHash(section) {
  const h = buildInfoHash({ section, lang: getLang(), defaultLang: DEFAULT_LANG });
  const url = h ? `#${h}` : `${location.pathname}${location.search}`;
  try { history.replaceState(null, '', url); } catch { /* file:// 等環境 */ }
}

dom.tocList.addEventListener('click', (ev) => {
  const a = ev.target.closest('a.toc__chip');
  if (!a) return;
  ev.preventDefault();
  const anchor = scrollToSection(a.dataset.anchor, { focus: true });
  if (anchor) writeHash(anchor);
});

window.addEventListener('hashchange', () => {
  const { section, lang } = parseInfoHash(location.hash);
  if (lang && lang !== getLang()) { setLang(lang, { persist: false }); return; } // onLanguageChanged 會重繪並捲動
  if (section) scrollToSection(section, { focus: true });
});

if ('ResizeObserver' in window) new ResizeObserver(syncTocHeight).observe(dom.toc);

/* ---------------- 啟動與語系切換 ---------------- */

async function start(lang, { keepAnchor = null } = {}) {
  const seq = ++loadSeq;
  if (!current) showLoading();
  else document.body.setAttribute('aria-busy', 'true');
  try {
    const loaded = await loadInfo(lang);
    if (seq !== loadSeq) return; // 已有較新的請求
    current = loaded;
    render();
    syncTocHeight();
    const want = keepAnchor || parseInfoHash(location.hash).section;
    if (want) requestAnimationFrame(() => scrollToSection(want, { smooth: false }));
  } catch (e) {
    if (seq !== loadSeq) return;
    console.error(e);
    current = null;
    showError(e);
  } finally {
    if (seq === loadSeq) document.body.removeAttribute('aria-busy');
  }
}

dom.langSelect.addEventListener('change', () => { setLang(dom.langSelect.value); });

onLangChange((lang) => {
  dom.langSelect.value = lang;
  const keep = activeAnchor && window.scrollY > 40 ? activeAnchor : null;
  // 網址已帶有 hash（分享連結）時同步更新其中的 lang
  if (location.hash) writeHash(parseInfoHash(location.hash).section);
  start(lang, { keepAnchor: keep });
});

initI18n().then((lang) => {
  dom.langSelect.value = lang;
  start(lang);
});
