// Pure helpers — no DOM access, so this module also runs under Node (tests).

export const LETTERS = 'ABCDEFGH';

/* ---------- randomness ---------- */

/** Small, fast seeded PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/**
 * Fisher–Yates shuffle returning a new array.
 * @param {Array} arr
 * @param {number|Function} [seedOrRng] numeric seed, an rng function, or omitted for Math.random
 */
export function shuffle(arr, seedOrRng) {
  const rng =
    typeof seedOrRng === 'function'
      ? seedOrRng
      : seedOrRng == null
        ? Math.random
        : mulberry32(seedOrRng);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- strings ---------- */

/** FNV-1a 32-bit hash → 8-char hex. Stable across browsers and Node. */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function slug(s) {
  const out = String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return out || 'set';
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : str;
}

/** Collapse markdown-lite to plain one-line text (for snippets/summaries). */
export function stripMarkdown(s) {
  return String(s ?? '')
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[^\w])[*_](?=\S)([^*_]*?\S)[*_](?!\w)/g, '$1$2')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- URLs ---------- */

/**
 * Allowlist for <img src>: http(s), protocol-relative, data:image/*, or a relative path.
 * Everything with another scheme (javascript:, data:text/html, file:, …) is rejected.
 */
export function isSafeImageUrl(url) {
  if (typeof url !== 'string') return false;
  // Strip whitespace/control chars before checking the scheme so "java\tscript:" can't sneak through.
  const probe = url.replace(/[\s\u0000-\u001f\u007f]/g, '').toLowerCase();
  if (!probe) return false;
  if (probe.startsWith('http://') || probe.startsWith('https://')) return true;
  if (probe.startsWith('data:image/')) return true;
  if (probe.startsWith('//')) return true;
  if (/^[a-z][a-z0-9+.-]*:/.test(probe)) return false;
  return true;
}

/* ---------- markdown-lite ---------- */

const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableRow = (line) => line.trim().startsWith('|') && line.trim().length > 1;
const isTableSep = (line) => TABLE_SEP.test(line) && line.includes('-');

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function inline(raw) {
  // 1. escape everything; 2. pull out code spans; 3. apply emphasis; 4. restore code.
  const codes = [];
  let s = escapeHtml(raw).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

function renderTable(header, aligns, rows) {
  const cell = (tag, txt, i) => {
    const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
    return `<${tag}${a}>${inline(txt)}</${tag}>`;
  };
  const width = header.length;
  const body = rows
    .map((r) => {
      const cells = [];
      for (let i = 0; i < width; i++) cells.push(cell('td', r[i] ?? '', i));
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');
  return (
    `<div class="table-wrap"><table><thead><tr>${header.map((h, i) => cell('th', h, i)).join('')}</tr></thead>` +
    `<tbody>${body}</tbody></table></div>`
  );
}

/**
 * Render untrusted text as a tiny markdown subset. The input is HTML-escaped FIRST;
 * only tags generated here (<p>, <br>, <strong>, <em>, <code>, <table> family) can appear.
 */
export function renderMarkdownLite(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''
      );
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(splitRow(lines[i++]));
      i--;
      out.push(renderTable(header, aligns, rows));
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line);
  }
  flush();
  return out.join('');
}

/* ---------- highlight ranges ---------- */

/**
 * Normalize highlight ranges ({start, end} character offsets into a container's text
 * content): drop invalid entries, sort, and merge overlapping or touching ranges.
 */
export function mergeRanges(ranges) {
  const valid = (Array.isArray(ranges) ? ranges : [])
    .filter((r) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** Add a range and re-merge. */
export const addRange = (ranges, r) => mergeRanges([...(Array.isArray(ranges) ? ranges : []), r]);

/** Remove the (merged) range that covers character `offset`. */
export function removeRangeAt(ranges, offset) {
  return mergeRanges(ranges).filter((r) => !(offset >= r.start && offset < r.end));
}

/**
 * Map ranges onto a sequence of text nodes, given only their lengths (in document order).
 * Returns [{node, start, end, range}] where start/end are offsets local to text node `node`
 * and `range` is the index of the merged range the piece belongs to. A range that crosses
 * element boundaries (bold, italic, table cells) yields one piece per text node.
 */
export function rangeSegments(lengths, ranges) {
  const merged = mergeRanges(ranges);
  const segs = [];
  let pos = 0;
  let first = 0;
  for (let n = 0; n < lengths.length; n++) {
    const nStart = pos;
    const nEnd = pos + lengths[n];
    pos = nEnd;
    for (let i = first; i < merged.length && merged[i].start < nEnd; i++) {
      const s = Math.max(merged[i].start, nStart);
      const e = Math.min(merged[i].end, nEnd);
      if (e > s) segs.push({ node: n, start: s - nStart, end: e - nStart, range: i });
    }
    while (first < merged.length && merged[first].end <= nEnd) first++;
  }
  return segs;
}

/* ---------- time ---------- */

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** "1h 02m 03s", "4m 05s", "12s" */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** "mm:ss" or "h:mm:ss"; negative values get a leading "−". */
export function formatClock(ms) {
  const neg = ms < 0;
  const total = Math.floor(Math.abs(ms || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const body = h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return (neg ? '−' : '') + body;
}

/** Local-time "YYYY-MM-DD-HHmm" for filenames. */
export function fileTimestamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function relativeTime(then, now = Date.now()) {
  const s = Math.round((now - then) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(then).toLocaleDateString();
}
