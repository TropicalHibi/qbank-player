// Quiz view. Tutor: picking an option makes it pending; Submit answer (or Enter) locks it
// and reveals feedback; navigator allows jumping to answered questions (read-only) but
// not ahead. Exam: no feedback, free navigation,
// answers changeable until Submit; optional block countdown.
// Both modes: options can be struck out (button, right-click, long-press, Shift+key);
// strikes are stored as original indexes in `item.struck` and never affect scoring.

import { el, setChildren, showModal, announce, isDialogOpen, toast } from './dom.js';
import { renderStem, renderImage, renderOptions, renderReveal, updateStrikes } from './render.js';
import { indexById, answeredCount, toggleStrike, clearStrike } from './session.js';
import { formatClock, LETTERS } from './util.js';

const TICK_MS = 500;
const SAVE_EVERY_MS = 5000;
const MAX_TICK_GAP_MS = 5000; // ignore gaps from sleep/suspend

export function startQuiz(root, { set, session, persist, onFinish, onExit }) {
  const byId = indexById(set);
  const items = session.items;
  const N = items.length;
  const exam = session.mode === 'exam';
  const timed = exam && session.timerSec > 0;

  let destroyed = false;
  let paused = document.hidden;
  let lastTick = performance.now();
  let lastSave = Date.now();

  const frontier = () => {
    const i = items.findIndex((it) => it.chosen === null);
    return i === -1 ? N - 1 : i;
  };
  const canVisit = (i) => i >= 0 && i < N && (exam || items[i].chosen !== null || i === frontier());

  let idx = Math.min(Math.max(0, session.current | 0), N - 1);
  if (!canVisit(idx)) idx = frontier();

  /* ----- skeleton ----- */
  const qCount = el('span', { class: 'q-count', attrs: { 'aria-hidden': 'true' } });
  const timerTotal = el('span', { class: 'timer', attrs: { role: 'timer' } });
  const timerQ = el('span', { class: 'timer' });
  const exitBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'Save & exit', on: { click: exitQuiz } });
  const endBtn = el('button', { class: 'btn btn-sm', type: 'button', text: exam ? 'Submit…' : 'End session…', on: { click: exam ? confirmSubmit : confirmEnd } });
  const bar = el(
    'div',
    { class: 'quiz-bar' },
    qCount,
    el('span', { class: 'badge mode-badge', text: exam ? 'Exam' : 'Tutor' }),
    timerTotal,
    timerQ,
    el('span', { class: 'spacer' }),
    exitBtn,
    endBtn
  );
  const progressFill = el('div');
  const progress = el('div', { class: 'progress', attrs: { 'aria-hidden': 'true' } }, progressFill);
  const navSummary = el('summary');
  const navGrid = el('div', { class: 'nav-grid', attrs: { role: 'group', 'aria-label': 'Question navigator' } });
  const nav = el('details', { class: 'navigator', open: N <= 40 }, navSummary, navGrid);
  const card = el('article', { class: 'question-card', attrs: { 'aria-live': 'off' } });
  const feedbackLive = el('div', { class: 'sr-only', attrs: { 'aria-live': 'assertive', 'aria-atomic': 'true' } });
  const prevBtn = el('button', { class: 'btn', type: 'button', text: '← Previous', on: { click: () => go(idx - 1) } });
  const flagBtn = el('button', { class: 'btn flag-btn', type: 'button', on: { click: toggleFlag } });
  const submitBtn = exam ? null : el('button', { class: 'btn btn-primary submit-answer', type: 'button', text: 'Submit answer', on: { click: submitAnswer } });
  const nextBtn = el('button', { class: 'btn btn-primary', type: 'button', on: { click: next } });
  const footer = el('div', { class: 'quiz-footer' }, prevBtn, flagBtn, el('span', { class: 'spacer' }), submitBtn, nextBtn);
  const help = el(
    'p',
    { class: 'kbd-help' },
    'Keys: ',
    el('kbd', { text: 'A' }),
    '–',
    el('kbd', { text: 'H' }),
    ' or ',
    el('kbd', { text: '1' }),
    '–',
    el('kbd', { text: '8' }),
    ' select (use ',
    el('kbd', { text: '6' }),
    ' for F) · ',
    el('kbd', { text: 'Shift' }),
    '+letter/number, right-click or long-press strike out · ',
    el('kbd', { text: 'Enter' }),
    exam ? ' next/submit · ' : ' submit answer, then next · ',
    el('kbd', { text: 'F' }),
    ' flag · ',
    el('kbd', { text: '←' }),
    el('kbd', { text: '→' }),
    ' move · ',
    el('kbd', { text: 'Esc' }),
    ' close'
  );
  root.replaceChildren(bar, progress, nav, card, feedbackLive, footer, help);

  /* ----- rendering ----- */
  function render({ focus = 'none' } = {}) {
    const it = items[idx];
    const q = byId.get(it.id);
    const answered = it.chosen !== null;
    const reveal = !exam && answered;
    session.current = idx;

    qCount.textContent = `Question ${idx + 1} / ${N}`;
    const heading = el('h2', { attrs: { tabindex: '-1' }, text: `Question ${idx + 1} of ${N}${reveal ? ' (answered)' : ''}` });
    // Strikes are editable until the answer is locked (tutor reveal); then shown read-only.
    const options = renderOptions(q, it, { reveal, interactive: true, onSelect: select, onStrike: reveal ? null : strike });
    if (reveal) options.querySelectorAll('button.option').forEach((b) => b.setAttribute('aria-disabled', 'true'));
    let feedback = null;
    if (reveal) {
      const ok = it.chosen === q.answer;
      feedback = el('p', {
        class: ['feedback', ok ? 'correct' : 'incorrect'],
        text: ok ? '✓ Correct' : `✕ Incorrect. The correct answer is ${LETTERS[it.order.indexOf(q.answer)]}.`,
      });
    }
    setChildren(card, heading, renderStem(q), renderImage(q, idx + 1), options, feedback, ...(reveal ? renderReveal(q) : []));

    flagBtn.setAttribute('aria-pressed', String(!!it.flagged));
    flagBtn.textContent = it.flagged ? '⚑ Flagged' : '⚐ Flag';
    prevBtn.disabled = !canVisit(idx - 1);
    if (exam) {
      nextBtn.textContent = idx === N - 1 ? 'Review & submit' : 'Next →';
      nextBtn.disabled = false;
    } else {
      nextBtn.textContent = idx === N - 1 ? 'Finish' : 'Next →';
      nextBtn.disabled = !answered;
      nextBtn.hidden = !answered;
      submitBtn.hidden = answered;
      submitBtn.disabled = it.pending === null;
    }
    progressFill.style.width = `${(answeredCount(session) / N) * 100}%`;
    renderNav();
    updateTimers();

    if (focus === 'heading') {
      heading.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }

  function renderNav() {
    const answered = answeredCount(session);
    const flagged = items.filter((i) => i.flagged).length;
    navSummary.textContent = `Navigator · ${answered}/${N} answered${flagged ? ` · ${flagged} flagged` : ''}`;
    navGrid.replaceChildren(
      ...items.map((it, i) => {
        const q = byId.get(it.id);
        const ans = it.chosen !== null;
        const cls = ['nav-cell'];
        let mini = '';
        let status = 'unanswered';
        if (ans && exam) {
          cls.push('answered');
          status = 'answered';
        } else if (ans) {
          const ok = it.chosen === q.answer;
          cls.push(ok ? 'is-correct' : 'is-incorrect');
          mini = ok ? '✓' : '✕';
          status = ok ? 'correct' : 'incorrect';
        }
        if (i === idx) cls.push('current');
        const visitable = canVisit(i);
        return el(
          'button',
          {
            class: cls,
            type: 'button',
            disabled: !visitable,
            title: !visitable ? 'Answer the current question first' : null,
            attrs: {
              'aria-label': [`Question ${i + 1}`, status, it.flagged && 'flagged', !visitable && 'locked'].filter(Boolean).join(', '),
              'aria-current': i === idx ? 'step' : null,
            },
            on: { click: () => go(i) },
          },
          String(i + 1),
          it.flagged ? el('span', { class: 'flag-dot', attrs: { 'aria-hidden': 'true' }, text: '⚑' }) : null,
          mini ? el('span', { class: 'mini', attrs: { 'aria-hidden': 'true' }, text: mini }) : null
        );
      })
    );
  }

  function updateTimers() {
    if (timed) {
      const rem = N * session.timerSec * 1000 - session.elapsedMs;
      timerTotal.textContent = `⏱ ${formatClock(Math.max(0, rem))} left`;
      timerTotal.classList.toggle('over', rem < 60000);
      const qrem = session.timerSec * 1000 - items[idx].timeMs;
      timerQ.hidden = false;
      timerQ.textContent = qrem >= 0 ? `· this question ${formatClock(qrem)}` : `· this question +${formatClock(-qrem)} over`;
      timerQ.classList.toggle('over', qrem < 0);
    } else {
      timerTotal.textContent = `⏱ ${formatClock(session.elapsedMs)}`;
      timerQ.hidden = true;
    }
  }

  /* ----- time ----- */
  function accrue() {
    const now = performance.now();
    const d = now - lastTick;
    lastTick = now;
    if (paused || session.finished || destroyed || d > MAX_TICK_GAP_MS) return;
    session.elapsedMs += d;
    const it = items[idx];
    if (exam || it.chosen === null) it.timeMs += d;
  }

  function save() {
    lastSave = Date.now();
    persist();
  }

  function tick() {
    accrue();
    updateTimers();
    if (timed && N * session.timerSec * 1000 - session.elapsedMs <= 0) {
      timeUp();
      return;
    }
    if (Date.now() - lastSave > SAVE_EVERY_MS) save();
  }

  function onVisibility() {
    if (document.hidden) {
      accrue();
      paused = true;
      save();
    } else {
      paused = false;
      lastTick = performance.now();
    }
  }
  function onPageHide() {
    accrue();
    save();
  }

  /* ----- actions ----- */
  function go(i, focus = 'heading') {
    if (!canVisit(i) || i === idx) return;
    accrue();
    idx = i;
    render({ focus });
    save();
  }

  function focusOption(d) {
    card.querySelector(`button.option[data-display="${d}"]`)?.focus({ preventScroll: true });
  }

  function select(original) {
    const it = items[idx];
    const d = it.order.indexOf(original);
    if (exam) {
      accrue();
      it.chosen = original;
      clearStrike(it, original); // selecting a struck option un-strikes it
      render();
      announce(`Selected ${LETTERS[d]}.`);
    } else {
      if (it.chosen !== null) return; // locked in tutor mode
      it.pending = original; // not an answer until submitted
      clearStrike(it, original); // picking a struck option un-strikes it
      render();
      announce(`${LETTERS[d]} selected, press Enter to submit.`);
    }
    focusOption(d);
    save();
  }

  /** Tutor mode: lock in the pending choice and reveal feedback. */
  function submitAnswer() {
    const it = items[idx];
    if (it.chosen !== null) return;
    if (it.pending === null) {
      announce('Choose an answer first.');
      toast('Choose an answer first');
      return;
    }
    accrue(); // timeMs stops accruing once chosen is set
    it.chosen = it.pending;
    it.pending = null;
    const q = byId.get(it.id);
    render();
    const ok = it.chosen === q.answer;
    feedbackLive.textContent = ok ? 'Correct.' : `Incorrect. The correct answer is ${LETTERS[it.order.indexOf(q.answer)]}.`;
    focusOption(it.order.indexOf(it.chosen));
    save();
  }

  function strike(original) {
    const it = items[idx];
    if (!exam && it.chosen !== null) return; // locked in tutor mode
    const list = card.querySelector('.options');
    if (!list) return;
    const on = toggleStrike(it, original);
    updateStrikes(list, it);
    announce(`Option ${LETTERS[it.order.indexOf(original)]} ${on ? 'struck out' : 'restored'}.`);
    save();
  }

  function toggleFlag() {
    const it = items[idx];
    it.flagged = !it.flagged;
    render();
    announce(it.flagged ? `Question ${idx + 1} flagged.` : `Question ${idx + 1} unflagged.`);
    save();
  }

  function next() {
    if (exam) {
      if (idx < N - 1) go(idx + 1);
      else confirmSubmit();
      return;
    }
    if (items[idx].chosen === null) {
      submitAnswer(); // submits the pending choice, or asks for one
      return;
    }
    if (idx < N - 1) go(idx + 1);
    else finish();
  }

  async function confirmSubmit() {
    const answered = answeredCount(session);
    const flagged = items.filter((i) => i.flagged).length;
    const un = N - answered;
    const body = el(
      'div',
      {},
      el('p', { text: `You have answered ${answered} of ${N} question${N === 1 ? '' : 's'}.` }),
      un ? el('p', { text: `${un} unanswered question${un === 1 ? '' : 's'} will be marked incorrect.` }) : null,
      flagged ? el('p', { text: `${flagged} question${flagged === 1 ? ' is' : 's are'} flagged for review.` }) : null,
      el('p', { text: 'You cannot change answers after submitting.' })
    );
    const ok = await showModal({
      title: 'Submit exam?',
      body,
      actions: [
        { label: 'Keep working', value: false },
        { label: 'Submit', value: true, variant: 'primary' },
      ],
      dismissValue: false,
    });
    if (ok && !destroyed) finish();
  }

  async function confirmEnd() {
    const un = N - answeredCount(session);
    if (!un) return finish();
    const ok = await showModal({
      title: 'End session now?',
      body: `${un} unanswered question${un === 1 ? '' : 's'} will count as incorrect.`,
      actions: [
        { label: 'Keep going', value: false },
        { label: 'End and see results', value: true, variant: 'primary' },
      ],
      dismissValue: false,
    });
    if (ok && !destroyed) finish();
  }

  function finish() {
    if (session.finished) return;
    accrue();
    session.finished = true;
    session.finishedAt = Date.now();
    save();
    onFinish();
  }

  function timeUp() {
    // Close any open confirm dialog first so it can't act on a finished session.
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    session.elapsedMs = N * session.timerSec * 1000;
    finish();
    showModal({ title: "Time's up", body: 'Your exam was submitted automatically.' });
  }

  function exitQuiz() {
    accrue();
    save();
    onExit();
  }

  /* ----- keyboard ----- */
  function onKey(e) {
    if (destroyed || root.hidden || isDialogOpen()) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const k = e.key;
    if (!e.shiftKey && (k === 'f' || k === 'F')) {
      e.preventDefault();
      toggleFlag();
      return;
    }
    let d = -1;
    if (e.shiftKey) {
      // Shift+digit gives layout-dependent symbols in e.key, so read the physical key.
      const m = /^(?:Digit|Numpad)([1-8])$/.exec(e.code || '');
      if (m) d = +m[1] - 1;
      else if (/^[a-hA-H]$/.test(k)) d = LETTERS.indexOf(k.toUpperCase());
    } else if (/^[1-8]$/.test(k)) d = +k - 1;
    else if (/^[a-hA-H]$/.test(k)) d = LETTERS.indexOf(k.toUpperCase());
    if (d >= 0) {
      const it = items[idx];
      if (d < it.order.length) {
        e.preventDefault();
        if (e.shiftKey) strike(it.order[d]);
        else select(it.order[d]);
      }
      return;
    }
    if (k === 'Enter') {
      // Let Enter activate other focused controls (nav cells, buttons, links, summary) natively.
      if (t && t.closest && t.closest('a, summary, button:not(.option)')) return;
      e.preventDefault();
      next();
      return;
    }
    if (k === 'ArrowRight') {
      e.preventDefault();
      go(idx + 1);
    } else if (k === 'ArrowLeft') {
      e.preventDefault();
      go(idx - 1);
    }
  }

  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  const timer = setInterval(tick, TICK_MS);

  render({ focus: 'heading' });

  return {
    destroy() {
      if (destroyed) return;
      accrue();
      destroyed = true;
      clearInterval(timer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    },
  };
}
