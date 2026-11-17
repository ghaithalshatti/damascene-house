// Customer menu: browse, search, item details, cart, live ordering (Firebase) or show-to-waiter fallback.
import {
  loadSite, normalizeConfig, deepMerge, initLang, setLang, getLang, t, tx, formatPrice, esc, imgSrc, applyTheme,
  ICONS, TAGS, normalizeSearch, openSheet, closeSheet, confirmDialog, ls, toast,
} from './core.js';
import { fbEnabled, sendRequest, getRequest, startSession, isBlocked, sessionHours } from './fb.js';

const params = new URLSearchParams(location.search);
const URL_TABLE = (params.get('t') || params.get('table') || '').replace(/[^\w-]/g, '').slice(0, 8);
const KEY = (params.get('k') || '').replace(/[^\w-]/g, '').slice(0, 16); // table secret printed in the QR
const PREVIEW = params.get('preview') === '1'; // used by the setup page's live preview
const MINE_KEY = 'rm:mine';
const CART_KEY = 'rm:cart';
const SESSION_KEY = 'rm:table';
const PHONE_KEY = 'rm:phone';
const PHONE_TTL = 24 * 3600e3;
let CART_TTL = 4 * 3600e3;
// The table this phone sits at: from the QR just scanned, else from its open table session.
let TABLE = URL_TABLE;

const app = document.getElementById('app');
const S = { config: null, menu: null, draft: false, langs: [], cart: [], lockSpy: 0, mine: [], cooldown: {} };
let itemSheet, cartSheet, infoSheet;

/* ---------- boot ---------- */
async function boot() {
  try {
    const d = await loadSite();
    Object.assign(S, { config: d.config, menu: d.menu, draft: d.draft });
  } catch (e) {
    console.error(e);
    initLang({});
    app.innerHTML = `<div class="empty" style="min-height:80vh;align-content:center">${ICONS.alert}<p>${esc(t('error_load'))}</p>
      <button class="btn btn--primary" onclick="location.reload()">${esc(t('retry'))}</button></div>`;
    return;
  }
  if (PREVIEW && params.get('skin')) S.config.theme = { id: params.get('skin'), primary: params.get('primary') || '', style: params.get('style') || 'classic' };
  applyTheme(S.config);
  S.langs = initLang(S.config);
  [itemSheet, cartSheet, infoSheet] = ['itemSheet', 'cartSheet', 'infoSheet'].map((id) => {
    const el = document.createElement('div'); el.className = 'sheet'; el.id = id; el.hidden = true; document.body.append(el); return el;
  });
  CART_TTL = sessionHours(S.config) * 3600e3;
  initSession();
  loadCart();
  loadMine();
  render();
  trackMine();
  bindGlobal();
  let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(setupObservers, 200); });
  if (PREVIEW) {
    addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.data?.type !== 'rm:preview') return;
      S.config = normalizeConfig(deepMerge(S.config, e.data.config));
      applyTheme(S.config); S.langs = initLang(S.config); render();
    });
    parent.postMessage({ type: 'rm:preview-ready' }, location.origin);
  }
}

/* ---------- helpers ---------- */
const ordering = () => S.config.features?.ordering !== false;
// Live mode: Firebase is set up and this phone has an open table session (QR scanned, not paid yet, not expired).
const online = () => ordering() && fbEnabled(S.config) && !!TABLE && !!(S.session || S.pendingKey) && !S.sessionOver && !PREVIEW;
const fmt = (n) => formatPrice(n, S.config);
const findItem = (id) => S.menu.items.find((i) => i.id === id);
const findCat = (id) => S.menu.categories.find((c) => c.id === id);
const visibleItems = () => S.menu.items.filter((i) => i.available && findCat(i.categoryId));
function catsWithItems() {
  const items = visibleItems();
  return S.menu.categories.map((c) => ({ ...c, items: items.filter((i) => i.categoryId === c.id) })).filter((c) => c.items.length);
}
const unitPrice = (it, size) => (size > -1 && it.sizes[size] ? it.sizes[size].price : it.price);
const minPrice = (it) => (it.sizes.length ? Math.min(...it.sizes.map((s) => s.price)) : it.price);
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const initial = (r) => { const n = (tx(r.name) || '•').trim().replace(/^ال/, ''); return esc(n.charAt(0)); };
const logoInner = (r) => (r.logo ? `<img src="${esc(imgSrc(r.logo))}" alt="">` : initial(r));
const mediaHTML = (it, icon) => (it.image ? `<img src="${esc(imgSrc(it.image))}" alt="${esc(tx(it.name))}" loading="lazy" decoding="async">` : `<div class="ph">${esc(icon || '🍽️')}</div>`);
const tagsHTML = (tags, cls = 'card__tags') => (tags?.length ? `<div class="${cls}">${tags.filter((k) => TAGS[k]).map((k) => `<span class="chip chip--${k}">${ICONS[TAGS[k].icon]}${esc(t(TAGS[k].key))}</span>`).join('')}</div>` : '');
function priceLabel(it) {
  return it.sizes.length
    ? `<small>${esc(t('from'))}</small><span class="num">${esc(fmt(minPrice(it)))}</span>`
    : `<span class="num">${esc(fmt(it.price))}</span>`;
}

/* ---------- render ---------- */
function render() {
  const r = S.config.restaurant;
  const cats = catsWithItems();
  document.title = `${tx(r.name)} · ${t('menu_word')}`;
  const social = socialLinks(r);
  app.innerHTML = `
    <header class="hero ${r.cover ? 'hero--cover' : ''}" id="hero" ${r.cover ? `style="--cover:url('${esc(imgSrc(r.cover))}')"` : ''}>
      <div class="hero__bg"></div>
      <div class="hero__top wrap" style="width:100%">
        ${TABLE ? `<span class="table-badge">${ICONS.table}${esc(t('table', { n: TABLE }))}</span>` : ''}
        <span class="spacer"></span>
        ${S.langs.length > 1 ? `<button class="glass-btn" id="langBtn">${ICONS.globe}<span>${esc(t('lang_switch'))}</span></button>` : ''}
        <button class="glass-btn" id="infoBtn" aria-label="${esc(t('info'))}">${ICONS.info}</button>
      </div>
      <div class="hero__brand wrap" style="width:100%">
        ${r.logo ? `<div class="logo">${logoInner(r)}</div>` : ''}
        <div style="min-width:0">
          <h1 class="hero__name">${esc(tx(r.name))}</h1>
          ${tx(r.tagline) ? `<p class="hero__tag">${esc(tx(r.tagline))}</p>` : ''}
          ${tx(r.hours) ? `<div class="hero__meta"><span class="glass-btn">${ICONS.clock}${esc(tx(r.hours))}</span></div>` : ''}
        </div>
      </div>
    </header>
    <div class="shell wrap">
    <div class="bar" id="bar">
      <div class="search">
        ${r.logo ? `<span class="bar__logo mini-logo">${logoInner(r)}</span>` : ''}
        <label class="search__box">${ICONS.search}
          <input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="${esc(t('search_ph'))}" aria-label="${esc(t('search'))}">
          <button class="search__clear" id="qClear" hidden aria-label="${esc(t('close'))}">${ICONS.close}</button>
        </label>
      </div>
      <nav class="cats" id="cats">${cats.map((c, i) => `<button class="cat ${i === 0 ? 'active' : ''}" data-cat="${c.id}"><span class="cat__icon">${esc(c.icon)}</span>${esc(tx(c.name))}<span class="cat__n num">${c.items.length}</span></button>`).join('')}</nav>
    </div>
    <main id="main">
      ${cats.map((c) => `
        <section class="sec" id="sec-${c.id}" data-cat="${c.id}">
          <h2 class="sec__title"><span class="sec__icon">${esc(c.icon)}</span>${esc(tx(c.name))}<span class="sec__count">${esc(t('items_count', { n: c.items.length }))}</span></h2>
          <div class="items">${c.items.map((it, ix) => cardHTML(it, c, ix)).join('')}</div>
        </section>`).join('')}
      <div class="empty" id="noResults" hidden>${ICONS.search}<p>${esc(t('no_results'))}</p></div>
    </main>
    </div>
    <footer class="foot wrap">
      ${social ? `<div class="socials">${social}</div>` : ''}
      <div>© ${new Date().getFullYear()} ${esc(tx(r.name))}</div>
      ${S.config.poweredBy?.name ? `<a class="credit" href="${esc(safeUrl(S.config.poweredBy.url) || '#')}" target="_blank" rel="noopener">${esc(t('powered_by'))} · ${esc(S.config.poweredBy.name)}</a>` : ''}
    </footer>
    ${ordering() ? `<button class="cartbar" id="cartbar"><span class="cartbar__count num" id="cbCount">0</span><span class="cartbar__label">${esc(t('view_order'))}</span><span class="cartbar__total num" id="cbTotal"></span></button>` : ''}
    ${online() ? `<div class="dock" id="dock">
      <button class="dock__btn" id="callWaiter">${ICONS.bell}<span>${esc(t('call_waiter'))}</span></button>
      <button class="dock__btn" id="askBill">${ICONS.receipt}<span>${esc(t('ask_bill'))}</span></button>
      <button class="dock__btn dock__btn--status" id="myOrders" hidden>${ICONS.clock}<span id="myStatus"></span></button>
    </div>` : ''}
  `;
  setupObservers();
  updateCartUI();
  renderMineStatus();
}

function cardHTML(it, c, ix) {
  const hay = normalizeSearch([it.name.ar, it.name.en, it.description.ar, it.description.en].join(' '));
  return `<article class="card" data-id="${esc(it.id)}" data-search="${esc(hay)}" style="animation-delay:${Math.min(ix, 8) * 45}ms">
    <div class="card__body">
      <h3 class="card__name">${esc(tx(it.name))}</h3>
      ${tx(it.description) ? `<p class="card__desc">${esc(tx(it.description))}</p>` : ''}
      ${tagsHTML(it.tags)}
      <div class="card__price">${priceLabel(it)}</div>
    </div>
    <div class="card__media">
      <div class="media">${mediaHTML(it, c.icon)}</div>
      ${ordering() ? `<button class="card__add" data-add="${esc(it.id)}" aria-label="${esc(t('add_to_order'))}">${ICONS.plus}</button><span class="card__qty num" hidden></span>` : ''}
    </div>
  </article>`;
}

function socialLinks(r) {
  const s = r.social || {};
  return [['instagram', s.instagram], ['facebook', s.facebook], ['tiktok', s.tiktok], ['link', s.website]]
    .filter(([, u]) => safeUrl(u))
    .map(([ic, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener" aria-label="${ic}">${ICONS[ic]}</a>`).join('');
}

/* ---------- events ---------- */
function bindGlobal() {
  app.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) { e.stopPropagation(); quickAdd(add.dataset.add, add); return; }
    const card = e.target.closest('.card');
    if (card) { openItem(card.dataset.id); return; }
    const cat = e.target.closest('.cat');
    if (cat) { scrollToCat(cat.dataset.cat); return; }
    if (e.target.closest('#langBtn')) { switchLang(); return; }
    if (e.target.closest('#infoBtn')) { openInfo(); return; }
    if (e.target.closest('#cartbar')) { openCart(); return; }
    if (e.target.closest('#callWaiter')) { serviceCall('waiter'); return; }
    if (e.target.closest('#askBill')) { serviceCall('bill'); return; }
    if (e.target.closest('#myOrders')) { openMine(); return; }
    if (e.target.closest('#qClear')) { e.preventDefault(); const q = document.getElementById('q'); q.value = ''; filter(''); q.focus(); }
  });
  app.addEventListener('input', (e) => { if (e.target.id === 'q') filter(e.target.value); });
}

function switchLang() {
  const i = S.langs.indexOf(getLang());
  setLang(S.langs[(i + 1) % S.langs.length]);
  render();
}

/* ---------- sticky bar + scroll spy ---------- */
let spyObs, heroObs;
function setupObservers() {
  spyObs?.disconnect(); heroObs?.disconnect();
  const bar = document.getElementById('bar');
  const hero = document.getElementById('hero');
  heroObs = new IntersectionObserver(([en]) => bar.classList.toggle('stuck', !en.isIntersecting), { rootMargin: '-60px 0px 0px 0px' });
  heroObs.observe(hero);
  const barH = () => stickyOffset();
  spyObs = new IntersectionObserver((entries) => {
    if (Date.now() < S.lockSpy) return;
    const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) setActiveCat(vis.target.dataset.cat);
  }, { rootMargin: `-${barH()}px 0px -55% 0px` });
  document.querySelectorAll('.sec').forEach((s) => { s.style.scrollMarginTop = `${barH()}px`; spyObs.observe(s); });
}
const isDesktop = () => matchMedia('(min-width: 1024px)').matches;
const stickyOffset = () => (isDesktop() ? 24 : document.getElementById('bar').offsetHeight + 12);
function setActiveCat(id) {
  const nav = document.getElementById('cats');
  nav?.querySelectorAll('.cat').forEach((b) => {
    const on = b.dataset.cat === id;
    b.classList.toggle('active', on);
    if (on) {
      if (isDesktop()) { b.scrollIntoView({ block: 'nearest' }); return; }
      const nr = nav.getBoundingClientRect(); const br = b.getBoundingClientRect();
      nav.scrollBy({ left: br.left - nr.left - (nr.width - br.width) / 2, behavior: 'smooth' });
    }
  });
}
function scrollToCat(id) {
  const sec = document.getElementById(`sec-${id}`); const bar = document.getElementById('bar');
  if (!sec) return;
  S.lockSpy = Date.now() + 900;
  setActiveCat(id);
  window.scrollTo({ top: sec.getBoundingClientRect().top + scrollY - (isDesktop() ? 24 : bar.offsetHeight - 2), behavior: 'smooth' });
}

/* ---------- search ---------- */
function filter(raw) {
  const q = normalizeSearch(raw);
  const terms = q.split(/\s+/).filter(Boolean);
  document.getElementById('qClear').hidden = !q;
  document.getElementById('cats').hidden = !!q;
  let any = false;
  document.querySelectorAll('.sec').forEach((sec) => {
    let n = 0;
    sec.querySelectorAll('.card').forEach((c) => {
      const ok = !terms.length || terms.every((tm) => c.dataset.search.includes(tm));
      c.hidden = !ok; if (ok) n++;
    });
    sec.hidden = !n; if (n) any = true;
  });
  document.getElementById('noResults').hidden = any;
  if (q) window.scrollTo({ top: document.getElementById('main').getBoundingClientRect().top + scrollY - stickyOffset() });
}

/* ---------- cart ---------- */
const lineKey = (l) => `${l.itemId}|${l.size}|${l.note.trim()}`;
function loadCart() {
  const saved = ls.get(CART_KEY);
  if (!saved || Date.now() - saved.t > CART_TTL || (saved.table || '') !== TABLE) { S.cart = []; return; }
  S.cart = (saved.lines || []).filter((l) => { const it = findItem(l.itemId); return it && it.available && (l.size < 0 || it.sizes[l.size]); });
}
const saveCart = () => ls.set(CART_KEY, { t: Date.now(), table: TABLE, lines: S.cart });
const cartCount = () => S.cart.reduce((a, l) => a + l.qty, 0);
const cartTotal = () => S.cart.reduce((a, l) => a + unitPrice(findItem(l.itemId), l.size) * l.qty, 0);
const qtyInCart = (id) => S.cart.filter((l) => l.itemId === id).reduce((a, l) => a + l.qty, 0);

function addLine(line) {
  line.note = (line.note || '').trim().slice(0, 200);
  const k = lineKey(line);
  const ex = S.cart.find((l) => lineKey(l) === k);
  if (ex) ex.qty = Math.min(99, ex.qty + line.qty); else S.cart.push({ ...line });
  saveCart(); updateCartUI(true);
}
function quickAdd(id, btn) {
  const it = findItem(id); if (!it) return;
  if (it.sizes.length) { openItem(id); return; }
  addLine({ itemId: id, size: -1, note: '', qty: 1 });
  btn?.classList.remove('pop'); void btn?.offsetWidth; btn?.classList.add('pop');
}
function updateCartUI(bump = false) {
  if (!ordering()) return;
  const bar = document.getElementById('cartbar'); if (!bar) return;
  const n = cartCount();
  bar.classList.toggle('show', n > 0);
  document.getElementById('dock')?.classList.toggle('dock--up', n > 0);
  document.getElementById('cbCount').textContent = n;
  document.getElementById('cbTotal').textContent = fmt(cartTotal());
  if (bump) { const c = document.getElementById('cbCount'); c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
  document.querySelectorAll('.card').forEach((card) => {
    const q = qtyInCart(card.dataset.id); const b = card.querySelector('.card__qty');
    if (b) { b.hidden = !q; b.textContent = q; }
  });
}

/* ---------- item sheet ---------- */
function openItem(id, editKey = null) {
  const it = findItem(id); if (!it) return;
  const cat = findCat(it.categoryId);
  // An item that's already in the order opens with its current quantity (edit instead of add).
  const fromCart = !!editKey;
  let edit = editKey ? S.cart.find((l) => lineKey(l) === editKey)
    : (S.cart.find((l) => l.itemId === id && l.size === (it.sizes.length ? 0 : -1)) || S.cart.find((l) => l.itemId === id) || null);
  let qty = edit?.qty || 1;
  let size = edit ? edit.size : (it.sizes.length ? 0 : -1);
  const canOrder = ordering();
  itemSheet.innerHTML = `<div class="sheet__panel item-sheet" role="dialog" aria-modal="true" aria-label="${esc(tx(it.name))}">
    <div class="item-media"><div class="media" style="height:100%">${mediaHTML(it, cat?.icon)}</div>
      <button class="icon-btn close-fab" data-close aria-label="${esc(t('close'))}">${ICONS.close}</button></div>
    <div class="sheet__body">
      <h2 class="item__name">${esc(tx(it.name))}</h2>
      <div class="item__price">${priceLabel(it)}</div>
      ${tagsHTML(it.tags, 'item__tags')}
      ${tx(it.description) ? `<p class="item__desc">${esc(tx(it.description))}</p>` : ''}
      ${it.sizes.length ? `<div class="block"><div class="block__title">${esc(t('choose_size'))}</div><div class="sizes">
        ${it.sizes.map((s, i) => `<label class="size"><input type="radio" name="size" value="${i}" ${i === size ? 'checked' : ''} ${canOrder ? '' : 'disabled'}><span>${esc(tx(s.name))}</span><b class="num">${esc(fmt(s.price))}</b></label>`).join('')}
      </div></div>` : ''}
      ${canOrder ? `<div class="block"><label class="block__title" for="note">${ICONS.note}${esc(t('note_label'))}</label>
        <textarea class="textarea" id="note" maxlength="200" rows="2" placeholder="${esc(t('note_ph'))}">${esc(edit?.note || '')}</textarea></div>` : ''}
    </div>
    ${canOrder ? `<div class="sheet__foot"><div class="item-foot">
      <div class="stepper"><button data-q="1" aria-label="+">${ICONS.plus}</button><output class="num" id="qty">${qty}</output><button data-q="-1" aria-label="-">${ICONS.minus}</button></div>
      <button class="btn btn--primary" id="addBtn"><span id="addLabel"></span><span class="num" id="addTotal"></span></button>
    </div></div>` : ''}
  </div>`;
  const upd = () => {
    if (!canOrder) return;
    itemSheet.querySelector('#qty').textContent = qty;
    itemSheet.querySelector('#addBtn').classList.toggle('btn--danger', !!edit && qty === 0);
    itemSheet.querySelector('#addLabel').textContent = t(!edit ? 'add_to_order' : qty === 0 ? 'remove_from_order' : 'update_order');
    itemSheet.querySelector('#addTotal').textContent = qty ? fmt(unitPrice(it, size) * qty) : '';
    itemSheet.querySelector('[data-q="-1"]').innerHTML = edit && qty <= 1 ? ICONS.trash : ICONS.minus;
  };
  upd();
  itemSheet.onchange = (e) => {
    if (e.target.name !== 'size') return;
    size = +e.target.value;
    if (!fromCart) { // switch to this size's line if it's already in the order
      edit = S.cart.find((l) => l.itemId === it.id && l.size === size) || null;
      qty = edit?.qty || 1;
      const n = itemSheet.querySelector('#note'); if (n) n.value = edit?.note || '';
    }
    upd();
  };
  itemSheet.onclick = (e) => {
    const q = e.target.closest('[data-q]');
    if (q) { qty = Math.max(edit ? 0 : 1, Math.min(99, qty + +q.dataset.q)); upd(); return; }
    if (e.target.closest('#addBtn')) {
      const note = itemSheet.querySelector('#note')?.value || '';
      if (edit) { S.cart.splice(S.cart.indexOf(edit), 1); saveCart(); updateCartUI(); }
      if (qty > 0) addLine({ itemId: it.id, size, note, qty });
      closeSheet(itemSheet);
      if (!cartSheet.hidden) { if (S.cart.length) renderCart(); else closeSheet(cartSheet); }
    }
  };
  openSheet(itemSheet);
}

/* ---------- cart sheet ---------- */
function openCart() { renderCart(); openSheet(cartSheet); }
function renderCart() {
  const lines = S.cart;
  cartSheet.innerHTML = `<div class="sheet__panel" role="dialog" aria-modal="true">
    <div class="sheet__grip"></div>
    <div class="sheet__head"><h2>${esc(t('my_order'))}</h2>
      <div style="display:flex;gap:8px;align-items:center">${TABLE ? `<span class="chip">${ICONS.table}${esc(t('table', { n: TABLE }))}</span>` : ''}
      <button class="icon-btn" data-close aria-label="${esc(t('close'))}">${ICONS.close}</button></div></div>
    <div class="sheet__body">
      ${lines.length ? `<div class="lines">${lines.map((l) => {
        const it = findItem(l.itemId); const k = lineKey(l);
        return `<div class="line" data-key="${esc(k)}">
          <div><div class="line__name" data-edit="${esc(k)}">${esc(tx(it.name))}</div>${l.size > -1 ? `<div class="line__size">${esc(tx(it.sizes[l.size].name))}</div>` : ''}</div>
          <div class="line__price num">${esc(fmt(unitPrice(it, l.size) * l.qty))}</div>
          ${l.note ? `<div class="line__note">${ICONS.note}<span>${esc(l.note)}</span></div>` : ''}
          <div class="line__row"><button class="link-btn" data-edit="${esc(k)}" style="padding:4px 0">${ICONS.edit}</button>
            <div class="stepper"><button data-inc="${esc(k)}" aria-label="+">${ICONS.plus}</button><output class="num">${l.qty}</output><button data-dec="${esc(k)}" aria-label="-">${l.qty > 1 ? ICONS.minus : ICONS.trash}</button></div></div>
        </div>`;
      }).join('')}</div>` : `<div class="empty">${ICONS.bag}<b>${esc(t('empty_order'))}</b><p>${esc(t('empty_order_hint'))}</p></div>`}
    </div>
    ${lines.length ? `<div class="sheet__foot">
      <div class="totals"><span>${esc(t('total'))}</span><span class="num">${esc(fmt(cartTotal()))}</span></div>
      <div class="cart-actions">
        ${online() ? `<button class="btn btn--primary btn--block" id="sendOrder">${ICONS.send}${esc(t('send_order'))}</button>`
          : `<button class="btn btn--primary btn--block" id="showWaiter">${ICONS.eye}${esc(t('show_waiter'))}</button>`}
        <button class="link-btn" id="clearCart">${esc(t('clear_order'))}</button>
      </div></div>` : ''}
  </div>`;
  cartSheet.onclick = async (e) => {
    const inc = e.target.closest('[data-inc]'); const dec = e.target.closest('[data-dec]'); const ed = e.target.closest('[data-edit]');
    if (inc || dec) {
      const k = (inc || dec).dataset.inc || (inc || dec).dataset.dec;
      const l = S.cart.find((x) => lineKey(x) === k); if (!l) return;
      l.qty += inc ? 1 : -1;
      if (l.qty < 1) S.cart.splice(S.cart.indexOf(l), 1);
      l.qty = Math.min(l.qty, 99);
      saveCart(); updateCartUI(); renderCart();
      if (!S.cart.length) setTimeout(() => closeSheet(cartSheet), 400);
      return;
    }
    if (ed) { const l = S.cart.find((x) => lineKey(x) === ed.dataset.edit); if (l) openItem(l.itemId, ed.dataset.edit); return; }
    if (e.target.closest('#showWaiter')) { showTicket(); return; }
    const so = e.target.closest('#sendOrder'); if (so) { sendOrder(so); return; }
    if (e.target.closest('#clearCart')) {
      if (await confirmDialog(t('clear_order_q'), { danger: true, okText: t('clear_order') })) {
        S.cart = []; saveCart(); updateCartUI(); closeSheet(cartSheet);
      }
    }
  };
}

/* ---------- ticket: big, clear screen for the waiter (in the restaurant's default language) ---------- */
function showTicket() {
  const L = S.config.languages.default || 'ar';
  const tl = (o) => (o ? o[L] || o.ar || o.en || '' : '');
  const time = new Date().toLocaleTimeString(L === 'ar' ? 'ar-SY' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const el = document.createElement('div');
  el.className = 'ticket'; el.dir = L === 'ar' ? 'rtl' : 'ltr'; el.lang = L;
  const count = cartCount();
  el.innerHTML = `<div class="ticket__card">
    <div class="ticket__head">
      ${TABLE ? `<div class="ticket__table">${esc(L === 'ar' ? `طاولة ${TABLE}` : `Table ${TABLE}`)}</div>` : `<div class="ticket__table" style="font-size:28px">${esc(L === 'ar' ? 'الطلب' : 'Order')}</div>`}
      <div class="ticket__meta"><span class="num">${esc(time)}</span> · ${count} ${esc(L === 'ar' ? 'وجبات' : 'items')}</div>
    </div>
    <div class="ticket__lines">${S.cart.map((l) => {
      const it = findItem(l.itemId);
      return `<div class="ticket__line"><span class="ticket__qty num">${l.qty}×</span>
        <span class="ticket__name">${esc(tl(it.name))}${l.size > -1 ? ` — ${esc(tl(it.sizes[l.size].name))}` : ''}</span>
        <span class="num">${esc(Number(unitPrice(it, l.size) * l.qty).toLocaleString('en-US'))}</span>
        ${l.note ? `<span class="ticket__note">✎ ${esc(l.note)}</span>` : ''}</div>`;
    }).join('')}</div>
    <div class="ticket__total"><span>${esc(L === 'ar' ? 'المجموع' : 'Total')}</span><span class="num">${esc(Number(cartTotal()).toLocaleString('en-US'))} ${esc(S.config.currency[L] || '')}</span></div>
  </div>
  <p class="ticket__hint">${esc(t('ticket_hint'))}</p>
  <button class="btn btn--primary btn--block" id="tkDone">${ICONS.check}${esc(t('ticket_confirm'))}</button>
  <button class="link-btn" id="tkBack" style="display:block;margin:10px auto 0">${esc(t('back_edit'))}</button>`;
  document.body.append(el);
  el.querySelector('#tkBack').onclick = () => el.remove();
  el.querySelector('#tkDone').onclick = () => {
    el.remove();
    S.cart = []; saveCart(); updateCartUI();
    closeSheet(cartSheet);
    celebrate(t('order_done'), t('order_done_sub'));
  };
}

// Success bubble.
function celebrate(title, sub, { icon = 'check', tone = '', ms = 3200, onClose } = {}) {
  const el = document.createElement('div');
  el.className = `done-pop${tone ? ` done-pop--${tone}` : ''}`;
  el.innerHTML = `<div class="done-pop__card" role="status">
    <div class="done-pop__ic">${ICONS[icon]}</div>
    <b>${esc(title)}</b>
    ${TABLE ? `<span class="chip">${ICONS.table}${esc(t('table', { n: TABLE }))}</span>` : ''}
    <p>${esc(sub)}</p></div>`;
  document.body.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  let closed = false;
  const close = () => { if (closed) return; closed = true; el.classList.remove('in'); setTimeout(() => { el.remove(); onClose?.(); }, 350); };
  el.onclick = close;
  setTimeout(close, ms);
}

/* ---------- live ordering (Firebase) ---------- */
const tlDefault = (o) => { const L = S.config.languages.default || 'ar'; return o ? (o[L] || o.ar || o.en || '') : ''; };
// This phone's requests at this table. Kept while the guest is seated: cleared as soon as the bill is
// paid, or 4 hours after the last request, so the next guest at the table always starts clean.
function loadMine() {
  const saved = ls.get(MINE_KEY);
  const fresh = !!saved && saved.table === TABLE && !!saved.phone && saved.phone === myPhone() && Date.now() - saved.t < CART_TTL;
  S.mine = fresh ? saved.list || [] : [];
  S.mineT = fresh ? saved.t : 0;
  if (saved && !fresh) ls.del(MINE_KEY);
}
// touch = a new request was just sent (restarts the 4-hour window); status updates keep the original time.
function saveMine(touch = false) {
  if (touch || !S.mineT) S.mineT = Date.now();
  if (!S.mine.length) { ls.del(MINE_KEY); S.mineT = 0; return; }
  ls.set(MINE_KEY, { t: S.mineT, table: TABLE, phone: myPhone(), list: S.mine });
}
const myOrders = () => S.mine.filter((x) => x.type === 'order');
const myTotal = () => myBill().total;
// This phone's invoice: its unpaid orders, identical dishes merged, priced from the menu (as the staff screen does).
// (The guest's phone can only read its own requests — the waiter sees the whole table's total.)
function myBill() {
  const map = new Map(); let orders = 0;
  for (const o of myOrders().filter((x) => !x.paid)) {
    orders++;
    if (!o.items) { map.set(o.id, { name: t('order_n', { n: orders }), size: '', qty: 1, price: o.total || 0 }); continue; }
    for (const l of o.items) {
      const it = findItem(l.id); const sz = it && l.si > -1 ? it.sizes[l.si] : null;
      const price = it ? (it.sizes.length ? (sz ? sz.price : l.price) : it.price) : l.price;
      const key = `${l.id}|${l.si}|${price}`;
      const row = map.get(key) || { name: it ? tx(it.name) : '…', size: sz ? tx(sz.name) : '', qty: 0, price };
      row.qty += l.qty || 1; map.set(key, row);
    }
  }
  const lines = [...map.values()].map((r) => ({ ...r, amount: r.price * r.qty }));
  return { lines, orders, total: lines.reduce((a, r) => a + r.amount, 0) };
}
function openBill() {
  const bill = myBill();
  const sheet = infoSheet;
  sheet.innerHTML = `<div class="sheet__panel" role="dialog" aria-modal="true"><div class="sheet__grip"></div>
    <div class="sheet__head"><div><h2>${esc(t('bill_title'))}</h2><p class="hint">${TABLE ? `<bdi>${esc(t('table', { n: TABLE }))}</bdi> · ` : ''}<bdi>${esc(t('bill_orders', { n: bill.orders }))}</bdi></p></div>
      <button class="icon-btn" data-close aria-label="${esc(t('close'))}">${ICONS.close}</button></div>
    <div class="sheet__body"><div class="lines bill-lines">${bill.lines.map((l) => `<div class="line">
      <div><div class="line__name">${esc(l.name)}${l.size ? ` <span class="line__size">(${esc(l.size)})</span>` : ''}</div>
        <div class="line__size"><bdi class="num">${esc(l.qty)}</bdi> × <bdi class="num">${esc(fmt(l.price))}</bdi></div></div>
      <span class="line__price num">${esc(fmt(l.amount))}</span></div>`).join('')}</div></div>
    <div class="sheet__foot"><div class="totals"><span>${esc(t('bill_total'))}</span><span class="num">${esc(fmt(bill.total))}</span></div>
      <p class="hint" style="text-align:center">${esc(t(S.billAsked ? 'bill_hint' : 'bill_hint_mine'))}</p></div></div>`;
  openSheet(sheet);
}

async function sendOrder(btn) {
  if (!S.cart.length) return;
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${esc(t('sending'))}`;
  try {
    const items = S.cart.map((l) => {
      const it = findItem(l.itemId);
      return { id: it.id, si: l.size, name: tlDefault(it.name), size: l.size > -1 ? tlDefault(it.sizes[l.size].name) : '', qty: l.qty, price: unitPrice(it, l.size), note: l.note || '' };
    });
    const total = cartTotal();
    const id = await sendRequest(S.config, { type: 'order', ...(await who()), items, total });
    S.mine.push({ id, type: 'order', total, at: Date.now(), status: 'new', items: items.map(({ id: i, si, qty, price }) => ({ id: i, si, qty, price })) }); saveMine(true);
    S.cart = []; saveCart(); updateCartUI();
    closeSheet(cartSheet);
    celebrate(t('order_sent'), t('order_sent_sub'));
    trackMine();
  } catch (e) {
    if (!btn.isConnected) return;
    btn.disabled = false; btn.innerHTML = `${ICONS.send}${esc(t('send_order'))}`;
    await requestFailed(e);
  }
}

async function serviceCall(type) {
  const wait = (S.cooldown[type] || 0) - Date.now();
  if (wait > 0) {
    // Asked for the bill a moment ago: show the invoice again instead of a "wait" message.
    if (type === 'bill') { openBill(); return; }
    toast(t('call_wait', { s: Math.ceil(wait / 1000) }), 'err'); return;
  }
  // Nothing ordered (or all paid): nothing to bring — say so instead of calling the waiter for nothing.
  if (type === 'bill' && !(myTotal() > 0)) { celebrate(t('no_bill'), t('no_bill_sub'), { icon: 'receipt', tone: 'info', ms: 4500 }); return; }
  const q = type === 'waiter' ? t('call_waiter_q') : t('ask_bill_q', { total: fmt(myTotal()) });
  if (!(await confirmDialog(q, { okText: t(type === 'waiter' ? 'call_waiter' : 'ask_bill') }))) return;
  try {
    const w = await who();
    const id = await sendRequest(S.config, type === 'bill' ? { type, ...w, total: myTotal() } : { type, ...w });
    S.mine.push({ id, type, at: Date.now() }); saveMine(true);
    S.cooldown[type] = Date.now() + 45e3;
    if (type === 'waiter') { celebrate(t('waiter_sent'), t('waiter_sent_sub')); return; }
    // Bill: confirm it was sent, then show the invoice so the guest can get the money ready.
    S.billAsked = true;
    celebrate(t('bill_sent'), t('bill_sent_sub'), { ms: 2200, onClose: openBill });
  } catch (e) { await requestFailed(e); }
}

/* ---------- table session (QR protection) ---------- */
// Scanning the QR (?t=…&k=…) opens a table session in Firestore and the key leaves the address bar right away.
// Ordering then works from this phone for the session hours, or until the waiter presses «Paid»; after that the
// menu is browse-only until the QR is scanned again. The phone gets an id kept for a day (renewed on every scan),
// so the staff can tell the phones at a table apart and reject a fake one.
function phoneId(renew) {
  let p = ls.get(PHONE_KEY);
  if (!p || !/^[0-9a-z]{16,32}$/.test(p.id || '') || Date.now() - p.t > PHONE_TTL) {
    p = { id: Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20), t: Date.now() };
    ls.set(PHONE_KEY, p);
  } else if (renew) { p.t = Date.now(); ls.set(PHONE_KEY, p); }
  return p.id;
}
const myPhone = () => S.session?.phone || ls.get(PHONE_KEY)?.id || '';
function initSession() {
  if (PREVIEW || !fbEnabled(S.config) || !ordering()) return;
  const saved = ls.get(SESSION_KEY);
  const valid = saved && saved.sid && saved.table && Date.now() - saved.t < CART_TTL;
  if (URL_TABLE && KEY) {
    // A fresh scan: open a new session (in the background; sending waits for it).
    S.pendingKey = KEY;
    history.replaceState(null, '', location.pathname);
    ensureSession().catch(() => {});
    return;
  }
  if (valid && (!URL_TABLE || URL_TABLE === saved.table)) { S.session = saved; TABLE = saved.table; return; }
  if (saved && !valid) ls.del(SESSION_KEY);
}
let sessionP = null;
function ensureSession() {
  if (!S.pendingKey) return Promise.resolve(S.session);
  sessionP ??= (async () => {
    try {
      const phone = phoneId(true);
      const sid = await startSession(S.config, TABLE, S.pendingKey, phone);
      S.session = { sid, table: TABLE, phone, t: Date.now() };
      ls.set(SESSION_KEY, S.session);
      S.pendingKey = '';
      return S.session;
    } catch (e) {
      if (e.code === 'permission-denied') { // wrong or old QR code
        S.pendingKey = ''; S.badQr = true;
        if (!S.session) { ls.del(SESSION_KEY); render(); toast(t('bad_table'), 'err', 7000); }
      }
      throw e;
    } finally { sessionP = null; }
  })();
  return sessionP;
}
async function who() {
  const s = await ensureSession();
  if (!s) { const e = new Error('no session'); e.code = 'no-session'; throw e; }
  return { table: s.table, sid: s.sid, phone: s.phone };
}
// The session ended (paid / expired / new QR) while this page was open: browse-only from now on.
function sessionOver() {
  S.sessionOver = true; S.session = null;
  ls.del(SESSION_KEY);
  closeSheet(cartSheet); render(); updateCartUI();
  toast(t('table_ended'), 'err', 8000);
}
async function requestFailed(e) {
  if (e.code === 'permission-denied' && S.badQr && !S.session) return; // already told
  if (e.code === 'permission-denied' || e.code === 'no-session') {
    const s = S.session;
    if (s && (await isBlocked(S.config, s.table, s.phone).catch(() => false))) { toast(t('blocked'), 'err', 7000); return; }
    sessionOver(); return;
  }
  console.error(e);
  toast(t('send_failed'), 'err', 5000);
}

// Follows this phone's orders: every 15 s while one is being prepared, then every minute until the bill
// is paid. Once everything is paid the list is cleared (a new guest at this table starts from zero).
let trackTimer = null;
async function trackMine() {
  clearTimeout(trackTimer);
  if (!online()) return;
  if (S.mine.length && Date.now() - S.mineT > CART_TTL) { S.mine = []; saveMine(); }
  const unpaid = myOrders().filter((x) => !x.paid);
  if (unpaid.length && document.visibilityState === 'visible') {
    await Promise.all(unpaid.map(async (x) => {
      try {
        const d = await getRequest(S.config, x.id);
        if (!d || d.type === 'void') x.rejected = true; // the staff rejected it as fake
        else { x.status = d.status; x.paid = !!d.paid; }
      } catch {}
    }));
    if (S.mine.some((x) => x.rejected)) {
      S.mine = S.mine.filter((x) => !x.rejected); saveMine();
      toast(t('order_rejected'), 'err', 7000);
    }
    if (myOrders().length && myOrders().every((x) => x.paid)) {
      S.mine = []; saveMine(); renderMineStatus();
      // «Paid» ends the table session: the next guest on this phone must scan the QR again.
      S.session = null; ls.del(SESSION_KEY); render(); updateCartUI();
      toast(t('paid_thanks'), 'ok', 5000);
      return;
    }
    saveMine();
  }
  renderMineStatus();
  const left = myOrders().filter((x) => !x.paid);
  if (left.length) trackTimer = setTimeout(trackMine, left.some((x) => x.status !== 'done') ? 15000 : 60000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') trackMine(); });
function renderMineStatus() {
  const btn = document.getElementById('myOrders'); if (!btn) return;
  const list = myOrders();
  btn.hidden = !list.length;
  if (!list.length) return;
  const last = list[list.length - 1];
  btn.dataset.status = last.status || 'new';
  document.getElementById('myStatus').textContent = `${t('my_orders')} · ${t(`st_${last.status || 'new'}`)}`;
}
function openMine() {
  const list = myOrders().slice().reverse();
  const sheet = infoSheet;
  sheet.innerHTML = `<div class="sheet__panel" role="dialog" aria-modal="true"><div class="sheet__grip"></div>
    <div class="sheet__head"><h2>${esc(t('my_orders'))}</h2><button class="icon-btn" data-close aria-label="${esc(t('close'))}">${ICONS.close}</button></div>
    <div class="sheet__body"><div class="lines">${list.map((x, i) => `<div class="line">
      <div><div class="line__name">${esc(t('order_n', { n: list.length - i }))}</div><div class="line__size num">${esc(new Date(x.at).toLocaleTimeString(getLang() === 'ar' ? 'ar-SY' : 'en-GB', { hour: '2-digit', minute: '2-digit' }))}</div></div>
      <div style="display:grid;justify-items:end;gap:4px"><span class="line__price num">${esc(fmt(x.total))}</span><span class="st st--${x.status || 'new'}">${esc(t(`st_${x.status || 'new'}`))}</span></div></div>`).join('')}</div></div>
    <div class="sheet__foot"><div class="totals" style="margin:0"><span>${esc(t('total'))}</span><span class="num">${esc(fmt(myTotal()))}</span></div>
      ${myTotal() > 0 ? `<button class="btn btn--ghost btn--block" id="seeBill" style="margin-top:10px">${ICONS.receipt}${esc(t('bill_title'))}</button>` : ''}</div></div>`;
  openSheet(sheet);
  sheet.querySelector('#seeBill')?.addEventListener('click', () => { closeSheet(sheet); setTimeout(openBill, 320); });
}

/* ---------- info sheet ---------- */
function openInfo() {
  const r = S.config.restaurant;
  const map = safeUrl(r.mapUrl);
  const social = socialLinks(r);
  infoSheet.innerHTML = `<div class="sheet__panel" role="dialog" aria-modal="true">
    <div class="sheet__grip"></div>
    <div class="sheet__head"><div class="info-head">${r.logo ? `<div class="logo">${logoInner(r)}</div>` : ''}<div><h2>${esc(tx(r.name))}</h2>${tx(r.tagline) ? `<p class="hint">${esc(tx(r.tagline))}</p>` : ''}</div></div>
      <button class="icon-btn" data-close aria-label="${esc(t('close'))}">${ICONS.close}</button></div>
    <div class="sheet__body">
      ${tx(r.hours) ? `<div class="info-row"><span class="info-row__icon">${ICONS.clock}</span><div><small>${esc(t('hours'))}</small><b>${esc(tx(r.hours))}</b></div></div>` : ''}
      ${r.phone ? `<a class="info-row" href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}"><span class="info-row__icon">${ICONS.phone}</span><div><small>${esc(t('phone'))}</small><b class="num">${esc(r.phone)}</b></div></a>` : ''}
      ${tx(r.address) ? `<${map ? `a href="${esc(map)}" target="_blank" rel="noopener"` : 'div'} class="info-row"><span class="info-row__icon">${ICONS.pin}</span><div><small>${esc(t('address'))}</small><b>${esc(tx(r.address))}</b>${map ? `<small style="color:var(--primary);margin-top:2px">${esc(t('open_map'))}</small>` : ''}</div></${map ? 'a' : 'div'}>` : ''}
      ${social ? `<div style="margin-top:18px"><div class="label" style="margin-bottom:10px">${esc(t('follow_us'))}</div><div class="socials" style="justify-content:flex-start">${social}</div></div>` : ''}
    </div></div>`;
  openSheet(infoSheet);
}

boot();
