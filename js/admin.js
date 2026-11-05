// ================================================================
// Admin panel — colleghi, filtri stato, config, upload, utenti
// ================================================================
const Admin = (() => {

  let _colleagues      = [];
  let _stateFilters    = [];
  let _users           = [];
  let _agentExclusions = [];

  // ── INIT ─────────────────────────────────────────────────────────
  async function init() {
    [_colleagues, _stateFilters, _users, _agentExclusions] = await Promise.all([
      DB.getColleagues(),
      DB.getStateFilters(),
      DB.getUsers(),
      DB.getAgentExclusions(),
    ]);
    renderColleagues();
    renderStateFilters();
    renderUsers();
    renderAgentExclusions();
    await renderWorkingDays();
  }

  // ── COLLEGHI ─────────────────────────────────────────────────────
  function renderColleagues() {
    const tbody = document.getElementById('admin-colleagues-tbody');
    if (!tbody) return;
    if (!_colleagues.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-3">Nessun collega</td></tr>`;
      return;
    }
    tbody.innerHTML = _colleagues.map(c => `
      <tr data-id="${c.id}">
        <td>
          <div class="d-flex align-items-center gap-2">
            <span class="avatar avatar-sm bg-${UI.colleagueColor(c.color_idx)}-lt">${c.name[0]}</span>
            <strong>${c.name}</strong>
          </div>
        </td>
        <td><span class="badge ${c.active ? 'bg-success-lt text-success' : 'bg-secondary-lt'}">${c.active ? 'Attivo' : 'Disattivo'}</span></td>
        <td>${c.min_quota} – ${c.max_quota}</td>
        <td class="text-muted small">${(c.primary_tipologie || []).join(', ') || '—'}</td>
        <td class="text-muted small">${(c.secondary_tipologie || []).join(', ') || '—'}</td>
        <td>
          <button class="btn btn-sm btn-ghost-secondary" onclick="Admin.openColleagueModal('${c.id}')">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-sm btn-ghost-danger" onclick="Admin.deleteColleague('${c.id}')">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </td>
      </tr>`).join('');
  }

  function openColleagueModal(id) {
    const c = id ? _colleagues.find(x => x.id === id) : null;
    const modal = document.getElementById('modal-colleague');
    if (!modal) return;

    modal.querySelector('[name=col-id]').value       = c?.id || '';
    modal.querySelector('[name=col-name]').value     = c?.name || '';
    modal.querySelector('[name=col-active]').checked = c ? c.active : true;
    modal.querySelector('[name=col-min]').value      = c?.min_quota ?? 30;
    modal.querySelector('[name=col-max]').value      = c?.max_quota ?? 60;
    modal.querySelector('[name=col-color]').value    = c?.color_idx ?? 0;
    modal.querySelector('[name=col-primary]').value  = (c?.primary_tipologie || []).join('\n');
    modal.querySelector('[name=col-secondary]').value= (c?.secondary_tipologie || []).join('\n');
    modal.querySelector('[name=col-sort]').value     = c?.sort_order ?? _colleagues.length;

    const bsModal = bootstrap.Modal.getOrCreateInstance(modal);
    bsModal.show();
  }

  async function saveColleague() {
    const modal = document.getElementById('modal-colleague');
    const id   = modal.querySelector('[name=col-id]').value.trim();
    const name = modal.querySelector('[name=col-name]').value.trim();
    if (!name) { UI.toast('Nome obbligatorio', 'danger'); return; }

    const col = {
      id:                  id || 'c' + Date.now(),
      name,
      active:              modal.querySelector('[name=col-active]').checked,
      min_quota:           parseInt(modal.querySelector('[name=col-min]').value) || 0,
      max_quota:           parseInt(modal.querySelector('[name=col-max]').value) || 60,
      color_idx:           parseInt(modal.querySelector('[name=col-color]').value) || 0,
      primary_tipologie:   modal.querySelector('[name=col-primary]').value.split('\n').map(s => s.trim()).filter(Boolean),
      secondary_tipologie: modal.querySelector('[name=col-secondary]').value.split('\n').map(s => s.trim()).filter(Boolean),
      sort_order:          parseInt(modal.querySelector('[name=col-sort]').value) || 0,
    };

    try {
      await DB.upsertColleague(col);
      bootstrap.Modal.getOrCreateInstance(modal).hide();
      _colleagues = await DB.getColleagues();
      renderColleagues();
      UI.toast('Collega salvato', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  async function deleteColleague(id) {
    if (!UI.confirm('Eliminare questo collega?')) return;
    try {
      await DB.deleteColleague(id);
      _colleagues = await DB.getColleagues();
      renderColleagues();
      UI.toast('Collega eliminato', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  // ── STATE FILTERS ─────────────────────────────────────────────────
  const MODE_LABELS = { any: '—', empty: '○', filled: '●' };
  const MODE_NEXT   = { any: 'empty', empty: 'filled', filled: 'any' };

  function renderStateFilters() {
    const tbody = document.getElementById('admin-filters-tbody');
    if (!tbody) return;
    tbody.innerHTML = _stateFilters.map(f => `
      <tr>
        <td>${f.stato}</td>
        <td>
          <input type="checkbox" class="form-check-input" ${f.included ? 'checked' : ''}
            onchange="Admin.toggleFilterIncluded('${f.stato}', this.checked)">
        </td>
        <td>
          <button class="btn btn-sm btn-ghost-secondary font-monospace" style="min-width:2rem"
            onclick="Admin.cycleFilterMode('${f.stato}','note_mode')" title="Note">${MODE_LABELS[f.note_mode]}</button>
        </td>
        <td>
          <button class="btn btn-sm btn-ghost-secondary font-monospace" style="min-width:2rem"
            onclick="Admin.cycleFilterMode('${f.stato}','conf_mode')" title="Conformità">${MODE_LABELS[f.conf_mode]}</button>
        </td>
      </tr>`).join('');
  }

  async function toggleFilterIncluded(stato, included) {
    const f = _stateFilters.find(x => x.stato === stato);
    if (!f) return;
    f.included = included;
    await DB.upsertStateFilter(f);
  }

  async function cycleFilterMode(stato, field) {
    const f = _stateFilters.find(x => x.stato === stato);
    if (!f) return;
    f[field] = MODE_NEXT[f[field]];
    await DB.upsertStateFilter(f);
    renderStateFilters();
  }

  // ── WORKING DAYS ─────────────────────────────────────────────────
  async function renderWorkingDays() {
    const cfg = await DB.getConfig();
    const el = document.getElementById('admin-working-days');
    if (el) el.value = cfg.working_days ?? 1;
  }

  async function saveWorkingDays() {
    const el = document.getElementById('admin-working-days');
    const v = parseInt(el?.value) || 1;
    await DB.setConfig('working_days', v);
    UI.toast('Giorni lavorativi salvati', 'success');
  }

  // ── USERS ─────────────────────────────────────────────────────────
  function renderUsers() {
    const tbody = document.getElementById('admin-users-tbody');
    if (!tbody) return;
    tbody.innerHTML = _users.map(u => `
      <tr>
        <td>${u.email}</td>
        <td>${u.full_name || '—'}</td>
        <td>${UI.renderRoleBadge(u.role)}</td>
        <td>
          <select class="form-select form-select-sm" style="width:auto"
            onchange="Admin.setUserRole('${u.id}', this.value)">
            <option value="user"  ${u.role === 'user'  ? 'selected' : ''}>User</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </td>
      </tr>`).join('');
  }

  async function setUserRole(userId, role) {
    try {
      await DB.setUserRole(userId, role);
      _users = await DB.getUsers();
      renderUsers();
      UI.toast('Ruolo aggiornato', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  // ── AGENTI ESCLUSI ───────────────────────────────────────────────
  function renderAgentExclusions() {
    const container = document.getElementById('admin-agent-exclusions-list');
    if (!container) return;
    if (!_agentExclusions.length) {
      container.innerHTML = '<span class="text-muted small">Nessun agente escluso</span>';
      return;
    }
    container.innerHTML = _agentExclusions.map(ae => `
      <span class="badge bg-danger-lt text-danger me-1 mb-1">
        ${ae.agent_name}
        <a href="#" class="ms-1 text-danger" onclick="Admin.removeAgentExclusion('${ae.id}');return false;">×</a>
      </span>`).join('');
  }

  async function addAgentExclusion() {
    const inp = document.getElementById('admin-agent-exclusion-input');
    const name = inp?.value.trim();
    if (!name) return;
    try {
      await DB.addAgentExclusion(name);
      inp.value = '';
      _agentExclusions = await DB.getAgentExclusions();
      renderAgentExclusions();
      UI.toast(`Agente "${name}" escluso`, 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  async function removeAgentExclusion(id) {
    try {
      await DB.deleteAgentExclusion(id);
      _agentExclusions = await DB.getAgentExclusions();
      renderAgentExclusions();
      UI.toast('Agente rimosso dalle esclusioni', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  return {
    init,
    openColleagueModal, saveColleague, deleteColleague,
    toggleFilterIncluded, cycleFilterMode,
    saveWorkingDays, renderWorkingDays,
    setUserRole,
    addAgentExclusion, removeAgentExclusion,
  };
})();
