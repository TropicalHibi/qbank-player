# CLAUDE.md

Conventions for working on qbank-player. Read this before changing code.

## What this is

A static, vanilla-JS web app that plays board-style (USMLE Step 1 / COMLEX Level 1) multiple-choice question sets stored as JSON. It is hosted on GitHub Pages under `/qbank-player/` and deployed by `.github/workflows/pages.yml` on every push to `main`. `create.html` produces the LLM prompt used to generate sets.

## Hard rules

- **No frameworks, bundlers, CDNs, runtime npm dependencies, or build step.** Use plain HTML, CSS and ES modules. `package.json` exists only so Node treats `.js` as ESM and to hold script aliases.
- **Relative paths only** (`./`, `css/…`, `js/…`, `sets/…`), never a leading `/`, because the site is served under `/qbank-player/`.
- Serve the site over HTTP (`python3 -m http.server 8000`). ES modules don't load from `file://`.
- No external requests, analytics or trackers. The site must work offline once loaded.

## Schema

- `schema.json` is **v1**. Change `version` only with a written migration plan, so existing sets either keep loading or the loader migrates them. The same change must update `js/validate.js`, `js/prompt.js`, the README schema reference and the tests.
- Keep `SCHEMA` in `js/prompt.js` **identical** to `schema.json`. `tests/validate.test.mjs` checks they are deep-equal; edit both together.
- Validator errors must name the question (id, or position if there is no id) and the field, for example `q7: answer index 5 out of range (4 options).` Unknown fields produce warnings, not errors.
- The prompt template lives only in `js/prompt.js` and must embed the schema inline.

## Security: set content is untrusted

- Never assign raw set strings to `innerHTML`. Use `textContent` / `el(tag, { text })`, or `renderMarkdownLite()` from `js/util.js`, which escapes HTML before formatting. `el(tag, { html })` is only for `renderMarkdownLite()` output.
- Load images only through `<img src>`, and only after `isSafeImageUrl()` passes (http/https, protocol-relative, relative path, `data:image/`).
- Never use `alert`, `confirm` or `prompt`. Use `showModal()` from `js/dom.js`.
- All storage goes through `js/storage.js`, which catches every failure. The app must keep working with storage blocked or full. Large set copies go to IndexedDB; small state goes to localStorage.

## Testing and PR checklist

Before opening a PR, run both:

```bash
node tests/validate.test.mjs
```

```bash
node tests/smoke.mjs
```

- `validate.test.mjs` has no dependencies and runs in CI. `smoke.mjs` is local only: it needs Playwright and Chromium, and it serves the site under `/qbank-player/`.
- Add tests for new behavior: unit tests for the DOM-free modules, smoke-test steps for UI flows.
- Adding a set means putting the file in `sets/` and adding a matching entry (same `title` and `count`) to `sets/index.json`. The tests check both.
- Don't re-commit `docs/screenshots/` unless the UI change affects what the README shows. To refresh them, run `node tests/smoke.mjs --screenshots`.
- One issue per PR. The PR body includes `Closes #N`.

## Module map

DOM-free (also run under Node and are unit-tested): `util.js`, `validate.js`, `loader.js`, `session.js`, `prompt.js`.

- `js/app.js`: index.html entry point; routing (Library → Start → Quiz → Results), app state, and the Library view (file/paste/`?set=` loading, bundled and recent sets).
- `js/create.js`: create.html; tab registry (the manual builder will go here) and the prompt generator form.
- `js/dom.js`: `el()` element builder, `setChildren()`, `showModal()`, lightbox, toast, aria-live `announce()`, clipboard, downloads.
- `js/loader.js`: turns text, files and URLs into a validated set; strips fences and prose, repairs trailing commas and smart quotes (reported as warnings), reports parse errors with line and column.
- `js/prompt.js`: the single prompt template, `fillPrompt()`, the inline `SCHEMA` copy, and `EXAMPLE_QUESTION`.
- `js/quiz.js`: quiz view for tutor and exam modes, including the navigator, timers, flags, keyboard shortcuts and progress persistence.
- `js/render.js`: question rendering shared by the quiz and the results review (stem, image, options, explanations, discriminator, tags).
- `js/results.js`: results view with score, per-tag breakdown, review list, redo/retake, JSON export and the Claude summary.
- `js/session.js`: session model; `setKey()`, tag pool filtering, seeded shuffling with answer remap (responses store original indexes), scoring, export, summaries.
- `js/start.js`: start screen with mode, timer, shuffle options, tag chips, the "Missed last session" filter and the question count.
- `js/storage.js`: localStorage (progress, last results, recents, prefs) and IndexedDB (full set copies), with failures caught.
- `js/theme-init.js`: classic (non-module) script in `<head>` that applies the saved theme before first paint and wires the toggle.
- `js/util.js`: seeded shuffle, hash, slug, `escapeHtml`, `renderMarkdownLite()`, `isSafeImageUrl()`, time formatting.
- `js/validate.js`: hand-rolled v1 schema validator (`validateSet()`).

Other files:
- `schema.json`: JSON Schema draft 2020-12 for sets.
- `sets/index.json`: manifest of bundled sets (`[{file, title, count}]`).
- `tests/`: `validate.test.mjs` (unit tests plus validation of every set) and `smoke.mjs` (Playwright end-to-end run).
