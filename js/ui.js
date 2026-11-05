// ================================================================
// UI helpers — rendering, toast, loaders
// ================================================================
const UI = (() => {

  // ── TOAST ────────────────────────────────────────────────────────
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `ec-toast ec-toast--${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('ec-toast--show'), 10);
    setTimeout(() => {
      el.classList.remove('ec-toast--show');
      setTimeout(() => el.remove(), 300);
    }, 3500);
  }

  // ── LOADER overlay ───────────────────────────────────────────────
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

  // ── BADGE ROLE ───────────────────────────────────────────────────
  function renderRoleBadge(role) {
    return role === 'admin'
      ? '<span class="badge bg-blue-lt">Admin</span>'
      : '<span class="badge bg-secondary-lt">User</span>';
  }

  // ── COLLEAGUE COLORS ─────────────────────────────────────────────
  const COLORS = ['blue','green','orange','purple','red','cyan','teal','yellow','pink','indigo'];
  function colleagueColor(colorIdx) {
    return COLORS[colorIdx % COLORS.length] || 'blue';
  }
  function colleagueBadge(name, colorIdx) {
    const c = colleagueColor(colorIdx);
    return `<span class="badge bg-${c}-lt text-${c}">${name}</span>`;
  }

  // ── KPI TILE ─────────────────────────────────────────────────────
  function kpiTile(label, value, icon, color = 'blue') {
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
                <div class="text-secondary">${label}</div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ── STATO BADGE ──────────────────────────────────────────────────
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

  // ── PROGRESS BAR ─────────────────────────────────────────────────
  function progressBar(value, min, max, color = 'blue') {
    const total = max || 1;
    const pct = Math.min(100, Math.round((value / total) * 100));
    const cls = value < min ? 'bg-danger' : value >= max ? 'bg-success' : `bg-${color}`;
    return `<div class="progress" style="height:6px">
      <div class="progress-bar ${cls}" style="width:${pct}%" title="${value}/${max}"></div>
    </div>`;
  }

  // ── EMPTY STATE ──────────────────────────────────────────────────
  function emptyState(icon, msg) {
    return `<div class="empty py-4">
      <div class="empty-icon">${icon}</div>
      <p class="empty-title">${msg}</p>
    </div>`;
  }

  // ── CONFIRM DIALOG ───────────────────────────────────────────────
  function confirm(msg) {
    return window.confirm(msg);
  }

  // ── STATO PRATICA (verde/giallo/arancione/rosso/viola/azzurro) ────
  const STATUS_COLORS = {
    verde:     { label: 'Conforme',               hex: '#2fb344' },
    giallo:    { label: 'Richiesta integrazioni',  hex: '#f59f00' },
    arancione: { label: 'Da chiamare',             hex: '#f76707' },
    rosso:     { label: 'Audit',                   hex: '#d63939' },
    viola:     { label: 'Xflat',                   hex: '#ae3ec9' },
    azzurro:   { label: 'Help',                    hex: '#0ca8c7' },
  };
  function statusDot(color) {
    if (!color || !STATUS_COLORS[color]) {
      return `<span class="status-dot status-dot-empty" title="Nessuno stato"></span>`;
    }
    const s = STATUS_COLORS[color];
    return `<span class="status-dot" style="background:${s.hex}" title="${s.label}"></span>`;
  }
  function statusBadge(color) {
    if (!color || !STATUS_COLORS[color]) return `<span class="text-muted small">—</span>`;
    const s = STATUS_COLORS[color];
    return `<span class="badge" style="background:${s.hex};color:#fff">${s.label}</span>`;
  }

  // ── AVATAR INIZIALI (per chat/note) ───────────────────────────────
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
    STATUS_COLORS, statusDot, statusBadge, initialsAvatar, timeAgo,
    COLORS,
  };
})();
