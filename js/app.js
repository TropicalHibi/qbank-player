// Entry point for index.html: routing between Library → Start → Quiz → Results,
// app state, and the Library view (file/paste/URL loading, bundled + recent sets).

import { $, el, setChildren, showModal, toast, downloadText } from './dom.js';
import { loadSetFromText, loadSetFromUrl, parseJsonText } from './loader.js';
import { backupFilename, looksLikeBackup, summarizeBackup, validateBackup, pluralize } from './backup.js';
import { setKey, isSessionValid, normalizeSession, buildSession, scoreSession } from './session.js';
import * as store from './storage.js';
import { relativeTime } from './util.js';
import { renderStart } from './start.js';
import { startQuiz } from './quiz.js';
import { renderResults } from './results.js';

const views = {
  library: $('#view-library'),
  start: $('#view-start'),
  quiz: $('#view-quiz'),
  results: $('#view-results'),
};

const state = {
  view: null,
  set: null,
  key: null,
  url: null, // set when loaded via ?set=
  warnings: [],
  session: null,
  quiz: null, // active quiz controller
};

/* ---------- helpers ---------- */

/** Encode a set URL for the query string while keeping it readable (/ and : unescaped). */
const encodeSetParam = (url) => encodeURIComponent(url).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
const setHref = (url, resume) => `?set=${encodeSetParam(url)}${resume ? '&resume=1' : ''}`;

function show(name) {
  $('#loading').hidden = true;
  if (state.quiz && name !== 'quiz') {
    state.quiz.destroy();
    state.quiz = null;
  }
  for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
  state.view = name;
  document.title = name === 'library' || !state.set ? 'qbank-player' : `${state.set.title} · qbank-player`;
  window.scrollTo(0, 0);
}

function focusHeading(view) {
  const h = view.querySelector('h1');
  if (h) {
    if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }
}

function showLoading() {
  for (const v of Object.values(views)) v.hidden = true;
  state.view = 'loading';
  $('#loading').hidden = false;
}

function getResumable() {
  if (!state.set) return null;
  const p = store.loadProgress(state.key);
  return p && !p.finished && isSessionValid(state.set, p) ? normalizeSession(state.set, p) : null;
}

/* ---------- library ---------- */

const MAX_SHOWN_ERRORS = 25;

function showLoadErrors(r, sourceLabel, heading = null) {
  const box = $('#load-errors');
  const errs = r.errors || [];
  setChildren(
    box,
    el('h2', { text: heading || `Couldn't load ${sourceLabel ? `"${sourceLabel}"` : 'this set'}` }),
    el(
      'ul',
      {},
      errs.slice(0, MAX_SHOWN_ERRORS).map((e) => el('li', { text: e })),
      errs.length > MAX_SHOWN_ERRORS ? el('li', { text: `…and ${errs.length - MAX_SHOWN_ERRORS} more.` }) : null
    ),
    r.snippet ? el('pre', { text: r.snippet }) : null,
    r.warnings && r.warnings.length
      ? el('details', {}, el('summary', { text: `${r.warnings.length} warning(s)` }), el('ul', {}, r.warnings.map((w) => el('li', { text: w }))))
      : null
  );
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

function clearLoadErrors() {
  const box = $('#load-errors');
  box.hidden = true;
  box.replaceChildren();
}

function showLibrary() {
  state.set = null;
  state.key = null;
  state.url = null;
  show('library');
  renderRecents();
  renderBundled();
  renderDataSection();
  focusHeading(views.library);
}

/* ---------- your data: back up / restore ---------- */

function renderDataSection() {
  const ok = store.storageAvailable();
  $('#backup-btn').disabled = !ok;
  $('#restore-btn').disabled = !ok;
  $('#data-blocked').hidden = ok;
  for (const id of ['#backup-btn', '#restore-btn']) $(id).setAttribute('aria-describedby', ok ? 'data-note' : 'data-note data-blocked');
}

async function backUp() {
  const backup = await store.exportAll();
  const s = summarizeBackup(backup);
  downloadText(backupFilename(), JSON.stringify(backup, null, 2));
  toast(`Backup downloaded: ${pluralize(s.sets, 'set')}, ${pluralize(s.sessions, 'saved session')}.`);
}

/** Text of a file, or null after showing why it couldn't be read. */
async function readFile(file) {
  try {
    return await file.text();
  } catch (e) {
    if (state.view !== 'library') showLibrary();
    showLoadErrors({ errors: [`Could not read "${file.name}": ${e.message}`] }, file.name);
    return null;
  }
}

/** If `text` parses to something claiming to be a backup, return it (else null). */
function asBackup(text) {
  const p = parseJsonText(text);
  return p.errors.length === 0 && looksLikeBackup(p.data) ? p.data : null;
}

/** After a restore, apply the restored theme pref (theme-init.js only reads it at page load). */
function applySavedTheme() {
  const t = store.getJSON('theme');
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  else root.removeAttribute('data-theme');
  const btn = $('#theme-toggle');
  if (!btn) return;
  const dark = (root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const text = dark ? 'Switch to light theme' : 'Switch to dark theme';
  btn.textContent = dark ? '☀︎' : '☾';
  btn.setAttribute('aria-label', text);
  btn.title = text;
}

const restoreHeading =(label) => `Couldn't restore ${label ? `"${label}"` : 'this backup'}`;

/** Restore flow for a parsed backup: validate, summarize, ask merge/replace, import, re-render. */
async function restoreFlow(backup, sourceLabel) {
  if (state.view !== 'library') {
    if (location.search) history.pushState(null, '', location.pathname);
    showLibrary();
  }
  clearLoadErrors();
  const v = validateBackup(backup);
  if (!v.valid) {
    showLoadErrors({ errors: v.errors }, sourceLabel, restoreHeading(sourceLabel));
    return;
  }
  if (!store.storageAvailable()) {
    showLoadErrors({ errors: ['Browser storage is blocked or disabled, so nothing can be restored.'] }, sourceLabel, restoreHeading(sourceLabel));
    return;
  }
  const s = summarizeBackup(backup);
  const facts = [
    ['Created', s.createdAt ? s.createdAt.toLocaleString() : 'unknown date'],
    ['Question sets', String(s.sets)],
    ['Saved sessions', String(s.sessions)],
    ['Recent sets', String(s.recents)],
  ];
  const mode = await showModal({
    title: 'Restore backup?',
    body: [
      el('p', { text: sourceLabel ? `From "${sourceLabel}":` : 'This backup contains:' }),
      el('dl', { class: 'backup-facts' }, facts.map(([k, val]) => [el('dt', { text: k }), el('dd', { text: val })])),
      el('p', { text: 'Merge keeps your current data and adds what is missing; the newer of two saved sessions for the same set wins.' }),
      el('p', { class: 'backup-replace-warn small', text: 'Replace deletes all current progress, results, recent sets and preferences in this browser first. This cannot be undone.' }),
    ],
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Replace current data', value: 'replace', variant: 'danger' },
      { label: 'Merge with current data', value: 'merge', variant: 'primary' },
    ],
    dismissValue: null,
  });
  if (!mode) return;
  const r = await store.importAll(backup, { mode });
  applySavedTheme();
  showLibrary(); // re-renders recents, resume buttons and this section
  if (r.errors.length && !r.restored.keys.length && !r.restored.sets.length) {
    showLoadErrors({ errors: r.errors }, sourceLabel, restoreHeading(sourceLabel));
    return;
  }
  const restoredSessions = r.restored.keys.filter((k) => k.startsWith('qbp:progress:')).length;
  const parts = [`${mode === 'replace' ? 'Replaced data' : 'Merged'}: restored ${pluralize(r.restored.sets.length, 'set')}, ${pluralize(restoredSessions, 'saved session')}`];
  if (r.skipped.length) parts.push(`${pluralize(r.skipped.length, 'item')} skipped (${mode === 'merge' ? 'kept your current copy' : 'not restorable'})`);
  if (r.errors.length) parts.push(`${pluralize(r.errors.length, 'problem')}`);
  toast(parts.join('; ') + '.');
  if (r.errors.length) showLoadErrors({ errors: r.errors }, sourceLabel, 'Some data could not be restored');
}

function renderRecents() {
  const list = store.getRecents();
  $('#recent-section').hidden = list.length === 0;
  $('#recent-list').replaceChildren(
    ...list.map((r) => {
      const prog = store.loadProgress(r.key);
      const inProgress = prog && !prog.finished && Array.isArray(prog.items) && prog.items.length > 0;
      const answered = inProgress ? prog.items.filter((i) => i && i.chosen !== null).length : 0;
      const last = store.loadLastResult(r.key);
      const meta = [
        `${r.count} question${r.count === 1 ? '' : 's'}`,
        r.url ? `from ${r.url}` : 'local file',
        `opened ${relativeTime(r.openedAt)}`,
        last ? `last score ${last.score}/${last.total}` : null,
      ].filter(Boolean);
      const canOpen = !!r.url || r.hasCopy;
      return el(
        'li',
        { class: 'set-item' },
        el(
          'div',
          { class: 'set-info' },
          el('div', { class: 'set-title', text: r.title }, ' ', inProgress ? el('span', { class: 'badge badge-warn', text: `In progress ${answered}/${prog.items.length}` }) : null),
          el('div', { class: 'set-meta', text: meta.join(' · ') })
        ),
        el(
          'div',
          { class: 'btn-row' },
          inProgress && canOpen ? el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Resume', on: { click: () => openRecent(r, true) } }) : null,
          canOpen
            ? el('button', { class: 'btn btn-sm', type: 'button', text: 'Open', attrs: { 'aria-label': `Open ${r.title}` }, on: { click: () => openRecent(r, false) } })
            : el('span', { class: 'muted small', text: 'Reload the file to open' }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            type: 'button',
            text: '✕',
            attrs: { 'aria-label': `Remove ${r.title} from recent` },
            on: { click: () => confirmRemoveRecent(r, inProgress) },
          })
        )
      );
    })
  );
}

async function confirmRemoveRecent(r, inProgress) {
  const ok = await showModal({
    title: 'Remove from recent?',
    body: inProgress ? `"${r.title}" has an unfinished session. Removing it also deletes that progress.` : `"${r.title}" will be removed from this list.`,
    actions: [
      { label: 'Cancel', value: false },
      { label: 'Remove', value: true, variant: 'primary' },
    ],
    dismissValue: false,
  });
  if (!ok) return;
  store.removeRecent(r.key);
  store.clearProgress(r.key);
  renderRecents();
  toast('Removed from recent');
}

async function openRecent(r, resume) {
  if (r.url) {
    location.href = setHref(r.url, resume);
    return;
  }
  showLoading();
  const text = await store.getSetCopy(r.key);
  if (!text) {
    showLibrary();
    showLoadErrors({ errors: ['No saved copy of this set is available in this browser (storage may have been cleared). Load the file again.'] }, r.title);
    return;
  }
  await handleResult(loadSetFromText(text), { sourceLabel: r.title, resume });
}

let bundledCache = null;
async function renderBundled() {
  const ul = $('#bundled-list');
  if (!bundledCache) {
    try {
      const res = await fetch('sets/index.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('index.json is not an array');
      bundledCache = data.filter((m) => m && typeof m.file === 'string');
    } catch (e) {
      ul.replaceChildren(el('li', { class: 'empty', text: `Could not load sets/index.json (${e.message}).` }));
      return;
    }
  }
  if (!bundledCache.length) {
    ul.replaceChildren(el('li', { class: 'empty', text: 'No bundled sets yet.' }));
    return;
  }
  const recents = store.getRecents();
  ul.replaceChildren(
    ...bundledCache.map((m) => {
      const url = `sets/${m.file}`;
      const recent = recents.find((r) => r.url === url);
      const prog = recent && store.loadProgress(recent.key);
      const inProgress = prog && !prog.finished && Array.isArray(prog.items);
      const title = m.title || m.file;
      return el(
        'li',
        { class: 'set-item' },
        el(
          'div',
          { class: 'set-info' },
          el('a', { class: 'set-title', href: setHref(url), text: title }),
          ' ',
          inProgress ? el('span', { class: 'badge badge-warn', text: 'In progress' }) : null,
          el('div', { class: 'set-meta', text: `${Number.isInteger(m.count) ? `${m.count} questions · ` : ''}${url}` })
        ),
        el(
          'div',
          { class: 'btn-row' },
          inProgress ? el('a', { class: 'btn btn-primary btn-sm', href: setHref(url, true), text: 'Resume' }) : null,
          el('a', { class: 'btn btn-sm', href: setHref(url), text: 'Open', attrs: { 'aria-label': `Open ${title}` } })
        )
      );
    })
  );
}

/* ---------- loading ---------- */

async function handleResult(r, { url = null, sourceLabel = '', resume = false } = {}) {
  if (!r.ok) {
    if (state.view !== 'library') showLibrary();
    showLoadErrors(r, sourceLabel);
    return false;
  }
  clearLoadErrors();
  state.set = r.set;
  state.key = setKey(r.set);
  state.url = url;
  state.warnings = r.warnings || [];

  // Keep the address bar meaningful: ?set=<url> for URL sets, bare page for local ones.
  if (url) history.replaceState(null, '', setHref(url));
  else if (location.search) history.pushState(null, '', location.pathname);

  await store.addRecent({ key: state.key, title: r.set.title, version: r.set.version, count: r.set.questions.length, url }, JSON.stringify(r.set));

  const progress = getResumable();
  if (resume && progress) beginQuiz(progress);
  else showStart();
  return true;
}

async function loadFile(file) {
  if (!file) return;
  showLoading();
  const text = await readFile(file);
  if (text == null) return;
  const backup = asBackup(text);
  if (backup) return restoreFlow(backup, file.name);
  await handleResult(loadSetFromText(text), { sourceLabel: file.name });
}

/** "Restore…" picker: anything chosen here is treated as a backup (wrong files get validateBackup() messages). */
async function restoreFile(file) {
  if (!file) return;
  const text = await readFile(file);
  if (text == null) return;
  const p = parseJsonText(text);
  if (p.errors.length) {
    clearLoadErrors();
    showLoadErrors(p, file.name, restoreHeading(file.name));
    return;
  }
  await restoreFlow(p.data, file.name);
}

async function loadUrl(url, resume) {
  showLoading();
  let r = await loadSetFromUrl(url);
  if (!r.ok && /Could not fetch/.test(r.errors[0] || '')) {
    // Offline or moved: fall back to the copy saved when it was last opened.
    const recent = store.getRecents().find((x) => x.url === url && x.hasCopy);
    const text = recent && (await store.getSetCopy(recent.key));
    if (text) {
      const r2 = loadSetFromText(text);
      if (r2.ok) {
        r2.warnings.unshift(`Couldn't fetch ${url}; using the copy saved in this browser.`);
        r = r2;
      }
    }
  }
  await handleResult(r, { url, sourceLabel: url, resume });
}

/* ---------- start / quiz / results ---------- */

function showStart() {
  show('start');
  renderStart(views.start, {
    set: state.set,
    warnings: state.warnings,
    progress: getResumable(),
    lastResult: store.loadLastResult(state.key),
    prefs: store.loadPrefs(),
    onStart: (opts, prefs) => {
      store.savePrefs(prefs);
      beginQuiz(buildSession(state.set, opts));
    },
    onResume: () => {
      const p = getResumable();
      if (p) beginQuiz(p);
    },
    onDiscard: () => {
      store.clearProgress(state.key);
      showStart();
      toast('Progress discarded');
    },
    onLibrary: backToLibrary,
  });
  focusHeading(views.start);
}

function beginQuiz(session) {
  state.session = session;
  if (!store.saveProgress(state.key, session) && !store.storageAvailable()) {
    toast('Browser storage is unavailable; progress will not survive a refresh.');
  }
  show('quiz');
  state.quiz = startQuiz(views.quiz, {
    set: state.set,
    session,
    persist: () => store.saveProgress(state.key, session),
    onFinish: finishSession,
    onExit: () => {
      showStart();
      toast('Progress saved');
    },
  });
}

function finishSession() {
  const s = state.session;
  const r = scoreSession(state.set, s);
  store.saveLastResult(state.key, {
    at: Date.now(),
    mode: s.mode,
    score: r.score,
    total: r.total,
    missedIds: r.missedIds,
    flaggedIds: r.flaggedIds,
  });
  store.clearProgress(state.key);
  showResults();
}

function showResults() {
  show('results');
  const prev = state.session;
  const again = (ids, label) =>
    beginQuiz(
      buildSession(state.set, {
        mode: prev.mode,
        timerSec: prev.timerSec,
        shuffleQuestions: true,
        shuffleOptions: prev.settings ? prev.settings.shuffleOptions : true,
        askConfidence: prev.settings ? prev.settings.askConfidence !== false : true,
        ids,
        label,
      })
    );
  renderResults(views.results, {
    set: state.set,
    session: prev,
    onRedo: (ids, label) => again(ids, label),
    onRetake: () => again(prev.items.map((i) => i.id), ''),
    onLibrary: backToLibrary,
  });
  focusHeading(views.results);
}

function backToLibrary() {
  if (location.search) history.pushState(null, '', location.pathname);
  showLibrary();
}

/* ---------- routing ---------- */

async function route() {
  const params = new URLSearchParams(location.search);
  const url = params.get('set');
  if (url) {
    if (state.set && state.url === url) {
      if (state.view !== 'start') showStart();
      return;
    }
    await loadUrl(url, params.get('resume') === '1');
  } else {
    showLibrary();
  }
}

/* ---------- wiring ---------- */

function wireLibrary() {
  $('#file-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    loadFile(f);
  });
  $('#paste-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#paste-input').value;
    const backup = asBackup(text);
    if (backup) {
      $('#paste-input').value = '';
      await restoreFlow(backup, 'pasted backup');
      return;
    }
    showLoading();
    const ok = await handleResult(loadSetFromText(text), { sourceLabel: 'pasted JSON' });
    if (ok) $('#paste-input').value = '';
  });
  $('#backup-btn').addEventListener('click', backUp);
  $('#restore-btn').addEventListener('click', () => $('#restore-input').click());
  $('#restore-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    restoreFile(f);
  });
}

function wireDragDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const allowed = () => state.view === 'library' || state.view === 'start';
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!allowed()) return;
    depth++;
    overlay.hidden = false;
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // also stops the browser from navigating to the file
    e.dataTransfer.dropEffect = allowed() ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    if (!allowed()) {
      toast('Finish or exit the current session to load another set.');
      return;
    }
    loadFile(e.dataTransfer.files[0]);
  });
}

window.addEventListener('popstate', route);
wireLibrary();
wireDragDrop();
route();
