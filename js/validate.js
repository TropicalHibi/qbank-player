// Hand-rolled validator for question set schema v1 (see /schema.json).
// Returns human-readable messages naming the question id (or position) and field.
// No DOM — runs in the browser and in Node.

import { isSafeImageUrl, LETTERS } from './util.js';

export const SCHEMA_VERSION = 1;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 8;

const TOP_KEYS = new Set(['$schema', 'title', 'version', 'description', 'questions']);
const Q_KEYS = new Set(['id', 'stem', 'image', 'options', 'answer', 'discriminator', 'tags', 'source', 'explanation', 'explanationImages']);
const OPT_KEYS = new Set(['text', 'explanation']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return `a string ("${v.length > 20 ? v.slice(0, 20) + '…' : v}")`;
  return `a ${typeof v}`;
}

/** Label used in messages: the question's id if usable, else its 1-based position. */
function labelFor(q, i) {
  return isObj(q) && isNonEmptyString(q.id) ? q.id.trim() : `question ${i + 1}`;
}

/**
 * @param {unknown} data parsed JSON
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validateSet(data) {
  const errors = [];
  const warnings = [];

  if (!isObj(data)) {
    if (Array.isArray(data)) {
      errors.push(
        'Top level must be an object with "title", "version" and "questions", but got an array. ' +
          'If this is just the questions array, wrap it: {"title": "…", "version": 1, "questions": [ … ]}'
      );
    } else {
      errors.push(`Top level must be a JSON object, but got ${typeName(data)}.`);
    }
    return { valid: false, errors, warnings };
  }

  // ----- top level -----
  if (!('title' in data)) errors.push('Set: missing "title".');
  else if (!isNonEmptyString(data.title)) errors.push(`Set: "title" must be a non-empty string (got ${typeName(data.title)}).`);

  if (!('version' in data)) errors.push(`Set: missing "version" (must be ${SCHEMA_VERSION}).`);
  else if (!Number.isInteger(data.version)) errors.push(`Set: "version" must be the integer ${SCHEMA_VERSION} (got ${typeName(data.version)}).`);
  else if (data.version !== SCHEMA_VERSION) errors.push(`Set: unsupported "version" ${data.version} (this player supports version ${SCHEMA_VERSION}).`);

  if ('description' in data && typeof data.description !== 'string') {
    errors.push(`Set: "description" must be a string (got ${typeName(data.description)}).`);
  }
  if ('$schema' in data && typeof data.$schema !== 'string') {
    warnings.push('Set: "$schema" should be a string (ignored).');
  }
  for (const k of Object.keys(data)) {
    if (!TOP_KEYS.has(k)) warnings.push(`Set: unknown field "${k}" (ignored).`);
  }

  if (!('questions' in data)) {
    errors.push('Set: missing "questions" array.');
    return { valid: false, errors, warnings };
  }
  if (!Array.isArray(data.questions)) {
    errors.push(`Set: "questions" must be an array (got ${typeName(data.questions)}).`);
    return { valid: false, errors, warnings };
  }
  if (data.questions.length === 0) {
    errors.push('Set: "questions" must contain at least 1 question.');
  }

  // ----- questions -----
  const seenIds = new Map();
  data.questions.forEach((q, i) => {
    const L = labelFor(q, i);
    if (!isObj(q)) {
      errors.push(`${L}: must be an object (got ${typeName(q)}).`);
      return;
    }

    // id
    if (!('id' in q)) errors.push(`${L}: missing "id".`);
    else if (!isNonEmptyString(q.id)) errors.push(`${L}: "id" must be a non-empty string (got ${typeName(q.id)}).`);
    else {
      const id = q.id.trim();
      if (seenIds.has(id)) errors.push(`${L}: duplicate id (also used by question ${seenIds.get(id) + 1}).`);
      else seenIds.set(id, i);
    }

    // stem
    if (!('stem' in q)) errors.push(`${L}: missing "stem".`);
    else if (!isNonEmptyString(q.stem)) errors.push(`${L}: "stem" must be a non-empty string.`);

    // image
    if ('image' in q) {
      if (typeof q.image !== 'string' || !q.image.trim()) errors.push(`${L}: "image" must be a non-empty string.`);
      else if (!isSafeImageUrl(q.image)) {
        errors.push(`${L}: "image" must be an http(s) URL, a relative path, or a data:image/ URI.`);
      }
    }

    // options
    let optCount = null;
    if (!('options' in q)) errors.push(`${L}: missing "options".`);
    else if (!Array.isArray(q.options)) errors.push(`${L}: "options" must be an array (got ${typeName(q.options)}).`);
    else {
      optCount = q.options.length;
      if (optCount < MIN_OPTIONS || optCount > MAX_OPTIONS) {
        errors.push(`${L}: "options" must have ${MIN_OPTIONS}–${MAX_OPTIONS} items (has ${optCount}).`);
      }
      const texts = new Map();
      q.options.forEach((o, j) => {
        const OL = `option ${LETTERS[j] ?? j + 1}`;
        if (typeof o === 'string') {
          errors.push(`${L}: ${OL} must be an object {"text", "explanation"}, not a plain string.`);
          return;
        }
        if (!isObj(o)) {
          errors.push(`${L}: ${OL} must be an object (got ${typeName(o)}).`);
          return;
        }
        if (!('text' in o)) errors.push(`${L}: ${OL} missing "text".`);
        else if (!isNonEmptyString(o.text)) errors.push(`${L}: ${OL} "text" must be a non-empty string.`);
        else {
          const norm = o.text.trim().toLowerCase();
          if (texts.has(norm)) warnings.push(`${L}: ${OL} has the same text as option ${LETTERS[texts.get(norm)]}.`);
          else texts.set(norm, j);
        }
        if (!('explanation' in o)) errors.push(`${L}: ${OL} missing "explanation".`);
        else if (!isNonEmptyString(o.explanation)) errors.push(`${L}: ${OL} "explanation" must be a non-empty string.`);
        for (const k of Object.keys(o)) {
          if (!OPT_KEYS.has(k)) warnings.push(`${L}: ${OL} unknown field "${k}" (ignored).`);
        }
      });
    }

    // answer
    if (!('answer' in q)) errors.push(`${L}: missing "answer" (zero-based index of the correct option).`);
    else if (!Number.isInteger(q.answer)) {
      let hint = '';
      if (typeof q.answer === 'string' && /^[A-Ha-h]$/.test(q.answer.trim())) {
        hint = ` — use ${LETTERS.indexOf(q.answer.trim().toUpperCase())} instead of "${q.answer.trim()}"`;
      }
      errors.push(`${L}: "answer" must be an integer index (got ${typeName(q.answer)})${hint}.`);
    } else if (optCount !== null && (q.answer < 0 || q.answer >= optCount)) {
      errors.push(`${L}: answer index ${q.answer} out of range (${optCount} options).`);
    }

    // optional strings
    for (const f of ['discriminator', 'source']) {
      if (f in q && typeof q[f] !== 'string') errors.push(`${L}: "${f}" must be a string (got ${typeName(q[f])}).`);
    }

    // overall explanation (blank is allowed and treated as absent)
    if ('explanation' in q && typeof q.explanation !== 'string') {
      errors.push(`${L}: "explanation" must be a string (got ${typeName(q.explanation)}).`);
    }

    // explanation images
    if ('explanationImages' in q) {
      if (!Array.isArray(q.explanationImages)) {
        errors.push(`${L}: "explanationImages" must be an array of image URLs (got ${typeName(q.explanationImages)}).`);
      } else {
        q.explanationImages.forEach((u, k) => {
          if (typeof u !== 'string' || !u.trim()) {
            errors.push(`${L}: explanationImages[${k}] must be a non-empty string (got ${typeName(u)}).`);
          } else if (!isSafeImageUrl(u)) {
            const shown = u.length > 30 ? u.slice(0, 30) + '…' : u;
            errors.push(`${L}: explanationImages[${k}] is not an allowed image URL (${shown}).`);
          }
        });
      }
    }

    // tags
    if ('tags' in q) {
      if (!Array.isArray(q.tags)) errors.push(`${L}: "tags" must be an array of strings (got ${typeName(q.tags)}).`);
      else {
        q.tags.forEach((t, k) => {
          if (!isNonEmptyString(t)) errors.push(`${L}: tags[${k}] must be a non-empty string (got ${typeName(t)}).`);
        });
      }
    }

    for (const k of Object.keys(q)) {
      if (!Q_KEYS.has(k)) warnings.push(`${L}: unknown field "${k}" (ignored).`);
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}
