// ================================================================
// App — orchestrazione principale
// ================================================================
(async () => {

  // 1. Verifica sessione
  const session = await Auth.requireAuth('index.html');
  if (!session) return;

  const profile = Auth.getProfile();

  // 1b. Utente non ancora approvato da un admin: solo schermata di attesa
  if (profile.status === 'pending') {
    document.querySelector('.wrapper').style.display = 'none';
    const pendingScreen = document.getElementById('pending-screen');
    pendingScreen.style.display = '';
    document.getElementById('pending-logout')?.addEventListener('click', async () => {
      await Auth.signOut();
      window.location.href = 'index.html';
    });
    return;
  }

  const isAdmin    = Auth.isAdmin();
  const canSeeAll  = Auth.canSeeAll();   // admin + top: Dashboard, Pool, pool Audit/xFlat/Help, schede
  const myColleagueId = profile.colleague_id || null;

  // 2. Mostra/nascondi elementi in base al ruolo (sistema piramidale)
  //    - data-admin-only:     solo Admin (Configurazione)
  //    - data-elevated-only:  Admin + Top (Dashboard, Pool, pool di gestione)
  document.querySelectorAll('[data-admin-only]').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  document.querySelectorAll('[data-elevated-only]').forEach(el => {
    el.style.display = canSeeAll ? '' : 'none';
  });
  document.getElementById('user-name-display').textContent = profile.full_name || profile.email;
  document.getElementById('user-role-badge').innerHTML = UI.renderRoleBadge(profile.role);

  // 2b. Stato applicativo
  let activeReport     = null;
  let practices        = [];
  let practiceById     = {};  // id tecnico -> pratica
  let practiceByPid    = {};  // pratica_id -> pratica
  let assignments      = {};  // practice_id -> assignment
  let colleagues       = [];
  let colleagueStateFilters = [];
  let config           = {};
  let agentExclusions  = [];

  let users            = [];
  let notifications    = [];
  let chatMessages     = [];

  let work             = {};  // pratica_id -> riga practice_work (stato/nota correnti)
  let stats            = [];  // righe check_stats(): controllate per collega/stato
  const pending        = {};  // pratica_id -> stato scelto in attesa della nota obbligatoria
  let dataLoaded       = false;

  let currentTarget     = null;
  let schedaColleagueId = null;
  let statsPeriod       = 'day';
  let mgmtTab           = 'audit';
  const planFilter      = {};  // colleague_id -> { q, st }
  let _poolSearchTerm   = '';
  let _poolShowAll      = false;

  const esc  = UI.esc;
  const norm = s => (s || '').toLowerCase().trim();
  const $    = id => document.getElementById(id);
  const fmt  = n => Number(n || 0).toLocaleString('it-IT');

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ── FINE GIORNATA: ultimo "19:00 Europe/Rome" gia' passato ─────────
  // Tutto cio' che e' stato lavorato prima di quel momento viene smistato:
  // Conforme/Integrazioni spariscono dal piano, Da chiamare va nel pool
  // dell'operatore, Audit/xFlat/Help nel pool gestito da Top e Admin.
  const CUTOFF_HOUR = 19;
  function romeParts(d) {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const o = {};
    for (const part of f.formatToParts(d)) o[part.type] = part.value;
    return o;
  }
  function lastCutoff(now = new Date()) {
    const p = romeParts(now);
    const romeAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const offset = romeAsUtc - Math.floor(now.getTime() / 1000) * 1000;
    let c = Date.UTC(+p.year, +p.month - 1, +p.day, CUTOFF_HOUR, 0, 0) - offset;
    if (c > now.getTime()) c -= 86400000;
    return c;
  }
  let cutoff = lastCutoff();

  function refreshCutoff() {
    const c = lastCutoff();
    if (c === cutoff) return;
    cutoff = c;
    for (const k of Object.keys(pending)) delete pending[k];
    fullRender();
  }
  function scheduleCutoff() {
    const ms = Math.max(1000, cutoff + 86400000 - Date.now() + 1500);
    setTimeout(() => { refreshCutoff(); scheduleCutoff(); }, Math.min(ms, 0x7fffffff));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCutoff(); });

  // Fase di una pratica rispetto al flusso di lavoro
  //   none  = nessuno stato (eventuale sola nota)   -> resta nel piano
  //   today = stato inserito dopo l'ultima chiusura -> nel piano, colorata
  //   done  = Conforme/Integrazioni gia' ripulite   -> fuori dal piano
  //   call  = pool "Da chiamare" dell'operatore
  //   mgmt  = pool Audit / xFlat / Help (Top e Admin)
  function workState(pid) {
    const w = work[pid];
    if (!w || w.closed_at) return { w: null, phase: 'none' };
    if (!w.status) return { w, phase: 'none' };
    if (new Date(w.set_at).getTime() >= cutoff) return { w, phase: 'today' };
    if (w.status === 'da_chiamare') {
      // le chiamate fatte vengono ripulite alla chiusura successiva
      const calledSwept = w.called && w.called_at && new Date(w.called_at).getTime() < cutoff;
      return calledSwept ? { w: null, phase: 'none' } : { w, phase: 'call' };
    }
    if (UI.MGMT_STATUSES.includes(w.status)) return { w, phase: 'mgmt' };
    return (activeReport && w.report_id === activeReport.id) ? { w, phase: 'done' } : { w: null, phase: 'none' };
  }
  const effStatus = pid => (pid in pending ? pending[pid] : (workState(pid).w?.status || ''));

  // Pratiche da non (ri)distribuire: gia' lavorate oggi o ferme in un pool
  function engineOpts() {
    const lockedPids = new Set();
    for (const pid of Object.keys(work)) if (workState(pid).phase !== 'none') lockedPids.add(pid);
    const baseQuotas = {};
    for (const a of Object.values(assignments)) {
      if (a.is_manual) continue;
      const p = practiceById[a.practice_id];
      if (p && workState(p.pratica_id).phase === 'today') baseQuotas[a.colleague_id] = (baseQuotas[a.colleague_id] || 0) + 1;
    }
    return { lockedPids, baseQuotas };
  }
  function runEngine(manual) {
    return Engine.distribute(
      practices, colleagues, colleagueStateFilters, config.working_days || 1,
      manual, agentExclusions, config.sally_hook_colleague_id || null, engineOpts()
    );
  }
  const manualAssignments = () => Object.values(assignments).filter(a => a.is_manual);

  // ── 3. Navigazione SPA ─────────────────────────────────────────────
  const ELEVATED_TARGETS = ['dashboard', 'pool', 'gestione', 'scheda'];
  const ADMIN_TARGETS    = ['admin'];
  const ALL_TARGETS      = [...ELEVATED_TARGETS, ...ADMIN_TARGETS, 'mine', 'chat'];
  function isTargetAllowed(target) {
    if (ADMIN_TARGETS.includes(target))    return isAdmin;
    if (ELEVATED_TARGETS.includes(target)) return canSeeAll;
    return true; // mine, chat
  }
  const defaultTarget = () => (canSeeAll ? 'dashboard' : 'mine');

  const navLinks = document.querySelectorAll('[data-nav]');
  const sections = document.querySelectorAll('[data-section]');

  function navigate(target, arg, push = false) {
    if (!ALL_TARGETS.includes(target) || !isTargetAllowed(target)) target = defaultTarget();
    if (target === 'scheda') {
      if (arg) schedaColleagueId = arg;
      if (!schedaColleagueId) target = 'dashboard';
    }
    currentTarget = target;

    const navKey = target === 'scheda' ? 'dashboard' : target;
    navLinks.forEach(l => l.classList.toggle('active', l.dataset.nav === navKey));
    sections.forEach(s => {
      s.style.display = (isTargetAllowed(s.dataset.section) && s.dataset.section === target) ? '' : 'none';
    });
    const hash = '#' + target + (target === 'scheda' ? ':' + encodeURIComponent(schedaColleagueId) : '');
    if (push) history.pushState(null, '', hash); else history.replaceState(null, '', hash);

    if (target === 'admin') Admin.init();
    else if (target === 'chat') { renderChat(); scrollChatToBottom(); }
    else renderSection(target);
    if (push) window.scrollTo(0, 0);
  }
  function navigateFromHash() {
    const [target, arg] = location.hash.replace('#', '').split(':');
    navigate(target || defaultTarget(), arg ? decodeURIComponent(arg) : null);
  }

  navLinks.forEach(l => l.addEventListener('click', e => {
    e.preventDefault();
    navigate(l.dataset.nav, null, true);
  }));
  window.addEventListener('popstate', navigateFromHash);

  // ── Render: sezione corrente ───────────────────────────────────────
  function renderSection(target) {
    if (target === 'dashboard') renderDashboard();
    else if (target === 'pool') renderPool();
    else if (target === 'gestione') renderMgmt();
    else if (target === 'mine') renderMine();
    else if (target === 'scheda') renderScheda();
  }

  // Ridisegna senza perdere il campo in cui l'utente sta scrivendo
  function withFocus(fn) {
    const a = document.activeElement;
    const key = a && a.dataset ? a.dataset.fkey : null;
    const val = key ? a.value : null;
    const sel = key && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    fn();
    if (!key) return;
    const el = document.querySelector(`[data-fkey="${CSS.escape(key)}"]`);
    if (!el || el === a) return;
    const dirty = el.tagName === 'INPUT' && val !== el.value;
    el.value = val;
    el.focus();
    if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* non testuale */ } }
    // testo non ancora salvato: il nuovo campo deve comunque salvarlo all'uscita
    if (dirty) el.addEventListener('blur', () => el.dispatchEvent(new Event('change', { bubbles: true })), { once: true });
  }
  function fullRender() { withFocus(() => renderSection(currentTarget)); }
  const fullRenderSoon = debounce(fullRender, 120);

  // Aggiorna contatori/pool senza toccare la griglia del piano di lavoro
  function softRender() {
    withFocus(() => {
      if (currentTarget === 'dashboard') renderDashboard();
      else if (currentTarget === 'pool') renderPool();
      else if (currentTarget === 'gestione') renderMgmt();
      else if (currentTarget === 'mine') renderPlanExtras(myColleagueId);
      else if (currentTarget === 'scheda') { renderSchedaHead(); renderPlanExtras(schedaColleagueId); }
    });
  }
  const softRenderSoon = debounce(softRender, 150);

  // 4. Logout
  $('btn-logout')?.addEventListener('click', async () => {
    await Auth.signOut();
    window.location.href = 'index.html';
  });

  // ── 5. Caricamento dati ────────────────────────────────────────────
  function indexPractices() {
    practiceById = {}; practiceByPid = {};
    for (const p of practices) {
      practiceById[p.id] = p;
      if (p.pratica_id) practiceByPid[p.pratica_id] = p;
    }
  }

  const SCHEMA_MSG = 'Database da aggiornare: esegui nel SQL Editor di Supabase la migration 20261111000000_workplan_pools_stats.sql per attivare stati, pool e statistiche.';
  function showSchemaBanner() {
    if (!isAdmin || $('ec-schema-banner')) return;
    const el = document.createElement('div');
    el.id = 'ec-schema-banner';
    el.className = 'alert alert-warning m-3 mb-0';
    el.textContent = SCHEMA_MSG;
    document.querySelector('.page-wrapper')?.prepend(el);
  }

  async function loadWork() {
    try {
      const since = new Date(cutoff).toISOString().slice(0, 19) + 'Z';
      const rows = await DB.getOpenWork(activeReport?.id || null, since);
      work = {};
      for (const r of rows) work[r.pratica_id] = r;
    } catch (e) {
      work = {};
      if (DB.isMissingSchema(e)) showSchemaBanner();
      else UI.toast('Errore caricamento stati: ' + e.message, 'danger');
    }
  }

  async function loadStats() {
    try { stats = await DB.getCheckStats(); }
    catch (e) { stats = []; if (!DB.isMissingSchema(e)) console.warn('check_stats', e); }
  }
  const refreshStatsSoon = debounce(async () => { await loadStats(); softRender(); }, 400);

  async function loadActiveReport() {
    UI.showLoader('Caricamento report…');
    try {
      [activeReport, colleagues, colleagueStateFilters, config, agentExclusions] = await Promise.all([
        DB.getActiveReport(),
        DB.getColleagues(),
        DB.getAllColleagueStateFilters(),
        DB.getConfig(),
        DB.getAgentExclusions(),
      ]);

      if (activeReport) {
        const [pr, assignList] = await Promise.all([
          DB.getPractices(activeReport.id),
          DB.getAssignments(activeReport.id),
          loadWork(),
        ]);
        practices = pr;
        assignments = {};
        for (const a of assignList) assignments[a.practice_id] = a;
      } else {
        practices = []; assignments = {};
        await loadWork();
      }
      indexPractices();
      dataLoaded = true;
      fullRender();
      subscribeRealtime();
    } catch (e) {
      UI.toast('Errore caricamento: ' + e.message, 'danger');
    } finally {
      UI.hideLoader();
    }
  }

  // 5b. Dati indipendenti dal report attivo
  async function loadGlobalData() {
    try {
      const [usersData, notifData, chatData] = await Promise.all([
        DB.getUsers(),
        DB.getNotifications(),
        DB.getChatMessages(),
        loadStats(),
      ]);
      users = usersData;
      notifications = notifData;
      chatMessages = chatData;

      renderNotifBell();
      if (currentTarget === 'chat') { renderChat(); scrollChatToBottom(); }
      else softRender();
    } catch (e) {
      UI.toast('Errore caricamento dati: ' + e.message, 'danger');
    }
  }

  // 5c. Realtime di sessione (chat, piano di lavoro, conteggi, notifiche)
  function subscribeGlobalRealtime() {
    Realtime.subscribeGlobal(session.user.id, {
      onChatMessage() {
        DB.getChatMessages().then(d => {
          chatMessages = d;
          if (currentTarget === 'chat') { withFocus(renderChat); scrollChatToBottom(); }
        });
      },
      onWorkChange(payload) {
        const { eventType, new: row, old } = payload;
        const pid = (row && row.pratica_id) || (old && old.pratica_id);
        if (!pid) return;
        if (eventType === 'DELETE') {
          if (!work[pid]) return;
          delete work[pid];
        } else {
          const cur = work[pid];
          // eco di una modifica fatta da questa stessa sessione
          if (cur && new Date(cur.updated_at).getTime() === new Date(row.updated_at).getTime()) return;
          if (row.closed_at) delete work[pid]; else work[pid] = row;
        }
        patchRow(pid);
        softRenderSoon();
      },
      onChecksChange() { refreshStatsSoon(); },
      onNotification(payload) {
        notifications.unshift(payload.new);
        renderNotifBell();
        UI.toast(payload.new.title || 'Nuova notifica', 'info');
      },
    });
  }

  // 6. Realtime del report attivo
  function subscribeRealtime() {
    if (!activeReport) return;
    Realtime.subscribe(activeReport.id, {
      onAssignment(payload) {
        const { eventType, new: row, old } = payload;
        if (eventType === 'DELETE') {
          // con RLS attiva l'evento porta solo la chiave primaria
          const key = old.practice_id || Object.keys(assignments).find(k => assignments[k].id === old.id);
          if (key) delete assignments[key];
        } else {
          assignments[row.practice_id] = row;
        }
        fullRenderSoon();
      },
      onNewReport(newReport) {
        if (newReport.id !== activeReport?.id) {
          UI.toast('Nuovo report caricato — aggiorno…', 'info');
          setTimeout(loadActiveReport, 1000);
        }
      },
      onColleaguesChange()       { DB.getColleagues().then(d => { colleagues = d; fullRenderSoon(); }); },
      onAgentExclusionsChange()  { DB.getAgentExclusions().then(d => { agentExclusions = d; fullRenderSoon(); }); },
      onConfigChange()           { DB.getConfig().then(d => { config = d; fullRenderSoon(); }); },
      onColleagueFiltersChange() { DB.getAllColleagueStateFilters().then(d => { colleagueStateFilters = d; fullRenderSoon(); }); },
    });
  }

  // ── 7. RICALCOLA (admin) ───────────────────────────────────────────
  $('btn-ricalcola')?.addEventListener('click', async () => {
    if (!activeReport) return;
    if (!UI.confirm('Ricalcolare le assegnazioni automatiche? Restano invariate quelle manuali e le pratiche già lavorate.')) return;
    UI.showLoader('Ricalcolo in corso…');
    try {
      // Le pratiche gia' lavorate (o ferme in un pool) conservano l'assegnazione
      const opts = engineOpts();
      const kept = Object.values(assignments)
        .filter(a => !a.is_manual && opts.lockedPids.has(practiceById[a.practice_id]?.pratica_id))
        .map(a => ({
          practice_id: a.practice_id, report_id: a.report_id, colleague_id: a.colleague_id,
          is_manual: false, assigned_by: a.assigned_by, assigned_at: a.assigned_at,
        }));

      const { autoAssignments } = runEngine(manualAssignments());
      await DB.deleteAutoAssignments(activeReport.id);

      const { data: { user } } = await db.auth.getUser();
      const rows = [...kept, ...autoAssignments.map(a => ({ ...a, assigned_by: user.id }))];
      if (rows.length) await DB.bulkUpsertAssignments(rows);

      UI.toast(`Ricalcolo completato: ${autoAssignments.length} assegnazioni`, 'success');
      await loadActiveReport();
    } catch (e) {
      UI.toast('Errore ricalcolo: ' + e.message, 'danger');
    } finally {
      UI.hideLoader();
    }
  });

  // ── 8. UPLOAD REPORT (admin) ───────────────────────────────────────
  $('btn-upload-report')?.addEventListener('click', () => $('input-report-file')?.click());
  $('input-report-file')?.addEventListener('change', async function () {
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

      // Auto-distribuisci subito (saltando le pratiche gia' lavorate o nei pool)
      UI.showLoader('Distribuzione automatica…');
      await loadActiveReport();

      const { autoAssignments } = runEngine([]);
      if (autoAssignments.length) {
        const { data: { user } } = await db.auth.getUser();
        await DB.bulkUpsertAssignments(autoAssignments.map(a => ({ ...a, assigned_by: user.id })));
      }

      UI.toast(`Report caricato: ${rows.length} pratiche, ${autoAssignments.length} assegnate`, 'success');
      await loadActiveReport();
    } catch (e) {
      UI.toast('Errore upload: ' + e.message, 'danger');
    } finally {
      UI.hideLoader();
    }
  }

  // ── 9. DASHBOARD ───────────────────────────────────────────────────
  const spinner = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary mb-3" role="status"></div><p>Caricamento…</p></div>';
  const svg = (inner, size = 20) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${inner}</svg>`;
  const iconDoc   = () => svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
  const iconCheck = () => svg('<polyline points="20 6 9 17 4 12"/>');
  const iconPool  = () => svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>');
  const iconCal   = () => svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>');
  const iconExcl  = () => svg('<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>');
  const iconEye   = () => svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>');
  const iconPhone = () => svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>');
  const iconFlag  = () => svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>');

  const PERIODS = {
    day:   { label: 'Giorno',    field: 'n_day',   text: 'oggi' },
    week:  { label: 'Settimana', field: 'n_week',  text: 'questa settimana' },
    month: { label: 'Mese',      field: 'n_month', text: 'questo mese' },
    total: { label: 'Totale',    field: 'n_total', text: 'in totale' },
  };
  function statsSum(field, keyFn) {
    const m = {};
    for (const r of stats) {
      const k = keyFn(r);
      m[k] = (m[k] || 0) + Number(r[field] || 0);
    }
    return m;
  }
  const ownerKey = r => r.colleague_id || ('u:' + r.user_id);
  const userName = id => { const u = users.find(x => x.id === id); return u ? (u.full_name || u.email) : 'Utente'; };

  // Pratiche attualmente nei pool (dopo la chiusura delle 19) e in arrivo oggi
  function poolCounts() {
    const c = {};
    for (const k of Object.keys(UI.WORK_STATUSES)) c[k] = { pool: 0, today: 0 };
    for (const pid of Object.keys(work)) {
      const { w, phase } = workState(pid);
      if (!w || !w.status) continue;
      if (phase === 'call' || phase === 'mgmt') c[w.status].pool++;
      else if (phase === 'today') c[w.status].today++;
    }
    return c;
  }

  function poolSplit() {
    const excludedSet = new Set((agentExclusions || []).map(a => norm(a.agent_name)));
    const sallyHooked = !!(config.sally_hook_colleague_id && colleagues.some(c => c.id === config.sally_hook_colleague_id && c.active));
    const unassigned  = practices.filter(p => !assignments[p.id] && workState(p.pratica_id).phase === 'none');
    const isSally     = p => excludedSet.size > 0 && excludedSet.has(norm(p.agente_attuale));
    return {
      unassigned,
      sallyPool:   sallyHooked ? [] : unassigned.filter(isSally),
      regularPool: unassigned.filter(p => !isSally(p)),
    };
  }

  function renderDashboard() {
    const el = $('dashboard-content');
    if (!el) return;
    if (!dataLoaded) { el.innerHTML = spinner; return; }

    let top = '';
    if (!activeReport) {
      top = UI.emptyState(svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', 40),
        isAdmin ? 'Nessun report attivo. Carica un CSV per iniziare.' : 'Nessun report attivo. Contatta un admin.');
    } else {
      const { kpi } = runEngine(manualAssignments());
      const assignedCount = Object.keys(assignments).length;
      const { regularPool, sallyPool } = poolSplit();
      const checkedToday = stats.reduce((s, r) => s + Number(r.n_day || 0), 0);

      top = `
        <div class="row g-3 mb-3">
          ${UI.kpiTile('Pratiche totali',   fmt(practices.length),   iconDoc(),   'blue')}
          ${UI.kpiTile('Assegnate',         fmt(assignedCount),      iconCheck(), 'green')}
          ${UI.kpiTile('In Pool',           fmt(regularPool.length), iconPool(),  'orange')}
          ${UI.kpiTile('Controllate oggi',  fmt(checkedToday),       iconEye(),   'teal')}
          ${kpi.sallyHooked ? UI.kpiTile('Agenti Sally (agganciati)', fmt(kpi.sallyHooked), iconExcl(), 'cyan') : ''}
          ${sallyPool.length ? UI.kpiTile('Agenti Sally (pool)', fmt(sallyPool.length), iconExcl(), 'red') : ''}
          ${UI.kpiTile('Giorni lavorativi', config.working_days || 1, iconCal(),  'purple')}
        </div>`;
    }

    const pc = poolCounts();
    const poolTile = (key, label, icon, color) =>
      UI.kpiTile(label, fmt(pc[key].pool), icon, color, pc[key].today ? `+${fmt(pc[key].today)} alle 19` : '');

    el.innerHTML = `
      ${top}
      <div class="row g-3 mb-4">
        ${poolTile('da_chiamare', 'Pool Da chiamare', iconPhone(), 'orange')}
        ${poolTile('audit',       'Pool Audit',       iconFlag(),  'red')}
        ${poolTile('xflat',       'Pool xFlat',       iconFlag(),  'purple')}
        ${poolTile('help',        'Pool Help',        iconFlag(),  'cyan')}
      </div>

      ${chartsHtml()}

      <h3 class="mt-4 mb-2">Numeri per utente</h3>
      ${colleagueBoxesHtml()}

      ${activeReport ? distributionHtml() : ''}`;
  }

  function chartsHtml() {
    const per = PERIODS[statsPeriod];
    const byOwner  = statsSum(per.field, ownerKey);
    const byStatus = statsSum(per.field, r => r.status);

    // Colleghi attivi sempre presenti (anche a zero), poi eventuali altri con valori
    const active = colleagues.filter(c => c.active);
    const items = active.map(c => ({ label: c.name, value: byOwner[c.id] || 0 }));
    const known = new Set(active.map(c => c.id));
    for (const [k, v] of Object.entries(byOwner)) {
      if (known.has(k) || !v) continue;
      const col = colleagues.find(c => c.id === k);
      items.push({ label: col ? col.name : userName(k.replace(/^u:/, '')), value: v });
    }
    const statusItems = Object.entries(UI.WORK_STATUSES).map(([k, s]) => ({ label: s.short, value: byStatus[k] || 0, color: s.hex }));
    const total = items.reduce((s, i) => s + i.value, 0);

    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Pratiche controllate <span class="text-muted fw-normal">— ${fmt(total)} ${per.text}</span></h3>
          <div class="card-options">
            <div class="btn-group ec-seg" role="group" aria-label="Periodo">
              ${Object.entries(PERIODS).map(([k, p]) => `
                <button type="button" class="btn ${k === statsPeriod ? 'btn-primary' : 'btn-outline-secondary'}" onclick="App.setPeriod('${k}')">${p.label}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="card-body">
          <div class="row g-4">
            <div class="col-lg-6">
              <div class="ec-chart-title">Controllate per utente</div>
              ${UI.barChart(items, { title: 'Pratiche controllate per utente' })}
            </div>
            <div class="col-lg-6">
              <div class="ec-chart-title">Stati inseriti</div>
              ${UI.barChart(statusItems, { title: 'Stati inseriti' })}
            </div>
          </div>
        </div>
      </div>`;
  }

  function colleagueBoxesHtml() {
    const byColleague = {}; // colleague_id -> { total, byTipologia }
    for (const p of practices) {
      const a = assignments[p.id];
      if (!a) continue;
      const b = byColleague[a.colleague_id] || (byColleague[a.colleague_id] = { total: 0, byTipologia: {} });
      b.total++;
      const tip = p.tipologia || 'Altro';
      b.byTipologia[tip] = (b.byTipologia[tip] || 0) + 1;
    }
    const checkedToday = statsSum('n_day', ownerKey);

    const active = colleagues.filter(c => c.active);
    if (!active.length) return '<div class="text-muted small">Nessun collega attivo.</div>';

    return `
      <div class="row g-3">
        ${active.map(c => {
          const s = byColleague[c.id] || { total: 0, byTipologia: {} };
          const tipRows = Object.entries(s.byTipologia).sort((a, b) => b[1] - a[1]);
          const color = UI.colleagueColor(c.color_idx);
          return `
          <div class="col-sm-6 col-lg-4 col-xxl-3">
            <a class="card ec-user-box h-100" href="#scheda:${encodeURIComponent(c.id)}" data-colleague="${esc(c.id)}"
              onclick="App.openScheda(this.dataset.colleague);return false;">
              <div class="card-body">
                <div class="d-flex align-items-center gap-2 mb-3">
                  <span class="avatar avatar-sm bg-${color}-lt">${esc(c.name[0] || '?')}</span>
                  <strong class="text-truncate">${esc(c.name)}</strong>
                  <span class="ms-auto text-muted small text-nowrap">Apri piano →</span>
                </div>
                <div class="ec-box-nums">
                  <div><strong>${fmt(s.total)}</strong><span>Assegnate</span></div>
                  <div><strong>${fmt(checkedToday[c.id] || 0)}</strong><span>Controllate oggi</span></div>
                </div>
                ${tipRows.length ? `
                  <div class="small text-muted mt-3">
                    ${tipRows.map(([tip, cnt]) => `<div class="d-flex justify-content-between gap-2"><span class="text-truncate">${esc(tip)}</span><strong>${fmt(cnt)}</strong></div>`).join('')}
                  </div>` : '<div class="small text-muted mt-3">Nessuna pratica assegnata</div>'}
              </div>
            </a>
          </div>`;
        }).join('')}
      </div>`;
  }

  function distributionHtml() {
    const counts = {};
    for (const a of Object.values(assignments)) counts[a.colleague_id] = (counts[a.colleague_id] || 0) + 1;
    return `
      <div class="card mt-4">
        <div class="card-header">
          <h3 class="card-title">Distribuzione per collega</h3>
          <div class="card-options">
            <span class="text-muted small">Report: ${esc(activeReport.filename)} · ${new Date(activeReport.uploaded_at).toLocaleDateString('it-IT')}</span>
          </div>
        </div>
        <div class="table-responsive">
          <table class="table table-vcenter card-table">
            <thead><tr><th>Collega</th><th>Assegnate</th><th>Min</th><th>Max</th><th>Progresso</th></tr></thead>
            <tbody>
              ${colleagues.filter(c => c.active).map(c => {
                const cnt = counts[c.id] || 0;
                return `<tr>
                  <td>${UI.colleagueBadge(esc(c.name), c.color_idx)}</td>
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

  function setPeriod(p) {
    if (!PERIODS[p]) return;
    statsPeriod = p;
    if (currentTarget === 'dashboard') renderDashboard();
  }

  // ── 10. PIANO DI LAVORO (griglia per collega) ──────────────────────
  // Stesse colonne del foglio di lavoro; "Stato" e' l'ultima a destra.
  const PLAN_COLS = [
    ['cognome', 'Cognome'], ['nome', 'Nome'], ['__note', 'Note'],
    ['tipologia', 'Tipologia'], ['istituto_finanziario', 'Istituto Finanziario'],
    ['agente_attuale', 'Agente Attuale'], ['area_manager', 'Area Manager'],
    ['group_manager', 'Group Manager'], ['team_manager', 'Team Manager'],
    ['stato_attuale', 'Stato Attuale'], ['conformita_documentazione', 'Conformità'],
    ['originale_archiviato', 'Originale Archiviato'],
  ];
  const dash = '<span class="text-muted">—</span>';
  const cell = v => `<td title="${esc(v)}">${v ? esc(v) : dash}</td>`;

  function planData(colleagueId) {
    const rows = [];
    for (const p of practices) {
      const a = assignments[p.id];
      if (!a || a.colleague_id !== colleagueId) continue;
      const ph = workState(p.pratica_id).phase;
      if (ph === 'none' || ph === 'today') rows.push(p);
    }
    const calls = Object.values(work)
      .filter(w => w.colleague_id === colleagueId && workState(w.pratica_id).phase === 'call')
      .sort((a, b) => new Date(a.set_at) - new Date(b.set_at));
    return { rows, calls };
  }

  function statusOptions(st) {
    return `<option value="">—</option>` + Object.entries(UI.WORK_STATUSES)
      .map(([k, s]) => `<option value="${k}" ${k === st ? 'selected' : ''}>${s.label}</option>`).join('');
  }

  function planRowHtml(p) {
    const pid = p.pratica_id || '';
    const { w } = workState(pid);
    const st  = effStatus(pid);
    const def = UI.WORK_STATUSES[st];
    const search = [pid, p.cognome, p.nome, p.tipologia, p.istituto_finanziario, p.agente_attuale, p.stato_attuale, w?.note].join(' ').toLowerCase();
    const off = pid ? '' : 'disabled';

    const cells = PLAN_COLS.map(([key]) => {
      if (key === '__note') return `
        <td class="ec-col-note">
          ${p.note ? `<div class="ec-src-note" title="Nota dal report: ${esc(p.note)}">${esc(p.note)}</div>` : ''}
          <input type="text" class="form-control form-control-sm ec-note-input" data-fkey="note:${esc(pid)}"
            value="${esc(w?.note || '')}" placeholder="Aggiungi nota…" maxlength="1000" autocomplete="off" ${off}
            aria-label="Nota pratica ${esc(pid)}"
            onchange="App.saveNote(this)" onkeydown="if(event.key==='Enter')this.blur()"/>
        </td>`;
      if (key === 'stato_attuale') return `<td>${UI.statoBadge(esc(p.stato_attuale))}</td>`;
      return cell(p[key]);
    }).join('');

    return `
      <tr data-pid="${esc(pid)}" data-st="${st}" data-search="${esc(search)}"
          class="${def ? 'has-st' : ''}${pid in pending ? ' is-pending' : ''}" ${def ? `style="--st:${def.hex}"` : ''}>
        <td class="ec-col-id">${UI.praticaLink(pid)}</td>
        ${cells}
        <td class="ec-col-status">
          <select class="form-select form-select-sm ec-status-select" data-fkey="st:${esc(pid)}" ${off}
            aria-label="Stato pratica ${esc(pid)}" onchange="App.setStatus(this)">${statusOptions(st)}</select>
        </td>
      </tr>`;
  }

  function callPoolHtml(calls) {
    if (!calls.length) return '';
    return `
      <div class="card mt-4">
        <div class="card-header">
          <h3 class="card-title"><span class="ec-st-dot" style="background:${UI.WORK_STATUSES.da_chiamare.hex}"></span> Da chiamare — ${calls.length}</h3>
        </div>
        <div class="ec-grid-wrap ec-grid-wrap--auto">
          <table class="ec-grid ec-grid--pool">
            <thead><tr>
              <th>Pratica ID</th><th>Cognome</th><th>Note</th><th>Tipologia</th><th>Istituto Finanziario</th>
              <th>Agente Attuale</th><th>Chiamato</th><th>Note Chiamata</th>
            </tr></thead>
            <tbody>
              ${calls.map(w => `
                <tr data-pid="${esc(w.pratica_id)}" class="${w.called ? 'is-called' : ''}">
                  <td class="ec-col-id">${UI.praticaLink(w.pratica_id)}</td>
                  ${cell(w.cognome)}
                  <td class="ec-col-wrap" title="${esc(w.note)}">${esc(w.note) || dash}</td>
                  ${cell(w.tipologia)}${cell(w.istituto_finanziario)}${cell(w.agente_attuale)}
                  <td>
                    <select class="form-select form-select-sm ec-called-select" data-fkey="called:${esc(w.pratica_id)}"
                      aria-label="Chiamato" onchange="App.setCalled(this)">
                      <option value="0" ${w.called ? '' : 'selected'}>No</option>
                      <option value="1" ${w.called ? 'selected' : ''}>Sì</option>
                    </select>
                  </td>
                  <td class="ec-col-note">
                    <input type="text" class="form-control form-control-sm ec-note-input" data-fkey="pnote:${esc(w.pratica_id)}"
                      value="${esc(w.pool_note || '')}" placeholder="Esito della chiamata…" maxlength="1000" autocomplete="off"
                      aria-label="Note chiamata" onchange="App.setPoolNote(this)" onkeydown="if(event.key==='Enter')this.blur()"/>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function planHtml(colleagueId) {
    const { rows, calls } = planData(colleagueId);
    const f = planFilter[colleagueId] || (planFilter[colleagueId] = { q: '', st: '' });
    const cid = esc(colleagueId);

    const grid = rows.length ? `
      <div class="ec-grid-wrap">
        <table class="ec-grid" data-colleague="${cid}">
          <thead><tr>
            <th class="ec-col-id">Pratica</th>
            ${PLAN_COLS.map(([, label]) => `<th>${label}</th>`).join('')}
            <th class="ec-col-status">Stato</th>
          </tr></thead>
          <tbody>${rows.map(planRowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="card-footer text-muted small d-flex flex-wrap gap-3">
        <span data-plan-count></span>
        <span class="ms-auto">Alle 19 le pratiche con uno stato lasciano il piano: Conforme e Integrazioni vengono archiviate, le altre passano ai rispettivi pool.</span>
      </div>`
      : UI.emptyState(svg('<polyline points="20 6 9 17 4 12"/>', 40),
          activeReport ? 'Nessuna pratica da lavorare nel piano' : 'Nessun report attivo');

    return `
      <div class="card ec-plan" data-plan="${cid}">
        <div class="card-header ec-plan-toolbar">
          <div class="ec-chips" data-plan-chips></div>
          <div class="ms-auto d-flex align-items-center gap-3">
            <small class="text-muted d-none d-xxl-inline">Scrivi @nome nella nota per taggare un collega</small>
            <input type="search" class="form-control form-control-sm ec-plan-search" data-fkey="plansearch:${cid}"
              placeholder="Cerca pratica, nome, agente…" value="${esc(f.q)}" aria-label="Cerca nel piano" oninput="App.planSearch(this)"/>
          </div>
        </div>
        ${grid}
      </div>
      <div data-plan-call="${cid}">${callPoolHtml(calls)}</div>`;
  }

  // Chip di riepilogo/filtro sopra la griglia (contati dalle righe a schermo)
  function renderChips(card) {
    const box = card.querySelector('[data-plan-chips]');
    if (!box) return;
    const f = planFilter[card.dataset.plan] || { q: '', st: '' };
    const trs = card.querySelectorAll('.ec-grid tbody tr[data-pid]');
    const counts = { todo: 0 };
    trs.forEach(tr => { const s = tr.dataset.st || 'todo'; counts[s] = (counts[s] || 0) + 1; });

    const chip = (key, label, n, hex) => `
      <button type="button" class="ec-chip ${f.st === key ? 'is-active' : ''}" data-chip="${key}" onclick="App.planChip(this)" aria-pressed="${f.st === key}">
        ${hex ? `<span class="ec-st-dot" style="background:${hex}"></span>` : ''}${label} <strong>${fmt(n)}</strong>
      </button>`;
    box.innerHTML =
      chip('', 'Tutte', trs.length) +
      chip('todo', 'Da lavorare', counts.todo) +
      Object.entries(UI.WORK_STATUSES).map(([k, s]) => chip(k, s.short, counts[k] || 0, s.hex)).join('');
  }

  function applyPlanFilter(card) {
    const f = planFilter[card.dataset.plan] || { q: '', st: '' };
    const q = f.q.toLowerCase().trim();
    let shown = 0, total = 0;
    card.querySelectorAll('.ec-grid tbody tr[data-pid]').forEach(tr => {
      total++;
      const okQ  = !q || (tr.dataset.search || '').includes(q);
      const okSt = !f.st || (f.st === 'todo' ? !tr.dataset.st : tr.dataset.st === f.st);
      const ok = okQ && okSt;
      tr.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    const cnt = card.querySelector('[data-plan-count]');
    if (cnt) cnt.textContent = shown === total ? `${fmt(total)} pratiche` : `${fmt(shown)} di ${fmt(total)} pratiche`;
  }

  function mountPlan(container, colleagueId) {
    container.innerHTML = planHtml(colleagueId);
    const card = container.querySelector('[data-plan]');
    if (card) { renderChips(card); applyPlanFilter(card); }
  }

  // Aggiorna chip + pool "Da chiamare" senza ridisegnare la griglia
  function renderPlanExtras(colleagueId) {
    if (!colleagueId) return;
    document.querySelectorAll('[data-plan]').forEach(card => {
      if (card.dataset.plan === colleagueId) renderChips(card);
    });
    document.querySelectorAll('[data-plan-call]').forEach(box => {
      if (box.dataset.planCall === colleagueId) box.innerHTML = callPoolHtml(planData(colleagueId).calls);
    });
  }

  // Aggiorna in place la riga di una pratica (niente ridisegno: non si perdono focus e menu aperti)
  function patchRow(pid) {
    const st  = effStatus(pid);
    const def = UI.WORK_STATUSES[st];
    const w   = workState(pid).w;
    document.querySelectorAll(`.ec-grid[data-colleague] tr[data-pid="${CSS.escape(pid)}"]`).forEach(tr => {
      tr.dataset.st = st;
      tr.classList.toggle('has-st', !!def);
      tr.classList.toggle('is-pending', pid in pending);
      if (def) tr.style.setProperty('--st', def.hex); else tr.style.removeProperty('--st');
      const sel = tr.querySelector('.ec-status-select');
      if (sel) sel.value = st;
      const inp = tr.querySelector('.ec-note-input');
      if (inp && inp !== document.activeElement) inp.value = w?.note || '';
      const card = tr.closest('[data-plan]');
      if (card) renderChips(card);
    });
  }

  function planSearch(input) {
    const card = input.closest('[data-plan]');
    if (!card) return;
    (planFilter[card.dataset.plan] || (planFilter[card.dataset.plan] = { q: '', st: '' })).q = input.value;
    applyPlanFilter(card);
  }
  function planChip(btn) {
    const card = btn.closest('[data-plan]');
    if (!card) return;
    const key = btn.dataset.chip || '';
    const f = planFilter[card.dataset.plan] || (planFilter[card.dataset.plan] = { q: '', st: '' });
    f.st = f.st === key ? '' : key;
    renderChips(card);
    applyPlanFilter(card);
  }

  // ── Salvataggio stato / nota (inline, senza popup) ─────────────────
  function rowContext(el) {
    const tr = el.closest('tr');
    return { tr, pid: tr.dataset.pid, colleagueId: el.closest('table').dataset.colleague };
  }

  async function setStatus(sel) {
    const { tr, pid, colleagueId } = rowContext(sel);
    const status = sel.value;
    const noteInput = tr.querySelector('.ec-note-input');
    const note = noteInput.value.trim();
    const def = UI.WORK_STATUSES[status];

    if (def && def.note && !note) {
      // nota obbligatoria: lo stato resta in sospeso finche' non viene scritta
      pending[pid] = status;
      patchRow(pid);
      noteInput.focus();
      UI.toast(`Nota obbligatoria per "${def.label}": scrivila nella riga`, 'warning');
      return;
    }
    delete pending[pid];
    await saveWork(pid, colleagueId, status, note);
  }

  async function saveNote(input) {
    const { pid, colleagueId } = rowContext(input);
    const note = input.value.trim();
    const saved = workState(pid).w;
    const status = effStatus(pid);
    const def = UI.WORK_STATUSES[status];

    if (def && def.note && !note) {
      if (!(pid in pending)) {
        input.value = saved?.note || '';
        UI.toast(`La nota è obbligatoria per "${def.label}"`, 'warning');
      }
      return;
    }
    if (!(pid in pending) && note === (saved?.note || '')) return; // niente da salvare
    delete pending[pid];
    await saveWork(pid, colleagueId, status, note);
  }

  function detectMentions(note, prevNote) {
    const low  = (note || '').toLowerCase();
    const prev = (prevNote || '').toLowerCase();
    if (!low.includes('@')) return [];
    const out = [];
    for (const u of users) {
      if (u.id === session.user.id || u.status === 'pending') continue;
      const first = (u.full_name || u.email || '').trim().split(/[\s@.]+/)[0].toLowerCase();
      if (first.length < 2) continue;
      const tag = '@' + first;
      if (low.includes(tag) && !prev.includes(tag)) out.push(u.id);
    }
    return out;
  }

  async function saveWork(pid, colleagueId, status, note) {
    if (!pid) return;
    const prev = work[pid];
    if (!status && !note && !prev) { patchRow(pid); return; }
    try {
      const row = await DB.setPracticeWork({
        praticaId: pid, status, note,
        reportId: activeReport?.id || null,
        colleagueId: colleagueId || null,
        practice: practiceByPid[pid],
      });
      if (row) work[pid] = row; else delete work[pid];
      patchRow(pid);
      refreshStatsSoon();

      const mentioned = detectMentions(note, prev?.note);
      if (mentioned.length) {
        DB.notifyMentions(mentioned, {
          title: `${profile.full_name || profile.email} ti ha taggato — pratica ${pid}`,
          body: note, praticaId: pid,
        }).catch(() => { /* non bloccante */ });
      }
    } catch (e) {
      UI.toast(DB.isMissingSchema(e) ? SCHEMA_MSG : 'Errore salvataggio: ' + e.message, 'danger');
      patchRow(pid); // riporta la riga all'ultimo stato salvato
    }
  }

  // ── Pool: Chiamato / note / chiusura ───────────────────────────────
  async function updatePoolRow(pid, patch) {
    try {
      const row = await DB.updateWork(pid, patch);
      if (row) work[pid] = row;
    } catch (e) {
      UI.toast('Errore salvataggio: ' + e.message, 'danger');
      softRender();
    }
  }
  async function setCalled(sel) {
    const tr = sel.closest('tr');
    const called = sel.value === '1';
    tr.classList.toggle('is-called', called);
    await updatePoolRow(tr.dataset.pid, { called, called_at: called ? new Date().toISOString() : null });
  }
  async function setPoolNote(input) {
    const pid = input.closest('tr').dataset.pid;
    const note = input.value.trim();
    if (note === (work[pid]?.pool_note || '')) return;
    await updatePoolRow(pid, { pool_note: note });
  }
  async function closePoolRow(btn) {
    const pid = btn.closest('tr').dataset.pid;
    if (!UI.confirm(`Chiudere la pratica ${pid}? Verrà rimossa dal pool.`)) return;
    try {
      await DB.closeWork(pid);
      delete work[pid];
      softRender();
      UI.toast(`Pratica ${pid} chiusa`, 'success');
    } catch (e) {
      UI.toast('Errore: ' + e.message, 'danger');
    }
  }

  // ── 11. PIANO DI LAVORO PERSONALE / SCHEDA COLLEGA ─────────────────
  function renderMine() {
    const el = $('mine-content');
    if (!el) return;
    if (!myColleagueId) {
      el.innerHTML = UI.emptyState(
        svg('<path d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>', 40),
        'Il tuo account non è collegato a nessun collega. Contatta un admin per il collegamento.');
      return;
    }
    if (!dataLoaded) { el.innerHTML = spinner; return; }
    mountPlan(el, myColleagueId);
  }

  function schedaHeadHtml(c) {
    const { rows, calls } = planData(c.id);
    const assigned = Object.values(assignments).filter(a => a.colleague_id === c.id).length;
    const checked  = statsSum('n_day', ownerKey)[c.id] || 0;
    const color = UI.colleagueColor(c.color_idx);
    const linked = users.filter(u => u.colleague_id === c.id).map(u => u.full_name || u.email);
    const num = (v, label) => `<div><strong>${fmt(v)}</strong><span>${label}</span></div>`;
    return `
      <div class="d-flex flex-wrap align-items-center gap-3 mb-3">
        <button type="button" class="btn btn-outline-secondary" onclick="App.backToDashboard()">
          ${svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>', 18)}<span class="ms-1">Dashboard</span>
        </button>
        <span class="avatar bg-${color}-lt">${esc(c.name[0] || '?')}</span>
        <div>
          <h2 class="mb-0">Piano di lavoro — ${esc(c.name)}</h2>
          <div class="text-muted small">${linked.length ? esc(linked.join(', ')) : 'Nessun utente collegato'}</div>
        </div>
        <div class="ec-box-nums ec-box-nums--inline ms-auto">
          ${num(assigned, 'Assegnate')}${num(rows.length, 'Nel piano')}${num(checked, 'Controllate oggi')}${num(calls.length, 'Da chiamare')}
        </div>
      </div>`;
  }

  function renderSchedaHead() {
    const head = document.querySelector('[data-scheda-head]');
    const c = colleagues.find(x => x.id === schedaColleagueId);
    if (head && c) head.innerHTML = schedaHeadHtml(c);
  }

  function renderScheda() {
    const el = $('scheda-content');
    if (!el) return;
    if (!dataLoaded) { el.innerHTML = spinner; return; }
    const c = colleagues.find(x => x.id === schedaColleagueId);
    if (!c) { schedaColleagueId = null; navigate('dashboard'); return; }
    el.innerHTML = `<div data-scheda-head>${schedaHeadHtml(c)}</div><div data-scheda-plan></div>`;
    mountPlan(el.querySelector('[data-scheda-plan]'), c.id);
  }

  function openScheda(colleagueId) { navigate('scheda', colleagueId, true); }
  function backToDashboard()       { navigate('dashboard', null, true); }

  // ── 12. POOL AUDIT / XFLAT / HELP (Top e Admin) ────────────────────
  function mgmtRows(status) {
    return Object.values(work)
      .filter(w => w.status === status && workState(w.pratica_id).phase === 'mgmt')
      .sort((a, b) => new Date(a.set_at) - new Date(b.set_at));
  }

  function renderMgmt() {
    const el = $('gestione-content');
    if (!el) return;
    if (!dataLoaded) { el.innerHTML = spinner; return; }

    const lists = {};
    for (const k of UI.MGMT_STATUSES) lists[k] = mgmtRows(k);
    const rows = lists[mgmtTab] || [];
    const colName = id => colleagues.find(c => c.id === id)?.name || '';

    el.innerHTML = `
      <div class="card">
        <div class="card-header ec-plan-toolbar">
          <div class="ec-chips">
            ${UI.MGMT_STATUSES.map(k => `
              <button type="button" class="ec-chip ${k === mgmtTab ? 'is-active' : ''}" onclick="App.setMgmtTab('${k}')" aria-pressed="${k === mgmtTab}">
                <span class="ec-st-dot" style="background:${UI.WORK_STATUSES[k].hex}"></span>${UI.WORK_STATUSES[k].label} <strong>${fmt(lists[k].length)}</strong>
              </button>`).join('')}
          </div>
          <small class="text-muted ms-auto">Le pratiche arrivano qui alle 19 del giorno in cui vengono segnalate</small>
        </div>
        ${rows.length ? `
        <div class="ec-grid-wrap">
          <table class="ec-grid ec-grid--pool">
            <thead><tr>
              <th>Pratica</th><th>Cognome</th><th>Nome</th><th>Note</th><th>Tipologia</th><th>Istituto Finanziario</th>
              <th>Agente Attuale</th><th>Operatore</th><th>Segnalata</th><th>Note gestione</th><th></th>
            </tr></thead>
            <tbody>
              ${rows.map(w => `
                <tr data-pid="${esc(w.pratica_id)}">
                  <td class="ec-col-id">${UI.praticaLink(w.pratica_id)}</td>
                  ${cell(w.cognome)}${cell(w.nome)}
                  <td class="ec-col-wrap" title="${esc(w.note)}">${esc(w.note) || dash}</td>
                  ${cell(w.tipologia)}${cell(w.istituto_finanziario)}${cell(w.agente_attuale)}
                  ${cell(colName(w.colleague_id) || userName(w.set_by))}
                  <td>${new Date(w.set_at).toLocaleDateString('it-IT')}</td>
                  <td class="ec-col-note">
                    <input type="text" class="form-control form-control-sm ec-note-input" data-fkey="pnote:${esc(w.pratica_id)}"
                      value="${esc(w.pool_note || '')}" placeholder="Esito / azioni…" maxlength="1000" autocomplete="off"
                      aria-label="Note gestione" onchange="App.setPoolNote(this)" onkeydown="if(event.key==='Enter')this.blur()"/>
                  </td>
                  <td><button type="button" class="btn btn-sm btn-outline-secondary" onclick="App.closePoolRow(this)">Chiudi</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`
        : UI.emptyState(svg('<polyline points="20 6 9 17 4 12"/>', 40), `Nessuna pratica nel pool ${UI.WORK_STATUSES[mgmtTab].label}`)}
      </div>`;
  }

  function setMgmtTab(k) {
    if (!UI.MGMT_STATUSES.includes(k)) return;
    mgmtTab = k;
    renderMgmt();
  }

  // ── 13. POOL (pratiche non assegnate) ──────────────────────────────
  const REASON_LABELS = {
    tipologia_no_match: 'Nessun collega per questa tipologia',
    filtro_stato:       'Filtro stato nessun collega',
    agente_escluso:     'Agente escluso per i colleghi compatibili',
    quota_full:         'Quota piena',
    other:              'Altro',
  };

  function renderPool() {
    const el = $('pool-content');
    if (!el) return;
    if (!dataLoaded) { el.innerHTML = spinner; return; }
    if (!activeReport) { el.innerHTML = UI.emptyState(svg('<circle cx="12" cy="12" r="10"/>', 40), 'Nessun report attivo'); return; }

    const { unassigned, regularPool, sallyPool } = poolSplit();
    if (!unassigned.length) {
      el.innerHTML = UI.emptyState(svg('<polyline points="20 6 9 17 4 12"/>', 40), 'Tutte le pratiche sono state assegnate');
      return;
    }

    const { poolPractices } = runEngine(manualAssignments());
    const reasonMap = {};
    for (const p of poolPractices) reasonMap[p.id] = p._reason;

    const searchKey = p => [p.pratica_id, p.cognome, p.nome, p.tipologia, p.agente_attuale].join(' ').toLowerCase();
    const assignOptions = colleagues.filter(c => c.active).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');

    const poolRow = (p, showAssign) => `
      <tr class="pool-row" data-search="${esc(searchKey(p))}">
        <td class="font-monospace small">${UI.praticaLink(p.pratica_id)}</td>
        <td>${esc(p.cognome)} ${esc(p.nome)}</td>
        <td class="text-muted small">${esc(p.tipologia) || '—'}</td>
        <td>${UI.statoBadge(esc(p.stato_attuale))}</td>
        <td class="text-muted small">${REASON_LABELS[reasonMap[p.id]] || '—'}</td>
        ${showAssign ? `<td>
          <select class="form-select form-select-sm" style="width:auto" data-practice="${p.id}"
            onchange="App.assignFromPool(this.dataset.practice, this.value)">
            <option value="">— assegna —</option>${assignOptions}
          </select>
        </td>` : `<td class="text-muted small">${esc(p.agente_attuale) || '—'}</td>`}
      </tr>`;

    const PAGE = 200;
    const regularShown = _poolShowAll ? regularPool : regularPool.slice(0, PAGE);

    el.innerHTML = `
      ${regularPool.length ? `
      <div class="card mb-4">
        <div class="card-header">
          <h3 class="card-title">Pool — ${fmt(regularPool.length)} pratiche non assegnate</h3>
          <div class="card-options">
            <input type="text" id="pool-search" data-fkey="pool-search" class="form-control form-control-sm" style="width:240px"
              placeholder="Cerca pratica, nome, tipologia…" value="${esc(_poolSearchTerm)}"
              oninput="App.filterPool(this.value)"/>
          </div>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-vcenter card-table">
            <thead><tr><th>Pratica</th><th>Nominativo</th><th>Tipologia</th><th>Stato</th><th>Motivo</th><th>Assegna a</th></tr></thead>
            <tbody>${regularShown.map(p => poolRow(p, true)).join('')}</tbody>
          </table>
        </div>
        ${!_poolShowAll && regularPool.length > PAGE ? `
          <div class="card-footer text-center">
            <span class="text-muted small me-2">Mostrate ${PAGE} su ${fmt(regularPool.length)}</span>
            <button class="btn btn-sm btn-outline-secondary" onclick="App.showAllPool()">Mostra tutte</button>
          </div>` : ''}
      </div>` : ''}

      ${sallyPool.length ? `
      <div class="card border-danger">
        <div class="card-header bg-danger-lt">
          <h3 class="card-title text-danger">Agenti Sally — ${fmt(sallyPool.length)} pratiche</h3>
          <div class="card-options">
            <small class="text-muted">Pool separata, non agganciata a nessun collega</small>
          </div>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-vcenter card-table">
            <thead><tr><th>Pratica</th><th>Nominativo</th><th>Tipologia</th><th>Stato</th><th>Motivo</th><th>Agente attuale</th></tr></thead>
            <tbody>${sallyPool.slice(0, 200).map(p => poolRow(p, false)).join('')}</tbody>
          </table>
        </div>
        ${sallyPool.length > 200 ? `<div class="card-footer text-muted text-center small">Mostrate 200 su ${fmt(sallyPool.length)}</div>` : ''}
      </div>` : ''}`;

    if (_poolSearchTerm) filterPool(_poolSearchTerm);
  }

  async function assignFromPool(practiceId, colleagueId) {
    if (!colleagueId) return;
    try {
      const { data: { user } } = await db.auth.getUser();
      const row = {
        practice_id:  practiceId,
        report_id:    activeReport.id,
        colleague_id: colleagueId,
        assigned_by:  user.id,
        is_manual:    true,
        assigned_at:  new Date().toISOString(),
      };
      await DB.upsertAssignment(row);
      assignments[practiceId] = { ...assignments[practiceId], ...row };
      fullRenderSoon();
    } catch (e) {
      UI.toast('Errore assegnazione: ' + e.message, 'danger');
    }
  }

  // Pool: ricerca client-side (senza perdere il focus dell'input)
  function filterPool(term) {
    _poolSearchTerm = (term || '').toLowerCase().trim();
    document.querySelectorAll('.pool-row').forEach(row => {
      row.style.display = (row.dataset.search || '').includes(_poolSearchTerm) ? '' : 'none';
    });
  }
  function showAllPool() {
    _poolShowAll = true;
    renderPool();
  }

  // ── 14. Export Excel ───────────────────────────────────────────────
  $('btn-export')?.addEventListener('click', exportExcel);

  function exportExcel() {
    if (!activeReport || !practices.length) {
      UI.toast('Nessun dato da esportare', 'warning'); return;
    }
    const rows = practices.map(p => {
      const a = assignments[p.id];
      const col = a ? colleagues.find(c => c.id === a.colleague_id) : null;
      const w = work[p.pratica_id];
      const open = w && !w.closed_at;
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
        'Stato controllo': (open && UI.WORK_STATUSES[w.status]?.label) || '',
        'Nota operatore':  (open && w.note) || '',
      };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Distribuzione');

    const poolRows = practices.filter(p => !assignments[p.id]).map(p => ({
      'Numero Pratica': p.pratica_id,
      'Cognome':        p.cognome,
      'Nome':           p.nome,
      'Tipologia':      p.tipologia,
      'Stato Attuale':  p.stato_attuale,
    }));
    if (poolRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(poolRows), 'Pool');
    XLSX.writeFile(wb, `distribuzione-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // ── 15. CHAT (stanza unica) ────────────────────────────────────────
  function renderChat() {
    const el = $('chat-content');
    if (!el) return;

    el.innerHTML = `
      <div class="card">
        <div class="card-header"><h3 class="card-title">Chat di gruppo</h3></div>
        <div id="chat-messages" class="ec-chat-messages">
          ${chatMessages.length ? chatMessages.map(m => {
            const mine = m.author_id === session.user.id;
            return `
            <div class="ec-chat-row ${mine ? 'ec-chat-row--mine' : ''}">
              ${!mine ? `<span class="avatar avatar-xs bg-blue-lt ec-chat-avatar">${esc(UI.initialsAvatar(m.author?.full_name || m.author?.email))}</span>` : ''}
              <div class="ec-chat-bubble ${mine ? 'ec-chat-bubble--mine' : ''}">
                ${!mine ? `<div class="ec-chat-author">${esc(m.author?.full_name || m.author?.email || '—')}</div>` : ''}
                <div class="ec-chat-body">${esc(m.body)}</div>
                <div class="ec-chat-time">${UI.timeAgo(m.created_at)}</div>
              </div>
            </div>`;
          }).join('') : '<div class="text-muted text-center py-4">Nessun messaggio ancora. Scrivi il primo!</div>'}
        </div>
        <div class="card-footer">
          <div class="input-group">
            <input type="text" id="chat-input" data-fkey="chat-input" class="form-control" placeholder="Scrivi un messaggio…"/>
            <button class="btn btn-primary" onclick="App.sendChat()">Invia</button>
          </div>
        </div>
      </div>`;

    $('chat-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });
  }

  function scrollChatToBottom() {
    const box = $('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  async function sendChat() {
    const input = $('chat-input');
    const body = input?.value.trim();
    if (!body) return;
    input.value = '';
    try {
      await DB.sendChatMessage(body);
      chatMessages = await DB.getChatMessages();
      renderChat();
      scrollChatToBottom();
      $('chat-input')?.focus();
    } catch (e) {
      UI.toast('Errore invio messaggio: ' + e.message, 'danger');
    }
  }

  // ── 16. NOTIFICHE ──────────────────────────────────────────────────
  function renderNotifBell() {
    const badge = $('notif-badge');
    const dropdown = $('notif-dropdown');
    if (!badge || !dropdown) return;

    const unread = notifications.filter(n => !n.read);
    badge.style.display = unread.length ? '' : 'none';
    badge.textContent = unread.length > 9 ? '9+' : unread.length;

    if (!notifications.length) {
      dropdown.innerHTML = '<div class="text-center text-muted small py-3">Nessuna notifica</div>';
      return;
    }
    dropdown.innerHTML = notifications.slice(0, 20).map(n => `
      <a href="#" class="dropdown-item ${n.read ? '' : 'bg-blue-lt'}" data-notif="${esc(n.id)}" data-pid="${esc(n.pratica_id || '')}"
        onclick="App.openNotification(this.dataset.notif, this.dataset.pid);return false;">
        <div class="small fw-medium">${esc(n.title)}</div>
        ${n.body ? `<div class="small text-muted">${esc(n.body)}</div>` : ''}
        <div class="text-muted" style="font-size:11px">${UI.timeAgo(n.created_at)}</div>
      </a>`).join('');
  }

  // Porta alla riga della pratica nel piano di lavoro che la contiene
  function revealPratica(pid) {
    const find = () => document.querySelector(`.ec-grid[data-colleague] tr[data-pid="${CSS.escape(pid)}"]`);
    let tr = find();
    if (!tr || tr.offsetParent === null) {
      const p = practiceByPid[pid];
      const owner = (p && assignments[p.id]?.colleague_id) || work[pid]?.colleague_id;
      if (owner && owner === myColleagueId) navigate('mine', null, true);
      else if (owner && canSeeAll) navigate('scheda', owner, true);
      tr = find();
    }
    if (!tr) return;
    tr.style.display = '';
    tr.scrollIntoView({ block: 'center' });
    tr.classList.add('ec-row-flash');
    setTimeout(() => tr.classList.remove('ec-row-flash'), 2500);
  }

  async function openNotification(id, praticaId) {
    try {
      await DB.markNotificationRead(id);
      const n = notifications.find(x => x.id === id);
      if (n) n.read = true;
      renderNotifBell();
    } catch (e) { /* non bloccante */ }
    if (praticaId) revealPratica(praticaId);
  }

  // Funzioni richiamate dagli handler inline
  window.App = window.AppRuntime = {
    setStatus, saveNote, planSearch, planChip,
    setCalled, setPoolNote, closePoolRow,
    openScheda, backToDashboard, setPeriod, setMgmtTab,
    assignFromPool, filterPool, showAllPool,
    sendChat, openNotification,
  };

  // Start (la prima navigazione avviene qui: tutte le funzioni di render sono definite)
  navigateFromHash();
  await loadActiveReport();
  await loadGlobalData();
  subscribeGlobalRealtime();
  scheduleCutoff();

})();
