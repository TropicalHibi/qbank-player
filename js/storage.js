// Persistence. Everything degrades gracefully: if storage is blocked/full, the app
// keeps working in memory.
//  - localStorage: progress, last-session results, recents metadata, prefs, theme
//  - IndexedDB:    full JSON copies of recently loaded sets (can be large: base64 images)

const PREFIX = 'qbp:';
let _ls;

function store() {
  if (_ls !== undefined) return _ls;
  try {
    const s = globalThis.localStorage;
    const k = PREFIX + '__test';
    s.setItem(k, '1');
    s.removeItem(k);
    _ls = s;
  } catch {
    _ls = null;
  }
  return _ls;
}

export const storageAvailable = () => !!store();

export function getJSON(key, fallback = null) {
  try {
    const s = store();
    if (!s) return fallback;
    const v = s.getItem(PREFIX + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function setJSON(key, value) {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try {
    store()?.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/* ---------- progress & last results (keyed by set storage key) ---------- */

export const loadProgress = (setKey) => getJSON(`progress:${setKey}`);
export const saveProgress = (setKey, session) => setJSON(`progress:${setKey}`, session);
export const clearProgress = (setKey) => remove(`progress:${setKey}`);

/** {at, score, total, missedIds, flaggedIds, mode} */
export const loadLastResult = (setKey) => getJSON(`last:${setKey}`);
export const saveLastResult = (setKey, r) => setJSON(`last:${setKey}`, r);

/* ---------- prefs ---------- */

export const loadPrefs = () => getJSON('prefs', {}) || {};
export const savePrefs = (p) => setJSON('prefs', p);

/* ---------- IndexedDB set copies ---------- */

const DB_NAME = 'qbank-player';
const DB_STORE = 'sets';
let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (!globalThis.indexedDB) return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function idb(mode, fn) {
  const db = await openDb();
  if (!db) return { ok: false };
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve({ ok: true, value: req ? req.result : undefined });
      tx.onerror = tx.onabort = () => resolve({ ok: false });
    } catch {
      resolve({ ok: false });
    }
  });
}

export async function putSetCopy(key, text) {
  return (await idb('readwrite', (s) => s.put({ text, savedAt: Date.now() }, key))).ok;
}
export async function getSetCopy(key) {
  const r = await idb('readonly', (s) => s.get(key));
  return r.ok && r.value && typeof r.value.text === 'string' ? r.value.text : null;
}
export async function deleteSetCopy(key) {
  return (await idb('readwrite', (s) => s.delete(key))).ok;
}

/* ---------- recents ---------- */

const MAX_RECENTS = 12;

/** [{key, title, version, count, url|null, hasCopy, openedAt}] most recent first */
export function getRecents() {
  const r = getJSON('recents', []);
  return Array.isArray(r) ? r.filter((x) => x && typeof x.key === 'string') : [];
}

export async function addRecent(entry, text) {
  const hasCopy = text ? await putSetCopy(entry.key, text) : false;
  let list = getRecents().filter((r) => r.key !== entry.key);
  list.unshift({ ...entry, hasCopy, openedAt: Date.now() });
  const dropped = list.slice(MAX_RECENTS);
  list = list.slice(0, MAX_RECENTS);
  for (const d of dropped) deleteSetCopy(d.key);
  setJSON('recents', list);
}

export function removeRecent(key) {
  setJSON('recents', getRecents().filter((r) => r.key !== key));
  deleteSetCopy(key);
}
