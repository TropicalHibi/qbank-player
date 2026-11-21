// Backup format (DOM-free; unit-tested under Node). Storage I/O lives in storage.js.
//
//   {
//     "app": "qbank-player",
//     "backupVersion": 1,
//     "createdAt": "2026-01-31T12:34:56.000Z",
//     "localStorage": { "qbp:prefs": {…}, "qbp:theme": "dark", "qbp:progress:<setKey>": {…}, … },
//     "sets": [{ "key": "<setKey>", "text": "<full set JSON text>" }]
//   }
//
// localStorage keys keep their `qbp:` prefix and values are parsed JSON. Anything under
// `qbp:` is included automatically, except the internal availability probe `qbp:__test`.

import { fileTimestamp } from './util.js';

export const BACKUP_APP = 'qbank-player';
export const BACKUP_VERSION = 1;
export const KEY_PREFIX = 'qbp:';
export const INTERNAL_KEYS = new Set([KEY_PREFIX + '__test']);
export const MAX_RECENTS = 12;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Should this raw localStorage key be part of a backup? */
export const isBackupKey = (k) => typeof k === 'string' && k.startsWith(KEY_PREFIX) && !INTERNAL_KEYS.has(k);

/** `qbank-player-backup-YYYY-MM-DD-HHmm.json` (local time). */
export const backupFilename = (d = new Date()) => `qbank-player-backup-${fileTimestamp(d)}.json`;

/** Assemble a backup object from already-read storage contents. */
export function makeBackup(localStorage = {}, sets = [], now = new Date()) {
  const ls = {};
  for (const [k, v] of Object.entries(localStorage || {})) if (isBackupKey(k)) ls[k] = v;
  return {
    app: BACKUP_APP,
    backupVersion: BACKUP_VERSION,
    createdAt: now.toISOString(),
    localStorage: ls,
    sets: (sets || []).map(({ key, text }) => ({ key, text })),
  };
}

/**
 * Check a parsed backup file. Returns { valid, errors } where each error names the problem,
 * e.g. `sets[3]: missing text.`
 */
export function validateBackup(obj) {
  const errors = [];
  if (!isObj(obj)) return { valid: false, errors: ['Backup must be a JSON object.'] };

  if (obj.app !== BACKUP_APP) {
    errors.push(own(obj, 'app') ? `app: expected "${BACKUP_APP}", got ${JSON.stringify(obj.app)}.` : `app: missing (expected "${BACKUP_APP}").`);
  }
  if (obj.backupVersion !== BACKUP_VERSION) {
    errors.push(
      own(obj, 'backupVersion')
        ? `backupVersion: unsupported version ${JSON.stringify(obj.backupVersion)} (expected ${BACKUP_VERSION}).`
        : `backupVersion: missing (expected ${BACKUP_VERSION}).`,
    );
  }
  if (own(obj, 'createdAt') && typeof obj.createdAt !== 'string') errors.push('createdAt: must be a string (ISO date).');

  if (!own(obj, 'localStorage')) errors.push('localStorage: missing.');
  else if (!isObj(obj.localStorage)) errors.push('localStorage: must be an object of key → value.');
  else {
    for (const k of Object.keys(obj.localStorage)) {
      if (!k.startsWith(KEY_PREFIX)) errors.push(`localStorage: key ${JSON.stringify(k)} is not under "${KEY_PREFIX}".`);
    }
  }

  if (!own(obj, 'sets')) errors.push('sets: missing.');
  else if (!Array.isArray(obj.sets)) errors.push('sets: must be an array.');
  else {
    const seen = new Set();
    obj.sets.forEach((s, i) => {
      const at = `sets[${i}]`;
      if (!isObj(s)) return errors.push(`${at}: must be an object with key and text.`);
      if (!own(s, 'key')) errors.push(`${at}: missing key.`);
      else if (typeof s.key !== 'string' || !s.key) errors.push(`${at}: key must be a non-empty string.`);
      else if (seen.has(s.key)) errors.push(`${at}: duplicate key ${JSON.stringify(s.key)}.`);
      else seen.add(s.key);
      if (!own(s, 'text')) errors.push(`${at}: missing text.`);
      else if (typeof s.text !== 'string') errors.push(`${at}: text must be a string.`);
    });
  }
  return { valid: errors.length === 0, errors };
}

/* ---------- merge ---------- */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Latest activity time of a saved session: finishedAt if finished, else createdAt. */
const progressTime = (p) => (isObj(p) ? Math.max(num(p.createdAt), num(p.finishedAt)) : 0);
const lastTime = (r) => (isObj(r) ? num(r.at) : 0);

/** Merge two recents lists by key: newest openedAt wins, newest first, capped at MAX_RECENTS. */
export function mergeRecents(current, incoming) {
  const byKey = new Map();
  for (const r of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!isObj(r) || typeof r.key !== 'string') continue;
    const prev = byKey.get(r.key);
    if (!prev) byKey.set(r.key, r);
    else {
      const winner = num(r.openedAt) > num(prev.openedAt) ? r : prev;
      byKey.set(r.key, { ...winner, hasCopy: !!(prev.hasCopy || r.hasCopy) });
    }
  }
  return [...byKey.values()].sort((a, b) => num(b.openedAt) - num(a.openedAt)).slice(0, MAX_RECENTS);
}

/**
 * Pure merge of two backup-shaped objects ({ localStorage, sets }). Keeps existing data and
 * adds what is missing. On a conflict:
 *  - `qbp:progress:*`: the newer session (by createdAt/finishedAt) wins; ties keep current.
 *  - `qbp:last:*`:     the newer result (by `at`) wins; ties keep current.
 *  - `qbp:recents`:    merged by key, newest first, capped at MAX_RECENTS.
 *  - `qbp:prefs`:      shallow merge, backup values win. `qbp:theme`: backup wins.
 *  - any other key:    current wins.
 *  - sets:             current copy kept; missing ones added.
 * Returns a new backup object (current is not modified).
 */
export function mergeBackup(current, incoming) {
  const cur = isObj(current?.localStorage) ? current.localStorage : {};
  const inc = isObj(incoming?.localStorage) ? incoming.localStorage : {};
  const ls = { ...cur };
  for (const [k, v] of Object.entries(inc)) {
    if (!isBackupKey(k)) continue;
    if (!own(cur, k)) {
      ls[k] = v;
      continue;
    }
    const c = cur[k];
    if (k.startsWith(KEY_PREFIX + 'progress:')) ls[k] = progressTime(v) > progressTime(c) ? v : c;
    else if (k.startsWith(KEY_PREFIX + 'last:')) ls[k] = lastTime(v) > lastTime(c) ? v : c;
    else if (k === KEY_PREFIX + 'recents') ls[k] = mergeRecents(c, v);
    else if (k === KEY_PREFIX + 'prefs') ls[k] = isObj(c) && isObj(v) ? { ...c, ...v } : v;
    else if (k === KEY_PREFIX + 'theme') ls[k] = v;
    // else: unknown key, keep current
  }

  const sets = (Array.isArray(current?.sets) ? current.sets : []).map(({ key, text }) => ({ key, text }));
  const have = new Set(sets.map((s) => s.key));
  for (const s of Array.isArray(incoming?.sets) ? incoming.sets : []) {
    if (s && typeof s.key === 'string' && typeof s.text === 'string' && !have.has(s.key)) {
      sets.push({ key: s.key, text: s.text });
      have.add(s.key);
    }
  }

  return {
    app: BACKUP_APP,
    backupVersion: BACKUP_VERSION,
    createdAt: incoming?.createdAt ?? current?.createdAt ?? new Date().toISOString(),
    localStorage: ls,
    sets,
  };
}
