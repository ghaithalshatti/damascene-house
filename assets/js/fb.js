// Firebase layer: customer requests (orders, waiter calls, bill requests) and the staff side.
// The SDK is bundled locally and loaded only when needed, so the menu stays light.
export const fbEnabled = (cfg) => !!(cfg?.firebase?.apiKey && cfg?.firebase?.projectId);

// Local testing hook: localStorage rm:fbEmu = {"host":"127.0.0.1","fs":8080,"auth":9099}
const emu = () => { try { return JSON.parse(localStorage.getItem('rm:fbEmu') || 'null'); } catch { return null; } };
const opts = (cfg) => {
  const f = cfg.firebase;
  return { apiKey: f.apiKey, authDomain: f.authDomain || `${f.projectId}.firebaseapp.com`, projectId: f.projectId, appId: f.appId || undefined };
};

let liteP = null; let fullP = null; let gen = 0;
// Call after the Firebase settings change (setup page) so the next call re-initialises.
export function resetFirebase() { liteP = null; fullP = null; gen += 1; }
function lite(cfg) {
  liteP ??= (async () => {
    const m = await import('../vendor/firebase-lite.mjs');
    const app = m.initializeApp(opts(cfg), `rm-lite-${gen}`);
    const db = m.getFirestore(app);
    const e = emu(); if (e) m.connectFirestoreEmulator(db, e.host, e.fs);
    return { m, db };
  })();
  return liteP;
}
function full(cfg) {
  fullP ??= (async () => {
    const m = await import('../vendor/firebase-full.mjs');
    const app = m.initializeApp(opts(cfg), `rm-full-${gen}`);
    const db = m.getFirestore(app);
    const auth = m.getAuth(app);
    const e = emu();
    if (e) { m.connectFirestoreEmulator(db, e.host, e.fs); m.connectAuthEmulator(auth, `http://${e.host}:${e.auth}`, { disableWarnings: true }); }
    await m.setPersistence(auth, m.browserLocalPersistence);
    return { m, db, auth };
  })();
  return fullP;
}

/* ---------- customer ---------- */
// A table session starts when the QR is scanned: { table, k, phone, createdAt }. Requests then carry its id
// (sid) and the phone id instead of the table key; the rules check that the session is still open
// (younger than the session hours and opened after the table's last "Paid") and the phone isn't blocked.
export async function startSession(cfg, table, k, phone) {
  const { m, db } = await lite(cfg);
  const ref = await m.addDoc(m.collection(db, 'sessions'), { table, k, phone, createdAt: m.serverTimestamp() });
  return ref.id;
}
export async function sendRequest(cfg, data) {
  const { m, db } = await lite(cfg);
  const ref = await m.addDoc(m.collection(db, 'orders'), { ...data, status: 'new', createdAt: m.serverTimestamp() });
  return ref.id;
}
export async function getRequest(cfg, id) {
  const { m, db } = await lite(cfg);
  const s = await m.getDoc(m.doc(db, 'orders', id));
  return s.exists() ? s.data() : null;
}
// True while the staff have blocked this phone at this table (after a «Reject»).
export async function isBlocked(cfg, table, phone) {
  const { m, db } = await lite(cfg);
  const s = await m.getDoc(m.doc(db, 'blocks', `${table}_${phone}`));
  const until = s.exists() ? s.data().until : null;
  return !!until && (until.toMillis ? until.toMillis() : +until) > Date.now();
}
export const sessionHours = (cfg) => Math.max(1, Math.min(24, parseInt(cfg?.firebase?.sessionHours, 10) || 4));
export const BLOCK_HOURS = 3;

/* ---------- staff ---------- */
// One account per waiter (created by the manager from the admin page) + the manager account
// (config.firebase.staffEmail). Waiters sign in with a username; logins/{username} holds the account's email.
export const isManagerEmail = (cfg, email) => !!email && (email || '').toLowerCase() === (cfg.firebase.staffEmail || '').toLowerCase();
export async function currentStaff(cfg) {
  const { auth } = await full(cfg);
  await auth.authStateReady();
  return auth.currentUser;
}
export async function staffSignIn(cfg, password, email) {
  const { m, auth } = await full(cfg);
  const cred = await m.signInWithEmailAndPassword(auth, (email || cfg.firebase.staffEmail || '').trim(), password);
  return cred.user;
}
// Username → that waiter's account; an empty username = the manager account.
export async function staffLogin(cfg, username, password) {
  const u = cleanUser(username);
  if (!u) return staffSignIn(cfg, password);
  const { m, db } = await full(cfg);
  const s = await m.getDoc(m.doc(db, 'logins', u));
  if (!s.exists()) { const e = new Error('wrong'); e.code = 'auth/invalid-credential'; throw e; }
  return staffSignIn(cfg, password, s.data().email);
}
export async function staffSignOut(cfg) { const { m, auth } = await full(cfg); await m.signOut(auth); }
// Who is signed in: { uid, manager, name } — null when the account is no longer on the staff list.
export async function staffMe(cfg, managerName) {
  const { m, db, auth } = await full(cfg);
  await auth.authStateReady();
  const u = auth.currentUser; if (!u) return null;
  if (isManagerEmail(cfg, u.email)) return { uid: u.uid, manager: true, name: managerName };
  let s;
  try { s = await m.getDoc(m.doc(db, 'staff', u.uid)); } catch (e) { if (e.code === 'permission-denied') return null; throw e; }
  return s.exists() ? { uid: u.uid, manager: false, name: s.data().name || '', username: s.data().username || '' } : null;
}
export const cleanUser = (u) => String(u || '').trim().toLowerCase();
export const validUser = (u) => /^[a-z0-9_.-]{2,20}$/.test(u);

// Manager only: waiter accounts. A secondary app creates the account so the manager stays signed in.
export async function listStaff(cfg) {
  const { m, db } = await full(cfg);
  const snap = await m.getDocs(m.collection(db, 'staff'));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
async function newAccount(cfg, username, password) {
  const { m } = await full(cfg);
  const app = m.initializeApp(opts(cfg), `rm-new-${Date.now()}`);
  try {
    const auth = m.getAuth(app);
    const e = emu(); if (e) m.connectAuthEmulator(auth, `http://${e.host}:${e.auth}`, { disableWarnings: true });
    await m.setPersistence(auth, m.inMemoryPersistence);
    const tag = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
    const email = `${username}-${tag}@${cfg.firebase.projectId}.firebaseapp.com`.toLowerCase();
    const cred = await m.createUserWithEmailAndPassword(auth, email, password);
    await m.signOut(auth);
    return { uid: cred.user.uid, email };
  } finally { await m.deleteApp(app).catch(() => {}); }
}
export async function addStaff(cfg, { name, username, password }) {
  const { m, db } = await full(cfg);
  const u = cleanUser(username);
  if ((await m.getDoc(m.doc(db, 'logins', u))).exists()) { const e = new Error('taken'); e.code = 'username-taken'; throw e; }
  const acc = await newAccount(cfg, u, password);
  const b = m.writeBatch(db);
  b.set(m.doc(db, 'staff', acc.uid), { name: name.trim(), username: u, email: acc.email, createdAt: m.serverTimestamp() });
  b.set(m.doc(db, 'logins', u), { email: acc.email });
  await b.commit();
}
// A new password = a new account under the same username (the client SDK can't change another user's password).
export async function resetStaffPassword(cfg, member, password) {
  const { m, db } = await full(cfg);
  const acc = await newAccount(cfg, member.username, password);
  const b = m.writeBatch(db);
  b.set(m.doc(db, 'staff', acc.uid), { name: member.name, username: member.username, email: acc.email, createdAt: m.serverTimestamp() });
  b.set(m.doc(db, 'logins', member.username), { email: acc.email });
  b.delete(m.doc(db, 'staff', member.uid));
  await b.commit();
}
export async function removeStaff(cfg, member) {
  const { m, db } = await full(cfg);
  const b = m.writeBatch(db);
  b.delete(m.doc(db, 'staff', member.uid));
  if (member.username) b.delete(m.doc(db, 'logins', member.username));
  await b.commit();
}

export const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

// Live feed of today's requests; returns an unsubscribe function.
export async function watchToday(cfg, onChange, onError) {
  const { m, db } = await full(cfg);
  const q = m.query(m.collection(db, 'orders'), m.where('createdAt', '>=', m.Timestamp.fromDate(startOfDay())), m.orderBy('createdAt', 'desc'), m.limit(500));
  return m.onSnapshot(q, onChange, onError);
}
export async function dayRequests(cfg, day = new Date()) {
  const { m, db } = await full(cfg);
  const from = startOfDay(day); const to = new Date(from); to.setDate(to.getDate() + 1);
  const q = m.query(m.collection(db, 'orders'), m.where('createdAt', '>=', m.Timestamp.fromDate(from)), m.where('createdAt', '<', m.Timestamp.fromDate(to)), m.orderBy('createdAt', 'asc'));
  const snap = await m.getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.type !== 'void');
}
// The first one to act on a request takes it (claimedBy / claimedName); the rules refuse a colleague's.
const claimOf = (d, me) => (d && !d.claimedBy && me ? { claimedBy: me.uid, claimedName: me.name } : {});
export async function setStatus(cfg, d, status, me) {
  const { m, db } = await full(cfg);
  await m.updateDoc(m.doc(db, 'orders', d.id), { status, updatedAt: m.serverTimestamp(), ...claimOf(d, me) });
}
// Marks a table's orders as paid, closes its bill request and ends every table session opened before now.
export async function settleTable(cfg, table, orders, bill, me) {
  const { m, db } = await full(cfg);
  const b = m.writeBatch(db);
  const now = m.serverTimestamp();
  orders.forEach((o) => b.update(m.doc(db, 'orders', o.id), { paid: true, paidAt: now, status: 'done', updatedAt: now }));
  if (bill) b.update(m.doc(db, 'orders', bill.id), { status: 'done', paidAt: now, updatedAt: now, ...claimOf(bill, me) });
  b.set(m.doc(db, 'tables', String(table)), { since: now }, { merge: true });
  await b.commit();
}
// The table's full invoice, written into the guest's bill request by the staff screen: the guest's phone
// can only read its own requests, so this is how it gets the whole table's bill.
export async function writeInvoice(cfg, billId, invoice) {
  const { m, db } = await full(cfg);
  await m.updateDoc(m.doc(db, 'orders', billId), { invoice });
}
// Fake request (nobody at the table): every unpaid request of that phone at the table is voided (hidden
// everywhere) and the phone can't order for this table for BLOCK_HOURS.
export async function rejectPhone(cfg, table, phone, docs) {
  const { m, db } = await full(cfg);
  const b = m.writeBatch(db);
  docs.forEach((d) => b.update(m.doc(db, 'orders', d.id), { type: 'void', status: 'done', updatedAt: m.serverTimestamp() }));
  if (phone) b.set(m.doc(db, 'blocks', `${table}_${phone}`), { until: m.Timestamp.fromMillis(Date.now() + BLOCK_HOURS * 3600e3) });
  await b.commit();
}

// Secret key per table (stored in Firestore, readable by staff only). QR codes carry it as &k=…
export async function tableKeys(cfg, from, to) {
  const { m, db } = await full(cfg);
  const out = {};
  for (let i = from; i <= to; i++) {
    const ref = m.doc(db, 'tables', String(i));
    const s = await m.getDoc(ref);
    let k = s.exists() ? s.data().k : '';
    if (!k) { k = randomKey(); await m.setDoc(ref, { k }, { merge: true }); }
    out[i] = k;
  }
  return out;
}
const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8);

// Firestore security rules for one restaurant (pasted in the Firebase console; again after the session hours change).
export function rulesFor(cfg) {
  const f = cfg?.firebase || {};
  const email = (f.staffEmail || 'staff@example.com').toLowerCase().replace(/[^a-z0-9@._+-]/g, '');
  const hours = sessionHours(cfg);
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    // The restaurant manager (the account typed in setup) — can override everything.
    function isManager() { return signedIn() && request.auth.token.email == '${email}'; }
    // Waiters: one account each, listed in /staff by the manager.
    function isStaff() { return isManager() || (signedIn() && exists(/databases/$(database)/documents/staff/$(request.auth.uid))); }
    function staffName() { return get(/databases/$(database)/documents/staff/$(request.auth.uid)).data.name; }
    function tbl(t) { return get(/databases/$(database)/documents/tables/$(t)).data; }
    // A table session (QR scan) is open for ${hours} h, until the table's next «Paid» or until its QR key changes.
    function sessionOk(d) {
      let s = get(/databases/$(database)/documents/sessions/$(d.sid)).data;
      let tb = tbl(d.table);
      return s.table == d.table && s.phone == d.phone && s.k == tb.k
        && request.time < s.createdAt + duration.value(${hours}, 'h')
        && (!('since' in tb) || s.createdAt > tb.since);
    }
    function notBlocked(d) {
      let p = /databases/$(database)/documents/blocks/$(d.table + '_' + d.phone);
      return !exists(p) || get(p).data.until < request.time;
    }
    function claim(d) { return d.get('claimedBy', ''); }
    function sameClaim() { return claim(request.resource.data) == claim(resource.data) && request.resource.data.get('claimedName', '') == resource.data.get('claimedName', ''); }
    function claimSelf() { return request.resource.data.claimedBy == request.auth.uid && request.resource.data.claimedName == staffName(); }
    function staffKeysOnly() { return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'updatedAt', 'paid', 'paidAt', 'type', 'claimedBy', 'claimedName']); }
    // A colleague may still mark someone else's request paid (the table's «Paid») or reject it.
    function payOnly() { return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['paid', 'paidAt', 'status', 'updatedAt']) && request.resource.data.get('paid', false) == true; }
    // Any staff screen fills in the table's invoice on a bill request.
    function invoiceOnly() { return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['invoice']) && resource.data.type == 'bill' && request.resource.data.invoice is map; }
    function voidOnly() { return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['type', 'status', 'updatedAt']) && request.resource.data.type == 'void' && resource.data.get('paid', false) != true; }

    match /tables/{t} {
      allow read: if isStaff();
      allow create, delete: if isManager();
      allow update: if isManager() || (isStaff() && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['since']));
    }
    match /sessions/{id} {
      allow create: if request.resource.data.keys().hasOnly(['table', 'k', 'phone', 'createdAt'])
        && request.resource.data.table is string && request.resource.data.table.size() <= 8
        && request.resource.data.phone is string && request.resource.data.phone.matches('^[0-9a-z]{16,32}$')
        && request.resource.data.createdAt == request.time
        && exists(/databases/$(database)/documents/tables/$(request.resource.data.table))
        && request.resource.data.k == tbl(request.resource.data.table).k;
      allow delete: if isManager();
    }
    match /orders/{id} {
      allow get: if true;
      allow list: if isStaff();
      allow delete: if isManager();
      allow update: if isManager() || (isStaff() && invoiceOnly()) || (isStaff() && staffKeysOnly() && (request.resource.data.type == resource.data.type || voidOnly()) && (
        (claim(resource.data) == '' && (claimSelf() || sameClaim()))
        || (claim(resource.data) == request.auth.uid && sameClaim())
        || (sameClaim() && (payOnly() || voidOnly()))));
      allow create: if request.resource.data.keys().hasOnly(['type', 'table', 'sid', 'phone', 'items', 'total', 'status', 'createdAt', 'note'])
        && request.resource.data.type in ['order', 'waiter', 'bill']
        && request.resource.data.status == 'new'
        && request.resource.data.createdAt == request.time
        && request.resource.data.table is string && request.resource.data.table.size() <= 8
        && request.resource.data.sid is string && request.resource.data.phone is string
        && sessionOk(request.resource.data) && notBlocked(request.resource.data)
        && (request.resource.data.type != 'order'
            || (request.resource.data.items is list && request.resource.data.items.size() > 0 && request.resource.data.items.size() <= 60));
    }
    match /blocks/{id} {
      allow get: if true;
      allow write: if isStaff();
    }
    match /staff/{uid} {
      allow read: if isStaff();
      allow write: if isManager();
    }
    match /logins/{username} {
      allow get: if true;
      allow write: if isManager();
    }
  }
}`;
}
