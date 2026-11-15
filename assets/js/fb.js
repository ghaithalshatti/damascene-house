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

/* ---------- staff ---------- */
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
export async function staffSignOut(cfg) { const { m, auth } = await full(cfg); await m.signOut(auth); }

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
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
export async function setStatus(cfg, id, status) {
  const { m, db } = await full(cfg);
  await m.updateDoc(m.doc(db, 'orders', id), { status, updatedAt: m.serverTimestamp() });
}
// Marks a table's orders as paid and closes its bill request.
export async function settleTable(cfg, orderIds, billId) {
  const { m, db } = await full(cfg);
  const b = m.writeBatch(db);
  orderIds.forEach((id) => b.update(m.doc(db, 'orders', id), { paid: true, status: 'done', updatedAt: m.serverTimestamp() }));
  if (billId) b.update(m.doc(db, 'orders', billId), { status: 'done', updatedAt: m.serverTimestamp() });
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
    if (!k) { k = randomKey(); await m.setDoc(ref, { k }); }
    out[i] = k;
  }
  return out;
}
const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8);

// Firestore security rules for one restaurant (pasted once in the Firebase console).
export function rulesFor(staffEmail) {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isStaff() {
      return request.auth != null && request.auth.token.email == '${(staffEmail || 'staff@example.com').toLowerCase()}';
    }
    function tableKey(t) {
      return get(/databases/$(database)/documents/tables/$(t)).data.k;
    }
    match /tables/{t} {
      allow read, write: if isStaff();
    }
    match /orders/{id} {
      allow get: if true;
      allow list, update, delete: if isStaff();
      allow create: if request.resource.data.keys().hasOnly(['type', 'table', 'k', 'items', 'total', 'status', 'createdAt', 'note'])
        && request.resource.data.type in ['order', 'waiter', 'bill']
        && request.resource.data.status == 'new'
        && request.resource.data.createdAt == request.time
        && request.resource.data.table is string && request.resource.data.table.size() <= 8
        && exists(/databases/$(database)/documents/tables/$(request.resource.data.table))
        && request.resource.data.k == tableKey(request.resource.data.table)
        && (request.resource.data.type != 'order'
            || (request.resource.data.items is list && request.resource.data.items.size() > 0 && request.resource.data.items.size() <= 60));
    }
  }
}`;
}
