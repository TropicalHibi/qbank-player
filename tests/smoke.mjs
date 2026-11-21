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

try {
  /* ---------- library ---------- */
  await page.goto(site);
  await page.waitForSelector('#bundled-list a.set-title');
  log('library lists bundled set');
  await shot('library');

  await page.click('#bundled-list a.btn:has-text("Open")');
  await page.waitForSelector('#start-title');
  assert.match(page.url(), /\?set=sets\/example\.json$/);
  assert.equal(await page.textContent('#start-title'), 'Example: Mixed Step 1 Systems');
  assert.ok(!/\bnull\b|undefined/.test(await page.textContent('#view-start')), 'no stray null/undefined text');
  log('?set= link opens start screen');
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
      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog.lightbox', { state: 'detached' });
      log('image lightbox opens and closes with Esc');
    }
    if (i === 0) {
      // Confirm-before-submit: Enter with nothing picked, then select → change → submit.
      assert.equal(await page.isDisabled('button.submit-answer'), true, 'Submit answer disabled until something is picked');
      assert.equal(await page.isVisible('.quiz-footer button:has-text("Next")'), false, 'Next hidden until answered');
      await page.evaluate(() => document.activeElement?.blur()); // focus may be on the image button after the lightbox
      await page.keyboard.press('Enter');
      await page.waitForSelector('#toast.show:has-text("Choose an answer first")');
      await page.keyboard.press('a');
      await page.waitForSelector('.option.pending[data-display="0"]');
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
    if (i === 2) await shot('tutor-feedback');
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

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export results")')]);
  assert.match(dl.suggestedFilename(), /^example-mixed-step-1-systems-results-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  const exported = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(Object.keys(exported), ['setTitle', 'setVersion', 'mode', 'timestamp', 'score', 'total', 'responses']);
  assert.equal(exported.total, 5);
  assert.equal(exported.mode, 'tutor');
  assert.equal(exported.responses.length, 5);
  assert.deepEqual(Object.keys(exported.responses[0]), ['id', 'chosen', 'correct', 'timeMs', 'flagged', 'tags']);
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
  await page.keyboard.press('2');
  assert.ok(await page.$('.option.selected'));
  assert.equal(await page.$('.feedback'), null, 'no feedback in exam mode');
  await page.keyboard.press('3'); // change answer
  assert.equal(await page.$$eval('.option.selected', (x) => x.length), 1);
  await page.keyboard.press('f');
  assert.equal(await page.getAttribute('.flag-btn', 'aria-pressed'), 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('a');
  await page.click('.nav-cell >> nth=4');
  await page.keyboard.press('c');
  await page.keyboard.press('ArrowLeft');
  await shot('exam');
  await page.click('button:has-text("Submit…")');
  await page.waitForSelector('dialog.modal[open]');
  assert.match(await page.textContent('dialog.modal'), /answered 3 of 5/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog.modal', { state: 'detached' });
  assert.ok(await page.$('.question-card'), 'Esc cancels submit');
  await page.click('button:has-text("Submit…")');
  await shot('exam-submit');
  await page.click('dialog.modal button:has-text("Submit")');
  await page.waitForSelector('#results-title');
  assert.match(await page.textContent('#view-results header p'), /Exam mode/);
  await page.click('.review-filter button:has-text("Flagged")');
  assert.equal(await page.$$eval('.review-list > li:not([hidden])', (x) => x.length), 1);
  log('exam mode: change answer, flag, navigate, confirm-submit modal, results');

  /* ---------- resume after refresh ---------- */
  await page.click('button:has-text("Retake all")');
  await page.waitForSelector('.question-card');
  await page.keyboard.press('a');
  await page.reload();
  await page.waitForSelector('.resume-card');
  assert.match(await page.textContent('.resume-card'), /1 of 5 answered/);
  await page.click('.resume-card button:has-text("Resume")');
  await page.waitForSelector('.question-card');
  log('progress survives refresh and resumes');
  await page.click('button:has-text("Save & exit")');
  await page.waitForSelector('.resume-card');

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
