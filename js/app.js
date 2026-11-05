// ================================================================
// App — orchestrazione principale
// ================================================================
(async () => {

  // 1. Verifica sessione
  const session = await Auth.requireAuth('index.html');
  if (!session) return;

  const profile = Auth.getProfile();
  const isAdmin = Auth.isAdmin();

  // 2. Mostra/nascondi elementi admin
  document.querySelectorAll('[data-admin-only]').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  document.getElementById('user-name-display').textContent = profile.full_name || profile.email;
  document.getElementById('user-role-badge').innerHTML = UI.renderRoleBadge(profile.role);

  // 3. Navigazione SPA
  const navLinks = document.querySelectorAll('[data-nav]');
  const sections = document.querySelectorAll('[data-section]');

  function navigate(target) {
    navLinks.forEach(l => l.classList.toggle('active', l.dataset.nav === target));
    sections.forEach(s => s.style.display = s.dataset.section === target ? '' : 'none');
    history.replaceState(null, '', '#' + target);

    if (target === 'admin' && isAdmin) Admin.init();
  }

  navLinks.forEach(l => l.addEventListener('click', e => {
    e.preventDefault();
    navigate(l.dataset.nav);
  }));

  // Restore from hash
  const initialHash = location.hash.replace('#', '') || 'dashboard';
  navigate(initialHash);

  // 4. Logout
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await Auth.signOut();
    window.location.href = 'index.html';
  });

  // 5. Carica report attivo
  let activeReport     = null;
  let practices        = [];
  let assignments      = {};  // practice_id → assignment
  let colleagues       = [];
  let stateFilters     = [];
  let config           = {};
  let agentExclusions  = [];

  async function loadActiveReport() {
    UI.showLoader('Caricamento report…');
    try {
      [activeReport, colleagues, stateFilters, config, agentExclusions] = await Promise.all([
        DB.getActiveReport(),
        DB.getColleagues(),
        DB.getStateFilters(),
        DB.getConfig(),
        DB.getAgentExclusions(),
      ]);

      if (!activeReport) {
        renderNoReport();
        return;
      }

      practices = await DB.getPractices(activeReport.id);
      const assignList = await DB.getAssignments(activeReport.id);
      assignments = {};
      for (const a of assignList) assignments[a.practice_id] = a;

      renderDashboard();
      renderPool();
      renderDistribution();
      subscribeRealtime();
    } catch(e) {
      UI.toast('Errore caricamento: ' + e.message, 'danger');
    } finally {
      UI.hideLoader();
    }
  }

  // 6. Real-time handlers
  function subscribeRealtime() {
    if (!activeReport) return;
    Realtime.subscribe(activeReport.id, {
      onAssignment(payload) {
        const { eventType, new: row, old } = payload;
        if (eventType === 'DELETE') {
          delete assignments[old.practice_id];
        } else {
          assignments[row.practice_id] = row;
        }
        renderDashboard();
        renderPool();
        renderDistribution();
      },
      onNewReport(newReport) {
        if (newReport.id !== activeReport?.id) {
          UI.toast('Nuovo report caricato — aggiorno…', 'info');
          setTimeout(loadActiveReport, 1000);
        }
      },
      onColleaguesChange() { DB.getColleagues().then(d => { colleagues = d; renderDistribution(); }); },
      onAgentExclusionsChange() { DB.getAgentExclusions().then(d => { agentExclusions = d; renderDistribution(); }); },
    });
  }

  // 7. RICALCOLA (admin only)
  document.getElementById('btn-ricalcola')?.addEventListener('click', async () => {
    if (!activeReport) return;
    if (!UI.confirm('Ricalcolare le assegnazioni automatiche? Quelle manuali verranno mantenute.')) return;
    UI.showLoader('Ricalcolo in corso…');
    try {
      const manualAssignments = Object.values(assignments).filter(a => a.is_manual);
      await DB.deleteAutoAssignments(activeReport.id);

      const { autoAssignments } = Engine.distribute(
        practices, colleagues, stateFilters, config.working_days || 1, manualAssignments, agentExclusions
      );

      if (autoAssignments.length) {
        const { data: { user } } = await db.auth.getUser();
        await DB.bulkUpsertAssignments(autoAssignments.map(a => ({
          ...a, assigned_by: user.id,
        })));
      }
      UI.toast(`Ricalcolo completato: ${autoAssignments.length} assegnazioni`, 'success');
    } catch(e) {
      UI.toast('Errore ricalcolo: ' + e.message, 'danger');
    } finally {
      UI.hideLoader();
    }
  });

  // 8. UPLOAD REPORT (admin only)
  document.getElementById('btn-upload-report')?.addEventListener('click', () => {
    document.getElementById('input-report-file')?.click();
  });

  document.getElementById('input-report-file')?.addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;
    this.value = '';
    await uploadReport(file);
  });

  async function uploadReport(file) {
    UI.showLoader('Caricamento CSV…');
    try {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, delimiter: ';', skipEmptyLines: true });
      if (!parsed.data.length) throw new Error('File vuoto o formato non valido');

      const report = await DB.createReport(file.name, parsed.data.length);

      const rows = parsed.data.map(r => ({
        report_id:                report.id,
        pratica_id:               r['Numero pratica'] || r['pratica_id'] || '',
        cognome:                  r['Cognome'] || r['cognome'] || '',
        nome:                     r['Nome'] || r['nome'] || '',
        note:                     r['Note'] || r['note'] || '',
        tipologia:                r['Tipologia'] || r['tipologia'] || '',
        istituto_finanziario:     r['Istituto finanziario'] || r['istituto_finanziario'] || '',
        agente_attuale:           r['Agente attuale'] || r['agente_attuale'] || '',
        area_manager:             r['Area Manager'] || r['area_manager'] || '',
        group_manager:            r['Group Manager'] || r['group_manager'] || '',
        team_manager:             r['Team Manager'] || r['team_manager'] || '',
        stato_attuale:            r['Stato Attuale'] || r['stato_attuale'] || '',
        conformita_documentazione:r['Conformità Documentazione'] || r['conformita_documentazione'] || '',
        originale_archiviato:     r['Originale Archiviato'] || r['originale_archiviato'] || '',
        pratica_fea:              r['Pratica FEA'] || r['pratica_fea'] || '',
      }));

      UI.showLoader(`Inserimento ${rows.length} pratiche…`);
      await DB.insertPractices(rows);

      // Auto-distribuisci subito
      UI.showLoader('Distribuzione automatica…');
      await loadActiveReport();

      const { autoAssignments } = Engine.distribute(
        practices, colleagues, stateFilters, config.working_days || 1, [], agentExclusions
      );
      if (autoAssignments.length) {
        const { data: { user } } = await db.auth.getUser();
        await DB.bulkUpsertAssignments(autoAssignments.map(a => ({ ...a, assigned_by: user.id })));
      }

      UI.toast(`Report caricato: ${rows.length} pratiche, ${autoAssignments.length} assegnate`, 'success');
      await loadActiveReport();
    } catch(e) {
      UI.toast('Errore upload: ' + e.message, 'danger');
    } finally {
      UI.hideLoader();
    }
  }

  // 9. RENDER functions
  function renderNoReport() {
    const el = document.getElementById('dashboard-content');
    if (el) el.innerHTML = UI.emptyState(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
      isAdmin ? 'Nessun report attivo. Carica un CSV per iniziare.' : 'Nessun report attivo. Contatta un admin.'
    );
  }

  function renderDashboard() {
    const el = document.getElementById('dashboard-content');
    if (!el || !activeReport) return;

    const { kpi } = Engine.distribute(
      practices, colleagues, stateFilters, config.working_days || 1,
      Object.values(assignments).filter(a => a.is_manual), agentExclusions
    );

    const assignedCount = Object.keys(assignments).length;
    const regularPool   = practices.length - assignedCount - kpi.excluded;

    el.innerHTML = `
      <div class="row g-3 mb-4">
        ${UI.kpiTile('Pratiche totali',   practices.length,       iconDoc(),      'blue')}
        ${UI.kpiTile('Assegnate',         assignedCount,          iconCheck(),    'green')}
        ${UI.kpiTile('In Pool',           Math.max(0, regularPool), iconPool(),   'orange')}
        ${agentExclusions.length ? UI.kpiTile('Agenti esclusi', kpi.excluded, iconExcl(), 'red') : ''}
        ${UI.kpiTile('Giorni lavorativi', config.working_days || 1, iconCal(),   'purple')}
      </div>
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Distribuzione per collega</h3>
          <div class="card-options">
            <span class="text-muted small">Report: ${activeReport.filename} · ${new Date(activeReport.uploaded_at).toLocaleDateString('it-IT')}</span>
          </div>
        </div>
        <div class="table-responsive">
          <table class="table table-vcenter card-table">
            <thead><tr><th>Collega</th><th>Assegnate</th><th>Min</th><th>Max</th><th>Progresso</th></tr></thead>
            <tbody>
              ${colleagues.filter(c => c.active).map(c => {
                const cnt = Object.values(assignments).filter(a => a.colleague_id === c.id).length;
                return `<tr>
                  <td>${UI.colleagueBadge(c.name, c.color_idx)}</td>
                  <td><strong>${cnt}</strong></td>
                  <td class="text-muted">${c.min_quota}</td>
                  <td class="text-muted">${c.max_quota}</td>
                  <td style="min-width:120px">${UI.progressBar(cnt, c.min_quota, c.max_quota, UI.colleagueColor(c.color_idx))}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function renderPool() {
    const el = document.getElementById('pool-content');
    if (!el || !activeReport) return;

    const assignedIds  = new Set(Object.keys(assignments));
    const excludedSet  = new Set((agentExclusions || []).map(a => (a.agent_name || '').toLowerCase().trim()));

    // Separa pool normale da pool agenti esclusi (match SOLO su agente_attuale)
    const unassigned   = practices.filter(p => !assignedIds.has(p.id));
    const excludedPool = unassigned.filter(p => excludedSet.size > 0 && excludedSet.has((p.agente_attuale || '').toLowerCase().trim()));
    const regularPool  = unassigned.filter(p => !excludedSet.has((p.agente_attuale || '').toLowerCase().trim()));

    const poolRow = (p, showAssign) => `
      <tr>
        <td class="font-monospace small">${p.pratica_id || '—'}</td>
        <td>${p.cognome} ${p.nome}</td>
        <td class="text-muted small">${p.tipologia || '—'}</td>
        <td>${UI.statoBadge(p.stato_attuale)}</td>
        ${showAssign ? `<td>
          <select class="form-select form-select-sm" style="width:auto"
            onchange="AppRuntime.assignFromPool('${p.id}', this.value)">
            <option value="">— assegna —</option>
            ${colleagues.filter(c => c.active).map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
          </select>
        </td>` : `<td class="text-muted small">${p.agente_attuale || '—'}</td>`}
      </tr>`;

    if (!unassigned.length) {
      el.innerHTML = UI.emptyState(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="20 6 9 17 4 12"/></svg>',
        'Tutte le pratiche sono state assegnate'
      );
      return;
    }

    el.innerHTML = `
      ${regularPool.length ? `
      <div class="card mb-4">
        <div class="card-header">
          <h3 class="card-title">Pool — ${regularPool.length} pratiche non assegnate</h3>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-vcenter card-table">
            <thead><tr><th>Pratica</th><th>Nominativo</th><th>Tipologia</th><th>Stato</th><th>Assegna a</th></tr></thead>
            <tbody>${regularPool.slice(0, 200).map(p => poolRow(p, true)).join('')}</tbody>
          </table>
        </div>
        ${regularPool.length > 200 ? `<div class="card-footer text-muted text-center small">Mostrate 200 su ${regularPool.length}</div>` : ''}
      </div>` : ''}

      ${excludedPool.length ? `
      <div class="card border-danger">
        <div class="card-header bg-danger-lt">
          <h3 class="card-title text-danger">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="me-1"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            Pool agenti esclusi — ${excludedPool.length} pratiche
          </h3>
          <div class="card-options">
            <small class="text-muted">Pratiche ignorate dalla distribuzione automatica (agente_attuale in lista esclusioni)</small>
          </div>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-vcenter card-table">
            <thead><tr><th>Pratica</th><th>Nominativo</th><th>Tipologia</th><th>Stato</th><th>Agente attuale</th></tr></thead>
            <tbody>${excludedPool.slice(0, 200).map(p => poolRow(p, false)).join('')}</tbody>
          </table>
        </div>
        ${excludedPool.length > 200 ? `<div class="card-footer text-muted text-center small">Mostrate 200 su ${excludedPool.length}</div>` : ''}
      </div>` : ''}`;
  }

  function renderDistribution() {
    renderDashboard();
    renderPool();
  }

  // 10. Pool manual assignment
  window.AppRuntime = {
    async assignFromPool(practiceId, colleagueId) {
      if (!colleagueId) return;
      try {
        const { data: { user } } = await db.auth.getUser();
        await DB.upsertAssignment({
          practice_id:  practiceId,
          report_id:    activeReport.id,
          colleague_id: colleagueId,
          assigned_by:  user.id,
          is_manual:    true,
          assigned_at:  new Date().toISOString(),
        });
        // Il real-time aggiornerà la UI automaticamente
      } catch(e) {
        UI.toast('Errore assegnazione: ' + e.message, 'danger');
      }
    },
  };

  // 11. Export Excel
  document.getElementById('btn-export')?.addEventListener('click', exportExcel);

  function exportExcel() {
    if (!activeReport || !practices.length) {
      UI.toast('Nessun dato da esportare', 'warning'); return;
    }
    const rows = practices.map(p => {
      const a = assignments[p.id];
      const col = a ? colleagues.find(c => c.id === a.colleague_id) : null;
      return {
        'Numero Pratica':  p.pratica_id,
        'Cognome':         p.cognome,
        'Nome':            p.nome,
        'Tipologia':       p.tipologia,
        'Stato Attuale':   p.stato_attuale,
        'Collega':         col?.name || '',
        'Manuale':         a?.is_manual ? 'Sì' : '',
        'Note':            p.note,
        'Conformità':      p.conformita_documentazione,
      };
    });
    const ws  = XLSX.utils.json_to_sheet(rows);
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Distribuzione');

    const poolRows = practices.filter(p => !assignments[p.id]).map(p => ({
      'Numero Pratica': p.pratica_id,
      'Cognome':        p.cognome,
      'Nome':           p.nome,
      'Tipologia':      p.tipologia,
      'Stato Attuale':  p.stato_attuale,
    }));
    if (poolRows.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(poolRows), 'Pool');
    }
    XLSX.writeFile(wb, `distribuzione-${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  // SVG icons inline
  function iconDoc()   { return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`; }
  function iconCheck() { return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`; }
  function iconPool()  { return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`; }
  function iconCal()   { return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`; }
  function iconExcl()  { return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`; }

  // Start
  await loadActiveReport();

})();
