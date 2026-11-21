// Persistence. Everything degrades gracefully: if storage is blocked/full, the app
// keeps working in memory.
//  - localStorage: progress, last-session results, recents metadata, prefs, theme
//  - IndexedDB:    full JSON copies of recently loaded sets (can be large: base64 images)
//  - backup:       exportAll() / importAll() move all of the above as one JSON object (format in backup.js)

import { KEY_PREFIX, MAX_RECENTS, isBackupKey, makeBackup, mergeBackup, validateBackup } from './backup.js';

const PREFIX = KEY_PREFIX;
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

/* ---------- backup / restore ---------- */

/** Raw `qbp:*` keys currently in localStorage (excluding internal ones). */
function backupKeys(s) {
  const keys = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (isBackupKey(k)) keys.push(k);
    }
  } catch {
    /* ignore */
  }
  return keys;
}

function readLocal() {
  const out = {};
  const s = store();
  if (!s) return out;
  for (const k of backupKeys(s)) {
    try {
      const v = s.getItem(k);
      if (v != null) out[k] = JSON.parse(v);
    } catch {
      /* unreadable or not JSON: leave it out */
    }
  }
  return out;
}

/** Every saved set copy as [{key, text}] ([] if IndexedDB is unavailable). */
async function readSetCopies() {
  const out = [];
  const r = await idb('readonly', (st) => {
    const req = st.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (typeof c.key === 'string' && c.value && typeof c.value.text === 'string') out.push({ key: c.key, text: c.value.text });
      c.continue();
    };
    return null;
  });
  return r.ok ? out : [];
}

/** The full backup object: every `qbp:*` localStorage key (parsed) plus every IndexedDB set copy. */
export async function exportAll() {
  try {
    return makeBackup(readLocal(), await readSetCopies());
  } catch {
    return makeBackup({}, []);
  }
}

const errText = (e) => (e && e.name === 'QuotaExceededError' ? 'storage is full' : (e && e.message) || 'write failed');

/**
 * Restore a backup. mode 'replace' clears `qbp:*` keys and the set store first; 'merge' keeps
 * existing data and adds what is missing (rules in mergeBackup()). Never throws.
 * Returns { ok, restored: { keys: [...], sets: [...] }, skipped: [...], errors: [...] }.
 */
export async function importAll(backup, { mode = 'merge' } = {}) {
  const result = { ok: false, restored: { keys: [], sets: [] }, skipped: [], errors: [] };
  try {
    if (mode !== 'replace' && mode !== 'merge') {
      result.errors.push(`Unknown import mode ${JSON.stringify(mode)} (use "replace" or "merge").`);
      return result;
    }
    const { valid, errors } = validateBackup(backup);
    if (!valid) {
      result.errors.push(...errors);
      return result;
    }
    const s = store();
    if (!s) {
      result.errors.push('Browser storage is unavailable (blocked or disabled); nothing was restored.');
      return result;
    }

    let localTarget; // key -> value to write
    let setTarget; // [{key, text}] to write
    const existingSets = new Set();

    if (mode === 'replace') {
      for (const k of backupKeys(s)) {
        try {
          s.removeItem(k);
        } catch {
          /* ignore */
        }
      }
      const cleared = await idb('readwrite', (st) => st.clear());
      if (!cleared.ok && backup.sets.length) result.errors.push('Could not clear saved set copies (IndexedDB unavailable).');
      localTarget = {};
      for (const [k, v] of Object.entries(backup.localStorage)) {
        if (isBackupKey(k)) localTarget[k] = v;
        else result.skipped.push(`${k} (internal key)`);
      }
      setTarget = backup.sets;
    } else {
      const current = await exportAll();
      const merged = mergeBackup(current, backup);
      localTarget = {};
      for (const [k, v] of Object.entries(merged.localStorage)) {
        const had = Object.prototype.hasOwnProperty.call(current.localStorage, k);
        if (had && JSON.stringify(current.localStorage[k]) === JSON.stringify(v)) {
          if (Object.prototype.hasOwnProperty.call(backup.localStorage, k)) result.skipped.push(`${k} (kept existing)`);
        } else localTarget[k] = v;
      }
      for (const c of current.sets) existingSets.add(c.key);
      setTarget = merged.sets.filter((x) => !existingSets.has(x.key));
      for (const x of backup.sets) if (existingSets.has(x.key)) result.skipped.push(`set ${x.key} (already saved)`);
    }

    // Sets first, so recents can record which copies actually exist.
    const haveSets = new Set(existingSets);
    for (const { key, text } of setTarget) {
      const ok = await idb('readwrite', (st) => st.put({ text, savedAt: Date.now() }, key));
      if (ok.ok) {
        result.restored.sets.push(key);
        haveSets.add(key);
      } else result.errors.push(`set ${key}: could not be saved (IndexedDB unavailable or full).`);
    }
    const recentsKey = PREFIX + 'recents';
    if (Array.isArray(localTarget[recentsKey])) {
      localTarget[recentsKey] = localTarget[recentsKey].map((r) => (r && typeof r.key === 'string' ? { ...r, hasCopy: haveSets.has(r.key) } : r));
    }

    for (const [k, v] of Object.entries(localTarget)) {
      try {
        s.setItem(k, JSON.stringify(v));
        result.restored.keys.push(k);
      } catch (e) {
        result.errors.push(`${k}: ${errText(e)}.`);
      }
    }
    result.ok = result.errors.length === 0;
  } catch (e) {
    result.errors.push(`Restore failed: ${errText(e)}.`);
  }
  return result;
}
