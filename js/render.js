// Shared question rendering for the quiz and the results review.

import { el, openLightbox } from './dom.js';
import { renderMarkdownLite, isSafeImageUrl, LETTERS } from './util.js';
import { questionTags, isStruck } from './session.js';

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
const STRUCK_NOTE = ' (struck out)';

export function renderStem(q) {
  return el('div', { class: 'stem prose', html: renderMarkdownLite(q.stem) });
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
 * Wire right-click and touch long-press on an option button to `fire()`.
 * Right-click never opens the browser menu. Returns {consumeClick()}, which the click
 * handler checks so a long-press never also selects the option.
 */
function bindStrikeGestures(btn, fire) {
  let timer = 0;
  let start = null; // set while a touch/pen press is down
  let suppressClick = false;
  let lastFire = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = 0;
  };
  const fireOnce = () => {
    // Some touch browsers send contextmenu as well as our long-press; toggle only once.
    if (Date.now() - lastFire < 800) return;
    lastFire = Date.now();
    fire();
  };
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (start) suppressClick = true; // touch-generated: the lift must not select
    cancel();
    fireOnce();
  });
  btn.addEventListener('pointerdown', (e) => {
    suppressClick = false;
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = 0;
      suppressClick = true;
      fireOnce();
    }, LONG_PRESS_MS);
  });
  btn.addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    btn.addEventListener(ev, () => {
      cancel();
      start = null;
    });
  }
  // The click that ends a long-press (or follows a right-click) must not select the option.
  return {
    consumeClick() {
      const s = suppressClick;
      suppressClick = false;
      return s;
    },
  };
}

/**
 * Render answer options.
 * @param {object} q question
 * @param {object} item session item ({order, chosen, struck})
 * @param {{reveal: boolean, interactive: boolean, onSelect?: (original:number)=>void, onStrike?: (original:number)=>void}} o
 *   With `onStrike`, each option gets a strike toggle button, plus right-click / long-press.
 *   Without it, strikes are shown read-only.
 */
export function renderOptions(q, item, { reveal, interactive, onSelect, onStrike }) {
  const list = el('ol', { class: ['options', reveal && 'revealed'], attrs: { role: 'list' } });
  item.order.forEach((orig, d) => {
    const opt = q.options[orig];
    const isCorrect = orig === q.answer;
    const isChosen = item.chosen === orig;
    const struck = isStruck(item, orig);
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
      el('span', { class: 'sr-only opt-note', dataset: { base: srNote }, text: srNote + (struck ? STRUCK_NOTE : '') }),
    ];
    const cls = ['option', state, struck && 'struck'];
    let gestures = null;
    const body = interactive
      ? el(
          'button',
          {
            class: cls,
            type: 'button',
            dataset: { display: String(d) },
            attrs: { 'aria-pressed': String(isChosen), 'aria-label': null },
            on: {
              click: () => {
                if (gestures && gestures.consumeClick()) return;
                if (onSelect) onSelect(orig);
              },
            },
          },
          el('span', { class: 'sr-only', text: `Option ${LETTERS[d]}: ` }),
          content
        )
      : el('div', { class: [...cls, 'static'] }, el('span', { class: 'sr-only', text: `Option ${LETTERS[d]}: ` }), content);
    let strikeBtn = null;
    if (onStrike) {
      if (interactive) gestures = bindStrikeGestures(body, () => onStrike(orig));
      strikeBtn = el(
        'button',
        {
          class: 'strike-btn',
          type: 'button',
          title: `Strike out ${LETTERS[d]} (Shift+${LETTERS[d]}, right-click or long-press)`,
          dataset: { display: String(d) },
          attrs: { 'aria-pressed': String(struck), 'aria-label': `Strike out option ${LETTERS[d]}` },
          on: {
            click: () => onStrike(orig),
            contextmenu: (e) => e.preventDefault(),
          },
        },
        el('span', { class: 'strike-icon', attrs: { 'aria-hidden': 'true' }, text: 'abc' })
      );
    }
    const li = el('li', { class: 'option-item', dataset: { original: String(orig) } }, el('div', { class: 'option-row' }, body, strikeBtn));
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

/**
 * Sync strike state of an already-rendered options list with `item.struck`, in place,
 * so focus and an in-progress touch stay on the same elements.
 */
export function updateStrikes(list, item) {
  for (const li of list.querySelectorAll('li.option-item')) {
    const struck = isStruck(item, Number(li.dataset.original));
    li.querySelector('.option')?.classList.toggle('struck', struck);
    li.querySelector('.strike-btn')?.setAttribute('aria-pressed', String(struck));
    const note = li.querySelector('.opt-note');
    if (note) note.textContent = note.dataset.base + (struck ? STRUCK_NOTE : '');
  }
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
    renderStem(q),
    renderImage(q, number),
    item.chosen === null ? el('p', { class: 'unanswered-note', text: 'You did not answer this question.' }) : null,
    renderOptions(q, item, { reveal: true, interactive: false }),
    renderReveal(q)
  );
}
