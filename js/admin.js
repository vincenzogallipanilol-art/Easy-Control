// ================================================================
// Admin panel — colleghi, filtri stato per collega, Agenti Sally,
// config, upload, utenti
// ================================================================
const Admin = (() => {

  let _colleagues      = [];
  let _users           = [];
  let _agentExclusions = [];
  let _config          = {};
  let _canonicalStates = [];   // lista nomi stato (da state_filters, solo come elenco)
  let _tipologieList   = [];   // distinct tipologie dalle pratiche

  // Stato del modal collega aperto al momento
  let _modalColleagueId = null;
  let _modalPrimary     = new Set();
  let _modalSecondary   = new Set();
  let _modalFilters     = {}; // stato -> { included, note_mode, conf_mode }

  // ── INIT ──────────────────────────────── */
  async function init() {
    [_colleagues, _users, _agentExclusions, _config, _canonicalStates] = await Promise.all([
      DB.getColleagues(),
      DB.getUsers(),
      DB.getAgentExclusions(),
      DB.getConfig(),
      DB.getStateFilters().then(rows => rows.map(r => r.stato)),
    ]);
    renderColleagues();
    renderPendingUsers();
    renderUsers();
    renderAgentExclusions();
    renderSallyHook();
    await renderWorkingDays();
  }

  // ── COLLEGHI ─────────────────────────────── */
  function renderColleagues() {
    const tbody = document.getElementById('admin-colleagues-tbody');
    if (!tbody) return;
    if (!_colleagues.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-3">Nessun collega</td></tr>`;
      return;
    }
    tbody.innerHTML = _colleagues.map(c => `
      <tr data-id="${c.id}" class="ec-row-clickable" onclick="Admin.openColleagueModal('${c.id}')">
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
      </tr>`).join('');
  }

  async function openColleagueModal(id) {
    const c = id ? _colleagues.find(x => x.id === id) : null;
    const modal = document.getElementById('modal-colleague');
    if (!modal) return;

    _modalColleagueId = id || null;
    _modalPrimary   = new Set(c?.primary_tipologie || []);
    _modalSecondary = new Set(c?.secondary_tipologie || []);

    modal.querySelector('[name=col-id]').value       = c?.id || '';
    modal.querySelector('[name=col-name]').value     = c?.name || '';
    modal.querySelector('[name=col-active]').checked = c ? c.active : true;
    modal.querySelector('[name=col-min]').value      = c?.min_quota ?? 30;
    modal.querySelector('[name=col-max]').value      = c?.max_quota ?? 60;
    modal.querySelector('[name=col-color]').value    = c?.color_idx ?? 0;
    modal.querySelector('[name=col-sort]').value     = c?.sort_order ?? _colleagues.length;

    document.getElementById('modal-colleague-title').textContent = c ? `Collega — ${c.name}` : 'Nuovo collega';
    document.getElementById('btn-delete-colleague').style.display = c ? '' : 'none';

    // Carica (se serve) la lista distinct tipologie
    if (!_tipologieList.length) {
      try { _tipologieList = await DB.getDistinctTipologie(); } catch(e) { /* non bloccante */ }
    }
    // Includi eventuali tipologie già assegnate ma non più presenti nelle pratiche correnti
    const extra = new Set([..._modalPrimary, ..._modalSecondary]);
    const fullList = Array.from(new Set([..._tipologieList, ...extra])).sort((a,b) => a.localeCompare(b,'it'));
    renderModalTipologie(fullList);

    // Filtri stato di questo collega (default: tutti inclusi, modalità 'empty')
    _modalFilters = {};
    for (const stato of _canonicalStates) {
      _modalFilters[stato] = { stato, included: true, note_mode: 'empty', conf_mode: 'empty' };
    }
    if (id) {
      try {
        const rows = await DB.getColleagueStateFilters(id);
        for (const r of rows) _modalFilters[r.stato] = { stato: r.stato, included: r.included, note_mode: r.note_mode, conf_mode: r.conf_mode };
      } catch(e) { /* non bloccante */ }
    }
    renderModalFilters();

    const bsModal = bootstrap.Modal.getOrCreateInstance(modal);
    bsModal.show();
  }

  function renderModalTipologie(list) {
    const primEl = document.getElementById('col-primary-list');
    const secEl  = document.getElementById('col-secondary-list');
    if (!primEl || !secEl) return;
    if (!list.length) {
      const msg = '<span class="text-muted small">Nessuna tipologia trovata nelle pratiche caricate finora.</span>';
      primEl.innerHTML = msg; secEl.innerHTML = msg;
      return;
    }
    const row = (t, set, which) => `
      <label class="form-check">
        <input type="checkbox" class="form-check-input" ${set.has(t) ? 'checked' : ''}
          onchange="Admin.toggleModalTipologia('${which}', '${t.replace(/'/g,"\\'")}', this.checked)">
        <span class="form-check-label small">${t}</span>
      </label>`;
    primEl.innerHTML = list.map(t => row(t, _modalPrimary, 'primary')).join('');
    secEl.innerHTML  = list.map(t => row(t, _modalSecondary, 'secondary')).join('');
  }

  function toggleModalTipologia(which, tipologia, checked) {
    const set = which === 'primary' ? _modalPrimary : _modalSecondary;
    if (checked) set.add(tipologia); else set.delete(tipologia);
  }

  const MODE_LABELS = { any: '—', empty: '○', filled: '●' };
  const MODE_NEXT   = { any: 'empty', empty: 'filled', filled: 'any' };

  function renderModalFilters() {
    const tbody = document.getElementById('col-filters-tbody');
    if (!tbody) return;
    if (!_canonicalStates.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted small py-2">Nessuno stato configurato</td></tr>`;
      return;
    }
    tbody.innerHTML = _canonicalStates.map(stato => {
      const f = _modalFilters[stato] || { included: true, note_mode: 'empty', conf_mode: 'empty' };
      return `
      <tr>
        <td class="small">${stato}</td>
        <td>
          <input type="checkbox" class="form-check-input" ${f.included ? 'checked' : ''}
            onchange="Admin.toggleModalFilterIncluded('${stato.replace(/'/g,"\\'")}', this.checked)">
        </td>
        <td>
          <button type="button" class="btn btn-sm btn-ghost-secondary font-monospace" style="min-width:2rem"
            onclick="Admin.cycleModalFilterMode('${stato.replace(/'/g,"\\'")}','note_mode')" title="Note">${MODE_LABELS[f.note_mode]}</button>
        </td>
        <td>
          <button type="button" class="btn btn-sm btn-ghost-secondary font-monospace" style="min-width:2rem"
            onclick="Admin.cycleModalFilterMode('${stato.replace(/'/g,"\\'")}','conf_mode')" title="Conformità">${MODE_LABELS[f.conf_mode]}</button>
        </td>
      </tr>`;
    }).join('');
  }

  function toggleModalFilterIncluded(stato, checked) {
    if (!_modalFilters[stato]) _modalFilters[stato] = { stato, included: true, note_mode: 'empty', conf_mode: 'empty' };
    _modalFilters[stato].included = checked;
  }

  function cycleModalFilterMode(stato, field) {
    if (!_modalFilters[stato]) _modalFilters[stato] = { stato, included: true, note_mode: 'empty', conf_mode: 'empty' };
    _modalFilters[stato][field] = MODE_NEXT[_modalFilters[stato][field]];
    renderModalFilters();
  }

  async function saveColleague() {
    const modal = document.getElementById('modal-colleague');
    const id   = modal.querySelector('[name=col-id]').value.trim();
    const name = modal.querySelector('[name=col-name]').value.trim();
    if (!name) { UI.toast('Nome obbligatorio', 'danger'); return; }

    const colleagueId = id || 'c' + Date.now();
    const col = {
      id:                  colleagueId,
      name,
      active:              modal.querySelector('[name=col-active]').checked,
      min_quota:           parseInt(modal.querySelector('[name=col-min]').value) || 0,
      max_quota:           parseInt(modal.querySelector('[name=col-max]').value) || 60,
      color_idx:           parseInt(modal.querySelector('[name=col-color]').value) || 0,
      primary_tipologie:   Array.from(_modalPrimary),
      secondary_tipologie: Array.from(_modalSecondary),
      sort_order:          parseInt(modal.querySelector('[name=col-sort]').value) || 0,
    };

    try {
      await DB.upsertColleague(col);
      const filterRows = _canonicalStates.map(stato => {
        const f = _modalFilters[stato] || { included: true, note_mode: 'empty', conf_mode: 'empty' };
        return { stato, included: f.included, note_mode: f.note_mode, conf_mode: f.conf_mode };
      });
      if (filterRows.length) await DB.saveColleagueStateFilters(colleagueId, filterRows);

      bootstrap.Modal.getOrCreateInstance(modal).hide();
      _colleagues = await DB.getColleagues();
      renderColleagues();
      UI.toast('Collega salvato', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  async function deleteColleague(id) {
    id = id || _modalColleagueId;
    if (!id) return;
    if (!UI.confirm('Eliminare questo collega?')) return;
    try {
      await DB.deleteColleague(id);
      const modal = document.getElementById('modal-colleague');
      if (modal) bootstrap.Modal.getOrCreateInstance(modal).hide();
      _colleagues = await DB.getColleagues();
      renderColleagues();
      UI.toast('Collega eliminato', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  // ── WORKING DAYS ──────────────────────────── */
  async function renderWorkingDays() {
    const el = document.getElementById('admin-working-days');
    if (el) el.value = _config.working_days ?? 1;
  }

  async function saveWorkingDays() {
    const el = document.getElementById('admin-working-days');
    const v = parseInt(el?.value) || 1;
    await DB.setConfig('working_days', v);
    UI.toast('Giorni lavorativi salvati', 'success');
  }

  // ── AGENTI SALLY (pool agganciabile a un collega) ─────────── */
  function renderSallyHook() {
    const sel = document.getElementById('admin-sally-hook');
    if (!sel) return;
    const hooked = _config.sally_hook_colleague_id || '';
    sel.innerHTML = `
      <option value="">— nessun aggancio (pool separata) —</option>
      ${_colleagues.map(c => `<option value="${c.id}" ${hooked === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}`;
  }

  async function setSallyHook(colleagueId) {
    try {
      await DB.setConfig('sally_hook_colleague_id', colleagueId || null);
      _config.sally_hook_colleague_id = colleagueId || null;
      UI.toast(colleagueId ? 'Pool Agenti Sally agganciata' : 'Aggancio rimosso — pool separata', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  // ── UTENTI IN ATTESA (nuove registrazioni da approvare) ─────── */
  function renderPendingUsers() {
    const wrap = document.getElementById('admin-pending-users-wrap');
    const tbody = document.getElementById('admin-pending-users-tbody');
    if (!wrap || !tbody) return;

    const pending = _users.filter(u => u.status === 'pending');
    wrap.style.display = pending.length ? '' : 'none';
    if (!pending.length) return;

    tbody.innerHTML = pending.map(u => `
      <tr data-pending-id="${u.id}">
        <td>${u.email}</td>
        <td>${u.full_name || '—'}</td>
        <td>
          <select class="form-select form-select-sm" style="width:auto" id="pending-col-${u.id}">
            <option value="">— nessuno —</option>
            ${_colleagues.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
          </select>
        </td>
        <td class="text-nowrap">
          <button class="btn btn-sm btn-success" onclick="Admin.approveUser('${u.id}')">Approva</button>
          <button class="btn btn-sm btn-ghost-danger" onclick="Admin.rejectUser('${u.id}')">Rifiuta</button>
        </td>
      </tr>`).join('');
  }

  async function approveUser(userId) {
    const sel = document.getElementById(`pending-col-${userId}`);
    const colleagueId = sel?.value || null;
    try {
      await DB.approveUser(userId, colleagueId);
      _users = await DB.getUsers();
      renderPendingUsers();
      renderUsers();
      UI.toast('Utente approvato', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  async function rejectUser(userId) {
    if (!UI.confirm("Riportare l'utente in attesa? Non potrà usare l'app finché non viene approvato di nuovo.")) return;
    try {
      await DB.rejectUser(userId);
      _users = await DB.getUsers();
      renderPendingUsers();
      renderUsers();
      UI.toast('Utente rimesso in attesa', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  // ── USERS ────────────────────────────────── */
  function renderUsers() {
    const tbody = document.getElementById('admin-users-tbody');
    if (!tbody) return;
    const approved = _users.filter(u => u.status !== 'pending');
    tbody.innerHTML = approved.map(u => `
      <tr>
        <td>${u.email}</td>
        <td>${u.full_name || '—'}</td>
        <td>${UI.renderRoleBadge(u.role)}</td>
        <td>
          <select class="form-select form-select-sm" style="width:auto"
            onchange="Admin.setUserRole('${u.id}', this.value)">
            <option value="user"  ${u.role === 'user'  ? 'selected' : ''}>User</option>
            <option value="top"   ${u.role === 'top'   ? 'selected' : ''}>Top</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </td>
        <td>
          <select class="form-select form-select-sm" style="width:auto"
            onchange="Admin.setUserColleague('${u.id}', this.value)">
            <option value="">— nessuno —</option>
            ${_colleagues.map(c => `<option value="${c.id}" ${u.colleague_id === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
          </select>
        </td>
        <td>
          <button class="btn btn-sm btn-ghost-secondary" title="Rimetti in attesa" onclick="Admin.rejectUser('${u.id}')">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </button>
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

  async function setUserColleague(userId, colleagueId) {
    try {
      await DB.setUserColleague(userId, colleagueId);
      _users = await DB.getUsers();
      renderUsers();
      UI.toast('Collega aggiornato', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  // ── AGENTI SALLY (lista nomi agente) ────────────────── */
  function renderAgentExclusions() {
    const container = document.getElementById('admin-agent-exclusions-list');
    if (!container) return;
    if (!_agentExclusions.length) {
      container.innerHTML = '<span class="text-muted small">Nessun agente in lista</span>';
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
      UI.toast(`Agente "${name}" aggiunto`, 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  async function removeAgentExclusion(id) {
    try {
      await DB.deleteAgentExclusion(id);
      _agentExclusions = await DB.getAgentExclusions();
      renderAgentExclusions();
      UI.toast('Agente rimosso dalla lista', 'success');
    } catch(e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  return {
    init,
    openColleagueModal, saveColleague, deleteColleague,
    toggleModalTipologia, toggleModalFilterIncluded, cycleModalFilterMode,
    saveWorkingDays, renderWorkingDays,
    setSallyHook,
    setUserRole, setUserColleague, approveUser, rejectUser,
    addAgentExclusion, removeAgentExclusion,
  };
})();
