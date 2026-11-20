// Classic (non-module) script loaded in <head> so the saved theme applies before first paint.
// Follows prefers-color-scheme unless the user picked one with the toggle (persisted).
(function () {
  var KEY = 'qbp:theme';
  var root = document.documentElement;
  try {
    var saved = JSON.parse(localStorage.getItem(KEY));
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch (e) {
    /* storage blocked: follow system */
  }

  function effective() {
    var t = root.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    function label() {
      var dark = effective() === 'dark';
      btn.textContent = dark ? '☀︎' : '☾';
      var text = dark ? 'Switch to light theme' : 'Switch to dark theme';
      btn.setAttribute('aria-label', text);
      btn.title = text;
    }
    btn.addEventListener('click', function () {
      var next = effective() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch (e) {
        /* ignore */
      }
      label();
    });
    if (window.matchMedia) {
      var mq = matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', label);
    }
    label();
  });
})();
