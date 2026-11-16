// ================================================================
// ColFilter — filtri e ordinamento per colonna (stile Excel / Fogli Google)
// ================================================================
const ColFilter = (() => {
  const state = {};   // tabella -> { ex: { colonna: Set(valori esclusi) }, sort: { col, dir } | null }
  const reg   = {};   // tabella -> { all: () => righe, cols: { colonna: riga => valore }, sortKeys?, onChange }
  let pop = null, cur = null;
  const MAX_LIST = 300;

  const collator = new Intl.Collator('it', { numeric: true, sensitivity: 'base' });
  const val  = v => (v == null ? '' : String(v)).trim();
  const esc  = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const st   = k => state[k] || (state[k] = { ex: {}, sort: null });

  function register(key, def) { reg[key] = def; }

  function exCols(key) {
    const s = state[key], r = reg[key];
    if (!s || !r) return [];
    return Object.keys(s.ex).filter(c => s.ex[c].size && r.cols[c]);
  }

  // Applica filtri e ordinamento della tabella alle righe
  function apply(key, rows) {
    const s = state[key], r = reg[key];
    if (!s || !r) return rows;
    let out = rows;
    const cols = exCols(key);
    if (cols.length) out = out.filter(row => cols.every(c => !s.ex[c].has(val(r.cols[c](row)))));
    if (s.sort && r.cols[s.sort.col]) {
      const g = (r.sortKeys && r.sortKeys[s.sort.col]) || r.cols[s.sort.col];
      const d = s.sort.dir === 'desc' ? -1 : 1;
      out = out.map(row => [val(g(row)), row]).sort((a, b) => {
        if (!a[0] && b[0]) return 1;       // le celle vuote vanno sempre in fondo
        if (a[0] && !b[0]) return -1;
        return d * collator.compare(a[0], b[0]);
      }).map(x => x[1]);
    }
    return out;
  }

  const active = key => !!(state[key] && (exCols(key).length || state[key].sort));

  function clear(prefix) {
    for (const k of Object.keys(state)) if (k === prefix || k.startsWith(prefix)) delete state[k];
    syncAll();
  }

  // Intestazione di colonna con il pulsante del menu
  function th(key, col, label, cls = '') {
    const s = state[key];
    const f = s && s.ex[col] && s.ex[col].size;
    const so = s && s.sort && s.sort.col === col ? s.sort.dir : '';
    return `<th class="ec-cf ${cls}${f ? ' is-filtered' : ''}${so ? ' is-' + so : ''}" data-cf-t="${esc(key)}" data-cf-c="${esc(col)}">` +
      `<span class="ec-cf-label">${label}</span>` +
      `<button type="button" class="ec-cf-btn" aria-label="Filtra e ordina: ${esc(label.replace(/<[^>]*>/g, ''))}" aria-haspopup="dialog" onclick="ColFilter.open(this)">` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 4h18l-7 8.5V20l-4-2v-5.5z"/></svg></button></th>`;
  }

  function syncAll() {
    document.querySelectorAll('th[data-cf-t]').forEach(h => {
      const s = state[h.dataset.cfT], c = h.dataset.cfC;
      const f = !!(s && s.ex[c] && s.ex[c].size && reg[h.dataset.cfT] && reg[h.dataset.cfT].cols[c]);
      const so = s && s.sort && s.sort.col === c ? s.sort.dir : '';
      h.classList.toggle('is-filtered', f);
      h.classList.toggle('is-asc', so === 'asc');
      h.classList.toggle('is-desc', so === 'desc');
    });
  }

  function changed(key) {
    syncAll();
    const r = reg[key];
    if (r && r.onChange) r.onChange();
  }

  // ── Menu a comparsa ────────────────────────────────────────────────
  function close() {
    if (pop) { pop.remove(); pop = null; }
    cur = null;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', onScroll, true);
  }
  const onOutside = e => { if (pop && !pop.contains(e.target) && !e.target.closest('.ec-cf-btn')) close(); };
  const onKey = e => {
    if (e.key === 'Escape') { const b = cur && cur.btn; close(); if (b) b.focus(); }
    else if (e.key === 'Enter' && pop && pop.contains(e.target) && e.target.tagName !== 'BUTTON') { e.preventDefault(); ok(); }
  };
  const onScroll = e => { if (pop && !pop.contains(e.target)) close(); };

  function open(btn) {
    const h = btn.closest('th');
    const key = h.dataset.cfT, col = h.dataset.cfC;
    const same = cur && cur.key === key && cur.col === col;
    close();
    if (same) return;
    const r = reg[key];
    if (!r || !r.cols[col]) return;
    const s = st(key);

    // Valori della colonna, tenendo conto dei filtri delle altre colonne
    const others = exCols(key).filter(c => c !== col);
    const counts = new Map();
    for (const row of r.all()) {
      if (others.some(c => s.ex[c].has(val(r.cols[c](row))))) continue;
      const v = val(r.cols[col](row));
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    for (const v of (s.ex[col] || [])) if (!counts.has(v)) counts.set(v, 0);
    const values = [...counts.keys()].sort((a, b) => {
      if (!a && b) return 1;
      if (a && !b) return -1;
      return collator.compare(a, b);
    });
    const checked = new Set(values.filter(v => !(s.ex[col] && s.ex[col].has(v))));
    cur = { key, col, btn, values, counts, checked, q: '' };

    pop = document.createElement('div');
    pop.className = 'ec-cf-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Filtra e ordina');
    const so = s.sort && s.sort.col === col ? s.sort.dir : '';
    pop.innerHTML = `
      <div class="ec-cf-sort">
        <button type="button" class="${so === 'asc' ? 'is-on' : ''}" data-act="asc">Ordina A → Z</button>
        <button type="button" class="${so === 'desc' ? 'is-on' : ''}" data-act="desc">Ordina Z → A</button>
        ${so ? '<button type="button" data-act="nosort">Rimuovi ordinamento</button>' : ''}
      </div>
      <input type="search" class="form-control form-control-sm ec-cf-search" placeholder="Cerca valore…" aria-label="Cerca valore" autocomplete="off"/>
      <label class="ec-cf-all"><input type="checkbox" data-act="all"/> <span>Seleziona tutto</span></label>
      <div class="ec-cf-list" role="group" aria-label="Valori"></div>
      <div class="ec-cf-foot">
        <button type="button" class="btn btn-sm btn-link" data-act="clear">Cancella filtro</button>
        <span class="ms-auto d-flex gap-2">
          <button type="button" class="btn btn-sm" data-act="cancel">Annulla</button>
          <button type="button" class="btn btn-sm btn-primary" data-act="ok">OK</button>
        </span>
      </div>`;
    document.body.appendChild(pop);
    renderList();

    pop.addEventListener('click', e => {
      const a = e.target.closest('[data-act]');
      if (!a || a.tagName === 'INPUT') return;
      const act = a.dataset.act;
      if (act === 'asc' || act === 'desc') { s.sort = { col, dir: act }; close(); changed(key); }
      else if (act === 'nosort') { s.sort = null; close(); changed(key); }
      else if (act === 'clear') { delete s.ex[col]; close(); changed(key); }
      else if (act === 'cancel') close();
      else if (act === 'ok') ok();
    });
    pop.addEventListener('change', e => {
      if (e.target.dataset.act === 'all') {
        const vis = visible();
        if (e.target.checked) vis.forEach(v => cur.checked.add(v)); else vis.forEach(v => cur.checked.delete(v));
        renderList();
      } else if (e.target.dataset.i !== undefined) {
        const v = cur.values[+e.target.dataset.i];
        if (e.target.checked) cur.checked.add(v); else cur.checked.delete(v);
        syncAllBox();
      }
    });
    pop.querySelector('.ec-cf-search').addEventListener('input', e => { cur.q = e.target.value; renderList(); });

    const rc = btn.getBoundingClientRect();
    const w = 264;
    pop.style.left = Math.max(8, Math.min(rc.left, window.innerWidth - w - 8)) + 'px';
    pop.style.top = Math.min(rc.bottom + 4, Math.max(8, window.innerHeight - 440)) + 'px';

    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    pop.querySelector('.ec-cf-search').focus();
  }

  const label = v => v === '' ? '(vuote)' : v;
  function visible() {
    const q = cur.q.toLowerCase().trim();
    return q ? cur.values.filter(v => label(v).toLowerCase().includes(q)) : cur.values;
  }
  function syncAllBox() {
    const box = pop.querySelector('[data-act="all"]');
    const vis = visible();
    const n = vis.filter(v => cur.checked.has(v)).length;
    box.checked = vis.length > 0 && n === vis.length;
    box.indeterminate = n > 0 && n < vis.length;
  }
  function renderList() {
    const vis = visible();
    const list = pop.querySelector('.ec-cf-list');
    const shown = vis.slice(0, MAX_LIST);
    list.innerHTML = shown.map(v => {
      const i = cur.values.indexOf(v);
      return `<label class="ec-cf-item"><input type="checkbox" data-i="${i}" ${cur.checked.has(v) ? 'checked' : ''}/>` +
        `<span class="ec-cf-val${v === '' ? ' is-blank' : ''}" title="${esc(label(v))}">${esc(label(v))}</span>` +
        `<span class="ec-cf-n">${cur.counts.get(v)}</span></label>`;
    }).join('') + (vis.length > shown.length ? `<div class="ec-cf-more">Altri ${vis.length - shown.length} valori: restringi la ricerca</div>` : '')
      + (!vis.length ? '<div class="ec-cf-more">Nessun valore</div>' : '');
    syncAllBox();
  }

  function ok() {
    if (!cur) return;
    const { key, col, values, checked } = cur;
    const s = st(key);
    const ex = new Set(values.filter(v => !checked.has(v)));
    if (ex.size) s.ex[col] = ex; else delete s.ex[col];
    close();
    changed(key);
  }

  return { register, apply, active, clear, th, open, syncAll };
})();
