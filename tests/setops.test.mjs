// Run: node tests/setops.test.mjs   (no dependencies)
import assert from 'node:assert/strict';

import { validateSet } from '../js/validate.js';
import { mergeSets, splitSet, findDuplicates, stemTokens } from '../js/setops.js';

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
const opts = (texts) => texts.map((text) => ({ text, explanation: `Because ${text}.` }));
const DISTRACTORS = ['Hydrochlorothiazide', 'Spironolactone', 'Acetazolamide', 'Furosemide', 'Mannitol'];
const mkQ = (id, stem, answerText = 'Furosemide', extra = {}) => ({
  id,
  stem,
  options: opts([...DISTRACTORS.filter((d) => d.toLowerCase() !== answerText.toLowerCase()).slice(0, 3), answerText]),
  answer: 3,
  ...extra,
});
const mkSet = (title, qs, extra = {}) => ({ title, version: 1, questions: qs, ...extra });
const assertValid = (set) => {
  const r = validateSet(set);
  assert.deepEqual(r.errors, [], `invalid set "${set.title}"`);
  assert.deepEqual(r.warnings, [], `warnings for "${set.title}"`);
};
const ids = (set) => set.questions.map((q) => q.id);

const LOOP = 'A 64-year-old man with **heart failure** has pitting edema. Which diuretic acts on the thick ascending limb?';
const LOOP_REWORDED = 'A 64 year old man with heart failure has pitting edema. Which diuretic acts on the *thick ascending limb*, most likely?';
const UNRELATED = 'A 22-year-old woman has a malar rash and arthralgias. Which antibody is most specific for her condition?';

const renal = mkSet('Renal pharm', [
  mkQ('q1', LOOP, 'Furosemide', { tags: ['renal', 'pharm'] }),
  mkQ('q2', 'Which drug blocks the Na-Cl cotransporter in the distal convoluted tubule?', 'Hydrochlorothiazide', { tags: ['renal'] }),
  mkQ('q3', 'Which drug inhibits carbonic anhydrase in the proximal tubule?', 'Acetazolamide'),
]);
const cardio = mkSet('Cardio pharm', [
  mkQ('q1', 'Which beta blocker is cardioselective and used after myocardial infarction?', 'Metoprolol', { tags: ['cardio'] }),
  mkQ('c2', LOOP_REWORDED, 'Furosemide', { tags: ['cardio', 'renal'] }),
  mkQ('q3', UNRELATED, 'Anti-dsDNA', { tags: ['immuno'] }),
]);

/* ---------- stemTokens ---------- */
section('stemTokens');
test('lowercases, strips markdown and punctuation, drops stopwords', () => {
  assert.deepEqual([...stemTokens('**The** *Loop* diuretic, acts on the TAL!')], ['loop', 'diuretic', 'acts', 'tal']);
});

/* ---------- findDuplicates ---------- */
section('findDuplicates');
test('finds a reworded copy', () => {
  const pairs = findDuplicates([mkQ('a', LOOP), mkQ('b', LOOP_REWORDED)]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a, 0);
  assert.equal(pairs[0].b, 1);
  assert.ok(pairs[0].score >= 0.8 && pairs[0].score <= 1);
});
test('does not flag an unrelated question', () => {
  assert.deepEqual(findDuplicates([mkQ('a', LOOP), mkQ('b', UNRELATED, 'Furosemide')]), []);
});
test('does not flag the same stem with a different correct answer', () => {
  assert.deepEqual(findDuplicates([mkQ('a', LOOP, 'Furosemide'), mkQ('b', LOOP, 'Bumetanide')]), []);
});
test('correct-answer match ignores case, markdown and punctuation', () => {
  assert.equal(findDuplicates([mkQ('a', LOOP, 'Furosemide'), mkQ('b', LOOP, '**furosemide.**')]).length, 1);
});
test('threshold is respected', () => {
  const qs = [mkQ('a', 'alpha beta gamma delta'), mkQ('b', 'alpha beta gamma epsilon')]; // Jaccard 3/5
  assert.deepEqual(findDuplicates(qs), []);
  assert.deepEqual(findDuplicates(qs, { threshold: 0.6 }), [{ a: 0, b: 1, score: 0.6 }]);
});
test('reports every pair in a group of three', () => {
  const pairs = findDuplicates([mkQ('a', LOOP), mkQ('x', UNRELATED), mkQ('b', LOOP), mkQ('c', LOOP_REWORDED)]);
  assert.deepEqual(
    pairs.map((p) => [p.a, p.b]),
    [
      [0, 2],
      [0, 3],
      [2, 3],
    ]
  );
});
test('matches a brute-force comparison on random data', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const vocab = Array.from({ length: 12 }, (_, i) => `w${i}`);
  const qs = Array.from({ length: 120 }, (_, i) => {
    const n = 3 + Math.floor(rnd() * 4);
    const words = Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]);
    return mkQ(`r${i}`, words.join(' '), rnd() < 0.5 ? 'Furosemide' : 'Mannitol');
  });
  for (const threshold of [0.5, 0.8, 1]) {
    const brute = [];
    for (let j = 0; j < qs.length; j++)
      for (let i = j + 1; i < qs.length; i++) {
        if (qs[i].options[3].text !== qs[j].options[3].text) continue;
        const A = stemTokens(qs[j].stem);
        const B = stemTokens(qs[i].stem);
        const inter = [...A].filter((w) => B.has(w)).length;
        const s = inter / (A.size + B.size - inter);
        if (s >= threshold) brute.push(`${j}-${i}`);
      }
    assert.deepEqual(
      findDuplicates(qs, { threshold }).map((p) => `${p.a}-${p.b}`),
      brute,
      `threshold ${threshold}`
    );
  }
});
test('1,000 questions finish quickly', () => {
  const topics = ['renal', 'cardiac', 'hepatic', 'pulmonary', 'neuro', 'endocrine', 'heme', 'gi'];
  const qs = Array.from({ length: 1000 }, (_, i) =>
    mkQ(
      `p${i}`,
      `Patient ${i} aged ${20 + (i % 60)} presents with ${topics[i % 8]} finding number ${i} and marker m${i * 7} ` +
        `after exposure e${i % 37}. Which mechanism explains finding ${i}?`,
      i % 3 ? 'Furosemide' : 'Mannitol'
    )
  );
  qs.push(mkQ('dup', qs[500].stem.replace('presents with', 'presenting with'), qs[500].options[3].text));
  const t0 = performance.now();
  const pairs = findDuplicates(qs);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  assert.deepEqual(
    pairs.map((p) => [p.a, p.b]),
    [[500, 1000]]
  );
});

/* ---------- mergeSets ---------- */
section('mergeSets');
test('produces a valid set with unique ids and renames collisions', () => {
  const { set, renamed, dropped } = mergeSets([renal, cardio], { title: 'Pharm mix' });
  assertValid(set);
  assert.equal(set.title, 'Pharm mix');
  assert.equal(set.questions.length, 6);
  assert.equal(new Set(ids(set)).size, 6);
  assert.deepEqual(ids(set), ['renal-pharm:q1', 'q2', 'renal-pharm:q3', 'cardio-pharm:q1', 'c2', 'cardio-pharm:q3']);
  assert.deepEqual(renamed, [
    { source: 0, sourceTitle: 'Renal pharm', from: 'q1', to: 'renal-pharm:q1' },
    { source: 0, sourceTitle: 'Renal pharm', from: 'q3', to: 'renal-pharm:q3' },
    { source: 1, sourceTitle: 'Cardio pharm', from: 'q1', to: 'cardio-pharm:q1' },
    { source: 1, sourceTitle: 'Cardio pharm', from: 'q3', to: 'cardio-pharm:q3' },
  ]);
  assert.deepEqual(dropped, []);
});
test('description lists the source titles; title defaults to them', () => {
  const { set } = mergeSets([renal, cardio]);
  assert.equal(set.title, 'Renal pharm + Cardio pharm');
  assert.ok(set.description.includes('Renal pharm') && set.description.includes('Cardio pharm'));
});
test('does not modify the source sets', () => {
  const before = JSON.stringify([renal, cardio]);
  const { set } = mergeSets([renal, cardio], { dedupe: true });
  set.questions[0].options[0].text = 'mutated';
  set.questions[0].tags.push('mutated');
  assert.equal(JSON.stringify([renal, cardio]), before);
});
test('dedupe drops the later duplicate and reports it', () => {
  const { set, dropped } = mergeSets([renal, cardio], { dedupe: true });
  assertValid(set);
  assert.deepEqual(ids(set), ['renal-pharm:q1', 'q2', 'renal-pharm:q3', 'cardio-pharm:q1', 'cardio-pharm:q3']);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'c2');
  assert.equal(dropped[0].source, 1);
  assert.equal(dropped[0].sourceTitle, 'Cardio pharm');
  assert.equal(dropped[0].duplicateOf, 'renal-pharm:q1');
  assert.ok(dropped[0].score >= 0.8);
});
test('sources with the same title still get unique ids', () => {
  const { set, renamed } = mergeSets([renal, renal, renal]);
  assertValid(set);
  assert.equal(new Set(ids(set)).size, 9);
  assert.equal(renamed.length, 9);
  assert.ok(ids(set).includes('renal-pharm-2:q1') && ids(set).includes('renal-pharm-3:q1'));
});
test('a prefixed id never clashes with an existing id', () => {
  const a = mkSet('A', [mkQ('q1', 'one'), mkQ('a:q1', 'two')]);
  const b = mkSet('B', [mkQ('q1', 'three')]);
  const { set } = mergeSets([a, b]);
  assertValid(set);
  assert.equal(new Set(ids(set)).size, 3);
});
test('rejects bad input', () => {
  assert.throws(() => mergeSets([]), TypeError);
  assert.throws(() => mergeSets([{ title: 'x' }]), TypeError);
});

/* ---------- splitSet ---------- */
section('splitSet');
const big = mkSet(
  'Renal pharm',
  Array.from({ length: 7 }, (_, i) =>
    mkQ(`q${i + 1}`, `Question number ${i + 1}`, 'Furosemide', i < 2 ? { tags: ['renal', 'pharm'] } : i < 5 ? { tags: ['renal'] } : {})
  ),
  { description: 'Original' }
);
test('by tag: one set per tag plus Untagged, multi-tag questions in each', () => {
  const before = JSON.stringify(big);
  const out = splitSet(big, { by: 'tag' });
  out.forEach(assertValid);
  assert.deepEqual(
    out.map((s) => [s.title, s.questions.length]),
    [
      ['Renal pharm: pharm', 2],
      ['Renal pharm: renal', 5],
      ['Renal pharm: Untagged', 2],
    ]
  );
  assert.deepEqual(ids(out[2]), ['q6', 'q7']);
  out[0].questions[0].stem = 'mutated';
  assert.notEqual(out[1].questions[0].stem, 'mutated', 'questions are copied per output set');
  assert.equal(JSON.stringify(big), before);
});
test('by tag: no Untagged set when every question is tagged', () => {
  const out = splitSet(mkSet('T', [mkQ('a', 'x', 'Furosemide', { tags: ['b'] })]), { by: 'tag' });
  assert.deepEqual(
    out.map((s) => s.title),
    ['T: b']
  );
});
test('by count: ordered chunks with "(i of n)" titles', () => {
  const out = splitSet(big, { by: 'count', size: 3 });
  out.forEach(assertValid);
  assert.deepEqual(
    out.map((s) => s.title),
    ['Renal pharm (1 of 3)', 'Renal pharm (2 of 3)', 'Renal pharm (3 of 3)']
  );
  assert.deepEqual(out.map(ids), [['q1', 'q2', 'q3'], ['q4', 'q5', 'q6'], ['q7']]);
});
test('by count: a single chunk keeps the title', () => {
  const out = splitSet(big, { by: 'count', size: 50 });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Renal pharm');
  assertValid(out[0]);
});
test('rejects bad options', () => {
  assert.throws(() => splitSet(big, { by: 'count', size: 0 }), RangeError);
  assert.throws(() => splitSet(big, { by: 'count' }), RangeError);
  assert.throws(() => splitSet(big, { by: 'nope' }), RangeError);
  assert.throws(() => splitSet(null, { by: 'tag' }), TypeError);
});

/* ---------- summary ---------- */
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed:\n - ' + failures.join('\n - '));
  process.exit(1);
}
