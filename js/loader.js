// Turn raw text (from a file, URL, or paste) into a validated question set.
// Tolerates common LLM quirks: ```json fences, prose around the JSON, a BOM,
// “smart quotes” used as JSON quotes, and trailing commas (auto-repaired with a warning).

import { validateSet } from './validate.js';

/**
 * Pull the JSON payload out of surrounding Markdown fences / prose.
 * @returns {{text: string, notes: string[]}}
 */
export function extractJsonText(raw) {
  const notes = [];
  let text = String(raw ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // Fenced block(s): prefer a ```json block whose body starts with { or [.
  const fenceRe = /```[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)\n?[ \t]*```/g;
  const blocks = [];
  let m;
  while ((m = fenceRe.exec(text))) blocks.push({ lang: m[1].toLowerCase(), body: m[2] });
  const looksJson = (b) => /^\s*[{[]/.test(b.body);
  if (blocks.length) {
    const pick =
      blocks.find((b) => b.lang === 'json' && looksJson(b)) || blocks.find(looksJson) || blocks[0];
    text = pick.body;
    notes.push('Removed Markdown code fence around the JSON.');
  } else {
    // Unterminated fence (e.g. truncated output): drop the opening fence line.
    const open = /^\s*```[^\n]*\n/.exec(text);
    if (open) {
      text = text.slice(open[0].length);
      notes.push('Removed an unterminated Markdown code fence.');
    }
  }

  const trimmed = text.trim();
  const isArray = trimmed.startsWith('[');
  const first = isArray ? text.indexOf('[') : text.indexOf('{');
  const last = isArray ? text.lastIndexOf(']') : text.lastIndexOf('}');
  if (first === -1) return { text: trimmed, notes };
  const end = last >= first ? last + 1 : text.length;
  if (text.slice(0, first).trim() || text.slice(end).trim()) {
    notes.push('Ignored text before/after the JSON.');
  }
  return { text: text.slice(first, end), notes };
}

/**
 * Repair JSON-ish text: smart quotes used as delimiters → ", trailing commas before } or ] removed.
 * Characters inside real JSON strings are left untouched. Valid JSON passes through unchanged.
 */
export function repairJson(text) {
  let out = '';
  let inStr = false;
  let smartStr = false;
  let esc = false;
  let trailingCommas = 0;
  let smartQuotes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
        out += c;
      } else if (c === '\\') {
        esc = true;
        out += c;
      } else if (smartStr && (c === '“' || c === '”')) {
        inStr = false;
        smartQuotes++;
        out += '"';
      } else if (c === '"') {
        if (smartStr) out += '\\"'; // a straight quote inside a smart-quoted string
        else {
          inStr = false;
          out += c;
        }
      } else out += c;
      continue;
    }
    if (c === '"') {
      inStr = true;
      smartStr = false;
      out += c;
    } else if (c === '“' || c === '”') {
      inStr = true;
      smartStr = true;
      smartQuotes++;
      out += '"';
    } else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') trailingCommas++;
      else out += c;
    } else out += c;
  }
  return { text: out, trailingCommas, smartQuotes };
}

function lineCol(text, pos) {
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  const column = pos - before.lastIndexOf('\n');
  return { line, column };
}

/** Build a readable message (with line/column and a caret snippet when possible). */
export function describeParseError(err, text) {
  const msg = String(err && err.message ? err.message : err);
  let line = null;
  let column = null;
  const lc = /line (\d+) column (\d+)/i.exec(msg);
  const p = /position (\d+)/i.exec(msg);
  const truncated =
    /end of (json )?(data|input)|unexpected end|unterminated/i.test(msg) || (p && +p[1] >= text.trimEnd().length);
  if (lc) {
    line = +lc[1];
    column = +lc[2];
  } else if (p) {
    ({ line, column } = lineCol(text, Math.min(+p[1], text.length)));
  } else if (truncated) {
    ({ line, column } = lineCol(text, text.length));
  }
  const reason = msg
    .replace(/^JSON\.parse:\s*/i, '')
    .replace(/^JSON Parse error:\s*/i, '')
    .replace(/\s*(in JSON )?at position \d+.*$/i, '')
    .replace(/\s*at line \d+ column \d+.*$/i, '')
    .trim();

  let message = line != null ? `Invalid JSON at line ${line}, column ${column}: ${reason}` : `Invalid JSON: ${reason}`;
  if (truncated) {
    message += ' — the JSON looks cut off. The model may have hit its output limit; ask it to continue, or generate fewer questions.';
  }
  let snippet = '';
  if (line != null) {
    const src = text.split('\n')[line - 1] ?? '';
    const start = Math.max(0, column - 40);
    const shown = src.slice(start, start + 80);
    snippet = `${start > 0 ? '…' : ''}${shown}\n${' '.repeat(Math.max(0, column - 1 - start) + (start > 0 ? 1 : 0))}^`;
  }
  return { message, line, column, snippet };
}

/**
 * Parse raw text into JSON, tolerating fences/prose/trailing commas.
 * @returns {{data?: any, errors: string[], warnings: string[], notes: string[], snippet?: string}}
 */
export function parseJsonText(raw) {
  const warnings = [];
  if (!String(raw ?? '').trim()) return { errors: ['Nothing to load — the input is empty.'], warnings, notes: [] };
  const { text, notes } = extractJsonText(raw);
  try {
    return { data: JSON.parse(text), errors: [], warnings, notes };
  } catch (firstErr) {
    const fixed = repairJson(text);
    try {
      const data = JSON.parse(fixed.text);
      if (fixed.trailingCommas) {
        warnings.push(`Auto-repaired ${fixed.trailingCommas} trailing comma${fixed.trailingCommas === 1 ? '' : 's'} before } or ].`);
      }
      if (fixed.smartQuotes) {
        warnings.push(`Auto-repaired ${fixed.smartQuotes} “smart quote” character${fixed.smartQuotes === 1 ? '' : 's'} used as JSON quotes.`);
      }
      return { data, errors: [], warnings, notes };
    } catch (err) {
      // Report against the repaired text (same line numbers; commas only removed).
      const d = describeParseError(err, fixed.text);
      return { errors: [d.message], warnings, notes, snippet: d.snippet };
    }
  }
}

/**
 * Parse + validate.
 * @returns {{ok: boolean, set?: object, errors: string[], warnings: string[], notes: string[], snippet?: string}}
 */
export function loadSetFromText(raw) {
  const parsed = parseJsonText(raw);
  if (parsed.errors.length) return { ok: false, ...parsed };
  const v = validateSet(parsed.data);
  return {
    ok: v.valid,
    set: v.valid ? parsed.data : undefined,
    errors: v.errors,
    warnings: [...parsed.warnings, ...v.warnings],
    notes: parsed.notes,
  };
}

export async function loadSetFromFile(file) {
  let text;
  try {
    text = await file.text();
  } catch (e) {
    return { ok: false, errors: [`Could not read "${file.name}": ${e.message}`], warnings: [], notes: [] };
  }
  return loadSetFromText(text);
}

export async function loadSetFromUrl(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (e) {
    return {
      ok: false,
      errors: [
        `Could not fetch ${url}: ${e.message}. If it is on another site, that server must allow cross-origin requests (CORS).`,
      ],
      warnings: [],
      notes: [],
    };
  }
  if (!res.ok) {
    return { ok: false, errors: [`Could not fetch ${url}: HTTP ${res.status} ${res.statusText}`.trim()], warnings: [], notes: [] };
  }
  return loadSetFromText(await res.text());
}
