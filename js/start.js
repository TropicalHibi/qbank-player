// Start screen: set info, resume, mode, timer, shuffles, tag filter, "missed last session", count.
// Never reveals which tags belong to which question; only tag names and counts.

import { el, setChildren, nextId, showModal } from './dom.js';
import { collectTags, poolIds, answeredCount } from './session.js';
import { formatDuration, relativeTime } from './util.js';

const DEFAULT_TIMER = 90;

export function renderStart(root, { set, warnings, progress, lastResult, prefs, onStart, onResume, onDiscard, onLibrary }) {
  const tags = collectTags(set);
  const ids = new Set(set.questions.map((q) => q.id));
  const lastMissed = lastResult && Array.isArray(lastResult.missedIds) ? lastResult.missedIds.filter((id) => ids.has(id)) : null;

  const st = {
    mode: prefs.mode === 'exam' ? 'exam' : 'tutor',
    timed: !!prefs.timed,
    timerSec: clampTimer(prefs.timerSec ?? DEFAULT_TIMER),
    shuffleQuestions: prefs.shuffleQuestions ?? true,
    shuffleOptions: prefs.shuffleOptions ?? true,
    askConfidence: prefs.askConfidence ?? true,
    selected: new Set(tags.map((t) => t.tag)),
    missedOnly: false,
    count: 0,
    countTouched: false,
  };

  /* ----- head ----- */
  const head = el(
    'header',
    { class: 'start-head' },
    el('h1', { id: 'start-title', attrs: { tabindex: '-1' }, text: set.title }),
    set.description ? el('p', { class: 'desc', text: set.description }) : null,
    el('p', { class: 'muted', text: `${set.questions.length} question${set.questions.length === 1 ? '' : 's'}${tags.length ? ` · ${tags.length} tag${tags.length === 1 ? '' : 's'}` : ''}` })
  );

  const warnBox =
    warnings && warnings.length
      ? el(
          'div',
          { class: 'notice notice-warn' },
          el('details', {}, el('summary', { text: `Loaded with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` }), el('ul', {}, warnings.map((w) => el('li', { text: w }))))
        )
      : null;

  /* ----- resume ----- */
  const resumeCard = progress
    ? el(
        'div',
        { class: 'notice notice-info resume-card' },
        el('h2', { text: 'Unfinished session' }),
        el('p', {
          text: `${progress.mode === 'exam' ? 'Exam' : 'Tutor'} mode${progress.label ? ` (${progress.label})` : ''}: ${answeredCount(progress)} of ${progress.items.length} answered, started ${relativeTime(progress.createdAt)}.`,
        }),
        el(
          'div',
          { class: 'btn-row' },
          el('button', { class: 'btn btn-primary', type: 'button', text: 'Resume', on: { click: onResume } }),
          el('button', {
            class: 'btn btn-danger',
            type: 'button',
            text: 'Discard',
            on: {
              click: async () => {
                const ok = await showModal({
                  title: 'Discard progress?',
                  body: 'Your answers in the unfinished session will be deleted.',
                  actions: [
                    { label: 'Cancel', value: false },
                    { label: 'Discard', value: true, variant: 'primary' },
                  ],
                  dismissValue: false,
                });
                if (ok) onDiscard();
              },
            },
          })
        )
      )
    : null;

  /* ----- mode ----- */
  const modeHelp = el('p', { class: 'hint mode-help' });
  const modeRadios = ['tutor', 'exam'].map((m) =>
    el('input', {
      type: 'radio',
      name: 'mode',
      value: m,
      checked: st.mode === m,
      on: {
        change: () => {
          st.mode = m;
          update();
        },
      },
    })
  );
  const modeField = el(
    'fieldset',
    {},
    el('legend', { text: 'Mode' }),
    el('div', { class: 'segmented' }, el('label', {}, modeRadios[0], 'Tutor'), el('label', {}, modeRadios[1], 'Exam')),
    modeHelp
  );

  /* ----- exam timer ----- */
  const timerId = nextId('timer');
  const timedBox = el('input', {
    type: 'checkbox',
    checked: st.timed,
    on: {
      change: (e) => {
        st.timed = e.target.checked;
        update();
      },
    },
  });
  const timerInput = el('input', {
    type: 'number',
    id: timerId,
    class: 'inline-input',
    value: String(st.timerSec),
    attrs: { min: 10, max: 600, step: 5, inputmode: 'numeric' },
    on: {
      input: (e) => {
        st.timerSec = clampTimer(e.target.value);
        update();
      },
      change: (e) => (e.target.value = String(st.timerSec)),
    },
  });
  const timerTotal = el('p', { class: 'hint' });
  const timerRow = el('div', { class: 'check-row' }, el('label', { htmlFor: timerId, text: 'Seconds per question' }), timerInput);
  const examField = el(
    'fieldset',
    {},
    el('legend', { text: 'Exam timer' }),
    el('label', { class: 'check-row' }, timedBox, 'Timed (countdown for the whole block)'),
    timerRow,
    timerTotal
  );

  /* ----- shuffles ----- */
  const shuffleField = el(
    'fieldset',
    {},
    el('legend', { text: 'Order' }),
    el(
      'label',
      { class: 'check-row' },
      el('input', { type: 'checkbox', checked: st.shuffleQuestions, on: { change: (e) => ((st.shuffleQuestions = e.target.checked), update()) } }),
      'Shuffle questions'
    ),
    el(
      'label',
      { class: 'check-row' },
      el('input', { type: 'checkbox', checked: st.shuffleOptions, on: { change: (e) => (st.shuffleOptions = e.target.checked) } }),
      'Shuffle answer options'
    )
  );

  /* ----- confidence ----- */
  const confidenceField = el(
    'fieldset',
    {},
    el('legend', { text: 'Confidence' }),
    el(
      'label',
      { class: 'check-row' },
      el('input', { type: 'checkbox', name: 'ask-confidence', checked: st.askConfidence, on: { change: (e) => (st.askConfidence = e.target.checked) } }),
      'Ask for confidence'
    ),
    el('p', { class: 'hint', text: 'Rate each answer Low, Medium or High (optional). Ratings are saved with your results and never change your score.' })
  );

  /* ----- tags ----- */
  const chipEls = tags.map((t) =>
    el(
      'button',
      {
        class: 'chip',
        type: 'button',
        attrs: { 'aria-pressed': 'true' },
        on: {
          click: () => {
            if (st.selected.has(t.tag)) st.selected.delete(t.tag);
            else st.selected.add(t.tag);
            update();
          },
        },
      },
      t.tag,
      el('span', { class: 'count', text: `(${t.count})` })
    )
  );
  const missedChip =
    lastMissed !== null
      ? el(
          'button',
          {
            class: 'chip chip-special',
            type: 'button',
            disabled: lastMissed.length === 0,
            attrs: { 'aria-pressed': 'false' },
            on: {
              click: () => {
                st.missedOnly = !st.missedOnly;
                update();
              },
            },
          },
          'Missed last session',
          el('span', { class: 'count', text: `(${lastMissed.length})` })
        )
      : null;
  const tagField = el(
    'fieldset',
    {},
    el('legend', { text: 'Questions' }),
    missedChip
      ? el(
          'div',
          { class: 'field' },
          el('div', { class: 'chips' }, missedChip),
          el('p', { class: 'hint', text: `Only questions you missed or skipped in your last session${lastResult.at ? ` (${relativeTime(lastResult.at)}, ${lastResult.score}/${lastResult.total})` : ''}.` })
        )
      : null,
    tags.length
      ? [
          el(
            'div',
            { class: 'chip-tools' },
            el('span', { class: 'field-label', text: 'Tags' }),
            el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'All', on: { click: () => (tags.forEach((t) => st.selected.add(t.tag)), update()) } }),
            el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'None', on: { click: () => (st.selected.clear(), update()) } })
          ),
          el('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'Filter by tag' } }, chipEls),
        ]
      : el('p', { class: 'hint', text: 'This set has no tags.' })
  );

  /* ----- count ----- */
  const countId = nextId('count');
  const range = el('input', {
    type: 'range',
    id: countId,
    attrs: { min: 1, step: 1 },
    on: {
      input: (e) => {
        st.count = +e.target.value;
        st.countTouched = true;
        update();
      },
    },
  });
  const countOut = el('output', { htmlFor: countId });
  const countField = el('div', { class: 'field' }, el('label', { htmlFor: countId, text: 'Number of questions' }), el('div', { class: 'count-row' }, range, countOut));

  /* ----- actions ----- */
  const startBtn = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Start' });
  const form = el(
    'form',
    {
      class: 'card',
      attrs: { 'aria-label': 'Session settings' },
      on: {
        submit: (e) => {
          e.preventDefault();
          const pool = currentPool();
          if (!pool.length) return;
          const opts = {
            mode: st.mode,
            shuffleQuestions: st.shuffleQuestions,
            shuffleOptions: st.shuffleOptions,
            ids: pool,
            count: st.count,
            timerSec: st.mode === 'exam' && st.timed ? st.timerSec : 0,
            label: st.missedOnly ? 'Missed last session' : '',
            askConfidence: st.askConfidence,
          };
          onStart(opts, {
            mode: st.mode,
            timed: st.timed,
            timerSec: st.timerSec,
            shuffleQuestions: st.shuffleQuestions,
            shuffleOptions: st.shuffleOptions,
            askConfidence: st.askConfidence,
          });
        },
      },
    },
    modeField,
    examField,
    shuffleField,
    confidenceField,
    tagField,
    countField,
    el('div', { class: 'btn-row start-actions' }, startBtn, el('button', { class: 'btn btn-ghost', type: 'button', text: '← Load a different set', on: { click: onLibrary } }))
  );

  setChildren(root, head, warnBox, resumeCard, el('div', { class: 'start-grid' }, form));

  function currentPool() {
    const all = st.selected.size === tags.length;
    return poolIds(set, { tags: all ? null : [...st.selected], restrictIds: st.missedOnly ? lastMissed : null });
  }

  function update() {
    modeHelp.textContent =
      st.mode === 'tutor'
        ? 'See whether you were right, with explanations for every option, right after each question.'
        : 'No feedback until you submit. Move freely between questions and change answers until then.';
    examField.hidden = st.mode !== 'exam';
    timerRow.hidden = !st.timed;
    chipEls.forEach((c, i) => c.setAttribute('aria-pressed', String(st.selected.has(tags[i].tag))));
    if (missedChip) missedChip.setAttribute('aria-pressed', String(st.missedOnly));

    const max = currentPool().length;
    if (!st.countTouched || st.count > max || st.count < 1) st.count = max;
    range.max = String(Math.max(1, max));
    range.value = String(Math.max(1, st.count));
    range.disabled = max <= 1;
    countOut.textContent = max ? `${st.count} of ${max}` : 'None match';
    startBtn.disabled = max === 0;
    timerTotal.textContent = st.timed ? `Total time: ${formatDuration(st.count * st.timerSec * 1000)} for ${st.count} question${st.count === 1 ? '' : 's'}.` : 'Untimed: elapsed time is still recorded.';
  }
  update();
}

function clampTimer(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_TIMER;
  return Math.min(600, Math.max(10, n));
}
