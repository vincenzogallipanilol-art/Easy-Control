// Avviso di nuova versione + riepilogo novità dopo l'aggiornamento.
(function () {
  const SEEN = 'ec_seen_version', DEFAULT_SEEN = '1.19.0', EVERY = 60000;
  const cmp = (a, b) => {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  };
  const store = {
    get() { try { return localStorage.getItem(SEEN); } catch (_) { return null; } },
    set(v) { try { localStorage.setItem(SEEN, v); } catch (_) {} },
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── Riepilogo novità ───────────────────────────────────────────
  function showLog(since) {
    if (document.getElementById('ec-changelog')) return;
    const list = (typeof CHANGELOG !== 'undefined' ? CHANGELOG : []).filter(e => cmp(e.v, since) > 0);
    const entries = list.length ? list : CHANGELOG.slice(0, 1);
    const wrap = document.createElement('div');
    wrap.className = 'ec-modal'; wrap.id = 'ec-changelog';
    wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', 'Novità');
    wrap.innerHTML = `
      <div class="ec-modal-box ec-log-box">
        <div class="ec-modal-head">
          <h3 class="m-0 fs-3">Novità dell'applicativo</h3>
          <span class="badge bg-blue-lt ms-2">v${esc(APP_VERSION)}</span>
          <button type="button" class="btn-close ms-auto" data-close aria-label="Chiudi"></button>
        </div>
        <div class="ec-log-body">
          ${entries.map(e => `
            <section class="ec-log-entry">
              <div class="ec-log-ver">v${esc(e.v)}<span class="text-muted ms-2">${esc(new Date(e.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }))}</span></div>
              <ul>${e.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
            </section>`).join('')}
        </div>
        <div class="ec-log-foot"><button type="button" class="btn btn-primary" data-close>Ho capito</button></div>
      </div>`;
    const close = () => { store.set(APP_VERSION); wrap.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('.btn-primary').focus();
  }

  function maybeShowLog() {
    const seen = store.get();
    if (seen === APP_VERSION) return;
    if (!document.getElementById('app-version')) return;
    showLog(seen || DEFAULT_SEEN);
  }

  // ── Nuova versione disponibile ─────────────────────────────────
  let bar = null, latest = null;
  function showBar(v) {
    if (bar) { bar.querySelector('[data-v]').textContent = 'v' + v; return; }
    bar = document.createElement('div');
    bar.className = 'ec-update-bar'; bar.setAttribute('role', 'status');
    bar.innerHTML = `
      <span><strong>Nuova versione disponibile</strong> (<span data-v>v${esc(v)}</span>): aggiorna la pagina per visualizzarla.</span>
      <button type="button" class="btn btn-sm btn-light" data-go>Aggiorna ora</button>
      <button type="button" class="btn-close btn-close-white" data-x aria-label="Più tardi"></button>`;
    bar.addEventListener('click', e => {
      if (e.target.closest('[data-x]')) { bar.remove(); bar = null; snoozeUntil = Date.now() + 10 * 60000; }
      else if (e.target.closest('[data-go]')) reload();
    });
    document.body.appendChild(bar);
  }
  function reload() {
    // forza la rilettura della pagina (la cache di GitHub Pages può durare qualche minuto)
    fetch(location.pathname + location.search, { cache: 'reload' }).catch(() => {}).finally(() => location.reload());
  }
  let snoozeUntil = 0, busy = false;
  async function check() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const r = await fetch('js/version.js?cb=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(await r.text());
      if (!m) return;
      latest = m[1];
      if (cmp(latest, APP_VERSION) > 0 && Date.now() >= snoozeUntil) showBar(latest);
    } catch (_) { /* offline: riprova al prossimo giro */ }
    finally { busy = false; }
  }

  function init() {
    const ver = document.getElementById('app-version');
    if (ver) {
      ver.style.cursor = 'pointer';
      ver.title = 'Novità dell\'applicativo';
      ver.addEventListener('click', () => showLog('0.0.0'));
    }
    setTimeout(maybeShowLog, 2500);
    setInterval(check, EVERY);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    window.addEventListener('online', check);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.Updates = { check, showLog: () => showLog('0.0.0') };
})();
