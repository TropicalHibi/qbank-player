// Quiz session model: building (filter, subset, shuffle with answer remap), scoring,
// export and summaries. Pure — no DOM — so it is unit-testable in Node.
//
// Responses always store ORIGINAL option indexes (`chosen`), so scoring never depends
// on display order. `item.order[displayIndex] === originalIndex`.
//
// `pending` (tutor mode) is an original index the user has picked but not yet submitted.
// It never counts as an answer: only `chosen` is used for scoring and progress.
//
// `confidence` is an optional self-rating ('low' | 'medium' | 'high', or null if unrated).
// It never affects scoring. Set it with setConfidence(), which enforces the lock rules.

import { mergeRanges, shuffle, mulberry32, randomSeed, hashString, slug, fileTimestamp, truncate, stripMarkdown, formatDuration, LETTERS } from './util.js';

export const UNTAGGED = '(untagged)';

export function setKey(set) {
  const ids = set.questions.map((q) => q.id);
  return `${set.title}::v${set.version}::${hashString(ids.join('\u001f'))}`;
}

export function indexById(set) {
  return new Map(set.questions.map((q) => [q.id, q]));
}

export function questionTags(q) {
  return Array.isArray(q.tags) ? q.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
}

/** [{tag, count}] sorted by name; includes UNTAGGED if any question lacks tags. */
export function collectTags(set) {
  const counts = new Map();
  let untagged = 0;
  for (const q of set.questions) {
    const tags = questionTags(q);
    if (!tags.length) untagged++;
    for (const t of new Set(tags)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const list = [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
  if (untagged) list.push({ tag: UNTAGGED, count: untagged });
  return list;
}

/**
 * Ids of questions matching the filter, in set order.
 * @param {object} set
 * @param {{tags?: string[]|null, restrictIds?: string[]|null}} f  tags=null means "all tags"
 */
export function poolIds(set, { tags = null, restrictIds = null } = {}) {
  const allow = tags ? new Set(tags) : null;
  const restrict = restrictIds ? new Set(restrictIds) : null;
  return set.questions
    .filter((q) => {
      if (restrict && !restrict.has(q.id)) return false;
      if (!allow) return true;
      const t = questionTags(q);
      return t.length ? t.some((x) => allow.has(x)) : allow.has(UNTAGGED);
    })
    .map((q) => q.id);
}

/**
 * Build a new session.
 * @param {object} set validated set
 * @param {object} o
 * @param {'tutor'|'exam'} [o.mode]
 * @param {boolean} [o.shuffleQuestions]
 * @param {boolean} [o.shuffleOptions]
 * @param {string[]} [o.ids] pool of question ids (default: all)
 * @param {number} [o.count] take this many from the pool
 * @param {number} [o.timerSec] exam per-question seconds (0 = untimed)
 * @param {number} [o.seed]
 * @param {string} [o.label] e.g. "Redo missed"
 * @param {boolean} [o.askConfidence] show the confidence rating control (default true)
 */
export function buildSession(set, o = {}) {
  const {
    mode = 'tutor',
    shuffleQuestions = true,
    shuffleOptions = true,
    ids,
    count,
    timerSec = 0,
    seed = randomSeed(),
    label = '',
    askConfidence = true,
  } = o;
  const byId = indexById(set);
  const rng = mulberry32(seed);
  let chosen = (ids ?? set.questions.map((q) => q.id)).filter((id) => byId.has(id));
  if (shuffleQuestions) chosen = shuffle(chosen, rng);
  if (count && count > 0 && count < chosen.length) chosen = chosen.slice(0, count);
  const items = chosen.map((id) => {
    const base = byId.get(id).options.map((_, i) => i);
    return { id, order: shuffleOptions ? shuffle(base, rng) : base, chosen: null, pending: null, timeMs: 0, flagged: false, struck: [], highlights: [], confidence: null };
  });
  return {
    v: 1,
    key: setKey(set),
    mode: mode === 'exam' ? 'exam' : 'tutor',
    timerSec: mode === 'exam' ? Math.max(0, Math.round(timerSec || 0)) : 0,
    seed,
    label,
    settings: { shuffleQuestions, shuffleOptions, askConfidence: askConfidence !== false },
    createdAt: Date.now(),
    items,
    current: 0,
    elapsedMs: 0,
    finished: false,
    finishedAt: null,
  };
}

/** Is a stored session still consistent with this set? (guards resume against edited sets/corrupt storage) */
export function isSessionValid(set, s) {
  if (!s || typeof s !== 'object' || s.v !== 1 || !Array.isArray(s.items) || !s.items.length) return false;
  if (s.key !== setKey(set)) return false;
  const byId = indexById(set);
  return s.items.every((it) => {
    const q = byId.get(it && it.id);
    if (!q || !Array.isArray(it.order) || it.order.length !== q.options.length) return false;
    const sorted = [...it.order].sort((a, b) => a - b);
    if (!sorted.every((v, i) => v === i)) return false;
    return it.chosen === null || (Number.isInteger(it.chosen) && it.chosen >= 0 && it.chosen < q.options.length);
  });
}

/** Highlight ranges for an item; older saved sessions have none, and garbage is dropped. */
export const itemHighlights = (item) => mergeRanges(item && item.highlights);

/**
 * Bring a stored session (already checked with isSessionValid) up to the current shape, in place.
 * Older saves have no `pending`; a missing or out-of-range pending becomes null, and a
 * pending choice is dropped once the question has been answered.
 * Older saves have no `struck`; it becomes [], and malformed entries are dropped.
 * Older saves have no `highlights`; they become [], and ranges are validated and merged.
 * Older saves have no `confidence`; a missing or unknown value becomes null.
 */
export function normalizeSession(set, s) {
  const byId = indexById(set);
  for (const it of s.items) {
    const n = byId.get(it.id).options.length;
    const p = it.pending;
    it.pending = it.chosen === null && Number.isInteger(p) && p >= 0 && p < n ? p : null;
    it.struck = Array.isArray(it.struck) ? [...new Set(it.struck.filter((v) => Number.isInteger(v) && v >= 0 && v < n))].sort((a, b) => a - b) : [];
    it.highlights = mergeRanges(it.highlights);
    it.confidence = normalizeConfidence(it.confidence);
  }
  return s;
}

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];

/** A valid confidence level, or null. */
export const normalizeConfidence = (v) => (CONFIDENCE_LEVELS.includes(v) ? v : null);

/** Does this session ask for confidence ratings? Older saves have no setting and default to yes. */
export const asksConfidence = (session) => !(session && session.settings && session.settings.askConfidence === false);

/** Can this item's confidence still change? Tutor: until the answer is submitted. Exam: until the exam is submitted. */
export const canSetConfidence = (session, item) => !session.finished && (session.mode === 'exam' || item.chosen === null);

/**
 * Set (or clear, with null) the confidence rating of session.items[index].
 * Returns false and changes nothing if the item is locked or the value is not a level or null.
 */
export function setConfidence(session, index, value) {
  const item = session.items[index];
  if (!item || (value !== null && !CONFIDENCE_LEVELS.includes(value)) || !canSetConfidence(session, item)) return false;
  item.confidence = value;
  return true;
}

/* Strikeouts store ORIGINAL option indexes, so they survive option shuffling. */
export const isStruck = (item, original) => Array.isArray(item.struck) && item.struck.includes(original);

/** Toggle a strike on an original option index. Returns the new state (true = struck). */
export function toggleStrike(item, original) {
  const cur = Array.isArray(item.struck) ? item.struck.filter((v) => v !== original) : [];
  const on = !isStruck(item, original);
  item.struck = on ? [...cur, original].sort((a, b) => a - b) : cur;
  return on;
}

/** Remove a strike (e.g. when the option is selected). Returns true if one was removed. */
export function clearStrike(item, original) {
  if (!isStruck(item, original)) return false;
  item.struck = item.struck.filter((v) => v !== original);
  return true;
}

export const displayIndexOf = (item, original) => item.order.indexOf(original);
export const letterFor = (item, original) => (original == null ? '—' : LETTERS[item.order.indexOf(original)] ?? '?');
export const answeredCount = (s) => s.items.filter((it) => it.chosen !== null).length;

export function scoreSession(set, session) {
  const byId = indexById(set);
  const responses = session.items.map((it) => {
    const q = byId.get(it.id);
    return {
      id: it.id,
      chosen: it.chosen,
      correct: it.chosen !== null && it.chosen === q.answer,
      timeMs: Math.round(it.timeMs || 0),
      flagged: !!it.flagged,
      confidence: normalizeConfidence(it.confidence),
      tags: questionTags(q).slice(),
    };
  });
  const score = responses.filter((r) => r.correct).length;
  const total = responses.length;
  const tagMap = new Map();
  for (const r of responses) {
    for (const t of r.tags.length ? new Set(r.tags) : [UNTAGGED]) {
      const e = tagMap.get(t) || { tag: t, correct: 0, total: 0 };
      e.total++;
      if (r.correct) e.correct++;
      tagMap.set(t, e);
    }
  }
  const byTag = [...tagMap.values()]
    .map((e) => ({ ...e, pct: e.total ? e.correct / e.total : 0 }))
    .sort((a, b) => a.pct - b.pct || b.total - a.total || a.tag.localeCompare(b.tag));
  const confidence = {};
  for (const k of [...CONFIDENCE_LEVELS, 'unrated']) confidence[k] = { correct: 0, incorrect: 0 };
  for (const r of responses) confidence[r.confidence ?? 'unrated'][r.correct ? 'correct' : 'incorrect']++;
  const totalMs = Math.round(session.elapsedMs || 0);
  return {
    score,
    total,
    pct: total ? score / total : 0,
    totalMs,
    avgMs: total ? totalMs / total : 0,
    responses,
    byTag,
    missedIds: responses.filter((r) => !r.correct).map((r) => r.id),
    flaggedIds: responses.filter((r) => r.flagged).map((r) => r.id),
    confidence,
    confidentWrong: responses.filter((r) => r.confidence === 'high' && !r.correct).map((r) => r.id),
    luckyRight: responses.filter((r) => r.confidence === 'low' && r.correct).map((r) => r.id),
  };
}

export function buildExport(set, session, now = new Date()) {
  const r = scoreSession(set, session);
  return {
    setTitle: set.title,
    setVersion: set.version,
    mode: session.mode,
    timestamp: now.toISOString(),
    score: r.score,
    total: r.total,
    responses: r.responses.map(({ id, chosen, correct, timeMs, flagged, confidence, tags }) => ({ id, chosen, correct, timeMs, flagged, confidence, tags })),
  };
}

export function resultsFilename(title, date = new Date()) {
  return `${slug(title)}-results-${fileTimestamp(date)}.json`;
}

const pctStr = (x) => `${Math.round(x * 100)}%`;

/** Compact plaintext for pasting into Claude to request a targeted follow-up set. */
export function buildClaudeSummary(set, session) {
  const r = scoreSession(set, session);
  const byId = indexById(set);
  const lines = [];
  lines.push(`qbank-player results: "${set.title}" (${session.mode} mode)`);
  lines.push(`Score: ${r.score}/${r.total} (${pctStr(r.pct)}) · Time: ${formatDuration(r.totalMs)}`);
  lines.push('');
  lines.push('Per-tag performance (worst first):');
  for (const t of r.byTag) lines.push(`- ${t.tag}: ${t.correct}/${t.total} (${pctStr(t.pct)})`);
  const missed = r.responses.filter((x) => !x.correct);
  lines.push('');
  lines.push(`Missed questions (${missed.length}):`);
  missed.forEach((x, n) => {
    const q = byId.get(x.id);
    const chosenText = x.chosen === null ? '(unanswered)' : stripMarkdown(q.options[x.chosen].text);
    lines.push(`${n + 1}. [${x.id}] ${truncate(stripMarkdown(q.stem), 120)}`);
    lines.push(`   Chose: ${chosenText} | Correct: ${stripMarkdown(q.options[q.answer].text)}`);
    if (x.tags.length) lines.push(`   Tags: ${x.tags.join(', ')}`);
  });
  if (r.confidentWrong.length) {
    lines.push('');
    lines.push(`Missed while confident: ${r.confidentWrong.map((id) => `[${id}]`).join(', ')}`);
    lines.push('   (rated high confidence but wrong — likely misconceptions worth targeting)');
  }
  lines.push('');
  lines.push(
    'Please write a new question set in the same JSON schema that targets my weak tags and the distinctions I missed, using new vignettes (not rewordings).'
  );
  return lines.join('\n');
}
