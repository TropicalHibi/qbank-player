// Browser smoke test (local only; needs Playwright + Chromium).
//   node tests/smoke.mjs [--screenshots]
// Serves the repo under /qbank-player/ (like GitHub Pages) with a tiny static server.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '/qbank-player/';
const SHOTS = process.argv.includes('--screenshots') ? path.join(root, 'docs', 'screenshots') : null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith(BASE)) {
    res.writeHead(404).end('not under base');
    return;
  }
  let p = decodeURIComponent(u.pathname.slice(BASE.length)) || 'index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const site = origin + BASE;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, acceptDownloads: true });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));

let step = 0;
const log = (s) => console.log(`  ${++step}. ${s}`);
// Only these are kept in docs/screenshots (README + PR); keep the repo light.
const KEEP = new Set(['tutor-feedback', 'exam', 'results', 'create', 'mobile-dark']);
const shot = async (name, p = page) => {
  if (!SHOTS || !KEEP.has(name)) return;
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
};
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/* ---------- accessibility scan (axe-core, dev-only) ----------
   axe-core is a devDependency injected by Playwright; the site never loads it.
   Each scan runs in the current theme and again in the other one. serious/critical
   violations fail the run; moderate/minor are printed as warnings. */
let AXE;
try {
  AXE = require.resolve('axe-core/axe.min.js');
} catch {
  console.error('axe-core not found: run `npm install` once before `npm run smoke`.');
  process.exit(1);
}
// Known issues, to be emptied by the remaining #17 sub-issues. Each entry is
// { rule, views?, targets?, reason }: omitting `views` allows the rule in every view,
// omitting `targets` allows it on every element. Remove an entry once it is fixed.
const A11Y_ALLOW = [
  // "Copied ✓" state: .btn.is-copied sets green text but .btn-primary keeps the accent background.
  { rule: 'color-contrast', views: ['create'], targets: ['#copy-prompt'], reason: '#29 contrast audit' },
];
const a11yFailures = [];
const a11yWarnings = new Map(); // "rule (impact)" -> Set of "view/theme"
const allowEntry = (a, rule, view, target) => a.rule === rule && (!a.views || a.views.includes(view)) && (!a.targets || a.targets.includes(target));
const allowed = (rule, view, target) => A11Y_ALLOW.some((a) => allowEntry(a, rule, view, target));
const a11y = async (view, p = page) => {
  if (!(await p.evaluate(() => !!window.axe))) await p.addScriptTag({ path: AXE });
  const start = await p.evaluate(() => {
    const r = document.documentElement;
    return r.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  });
  for (const theme of [start, start === 'dark' ? 'light' : 'dark']) {
    const violations = await p.evaluate(async (theme) => {
      const r = document.documentElement;
      const style = document.createElement('style');
      style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
      document.head.append(style);
      r.setAttribute('data-theme', theme);
      try {
        const res = await window.axe.run(document, { resultTypes: ['violations'] });
        return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.map((n) => n.target.join(' ')) }));
      } finally {
        style.remove();
      }
    }, theme);
    const where = `${view}/${theme}`;
    for (const v of violations) {
      const blocking = v.impact === 'serious' || v.impact === 'critical';
      const failing = blocking ? v.targets.filter((t) => !allowed(v.id, view, t)) : [];
      if (failing.length) a11yFailures.push(`${where}: [${v.impact}] ${v.id}: ${v.help} (${failing.length}×: ${failing.slice(0, 5).join(', ')})`);
      if (failing.length === v.targets.length) continue;
      const key = `${v.id} (${v.impact}${blocking ? ', allowlisted' : ''})`;
      if (!a11yWarnings.has(key)) a11yWarnings.set(key, new Set());
      a11yWarnings.get(key).add(where);
    }
  }
  // Restore the theme the app had (attribute only; the saved pref is untouched).
  await p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), start);
};

try {
  /* ---------- library ---------- */
  await page.goto(site);
  await page.waitForSelector('#bundled-list a.set-title');
  log('library lists bundled set');
  await a11y('library');
  await shot('library');

  await page.click('#bundled-list a.btn:has-text("Open")');
  await page.waitForSelector('#start-title');
  assert.match(page.url(), /\?set=sets\/example\.json$/);
  assert.equal(await page.textContent('#start-title'), 'Example: Mixed Step 1 Systems');
  assert.ok(!/\bnull\b|undefined/.test(await page.textContent('#view-start')), 'no stray null/undefined text');
  log('?set= link opens start screen');
  await a11y('start');
  await shot('start');

  /* ---------- tutor run ---------- */
  await page.click('button[type=submit]:has-text("Start")');
  await page.waitForSelector('.question-card');
  let sawImage = false;
  for (let i = 0; i < 5; i++) {
    const hasImg = await page.$('.q-image');
    if (hasImg && !sawImage) {
      sawImage = true;
      await hasImg.click();
      await page.waitForSelector('dialog.lightbox[open]');
      await a11y('lightbox');
      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog.lightbox', { state: 'detached' });
      log('image lightbox opens and closes with Esc');
    }
    assert.equal(await page.$$eval('.strike-btn', (x) => x.length), await page.$$eval('.options .option', (x) => x.length), 'strike button per option');
    if (i === 0) {
      // Confirm-before-submit: Enter with nothing picked, then select → change → submit.
      assert.equal(await page.isDisabled('button.submit-answer'), true, 'Submit answer disabled until something is picked');
      assert.equal(await page.isVisible('.quiz-footer button:has-text("Next")'), false, 'Next hidden until answered');
      await page.evaluate(() => document.activeElement?.blur()); // focus may be on the image button after the lightbox
      await page.keyboard.press('Enter');
      await page.waitForSelector('#toast.show:has-text("Choose an answer first")');
      await page.keyboard.press('Shift+A');
      await page.waitForSelector('.option.struck[data-display="0"]');
      await page.keyboard.press('a');
      await page.waitForSelector('.option.pending[data-display="0"]');
      assert.equal(await page.$('.option.struck'), null, 'picking a struck option (pending) clears its strike');
      assert.equal(await page.$('.feedback'), null, 'no reveal while pending');
      await page.waitForSelector('#sr-live:has-text("A selected, press Enter to submit")'); // set on the next frame
      await page.keyboard.press('2');
      assert.deepEqual(await page.$$eval('.option.pending', (x) => x.map((b) => b.dataset.display)), ['1'], 'new pick replaces the old one');
      assert.equal(await page.getAttribute('.option[data-display="1"]', 'aria-pressed'), 'true');
      assert.equal(await page.textContent('.navigator summary'), 'Navigator · 0/5 answered', 'pending is not answered');
      await page.click('button.submit-answer');
      await page.waitForSelector('.feedback');
      assert.equal(await page.isVisible('button.submit-answer'), false);
      assert.match(await page.$eval('.option[data-display="1"]', (b) => b.className), /\b(correct|incorrect)\b/, 'the changed pick was graded');
      log('tutor confirm-before-submit: empty Enter toast, select → change → submit → reveal');
    } else {
      // Pick B on odd questions, the shown correct one is unknown, so just choose by key.
      await page.keyboard.press(i % 2 ? 'b' : '1');
      assert.equal(await page.$('.feedback'), null, 'no reveal before submitting');
      await page.keyboard.press('Enter'); // submit
      await page.waitForSelector('.feedback');
    }
    assert.equal(await page.$('.strike-btn'), null, 'strikes are read-only once a tutor answer is locked');
    const nOpts = await page.$$eval('.options .option', (x) => x.length);
    const nExpl = await page.$$eval('.options .explanation', (x) => x.length);
    assert.equal(nExpl, nOpts, 'every option shows an explanation');
    assert.ok(await page.$('.callout.discriminator'), 'discriminator shown');
    assert.ok(await page.$('.q-meta .tag'), 'tags shown after answering');
    assert.equal(await page.$$eval('.option.correct .opt-mark', (x) => x[0].textContent), '✓');
    if (i === 1) {
      // Jump back to Q1 via navigator (read-only), Q3+ must be locked.
      assert.equal(await page.isDisabled('.nav-cell >> nth=2'), false, 'next unanswered question reachable');
      assert.equal(await page.isDisabled('.nav-cell >> nth=3'), true, 'later unanswered question locked');
      const before = await page.textContent('.question-card .options');
      await page.click('.nav-cell >> nth=0');
      await page.waitForSelector('.question-card h2:has-text("Question 1 of 5 (answered)")');
      const marks = await page.$$eval('.option.correct, .option.incorrect', (x) => x.length);
      await page.keyboard.press('c'); // ignored: answer locked
      assert.equal(await page.$$eval('.option.correct, .option.incorrect', (x) => x.length), marks);
      await page.click('.nav-cell >> nth=1');
      assert.equal(await page.textContent('.question-card .options'), before);
      log('tutor navigator: answered questions reachable, future locked');
    }
    if (i === 2) {
      await shot('tutor-feedback');
      await a11y('quiz-tutor-feedback');
    }
    await page.keyboard.press('Enter');
  }
  await page.waitForSelector('#results-title');
  log('tutor mode: answered all 5, results shown');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow on results');
  const scoreText = await page.textContent('.stat .value');
  assert.match(scoreText, /^\d \/ 5$/);
  const row = await page.textContent('.review-item summary .r-answers');
  assert.match(row, /^You: [A-E] · Correct: [A-E]$/);
  await page.click('.review-item >> nth=0');
  await page.waitForSelector('.review-item[open] .review-body .explanation');
  await shot('results');
  await a11y('results');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export results")')]);
  assert.match(dl.suggestedFilename(), /^example-mixed-step-1-systems-results-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  const exported = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(Object.keys(exported), ['setTitle', 'setVersion', 'mode', 'timestamp', 'score', 'total', 'responses']);
  assert.equal(exported.total, 5);
  assert.equal(exported.mode, 'tutor');
  assert.equal(exported.responses.length, 5);
  assert.deepEqual(Object.keys(exported.responses[0]), ['id', 'chosen', 'correct', 'timeMs', 'flagged', 'confidence', 'tags']);
  log(`export downloads ${dl.suggestedFilename()} (score ${exported.score}/5)`);

  await page.click('button:has-text("Copy summary for Claude")');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /^qbank-player results: "Example: Mixed Step 1 Systems"/);
  assert.match(clip, /Per-tag performance/);
  log('copy summary for Claude');

  const missed = 5 - exported.score;
  await page.click('button:has-text("Back to library")');
  await page.waitForSelector('#recent-list .set-item');
  log('back to library; recent list populated');

  /* ---------- exam run ---------- */
  await page.click('#bundled-list a.btn:has-text("Open")');
  await page.waitForSelector('#start-title');
  const missedChip = await page.$('.chip-special');
  assert.ok(missedChip, 'missed-last-session chip present');
  assert.match(await missedChip.textContent(), new RegExp(`\\(${missed}\\)`));
  if (missed > 0) {
    await missedChip.click();
    assert.match(await page.textContent('output'), new RegExp(`^${missed} of ${missed}$`));
    await missedChip.click();
  }
  log('"Missed last session" quick filter reflects last results');
  await page.check('input[name=mode][value=exam]');
  await page.check('label:has-text("Timed") input');
  await page.click('button[type=submit]:has-text("Start")');
  await page.waitForSelector('.question-card');
  assert.match(await page.textContent('.timer'), /left$/);
  const opt = (d) => `.question-card button.option[data-display="${d}"]`;
  const struckDisplays = () => page.$$eval('.question-card button.option.struck', (x) => x.map((b) => +b.dataset.display));
  await page.click('.strike-btn[data-display="3"]');
  assert.deepEqual(await struckDisplays(), [3]);
  assert.equal(await page.getAttribute('.strike-btn[data-display="3"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('.strike-btn[data-display="3"]', 'aria-label'), 'Strike out option D');
  assert.match(await page.textContent(opt(3)), /\(struck out\)/);
  await page.click(opt(0), { button: 'right' });
  assert.deepEqual(await struckDisplays(), [0, 3], 'right-click strikes');
  assert.equal(await page.$('.option.selected'), null, 'right-click does not select');
  await page.keyboard.press('Shift+B');
  assert.deepEqual(await struckDisplays(), [0, 1, 3], 'Shift+letter strikes');
  await page.keyboard.press('Shift+Digit2');
  assert.deepEqual(await struckDisplays(), [0, 3], 'Shift+number toggles back');
  await page.keyboard.press('Shift+C');
  assert.deepEqual(await struckDisplays(), [0, 2, 3]);
  assert.equal(await page.getAttribute('.flag-btn', 'aria-pressed'), 'false', 'Shift+letter is not a shortcut for anything else');
  log('strike via button, right-click, Shift+letter and Shift+number');
  await page.keyboard.press('2');
  assert.ok(await page.$('.option.selected'));
  assert.equal(await page.$('.feedback'), null, 'no feedback in exam mode');
  await page.keyboard.press('3'); // change answer (C was struck)
  assert.equal(await page.$$eval('.option.selected', (x) => x.length), 1);
  assert.deepEqual(await struckDisplays(), [0, 3], 'selecting a struck option clears its strike');
  log('selecting a struck option selects it and clears the strike');
  await page.keyboard.press('f');
  assert.equal(await page.getAttribute('.flag-btn', 'aria-pressed'), 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('a');
  await page.click('.nav-cell >> nth=4');
  await page.keyboard.press('c');
  await page.keyboard.press('ArrowLeft');
  await shot('exam');
  await a11y('quiz-exam');
  await page.click('button:has-text("Submit…")');
  await page.waitForSelector('dialog.modal[open]');
  assert.match(await page.textContent('dialog.modal'), /answered 3 of 5/);
  await a11y('modal');
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog.modal', { state: 'detached' });
  assert.ok(await page.$('.question-card'), 'Esc cancels submit');
  await page.click('button:has-text("Submit…")');
  await shot('exam-submit');
  await page.click('dialog.modal button:has-text("Submit")');
  await page.waitForSelector('#results-title');
  assert.match(await page.textContent('#view-results header p'), /Exam mode/);
  await page.click('.review-item >> nth=0');
  await page.waitForSelector('.review-item[open] .review-body .option');
  assert.equal(await page.$$eval('.review-item[open] .option.static.struck', (x) => x.length), 2, 'review shows strikes');
  assert.equal(await page.$('.review-item .strike-btn'), null, 'review strikes are read-only');
  await page.click('.review-filter button:has-text("Flagged")');
  assert.equal(await page.$$eval('.review-list > li:not([hidden])', (x) => x.length), 1);
  log('exam mode: change answer, flag, navigate, confirm-submit modal, results');

  /* ---------- resume after refresh ---------- */
  await page.click('button:has-text("Retake all")');
  await page.waitForSelector('.question-card');
  await page.keyboard.press('Shift+D');
  await page.keyboard.press('a');
  await page.reload();
  await page.waitForSelector('.resume-card');
  assert.match(await page.textContent('.resume-card'), /1 of 5 answered/);
  await page.click('.resume-card button:has-text("Resume")');
  await page.waitForSelector('.question-card');
  assert.deepEqual(await struckDisplays(), [3], 'strike survives refresh');
  log('progress and strikes survive refresh and resume');
  await page.click('button:has-text("Save & exit")');
  await page.waitForSelector('.resume-card');

  /* ---------- touch long-press strikes without selecting ---------- */
  {
    const t = await browser.newContext({ ...devices['Pixel 7'] });
    const tp = await t.newPage();
    tp.on('pageerror', (e) => problems.push(`pageerror (touch): ${e.message}`));
    await tp.goto(site + '?set=sets/example.json');
    await tp.waitForSelector('#start-title');
    await tp.click('button[type=submit]:has-text("Start")');
    await tp.waitForSelector('.question-card');
    const target = tp.locator('.question-card button.option[data-display="1"]');
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const cdp = await t.newCDPSession(tp);
    const pt = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
    await tp.waitForTimeout(800);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await tp.waitForTimeout(150);
    assert.deepEqual(await tp.$$eval('.question-card button.option.struck', (x) => x.map((b) => +b.dataset.display)), [1], 'long-press strikes');
    assert.equal(await tp.$('.feedback'), null, 'long-press does not select');
    await tp.tap('.question-card button.option[data-display="1"]');
    await tp.waitForSelector('.question-card .option.pending[data-display="1"]');
    assert.equal(await tp.$('.question-card .option.struck'), null, 'tapping a struck option selects it and clears the strike');
    await t.close();
    log('touch long-press strikes without selecting');
  }

  /* ---------- confidence rating ---------- */
  {
    const conf = (lv) => `.question-card .conf-opt[data-level="${lv}"]`;
    const checked = () => page.$$eval('.question-card .conf-opt[aria-checked="true"]', (x) => x.map((b) => b.dataset.level));
    await page.goto(site + '?set=sets/example.json');
    await page.waitForSelector('#start-title');
    assert.equal(await page.isChecked('input[name=ask-confidence]'), true, 'Ask for confidence defaults on');
    await page.check('input[name=mode][value=tutor]');
    await page.uncheck('input[name=ask-confidence]');
    await page.click('button[type=submit]:has-text("Start")');
    await page.waitForSelector('.question-card');
    assert.equal(await page.$('.confidence, [role=radiogroup]'), null, 'no confidence control when "Ask for confidence" is off');
    await page.keyboard.press('r');
    assert.ok(!(await page.textContent('.kbd-help')).includes('confidence'), 'help omits confidence keys when off');
    await page.click('button:has-text("Save & exit")');
    await page.waitForSelector('#start-title');
    assert.equal(await page.isChecked('input[name=ask-confidence]'), false, '"Ask for confidence" saved in prefs');
    await page.check('input[name=ask-confidence]');
    await page.click('button[type=submit]:has-text("Start")');
    await page.waitForSelector('.question-card .confidence');
    log('"Ask for confidence" off hides the control; the setting is remembered');

    assert.equal(await page.getAttribute('.question-card .conf-group', 'role'), 'radiogroup');
    assert.equal(await page.$$eval('.question-card .conf-opt[role=radio]', (x) => x.length), 3);
    assert.deepEqual(await checked(), []);
    assert.match(await page.textContent('.kbd-help'), /confidence/);
    await page.click(conf('medium'));
    assert.deepEqual(await checked(), ['medium']);
    await page.waitForSelector('#sr-live:has-text("Confidence: medium")');
    assert.equal(await page.textContent(`${conf('medium')} .conf-mark`), '✓', 'checked state is not color alone');
    await page.click(conf('medium'));
    assert.deepEqual(await checked(), [], 'clicking the active value clears it');
    await page.keyboard.press('r');
    assert.deepEqual(await checked(), ['high'], 'R rates high');
    assert.deepEqual(await page.$$eval('.question-card .conf-opt', (x) => x.map((b) => b.tabIndex)), [-1, -1, 0], 'roving tabindex follows the checked value');
    await page.focus(conf('high'));
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await checked(), ['low'], 'arrow keys move the selection');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.level), 'low');
    assert.match(await page.textContent('.question-card h2'), /^Question 1 of 5$/, 'arrows inside the group do not change question');
    await page.keyboard.press('q');
    assert.deepEqual(await checked(), [], 'pressing the active key again clears it');
    await page.keyboard.press('w');
    await page.keyboard.press('q');
    assert.deepEqual(await checked(), ['low']);
    assert.ok(!/confidence|low/i.test(await page.$$eval('.nav-cell', (x) => x.map((b) => b.getAttribute('aria-label') + b.textContent).join(' '))), 'navigator does not show confidence');
    await a11y('quiz-confidence');
    log('confidence: rate by click, Q/W/R and arrow keys; clicking again clears');

    await page.reload();
    await page.click('.resume-card button:has-text("Resume")');
    await page.waitForSelector('.question-card .confidence');
    assert.deepEqual(await checked(), ['low'], 'rating restored after refresh');
    log('confidence rating survives refresh and resume');

    await page.keyboard.press('a');
    await page.click('button.submit-answer');
    await page.waitForSelector('.feedback');
    assert.ok(await page.$('.question-card .confidence.is-locked'), 'read-only after submit');
    assert.equal(await page.getAttribute('.question-card .conf-group', 'aria-readonly'), 'true');
    assert.deepEqual(await checked(), ['low'], 'read-only control shows the chosen value');
    await page.keyboard.press('r');
    await page.click(conf('high'), { force: true }); // aria-disabled: Playwright would otherwise wait
    assert.deepEqual(await checked(), ['low'], 'tutor rating locked after submit');
    await a11y('quiz-confidence-locked');
    await page.click('.quiz-footer button:has-text("Next")');
    await page.waitForSelector('.question-card h2:has-text("Question 2 of 5")');
    await page.keyboard.press('b');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.feedback');
    assert.equal(await page.textContent('.question-card .conf-note'), 'Not rated', 'submitting without a rating is allowed');
    log('tutor: rating locks on submit; unrated submit allowed');

    await page.click('button:has-text("Save & exit")');
    await page.waitForSelector('#start-title');
    await page.check('input[name=mode][value=exam]');
    await page.click('button[type=submit]:has-text("Start")');
    await page.waitForSelector('.question-card .confidence');
    await page.keyboard.press('1');
    await page.keyboard.press('w');
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('.question-card h2:has-text("Question 2 of 5")');
    await page.keyboard.press('ArrowLeft');
    await page.waitForSelector('.question-card h2:has-text("Question 1 of 5")');
    assert.deepEqual(await checked(), ['medium']);
    await page.keyboard.press('r');
    assert.deepEqual(await checked(), ['high'], 'exam: rating changes after answering');
    await a11y('quiz-exam-confidence');
    await page.click('button:has-text("Save & exit")');
    await page.waitForSelector('#start-title');
    log('exam: rating can change until the exam is submitted');
  }

  /* ---------- paste: repaired + broken ---------- */
  await page.goto(site);
  const setText = fs.readFileSync(path.join(root, 'sets/example.json'), 'utf8');
  const sloppy = 'Here you go!\n```json\n' + setText.replace(/"source": ("[^"]*")\n/, '"source": $1,\n') + '\n```\nEnjoy.';
  await page.fill('#paste-input', sloppy);
  await page.click('#paste-form button[type=submit]');
  await page.waitForSelector('#start-title');
  assert.match(await page.textContent('.notice-warn'), /1 warning/);
  log('paste with fences + trailing comma loads with a warning');
  await page.goto(site);
  await page.fill('#paste-input', '{\n "title": "x",\n "version": 1\n "questions": []\n}');
  await page.click('#paste-form button[type=submit]');
  await page.waitForSelector('#load-errors:not([hidden])');
  assert.match(await page.textContent('#load-errors'), /line 4, column 2/);
  await page.fill('#paste-input', JSON.stringify({ title: 'x', version: 1, questions: [{ id: 'q7', stem: 's', options: [{ text: 'a', explanation: 'a' }, { text: 'b', explanation: 'b' }, { text: 'c', explanation: 'c' }, { text: 'd', explanation: 'd' }], answer: 5 }] }));
  await page.click('#paste-form button[type=submit]');
  await page.waitForSelector('#load-errors li:has-text("q7: answer index 5 out of range (4 options).")');
  await shot('load-error');
  log('invalid JSON / schema errors are shown');

  /* ---------- security: hostile content stays inert ---------- */
  const hostile = {
    title: '<img src=x onerror="window.__pwned=1">',
    version: 1,
    questions: [{ id: 'q1', stem: '<script>window.__pwned=1</script>**ok**', options: [{ text: '<b onmouseover=alert(1)>x</b>', explanation: 'e' }, { text: 'y', explanation: 'e' }], answer: 0 }],
  };
  await page.fill('#paste-input', JSON.stringify(hostile));
  await page.click('#paste-form button[type=submit]');
  await page.waitForSelector('#start-title');
  await page.click('button[type=submit]:has-text("Start")');
  await page.waitForSelector('.question-card strong:has-text("ok")');
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.$('.question-card script, .question-card b'), null);
  log('HTML in set content is escaped');

  /* ---------- stem highlighting ---------- */
  const hlSet = {
    title: 'Highlight test',
    version: 1,
    questions: [
      {
        id: 'h1',
        stem: 'The patient has **severe hypokalemia** and weakness.\n\n| Analyte | Value |\n|---|---|\n| Na | 140 |\n| K | 2.1 |',
        options: [
          { text: 'Long option text that the user drags across to select it', explanation: 'e' },
          { text: 'Second', explanation: 'e' },
          { text: 'Third', explanation: 'e' },
          { text: 'Fourth', explanation: 'e' },
        ],
        answer: 1,
      },
    ],
  };
  // Select stem text from the first occurrence of `from` to the end of the first `to` after it.
  const selectStem = (from, to) =>
    page.evaluate(
      ([from, to]) => {
        const stem = document.querySelector('.question-card .stem');
        const walker = document.createTreeWalker(stem, NodeFilter.SHOW_TEXT);
        const nodes = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
        const text = nodes.map((n) => n.data).join('');
        const s = text.indexOf(from);
        const e = text.indexOf(to, s) + to.length;
        const at = (off) => {
          for (const n of nodes) {
            if (off <= n.data.length) return [n, off];
            off -= n.data.length;
          }
        };
        const r = document.createRange();
        r.setStart(...at(s));
        r.setEnd(...at(e));
        const sel = document.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      },
      [from, to]
    );
  const markTexts = () => page.$$eval('.question-card .stem mark.hl', (m) => m.map((x) => x.textContent));
  await page.goto(site);
  await page.fill('#paste-input', JSON.stringify(hlSet));
  await page.click('#paste-form button[type=submit]');
  await page.waitForSelector('#start-title');
  await page.click('button[type=submit]:has-text("Start")');
  await page.waitForSelector('.question-card .stem strong');
  assert.equal(await page.isDisabled('button:has-text("Clear highlights")'), true);

  await selectStem('has', 'hypo');
  await page.waitForSelector('.hl-float:not([hidden])');
  await page.click('.hl-float');
  assert.deepEqual(await markTexts(), ['has ', 'severe hypo']);
  assert.equal(await page.$eval('.stem strong', (s) => s.textContent), 'severe hypokalemia', 'bold span intact');
  assert.ok(await page.$('.stem strong > mark.hl'), 'mark nested inside the bold span, not across it');
  assert.equal(await page.isVisible('.hl-float'), false);
  await selectStem('Na', '140');
  await page.click('.hl-float');
  assert.equal(await page.$$eval('.stem td', (x) => x.length), 4, 'table structure intact');
  assert.equal(await page.$$eval('.stem td > mark.hl', (x) => x.length), 2, 'one mark per table cell');
  assert.equal(await page.$('.option.selected, .feedback'), null, 'highlighting does not answer');
  log('highlight across a bold span and table cells');

  await page.reload(); // a pasted set reloads to the Library; resume it from Recent
  await page.click('#recent-list .set-item:has-text("Highlight test") button:has-text("Resume")');
  await page.waitForSelector('.question-card .stem mark.hl');
  assert.deepEqual(await markTexts(), ['has ', 'severe hypo', 'Na', '140']);
  log('highlights survive a refresh');

  await page.click('.stem mark.hl >> text=severe hypo');
  assert.deepEqual(await markTexts(), ['Na', '140']);
  log('clicking a highlight removes it');
  await selectStem('weak', 'ness');
  await page.click('.hl-float');
  assert.equal((await markTexts()).length, 3);
  await page.click('button:has-text("Clear highlights")');
  assert.deepEqual(await markTexts(), []);
  assert.equal(await page.isDisabled('button:has-text("Clear highlights")'), true);
  log('Clear highlights removes all');

  const optText = await page.$('.option >> nth=0 >> .opt-text');
  const box = await optText.boundingBox();
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.ok((await page.evaluate(() => document.getSelection().toString())).length > 3, 'option text got selected');
  assert.equal(await page.$('.option.selected, .option.correct, .option.incorrect, .feedback'), null, 'selecting option text does not pick it');
  assert.equal(await page.isVisible('.hl-float'), false, 'no highlight button for option text');
  await page.click('.option >> nth=1');
  await page.waitForSelector('.option.selected'); // the start screen remembered exam mode

  log('selecting option text does not select the option; a click still does');

  /* ---------- create page ---------- */
  await page.goto(site + 'create.html');
  await page.fill('#opt-n', '12');
  await page.fill('#opt-topic', 'renal acid-base');
  await page.check('input[name=difficulty][value=hard]');
  assert.match(await page.inputValue('#prompt-preview'), /^Generate 12 USMLE Step 1-style .* on renal acid-base/);
  await page.click('#copy-prompt');
  await page.waitForSelector('#copy-prompt:has-text("Copied")');
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(prompt.includes('Schema:\n{') && prompt.includes('"discriminator"'));
  assert.equal(await page.isDisabled('#tab-manual'), true);
  const [sdl] = await Promise.all([page.waitForEvent('download'), page.click('#download-schema')]);
  assert.equal(sdl.suggestedFilename(), 'schema.json');
  await page.click('#copy-example');
  JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  log('create page: prompt fills, copies, schema downloads, example copies');
  await shot('create');
  await a11y('create');

  /* ---------- dark mode + mobile ---------- */
  await page.click('#theme-toggle');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await page.reload();
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  log('theme toggle persists');
  if (SHOTS) {
    const m = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' });
    const mp = await m.newPage();
    await mp.goto(site + '?set=sets/example.json');
    await mp.waitForSelector('#start-title');
    await mp.click('button[type=submit]:has-text("Start")');
    await mp.waitForSelector('.question-card');
    await mp.keyboard.press('a');
    await mp.keyboard.press('Enter');
    await mp.waitForSelector('.feedback');
    await shot('mobile-dark', mp);
    await m.close();
  }

  /* ---------- backup round-trip (storage.js exportAll/importAll) ---------- */
  const bk = await page.evaluate(async () => {
    const st = await import('./js/storage.js');
    const before = await st.exportAll();
    const replaced = await st.importAll(before, { mode: 'replace' });
    const after = await st.exportAll();
    const incoming = {
      ...before,
      localStorage: { ...before.localStorage, 'qbp:smoke-extra': { n: 1 } },
      sets: [...before.sets, { key: 'smoke-set', text: '{"title":"S","version":1,"questions":[]}' }],
    };
    const merged = await st.importAll(incoming, { mode: 'merge' });
    const final = await st.exportAll();
    const bad = await st.importAll({ app: 'nope' }, { mode: 'replace' });
    const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    return {
      app: before.app,
      keys: Object.keys(before.localStorage),
      sets: before.sets.length,
      replacedOk: replaced.ok,
      roundTrip: same(before.localStorage, after.localStorage) && JSON.stringify(before.sets.sort((a, b) => (a.key < b.key ? -1 : 1))) === JSON.stringify(after.sets.sort((a, b) => (a.key < b.key ? -1 : 1))),
      merged,
      extra: final.localStorage['qbp:smoke-extra'],
      finalSets: final.sets.length,
      badOk: bad.ok,
      badErrors: bad.errors.length,
    };
  });
  assert.equal(bk.app, 'qbank-player');
  assert.ok(bk.keys.includes('qbp:theme') && bk.keys.includes('qbp:recents') && !bk.keys.includes('qbp:__test'), 'backup has theme + recents: ' + bk.keys.join(', '));
  assert.ok(bk.sets >= 1, 'backup includes saved set copies');
  assert.equal(bk.replacedOk, true);
  assert.equal(bk.roundTrip, true, 'export → replace → export is identical');
  assert.equal(bk.merged.ok, true, bk.merged.errors.join('; '));
  assert.deepEqual(bk.merged.restored, { keys: ['qbp:smoke-extra'], sets: ['smoke-set'] });
  assert.deepEqual(bk.extra, { n: 1 });
  assert.equal(bk.finalSets, bk.sets + 1);
  assert.equal(bk.badOk, false);
  assert.ok(bk.badErrors > 0);
  log('backup: exportAll → importAll replace round-trips; merge adds missing; invalid backup rejected');

  for (const [rule, where] of a11yWarnings) console.warn(`  a11y warning: ${rule} in ${[...where].join(', ')}`);
  assert.deepEqual(a11yFailures, [], 'no serious/critical accessibility violations:\n' + a11yFailures.join('\n'));
  log('accessibility scans: no serious/critical violations (light + dark)');
  assert.deepEqual(problems, [], 'no console errors');
  console.log(`\nSmoke test passed (${step} steps).`);
} catch (e) {
  console.error('\nSmoke test FAILED:', e.message);
  if (problems.length) console.error('Page problems:\n' + problems.join('\n'));
  await page.screenshot({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), 'smoke-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
