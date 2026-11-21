// Run: node tests/backup.test.mjs   (no dependencies)
import assert from 'node:assert/strict';

import { validateBackup, mergeBackup, mergeRecents, makeBackup, backupFilename, isBackupKey, MAX_RECENTS } from '../js/backup.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✕ ${name}\n      ${String(e && e.message).split('\n').join('\n      ')}`);
  }
}
const section = (s) => console.log(`\n${s}`);

/* ---------- fixtures ---------- */
const good = () => ({
  app: 'qbank-player',
  backupVersion: 1,
  createdAt: '2026-01-31T12:34:56.000Z',
  localStorage: { 'qbp:prefs': { mode: 'tutor' }, 'qbp:theme': 'dark' },
  sets: [{ key: 'abc', text: '{"title":"A","version":1,"questions":[]}' }],
});
const errs = (o) => validateBackup(o).errors;
const recent = (key, openedAt, extra = {}) => ({ key, title: key, version: 1, count: 3, url: null, hasCopy: true, openedAt, ...extra });

/* ---------- format helpers ---------- */
section('Format helpers');
test('backupFilename uses qbank-player-backup-YYYY-MM-DD-HHmm.json', () => {
  assert.equal(backupFilename(new Date(2026, 0, 5, 7, 3)), 'qbank-player-backup-2026-01-05-0703.json');
});
test('isBackupKey: qbp:* only, excluding qbp:__test', () => {
  assert.ok(isBackupKey('qbp:prefs'));
  assert.ok(isBackupKey('qbp:progress:x'));
  assert.ok(!isBackupKey('qbp:__test'));
  assert.ok(!isBackupKey('other:prefs'));
});
test('makeBackup builds a valid backup and drops non-backup keys', () => {
  const b = makeBackup({ 'qbp:prefs': {}, 'qbp:__test': '1', foo: 1 }, [{ key: 'k', text: 't', savedAt: 5 }], new Date('2026-01-01T00:00:00Z'));
  assert.deepEqual(errs(b), []);
  assert.deepEqual(Object.keys(b.localStorage), ['qbp:prefs']);
  assert.deepEqual(b.sets, [{ key: 'k', text: 't' }]);
  assert.equal(b.createdAt, '2026-01-01T00:00:00.000Z');
});

/* ---------- validateBackup ---------- */
section('validateBackup()');
test('accepts a good backup', () => {
  assert.deepEqual(validateBackup(good()), { valid: true, errors: [] });
});
test('accepts an empty backup', () => {
  assert.deepEqual(errs({ app: 'qbank-player', backupVersion: 1, localStorage: {}, sets: [] }), []);
});
test('rejects non-objects', () => {
  for (const v of [null, 5, 'x', []]) assert.equal(validateBackup(v).valid, false);
});
test('rejects the wrong app', () => {
  assert.match(errs({ ...good(), app: 'other-app' }).join('\n'), /app: expected "qbank-player", got "other-app"/);
  const { app, ...noApp } = good();
  assert.match(errs(noApp).join('\n'), /app: missing/);
});
test('rejects the wrong version', () => {
  assert.match(errs({ ...good(), backupVersion: 2 }).join('\n'), /backupVersion: unsupported version 2/);
  assert.match(errs({ ...good(), backupVersion: '1' }).join('\n'), /backupVersion: unsupported version "1"/);
  const { backupVersion, ...noVer } = good();
  assert.match(errs(noVer).join('\n'), /backupVersion: missing/);
});
test('rejects malformed localStorage', () => {
  assert.match(errs({ ...good(), localStorage: [] }).join('\n'), /localStorage: must be an object/);
  assert.match(errs({ ...good(), localStorage: { prefs: {} } }).join('\n'), /localStorage: key "prefs" is not under "qbp:"/);
  const { localStorage, ...noLs } = good();
  assert.match(errs(noLs).join('\n'), /localStorage: missing/);
});
test('rejects malformed set entries, naming the index', () => {
  const b = good();
  b.sets = [{ key: 'a', text: 't' }, 'nope', { key: '', text: 't' }, { key: 'd' }, { text: 't' }, { key: 'a', text: 't' }, { key: 'g', text: 7 }];
  const e = errs(b).join('\n');
  assert.match(e, /sets\[1\]: must be an object/);
  assert.match(e, /sets\[2\]: key must be a non-empty string/);
  assert.match(e, /sets\[3\]: missing text/);
  assert.match(e, /sets\[4\]: missing key/);
  assert.match(e, /sets\[5\]: duplicate key "a"/);
  assert.match(e, /sets\[6\]: text must be a string/);
  assert.match(errs({ ...good(), sets: {} }).join('\n'), /sets: must be an array/);
});
test('rejects a non-string createdAt', () => {
  assert.match(errs({ ...good(), createdAt: 123 }).join('\n'), /createdAt: must be a string/);
});

/* ---------- mergeBackup ---------- */
section('mergeBackup()');
const wrap = (localStorage, sets = []) => ({ app: 'qbank-player', backupVersion: 1, localStorage, sets });

test('adds missing keys and sets, keeps existing ones', () => {
  const cur = wrap({ 'qbp:progress:a': { createdAt: 1 } }, [{ key: 'a', text: 'current' }]);
  const inc = wrap({ 'qbp:progress:b': { createdAt: 2 } }, [{ key: 'a', text: 'incoming' }, { key: 'b', text: 'bb' }]);
  const m = mergeBackup(cur, inc);
  assert.deepEqual(m.localStorage, { 'qbp:progress:a': { createdAt: 1 }, 'qbp:progress:b': { createdAt: 2 } });
  assert.deepEqual(m.sets, [{ key: 'a', text: 'current' }, { key: 'b', text: 'bb' }]);
  assert.deepEqual(errs(m), []);
});
test('progress conflict: the newer session wins (createdAt/finishedAt)', () => {
  const older = { createdAt: 100, finishedAt: null, tag: 'old' };
  const newer = { createdAt: 200, finishedAt: null, tag: 'new' };
  const finishedLater = { createdAt: 50, finishedAt: 300, tag: 'finished' };
  assert.equal(mergeBackup(wrap({ 'qbp:progress:x': older }), wrap({ 'qbp:progress:x': newer })).localStorage['qbp:progress:x'].tag, 'new');
  assert.equal(mergeBackup(wrap({ 'qbp:progress:x': newer }), wrap({ 'qbp:progress:x': older })).localStorage['qbp:progress:x'].tag, 'new');
  assert.equal(mergeBackup(wrap({ 'qbp:progress:x': newer }), wrap({ 'qbp:progress:x': finishedLater })).localStorage['qbp:progress:x'].tag, 'finished');
  // tie keeps current
  assert.equal(mergeBackup(wrap({ 'qbp:progress:x': { createdAt: 5, tag: 'cur' } }), wrap({ 'qbp:progress:x': { createdAt: 5, tag: 'inc' } })).localStorage['qbp:progress:x'].tag, 'cur');
});
test('last results conflict: the newer result (by at) wins', () => {
  const m = mergeBackup(wrap({ 'qbp:last:x': { at: 10, score: 1 } }), wrap({ 'qbp:last:x': { at: 20, score: 2 } }));
  assert.equal(m.localStorage['qbp:last:x'].score, 2);
  const m2 = mergeBackup(wrap({ 'qbp:last:x': { at: 30, score: 3 } }), wrap({ 'qbp:last:x': { at: 20, score: 2 } }));
  assert.equal(m2.localStorage['qbp:last:x'].score, 3);
});
test('recents merge by key, newest first', () => {
  const cur = [recent('a', 300), recent('b', 100, { title: 'B-current' })];
  const inc = [recent('b', 200, { title: 'B-incoming', hasCopy: false }), recent('c', 250)];
  const m = mergeBackup(wrap({ 'qbp:recents': cur }), wrap({ 'qbp:recents': inc })).localStorage['qbp:recents'];
  assert.deepEqual(m.map((r) => r.key), ['a', 'c', 'b']);
  assert.equal(m[2].title, 'B-incoming');
  assert.equal(m[2].hasCopy, true, 'hasCopy is kept if either side has a copy');
});
test(`recents merge is capped at MAX_RECENTS (${MAX_RECENTS})`, () => {
  const cur = Array.from({ length: 10 }, (_, i) => recent(`c${i}`, 1000 + i));
  const inc = Array.from({ length: 10 }, (_, i) => recent(`i${i}`, 2000 + i));
  const m = mergeRecents(cur, inc);
  assert.equal(m.length, MAX_RECENTS);
  assert.equal(m[0].key, 'i9');
  assert.ok(m.every((r, i) => i === 0 || r.openedAt <= m[i - 1].openedAt));
  assert.ok(!m.some((r) => r.key === 'c0'), 'oldest dropped');
});
test('recents merge ignores malformed entries', () => {
  assert.deepEqual(mergeRecents([null, { title: 'no key' }, recent('a', 1)], 'nope').map((r) => r.key), ['a']);
});
test('prefs: backup values win, other current prefs kept; theme: backup wins', () => {
  const m = mergeBackup(
    wrap({ 'qbp:prefs': { mode: 'tutor', timerSec: 90, shuffle: true }, 'qbp:theme': 'light' }),
    wrap({ 'qbp:prefs': { mode: 'exam', timerSec: 60 }, 'qbp:theme': 'dark' }),
  ).localStorage;
  assert.deepEqual(m['qbp:prefs'], { mode: 'exam', timerSec: 60, shuffle: true });
  assert.equal(m['qbp:theme'], 'dark');
});
test('unknown qbp: keys: keep existing, add missing', () => {
  const m = mergeBackup(wrap({ 'qbp:future': 'cur' }), wrap({ 'qbp:future': 'inc', 'qbp:other': 1 })).localStorage;
  assert.deepEqual(m, { 'qbp:future': 'cur', 'qbp:other': 1 });
});
test('does not mutate its inputs and ignores qbp:__test', () => {
  const cur = wrap({ 'qbp:recents': [recent('a', 1)] }, [{ key: 'a', text: 't' }]);
  const inc = wrap({ 'qbp:recents': [recent('b', 2)], 'qbp:__test': '1' }, [{ key: 'b', text: 'u' }]);
  const snap = JSON.stringify([cur, inc]);
  const m = mergeBackup(cur, inc);
  assert.equal(JSON.stringify([cur, inc]), snap);
  assert.ok(!('qbp:__test' in m.localStorage));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
