// "Pratica in controllo": cliccando l'ID di una pratica (apre EGG) la riga resta evidenziata con un contorno
// rosso pulsante, cosi' al ritorno su Easy Control si vede subito quale pratica si stava controllando.
// Resta evidenziata (anche dopo F5) finche' non si imposta lo stato, si clicca la X o si apre un'altra pratica.
const Focus = (() => {
  const KEY = 'ec_focus_pid';
  let pid = '';
  try { pid = localStorage.getItem(KEY) || ''; } catch (_) {}

  function save() { try { pid ? localStorage.setItem(KEY, pid) : localStorage.removeItem(KEY); } catch (_) {} }

  function rowOf(p) {
    if (!p) return null;
    const a = [...document.querySelectorAll('.ec-pratica-btn[data-pid]')].find(x => x.dataset.pid === p);
    return a ? a.closest('tr') : null;
  }

  function apply() {
    document.querySelectorAll('tr.ec-focus').forEach(tr => {
      if (!pid || rowOf(pid) !== tr) { tr.classList.remove('ec-focus'); tr.querySelectorAll('.ec-focus-tag').forEach(t => t.remove()); }
    });
    const tr = rowOf(pid);
    if (!tr) return;
    tr.classList.add('ec-focus');
    if (!tr.querySelector('.ec-focus-tag')) {
      const tag = document.createElement('span');
      tag.className = 'ec-focus-tag';
      tag.innerHTML = '<span class="ec-focus-dot"></span>In controllo<button type="button" class="ec-focus-x" title="Togli evidenziazione" aria-label="Togli evidenziazione">×</button>';
      const cell = tr.querySelector('.ec-col-id') || tr.querySelector('.ec-pratica-btn').parentElement;
      cell.appendChild(tag);
    }
  }

  function set(p) { pid = p || ''; save(); apply(); }
  function clear() { set(''); }
  // chiamato quando alla pratica viene dato uno stato
  function done(p, status) { if (status && p && p === pid) clear(); }

  function reveal() {
    const tr = rowOf(pid);
    if (!tr) return;
    const r = tr.getBoundingClientRect();
    if (r.top < 70 || r.bottom > window.innerHeight - 20) tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  document.addEventListener('click', e => {
    const x = e.target.closest('.ec-focus-x');
    if (x) { e.preventDefault(); clear(); return; }
    const a = e.target.closest('.ec-pratica-btn[data-pid]');
    if (a) set(a.dataset.pid);
  }, true);

  let t = null;
  new MutationObserver(() => { if (t) return; t = requestAnimationFrame(() => { t = null; apply(); }); })
    .observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { apply(); setTimeout(reveal, 150); } });
  window.addEventListener('focus', () => { apply(); setTimeout(reveal, 150); });
  document.addEventListener('DOMContentLoaded', apply);

  return { set, clear, done, apply, pid: () => pid };
})();
