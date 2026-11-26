// Supporto mobile: etichette per le schede (tabelle → schede), barra menu nascosta con la tastiera, menu "sposta" su touch.
(function () {
  const mq = window.matchMedia('(max-width: 767.98px)');
  const clean = t => (t.textContent || '').replace(/\s+/g, ' ').trim();

  // Ogni cella prende come etichetta il testo della colonna corrispondente (solo su schermi stretti)
  function labelTables() {
    if (!mq.matches) return;
    document.querySelectorAll('table.ec-grid:not(.ec-nostack), table.card-table:not(.ec-nostack)').forEach(table => {
      const head = table.tHead && table.tHead.rows[0];
      if (!head) return;
      const names = [...head.cells].map(clean);
      for (const body of table.tBodies) {
        for (const tr of body.rows) {
          let i = 0;
          for (const td of tr.cells) {
            const span = td.colSpan || 1;
            const name = span === 1 ? names[i] : '';
            if (name && td.dataset.l !== name) td.dataset.l = name;
            i += span;
          }
        }
      }
    });
  }
  let raf = 0;
  const soon = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; labelTables(); }); };
  const start = () => {
    new MutationObserver(soon).observe(document.body, { childList: true, subtree: true });
    mq.addEventListener ? mq.addEventListener('change', soon) : mq.addListener(soon);
    soon();
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  // Con la tastiera aperta la barra in basso si nasconde
  const isField = el => el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(checkbox|radio|button|submit)$/.test(el.type || '');
  let t = 0;
  document.addEventListener('focusin', e => { if (isField(e.target) && window.innerWidth < 992) { clearTimeout(t); document.body.classList.add('ec-kb'); } });
  document.addEventListener('focusout', () => { clearTimeout(t); t = setTimeout(() => document.body.classList.remove('ec-kb'), 120); });

  // Il menu "sposta a un altro collega" si compila al passaggio del mouse: su touch prima del tocco
  document.addEventListener('pointerdown', e => {
    const s = e.target.closest && e.target.closest('.ec-move');
    if (s && window.App && typeof App.moveFill === 'function') App.moveFill(s);
  }, true);
})();
