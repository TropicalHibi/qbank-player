// create.html: tab registry + the prompt generator.
//
// Adding a creation method (e.g. the planned form-based Manual builder) means adding an
// entry to TABS with a `mount(panel)` function. A builder should produce a plain set object
// ({title, version: 1, questions: [...]}) and check it with validateSet() from ./validate.js
// before offering a download or copy. The schema and player stay untouched.

import { $, el, copyWithFeedback, downloadText } from './dom.js';
import { SCHEMA, EXAMPLE_QUESTION, fillPrompt } from './prompt.js';

const TABS = [
  { id: 'prompt', label: 'Prompt generator', mount: mountPromptGenerator },
  { id: 'manual', label: 'Manual builder (coming soon)', disabled: true },
];

function mountTabs() {
  const tablist = $('#tabs');
  const panels = $('#tab-panels');
  const enabled = TABS.filter((t) => !t.disabled);
  const buttons = [];
  const panelEls = new Map();

  TABS.forEach((t) => {
    const btn = el('button', {
      class: 'tab',
      type: 'button',
      id: `tab-${t.id}`,
      text: t.label,
      disabled: !!t.disabled,
      attrs: {
        role: 'tab',
        'aria-selected': 'false',
        'aria-controls': t.disabled ? null : `panel-${t.id}`,
        'aria-disabled': t.disabled ? 'true' : null,
        tabindex: '-1',
      },
      on: { click: () => select(t.id) },
    });
    buttons.push(btn);
    tablist.append(btn);
    if (!t.disabled) {
      const panel = el('div', { id: `panel-${t.id}`, attrs: { role: 'tabpanel', 'aria-labelledby': `tab-${t.id}` }, hidden: true });
      panels.append(panel);
      panelEls.set(t.id, { panel, mounted: false, tab: t });
    }
  });

  tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const cur = enabled.findIndex((t) => `tab-${t.id}` === document.activeElement.id);
    if (cur < 0) return;
    const nxt = enabled[(cur + (e.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length];
    select(nxt.id);
    $(`#tab-${nxt.id}`).focus();
  });

  function select(id) {
    TABS.forEach((t, i) => {
      const on = t.id === id;
      buttons[i].setAttribute('aria-selected', String(on));
      buttons[i].tabIndex = on ? 0 : -1;
    });
    for (const [pid, p] of panelEls) {
      p.panel.hidden = pid !== id;
      if (pid === id && !p.mounted) {
        p.tab.mount(p.panel);
        p.mounted = true;
      }
    }
  }
  select(enabled[0].id);
}

function mountPromptGenerator(panel) {
  panel.append($('#tpl-prompt').content.cloneNode(true));
  const form = $('#prompt-form', panel);
  const preview = $('#prompt-preview', panel);
  const copyBtn = $('#copy-prompt', panel);

  const read = () => {
    const fd = new FormData(form);
    return {
      n: fd.get('n'),
      style: fd.get('style'),
      topic: fd.get('topic'),
      options: fd.get('options'),
      difficulty: fd.get('difficulty'),
    };
  };
  const update = () => {
    preview.value = fillPrompt(read());
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('submit', (e) => e.preventDefault());
  copyBtn.addEventListener('click', () => copyWithFeedback(copyBtn, fillPrompt(read()), 'Copy prompt'));
  update();
}

function wireExtras() {
  $('#download-schema').addEventListener('click', () => downloadText('schema.json', JSON.stringify(SCHEMA, null, 2) + '\n'));
  const ex = $('#copy-example');
  ex.addEventListener('click', () => copyWithFeedback(ex, JSON.stringify(EXAMPLE_QUESTION, null, 2), 'Copy example question'));
}

mountTabs();
wireExtras();
