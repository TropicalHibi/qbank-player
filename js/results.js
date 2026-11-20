// Results view: score, timing, per-tag breakdown, review list, redo/retake, export, Claude summary.

import { el, setChildren, downloadText, copyWithFeedback } from './dom.js';
import { renderReviewBody } from './render.js';
import { scoreSession, buildExport, resultsFilename, buildClaudeSummary, indexById, letterFor } from './session.js';
import { formatDuration, truncate, stripMarkdown } from './util.js';

const pct = (x) => `${Math.round(x * 100)}%`;

export function renderResults(root, { set, session, onRedo, onRetake, onLibrary }) {
  const r = scoreSession(set, session);
  const byId = indexById(set);

  const head = el(
    'header',
    {},
    el('h1', { id: 'results-title', attrs: { tabindex: '-1' }, text: 'Results' }),
    el('p', { class: 'muted', text: [set.title, session.mode === 'exam' ? 'Exam mode' : 'Tutor mode', session.label].filter(Boolean).join(' · ') })
  );

  const stat = (label, value) => el('div', { class: 'stat' }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }));
  const stats = el(
    'div',
    { class: 'stats' },
    stat('Score', `${r.score} / ${r.total}`),
    stat('Percentage', pct(r.pct)),
    stat('Total time', formatDuration(r.totalMs)),
    stat('Avg / question', formatDuration(r.avgMs))
  );

  /* ----- actions ----- */
  const exportBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Export results (JSON)',
    on: {
      click: () => {
        const when = new Date(session.finishedAt || Date.now());
        downloadText(resultsFilename(set.title, when), JSON.stringify(buildExport(set, session, when), null, 2) + '\n');
      },
    },
  });
  const copyBtn = el('button', { class: 'btn', type: 'button', text: 'Copy summary for Claude' });
  copyBtn.addEventListener('click', () => copyWithFeedback(copyBtn, buildClaudeSummary(set, session), 'Copy summary for Claude'));

  const actions = el(
    'div',
    { class: 'btn-row results-actions' },
    el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: `Redo missed (${r.missedIds.length})`,
      disabled: !r.missedIds.length,
      on: { click: () => onRedo(r.missedIds, 'Redo missed') },
    }),
    el('button', {
      class: 'btn',
      type: 'button',
      text: `Redo flagged (${r.flaggedIds.length})`,
      disabled: !r.flaggedIds.length,
      on: { click: () => onRedo(r.flaggedIds, 'Redo flagged') },
    }),
    el('button', { class: 'btn', type: 'button', text: 'Retake all (reshuffled)', on: { click: onRetake } }),
    exportBtn,
    copyBtn,
    el('button', { class: 'btn btn-ghost', type: 'button', text: '← Back to library', on: { click: onLibrary } })
  );

  /* ----- by tag ----- */
  const tagSection = r.byTag.length
    ? el(
        'section',
        { attrs: { 'aria-labelledby': 'bytag-title' } },
        el('h2', { id: 'bytag-title', text: 'By tag (weakest first)' }),
        el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            { class: 'tag-table' },
            el('thead', {}, el('tr', {}, el('th', { text: 'Tag' }), el('th', { text: 'Correct' }), el('th', { text: '%' }), el('th', { attrs: { 'aria-hidden': 'true' } }))),
            el(
              'tbody',
              {},
              r.byTag.map((t) =>
                el(
                  'tr',
                  {},
                  el('td', { text: t.tag }),
                  el('td', { class: 'num', text: `${t.correct}/${t.total}` }),
                  el('td', { class: 'num', text: pct(t.pct) }),
                  el('td', { attrs: { 'aria-hidden': 'true' } }, el('div', { class: 'bar' }, el('div', { attrs: { style: `width:${Math.round(t.pct * 100)}%` } })))
                )
              )
            )
          )
        )
      )
    : null;

  /* ----- review ----- */
  const reviewItems = session.items.map((it, i) => {
    const q = byId.get(it.id);
    const resp = r.responses[i];
    const status = it.chosen === null ? 'unanswered' : resp.correct ? 'correct' : 'incorrect';
    const det = el(
      'details',
      { class: ['review-item', resp.correct ? 'is-correct' : 'is-incorrect'], dataset: { missed: String(!resp.correct), flagged: String(!!it.flagged) } },
      el(
        'summary',
        {},
        el('span', { class: 'r-num', text: `${i + 1}.` }),
        el('span', { class: 'r-mark', attrs: { 'aria-hidden': 'true' }, text: status === 'correct' ? '✓' : status === 'incorrect' ? '✕' : '–' }),
        el('span', { class: 'sr-only', text: `${status}. ` }),
        el('span', { class: 'r-snippet', text: truncate(stripMarkdown(q.stem), 160) }),
        el(
          'span',
          { class: 'r-answers' },
          el('span', { class: 'r-you', text: `You: ${letterFor(it, it.chosen)}` }),
          ' · ',
          el('span', { class: 'r-correct', text: `Correct: ${letterFor(it, q.answer)}` })
        ),
        it.flagged ? el('span', { class: 'r-flag', attrs: { 'aria-label': 'flagged' }, text: '⚑' }) : null
      )
    );
    det.addEventListener('toggle', () => {
      if (det.open && !det.dataset.rendered) {
        det.append(renderReviewBody(q, it, i + 1));
        det.dataset.rendered = '1';
      }
    });
    return det;
  });
  const list = el('ul', { class: 'review-list' }, reviewItems.map((d) => el('li', {}, d)));
  const emptyMsg = el('p', { class: 'empty', hidden: true });

  const counts = { all: reviewItems.length, missed: r.missedIds.length, flagged: r.flaggedIds.length };
  const filterBtns = {};
  let filter = 'all';
  const applyFilter = (f) => {
    filter = f;
    for (const [k, b] of Object.entries(filterBtns)) b.setAttribute('aria-pressed', String(k === f));
    let shown = 0;
    reviewItems.forEach((d) => {
      const vis = f === 'all' || (f === 'missed' && d.dataset.missed === 'true') || (f === 'flagged' && d.dataset.flagged === 'true');
      d.parentElement.hidden = !vis;
      if (vis) shown++;
    });
    emptyMsg.hidden = shown > 0;
    emptyMsg.textContent = f === 'missed' ? 'No missed questions. Nice work!' : 'No flagged questions.';
  };
  for (const [k, label] of [
    ['all', 'All'],
    ['missed', 'Missed'],
    ['flagged', 'Flagged'],
  ]) {
    filterBtns[k] = el('button', { class: 'chip', type: 'button', attrs: { 'aria-pressed': String(k === filter) }, on: { click: () => applyFilter(k) } }, label, el('span', { class: 'count', text: `(${counts[k]})` }));
  }
  const review = el(
    'section',
    { attrs: { 'aria-labelledby': 'review-title' } },
    el('h2', { id: 'review-title', text: 'Review' }),
    el('div', { class: 'chips review-filter', attrs: { role: 'group', 'aria-label': 'Filter review list' } }, Object.values(filterBtns)),
    list,
    emptyMsg
  );

  setChildren(root, head, stats, actions, tagSection, review);
}
