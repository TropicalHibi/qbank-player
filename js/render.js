// Shared question rendering for the quiz and the results review.

import { el, openLightbox } from './dom.js';
import { renderMarkdownLite, isSafeImageUrl, rangeSegments, LETTERS } from './util.js';
import { questionTags, itemHighlights } from './session.js';

/** Stem with the item's saved highlights (if any) reapplied after the md-lite render. */
export function renderStem(q, item) {
  const stem = el('div', { class: 'stem prose', html: renderMarkdownLite(q.stem) });
  if (item) applyHighlights(stem, itemHighlights(item));
  return stem;
}

/* ---------- highlights ---------- */

// Text nodes directly inside these are formatting whitespace; wrapping them would break the table.
const NO_MARK_PARENTS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);

function textNodes(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  return nodes;
}

/**
 * Wrap the given character ranges of `container`'s text content in <mark class="hl">,
 * one mark per text-node piece, by splitting text nodes (DOM APIs only, no innerHTML).
 */
export function applyHighlights(container, ranges) {
  const nodes = textNodes(container);
  const segs = rangeSegments(nodes.map((n) => n.data.length), ranges);
  // Work backwards so splitting a node never shifts offsets of pieces still to be wrapped.
  for (let i = segs.length - 1; i >= 0; i--) {
    const { node, start, end, range } = segs[i];
    let t = nodes[node];
    if (!t.parentNode || NO_MARK_PARENTS.has(t.parentNode.nodeName)) continue;
    if (end < t.data.length) t.splitText(end);
    if (start > 0) t = t.splitText(start);
    const mark = document.createElement('mark');
    mark.className = 'hl';
    mark.dataset.hl = String(range);
    t.replaceWith(mark);
    mark.append(t);
  }
}

/** Character offset of a DOM boundary point within `container`'s text content. */
export function textOffset(container, node, offset) {
  const r = document.createRange();
  r.setStart(container, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** The part of a DOM Range that falls inside `container`, as {start, end} text offsets (or null). */
export function rangeToOffsets(container, range) {
  if (!range || range.collapsed || !range.intersectsNode(container)) return null;
  const full = document.createRange();
  full.selectNodeContents(container);
  const r = range.cloneRange();
  if (r.compareBoundaryPoints(Range.START_TO_START, full) < 0) r.setStart(full.startContainer, full.startOffset);
  if (r.compareBoundaryPoints(Range.END_TO_END, full) > 0) r.setEnd(full.endContainer, full.endOffset);
  const start = textOffset(container, r.startContainer, r.startOffset);
  const end = start + r.toString().length;
  return end > start ? { start, end, rect: r.getBoundingClientRect() } : null;
}

/** True when the user has a non-empty text selection touching `node` (a drag, not a click). */
function selectionTouches(node) {
  const sel = document.getSelection();
  return !!(sel && !sel.isCollapsed && sel.rangeCount && sel.getRangeAt(0).intersectsNode(node) && sel.toString().trim());
}

export function renderImage(q, number) {
  if (!q.image) return null;
  if (!isSafeImageUrl(q.image)) {
    return el('p', { class: 'image-blocked', text: 'Image not shown: unsupported URL scheme.' });
  }
  const alt = `Image for question ${number}`;
  const img = el('img', { src: q.image.trim(), alt, attrs: { loading: 'lazy', decoding: 'async' } });
  img.addEventListener('error', () => {
    btn.replaceWith(el('p', { class: 'image-blocked', text: 'Image could not be loaded.' }));
  });
  const btn = el(
    'button',
    { class: 'q-image', type: 'button', attrs: { 'aria-label': `${alt}. Click to enlarge.` }, on: { click: () => openLightbox(q.image.trim(), alt) } },
    img,
    el('span', { class: 'zoom-hint', attrs: { 'aria-hidden': 'true' }, text: '⤢ Enlarge' })
  );
  return btn;
}

/**
 * Render answer options.
 * @param {object} q question
 * @param {object} item session item ({order, chosen})
 * @param {{reveal: boolean, interactive: boolean, onSelect?: (original:number)=>void}} o
 */
export function renderOptions(q, item, { reveal, interactive, onSelect }) {
  const list = el('ol', { class: ['options', reveal && 'revealed'], attrs: { role: 'list' } });
  item.order.forEach((orig, d) => {
    const opt = q.options[orig];
    const isCorrect = orig === q.answer;
    const isChosen = item.chosen === orig;
    let state = '';
    let mark = '';
    let srNote = '';
    if (reveal) {
      if (isCorrect) {
        state = 'correct';
        mark = '✓';
        srNote = isChosen ? ' (your answer, correct)' : ' (correct answer)';
      } else if (isChosen) {
        state = 'incorrect';
        mark = '✕';
        srNote = ' (your answer, incorrect)';
      }
    } else if (isChosen) {
      state = 'selected';
      mark = '●';
      srNote = ' (selected)';
    }
    const content = [
      el('span', { class: 'opt-letter', attrs: { 'aria-hidden': 'true' }, text: LETTERS[d] }),
      el('span', { class: 'opt-text prose', html: renderMarkdownLite(opt.text) }),
      el('span', { class: 'opt-mark', attrs: { 'aria-hidden': 'true' }, text: mark }),
      el('span', { class: 'sr-only', text: srNote }),
    ];
    const body = interactive
      ? el(
          'button',
          {
            class: ['option', state],
            type: 'button',
            dataset: { display: String(d) },
            attrs: { 'aria-pressed': String(isChosen), 'aria-label': null },
            on: {
              click: (e) => {
                // Selecting option text with mouse or touch must not pick the option.
                if (e.detail && selectionTouches(e.currentTarget)) return;
                if (onSelect) onSelect(orig);
              },
            },
          },
          el('span', { class: 'sr-only', text: `Option ${LETTERS[d]}: ` }),
          content
        )
      : el('div', { class: ['option', state, 'static'] }, el('span', { class: 'sr-only', text: `Option ${LETTERS[d]}: ` }), content);
    const li = el('li', { class: 'option-item' }, body);
    if (reveal) {
      li.append(
        el(
          'div',
          { class: ['explanation', state] },
          el('span', { class: 'sr-only', text: `Explanation for ${LETTERS[d]}: ` }),
          el('div', { class: 'prose', html: renderMarkdownLite(opt.explanation) })
        )
      );
    }
    list.append(li);
  });
  return list;
}

/** Discriminator callout + tags + source (only shown after answering). */
export function renderReveal(q) {
  const parts = [];
  if (q.discriminator) {
    parts.push(
      el(
        'aside',
        { class: 'callout discriminator', attrs: { 'aria-label': 'Key distinction' } },
        el('strong', { class: 'callout-label', text: 'Key distinction' }),
        el('div', { class: 'prose', html: renderMarkdownLite(q.discriminator) })
      )
    );
  }
  const tags = questionTags(q);
  if (tags.length || q.source) {
    parts.push(
      el(
        'div',
        { class: 'q-meta' },
        tags.length ? el('ul', { class: 'tag-list', attrs: { 'aria-label': 'Tags' } }, tags.map((t) => el('li', { class: 'tag', text: t }))) : null,
        q.source ? el('p', { class: 'source' }, el('span', { class: 'muted', text: 'Source: ' }), q.source) : null
      )
    );
  }
  return parts;
}

/** Full read-only question with all explanations (results review). */
export function renderReviewBody(q, item, number) {
  return el(
    'div',
    { class: 'review-body' },
    renderStem(q, item),
    renderImage(q, number),
    item.chosen === null ? el('p', { class: 'unanswered-note', text: 'You did not answer this question.' }) : null,
    renderOptions(q, item, { reveal: true, interactive: false }),
    renderReveal(q)
  );
}
