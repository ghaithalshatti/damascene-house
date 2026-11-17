// Staff screen: live orders, waiter calls and bill requests for today.
import { loadSite, initLang, setLang, getLang, t, tx, esc, applyTheme, formatPrice, ICONS, ls, toast, checkOrder, confirmDialog } from './core.js';
import { fbEnabled, currentStaff, staffLogin, staffMe, staffSignOut, watchToday, setStatus, settleTable, rejectPhone, writeInvoice } from './fb.js';

const app = document.getElementById('app');
const S = { config: null, menu: null, me: null, docs: [], filter: 'all', showDone: false, sound: ls.get('rm:staffSound', true), unsub: null, first: true, fresh: new Set(), audio: null, error: false };
const TYPE_IC = { order: 'receipt', waiter: 'bell', bill: 'receipt' };
const fmt = (n) => formatPrice(n, S.config);

async function boot() {
  try { ({ config: S.config, menu: S.menu } = await loadSite()); }
  catch (e) { app.innerHTML = `<div class="login"><div class="login__card"><p class="err-msg">${esc(e.message)}</p></div></div>`; return; }
  applyTheme(S.config, { admin: true });
  initLang(S.config);
  document.title = `${t('staff_title')} · ${tx(S.config.restaurant.name)}`;
  if (!fbEnabled(S.config)) { renderMessage(t('fb_not_ready')); return; }
  try { if (await currentStaff(S.config) && await identify()) { start(false); return; } } catch (e) { console.error(e); }
  renderLogin();
}
// Who is using this screen: the manager (the main staff account) or a waiter with their own account.
async function identify() {
  S.me = await staffMe(S.config, t('manager_name'));
  if (!S.me) { await staffSignOut(S.config).catch(() => {}); return false; }
  return true;
}

function renderMessage(msg) {
  app.innerHTML = `<div class="login"><div class="login__card" style="text-align:center">${ICONS.alert}<h1 style="font-size:19px">${esc(tx(S.config.restaurant.name))}</h1><p class="sub" style="margin:0">${esc(msg)}</p></div></div>`;
}

function renderLogin(err = '') {
  app.innerHTML = `<div class="login"><form class="login__card" id="lf">
    <div class="login__logo">${ICONS.chef}</div>
    <h1>${esc(t('staff_title'))}</h1>
    <p class="sub">${esc(tx(S.config.restaurant.name))} · ${esc(t('staff_login_sub'))}</p>
    <input class="input" type="text" id="em" dir="ltr" placeholder="${esc(t('username'))}" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(ls.get('rm:staffUser', ''))}">
    <p class="hint" style="margin:-4px 2px 2px;font-size:12.5px">${esc(t('username_hint'))}</p>
    <div class="pw"><input class="input" type="password" id="pw" placeholder="${esc(t('password'))}" autocomplete="current-password" required>
      <button type="button" id="eye">${ICONS.eye}</button></div>
    <div class="err-msg" id="err">${esc(err)}</div>
    <button class="btn btn--primary btn--block" id="go">${ICONS.lock}<span>${esc(t('login'))}</span></button>
    ${S.config.languages.enabled.length > 1 ? `<button type="button" class="btn btn--ghost btn--sm lang-mini" id="lang">${ICONS.globe}${esc(t('lang_switch'))}</button>` : ''}
  </form></div>`;
  document.getElementById('eye').onclick = () => { const p = document.getElementById('pw'); p.type = p.type === 'password' ? 'text' : 'password'; };
  document.getElementById('lang')?.addEventListener('click', () => { setLang(getLang() === 'ar' ? 'en' : 'ar'); renderLogin(); });
  document.getElementById('lf').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('go');
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${esc(t('checking'))}`;
    unlockAudio();
    try {
      const user = document.getElementById('em').value.trim();
      await staffLogin(S.config, user, document.getElementById('pw').value);
      if (!(await identify())) { renderLogin(t('account_removed')); return; }
      ls.set('rm:staffUser', user);
      start(true);
    } catch (ex) {
      console.error(ex);
      renderLogin(/invalid|wrong|user-not-found|credential/i.test(ex.code || ex.message) ? t('wrong_login') : (ex.code || ex.message));
    }
  };
}

/* ---------- live feed ---------- */
async function start(gesture) {
  renderShell(gesture);
  keepAwake();
  await listen();
  if (!S.tick) S.tick = setInterval(() => { renderList(); refreshMenu(); }, 30000); // refresh "x min ago" (+ the menu every 5 min)
}

// Live listener that heals itself: on any error it re-subscribes with back-off (2s, 4s, 8s … 30s),
// again as soon as the device is back online or the tab is shown, and rolls over to the new day at midnight.
let retryT = 0, retryN = 0, dayT = 0;
async function listen() {
  clearTimeout(retryT);
  S.unsub?.(); S.unsub = null;
  try { S.unsub = await watchToday(S.config, onSnap, onErr); } catch (e) { onErr(e); return; }
  clearTimeout(dayT);
  const now = new Date(); const next = new Date(now); next.setHours(24, 0, 5, 0);
  dayT = setTimeout(() => { S.seen = null; listen(); }, next - now);
}
function onErr(err) {
  console.error(err);
  // This waiter's account was removed by the manager: back to the sign-in screen.
  if (err?.code === 'permission-denied' && S.me && !S.me.manager) {
    identify().then((ok) => { if (!ok) logout(t('account_removed')); }).catch(() => {});
  }
  S.error = true; renderList();
  S.unsub?.(); S.unsub = null;
  clearTimeout(retryT);
  retryT = setTimeout(listen, Math.min(30000, 2000 * 2 ** retryN++));
}
const reconnect = () => { if (S.error && S.config) { retryN = 0; listen(); } };
addEventListener('online', reconnect);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconnect(); });

function onSnap(snap) {
  S.error = false; retryN = 0;
  const ms = (v) => (v?.toMillis ? v.toMillis() : 0);
  S.docs = snap.docs.filter((d) => d.data().type !== 'void') // rejected (fake) requests disappear everywhere
    .map((d) => { const x = d.data(); return { id: d.id, ...x, ts: ms(x.createdAt) || Date.now(), paidAt: ms(x.paidAt) }; });
  // Ring only for requests not seen before — also catches ones that arrived while reconnecting, without re-ringing old ones.
  const first = !S.seen; S.seen ||= new Set();
  const added = snap.docs.filter((d) => !S.seen.has(d.id) && (d.data().status || 'new') === 'new' && d.data().type !== 'void');
  snap.docs.forEach((d) => S.seen.add(d.id));
  if (!first && added.length) {
    added.forEach((d) => S.fresh.add(d.id));
    setTimeout(() => { added.forEach((d) => S.fresh.delete(d.id)); renderList(); }, 9000);
    ring();
  }
  renderList();
  syncInvoices();
}

// Open bill requests get the table's full invoice written into them (the guest's phone shows it): every unpaid
// order of the table from every phone, priced from the menu, identical dishes merged. Rewritten if orders change.
const invSent = new Map();
function tableInvoice(table) {
  const map = new Map(); const orders = tableOrders(table);
  for (const o of orders) {
    const c = checked(o);
    (o.items || []).forEach((l, i) => {
      const ln = c.lines[i]; const si = Number.isInteger(l.si) ? l.si : -1;
      const key = `${l.id}|${si}|${ln.price}`;
      const r = map.get(key) || { id: String(l.id || ''), si, name: ln.name, size: ln.size, qty: 0, price: ln.price };
      r.qty += ln.qty; map.set(key, r);
    });
  }
  const lines = [...map.values()];
  return { lines, orders: orders.length, total: lines.reduce((a, r) => a + r.price * r.qty, 0) };
}
function syncInvoices() {
  if (!S.menu || !S.me) return;
  for (const b of S.docs.filter((d) => d.type === 'bill' && d.status !== 'done')) {
    const inv = tableInvoice(b.table);
    const sig = `${inv.orders}|${inv.total}`;
    if ((b.invoice && `${b.invoice.orders}|${b.invoice.total}` === sig) || invSent.get(b.id) === sig) continue;
    invSent.set(b.id, sig); // once per change, also when it fails (e.g. old rules)
    writeInvoice(S.config, b.id, inv).catch((e) => console.error(e));
  }
}

function renderShell(gesture) {
  app.innerHTML = `
    <header class="adm-top"><div class="adm-wrap staff-wrap">
      <div class="adm-top__row">
        <div class="adm-brand"><div class="adm-brand__logo">${ICONS.chef}</div>
          <div style="min-width:0"><b>${esc(tx(S.config.restaurant.name))}</b><small>${esc(t('staff_title'))} · ${esc(S.me?.name || '')}</small></div></div>
        <div class="adm-actions">
          <button class="icon-btn" id="snd" title="sound">${S.sound ? ICONS.sound : ICONS.mute}</button>
          ${S.config.languages.enabled.length > 1 ? `<button class="icon-btn" id="lang" title="${esc(t('lang_switch'))}">${ICONS.globe}</button>` : ''}
          <button class="icon-btn" id="out" title="${esc(t('logout'))}">${ICONS.logout}</button>
        </div>
      </div>
      <nav class="tabs" id="filters"></nav>
    </div></header>
    ${gesture ? '' : `<button class="sound-banner" id="unlock">${ICONS.sound}${esc(t('enable_sound'))}</button>`}
    <main class="adm-wrap staff-wrap adm-main">
      <label class="check" style="margin:0 4px 12px"><input type="checkbox" id="showDone" ${S.showDone ? 'checked' : ''}>${esc(t('show_done'))}</label>
      <div class="tk-grid" id="list"></div>
    </main>`;
  document.getElementById('snd').onclick = () => { S.sound = !S.sound; ls.set('rm:staffSound', S.sound); unlockAudio(); document.getElementById('snd').innerHTML = S.sound ? ICONS.sound : ICONS.mute; if (S.sound) beep(); };
  document.getElementById('lang')?.addEventListener('click', () => { setLang(getLang() === 'ar' ? 'en' : 'ar'); renderShell(true); renderList(); });
  document.getElementById('out').onclick = () => logout();
  document.getElementById('unlock')?.addEventListener('click', (e) => { unlockAudio(); beep(); e.currentTarget.remove(); });
  document.getElementById('showDone').onchange = (e) => { S.showDone = e.target.checked; renderList(); };
  document.getElementById('filters').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { S.filter = b.dataset.f; renderList(); } };
  document.getElementById('list').onclick = onAction;
}

async function logout(msg = '') {
  clearTimeout(retryT); clearTimeout(dayT); S.unsub?.(); S.unsub = null;
  await staffSignOut(S.config).catch(() => {});
  S.seen = null; S.error = false; S.me = null; S.filter = 'all';
  renderLogin(msg);
}
const ago = (ts) => { const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? t('ago_now') : m < 60 ? t('ago_min', { n: m }) : t('ago_hr', { n: Math.floor(m / 60) }); };
const tableLabel = (n) => t('table', { n });
// Requests are taken by the first staff member who acts on them (prepare / done / paid).
const isMine = (d) => !!S.me && d.claimedBy === S.me.uid;
const isTaken = (d) => !!d.claimedBy && !isMine(d);
// Unpaid orders of a table today (for bill requests).
const tableOrders = (table) => S.docs.filter((d) => d.type === 'order' && d.table === table && !d.paid);

// Phones at each table in the current sitting (since the table's last "Paid"), numbered in the order they
// first sent something. Only tables with more than one phone are returned: then all their cards turn red
// (blinking until taken) and show which phone sent them — a phone that isn't the guests' stands out.
function phoneNumbers() {
  const lastPaid = new Map();
  for (const d of S.docs) if (d.paidAt) lastPaid.set(d.table, Math.max(lastPaid.get(d.table) || 0, d.paidAt));
  const byTable = new Map();
  for (const d of [...S.docs].sort((a, b) => a.ts - b.ts)) {
    if (!d.phone || d.paid || d.ts <= (lastPaid.get(d.table) || 0)) continue;
    const m = byTable.get(d.table) || new Map(); byTable.set(d.table, m);
    if (!m.has(d.phone)) m.set(d.phone, m.size + 1);
  }
  const out = new Map();
  for (const [table, m] of byTable) if (m.size > 1) for (const [g, n] of m) out.set(`${table}|${g}`, n);
  return out;
}
// Orders re-priced from the menu (the price a phone sends is never trusted).
const checked = (o) => checkOrder(o, S.menu, S.config);
// Keeps the menu fresh (the owner may change prices while this screen stays open), and re-checks
// right away when an order doesn't match, so a just-published price change isn't flagged.
let menuAt = Date.now();
async function refreshMenu(force = false) {
  if (!force && Date.now() - menuAt < 5 * 60e3) return;
  if (force && Date.now() - menuAt < 30e3) return;
  menuAt = Date.now();
  try { S.menu = (await loadSite()).menu; renderList(); syncInvoices(); } catch {}
}

function renderList() {
  const list = document.getElementById('list'); if (!list) return;
  S.phones = phoneNumbers();
  const active = S.docs.filter((d) => d.status !== 'done');
  const count = (f) => active.filter((d) => (f === 'mine' ? isMine(d) : f === 'all' || d.type === f)).length;
  if (S.filter === 'mine' && S.me?.manager) S.filter = 'all';
  document.getElementById('filters').innerHTML = [['all', 'f_all', 'list'], ['order', 'f_order', 'receipt'], ['waiter', 'f_waiter', 'bell'], ['bill', 'f_bill', 'receipt']]
    .map(([f, key, ic]) => `<button class="tab ${S.filter === f ? 'active' : ''}" data-f="${f}">${ICONS[ic]}${esc(t(key))}${count(f) ? `<span class="tab__n num">${count(f)}</span>` : ''}</button>`).join('')
    + (S.me && !S.me.manager ? `<button class="tab ${S.filter === 'mine' ? 'active' : ''}" data-f="mine">${ICONS.user}${esc(t('f_mine'))}${count('mine') ? `<span class="tab__n tab__n--mine num">${count('mine')}</span>` : ''}</button>` : '')
    + `<button class="tab ${S.filter === 'log' ? 'active' : ''}" data-f="log">${ICONS.clock}${esc(t('f_log'))}</button>`;
  const newN = S.docs.filter((d) => (d.status || 'new') === 'new').length;
  document.title = `${newN ? `(${newN}) ` : ''}${t('staff_title')} · ${tx(S.config.restaurant.name)}`;
  const doneBox = document.getElementById('showDone')?.closest('label');
  if (doneBox) doneBox.hidden = S.filter === 'log';
  if (S.filter === 'log') { list.innerHTML = (S.error ? `<div class="banner" style="grid-column:1/-1;border-radius:14px">${esc(t('conn_error'))}</div>` : '') + logHTML(); return; }
  const rank = { new: 0, preparing: 1, done: 2 };
  const shown = S.docs
    .filter((d) => (S.filter === 'all' || d.type === S.filter || (S.filter === 'mine' && isMine(d))) && (S.showDone || d.status !== 'done'))
    .sort((a, b) => (rank[a.status || 'new'] - rank[b.status || 'new']) || (a.status === 'done' ? b.ts - a.ts : a.ts - b.ts));
  list.innerHTML = (S.error ? `<div class="banner" style="grid-column:1/-1;border-radius:14px">${esc(t('conn_error'))}</div>` : '')
    + (shown.length ? shown.map(cardHTML).join('') : `<div class="empty" style="grid-column:1/-1">${ICONS.chef}<b>${esc(t('no_requests'))}</b><p>${esc(t('no_requests_sub'))}</p></div>`);
}

// Today's log: every request of the day, grouped by table, with what is paid and what is still due.
function logHTML() {
  if (!S.docs.length) return `<div class="empty" style="grid-column:1/-1">${ICONS.receipt}<b>${esc(t('log_empty'))}</b></div>`;
  const total = (o) => checked(o).total;
  const sum = (list) => list.reduce((a, o) => a + total(o), 0);
  const orders = S.docs.filter((d) => d.type === 'order');
  const all = sum(orders); const paid = sum(orders.filter((o) => o.paid));
  const stat = (cls, ic, val, key) => `<div class="stat stat--${cls}"><span class="stat__ic">${ICONS[ic]}</span><div><b class="num">${esc(String(val))}</b><small>${esc(t(key))}</small></div></div>`;
  const time = (ts) => new Date(ts).toLocaleTimeString(getLang() === 'ar' ? 'ar-SY' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const groups = new Map();
  for (const d of S.docs) {
    const g = groups.get(d.table) || { table: d.table, orders: [], calls: 0, last: 0 };
    if (d.type === 'order') g.orders.push(d); else g.calls++;
    g.last = Math.max(g.last, d.ts || 0);
    groups.set(d.table, g);
  }
  const cards = [...groups.values()].sort((a, b) => b.last - a.last).map((g) => {
    const gAll = sum(g.orders); const due = gAll - sum(g.orders.filter((o) => o.paid));
    const rows = [...g.orders].sort((a, b) => a.ts - b.ts).map((o) => {
      const st = o.paid ? 'done' : o.status || 'new';
      const items = checked(o).lines.map((i) => `${i.qty}× ${esc(i.name)}${i.size ? ` (${esc(i.size)})` : ''}`).join(getLang() === 'ar' ? '، ' : ', ');
      return `<li><time class="num">${esc(time(o.ts))}</time><span>${items}</span><b class="num">${esc(fmt(total(o)))}</b>
        <div class="log-meta"><small class="st st--${st}">${esc(o.paid ? t('log_paid') : t(`s_${st}`))}</small>${o.claimedName ? `<small class="log-by">${ICONS.user}${esc(o.claimedName)}</small>` : ''}</div></li>`;
    }).join('');
    const badge = !g.orders.length ? '' : due > 0 ? `<span class="st st--new">${esc(t('log_unpaid'))}</span>` : `<span class="st st--done">${esc(t('log_paid'))}</span>`;
    return `<article class="tk tk--log ${due > 0 ? 'tk--due' : ''}">
      <div class="tk__row"><b class="tk__table">${esc(tableLabel(g.table))}</b>${badge}</div>
      ${rows ? `<ul class="log-items">${rows}</ul>` : ''}
      ${g.calls ? `<p class="log-calls">${ICONS.bell}${esc(t('log_calls', { n: g.calls }))}</p>` : ''}
      ${g.orders.length ? `<div class="tk__total"><span>${esc(t('total'))}</span><b class="num">${esc(fmt(gAll))}</b></div>` : ''}
      ${due > 0 && due < gAll ? `<div class="tk__total"><span>${esc(t('log_due'))}</span><b class="num">${esc(fmt(due))}</b></div>` : ''}
    </article>`;
  }).join('');
  return `<div class="stats log-stats">${stat('total', 'receipt', orders.length, 't_orders')}${stat('on', 'chart', fmt(all), 't_sales')}${stat('cats', 'check', fmt(paid), 'log_paid')}${stat('off', 'clock', fmt(all - paid), 'log_unpaid')}</div>${cards}`;
}

function cardHTML(d) {
  const st = d.status || 'new';
  const phone = d.phone && !d.paid ? S.phones?.get(`${d.table}|${d.phone}`) : 0;
  let body = '';
  let actions = '';
  if (d.type === 'order') {
    const c = checked(d);
    if (!c.ok) refreshMenu(true);
    body = `<ul class="tk__items">${c.lines.map((i) => `<li><b class="num">${i.qty}×</b><span>${esc(i.name)}${i.size ? ` <small>— ${esc(i.size)}</small>` : ''}${i.ok ? '' : ` <small class="tk__bad">⚠ ${esc(i.known ? t('price_sent', { p: fmt(i.sent) }) : t('item_unknown'))}</small>`}${i.note ? `<em>✎ ${esc(i.note)}</em>` : ''}</span></li>`).join('')}</ul>
      ${c.ok ? '' : `<p class="tk__warn">${ICONS.alert}${esc(t('price_mismatch', { sent: fmt(c.sentTotal) }))}</p>`}
      <div class="tk__total"><span>${esc(t('total'))}</span><b class="num">${esc(fmt(c.total))}</b></div>`;
    if (st === 'new') actions = `<button class="btn btn--ghost btn--sm" data-act="preparing" data-id="${d.id}">${ICONS.chef}${esc(t('a_prepare'))}</button>`;
    if (st !== 'done') actions += `<button class="btn btn--primary btn--sm" data-act="done" data-id="${d.id}">${ICONS.check}${esc(t('a_done'))}</button>`;
  } else if (d.type === 'waiter') {
    body = `<p class="tk__msg">${ICONS.bell}${esc(t('waiter_msg'))}</p>`;
    if (st !== 'done') actions = `<button class="btn btn--primary btn--sm" data-act="done" data-id="${d.id}">${ICONS.check}${esc(t('a_done'))}</button>`;
  } else {
    const sum = tableOrders(d.table).reduce((a, o) => a + checked(o).total, 0);
    body = `<p class="tk__msg">${ICONS.receipt}${esc(t('bill_msg'))}</p>
      <div class="tk__total"><span>${esc(t('table_total'))}</span><b class="num">${esc(fmt(sum || d.total || 0))}</b></div>`;
    if (st !== 'done') actions = `<button class="btn btn--primary btn--sm" data-act="paid" data-id="${d.id}" data-table="${esc(d.table)}">${ICONS.check}${esc(t('a_paid'))}</button>`;
  }
  // Fake request (nobody at the table): reject it — only needed when it happens.
  if (st !== 'done' && !d.paid && d.phone) actions = `<button class="btn btn--ghost btn--sm tk__reject" data-act="reject" data-id="${d.id}" data-table="${esc(d.table)}" title="${esc(t('a_reject'))}">${ICONS.close}${esc(t('a_reject'))}</button>${actions}`;
  // Taken by a colleague: the buttons stay visible but can't be pressed (the manager can still act).
  if (isTaken(d) && !S.me?.manager) actions = actions.replaceAll('<button ', `<button disabled title="${esc(t('claim_by', { n: d.claimedName || '' }))}" `);
  const claim = isMine(d) ? `<p class="tk__claim tk__claim--mine">${ICONS.user}${esc(t('claim_mine'))}</p>`
    : d.claimedName ? `<p class="tk__claim">${ICONS.user}${esc(t('claim_by', { n: d.claimedName }))}</p>` : '';
  // More than one phone at this table: red, and blinking until someone takes it.
  const multi = phone ? ` tk--multi${st === 'new' && !d.claimedBy ? ' tk--alarm' : ''}` : '';
  return `<article class="tk tk--${d.type} tk--${st} ${isMine(d) ? 'tk--mine' : ''} ${isTaken(d) ? 'tk--taken' : ''} ${S.fresh.has(d.id) ? 'tk--fresh' : ''}${multi}">
    <header class="tk__head">
      <span class="tk__type">${ICONS[TYPE_IC[d.type]]}${esc(t(`k_${d.type}`))}</span>
      <span class="st st--${st}">${esc(t(`s_${st}`))}</span>
    </header>
    <div class="tk__row"><span class="tk__where"><b class="tk__table">${esc(tableLabel(d.table))}</b>${phone ? `<span class="tk__phone" title="${esc(t('phone_n', { n: phone }))}">${ICONS.mobile}<b class="num">${phone}</b></span>` : ''}</span><time class="num">${esc(ago(d.ts))}</time></div>
    ${claim}
    ${body}
    ${actions ? `<footer class="tk__actions">${actions}</footer>` : ''}
  </article>`;
}

async function onAction(e) {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const d = S.docs.find((x) => x.id === b.dataset.id); if (!d) return;
  if (b.dataset.act === 'reject' && !(await confirmDialog(t('reject_q', { n: d.table }), { okText: t('a_reject'), danger: true }))) return;
  b.disabled = true;
  try {
    if (b.dataset.act === 'paid') await settleTable(S.config, d.table, tableOrders(d.table), d, S.me);
    else if (b.dataset.act === 'reject') {
      // Every unpaid request this phone sent to the table goes with it.
      const since = Math.max(0, ...S.docs.filter((x) => x.table === d.table).map((x) => x.paidAt || 0));
      const gone = S.docs.filter((x) => x.table === d.table && !x.paid && (x.id === d.id || (d.phone && x.phone === d.phone && x.ts > since)));
      await rejectPhone(S.config, d.table, d.phone, gone);
      const ids = new Set(gone.map((x) => x.id));
      S.docs = S.docs.filter((x) => !ids.has(x.id)); renderList();
      toast(t('rejected_ok'), 'ok');
    } else await setStatus(S.config, d, b.dataset.act, S.me);
  } catch (ex) {
    console.error(ex); b.disabled = false;
    if (ex.code === 'permission-denied') {
      // A colleague pressed first (the rules refuse a request someone else took), or this account was removed.
      if (!S.me.manager && !(await identify().catch(() => true))) { await logout(t('account_removed')); return; }
      toast(t('taken_first'), 'err', 5000); return;
    }
    toast(ex.code === 'unavailable' ? t('conn_error') : (ex.code || ex.message), 'err', 5000);
  }
}

/* ---------- alerts ---------- */
function unlockAudio() {
  try { S.audio ??= new (window.AudioContext || window.webkitAudioContext)(); if (S.audio.state === 'suspended') S.audio.resume(); } catch {}
}
function beep() {
  if (!S.sound || !S.audio) return;
  const now = S.audio.currentTime;
  [0, 0.22, 0.44].forEach((d, i) => {
    const o = S.audio.createOscillator(); const g = S.audio.createGain();
    o.type = 'sine'; o.frequency.value = [880, 1175, 1568][i];
    g.gain.setValueAtTime(0.0001, now + d); g.gain.exponentialRampToValueAtTime(0.35, now + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.2);
    o.connect(g).connect(S.audio.destination); o.start(now + d); o.stop(now + d + 0.22);
  });
}
function ring() { beep(); try { navigator.vibrate?.([200, 100, 200]); } catch {} }

// Keep the screen on while this page is open.
let lock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

boot();
