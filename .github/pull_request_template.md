Closes #

## What changed
<!-- 1–3 sentences: what this does and why. -->

## How to test
<!-- Steps a reviewer can follow on the deployed preview or a local server (npm run serve). -->
1.

## Screenshots
<!-- UI changes only: before/after, light + dark, and mobile if layout changed. Attach here; don't commit unless the README uses them. -->

## Checklist
- [ ] `npm test` passes
- [ ] `npm run smoke` passes (new behavior has a smoke step)
- [ ] No frameworks, CDNs, or build step; relative paths only (works under `/qbank-player/`)
- [ ] Set content stays untrusted: escaped before md-lite, no `innerHTML` of set strings, image URL allowlist intact
- [ ] Schema unchanged, **or** `schema.json` + `js/prompt.js` updated together and version/migration noted below
- [ ] Old saved sessions/localStorage still load (new fields default safely)
- [ ] Keyboard + screen reader: new controls are buttons with labels, key help overlay updated
- [ ] Readable in light and dark themes and on a phone
- [ ] README updated if usage, shortcuts, or the generation prompt changed

## Notes
<!-- Decisions made, follow-ups, anything left out on purpose. -->
