// ================================================================
// UI helpers — rendering, toast, loaders
// ================================================================
const UI = (() => {

  // ── TOAST ──────────────────────────────── */
  function toast(msg, type = 'info') {
    let box = document.getElementById('ec-toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ec-toasts';
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `ec-toast ec-toast--${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.classList.add('ec-toast--show'), 10);
    setTimeout(() => {
      el.classList.remove('ec-toast--show');
      setTimeout(() => el.remove(), 300);
    }, 3500);
  }

  // ── LOADER overlay ────────────────────────── */
  function showLoader(msg = 'Caricamento…') {
    let el = document.getElementById('ec-loader');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ec-loader';
      el.innerHTML = `<div class="ec-loader__box"><div class="spinner-border text-primary" role="status"></div><p class="mt-2 mb-0 text-muted small">${msg}</p></div>`;
      document.body.appendChild(el);
    } else {
      el.querySelector('p').textContent = msg;
      el.style.display = '';
    }
  }
  function hideLoader() {
    const el = document.getElementById('ec-loader');
    if (el) el.style.display = 'none';
  }

  // ── BADGE ROLE ───────────────────────────── */
  function renderRoleBadge(role) {
    if (role === 'admin') return '<span class="badge bg-blue-lt">Admin</span>';
    if (role === 'top')   return '<span class="badge bg-purple-lt">Top</span>';
    return '<span class="badge bg-secondary-lt">User</span>';
  }

  // ── COLLEAGUE COLORS ──────────────────────── */
  const COLORS = ['blue','green','orange','purple','red','cyan','teal','yellow','pink','indigo'];
  function colleagueColor(colorIdx) {
    return COLORS[colorIdx % COLORS.length] || 'blue';
  }
  function colleagueBadge(name, colorIdx) {
    const c = colleagueColor(colorIdx);
    return `<span class="badge bg-${c}-lt text-${c}">${name}</span>`;
  }

  // ── KPI TILE ───────────────────────────── */
  function kpiTile(label, value, icon, color = 'blue', sub = '') {
    return `
      <div class="col-sm-6 col-xl-3">
        <div class="card card-sm">
          <div class="card-body">
            <div class="row align-items-center">
              <div class="col-auto">
                <span class="bg-${color}-lt avatar">${icon}</span>
              </div>
              <div class="col">
                <div class="font-weight-medium">${value}</div>
                <div class="text-secondary">${label}${sub ? ` <span class="text-muted small">· ${sub}</span>` : ''}</div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ── STATO BADGE ─────────────────────────── */
  function statoBadge(stato) {
    const map = {
      'Stipulata-6': 'bg-green-lt text-green',
      'Liquidata':   'bg-teal-lt text-teal',
      'Pagata':      'bg-cyan-lt text-cyan',
      'Deliberata-4': 'bg-orange-lt text-orange',
      'Deliberata':   'bg-orange-lt text-orange',
    };
    const cls = map[stato] || 'bg-secondary-lt text-secondary';
    return `<span class="badge ${cls}">${stato || '—'}</span>`;
  }

  // ── PROGRESS BAR ───────────────────────── */
  function progressBar(value, min, max, color = 'blue') {
    const total = max || 1;
    const pct = Math.min(100, Math.round((value / total) * 100));
    const cls = value < min ? 'bg-danger' : value >= max ? 'bg-success' : `bg-${color}`;
    return `<div class="progress" style="height:6px">
      <div class="progress-bar ${cls}" style="width:${pct}%" title="${value}/${max}"></div>
    </div>`;
  }

  // ── EMPTY STATE ────────────────────────── */
  function emptyState(icon, msg) {
    return `<div class="empty py-4">
      <div class="empty-icon">${icon}</div>
      <p class="empty-title">${msg}</p>
    </div>`;
  }

  // ── CONFIRM DIALOG ─────────────────────── */
  function confirm(msg) {
    return window.confirm(msg);
  }

  // ── ESCAPE ────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ── STATO DI LAVORAZIONE DELLA PRATICA ──────────────────────────── */
  // note:true  = nota obbligatoria
  // pool       = dove finisce la pratica a fine giornata (ore 19)
  const WORK_STATUSES = {
    conforme:     { label: 'Conforme',               short: 'Conforme',     hex: '#2fb344', note: false, pool: null },
    integrazioni: { label: 'Richiesta integrazioni', short: 'Integrazioni', hex: '#f59f00', note: true,  pool: null },
    da_chiamare:  { label: 'Da chiamare',            short: 'Da chiamare',  hex: '#f76707', note: true,  pool: 'call' },
    audit:        { label: 'Audit',                  short: 'Audit',        hex: '#d63939', note: true,  pool: 'mgmt' },
    help:         { label: 'Help',                   short: 'Help',         hex: '#0ca8c7', note: true,  pool: 'mgmt' },
    xflat:        { label: 'xFlat',                  short: 'xFlat',        hex: '#ae3ec9', note: true,  pool: 'mgmt' },
  };
  const MGMT_STATUSES = ['audit', 'xflat', 'help'];

  function workBadge(status) {
    const s = WORK_STATUSES[status];
    if (!s) return `<span class="text-muted small">—</span>`;
    return `<span class="ec-st-badge"><span class="ec-st-dot" style="background:${s.hex}"></span>${s.label}</span>`;
  }

  // Link diretto alla pratica sul gestionale
  const PRATICA_URL = 'https://finance.blackbird71.com/a/index2.php?modulo=pratiche&azione=apri&opzione=';
  function praticaLink(praticaId) {
    if (!praticaId) return '—';
    return `<a href="${PRATICA_URL}${encodeURIComponent(praticaId)}" target="_blank" rel="noopener" title="Apri la pratica ${esc(praticaId)}">${esc(praticaId)}</a>`;
  }

  // ── GRAFICO A COLONNE (SVG, una serie) ──────────────────────────── */
  // items: [{ label, value, color? }]
  function niceMax(v) {
    if (v <= 5) return 5;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * pow) return m * pow;
    return 10 * pow;
  }
  function barChart(items, opts = {}) {
    const color = opts.color || '#206bc4';
    if (!items.length || items.every(i => !i.value)) {
      return `<div class="ec-chart-empty">${esc(opts.empty || 'Nessun dato nel periodo selezionato')}</div>`;
    }
    const H = opts.height || 240;
    const padL = 40, padR = 12, padT = 22, padB = 46;
    // larghezza logica: il grafico si adatta al contenitore, le colonne restano sottili
    const W = Math.max(opts.width || 560, padL + padR + 56 * items.length);
    const slot = (W - padL - padR) / items.length;
    const plotH = H - padT - padB;
    const max = niceMax(Math.max(...items.map(i => i.value)));
    const ticks = 4;
    const barW = Math.min(24, slot - 16);
    const y = v => padT + plotH - (v / max) * plotH;
    const fmt = n => Number(n).toLocaleString('it-IT');
    const cut = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

    let grid = '';
    for (let i = 0; i <= ticks; i++) {
      const v = (max / ticks) * i, yy = y(v);
      grid += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" class="${i ? 'ec-chart-grid' : 'ec-chart-axis'}"/>` +
              `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" class="ec-chart-tick">${fmt(v)}</text>`;
    }

    const bars = items.map((it, i) => {
      const cx = padL + slot * i + slot / 2;
      const h = Math.max(it.value ? 2 : 0, (it.value / max) * plotH);
      const x = cx - barW / 2, top = padT + plotH - h, r = Math.min(4, h);
      const path = h
        ? `M${x},${padT + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${padT + plotH} Z`
        : '';
      const maxChars = Math.max(6, Math.floor(slot / 6.2));
      const words = String(it.label).split(' ');
      const l1 = words.length > 1 && it.label.length > maxChars ? words.slice(0, Math.ceil(words.length / 2)).join(' ') : it.label;
      const l2 = l1 === it.label ? '' : words.slice(Math.ceil(words.length / 2)).join(' ');
      return `
        <g class="ec-chart-bar" tabindex="0" data-tip-label="${esc(it.label)}" data-tip-value="${esc(fmt(it.value))}">
          <rect x="${cx - slot / 2}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"/>
          ${path ? `<path d="${path}" fill="${it.color || color}"/>` : ''}
          <text x="${cx}" y="${top - 6}" text-anchor="middle" class="ec-chart-value">${fmt(it.value)}</text>
          <text x="${cx}" y="${padT + plotH + 16}" text-anchor="middle" class="ec-chart-label">${esc(cut(l1, maxChars + 2))}</text>
          ${l2 ? `<text x="${cx}" y="${padT + plotH + 29}" text-anchor="middle" class="ec-chart-label">${esc(cut(l2, maxChars + 2))}</text>` : ''}
        </g>`;
    }).join('');

    return `
      <div class="ec-chart">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || 'Grafico')}"
          style="width:100%;min-width:${padL + padR + 48 * items.length}px;max-width:${Math.round(W * 1.3)}px;height:auto">
          ${grid}${bars}
        </svg>
      </div>`;
  }

  // Tooltip unico per i grafici (hover e focus da tastiera)
  let _tipEl = null;
  function _showTip(g, evt) {
    if (!_tipEl) {
      _tipEl = document.createElement('div');
      _tipEl.className = 'ec-chart-tip';
      _tipEl.innerHTML = '<strong></strong><span></span>';
      document.body.appendChild(_tipEl);
    }
    _tipEl.firstChild.textContent = g.dataset.tipValue;
    _tipEl.lastChild.textContent  = g.dataset.tipLabel;
    const r = g.getBoundingClientRect();
    const x = evt && evt.clientX ? evt.clientX : r.left + r.width / 2;
    const yy = evt && evt.clientY ? evt.clientY : r.top + 20;
    _tipEl.style.left = Math.min(window.innerWidth - 180, x + 14) + 'px';
    _tipEl.style.top  = Math.max(8, yy - 12) + 'px';
    _tipEl.style.display = 'block';
  }
  function _hideTip() { if (_tipEl) _tipEl.style.display = 'none'; }
  document.addEventListener('pointermove', e => {
    const g = e.target.closest && e.target.closest('.ec-chart-bar');
    if (g) _showTip(g, e); else _hideTip();
  });
  document.addEventListener('focusin',  e => { const g = e.target.closest && e.target.closest('.ec-chart-bar'); if (g) _showTip(g); });
  document.addEventListener('focusout', _hideTip);

  // ── AVATAR INIZIALI (per chat/note) ────────────────── */
  function initialsAvatar(name) {
    const n = (name || '?').trim();
    const initials = n.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
    return initials;
  }

  function timeAgo(iso) {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'ora';
    if (mins < 60) return `${mins}m fa`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h fa`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}g fa`;
    return d.toLocaleDateString('it-IT');
  }

  return {
    toast, showLoader, hideLoader,
    renderRoleBadge, colleagueColor, colleagueBadge,
    kpiTile, statoBadge, progressBar, emptyState, confirm,
    esc, WORK_STATUSES, MGMT_STATUSES, workBadge, praticaLink, barChart,
    initialsAvatar, timeAgo,
    COLORS,
  };
})();
