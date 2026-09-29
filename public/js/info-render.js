// 接種資訊頁的 DOM 產生器。所有資料字串一律經由 el()（textContent／setAttribute），不使用 innerHTML；
// 連結網址在 info-parse.js 的 normalizeInfo() 已過 safeHref() 白名單，這裡建立 <a> 前再檢查一次。
import { el } from './ui.js';
import { t, tParts, tGroup, getLocale, fmtNum, formatTaipeiL } from './i18n.js';
import { safeHref, parseCoins, parseCell, splitLinkList, bareUrl, stripMarker, fileLang, soleLink, nestList, noBreakHyphen, isVideoHref } from './info-parse.js';

const ZH_TAG = 'zh-Hant-TW';
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------------- 圖示（路徑為程式內常數） ---------------- */

const ICONS = {
  map: ['M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z', 'M9 4v14', 'M15 6v14'],
  info: ['C12 12 9', 'M12 11v5.5', 'M12 7.6v.2'],
  coins: ['C12 12 9', 'C12 12 5.2', 'M12 9.6v4.8'],
  eligibility: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5', 'M16 4.3a3.5 3.5 0 0 1 0 6.6', 'M18 14.8c1.9.7 3.2 2.5 3.5 5.2'],
  where: ['M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z', 'C12 9.5 2.6'],
  precautions: ['M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3z', 'M8.8 12.2l2.2 2.2 4.4-4.6'],
  brands: ['M18 2.5l3.5 3.5', 'M19.75 4.25 15 9', 'M16.5 7.5 7.4 16.6a1.8 1.8 0 0 1-2.5 0l-.5-.5a1.8 1.8 0 0 1 0-2.5L13.5 4.5', 'M12 3l9 9', 'M5.6 18.4 2.5 21.5', 'M8.5 10.5l2 2', 'M11 8l2 2'],
  education: ['M4 19V5a2 2 0 0 1 2-2h14v14H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h14', 'M8.5 7.5h7', 'M8.5 11h5'],
  faq: ['C12 12 9', 'M9.6 9.3a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.1-2.5 3.7', 'M12 16.8v.2'],
  news: ['M4 5h12.5v14a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z', 'M16.5 9H20v10a2 2 0 0 1-2 2', 'M7.5 8.5h5.5', 'M7.5 12.5h5.5', 'M7.5 16.5h3.5'],
  other: ['C12 12 9', 'M12 11v5.5', 'M12 7.6v.2'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  clock: ['C12 12 9', 'M12 7.5V12l3 2'],
  alert: ['M12 3.5 2.5 20h19L12 3.5z', 'M12 10v4.5', 'M12 17.2v.2'],
  play: ['C12 12 9', 'M10.2 8.6v6.8l5.6-3.4z'],
  translate: ['M4 5h9', 'M8.5 3v2', 'M11 5c-1 4-3.5 7-7 8.5', 'M6.5 8.5c1.2 2 3 3.6 5 4.5', 'M13 21l4-9 4 9', 'M14.3 18h5.4'],
};

/** 線條圖示（aria-hidden）；"Cx y r" 代表圓 */
export function svgIcon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', cls || 'ic');
  for (const d of ICONS[name] || ICONS.info) {
    let node;
    if (d.startsWith('C')) {
      const [cx, cy, r] = d.slice(1).trim().split(/\s+/);
      node = document.createElementNS(SVG_NS, 'circle');
      node.setAttribute('cx', cx); node.setAttribute('cy', cy); node.setAttribute('r', r);
    } else {
      node = document.createElementNS(SVG_NS, 'path');
      node.setAttribute('d', d);
    }
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.9');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(node);
  }
  return svg;
}

/* ---------------- 格式 ---------------- */

/** 日期（只有年月日，資料為 UTC 午夜）→ 依語系「2026年9月23日」／「September 23, 2026」 */
export function fmtDate(d) {
  if (!(d instanceof Date)) return '';
  try {
    return new Intl.DateTimeFormat(getLocale(), {
      timeZone: 'UTC', calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: 'long', day: 'numeric',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function timeEl(d, text) {
  return el('time', { datetime: d.toISOString().slice(0, 10), text });
}

/* ---------------- 連結 ---------------- */

/** 外部連結：https 且政府網域才建立 <a>，否則回傳純文字 span */
export function extLink(href, children, attrs = {}) {
  const safe = safeHref(href);
  if (!safe) return el('span', { class: attrs.class ? `${attrs.class} is-plain` : 'is-plain' }, children);
  return el('a', { ...attrs, href: safe, target: '_blank', rel: 'noopener noreferrer' },
    children,
    el('span', { class: 'sr-only', text: t('info.newWindow') }));
}

const URL_IN_TEXT = /https:\/\/[^\s，。、；」）)<>"']+/g;

/** 純文字中的 https 網址 → 行內連結（僅白名單網域） */
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const href = safeHref(m[0]);
    if (!href) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(extLink(href, m[0], { class: 'ilink ilink--url' }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function runsToNodes(runs) {
  return runs.map((r) => (r.href ? extLink(r.href, r.text, { class: 'ilink' }) : linkify(r.text)));
}

/* ---------------- 區塊 ---------------- */

function newBadge() {
  return el('span', { class: 'tag tag--new', text: t('info.new') });
}

function headingLevels(blocks) {
  const levels = [...new Set(blocks.filter((b) => b.type === 'h').map((b) => b.level))].sort();
  return (lvl) => (levels.indexOf(lvl) <= 0 ? 'h3' : 'h4');
}

function isPlainP(b) {
  return b && b.type === 'p' && !b.runs && !bareUrl(b.text) && b.text.length <= 120;
}

/** 大量連結的段落（縣市衛生局）→ 分欄清單 */
function linkGrid(items) {
  return el('ul', { class: 'lgrid' }, items.map((it) => el('li', null,
    it.href ? extLink(it.href, [el('span', { class: 'lgrid__t', text: it.text }), svgIcon('external', 'ic ic--xs')], { class: 'lgrid__a' })
      : el('span', { class: 'lgrid__a is-plain', text: it.text }))));
}

function linkRow(l) {
  // 影片（YouTube）：左側播放圖示＋「影片」標籤，右側仍是外部連結符號；只連出去，不嵌入
  const video = isVideoHref(l.href);
  const body = [
    video ? el('span', { class: 'lrow__play', 'aria-hidden': 'true' }, svgIcon('play', 'ic')) : null,
    el('span', { class: 'lrow__main' },
      el('span', { class: 'lrow__t', text: l.text }),
      (l.date || l.isNew || video) ? el('span', { class: 'lrow__meta' },
        video ? el('span', { class: 'tag tag--video', text: t('info.video') }) : null,
        l.date ? timeEl(l.date, fmtDate(l.date)) : null,
        l.isNew ? newBadge() : null) : null),
  ];
  if (!safeHref(l.href)) return el('li', { class: 'lrow' }, el('span', { class: 'lrow__a is-plain' }, body));
  return el('li', { class: video ? 'lrow lrow--video' : 'lrow' }, extLink(l.href, [...body, svgIcon('external', 'ic lrow__ic')], { class: 'lrow__a' }));
}

export function linkList(links, cls = '') {
  if (!links.length) return null;
  return el('ul', { class: `lrows ${cls}`.trim() }, links.map(linkRow));
}

function markEl(mark) {
  if (mark === 'yes') return el('span', { class: 'mark mark--yes', role: 'img', 'aria-label': t('info.elig.yes') }, el('span', { 'aria-hidden': 'true', text: '✓' }));
  if (mark === 'no') return el('span', { class: 'mark mark--no', role: 'img', 'aria-label': t('info.elig.no') }, el('span', { 'aria-hidden': 'true', text: '–' }));
  return null;
}

function cellContent(v) {
  const c = parseCell(v);
  if (!c.mark) return linkify(c.note);
  return [markEl(c.mark), c.note ? el('span', { class: 'mark__note', text: c.note }) : null];
}

let tableSeq = 0;
/** 表格：桌機為 <table>（th scope），手機為每列一張卡片（dl）；兩者由 CSS 切換，隱藏的一方 display:none 不進無障礙樹 */
function tableBlock(b, Hn) {
  const id = `itbl-${++tableSeq}`;
  const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length));
  const head = Array.from({ length: cols }, (_, i) => b.head[i] || '');
  const cap = stripMarker(b.caption).text.trim();
  const labelled = cap ? id : null;

  const thead = head.some(Boolean)
    ? el('thead', null, el('tr', null, head.map((h, i) => el('th', { scope: 'col', class: i ? 'c' : null, text: h }))))
    : null;
  const rowEl = (r) => el('tr', null, head.map((_, i) => (i === 0
    ? el('th', { scope: 'row', text: r[0] || '' })
    : el('td', { class: 'c' }, cellContent(r[i] || '')))));
  const table = el('table', { class: 'itable__t', 'aria-labelledby': labelled }, thead, el('tbody', null, b.rows.map(rowEl)));

  const cardEl = (r) => el('li', { class: 'icard' },
    el('p', { class: 'icard__t', text: r[0] || '' }),
    el('dl', { class: 'icard__dl' }, head.slice(1).map((h, j) => {
      // 手機卡片：符號與說明分成兩個 dd，說明換到下一行、佔滿整列
      const c = parseCell(r[j + 1] || '');
      return el('div', { class: 'icard__row' },
        el('dt', { text: h }),
        c.mark ? el('dd', { class: 'icard__mark' }, markEl(c.mark)) : null,
        c.note ? el('dd', { class: c.mark ? 'icard__note' : 'icard__text' }, linkify(c.note)) : null);
    })));
  const cards = el('ul', { class: 'icards', 'aria-labelledby': labelled }, b.rows.map(cardEl));

  return el('div', { class: 'itable' },
    cap ? el(Hn, { class: 'itable__cap', id }, cap) : null,
    el('div', { class: 'itable__scroll' }, table),
    cards);
}

function listEl(nodes, ordered, depth = 0) {
  return el(ordered && depth === 0 ? 'ol' : 'ul', { class: depth ? 'ilist ilist--sub' : 'ilist' }, nodes.map((n) => el('li', null,
    // 有子項目的項目（「提供3歲以上幼兒及成人使用(標準型)」）是小標
    n.children.length ? el('span', { class: 'ilist__head' }, linkify(n.text)) : linkify(n.text),
    n.children.length ? listEl(n.children, ordered, depth + 1) : null)));
}

/** 正文區塊 → 節點陣列（h 依出現的層級對應為 h3／h4） */
export function renderBlocks(blocks) {
  const hTag = headingLevels(blocks);
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // 「標題一行＋網址一行」（常見問答）→ 連結清單
    if (isPlainP(b) && blocks[i + 1] && blocks[i + 1].type === 'p' && !blocks[i + 1].runs && bareUrl(blocks[i + 1].text)) {
      const links = [];
      while (isPlainP(blocks[i]) && blocks[i + 1] && blocks[i + 1].type === 'p' && !blocks[i + 1].runs && bareUrl(blocks[i + 1].text)) {
        links.push({ text: stripMarker(blocks[i].text).text, href: bareUrl(blocks[i + 1].text), isNew: false });
        i += 2;
      }
      i--;
      out.push(linkList(links));
      continue;
    }
    // 連續「整段只有一個連結」的段落（常見問答）→ 連結清單
    if (soleLink(b)) {
      const links = [];
      while (soleLink(blocks[i])) { links.push({ ...soleLink(blocks[i]), isNew: false }); i++; }
      i--;
      out.push(linkList(links));
      continue;
    }
    switch (b.type) {
      case 'h':
        out.push(el(hTag(b.level), { class: 'isub', text: stripMarker(b.text).text }));
        break;
      case 'p': {
        const grid = b.runs ? splitLinkList(b.runs) : null;
        if (grid) { out.push(linkGrid(grid)); break; }
        const url = !b.runs && bareUrl(b.text);
        if (url) { out.push(el('p', null, extLink(url, b.text.trim(), { class: 'ilink ilink--url' }))); break; }
        const { marked, text } = stripMarker(b.text);
        if (marked && !b.runs && text.length <= 80) { out.push(el('h3', { class: 'isub isub--marked', text })); break; }
        let runs = b.runs;
        if (marked && runs) {
          // 去掉第一個 run 開頭的 ▲
          runs = runs.map((r, j) => (j === 0 ? { ...r, text: stripMarker(r.text).text } : r)).filter((r) => r.text);
        }
        out.push(el('p', { class: marked ? 'ip is-marked' : 'ip' }, runs ? runsToNodes(runs) : linkify(text)));
        break;
      }
      case 'note':
        out.push(el('p', { class: 'callout', role: 'note' }, svgIcon('alert', 'ic callout__ic'), el('span', null, b.runs ? runsToNodes(b.runs) : linkify(b.text))));
        break;
      case 'list':
        out.push(listEl(nestList(b.items, b.levels), b.ordered));
        break;
      case 'table':
        out.push(tableBlock(b, 'h3'));
        break;
      default:
        break;
    }
  }
  return out.filter(Boolean);
}

/* ---------------- 檔案卡片 ---------------- */

export function fileCards(files) {
  if (!files.length) return null;
  return el('ul', { class: 'files' }, files.map((f) => {
    const ext = (f.ext || 'file').toUpperCase();
    const fl = fileLang(f.text);
    const inner = [
      el('span', { class: 'file__icon', 'aria-hidden': 'true' }, svgIcon('file', 'ic file__svg'), el('span', { class: 'file__ext', text: ext.slice(0, 4) })),
      el('span', { class: 'file__body' },
        el('span', { class: 'file__t', text: f.text }),
        el('span', { class: 'file__tags' },
          fl ? el('span', { class: `tag tag--lang tag--${fl}`, text: t(`info.fileLang.${fl}`) }) : null,
          f.isNew ? newBadge() : null,
          safeHref(f.href) ? el('span', { class: 'file__dl' }, svgIcon('download', 'ic ic--xs'), t('info.download', { ext })) : null)),
    ];
    return el('li', null, safeHref(f.href) ? extLink(f.href, inner, { class: 'file' }) : el('span', { class: 'file is-plain' }, inner));
  }));
}

/* ---------------- 健康幣 ---------------- */

const COIN_ORDER = ['flu', 'covid', 'pcv'];

export function coinsCard(section) {
  const texts = section.blocks.flatMap((b) => (b.type === 'list' ? b.items : [b.text]));
  const coins = parseCoins(texts);
  if (!coins) return null;
  return el('ul', { class: 'coins', 'aria-label': t('info.coins.label') }, COIN_ORDER.map((id) => el('li', { class: `coin coin--${id}` },
    el('span', { class: 'coin__disc', 'aria-hidden': 'true' },
      el('span', { class: 'coin__num', text: fmtNum(coins[id]) })),
    el('span', { class: 'coin__text' },
      el('span', { class: 'coin__label', text: t(`info.coins.${id}`) }),
      el('span', { class: 'coin__amt' }, tParts('info.coins.amount', { n: el('strong', { text: fmtNum(coins[id]) }) }))))));
}

/* ---------------- 地圖 CTA ---------------- */

export function mapCta(mapHref) {
  const groups = ['flu', 'covid', 'pcv'];
  return el('div', { class: 'mapcta' },
    el('div', { class: 'mapcta__head' },
      el('span', { class: 'mapcta__icon' }, svgIcon('map')),
      el('div', null,
        el('p', { class: 'mapcta__title', text: t('info.mapCta') }),
        el('p', { class: 'mapcta__body', text: t('info.mapCtaBody') }))),
    el('div', { class: 'mapcta__actions' }, groups.map((g, i) => el('a', {
      class: i === 0 ? 'btn btn--primary mapcta__btn' : 'btn mapcta__btn',
      href: mapHref(`g=${g}`),
      'data-map-group': g,
    }, svgIcon(i === 0 ? 'map' : 'arrow', 'ic'), el('span', { text: tGroup(g, 'name') })))));
}

/* ---------------- 區塊卡片 ---------------- */

/**
 * @param s 區塊（normalizeInfo 的輸出）
 * @param ctx { contentLang: 'zh'|null（非 null 時標示原文語言）, showNotice, sourceUrl, mapHref }
 */
export function sectionCard(s, ctx) {
  const zhLang = ctx.contentLang ? ZH_TAG : null;
  const hid = `${s.anchor}-h`;
  const srcHref = ctx.sourceUrl && s.id ? `${ctx.sourceUrl}#collapseOne${s.id}` : ctx.sourceUrl;
  const body = [];
  if (s.key === 'coins') body.push(coinsCard(s));
  if (s.key === 'where') body.push(mapCta(ctx.mapHref));
  body.push(...renderBlocks(s.blocks));
  const listCls = s.key === 'news' ? 'lrows--news' : '';
  // 注意事項／衛教：檔案卡片放在連結之前（主要內容是檔案）
  if (s.key === 'precautions' || s.key === 'education') body.push(fileCards(s.files), linkList(s.links, listCls));
  else body.push(linkList(s.links, listCls), fileCards(s.files));
  // 來源卡片的內容都被過濾掉了（例如只有非政府網域的影片連結）→ 指向官網原文
  if (!body.some(Boolean) && srcHref) body.push(el('p', { class: 'isec__empty' }, extLink(srcHref, t('info.more'), { class: 'ilink' })));

  return el('section', { class: `isec isec--${s.key}`, id: s.anchor, 'aria-labelledby': hid, dataset: { key: s.key, sourceId: s.id } },
    el('header', { class: 'isec__head' },
      el('span', { class: 'isec__icon', 'aria-hidden': 'true' }, svgIcon(s.key)),
      el('div', { class: 'isec__titles' },
        el('p', { class: 'isec__kicker', text: t(`info.key.${s.key}`) }),
        el('h2', { class: 'isec__title', id: hid, tabindex: '-1', lang: zhLang }, noBreakHyphen(s.title)),
        el('p', { class: 'isec__meta' },
          s.updated ? el('span', { class: 'isec__upd' }, svgIcon('clock', 'ic ic--xs'), tParts('info.updated', { date: timeEl(s.updated, fmtDate(s.updated)) })) : null,
          srcHref ? extLink(srcHref, t('info.sectionSource'), { class: 'isec__src', 'aria-label': t('info.sectionSourceLabel', { title: s.title }) }) : null))),
    ctx.showNotice ? el('p', { class: 'untr', role: 'note' }, svgIcon('translate', 'ic untr__ic'), t('info.untranslated')) : null,
    el('div', { class: 'isec__body', lang: zhLang }, body.filter(Boolean)));
}

/** 「本頁內容」chip 列 */
export function tocItems(sections) {
  const keyCount = Object.create(null);
  for (const s of sections) keyCount[s.key] = (keyCount[s.key] || 0) + 1;
  return sections.map((s) => {
    const label = keyCount[s.key] > 1 || s.key === 'other' ? s.title : t(`info.key.${s.key}`);
    return el('li', null, el('a', { class: 'toc__chip', href: `#${s.anchor}`, dataset: { anchor: s.anchor }, title: label !== s.title ? s.title : null },
      svgIcon(s.key, 'ic toc__ic'), el('span', { class: 'toc__t', text: label })));
  });
}

export { formatTaipeiL };
