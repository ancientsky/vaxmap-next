// DOM 產生器：所有資料字串一律經由 textContent / 屬性設定，不使用 innerHTML。
import { PERIODS, WEEKDAYS, formatDistance } from './logic.js';

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

export const STATUS = {
  ok: { glyph: '✓', text: '有庫存', long: '今日有看診・有庫存' },
  nostock: { glyph: '–', text: '無庫存', long: '今日有看診・所選品項無庫存' },
  closed: { glyph: '休', text: '今日休診', long: '今日休診' },
};

export function statusBadge(status) {
  const s = STATUS[status];
  return el('span', { class: `badge badge--${status}` },
    el('span', { class: 'badge__g', 'aria-hidden': 'true' }, el('span', { text: s.glyph })),
    s.text);
}

export function fmtNum(n) {
  return Number(n).toLocaleString('zh-TW');
}

/** 今日時段 pills：填滿 = 有看診（●），虛線 = 休（○）。文字不只靠顏色。 */
export function sessionPills(bits, currentBit) {
  const frag = [];
  const spoken = [];
  for (const p of PERIODS) {
    const on = (bits & p.bit) !== 0;
    const now = on && p.bit === currentBit;
    spoken.push(`${p.label}${on ? '有看診' : '休診'}`);
    frag.push(el('span', { class: `pill ${on ? 'pill--on' : 'pill--off'}${now ? ' pill--now' : ''}`, 'aria-hidden': 'true' },
      on ? '●' : '○', ` ${p.label}`));
  }
  return { nodes: frag, label: `今日時段：${spoken.join('、')}` };
}

/** 庫存圖示：綠圈 ✓ = 有庫存、琥珀菱形 – = 無庫存（形狀＋顏色雙重編碼，並附螢幕閱讀器文字） */
export function stockMark(has) {
  return el('span', { class: `stkm ${has ? 'stkm--ok' : 'stkm--zero'}` },
    el('span', { class: 'stkm__g', 'aria-hidden': 'true' }, el('span', { text: has ? '✓' : '–' })),
    el('span', { class: 'sr-only', text: has ? '有庫存' : '無庫存' }));
}

export function stockChip(v, qty) {
  const zero = !(qty > 0);
  return el('span', { class: `stk${zero ? ' stk--zero' : ''}` }, v.short, stockMark(!zero));
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

  return el('li', { class: 'card', dataset: { id: h.id } },
    el('div', { class: 'card__head' },
      el('h3', { class: 'card__title' },
        el('button', { type: 'button', class: 'card__btn', id: btnId, onclick: () => onOpen(h.id) }, h.name)),
      statusBadge(status)),
    el('p', { class: 'card__meta' },
      showDistance && item.distance != null ? el('span', { class: 'dist', text: formatDistance(item.distance) }) : null,
      showDistance && item.distance != null ? ' · ' : null,
      `${h.city}${h.dist}`),
    el('div', { class: 'card__row' },
      el('span', { class: 'card__row-label', 'aria-hidden': 'true', text: '今日' }),
      el('span', { class: 'sr-only', text: pills.label }),
      pills.nodes,
      item.openNow ? el('span', { class: 'now-tag', text: '本時段有看診' }) : null),
    productList.length
      ? el('div', { class: 'card__row' },
        el('span', { class: 'sr-only', text: '庫存：' }),
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
      icon('phone'), el('span', {}, '撥打電話', el('span', { class: 'action__sub', text: h.tel }))));
  }
  const nav = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${h.lat},${h.lng}`)}`;
  actions.push(el('a', { class: 'action', href: nav, target: '_blank', rel: 'noopener noreferrer' },
    icon('nav'), el('span', {}, 'Google 地圖導航', el('span', { class: 'sr-only', text: '（開啟新分頁）' }))));
  const appt = h.apptUrl && safeHttpUrl(h.apptUrl);
  if (appt) {
    actions.push(el('a', { class: 'action', href: appt, target: '_blank', rel: 'noopener noreferrer' },
      icon('cal'), el('span', {}, '線上預約', el('span', { class: 'sr-only', text: '（開啟新分頁）' }))));
  }
  const apptTel = h.apptTel && telHref(h.apptTel);
  if (apptTel) {
    actions.push(el('a', { class: 'action', href: apptTel },
      icon('phone'), el('span', {}, '預約電話', el('span', { class: 'action__sub', text: h.apptTel }))));
  }
  if (actions.length % 2 === 1) actions[actions.length - 1].classList.add('action--wide');

  const offered = catalog.filter((v) => Object.prototype.hasOwnProperty.call(h.stock || {}, v.id));
  const stockTable = el('table', { class: 'tbl' },
    el('caption', { class: 'sr-only', text: '品項庫存' }),
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col', text: '品項' }),
      el('th', { scope: 'col', class: 'num', text: '庫存' }))),
    el('tbody', {}, offered.map((v) => {
      const q = h.stock[v.id];
      const sel = selectedIds.includes(v.id);
      return el('tr', { class: sel ? 'is-selected' : null },
        el('th', { scope: 'row' }, v.name, sel ? el('span', { class: 'sr-only', text: '（已選）' }) : null),
        el('td', { class: 'num' }, stockMark(q > 0)));
    })));

  const schedule = el('div', { class: 'sched-wrap' },
    el('table', { class: 'sched' },
      el('caption', { text: '✓ 有看診　– 休診　（框線為今天）' }),
      el('thead', {}, el('tr', {},
        el('td', {}),
        WEEKDAYS.map((w, i) => el('th', { scope: 'col', class: i === ctx.day ? 'today' : null },
          w.replace('週', ''),
          i === ctx.day ? el('span', { class: 'today-tag', text: '今天' }) : el('span', { class: 'sr-only', text: w }))))),
      el('tbody', {}, PERIODS.map((p) => el('tr', {},
        el('th', { scope: 'row', text: p.label }),
        WEEKDAYS.map((w, i) => {
          const on = ((h.hours?.[i] || 0) & p.bit) !== 0;
          return el('td', { class: `${on ? 'on' : 'off'}${i === ctx.day ? ' today' : ''}` },
            el('span', { 'aria-hidden': 'true', text: on ? '✓' : '–' }),
            el('span', { class: 'sr-only', text: on ? '有看診' : '休診' }));
        }))))));

  return [
    el('h2', { class: 'detail__name', id: 'detail-name', tabindex: '-1', text: h.name }),
    el('div', { class: 'detail__status' },
      statusBadge(status),
      el('span', { class: 'sr-only', text: STATUS[status].long }),
      item.openNow ? el('span', { class: 'now-tag', text: '本時段有看診' }) : null),
    el('div', { class: 'card__row' },
      el('span', { class: 'card__row-label', 'aria-hidden': 'true', text: '今日' }),
      el('span', { class: 'sr-only', text: pills.label }),
      pills.nodes),
    el('p', { class: 'detail__addr', text: h.addr }),
    el('p', { class: 'detail__sub' }, `${h.city}${h.dist}`, distanceLabel ? `・${distanceLabel}` : ''),
    el('div', { class: 'actions' }, actions),
    el('h3', { class: 'section-title', text: '庫存' }),
    offered.length ? stockTable : el('p', { text: '此院所目前未提供本地圖所列品項。' }),
    el('h3', { class: 'section-title', text: '每週看診時段' }),
    schedule,
    h.note ? el('p', { class: 'detail__note' }, el('strong', { text: '院所備註：' }), h.note) : null,
    el('p', { class: 'caveat', text: '庫存與門診時段為院所每日回報，實際情形請先電洽院所確認。' }),
    el('p', { class: 'hotline' }, '疫苗相關諮詢：疾管署 ', el('a', { href: 'tel:1922', text: '1922' }), ' 防疫專線'),
    h.code ? el('p', { class: 'detail__code', text: `醫事機構代碼 ${h.code}` }) : null,
  ].filter(Boolean);
}
