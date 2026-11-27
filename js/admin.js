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
  let _agentiList      = [];   // distinct agenti dalle pratiche (suggerimenti)

  // Stato del modal collega aperto al momento
  let _modalColleagueId = null;
  let _modalPrimary     = new Set();
  let _modalSecondary   = new Set();
  let _modalFilters     = {}; // stato -> { included, note_mode, conf_mode }
  let _modalExcluded    = [];  // agenti esclusi per questo collega
  let _modalSally       = [];  // agenti Sally dedicati a questo collega
  let _modalSallyOnly   = false;

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
    await renderWorkingDays();
    renderVerifica();
    sallyRegLoad();
    watchLoad();
  }

  // ── COLLEGHI ─────────────────────────────── */
  function sallyBadge(id) {
    const d = dedicatedMap()[id];
    if (!d) return '';
    return `<span class="badge bg-orange-lt text-orange" title="Agenti Sally: ${UI.esc(d.agents.join(', '))}">${d.agents.length} agenti Sally${d.only ? ' · solo questi' : ''}</span>`;
  }

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
            ${(c.excluded_agents || []).length ? `<span class="badge bg-danger-lt text-danger" title="Agenti esclusi: ${UI.esc(c.excluded_agents.join(', '))}">${c.excluded_agents.length} agenti esclusi</span>` : ''}
            ${sallyBadge(c.id)}
          </div>
        </td>
        <td><span class="badge ${c.active ? 'bg-success-lt text-success' : 'bg-secondary-lt'}">${c.active ? 'Attivo' : 'Disattivo'}</span></td>
        <td>${c.min_quota} – ${c.max_quota}</td>
        <td class="text-muted small">${(c.primary_tipologie || []).join(', ') || '—'}</td>
        <td class="text-muted small">${(c.secondary_tipologie || []).join(', ') || '—'}</td>
      </tr>`).join('');
  }

  let _modalSeq = 0;
  async function openColleagueModal(id) {
    const c = id ? _colleagues.find(x => x.id === id) : null;
    const modal = document.getElementById('modal-colleague');
    if (!modal) return;

    _modalColleagueId = id || null;
    _modalPrimary   = new Set(c?.primary_tipologie || []);
    _modalSecondary = new Set(c?.secondary_tipologie || []);
    _modalExcluded  = [...(c?.excluded_agents || [])];
    const ded = (id && dedicatedMap()[id]) || null;
    _modalSally     = ded ? [...ded.agents] : [];
    _modalSallyOnly = !!(ded && ded.only);
    sallyCancel();
    { const ta = document.getElementById('col-sally-paste'); if (ta) ta.value = ''; }

    modal.querySelector('[name=col-id]').value       = c?.id || '';
    modal.querySelector('[name=col-name]').value     = c?.name || '';
    modal.querySelector('[name=col-active]').checked = c ? c.active : true;
    modal.querySelector('[name=col-min]').value      = c?.min_quota ?? 30;
    modal.querySelector('[name=col-max]').value      = c?.max_quota ?? 60;
    modal.querySelector('[name=col-color]').value    = c?.color_idx ?? 0;
    modal.querySelector('[name=col-sort]').value     = c?.sort_order ?? _colleagues.length;

    document.getElementById('modal-colleague-title').textContent = c ? `Collega — ${c.name}` : 'Nuovo collega';
    document.getElementById('btn-delete-colleague').style.display = c ? '' : 'none';

    // Filtri stato di default (tutti inclusi): il modal si apre subito, il resto arriva in background
    _modalFilters = {};
    for (const stato of _canonicalStates) {
      _modalFilters[stato] = { stato, included: true, note_mode: 'empty', conf_mode: 'empty' };
    }
    const seq = ++_modalSeq;
    const fillTipologie = () => {
      const extra = new Set([..._modalPrimary, ..._modalSecondary]);
      renderModalTipologie(Array.from(new Set([..._tipologieList, ...extra])).sort((a, b) => a.localeCompare(b, 'it')));
    };
    if (_tipologieList.length) fillTipologie();
    else {
      const msg = '<span class="text-muted small">Caricamento…</span>';
      document.getElementById('col-primary-list').innerHTML = msg;
      document.getElementById('col-secondary-list').innerHTML = msg;
    }
    renderModalFilters();
    renderModalExcluded();
    renderModalSally();
    const dl = document.getElementById('col-agents-datalist');
    const fillAgenti = () => { if (dl) dl.innerHTML = _agentiList.map(a => `<option value="${UI.esc(a)}"></option>`).join(''); };
    fillAgenti();

    bootstrap.Modal.getOrCreateInstance(modal).show();

    // Dati pesanti in parallelo, senza bloccare l'apertura
    const jobs = [];
    if (!_tipologieList.length) jobs.push(DB.getDistinctTipologie().then(l => { _tipologieList = l; if (seq === _modalSeq) fillTipologie(); }).catch(() => {}));
    if (!_agentiList.length) jobs.push(DB.getDistinctAgenti().then(l => { _agentiList = l; if (seq === _modalSeq) fillAgenti(); }).catch(() => {}));
    if (id) jobs.push(DB.getColleagueStateFilters(id).then(rows => {
      if (seq !== _modalSeq) return;
      for (const r of rows) _modalFilters[r.stato] = { stato: r.stato, included: r.included, note_mode: r.note_mode, conf_mode: r.conf_mode };
      renderModalFilters();
    }).catch(() => {}));
    await Promise.all(jobs);
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

  // ── Agenti esclusi per il singolo collega ─────────────────────── */
  function renderModalExcluded() {
    const el = document.getElementById('col-excluded-agents');
    if (!el) return;
    if (!_modalExcluded.length) {
      el.innerHTML = '<span class="text-muted small">Nessun agente escluso</span>';
      return;
    }
    el.innerHTML = _modalExcluded.map((a, i) => `
      <span class="badge bg-danger-lt text-danger me-1 mb-1">
        ${UI.esc(a)}
        <a href="#" class="ms-1 text-danger" title="Rimuovi" onclick="Admin.removeModalExcludedAgent(${i});return false;">×</a>
      </span>`).join('');
  }

  function addModalExcludedAgent() {
    const inp = document.getElementById('col-excluded-agent-input');
    const name = (inp?.value || '').trim();
    if (!name) return;
    if (!_modalExcluded.some(a => a.toLowerCase() === name.toLowerCase())) _modalExcluded.push(name);
    inp.value = '';
    renderModalExcluded();
    inp.focus();
  }

  function removeModalExcludedAgent(idx) {
    _modalExcluded.splice(idx, 1);
    renderModalExcluded();
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
      excluded_agents:     [..._modalExcluded],
      sort_order:          parseInt(modal.querySelector('[name=col-sort]').value) || 0,
    };

    try {
      const res = await DB.upsertColleague(col);
      // Agenti Sally del collega (in app_config.colleague_agents; salva anche la conversione dalla vecchia configurazione)
      const map = { ...dedicatedMap() };
      if (_modalSally.length) map[colleagueId] = { agents: [..._modalSally], only: _modalSallyOnly };
      else delete map[colleagueId];
      if (JSON.stringify(map) !== JSON.stringify(_config.colleague_agents)) {
        await DB.setConfig('colleague_agents', map);
        _config.colleague_agents = map;
      }
      const filterRows = _canonicalStates.map(stato => {
        const f = _modalFilters[stato] || { included: true, note_mode: 'empty', conf_mode: 'empty' };
        return { stato, included: f.included, note_mode: f.note_mode, conf_mode: f.conf_mode };
      });
      if (filterRows.length) await DB.saveColleagueStateFilters(colleagueId, filterRows);

      bootstrap.Modal.getOrCreateInstance(modal).hide();
      _colleagues = await DB.getColleagues();
      renderColleagues();
      if (res && res.partial && _modalExcluded.length) {
        UI.toast('Collega salvato, ma gli agenti esclusi richiedono la migration SQL del piano di lavoro', 'warning');
      } else {
        UI.toast('Collega salvato. Filtri e tipologie valgono per le nuove assegnazioni: per applicarli ai piani già assegnati premi Ricalcola', 'success');
      }
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
      const map = { ...dedicatedMap() };
      if (map[id]) { delete map[id]; await DB.setConfig('colleague_agents', map); _config.colleague_agents = map; }
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

  // ── TABELLA VERIFICA DOCUMENTI (popup Modelli) ─────────── */
  function renderVerifica() {
    const v = _config.verifica_documenti || Modelli.defaults();
    const p = document.getElementById('admin-verifica-persons');
    const d = document.getElementById('admin-verifica-docs');
    if (p) p.value = (v.persons || []).join('\n');
    if (d) d.value = (v.groups || []).map(g => `[${g.g}]\n${(g.d || []).join('\n')}`).join('\n\n');
  }

  function parseVerifica() {
    const persons = document.getElementById('admin-verifica-persons').value.split('\n').map(s => s.trim()).filter(Boolean);
    const groups = [];
    let cur = null;
    for (const raw of document.getElementById('admin-verifica-docs').value.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^\[(.+)\]$/);
      if (m) { cur = { g: m[1].trim(), d: [] }; groups.push(cur); }
      else {
        if (!cur) { cur = { g: 'Documenti', d: [] }; groups.push(cur); }
        cur.d.push(line);
      }
    }
    return { persons, groups: groups.filter(g => g.d.length) };
  }

  async function saveVerifica() {
    const v = parseVerifica();
    if (!v.persons.length || !v.groups.length) { UI.toast('Servono almeno una colonna e un documento', 'warning'); return; }
    try {
      await DB.setConfig('verifica_documenti', v);
      _config.verifica_documenti = v;
      renderVerifica();
      UI.toast('Tabella verifica salvata', 'success');
    } catch (e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  async function resetVerifica() {
    try {
      await DB.setConfig('verifica_documenti', null);
      delete _config.verifica_documenti;
      renderVerifica();
      UI.toast('Tabella verifica ripristinata', 'success');
    } catch (e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  // ── AGENTI SALLY per collega (nella scheda del collega) ─────── */
  const lcn = x => (x || '').toLowerCase().trim();
  // Quante pratiche del report attivo hanno ciascun agente (match su Agente attuale, senza maiuscole/spazi)
  function sallyCounts() {
    const list = window.App && window.App.getPractices ? window.App.getPractices() : [];
    const m = {};
    for (const p of list) { const k = lcn(p.agente_attuale); if (k) m[k] = (m[k] || 0) + 1; }
    return { m, hasReport: list.length > 0 };
  }
  const dedicatedMap = () => Engine.dedicatedFromConfig(_config, _agentExclusions);
  // Altro collega a cui l'agente e' gia' dedicato (null se libero)
  function sallyOwner(name, exceptId) {
    const k = lcn(name);
    for (const [cid, v] of Object.entries(dedicatedMap())) {
      if (cid !== exceptId && v.agents.some(a => lcn(a) === k)) return (_colleagues.find(c => c.id === cid) || {}).name || cid;
    }
    return null;
  }

  function renderModalSally() {
    const list = document.getElementById('col-sally-list');
    if (!list) return;
    const { m, hasReport } = sallyCounts();
    if (!_modalSally.length) {
      list.innerHTML = '<span class="text-muted small">Nessun agente Sally</span>';
    } else {
      list.innerHTML = _modalSally.map((a, i) => {
        const n = m[lcn(a)] || 0;
        const miss = hasReport && !n;
        const cnt = hasReport ? `<span class="ms-1 fw-normal">· ${n}</span>` : '';
        const tip = hasReport ? (miss ? 'Nessuna pratica con questo agente nel report attivo: controlla il nome' : `${n} pratiche nel report attivo`) : '';
        return `<span class="badge ${miss ? 'bg-secondary-lt text-secondary' : 'bg-danger-lt text-danger'} me-1 mb-1" title="${UI.esc(tip)}">
          ${UI.esc(a)}${cnt}
          <a href="#" class="ms-1 ${miss ? 'text-secondary' : 'text-danger'}" onclick="Admin.removeModalSally(${i});return false;" aria-label="Rimuovi ${UI.esc(a)}">×</a>
        </span>`;
      }).join('') + (hasReport ? '<div class="text-muted small mt-1">Il numero è quante pratiche del report attivo hanno quell\'agente; in grigio = nessuna corrispondenza.</div>' : '');
    }
    const only = document.getElementById('col-sally-only');
    if (only) { only.checked = _modalSallyOnly && _modalSally.length > 0; only.disabled = !_modalSally.length; }
    const st = document.getElementById('col-sally-status');
    if (st) {
      const total = _modalSally.reduce((n, a) => n + (m[lcn(a)] || 0), 0);
      const num = hasReport ? ` (${total} pratiche nel report attivo)` : '';
      st.innerHTML = !_modalSally.length ? ''
        : _modalSallyOnly ? `<span class="text-success">Questo collega riceve solo le pratiche dei suoi agenti${num}, negli stati attivi qui sopra.</span>`
        : `<span class="text-success">Le pratiche dei suoi agenti vanno a lui${num}, negli stati attivi qui sopra; in più riceve le pratiche normali per le sue tipologie.</span>`;
    }
  }

  function addModalSally(nameArg) {
    const inp = document.getElementById('col-sally-input');
    const name = String(nameArg != null ? nameArg : (inp?.value || '')).trim();
    if (!name) return false;
    if (_modalSally.some(a => lcn(a) === lcn(name))) { if (inp) inp.value = ''; return false; }
    const other = sallyOwner(name, _modalColleagueId);
    if (other) { UI.toast(`"${name}" è già un agente Sally di ${other}`, 'warning'); return false; }
    _modalSally.push(name);
    if (inp) { inp.value = ''; inp.focus(); }
    renderModalSally();
    return true;
  }

  function removeModalSally(idx) {
    _modalSally.splice(idx, 1);
    if (!_modalSally.length) _modalSallyOnly = false;
    renderModalSally();
  }

  function setModalSallyOnly(on) {
    _modalSallyOnly = !!on;
    renderModalSally();
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
        <td class="text-nowrap">
          ${u.id !== (Auth.getRealProfile()?.id) ? `<button class="btn btn-sm btn-outline-warning me-1" title="Entra come questo utente" onclick="Admin.impersonate('${u.id}')">Impersonifica</button>` : ''}
          <button class="btn btn-sm btn-outline-secondary me-1" title="Imposta una nuova password per questo utente" onclick="Admin.setUserPassword('${u.id}')">Password</button>
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

  async function setUserPassword(userId) {
    const u = _users.find(x => x.id === userId);
    if (!u) return;
    const pw = window.prompt(`Nuova password per ${u.email} (minimo 6 caratteri):`);
    if (pw === null) return;
    if (pw.length < 6) { UI.toast('La password deve avere almeno 6 caratteri', 'warning'); return; }
    try {
      await DB.adminSetPassword(userId, pw);
      UI.toast('Password impostata: comunicala all\'utente', 'success');
    } catch (e) {
      UI.toast(/admin_set_password|function/i.test(e.message) ? 'Funzione SQL mancante: esegui lo script in Supabase' : 'Errore: ' + e.message, 'danger');
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

  // ── IMPORT LISTA AGENTI SALLY (con suggerimenti per nomi simili) ──── */
  let _sallyPlan = [];
  const nrm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const lc = s => String(s || '').toLowerCase().trim();

  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m || !n) return Math.max(m, n);
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const ratio = (a, b) => { const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 1; };

  // Somiglianza tra due nomi normalizzati (0..1): ordine delle parole, iniziali, refusi
  function nameScore(a, b) {
    if (a === b) return 1;
    const ta = a.split(' '), tb = b.split(' ');
    let best = Math.max(ratio(a, b), ratio([...ta].sort().join(' '), [...tb].sort().join(' ')));
    const [s, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    let sum = 0;
    for (const t of s) {
      let m = 0;
      for (const u of l) {
        let v = t === u ? 1 : ((t.length === 1 || u.length === 1) && t[0] === u[0]) ? 0.9 : ratio(t, u);
        if (v < 0.8) v = 0;
        if (v > m) m = v;
      }
      sum += m;
    }
    return Math.max(best, (sum / s.length) * Math.sqrt(s.length / l.length));
  }

  function parseNames(text) {
    let parts = String(text || '').split(/[\n;\t]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 1 && parts[0].includes(',')) parts = parts[0].split(',').map(s => s.trim()).filter(Boolean);
    const seen = new Set();
    return parts.filter(p => { const k = lc(p); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  async function sallyAnalyze() {
    const names = parseNames(document.getElementById('col-sally-paste')?.value);
    const box = document.getElementById('col-sally-review');
    if (!box) return;
    if (!names.length) { box.innerHTML = ''; _sallyPlan = []; UI.toast('Incolla almeno un nome', 'warning'); return; }
    let agents = [];
    try { agents = await DB.getDistinctAgenti(); } catch (e) { /* senza report: nessun suggerimento */ }
    const inList = new Set(_modalSally.map(lc));
    _sallyPlan = names.map(name => {
      const key = lc(name), n = nrm(name);
      const exact = agents.filter(x => lc(x) === key);
      const similar = agents.filter(x => lc(x) !== key)
        .map(x => ({ value: x, score: nameScore(n, nrm(x)) }))
        .filter(x => x.score >= 0.72).sort((p, q) => q.score - p.score).slice(0, 6);
      const opts = [];
      exact.forEach(x => opts.push({ value: x, kind: 'exact', checked: true }));
      const strong = !exact.length && similar.length && similar[0].score >= 0.9;
      if (!exact.length) opts.push({ value: name, kind: 'asis', checked: !strong });
      similar.forEach((x, i) => opts.push({ value: x.value, kind: 'similar', score: x.score, checked: strong && i === 0 }));
      opts.forEach(o => {
        o.inList = inList.has(lc(o.value));
        o.other = sallyOwner(o.value, _modalColleagueId);
        if (o.inList || o.other) o.checked = false;
      });
      return { name, found: exact.length > 0, opts };
    });
    renderSallyReview();
  }

  function renderSallyReview() {
    const box = document.getElementById('col-sally-review');
    if (!box) return;
    let i = 0;
    const rows = _sallyPlan.map(item => {
      const badge = item.found ? '<span class="badge bg-success-lt text-success">Nei report</span>'
        : '<span class="badge bg-warning-lt text-warning">Non trovato nei report</span>';
      const opts = item.opts.map(o => {
        const id = i++;
        const off = o.inList || o.other;
        const label = o.kind === 'asis' ? `Aggiungi come scritto: <strong>${UI.esc(o.value)}</strong>`
          : o.kind === 'exact' ? `<strong>${UI.esc(o.value)}</strong>`
          : `${UI.esc(o.value)} <span class="badge bg-azure-lt text-azure">simile ${Math.round(o.score * 100)}%</span>`;
        const note = o.inList ? ' <em>(già in lista)</em>' : o.other ? ` <em>(già di ${UI.esc(o.other)})</em>` : '';
        return `<label class="ec-sally-opt${off ? ' is-off' : ''}">
          <input type="checkbox" data-sally="${id}" ${o.checked ? 'checked' : ''} ${off ? 'disabled' : ''}/>
          <span>${label}${note}</span></label>`;
      }).join('');
      return `<tr><td class="text-nowrap">${UI.esc(item.name)}<div>${badge}</div></td><td>${opts}</td></tr>`;
    }).join('');
    box.innerHTML = `
      <div class="table-responsive"><table class="table table-sm ec-sally-rev">
        <thead><tr><th>Nome incollato</th><th>Nomi da aggiungere (spunta quelli giusti)</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <button type="button" class="btn btn-danger" onclick="Admin.sallyApply()">Aggiungi i nomi selezionati</button>
      <button type="button" class="btn btn-ghost-secondary ms-2" onclick="Admin.sallyCancel()">Annulla</button>`;
  }

  function sallyCancel() {
    _sallyPlan = [];
    const box = document.getElementById('col-sally-review');
    if (box) box.innerHTML = '';
  }

  function sallyApply() {
    const flat = _sallyPlan.flatMap(x => x.opts);
    let n = 0;
    document.querySelectorAll('#col-sally-review input[data-sally]:checked').forEach(el => {
      const o = flat[+el.dataset.sally];
      if (o && addModalSally(o.value)) n++;
    });
    if (!n) { UI.toast('Nessun nome selezionato', 'warning'); return; }
    sallyCancel();
    const ta = document.getElementById('col-sally-paste');
    if (ta) ta.value = '';
    UI.toast(`${n} agenti aggiunti (salva il collega per confermare)`, 'success');
  }


  // ── REGISTRO SALLY: pratiche gia' controllate (escluse dai nuovi report) ──── */
  // ── AGENTI CON OCCHIO DI RIGUARDO ─────────────────── */
  let _watch = [];
  const lcw = x => String(x || '').toLowerCase().trim();
  async function watchLoad() {
    _watch = Array.isArray(_config.watched_agents) ? _config.watched_agents.map(w => ({ name: w.name, note: w.note || '', colleague_id: w.colleague_id || '' })) : [];
    const dl = document.getElementById('watch-agents-dl');
    if (dl && !dl.children.length) DB.getDistinctAgenti().then(l => { dl.innerHTML = l.map(x => `<option value="${UI.esc(x)}"></option>`).join(''); }).catch(() => {});
    const sel = document.getElementById('watch-col');
    if (sel) sel.innerHTML = '<option value="">Nessuna assegnazione</option>' + _colleagues.filter(c => c.active).map(c => `<option value="${UI.esc(c.id)}">${UI.esc(c.name)}</option>`).join('');
    watchRender();
  }
  function watchRender() {
    const tb = document.getElementById('watch-tbody'), cnt = document.getElementById('watch-count');
    if (cnt) cnt.textContent = _watch.length;
    if (!tb) return;
    if (!_watch.length) { tb.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">Nessun agente in elenco</td></tr>'; return; }
    const opts = sel => '<option value="">Nessuna assegnazione</option>' + _colleagues.filter(c => c.active || c.id === sel)
      .map(c => `<option value="${UI.esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${UI.esc(c.name)}</option>`).join('');
    tb.innerHTML = _watch.map((w, i) => `
      <tr>
        <td><strong class="text-danger">${UI.esc(w.name)}</strong></td>
        <td><input type="text" class="form-control form-control-sm" value="${UI.esc(w.note)}" maxlength="300" placeholder="Nota" onchange="Admin.watchEdit(${i}, 'note', this.value)"/></td>
        <td><select class="form-select form-select-sm" style="min-width:180px" onchange="Admin.watchEdit(${i}, 'colleague_id', this.value)">${opts(w.colleague_id)}</select></td>
        <td><button type="button" class="btn btn-sm btn-outline-danger" onclick="Admin.watchRemove(${i})">Rimuovi</button></td>
      </tr>`).join('');
  }
  async function watchSave() {
    await DB.setConfig('watched_agents', _watch);
    _config.watched_agents = _watch.map(w => ({ ...w }));
  }
  async function watchAdd() {
    const name = document.getElementById('watch-name').value.trim();
    if (!name) { UI.toast('Scrivi il nome dell\'agente', 'warning'); return; }
    if (_watch.some(w => lcw(w.name) === lcw(name))) { UI.toast('Agente già in elenco', 'warning'); return; }
    _watch.push({ name, note: document.getElementById('watch-note').value.trim(), colleague_id: document.getElementById('watch-col').value || '' });
    try {
      await watchSave();
      ['watch-name', 'watch-note'].forEach(id => { document.getElementById(id).value = ''; });
      document.getElementById('watch-col').value = '';
      watchRender();
      UI.toast('Agente aggiunto', 'success');
    } catch (e) { _watch.pop(); UI.toast('Errore salvataggio: ' + e.message, 'danger'); }
  }
  async function watchEdit(i, field, value) {
    if (!_watch[i]) return;
    const prev = _watch[i][field];
    _watch[i][field] = value.trim ? value.trim() : value;
    try { await watchSave(); UI.toast('Salvato', 'success'); }
    catch (e) { _watch[i][field] = prev; watchRender(); UI.toast('Errore salvataggio: ' + e.message, 'danger'); }
  }
  async function watchRemove(i) {
    const w = _watch[i];
    if (!w || !UI.confirm(`Togliere ${w.name} dall'elenco?`)) return;
    _watch.splice(i, 1);
    try { await watchSave(); watchRender(); } catch (e) { _watch.splice(i, 0, w); UI.toast('Errore salvataggio: ' + e.message, 'danger'); }
  }

  let _sallyReg = [];
  const fmtDay = iso => iso ? new Date(iso).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

  async function sallyRegLoad() {
    const tb = document.getElementById('sally-reg-tbody');
    if (!tb) return;
    try {
      _sallyReg = (await DB.getSallyChecked()).sort((a, b) => String(b.checked_at).localeCompare(String(a.checked_at)));
      sallyRegRender();
    } catch (e) {
      tb.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-3">${DB.isMissingSchema(e)
        ? 'Da attivare: esegui la migration 20261121000000_sally_checked.sql nel SQL Editor di Supabase.' : UI.esc('Errore: ' + e.message)}</td></tr>`;
    }
  }

  function sallyRegRender() {
    const tb = document.getElementById('sally-reg-tbody');
    if (!tb) return;
    const q = lcn(document.getElementById('sally-reg-q')?.value);
    const list = q ? _sallyReg.filter(r => [r.pratica_id, r.agente, r.checked_by_name].some(v => lcn(v).includes(q))) : _sallyReg;
    const cnt = document.getElementById('sally-reg-count');
    if (cnt) cnt.textContent = _sallyReg.length;
    const MAX = 300;
    tb.innerHTML = list.slice(0, MAX).map(r => `
      <tr>
        <td class="font-monospace">${UI.esc(r.pratica_id)}</td>
        <td>${UI.esc(r.agente) || '—'}</td>
        <td>${r.status ? UI.workBadge(r.status) : '—'}</td>
        <td>${fmtDay(r.checked_at)}</td>
        <td>${UI.esc(r.checked_by_name) || '—'}</td>
        <td class="text-muted small">${r.source === 'manual' ? 'Manuale' : 'Controllo'}</td>
        <td class="text-end"><a href="#" class="text-danger" title="Togli dal registro" onclick="Admin.sallyRegRemove('${UI.esc(r.pratica_id)}');return false;">×</a></td>
      </tr>`).join('') || '<tr><td colspan="7" class="text-center text-muted py-3">Nessuna pratica nel registro</td></tr>';
    const foot = document.getElementById('sally-reg-foot');
    if (foot) foot.textContent = list.length > MAX ? `Mostrate ${MAX} di ${list.length}: usa la ricerca per restringere.` : '';
  }

  async function sallyRegSync() {
    try {
      const ded = Engine.dedicatedFromConfig(_config, _agentExclusions);
      const ag = [], co = [];
      for (const [cid, d] of Object.entries(ded)) for (const a of d.agents || []) { ag.push(lcn(a)); co.push(cid); }
      if (!ag.length) { UI.toast('Nessun agente Sally configurato nei colleghi', 'warning'); return; }
      const n = await DB.sallySync(ag, co);
      await sallyRegLoad();
      UI.toast(n ? `${n} pratiche aggiunte o aggiornate nel registro` : 'Registro già aggiornato', 'success');
    } catch (e) {
      UI.toast(DB.isMissingSchema(e) ? 'Esegui prima la migration 20261121000000_sally_checked.sql in Supabase' : 'Errore: ' + e.message, 'danger');
    }
  }

  async function sallyRegAdd() {
    const ids = [...new Set((document.getElementById('sally-reg-ids')?.value || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean))];
    if (!ids.length) { UI.toast('Incolla almeno un ID pratica', 'warning'); return; }
    const agente = (document.getElementById('sally-reg-agent')?.value || '').trim();
    const have = new Set(_sallyReg.map(r => r.pratica_id));
    const rows = ids.filter(id => !have.has(id)).map(id => ({
      pratica_id: id, agente, status: '', checked_at: new Date().toISOString(),
      checked_by: Auth.getProfile()?.id || null, checked_by_name: 'Aggiunta manuale', source: 'manual',
    }));
    if (!rows.length) { UI.toast('Gli ID sono già nel registro', 'info'); return; }
    try {
      await DB.addSallyChecked(rows);
      document.getElementById('sally-reg-ids').value = '';
      await sallyRegLoad();
      UI.toast(`${rows.length} pratiche aggiunte al registro`, 'success');
    } catch (e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  async function sallyRegRemove(id) {
    if (!UI.confirm(`Togliere la pratica ${id} dal registro? Potrà rientrare nei prossimi report.`)) return;
    try {
      await DB.deleteSallyChecked([id]);
      _sallyReg = _sallyReg.filter(r => r.pratica_id !== id);
      sallyRegRender();
    } catch (e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  return {
    init,
    openColleagueModal, saveColleague, deleteColleague,
    toggleModalTipologia, toggleModalFilterIncluded, cycleModalFilterMode,
    addModalExcludedAgent, removeModalExcludedAgent,
    saveWorkingDays, renderWorkingDays, saveVerifica, resetVerifica,
    addModalSally, removeModalSally, setModalSallyOnly,
    setUserRole, setUserColleague, setUserPassword, approveUser, rejectUser,
    impersonate: id => Auth.impersonate(id),
    sallyAnalyze, sallyApply, sallyCancel,
    sallyRegSync, sallyRegAdd, sallyRegRemove, sallyRegRender,
    watchAdd, watchEdit, watchRemove,
  };
})();
