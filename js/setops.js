// Set operations: merge, split and duplicate detection. Pure — no DOM — so it is
// unit-testable in Node.
//
// Inputs are never modified: every produced set holds deep copies of the source
// questions. Given valid v1 sets, every produced set is a valid v1 set.

import { slug, stripMarkdown } from './util.js';
import { questionTags } from './session.js';

export const UNTAGGED_TITLE = 'Untagged';
export const DEFAULT_DUP_THRESHOLD = 0.8;

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function assertSet(set, label) {
  if (!set || typeof set !== 'object' || !Array.isArray(set.questions)) {
    throw new TypeError(`${label} must be a set object with a "questions" array.`);
  }
}

/* ---------- duplicate detection ---------- */

// Common English function words plus words that appear in nearly every vignette stem.
const STOPWORDS = new Set(
  (
    'a an and are as at be been being but by can could did do does for from had has have he her his how i if in into ' +
    'is it its may might more most of on or she should than that the their them then there these they this those to ' +
    'was we were what when where which while who whom whose why will with would you your following best likely next'
  ).split(' ')
);

/**
 * Normalize text to a set of comparison tokens: lowercase, markdown stripped with
 * stripMarkdown(), punctuation removed, stopwords dropped.
 * @param {string} text
 * @returns {Set<string>}
 */
export function stemTokens(text) {
  const words = stripMarkdown(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ');
  const out = new Set();
  for (const w of words) if (w && !STOPWORDS.has(w)) out.add(w);
  return out;
}

/** Normalized text of a question's correct option ('' when it has none). */
function answerKey(q) {
  const opt = q && Array.isArray(q.options) ? q.options[q.answer] : null;
  const text = opt && typeof opt.text === 'string' ? opt.text : '';
  return stripMarkdown(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Find likely duplicate questions.
 *
 * Two questions are a pair when their correct options have the same normalized text AND
 * the Jaccard similarity of their normalized stem tokens (see stemTokens()) is at least
 * `threshold`. Candidates are found with an inverted index over a rarity-ordered token
 * prefix (prefix filtering), which is exact for Jaccard but avoids comparing every pair,
 * so ~1,000 questions take milliseconds.
 *
 * @param {object[]} questions
 * @param {{threshold?: number}} [opts] threshold in [0, 1], default 0.8
 * @returns {{a: number, b: number, score: number}[]} `a` < `b` are indexes into
 *   `questions`; `score` is the stem Jaccard similarity (0–1). Sorted by a, then b.
 */
export function findDuplicates(questions, { threshold = DEFAULT_DUP_THRESHOLD } = {}) {
  if (!Array.isArray(questions)) throw new TypeError('findDuplicates: questions must be an array.');
  const t = Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_DUP_THRESHOLD;

  const tokens = questions.map((q) => stemTokens(q && q.stem));
  const keys = questions.map(answerKey);

  // Global token frequency → order tokens rarest first so prefixes are selective.
  const freq = new Map();
  for (const set of tokens) for (const w of set) freq.set(w, (freq.get(w) || 0) + 1);
  const byRarity = (x, y) => freq.get(x) - freq.get(y) || (x < y ? -1 : x > y ? 1 : 0);
  const sorted = tokens.map((set) => [...set].sort(byRarity));

  const index = new Map(); // `${answerKey}\u0000${token}` → [question index]
  const pairs = [];
  for (let i = 0; i < questions.length; i++) {
    const toks = sorted[i];
    const n = toks.length;
    if (!n || !keys[i]) continue;
    // Any set with Jaccard ≥ t shares at least one token within this prefix.
    const prefix = t === 0 ? n : n - Math.ceil(t * n - 1e-9) + 1;
    const seen = new Set();
    for (let p = 0; p < prefix; p++) {
      const bucket = index.get(keys[i] + '\u0000' + toks[p]);
      if (!bucket) continue;
      for (const j of bucket) {
        if (seen.has(j)) continue;
        seen.add(j);
        const m = tokens[j].size;
        if (Math.min(n, m) < t * Math.max(n, m) - 1e-9) continue; // length filter
        let inter = 0;
        for (const w of tokens[j]) if (tokens[i].has(w)) inter++;
        const score = inter / (n + m - inter);
        if (score >= t - 1e-9 && inter > 0) pairs.push({ a: j, b: i, score: Math.round(score * 1000) / 1000 });
      }
    }
    for (let p = 0; p < prefix; p++) {
      const k = keys[i] + '\u0000' + toks[p];
      const bucket = index.get(k);
      if (bucket) bucket.push(i);
      else index.set(k, [i]);
    }
  }
  return pairs.sort((x, y) => x.a - y.a || x.b - y.b);
}

/* ---------- merge ---------- */

/**
 * Merge sets into one new v1 set.
 *
 * Ids that appear in more than one source set are prefixed with that source's title
 * slug (`renal-pharm:q3`) in every set they appear in; ids unique across sources are
 * kept. Sources whose titles slug the same get `-2`, `-3`… so prefixed ids stay unique.
 * With `dedupe`, a question is dropped when findDuplicates() pairs it with an earlier
 * question that was kept (the earliest question of each duplicate group survives).
 *
 * @param {object[]} sets source sets (not modified)
 * @param {{title?: string, description?: string, dedupe?: boolean, threshold?: number}} [opts]
 *   title defaults to the source titles joined with " + "; description defaults to
 *   "Merged from: <titles>."; threshold is passed to findDuplicates().
 * @returns {{
 *   set: object,
 *   renamed: {source: number, sourceTitle: string, from: string, to: string}[],
 *   dropped: {id: string, source: number, sourceTitle: string, duplicateOf: string, score: number}[]
 * }} `source` is the index into `sets`; ids in `dropped` are the merged (possibly renamed) ids.
 */
export function mergeSets(sets, { title, description, dedupe = false, threshold = DEFAULT_DUP_THRESHOLD } = {}) {
  if (!Array.isArray(sets) || !sets.length) throw new TypeError('mergeSets: pass a non-empty array of sets.');
  sets.forEach((s, i) => assertSet(s, `mergeSets: sets[${i}]`));

  const titles = sets.map((s, i) => (typeof s.title === 'string' && s.title.trim() ? s.title.trim() : `Set ${i + 1}`));

  // Unique slug per source.
  const slugCount = new Map();
  const prefixes = titles.map((t) => {
    const base = slug(t);
    const n = (slugCount.get(base) || 0) + 1;
    slugCount.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });

  // Which ids appear in more than one source?
  const owners = new Map(); // id → Set(source index)
  sets.forEach((s, si) => {
    for (const q of s.questions) {
      const id = String(q && q.id);
      if (!owners.has(id)) owners.set(id, new Set());
      owners.get(id).add(si);
    }
  });

  const taken = new Set();
  for (const [id, srcs] of owners) if (srcs.size === 1) taken.add(id);
  const used = new Set();
  const claim = (id) => {
    let out = id;
    for (let n = 2; used.has(out); n++) out = `${id}~${n}`;
    used.add(out);
    return out;
  };

  const renamed = [];
  const merged = []; // {q, source}
  sets.forEach((s, si) => {
    for (const q of s.questions) {
      const copy = clone(q);
      const from = String(q && q.id);
      let to = owners.get(from).size > 1 ? `${prefixes[si]}:${from}` : from;
      // Guard against a prefixed id clashing with a kept id, or repeats inside one source.
      if (to !== from && taken.has(to)) to = `${to}~${si + 1}`;
      to = claim(to);
      if (to !== from) renamed.push({ source: si, sourceTitle: titles[si], from, to });
      copy.id = to;
      merged.push({ q: copy, source: si });
    }
  });

  const dropped = [];
  let kept = merged;
  if (dedupe) {
    const pairs = findDuplicates(
      merged.map((m) => m.q),
      { threshold }
    );
    const isDropped = new Array(merged.length).fill(false);
    // pairs are sorted by a then b; walk by b so an earlier question's fate is known first.
    const byB = [...pairs].sort((x, y) => x.b - y.b || x.a - y.a);
    for (const { a, b, score } of byB) {
      if (isDropped[b] || isDropped[a]) continue;
      isDropped[b] = true;
      const m = merged[b];
      dropped.push({ id: m.q.id, source: m.source, sourceTitle: titles[m.source], duplicateOf: merged[a].q.id, score });
    }
    kept = merged.filter((_, i) => !isDropped[i]);
  }

  const set = {
    title: typeof title === 'string' && title.trim() ? title.trim() : titles.join(' + '),
    version: 1,
    description: typeof description === 'string' ? description : `Merged from: ${titles.join('; ')}.`,
    questions: kept.map((m) => m.q),
  };
  return { set, renamed, dropped };
}

/* ---------- split ---------- */

/**
 * Split a set into several new v1 sets.
 *
 * - `by: 'tag'`: one set per tag, titled "<title>: <tag>", in tag name order, with an
 *   "<title>: Untagged" set last for questions without tags. A question with several
 *   tags appears in each of their sets.
 * - `by: 'count'`: consecutive chunks of `size` questions in set order, titled
 *   "<title> (2 of 3)". A set that fits in one chunk yields one copy without a suffix.
 *
 * @param {object} set source set (not modified)
 * @param {{by: 'tag'|'count', size?: number}} opts size: positive integer, required for 'count'
 * @returns {object[]} new sets, each with copies of its questions
 */
export function splitSet(set, { by, size } = {}) {
  assertSet(set, 'splitSet: set');
  const title = typeof set.title === 'string' && set.title.trim() ? set.title.trim() : 'Set';
  const make = (suffixTitle, questions, description) => ({
    title: suffixTitle,
    version: 1,
    description,
    questions: questions.map(clone),
  });

  if (by === 'tag') {
    const groups = new Map();
    const untagged = [];
    for (const q of set.questions) {
      const tags = [...new Set(questionTags(q))];
      if (!tags.length) untagged.push(q);
      for (const t of tags) {
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(q);
      }
    }
    const out = [...groups.keys()]
      .sort((x, y) => x.localeCompare(y))
      .map((t) => make(`${title}: ${t}`, groups.get(t), `Questions tagged "${t}" from "${title}".`));
    if (untagged.length) out.push(make(`${title}: ${UNTAGGED_TITLE}`, untagged, `Untagged questions from "${title}".`));
    return out;
  }

  if (by === 'count') {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('splitSet: size must be a positive integer.');
    const total = Math.ceil(set.questions.length / size);
    const out = [];
    for (let i = 0; i < total; i++) {
      const chunk = set.questions.slice(i * size, (i + 1) * size);
      const t = total === 1 ? title : `${title} (${i + 1} of ${total})`;
      const first = i * size + 1;
      out.push(make(t, chunk, `Questions ${first}–${first + chunk.length - 1} of "${title}".`));
    }
    return out;
  }

  throw new RangeError(`splitSet: "by" must be 'tag' or 'count' (got ${JSON.stringify(by)}).`);
}
