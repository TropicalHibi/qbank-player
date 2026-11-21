// Run: node tests/validate.test.mjs   (no dependencies)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSet } from '../js/validate.js';
import { extractJsonText, repairJson, parseJsonText, loadSetFromText } from '../js/loader.js';
import { shuffle, mulberry32, slug, hashString, renderMarkdownLite, isSafeImageUrl, fileTimestamp, stripMarkdown, mergeRanges, addRange, removeRangeAt, rangeSegments } from '../js/util.js';
import { buildSession, scoreSession, buildExport, resultsFilename, buildClaudeSummary, setKey, poolIds, collectTags, isSessionValid, normalizeSession, answeredCount, toggleStrike, clearStrike, isStruck, itemHighlights, UNTAGGED } from '../js/session.js';
import { SCHEMA, fillPrompt, EXAMPLE_QUESTION, PROMPT_TEMPLATE } from '../js/prompt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const mkQ = (id, extra = {}) => ({
  id,
  stem: `Stem for ${id}`,
  options: [
    { text: 'Alpha', explanation: 'a' },
    { text: 'Bravo', explanation: 'b' },
    { text: 'Charlie', explanation: 'c' },
    { text: 'Delta', explanation: 'd' },
  ],
  answer: 2,
  tags: ['cardio', 'pharm'],
  ...extra,
});
const mkSet = (qs) => ({ title: 'Test Set', version: 1, questions: qs });
const errorsOf = (data) => validateSet(data).errors;

/* ---------- bundled sets ---------- */
section('Bundled sets (/sets)');
const setsDir = path.join(root, 'sets');
const manifest = JSON.parse(fs.readFileSync(path.join(setsDir, 'index.json'), 'utf8'));
test('sets/index.json is an array of {file,title,count}', () => {
  assert.ok(Array.isArray(manifest) && manifest.length > 0);
  for (const m of manifest) {
    assert.equal(typeof m.file, 'string');
    assert.equal(typeof m.title, 'string');
    assert.ok(Number.isInteger(m.count));
  }
});
for (const file of fs.readdirSync(setsDir).filter((f) => f.endsWith('.json') && f !== 'index.json')) {
  test(`sets/${file} is valid and listed correctly in index.json`, () => {
    const r = loadSetFromText(fs.readFileSync(path.join(setsDir, file), 'utf8'));
    assert.deepEqual(r.errors, []);
    assert.ok(r.ok);
    const entry = manifest.find((m) => m.file === file);
    assert.ok(entry, `${file} missing from sets/index.json`);
    assert.equal(entry.title, r.set.title, 'manifest title mismatch');
    assert.equal(entry.count, r.set.questions.length, 'manifest count mismatch');
  });
}
test('every manifest entry points to an existing file', () => {
  for (const m of manifest) assert.ok(fs.existsSync(path.join(setsDir, m.file)), `${m.file} not found`);
});

/* ---------- schema duplication ---------- */
section('Schema');
test('js/prompt.js SCHEMA deep-equals /schema.json', () => {
  assert.deepEqual(SCHEMA, JSON.parse(fs.readFileSync(path.join(root, 'schema.json'), 'utf8')));
});
test('EXAMPLE_QUESTION validates inside a set', () => {
  assert.deepEqual(errorsOf(mkSet([EXAMPLE_QUESTION])), []);
});

/* ---------- validator ---------- */
section('Validator messages');
test('valid set passes with no warnings', () => {
  const r = validateSet(mkSet([mkQ('q1'), mkQ('q2')]));
  assert.ok(r.valid);
  assert.deepEqual(r.warnings, []);
});
test('answer out of range names id and option count', () => {
  assert.deepEqual(errorsOf(mkSet([mkQ('q7', { answer: 5 })])), ['q7: answer index 5 out of range (4 options).']);
});
test('letter answer gets a helpful hint', () => {
  assert.match(errorsOf(mkSet([mkQ('q1', { answer: 'C' })]))[0], /q1: "answer" must be an integer index .*use 2 instead of "C"/);
});
test('duplicate id reported', () => {
  assert.deepEqual(errorsOf(mkSet([mkQ('q1'), mkQ('q1')])), ['q1: duplicate id (also used by question 1).']);
});
test('missing id falls back to position label', () => {
  const q = mkQ('x');
  delete q.id;
  assert.deepEqual(errorsOf(mkSet([mkQ('q1'), q])), ['question 2: missing "id".']);
});
test('too few / too many options', () => {
  const few = mkQ('q1', { options: [{ text: 'a', explanation: 'a' }], answer: 0 });
  assert.match(errorsOf(mkSet([few]))[0], /^q1: "options" must have 2–8 items \(has 1\)/);
  const many = mkQ('q2', { options: Array.from({ length: 9 }, (_, i) => ({ text: `o${i}`, explanation: 'x' })), answer: 0 });
  assert.match(errorsOf(mkSet([many]))[0], /^q2: "options" must have 2–8 items \(has 9\)/);
});
test('option missing explanation / string option', () => {
  const q = mkQ('q3');
  q.options[1] = { text: 'Bravo' };
  q.options[3] = 'Delta';
  assert.deepEqual(errorsOf(mkSet([q])), [
    'q3: option B missing "explanation".',
    'q3: option D must be an object {"text", "explanation"}, not a plain string.',
  ]);
});
test('top-level problems', () => {
  assert.deepEqual(errorsOf({ version: 1, questions: [mkQ('q1')] }), ['Set: missing "title".']);
  assert.match(errorsOf({ title: 'x', version: 2, questions: [mkQ('q1')] })[0], /unsupported "version" 2/);
  assert.match(errorsOf({ title: 'x', version: 1, questions: [] })[0], /at least 1 question/);
  assert.match(errorsOf([mkQ('q1')])[0], /got an array/);
});
test('unsafe image scheme rejected; safe ones accepted', () => {
  assert.deepEqual(errorsOf(mkSet([mkQ('q1', { image: 'javascript:alert(1)' })])), [
    'q1: "image" must be an http(s) URL, a relative path, or a data:image/ URI.',
  ]);
  for (const ok of ['https://x.org/a.png', 'img/a.png', '../a.png', 'data:image/png;base64,AAAA']) {
    assert.deepEqual(errorsOf(mkSet([mkQ('q1', { image: ok })])), [], ok);
  }
});
test('unknown fields are warnings, not errors', () => {
  const r = validateSet({ ...mkSet([mkQ('q1', { difficulty: 'hard' })]), author: 'me' });
  assert.ok(r.valid);
  assert.deepEqual(r.warnings, ['Set: unknown field "author" (ignored).', 'q1: unknown field "difficulty" (ignored).']);
});
test('bad tags type', () => {
  assert.deepEqual(errorsOf(mkSet([mkQ('q1', { tags: 'cardio' })])), ['q1: "tags" must be an array of strings (got a string ("cardio")).']);
});

/* ---------- loader ---------- */
section('Loader: fences, prose, repairs, parse errors');
const json = JSON.stringify(mkSet([mkQ('q1')]));
test('strips ```json fences', () => {
  const r = loadSetFromText('```json\n' + json + '\n```');
  assert.ok(r.ok);
  assert.equal(r.warnings.length, 0);
});
test('strips leading/trailing prose around fenced block', () => {
  const r = loadSetFromText('Here is your set:\n\n```json\n' + json + '\n```\n\nLet me know if you want more!');
  assert.ok(r.ok, r.errors.join('; '));
});
test('strips prose without fences', () => {
  const r = loadSetFromText('Sure! ' + json + ' Hope this helps.');
  assert.ok(r.ok, r.errors.join('; '));
  assert.ok(r.notes.some((n) => /before\/after/.test(n)));
});
test('handles BOM and unterminated fence', () => {
  assert.ok(loadSetFromText('﻿' + json).ok);
  assert.ok(loadSetFromText('```json\n' + json).ok);
});
test('extractJsonText prefers the json block among several', () => {
  const t = '```bash\necho hi\n```\n```json\n{"a":1}\n```';
  assert.equal(extractJsonText(t).text, '{"a":1}');
});
test('trailing commas are auto-repaired with a warning', () => {
  const r = parseJsonText('{"a": [1, 2, 3,], "b": {"c": 1,\n},}');
  assert.deepEqual(r.data, { a: [1, 2, 3], b: { c: 1 } });
  assert.deepEqual(r.warnings, ['Auto-repaired 3 trailing commas before } or ].']);
});
test('commas inside strings are untouched', () => {
  const { text, trailingCommas } = repairJson('{"a": "x,]", "b": "y, }",}');
  assert.equal(trailingCommas, 1);
  assert.deepEqual(JSON.parse(text), { a: 'x,]', b: 'y, }' });
});
test('smart quotes used as JSON quotes are repaired', () => {
  const r = parseJsonText('{“a”: “hello”}');
  assert.deepEqual(r.data, { a: 'hello' });
  assert.equal(r.warnings.length, 1);
});
test('valid JSON is unchanged by repairJson', () => {
  const s = JSON.stringify({ x: 'a,]}', y: [1, { z: '“q”' }] });
  assert.equal(repairJson(s).text, s);
});
test('parse error reports line and column', () => {
  const r = parseJsonText('{\n  "title": "x",\n  "version": 1\n  "questions": []\n}');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^Invalid JSON at line 4, column 3/);
  assert.ok(r.snippet.includes('"questions"'));
});
test('truncated JSON is explained', () => {
  const r = parseJsonText('{"title": "x", "questions": [{"id": "q1"');
  assert.match(r.errors[0], /cut off/);
});
test('empty input', () => {
  assert.match(parseJsonText('   ').errors[0], /empty/);
});

/* ---------- util ---------- */
section('Util');
test('seeded shuffle is deterministic and a permutation', () => {
  const a = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(shuffle(a, 42), shuffle(a, 42));
  assert.notDeepEqual(shuffle(a, 42), shuffle(a, 43));
  assert.deepEqual([...shuffle(a, 7)].sort((x, y) => x - y), a);
  assert.deepEqual(a, Array.from({ length: 20 }, (_, i) => i), 'input not mutated');
});
test('mulberry32 range', () => {
  const r = mulberry32(1);
  for (let i = 0; i < 1000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1);
  }
});
test('slug', () => {
  assert.equal(slug('Cardio: Pharm — Ünit 3!'), 'cardio-pharm-unit-3');
  assert.equal(slug('***'), 'set');
});
test('hashString stable', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.equal(hashString('abc').length, 8);
  assert.notEqual(hashString('abc'), hashString('abd'));
});
test('markdown-lite escapes HTML before formatting', () => {
  const html = renderMarkdownLite('<img src=x onerror=alert(1)> **bold** and *it* & `<b>`');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>it</em>'));
  assert.ok(html.includes('<code>&lt;b&gt;</code>'));
  assert.ok(html.includes('&amp;'));
});
test('markdown-lite line breaks, paragraphs, tables', () => {
  assert.equal(renderMarkdownLite('a\nb\n\nc'), '<p>a<br>b</p><p>c</p>');
  const t = renderMarkdownLite('Labs:\n| Test | Value |\n|---|---:|\n| Na | 140 |\n| K | **6.1** |\nDone');
  assert.ok(t.startsWith('<p>Labs:</p><div class="table-wrap"><table>'));
  assert.ok(t.includes('<th>Test</th><th style="text-align:right">Value</th>'));
  assert.ok(t.includes('<td>K</td><td style="text-align:right"><strong>6.1</strong></td>'));
  assert.ok(t.endsWith('<p>Done</p>'));
});
test('markdown-lite does not italicize arithmetic', () => {
  assert.equal(renderMarkdownLite('2 * 3 * 4'), '<p>2 * 3 * 4</p>');
});
test('isSafeImageUrl allowlist', () => {
  for (const ok of ['http://a/b.png', 'HTTPS://A/B.PNG', 'data:image/svg+xml,%3Csvg%3E', 'a/b.png', './b.png', '//cdn/x.png']) {
    assert.ok(isSafeImageUrl(ok), ok);
  }
  for (const bad of ['javascript:alert(1)', 'java\tscript:alert(1)', ' JAVASCRIPT:x', 'data:text/html,<b>', 'vbscript:x', 'file:///etc/passwd', '', null]) {
    assert.ok(!isSafeImageUrl(bad), String(bad));
  }
});
test('fileTimestamp format', () => {
  assert.equal(fileTimestamp(new Date(2026, 0, 5, 9, 7)), '2026-01-05-0907');
});
test('stripMarkdown', () => {
  assert.equal(stripMarkdown('**A** *b*\n| x | y |\n|---|---|'), 'A b x y');
});

/* ---------- highlight ranges ---------- */
section('Highlight ranges');
test('mergeRanges sorts, merges overlapping/touching ranges, drops junk', () => {
  assert.deepEqual(mergeRanges([{ start: 10, end: 15 }, { start: 0, end: 4 }, { start: 3, end: 6 }]), [{ start: 0, end: 6 }, { start: 10, end: 15 }]);
  assert.deepEqual(mergeRanges([{ start: 0, end: 5 }, { start: 5, end: 8 }]), [{ start: 0, end: 8 }]);
  assert.deepEqual(mergeRanges([{ start: 2, end: 9 }, { start: 3, end: 4 }]), [{ start: 2, end: 9 }]);
  assert.deepEqual(mergeRanges([{ start: 4, end: 4 }, { start: -1, end: 3 }, { start: 1.5, end: 3 }, null, 'x', { start: 1 }]), []);
  assert.deepEqual(mergeRanges(undefined), []);
  const input = [{ start: 3, end: 6 }, { start: 0, end: 4 }];
  mergeRanges(input);
  assert.deepEqual(input, [{ start: 3, end: 6 }, { start: 0, end: 4 }], 'input not mutated');
});
test('addRange / removeRangeAt', () => {
  let r = addRange([], { start: 5, end: 10 });
  r = addRange(r, { start: 8, end: 12 });
  r = addRange(r, { start: 20, end: 25 });
  assert.deepEqual(r, [{ start: 5, end: 12 }, { start: 20, end: 25 }]);
  assert.deepEqual(removeRangeAt(r, 5), [{ start: 20, end: 25 }]);
  assert.deepEqual(removeRangeAt(r, 11), [{ start: 20, end: 25 }]);
  assert.deepEqual(removeRangeAt(r, 12), r, 'end is exclusive');
  assert.deepEqual(removeRangeAt(r, 15), r);
});
test('rangeSegments maps offsets onto text nodes', () => {
  // "The **quick** brown" -> text nodes "The ", "quick", " brown"
  const lengths = [4, 5, 6];
  assert.deepEqual(rangeSegments(lengths, [{ start: 2, end: 11 }]), [
    { node: 0, start: 2, end: 4, range: 0 },
    { node: 1, start: 0, end: 5, range: 0 },
    { node: 2, start: 0, end: 2, range: 0 },
  ]);
  // Two ranges inside one node, one range ending exactly at a node boundary.
  assert.deepEqual(rangeSegments([10, 5], [{ start: 6, end: 10 }, { start: 1, end: 3 }]), [
    { node: 0, start: 1, end: 3, range: 0 },
    { node: 0, start: 6, end: 10, range: 1 },
  ]);
  // Overlapping input is merged first; empty text nodes and out-of-range offsets are skipped.
  assert.deepEqual(rangeSegments([3, 0, 3], [{ start: 1, end: 4 }, { start: 2, end: 5 }, { start: 50, end: 60 }]), [
    { node: 0, start: 1, end: 3, range: 0 },
    { node: 2, start: 0, end: 2, range: 0 },
  ]);
  assert.deepEqual(rangeSegments([5], []), []);
});
test('table cells: a range across cells yields one piece per cell', () => {
  // | Na | 140 | -> "Na", "140" (no text between cells)
  assert.deepEqual(rangeSegments([2, 3], [{ start: 1, end: 4 }]), [
    { node: 0, start: 1, end: 2, range: 0 },
    { node: 1, start: 0, end: 2, range: 0 },
  ]);
});

/* ---------- session ---------- */
section('Session: shuffling, answer remap, scoring, export');
const set = mkSet([
  mkQ('q1', { answer: 0 }),
  mkQ('q2', { answer: 1, tags: ['renal'] }),
  mkQ('q3', { answer: 2 }),
  mkQ('q4', { answer: 3, tags: [] }),
  mkQ('q5', { answer: 1, tags: ['renal', 'pharm'] }),
]);
test('option shuffle remaps correct answer (display ↔ original)', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const s = buildSession(set, { seed, shuffleOptions: true, shuffleQuestions: true });
    for (const it of s.items) {
      const q = set.questions.find((x) => x.id === it.id);
      assert.deepEqual([...it.order].sort(), [0, 1, 2, 3]);
      const displayedCorrect = it.order.indexOf(q.answer);
      // The text shown at the displayed-correct position is the original correct option.
      assert.equal(q.options[it.order[displayedCorrect]].text, q.options[q.answer].text);
    }
  }
});
test('options actually get shuffled for some seed, and not when disabled', () => {
  const moved = [1, 2, 3, 4, 5].some((seed) => buildSession(set, { seed }).items.some((it) => it.order.join() !== '0,1,2,3'));
  assert.ok(moved);
  const fixed = buildSession(set, { seed: 1, shuffleOptions: false, shuffleQuestions: false });
  assert.deepEqual(fixed.items.map((i) => i.id), ['q1', 'q2', 'q3', 'q4', 'q5']);
  assert.ok(fixed.items.every((it) => it.order.join() === '0,1,2,3'));
});
test('same seed reproduces the session', () => {
  const a = buildSession(set, { seed: 99 });
  const b = buildSession(set, { seed: 99 });
  assert.deepEqual(a.items, b.items);
});
test('subset count and id pool', () => {
  assert.equal(buildSession(set, { count: 2 }).items.length, 2);
  const s = buildSession(set, { ids: ['q2', 'q4'], shuffleQuestions: false });
  assert.deepEqual(s.items.map((i) => i.id), ['q2', 'q4']);
});
test('tag filtering and untagged chip', () => {
  assert.deepEqual(poolIds(set, { tags: ['renal'] }), ['q2', 'q5']);
  assert.deepEqual(poolIds(set, { tags: [UNTAGGED] }), ['q4']);
  assert.deepEqual(poolIds(set, { tags: ['pharm'], restrictIds: ['q1', 'q2'] }), ['q1']);
  assert.deepEqual(collectTags(set).map((t) => `${t.tag}:${t.count}`), ['cardio:2', 'pharm:3', 'renal:2', `${UNTAGGED}:1`]);
});
test('scoring uses original indexes regardless of display order', () => {
  const s = buildSession(set, { seed: 5, shuffleQuestions: false });
  const byId = Object.fromEntries(set.questions.map((q) => [q.id, q]));
  // answer q1,q2 correctly; q3 wrong; q4 unanswered; q5 correct
  s.items[0].chosen = byId.q1.answer;
  s.items[1].chosen = byId.q2.answer;
  s.items[2].chosen = (byId.q3.answer + 1) % 4;
  s.items[4].chosen = byId.q5.answer;
  s.items[4].flagged = true;
  s.elapsedMs = 50000;
  const r = scoreSession(set, s);
  assert.equal(r.score, 3);
  assert.equal(r.total, 5);
  assert.deepEqual(r.missedIds, ['q3', 'q4']);
  assert.deepEqual(r.flaggedIds, ['q5']);
  assert.equal(r.avgMs, 10000);
  assert.equal(r.byTag[0].tag, UNTAGGED); // 0/1, worst first
  const exp = buildExport(set, s, new Date('2026-03-04T05:06:07Z'));
  assert.deepEqual(Object.keys(exp), ['setTitle', 'setVersion', 'mode', 'timestamp', 'score', 'total', 'responses']);
  assert.equal(exp.timestamp, '2026-03-04T05:06:07.000Z');
  assert.deepEqual(Object.keys(exp.responses[0]), ['id', 'chosen', 'correct', 'timeMs', 'flagged', 'confidence', 'tags']);
  assert.equal(exp.responses[3].chosen, null);
  assert.equal(exp.responses[3].correct, false);
  const sum = buildClaudeSummary(set, s);
  assert.match(sum, /Score: 3\/5 \(60%\)/);
  assert.match(sum, /Missed questions \(2\):/);
  assert.match(sum, /Chose: \(unanswered\) \| Correct: Delta/);
});
test('resultsFilename', () => {
  assert.equal(resultsFilename('My Set: Renal!', new Date(2026, 10, 20, 14, 3)), 'my-set-renal-results-2026-11-20-1403.json');
});
test('setKey and session validity', () => {
  assert.match(setKey(set), /^Test Set::v1::[0-9a-f]{8}$/);
  const s = buildSession(set, {});
  assert.ok(isSessionValid(set, s));
  assert.ok(!isSessionValid(mkSet([mkQ('q1')]), s));
  const bad = JSON.parse(JSON.stringify(s));
  bad.items[0].order = [0, 0, 1, 2];
  assert.ok(!isSessionValid(set, bad));
});
test('highlights: new items start empty, survive save/load, old sessions default to []', () => {
  const s = buildSession(set, { seed: 3 });
  assert.ok(s.items.every((it) => Array.isArray(it.highlights) && it.highlights.length === 0));
  s.items[0].highlights = addRange(s.items[0].highlights, { start: 2, end: 9 });
  const loaded = JSON.parse(JSON.stringify(s));
  assert.ok(isSessionValid(set, loaded));
  assert.deepEqual(itemHighlights(loaded.items[0]), [{ start: 2, end: 9 }]);
  delete loaded.items[1].highlights; // saved by an older version
  loaded.items[2].highlights = 'garbage';
  assert.ok(isSessionValid(set, loaded));
  assert.deepEqual(itemHighlights(loaded.items[1]), []);
  assert.deepEqual(itemHighlights(loaded.items[2]), []);  normalizeSession(set, loaded);
  assert.deepEqual(loaded.items[0].highlights, [{ start: 2, end: 9 }]);
  assert.deepEqual(loaded.items[1].highlights, []);
  assert.deepEqual(loaded.items[2].highlights, []);
});

test('strikes store original indexes and map correctly under shuffled options', () => {
  let checked = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const s = buildSession(set, { seed, shuffleOptions: true });
    for (const it of s.items) {
      assert.deepEqual(it.struck, []);
      const q = set.questions.find((x) => x.id === it.id);
      // Strike the option displayed at position C (display index 2).
      const shownText = q.options[it.order[2]].text;
      assert.equal(toggleStrike(it, it.order[2]), true);
      assert.deepEqual(it.struck, [it.order[2]]);
      // Mapping back from the stored original index finds the same option at the same display slot.
      assert.equal(it.order.indexOf(it.struck[0]), 2);
      assert.equal(q.options[it.struck[0]].text, shownText);
      // Survives JSON save/load, and a different display order still points at the same option.
      const loaded = JSON.parse(JSON.stringify(it));
      assert.ok(isStruck(loaded, it.order[2]));
      const reordered = { ...loaded, order: [...loaded.order].reverse() };
      assert.equal(q.options[reordered.struck[0]].text, shownText);
      assert.equal(reordered.order.indexOf(reordered.struck[0]), reordered.order.length - 3);
      if (it.order[2] !== 2) checked++;
      // Toggle off; clearStrike is a no-op when not struck.
      assert.equal(toggleStrike(it, it.order[2]), false);
      assert.deepEqual(it.struck, []);
      assert.equal(clearStrike(it, 0), false);
    }
  }
  assert.ok(checked > 0, 'some seeds actually moved the struck option');
});
test('strikes keep a sorted unique list; clearStrike removes one', () => {
  const it = { order: [3, 1, 0, 2], struck: [] };
  toggleStrike(it, 2);
  toggleStrike(it, 0);
  toggleStrike(it, 3);
  assert.deepEqual(it.struck, [0, 2, 3]);
  assert.equal(clearStrike(it, 2), true);
  assert.deepEqual(it.struck, [0, 3]);
});
test('strikes do not affect scoring or export', () => {
  const s = buildSession(set, { seed: 3, shuffleQuestions: false });
  s.items.forEach((it) => (it.chosen = set.questions.find((q) => q.id === it.id).answer));
  const before = buildExport(set, s, new Date(0));
  s.items.forEach((it) => toggleStrike(it, (it.chosen + 1) % 4));
  assert.deepEqual(buildExport(set, s, new Date(0)), before);
});
test('older saved sessions without struck load as [] and bad values are dropped', () => {
  const s = JSON.parse(JSON.stringify(buildSession(set, {})));
  delete s.items[0].struck;
  s.items[1].struck = 'nope';
  s.items[2].struck = [2, 2, 9, -1, 1.5, '0', 0];
  assert.ok(isSessionValid(set, s), 'old sessions stay valid');
  normalizeSession(set, s);
  assert.deepEqual(s.items[0].struck, []);
  assert.deepEqual(s.items[1].struck, []);
  assert.deepEqual(s.items[2].struck, [0, 2]);
});
test('pending (unsubmitted) choice is not an answer and survives save/load', () => {
  const s = buildSession(set, { seed: 7, shuffleQuestions: false });
  assert.ok(s.items.every((it) => it.pending === null));
  const q1 = set.questions[0];
  s.items[0].pending = q1.answer; // picked the right option but did not submit
  assert.equal(answeredCount(s), 0);
  const r = scoreSession(set, s);
  assert.equal(r.score, 0);
  assert.equal(r.responses[0].chosen, null);
  assert.ok(r.missedIds.includes('q1'), 'pending counts as missed');
  assert.equal(buildExport(set, s).responses[0].chosen, null);
  const loaded = JSON.parse(JSON.stringify(s));
  assert.ok(isSessionValid(set, loaded));
  normalizeSession(set, loaded);
  assert.equal(loaded.items[0].pending, q1.answer);
  assert.equal(answeredCount(loaded), 0);
});
test('older saved sessions without pending load with pending = null', () => {
  const old = JSON.parse(JSON.stringify(buildSession(set, { seed: 3 })));
  for (const it of old.items) delete it.pending;
  old.items[1].chosen = 2;
  old.items[2].pending = 99; // corrupt value
  old.items[1].pending = 0; // stale: already answered
  assert.ok(isSessionValid(set, old));
  normalizeSession(set, old);
  assert.ok(old.items.every((it) => it.pending === null));
  assert.equal(old.items[1].chosen, 2);
});

/* ---------- confidence ---------- */
// Imported here (ESM imports are hoisted) to keep this section self-contained.
import { setConfidence, canSetConfidence, normalizeConfidence, CONFIDENCE_LEVELS } from '../js/session.js';
section('Session: confidence');
const confSet = mkSet([mkQ('c1', { answer: 0 }), mkQ('c2', { answer: 0 }), mkQ('c3', { answer: 0 }), mkQ('c4', { answer: 0 }), mkQ('c5', { answer: 0 })]);
const confSession = (mode = 'exam') => buildSession(confSet, { mode, seed: 1, shuffleQuestions: false, shuffleOptions: false });
test('new items start with confidence null', () => {
  assert.deepEqual(CONFIDENCE_LEVELS, ['low', 'medium', 'high']);
  assert.ok(confSession().items.every((it) => it.confidence === null));
});
test('normalizeSession: missing or bad confidence becomes null, valid values kept', () => {
  const s = JSON.parse(JSON.stringify(confSession()));
  delete s.items[0].confidence; // saved by an older version
  s.items[1].confidence = 'HIGH';
  s.items[2].confidence = 3;
  s.items[3].confidence = 'medium';
  s.items[4].confidence = 'low';
  assert.ok(isSessionValid(confSet, s));
  normalizeSession(confSet, s);
  assert.deepEqual(s.items.map((it) => it.confidence), [null, null, null, 'medium', 'low']);
  assert.equal(normalizeConfidence(undefined), null);
});
test('setConfidence: tutor locks on submit, exam locks on finish, bad values refused', () => {
  const t = confSession('tutor');
  assert.equal(setConfidence(t, 0, 'high'), true);
  assert.equal(setConfidence(t, 0, 'low'), true);
  assert.equal(setConfidence(t, 0, 'sure'), false);
  assert.equal(setConfidence(t, 99, 'low'), false);
  assert.equal(t.items[0].confidence, 'low');
  t.items[0].chosen = 1; // submitted
  assert.equal(canSetConfidence(t, t.items[0]), false);
  assert.equal(setConfidence(t, 0, 'high'), false);
  assert.equal(setConfidence(t, 0, null), false);
  assert.equal(t.items[0].confidence, 'low');

  const e = confSession('exam');
  e.items[0].chosen = 1;
  assert.equal(setConfidence(e, 0, 'high'), true);
  assert.equal(setConfidence(e, 0, null), true);
  assert.equal(e.items[0].confidence, null);
  e.finished = true;
  assert.equal(setConfidence(e, 0, 'medium'), false);
  assert.equal(setConfidence(e, 1, 'medium'), false);
});
// c1 high+wrong, c2 high+right, c3 low+right, c4 low+wrong, c5 unrated+unanswered
const ratedSession = () => {
  const s = confSession('exam');
  const plan = [[1, 'high'], [0, 'high'], [0, 'low'], [2, 'low'], [null, null]];
  plan.forEach(([chosen, c], i) => {
    s.items[i].chosen = chosen;
    setConfidence(s, i, c);
  });
  return s;
};
test('scoreSession: confidence breakdown and id lists; scoring unaffected', () => {
  const r = scoreSession(confSet, ratedSession());
  assert.equal(r.score, 2);
  assert.deepEqual(r.confidence, {
    low: { correct: 1, incorrect: 1 },
    medium: { correct: 0, incorrect: 0 },
    high: { correct: 1, incorrect: 1 },
    unrated: { correct: 0, incorrect: 1 },
  });
  assert.deepEqual(r.confidentWrong, ['c1']);
  assert.deepEqual(r.luckyRight, ['c3']);
  const none = scoreSession(confSet, confSession());
  assert.deepEqual(none.confidence.unrated, { correct: 0, incorrect: 5 });
  assert.deepEqual([none.confidentWrong, none.luckyRight], [[], []]);
});
test('buildExport includes confidence per response', () => {
  const exp = buildExport(confSet, ratedSession(), new Date(0));
  assert.deepEqual(exp.responses.map((x) => x.confidence), ['high', 'high', 'low', 'low', null]);
  const old = confSession();
  delete old.items[0].confidence; // unnormalized older item still exports null
  assert.equal(buildExport(confSet, old).responses[0].confidence, null);
});
test('buildClaudeSummary lists high-confidence misses separately', () => {
  const txt = buildClaudeSummary(confSet, ratedSession());
  assert.ok(txt.includes('Missed while confident: [c1]'));
  assert.ok(!buildClaudeSummary(confSet, confSession()).includes('Missed while confident'));
});

/* ---------- prompt ---------- */
section('Prompt');
test('fillPrompt substitutes every placeholder and embeds the schema', () => {
  const p = fillPrompt({ n: 12, style: 'comlex', topic: 'renal acid-base', options: 4, difficulty: 'hard' });
  assert.ok(p.startsWith('Generate 12 COMLEX Level 1-style single-best-answer questions on renal acid-base'));
  assert.ok(p.includes('- 4 answer options per question'));
  assert.ok(p.includes('osteopathic'));
  assert.ok(p.includes('"$defs"') && p.includes('"discriminator"'));
  const placeholders = PROMPT_TEMPLATE.match(/\{[A-Z_]+\}/g);
  for (const ph of placeholders) assert.ok(!p.includes(ph), `leftover ${ph}`);
  const schemaPart = p.slice(p.indexOf('Schema:\n') + 8);
  assert.deepEqual(JSON.parse(schemaPart), SCHEMA);
});
test('fillPrompt clamps bad input', () => {
  const p = fillPrompt({ n: -3, options: 99, style: 'nope', difficulty: '?' });
  assert.ok(p.startsWith('Generate 1 USMLE Step 1-style'));
  assert.ok(p.includes('- 8 answer options'));
});

/* ---------- summary ---------- */
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed:\n - ' + failures.join('\n - '));
  process.exit(1);
}
