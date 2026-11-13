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
  const HEX = { blue: '#3b82f6', green: '#22a559', orange: '#f76707', purple: '#a855f7', red: '#e03131', cyan: '#15aabf',
                teal: '#12b3a8', yellow: '#f5b301', pink: '#d6336c', indigo: '#5c6ac4' };
  const colleagueHex = idx => HEX[COLORS[idx % COLORS.length]] || HEX.blue;
  function colleagueColor(colorIdx) {
    return COLORS[colorIdx % COLORS.length] || 'blue';
  }
  function colleagueBadge(name, colorIdx) {
    const c = colleagueColor(colorIdx);
    return `<span class="badge bg-${c}-lt text-${c}">${name}</span>`;
  }

  // ── KPI TILE ───────────────────────────── */
  function kpiTile(label, value, icon, color = 'blue', sub = '', go = '') {
    const inner = `
        <div class="ec-kpi-top">
          <span class="ec-kpi-icon">${icon}</span>
          <span class="ec-kpi-value">${value}</span>
        </div>
        <div class="ec-kpi-label">${label}${sub ? ` <span class="ec-kpi-sub">· ${sub}</span>` : ''}</div>`;
    return go
      ? `<a href="#" class="ec-kpi ec-kpi--${color} ec-kpi--link" onclick="${go};return false;">${inner}</a>`
      : `<div class="ec-kpi ec-kpi--${color}">${inner}</div>`;
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


  // ── GRAFICO A LINEE (cartesiano, curve morbide, una serie per utente) ─────
  // Il disegno viene fatto alla larghezza reale del contenitore (mountLineCharts),
  // cosi' testi e punti restano nitidi su qualsiasi schermo.
  const _lines = {};        // id -> { labels, series, off:Set }
  function lineChart(id, labels, series, opts = {}) {
    const prevOff = _lines[id] ? _lines[id].off : new Set();
    _lines[id] = { labels, series, off: prevOff, height: opts.height || 330, title: opts.title || 'Grafico' };
    const empty = !series.length || series.every(s => s.values.every(v => !v));
    const legend = series.map(s => `
      <button type="button" class="ec-leg${prevOff.has(s.key) ? ' is-off' : ''}" data-chart="${esc(id)}" data-series="${esc(s.key)}" style="--c:${s.color}">
        <span class="ec-leg-box"></span>${esc(s.name)}
      </button>`).join('');
    return `
      <div class="ec-line-wrap" data-chart-wrap="${esc(id)}">
        ${empty ? `<div class="ec-chart-empty">${esc(opts.empty || 'Nessun dato nel periodo selezionato')}</div>` : `
        <div class="ec-legend">${legend}</div>
        <div class="ec-line" data-chart="${esc(id)}"></div>`}
      </div>`;
  }

  // Curva monotona (niente overshoot sotto lo zero)
  function _smooth(pts) {
    const n = pts.length;
    if (n < 2) return n ? `M${pts[0][0]},${pts[0][1]}` : '';
    const dx = [], dy = [], m = [];
    for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0]); dy.push(pts[i + 1][1] - pts[i][1]); m.push(dy[i] / dx[i]); }
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
    t.push(m[n - 2]);
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += ` C${pts[i][0] + h},${pts[i][1] + t[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - t[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
    }
    return d;
  }

  function _drawLine(box) {
    const c = _lines[box.dataset.chart];
    if (!c) return;
    const W = Math.max(320, Math.round(box.clientWidth || 640)), H = W < 560 ? 280 : c.height;
    const padL = 46, padR = 40, padT = 16, padB = 36;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const n = c.labels.length;
    const vis = c.series.filter(s => !c.off.has(s.key));
    const max = niceMax(Math.max(1, ...(vis.length ? vis : c.series).flatMap(s => s.values)));
    const ticks = 5, step = max / ticks;
    const x = i => padL + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
    const y = v => padT + plotH - (v / max) * plotH;
    const fmt = v => Number(v).toLocaleString('it-IT');

    let grid = '';
    for (let i = 0; i <= ticks; i++) {
      const yy = y(step * i);
      grid += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" class="${i ? 'ec-chart-grid' : 'ec-chart-axis'}"/>` +
              `<text x="${padL - 10}" y="${yy + 4}" text-anchor="end" class="ec-chart-tick">${fmt(step * i)}</text>`;
    }
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 84))));
    let xs = '';
    c.labels.forEach((l, i) => {
      xs += `<line x1="${x(i)}" x2="${x(i)}" y1="${padT}" y2="${padT + plotH}" class="ec-chart-grid ec-chart-vgrid"/>`;
      if (i % every === 0 || i === n - 1) {
        const lab = plotW / n < 78 ? l.slice(0, 5) : l;
        xs += `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" class="ec-chart-tick">${esc(lab)}</text>`;
      }
    });

    const lines = c.series.map(s => {
      const pts = s.values.map((v, i) => [x(i), y(v)]);
      return `
        <g class="ec-line-series" data-series="${esc(s.key)}" style="--c:${s.color}"${c.off.has(s.key) ? ' hidden' : ''}>
          <path d="${_smooth(pts)}" class="ec-line-path" stroke="${s.color}"/>
          ${pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="4" class="ec-line-dot" stroke="${s.color}"/>`).join('')}
        </g>`;
    }).join('');

    box.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(c.title)}" class="ec-line-svg" data-chart="${esc(box.dataset.chart)}"
        data-pl="${padL}" data-pw="${plotW}">
        ${grid}${xs}
        <line class="ec-line-guide" y1="${padT}" y2="${padT + plotH}" x1="0" x2="0" style="display:none"/>
        ${lines}
        <rect x="${padL - 10}" y="${padT}" width="${plotW + 20}" height="${plotH}" fill="transparent" class="ec-line-hit"/>
      </svg>`;
    box.dataset.w = W;
  }

  function mountLineCharts(root = document) {
    root.querySelectorAll('.ec-line[data-chart]').forEach(box => {
      _drawLine(box);
      if (typeof ResizeObserver === 'function') {
        if (box._ro) box._ro.disconnect();
        let t = null;
        box._ro = new ResizeObserver(() => {
          clearTimeout(t);
          t = setTimeout(() => { if (box.isConnected && Math.abs((box.clientWidth || 0) - Number(box.dataset.w || 0)) > 8) _drawLine(box); }, 120);
        });
        box._ro.observe(box);
      }
    });
  }

  // Interazione: legenda (mostra/nascondi serie) e tooltip con tutte le serie del giorno
  let _lineTip = null;
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.ec-leg');
    if (!b) return;
    const c = _lines[b.dataset.chart];
    if (!c) return;
    const k = b.dataset.series;
    if (c.off.has(k)) c.off.delete(k); else c.off.add(k);
    if (c.off.size >= c.series.length) c.off.clear();
    b.closest('[data-chart-wrap]').querySelectorAll('.ec-leg').forEach(x => x.classList.toggle('is-off', c.off.has(x.dataset.series)));
    const box = b.closest('[data-chart-wrap]').querySelector('.ec-line');
    if (box) _drawLine(box);
  });
  function _hideLineTip() {
    if (_lineTip) _lineTip.style.display = 'none';
    document.querySelectorAll('.ec-line-guide').forEach(g => { g.style.display = 'none'; });
  }
  document.addEventListener('pointermove', e => {
    const svg = e.target.closest && e.target.closest('.ec-line-svg');
    if (!svg) { _hideLineTip(); return; }
    const c = _lines[svg.dataset.chart];
    if (!c) return;
    const r = svg.getBoundingClientRect();
    const scale = (svg.viewBox.baseVal.width || r.width) / r.width;
    const padL = +svg.dataset.pl, plotW = +svg.dataset.pw, n = c.labels.length;
    const lx = (e.clientX - r.left) * scale;
    const i = Math.max(0, Math.min(n - 1, n === 1 ? 0 : Math.round(((lx - padL) / plotW) * (n - 1))));
    const gx = padL + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
    const g = svg.querySelector('.ec-line-guide');
    g.setAttribute('x1', gx); g.setAttribute('x2', gx); g.style.display = '';
    if (!_lineTip) { _lineTip = document.createElement('div'); _lineTip.className = 'ec-chart-tip ec-line-tip'; document.body.appendChild(_lineTip); }
    const rows = c.series.filter(s => !c.off.has(s.key)).map(s => ({ s, v: s.values[i] || 0 })).sort((a, b) => b.v - a.v);
    _lineTip.innerHTML = `<div class="ec-tip-date">${esc(c.labels[i])}</div>` + rows.map(({ s, v }) =>
      `<div class="ec-tip-row"><span class="ec-tip-sw" style="background:${s.color}"></span><span>${esc(s.name)}</span><strong>${Number(v).toLocaleString('it-IT')}</strong></div>`).join('');
    _lineTip.style.display = 'block';
    const tw = _lineTip.offsetWidth, th = _lineTip.offsetHeight;
    let left = e.clientX + 16, top = e.clientY - th / 2;
    if (left + tw > window.innerWidth - 8) left = e.clientX - tw - 16;
    _lineTip.style.left = left + 'px'; _lineTip.style.top = Math.max(8, Math.min(top, window.innerHeight - th - 8)) + 'px';
  });
  document.addEventListener('pointerout', e => { if (!e.relatedTarget) _hideLineTip(); });

  return {
    toast, showLoader, hideLoader,
    renderRoleBadge, colleagueColor, colleagueBadge,
    kpiTile, statoBadge, progressBar, emptyState, confirm,
    esc, WORK_STATUSES, MGMT_STATUSES, workBadge, praticaLink, barChart, lineChart, mountLineCharts, colleagueHex,
    initialsAvatar, timeAgo,
    COLORS,
  };
})();
