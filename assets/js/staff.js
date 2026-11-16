// Staff screen: live orders, waiter calls and bill requests for today.
import { loadSite, initLang, setLang, getLang, t, tx, esc, applyTheme, formatPrice, ICONS, ls, toast } from './core.js';
import { fbEnabled, currentStaff, staffSignIn, staffSignOut, watchToday, setStatus, settleTable } from './fb.js';

const app = document.getElementById('app');
const S = { config: null, docs: [], filter: 'all', showDone: false, sound: ls.get('rm:staffSound', true), unsub: null, first: true, fresh: new Set(), audio: null, error: false };
const TYPE_IC = { order: 'receipt', waiter: 'bell', bill: 'receipt' };
const fmt = (n) => formatPrice(n, S.config);

async function boot() {
  try { S.config = (await loadSite()).config; }
  catch (e) { app.innerHTML = `<div class="login"><div class="login__card"><p class="err-msg">${esc(e.message)}</p></div></div>`; return; }
  applyTheme(S.config, { admin: true });
  initLang(S.config);
  document.title = `${t('staff_title')} · ${tx(S.config.restaurant.name)}`;
  if (!fbEnabled(S.config)) { renderMessage(t('fb_not_ready')); return; }
  try { if (await currentStaff(S.config)) { start(false); return; } } catch (e) { console.error(e); }
  renderLogin();
}

function renderMessage(msg) {
  app.innerHTML = `<div class="login"><div class="login__card" style="text-align:center">${ICONS.alert}<h1 style="font-size:19px">${esc(tx(S.config.restaurant.name))}</h1><p class="sub" style="margin:0">${esc(msg)}</p></div></div>`;
}

function renderLogin(err = '') {
  const needEmail = !S.config.firebase.staffEmail;
  app.innerHTML = `<div class="login"><form class="login__card" id="lf">
    <div class="login__logo">${ICONS.chef}</div>
    <h1>${esc(t('staff_title'))}</h1>
    <p class="sub">${esc(tx(S.config.restaurant.name))} · ${esc(t('staff_login_sub'))}</p>
    <input class="input" type="email" id="em" dir="ltr" placeholder="${esc(t('email'))}" autocomplete="username" value="${esc(S.config.firebase.staffEmail || '')}" ${needEmail ? '' : 'hidden'}>
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
      await staffSignIn(S.config, document.getElementById('pw').value, document.getElementById('em').value);
      start(true);
    } catch (ex) {
      console.error(ex);
      renderLogin(/invalid|wrong|user-not-found|credential/i.test(ex.code || ex.message) ? t('wrong_password') : (ex.code || ex.message));
    }
  };
}

/* ---------- live feed ---------- */
async function start(gesture) {
  renderShell(gesture);
  keepAwake();
  await listen();
  if (!S.tick) S.tick = setInterval(renderList, 30000); // refresh "x min ago"
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
  S.docs = snap.docs.map((d) => { const x = d.data(); return { id: d.id, ...x, ts: x.createdAt?.toMillis ? x.createdAt.toMillis() : Date.now() }; });
  // Ring only for requests not seen before — also catches ones that arrived while reconnecting, without re-ringing old ones.
  const first = !S.seen; S.seen ||= new Set();
  const added = snap.docs.filter((d) => !S.seen.has(d.id) && (d.data().status || 'new') === 'new');
  snap.docs.forEach((d) => S.seen.add(d.id));
  if (!first && added.length) {
    added.forEach((d) => S.fresh.add(d.id));
    setTimeout(() => { added.forEach((d) => S.fresh.delete(d.id)); renderList(); }, 9000);
    ring();
  }
  renderList();
}

function renderShell(gesture) {
  app.innerHTML = `
    <header class="adm-top"><div class="adm-wrap staff-wrap">
      <div class="adm-top__row">
        <div class="adm-brand"><div class="adm-brand__logo">${ICONS.chef}</div>
          <div style="min-width:0"><b>${esc(tx(S.config.restaurant.name))}</b><small>${esc(t('staff_title'))}</small></div></div>
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
  document.getElementById('out').onclick = async () => { clearTimeout(retryT); clearTimeout(dayT); S.unsub?.(); S.unsub = null; await staffSignOut(S.config); S.seen = null; S.error = false; renderLogin(); };
  document.getElementById('unlock')?.addEventListener('click', (e) => { unlockAudio(); beep(); e.currentTarget.remove(); });
  document.getElementById('showDone').onchange = (e) => { S.showDone = e.target.checked; renderList(); };
  document.getElementById('filters').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { S.filter = b.dataset.f; renderList(); } };
  document.getElementById('list').onclick = onAction;
}

const ago = (ts) => { const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? t('ago_now') : m < 60 ? t('ago_min', { n: m }) : t('ago_hr', { n: Math.floor(m / 60) }); };
const tableLabel = (n) => t('table', { n });
// Unpaid orders of a table today (for bill requests).
const tableOrders = (table) => S.docs.filter((d) => d.type === 'order' && d.table === table && !d.paid);

function renderList() {
  const list = document.getElementById('list'); if (!list) return;
  const active = S.docs.filter((d) => d.status !== 'done');
  const count = (f) => active.filter((d) => f === 'all' || d.type === f).length;
  document.getElementById('filters').innerHTML = [['all', 'f_all', 'list'], ['order', 'f_order', 'receipt'], ['waiter', 'f_waiter', 'bell'], ['bill', 'f_bill', 'receipt']]
    .map(([f, key, ic]) => `<button class="tab ${S.filter === f ? 'active' : ''}" data-f="${f}">${ICONS[ic]}${esc(t(key))}${count(f) ? `<span class="tab__n num">${count(f)}</span>` : ''}</button>`).join('');
  const newN = S.docs.filter((d) => (d.status || 'new') === 'new').length;
  document.title = `${newN ? `(${newN}) ` : ''}${t('staff_title')} · ${tx(S.config.restaurant.name)}`;
  const rank = { new: 0, preparing: 1, done: 2 };
  const shown = S.docs
    .filter((d) => (S.filter === 'all' || d.type === S.filter) && (S.showDone || d.status !== 'done'))
    .sort((a, b) => (rank[a.status || 'new'] - rank[b.status || 'new']) || (a.status === 'done' ? b.ts - a.ts : a.ts - b.ts));
  list.innerHTML = (S.error ? `<div class="banner" style="grid-column:1/-1;border-radius:14px">${esc(t('conn_error'))}</div>` : '')
    + (shown.length ? shown.map(cardHTML).join('') : `<div class="empty" style="grid-column:1/-1">${ICONS.chef}<b>${esc(t('no_requests'))}</b><p>${esc(t('no_requests_sub'))}</p></div>`);
}

function cardHTML(d) {
  const st = d.status || 'new';
  let body = '';
  let actions = '';
  if (d.type === 'order') {
    body = `<ul class="tk__items">${(d.items || []).map((i) => `<li><b class="num">${i.qty}×</b><span>${esc(i.name)}${i.size ? ` <small>— ${esc(i.size)}</small>` : ''}${i.note ? `<em>✎ ${esc(i.note)}</em>` : ''}</span></li>`).join('')}</ul>
      <div class="tk__total"><span>${esc(t('total'))}</span><b class="num">${esc(fmt(d.total))}</b></div>`;
    if (st === 'new') actions = `<button class="btn btn--ghost btn--sm" data-act="preparing" data-id="${d.id}">${ICONS.chef}${esc(t('a_prepare'))}</button>`;
    if (st !== 'done') actions += `<button class="btn btn--primary btn--sm" data-act="done" data-id="${d.id}">${ICONS.check}${esc(t('a_done'))}</button>`;
  } else if (d.type === 'waiter') {
    body = `<p class="tk__msg">${ICONS.bell}${esc(t('waiter_msg'))}</p>`;
    if (st !== 'done') actions = `<button class="btn btn--primary btn--sm" data-act="done" data-id="${d.id}">${ICONS.check}${esc(t('a_done'))}</button>`;
  } else {
    const sum = tableOrders(d.table).reduce((a, o) => a + (o.total || 0), 0);
    body = `<p class="tk__msg">${ICONS.receipt}${esc(t('bill_msg'))}</p>
      <div class="tk__total"><span>${esc(t('table_total'))}</span><b class="num">${esc(fmt(sum || d.total || 0))}</b></div>`;
    if (st !== 'done') actions = `<button class="btn btn--primary btn--sm" data-act="paid" data-id="${d.id}" data-table="${esc(d.table)}">${ICONS.check}${esc(t('a_paid'))}</button>`;
  }
  return `<article class="tk tk--${d.type} tk--${st} ${S.fresh.has(d.id) ? 'tk--fresh' : ''}">
    <header class="tk__head">
      <span class="tk__type">${ICONS[TYPE_IC[d.type]]}${esc(t(`k_${d.type}`))}</span>
      <span class="st st--${st}">${esc(t(`s_${st}`))}</span>
    </header>
    <div class="tk__row"><b class="tk__table">${esc(tableLabel(d.table))}</b><time class="num">${esc(ago(d.ts))}</time></div>
    ${body}
    ${actions ? `<footer class="tk__actions">${actions}</footer>` : ''}
  </article>`;
}

async function onAction(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.act === 'paid') await settleTable(S.config, tableOrders(b.dataset.table).map((o) => o.id), b.dataset.id);
    else await setStatus(S.config, b.dataset.id, b.dataset.act);
  } catch (ex) { console.error(ex); toast(ex.code || ex.message, 'err', 5000); b.disabled = false; }
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
