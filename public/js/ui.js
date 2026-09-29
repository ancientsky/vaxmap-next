// DOM 產生器：所有資料字串一律經由 textContent / 屬性設定，不使用 innerHTML。
import { PERIODS, WEEKDAY_IDS } from './logic.js';
import { t, tParts, tVaccine, formatDistanceL, closedGlyph, fmtNum as fmtNumL, displayParts, displayArea } from './i18n.js';

/** el('div', {class:'x', onclick: fn, 'aria-label': '…'}, child, 'text', …) */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 簡單的 inline SVG 圖示（路徑為程式內常數，非資料） */
export function icon(name) {
  const paths = {
    phone: 'M6.6 10.8a15.1 15.1 0 006.6 6.6l2.2-2.2a1 1 0 011-.25 11.4 11.4 0 003.6.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.25 1z',
    nav: 'M21.7 11.3l-9-9a1 1 0 00-1.4 0l-9 9a1 1 0 000 1.4l9 9a1 1 0 001.4 0l9-9a1 1 0 000-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 011-1h5V7.5l3.5 3.5z',
    link: 'M10.6 13.4a1 1 0 010-1.4l3.5-3.5a3 3 0 114.2 4.2l-2 2a1 1 0 01-1.4-1.4l2-2a1 1 0 10-1.4-1.4L12 13.4a1 1 0 01-1.4 0zM13.4 10.6a1 1 0 010 1.4l-3.5 3.5a3 3 0 11-4.2-4.2l2-2a1 1 0 011.4 1.4l-2 2a1 1 0 101.4 1.4L12 10.6a1 1 0 011.4 0z',
    cal: 'M7 2a1 1 0 011 1v1h8V3a1 1 0 112 0v1h1a2 2 0 012 2v13a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h1V3a1 1 0 011-1zm12 8H5v9h14z',
  };
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', paths[name] || '');
  p.setAttribute('fill', 'currentColor');
  svg.appendChild(p);
  return svg;
}

// 狀態文字依目前語系即時取得（getter），切換語系後不需重新 import
const statusEntry = (id, glyph) => ({
  get glyph() { return typeof glyph === 'function' ? glyph() : glyph; },
  get text() { return t(`status.${id}.text`); },
  get long() { return t(`status.${id}.long`); },
});
export const STATUS = {
  ok: statusEntry('ok', '✓'),
  nostock: statusEntry('nostock', '–'),
  closed: statusEntry('closed', closedGlyph),
};

export function statusBadge(status) {
  const s = STATUS[status];
  return el('span', { class: `badge badge--${status}` },
    el('span', { class: 'badge__g', 'aria-hidden': 'true' }, el('span', { text: s.glyph })),
    s.text);
}

export function fmtNum(n) {
  return fmtNumL(n);
}

/** 品項在畫面上的名稱（繁中用資料檔，其他語系用語系檔） */
export const vName = (v) => tVaccine(v.id, 'name', v.name);
export const vShort = (v) => tVaccine(v.id, 'short', v.short);

/** 今日時段 pills：填滿 = 有看診（●），虛線 = 休（○）。文字不只靠顏色。 */
export function sessionPills(bits, currentBit) {
  const frag = [];
  const spoken = [];
  for (const p of PERIODS) {
    const on = (bits & p.bit) !== 0;
    const now = on && p.bit === currentBit;
    const label = t(`period.${p.id}`);
    spoken.push(t(on ? 'pills.open' : 'pills.closed', { period: label }));
    frag.push(el('span', { class: `pill ${on ? 'pill--on' : 'pill--off'}${now ? ' pill--now' : ''}`, 'aria-hidden': 'true' },
      on ? '●' : '○', ` ${t(`period.${p.id}.short`)}`));
  }
  return { nodes: frag, label: t('pills.label', { list: spoken.join(t('list.sep')) }) };
}

/** 庫存圖示：綠圈 ✓ = 有庫存、琥珀菱形 – = 無庫存（形狀＋顏色雙重編碼，並附螢幕閱讀器文字） */
export function stockMark(has) {
  return el('span', { class: `stkm ${has ? 'stkm--ok' : 'stkm--zero'}` },
    el('span', { class: 'stkm__g', 'aria-hidden': 'true' }, el('span', { text: has ? '✓' : '–' })),
    el('span', { class: 'sr-only', text: t(has ? 'stock.has' : 'stock.none') }));
}

export function stockChip(v, qty) {
  const zero = !(qty > 0);
  return el('span', { class: `stk${zero ? ' stk--zero' : ''}` }, vShort(v), stockMark(!zero));
}

/**
 * 清單卡片
 * @param {{h, status, distance, openNow, products}} item
 */
export function card(item, { catalog, ctx, onOpen, showDistance = false }) {
  const { h, status } = item;
  const bits = h.hours?.[ctx.day] || 0;
  const pills = sessionPills(bits, ctx.period);
  const productList = catalog.filter((v) => item.products.includes(v.id));
  const btnId = `card-${h.id}`;

  const name = displayParts(h, 'name');

  return el('li', { class: 'card', dataset: { id: h.id } },
    el('div', { class: 'card__head' },
      el('div', { class: 'card__titles' },
        el('h3', { class: 'card__title', lang: name.lang },
          el('button', { type: 'button', class: 'card__btn', id: btnId, onclick: () => onOpen(h.id) }, name.text)),
        // 第二種寫法（外文介面的中文原名／日文介面的英文）：給櫃檯、計程車司機看
        name.alt ? el('p', { class: 'card__alt', lang: name.altLang, text: name.alt }) : null),
      statusBadge(status)),
    el('p', { class: 'card__meta' },
      showDistance && item.distance != null ? el('span', { class: 'dist', text: formatDistanceL(item.distance) }) : null,
      showDistance && item.distance != null ? ' · ' : null,
      displayArea(h)),
    el('div', { class: 'card__row' },
      el('span', { class: 'card__row-label', 'aria-hidden': 'true', text: t('card.today') }),
      el('span', { class: 'sr-only', text: pills.label }),
      pills.nodes,
      item.openNow ? el('span', { class: 'now-tag', text: t('card.openNow') }) : null),
    productList.length
      ? el('div', { class: 'card__row' },
        el('span', { class: 'sr-only', text: t('card.stockLabel') }),
        productList.map((v) => stockChip(v, h.stock[v.id])))
      : null,
  );
}

export function skeletonCards(n = 4) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push(el('li', { class: 'skel', 'aria-hidden': 'true' },
      el('div', { class: 'card' },
        el('div', { class: 'skel-line skel-line--title' }),
        el('div', { class: 'skel-line skel-line--short' }),
        el('div', { class: 'skel-line' }))));
  }
  return items;
}

// 只接受絕對的 https 網址，且不得夾帶帳密（資料來自外部網站，視為不可信）
function safeHttpUrl(u) {
  if (typeof u !== 'string' || !/^https:\/\//i.test(u)) return null;
  try {
    const url = new URL(u);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* ignore */ }
  return null;
}

// 來源電話常見「(07)3485317~8」「02-2835-3456#5131或5132」這類寫法：
// 只取第一組號碼；分機以「,」（撥號暫停）接在後面，避免把多組號碼黏成一個錯的號碼
export function telHref(tel) {
  const first = String(tel || '').split(/[~～〜或、/]/)[0];
  const [main, ext = ''] = first.split(/#|轉|分機|ext\.?/i);
  const num = main.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  if (num.replace(/\D/g, '').length < 3) return null;
  const e = ext.replace(/\D/g, '');
  return `tel:${num}${e ? `,${e}` : ''}`;
}

/** 院所詳細資料 */
export function detail(item, { catalog, ctx, selectedIds, distanceLabel }) {
  const { h, status } = item;
  const today = h.hours?.[ctx.day] || 0;
  const pills = sessionPills(today, ctx.period);
  const actions = [];
  const tel = telHref(h.tel);
  if (tel) {
    actions.push(el('a', { class: 'action action--primary', href: tel },
      icon('phone'), el('span', {}, t('detail.call'), el('span', { class: 'action__sub', text: h.tel }))));
  }
  const nav = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${h.lat},${h.lng}`)}`;
  actions.push(el('a', { class: 'action', href: nav, target: '_blank', rel: 'noopener noreferrer' },
    icon('nav'), el('span', {}, t('detail.navigate'), el('span', { class: 'sr-only', text: t('detail.newTab') }))));
  const appt = h.apptUrl && safeHttpUrl(h.apptUrl);
  if (appt) {
    actions.push(el('a', { class: 'action', href: appt, target: '_blank', rel: 'noopener noreferrer' },
      icon('cal'), el('span', {}, t('detail.book'), el('span', { class: 'sr-only', text: t('detail.newTab') }))));
  }
  const apptTel = h.apptTel && telHref(h.apptTel);
  if (apptTel) {
    actions.push(el('a', { class: 'action', href: apptTel },
      icon('phone'), el('span', {}, t('detail.bookTel'), el('span', { class: 'action__sub', text: h.apptTel }))));
  }
  if (actions.length % 2 === 1) actions[actions.length - 1].classList.add('action--wide');

  const offered = catalog.filter((v) => Object.prototype.hasOwnProperty.call(h.stock || {}, v.id));
  const stockTable = el('table', { class: 'tbl' },
    el('caption', { class: 'sr-only', text: t('detail.stockCaption') }),
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col', text: t('detail.colItem') }),
      el('th', { scope: 'col', class: 'num', text: t('detail.colStock') }))),
    el('tbody', {}, offered.map((v) => {
      const q = h.stock[v.id];
      const sel = selectedIds.includes(v.id);
      return el('tr', { class: sel ? 'is-selected' : null },
        el('th', { scope: 'row' }, vName(v), sel ? el('span', { class: 'sr-only', text: t('detail.selected') }) : null),
        el('td', { class: 'num' }, stockMark(q > 0)));
    })));

  const schedule = el('div', { class: 'sched-wrap' },
    el('table', { class: 'sched' },
      el('caption', { text: t('detail.schedCaption') }),
      el('thead', {}, el('tr', {},
        el('td', {}),
        WEEKDAY_IDS.map((w, i) => el('th', { scope: 'col', class: i === ctx.day ? 'today' : null },
          el('span', { 'aria-hidden': 'true', text: t(`weekday.${w}.short`) }),
          el('span', { class: 'sr-only', text: t(`weekday.${w}.long`) }),
          i === ctx.day ? el('span', { class: 'today-tag', text: t('detail.today') }) : null)))),
      el('tbody', {}, PERIODS.map((p) => el('tr', {},
        el('th', { scope: 'row' },
          el('span', { 'aria-hidden': 'true', text: t(`period.${p.id}.short`) }),
          el('span', { class: 'sr-only', text: t(`period.${p.id}`) })),
        WEEKDAY_IDS.map((w, i) => {
          const on = ((h.hours?.[i] || 0) & p.bit) !== 0;
          return el('td', { class: `${on ? 'on' : 'off'}${i === ctx.day ? ' today' : ''}` },
            el('span', { 'aria-hidden': 'true', text: on ? '✓' : '–' }),
            el('span', { class: 'sr-only', text: t(on ? 'detail.open' : 'detail.closed') }));
        }))))));

  const name = displayParts(h, 'name');
  const addr = displayParts(h, 'addr');
  // 所在地＋距離；英文地址已含「行政區, 縣市」時不再重複所在地，只留距離（去掉開頭的「 · 」）
  const area = addr.alt ? '' : displayArea(h);
  const distText = distanceLabel ? t('detail.distance', { distance: distanceLabel }) : '';
  const sub = area ? area + distText : distText.replace(/^\s*[·・]\s*/, '');
  return [
    el('h2', { class: 'detail__name', id: 'detail-name', tabindex: '-1', lang: name.lang, text: name.text }),
    name.alt ? el('p', { class: 'detail__alt', lang: name.altLang, text: name.alt }) : null,
    el('div', { class: 'detail__status' },
      statusBadge(status),
      el('span', { class: 'sr-only', text: STATUS[status].long }),
      item.openNow ? el('span', { class: 'now-tag', text: t('card.openNow') }) : null),
    el('div', { class: 'card__row' },
      el('span', { class: 'card__row-label', 'aria-hidden': 'true', text: t('card.today') }),
      el('span', { class: 'sr-only', text: pills.label }),
      pills.nodes),
    el('p', { class: 'detail__addr', lang: addr.lang, text: addr.text }),
    addr.alt ? el('p', { class: 'detail__addr-alt', lang: addr.altLang, text: addr.alt }) : null,
    sub ? el('p', { class: 'detail__sub', text: sub }) : null,
    el('div', { class: 'actions' }, actions),
    el('h3', { class: 'section-title', text: t('detail.stockTitle') }),
    offered.length ? stockTable : el('p', { text: t('detail.noProducts') }),
    el('h3', { class: 'section-title', text: t('detail.scheduleTitle') }),
    schedule,
    h.note ? el('p', { class: 'detail__note' }, el('strong', { text: t('detail.note') }), h.note) : null,
    el('p', { class: 'caveat', text: t('detail.caveat') }),
    el('p', { class: 'hotline' }, tParts('detail.hotline', { tel: el('a', { href: 'tel:1922', text: '1922' }) })),
    h.code ? el('p', { class: 'detail__code', text: t('detail.code', { code: h.code }) }) : null,
  ].filter(Boolean);
}
