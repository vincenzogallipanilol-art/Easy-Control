// Tema chiaro/scuro: preferenza salvata per dispositivo, applicata prima del rendering.
const Theme = (function () {
  const KEY = 'ec_theme';
  const get = () => { try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch (_) { return 'light'; } };
  function mark() {
    const t = get();
    document.querySelectorAll('[data-theme-opt]').forEach(b => {
      const on = b.dataset.themeOpt === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  function apply() {
    document.documentElement.setAttribute('data-bs-theme', get());
    document.documentElement.style.colorScheme = get();
  }
  function set(t) {
    try { localStorage.setItem(KEY, t === 'dark' ? 'dark' : 'light'); } catch (_) {}
    apply(); mark();
  }
  apply();
  document.addEventListener('DOMContentLoaded', mark);
  return { get, set };
})();
