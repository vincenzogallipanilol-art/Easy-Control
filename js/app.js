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
  document.getElementById('user-avatar').textContent = String(profile.full_name || profile.email || '?').trim()[0].toUpperCase();

  // 2a. Impersonificazione (solo admin): banner fisso con ritorno all'account principale
  if (Auth.isImpersonating()) {
    const real = Auth.getRealProfile();
    const bar = document.getElementById('imp-banner');
    document.getElementById('imp-target').textContent = `${profile.full_name || profile.email} (${profile.role})`;
    document.getElementById('imp-real').textContent = real.full_name || real.email;
    bar.style.display = '';
    document.body.classList.add('is-impersonating');
    document.getElementById('imp-back').addEventListener('click', () => Auth.stopImpersonating());
  }

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
  let series            = null;   // righe check_series(): null = migration non eseguita
  let seriesDays        = 7;
  let seriesMode        = 'user'; // 'user' | 'status'
  let poolTab           = 'assign';   // assign | da_chiamare | audit | xflat | help
  const poolFilter      = { q: '', st: '', tip: '', ag: '' };
  const planFilter      = {};  // colleague_id -> { q, st }
  let _poolShowAll      = false;

  // Librerie pesanti (CSV / Excel): caricate solo quando servono
  const _libs = {};
  function loadLib(url, probe) {
    if (probe()) return Promise.resolve();
    return _libs[url] || (_libs[url] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url; s.onload = resolve;
      s.onerror = () => { delete _libs[url]; reject(new Error('Impossibile caricare una libreria esterna')); };
      document.head.appendChild(s);
    }));
  }
  const needPapa = () => loadLib('https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js', () => window.Papa);
  const needXlsx = () => loadLib('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', () => window.XLSX);

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
  const ELEVATED_TARGETS = ['pool', 'scheda'];
  const ADMIN_TARGETS    = ['admin'];
  const ALL_TARGETS      = [...ELEVATED_TARGETS, ...ADMIN_TARGETS, 'dashboard', 'mine', 'chat'];
  function isTargetAllowed(target) {
    if (ADMIN_TARGETS.includes(target))    return isAdmin;
    if (ELEVATED_TARGETS.includes(target)) return canSeeAll;
    return true; // dashboard, mine, chat
  }
  const defaultTarget = () => 'dashboard';

  const navLinks = document.querySelectorAll('[data-nav]');
  const sections = document.querySelectorAll('[data-section]');

  const POOL_TABS = ['assign', 'da_chiamare', 'audit', 'xflat', 'help'];
  function navigate(target, arg, push = false) {
    if (target === 'gestione') { target = 'pool'; arg = arg || 'audit'; }   // vecchi link
    if (!ALL_TARGETS.includes(target) || !isTargetAllowed(target)) target = defaultTarget();
    if (target === 'scheda') {
      if (arg) schedaColleagueId = arg;
      if (!schedaColleagueId) target = 'dashboard';
    }
    if (target === 'pool' && arg && POOL_TABS.includes(arg) && arg !== poolTab) {
      poolTab = arg; _poolShowAll = false;
      Object.assign(poolFilter, { q: '', st: '', tip: '', ag: '' });
    }
    currentTarget = target;
    updateHeader(target);

    const navKey = target === 'scheda' ? 'dashboard' : target;
    navLinks.forEach(l => l.classList.toggle('active', l.dataset.nav === navKey));
    sections.forEach(s => {
      s.style.display = (isTargetAllowed(s.dataset.section) && s.dataset.section === target) ? '' : 'none';
    });
    const hash = '#' + target + (target === 'scheda' ? ':' + encodeURIComponent(schedaColleagueId) : target === 'pool' ? ':' + poolTab : '');
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
  document.querySelector('[data-nav-home]')?.addEventListener('click', e => { e.preventDefault(); navigate(defaultTarget(), null, true); });

  // Intestazione: saluto + sottotitolo della pagina
  const SUBTITLES = {
    dashboard: isElevatedView() ? 'Pratiche controllate e carico di lavoro in tempo reale' : 'Il tuo carico di lavoro e le tue pratiche controllate',
    pool:      'Da assegnare, da chiamare, audit, xFlat e help',
    scheda:    'Piano di lavoro del collega',
    mine:      'Il tuo piano di lavoro di oggi',
    chat:      'Scrivi al team e tagga i colleghi',
    admin:     'Utenti, colleghi e regole di distribuzione',
  };
  function isElevatedView() { return canSeeAll; }
  function updateHeader(target) {
    const h = Number(romeParts(new Date()).hour);
    const hello = h < 13 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';
    const first = String(profile.full_name || profile.email || '').trim().split(/[\s@.]+/)[0];
    const t = $('page-greeting'), sub = $('page-subtitle');
    if (t) t.textContent = `${hello}${first ? ' ' + first : ''}!`;
    if (sub) sub.textContent = SUBTITLES[target] || '';
  }

  // ── Render: sezione corrente ───────────────────────────────────────
  function renderSection(target) {
    if (target === 'dashboard') renderDashboard();
    else if (target === 'pool') renderPool();
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
  const fullRenderSoon = debounce(fullRender, 350);

  // Aggiorna contatori/pool senza toccare la griglia del piano di lavoro
  function softRender() {
    withFocus(() => {
      if (currentTarget === 'dashboard') renderDashboard();
      else if (currentTarget === 'pool') renderPool();
      else if (currentTarget === 'mine') renderPlanExtras(myColleagueId);
      else if (currentTarget === 'scheda') { renderSchedaHead(); renderPlanExtras(schedaColleagueId); }
    });
  }
  const softRenderSoon = debounce(softRender, 150);

  // 4. Logout
  $('btn-logout')?.addEventListener('click', async () => {
    await Cache.clear();
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
      return rows;
    } catch (e) {
      work = {};
      if (DB.isMissingSchema(e)) showSchemaBanner();
      else UI.toast('Errore caricamento stati: ' + e.message, 'danger');
      return null;
    }
  }

  async function loadStats() {
    try { stats = await DB.getCheckStats(); }
    catch (e) { stats = []; if (!DB.isMissingSchema(e)) console.warn('check_stats', e); }
  }
  async function loadSeries() {
    try { series = await DB.getCheckSeries(seriesDays); }
    catch (e) { series = null; if (!DB.isMissingSchema(e)) console.warn('check_series', e); }
  }
  const refreshStatsSoon = debounce(async () => { await Promise.all([loadStats(), loadSeries()]); softRender(); }, 2000);

  // Tempi di caricamento (console.table con ?perf=1 nell'indirizzo)
  const _t0 = performance.now(), _marks = [];
  const mark = label => _marks.push([label, Math.round(performance.now() - _t0)]);
  window.__perf = _marks;
  mark('avvio app');

  // Cache locale: l'ambito dei dati e' dato dall'utente REALE (le regole RLS sono le sue)
  const cacheUid  = (Auth.getRealProfile() || profile).id;
  const seesAllDb = ['admin', 'top'].includes((Auth.getRealProfile() || profile).role);
  const ck = (kind, rid) => `${kind}:${cacheUid}:${rid}`;

  function setAssignments(list) {
    assignments = {};
    for (const a of list) assignments[a.practice_id] = a;
  }

  // Assegnazioni + stati correnti: cambiano spesso, quindi si rileggono sempre
  async function refreshLive(rid) {
    const [assignList, workRows] = await Promise.all([DB.getAssignments(rid), loadWork()]);
    mark('dati aggiornati');
    if (!activeReport || activeReport.id !== rid) return;
    setAssignments(assignList);
    indexPractices();
    fullRenderSoon();
    Cache.set(ck('assign', rid), assignList);
    if (workRows) Cache.set(ck('work', rid), workRows);
  }

  async function loadActiveReport({ fresh = false } = {}) {
    UI.showLoader('Caricamento report…');
    try {
      [activeReport, colleagues, colleagueStateFilters, config, agentExclusions] = await Promise.all([
        DB.getActiveReport(),
        DB.getColleagues(),
        DB.getAllColleagueStateFilters(),
        DB.getConfig(),
        DB.getAgentExclusions(),
      ]);
      mark('report e configurazione');

      let background = null;
      if (activeReport) {
        const rid = activeReport.id;
        const [cP, cA, cW] = await Promise.all([
          Cache.get(ck('practices', rid)),
          fresh ? null : Cache.get(ck('assign', rid)),
          fresh ? null : Cache.get(ck('work', rid)),
        ]);
        // Le pratiche di un report non cambiano mai: la cache vale se e' completa
        const practicesOk = seesAllDb && Array.isArray(cP) && activeReport.row_count && cP.length === activeReport.row_count;
        mark(practicesOk ? 'cache pratiche' : 'nessuna cache pratiche');

        if (practicesOk && Array.isArray(cA) && Array.isArray(cW)) {
          // Caricamento da cache: la pagina e' usabile subito, i dati vivi arrivano in background
          practices = cP;
          setAssignments(cA);
          work = {};
          for (const r of cW) work[r.pratica_id] = r;
          background = () => refreshLive(rid);
        } else {
          const [pr, assignList] = await Promise.all([
            practicesOk ? cP : DB.getPractices(rid),
            DB.getAssignments(rid),
            loadWork(),
          ]);
          practices = pr;
          setAssignments(assignList);
          mark('dati scaricati');
          if (seesAllDb && !practicesOk) Cache.set(ck('practices', rid), pr).then(() => Cache.dropOthers(rid));
          Cache.set(ck('assign', rid), assignList);
          Cache.set(ck('work', rid), Object.values(work));
        }
      } else {
        practices = []; assignments = {};
        await loadWork();
      }
      indexPractices();
      dataLoaded = true;
      fullRender();
      mark('pagina visibile');
      subscribeRealtime();
      if (background) background().catch(e => console.warn('aggiornamento in background', e));
    } catch (e) {
      UI.toast('Errore caricamento: ' + e.message, 'danger');
    } finally {
      UI.hideLoader();
      if (/[?&]perf\b/.test(location.search)) console.table(_marks.map(([k, ms]) => ({ fase: k, ms })));
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
        loadSeries(),
      ]);
      users = usersData;
      notifications = notifData;
      chatMessages = chatData;

      renderNotifBell();
      if (currentTarget === 'chat') { renderChat(); scrollChatToBottom(); }
      else if (currentTarget === 'scheda') fullRender();
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
          setTimeout(() => loadActiveReport({ fresh: true }), 1000);
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
      await loadActiveReport({ fresh: true });
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
      await needPapa();
      const parsed = Papa.parse(text, { header: true, delimiter: ';', skipEmptyLines: true });
      if (!parsed.data.length) throw new Error('File vuoto o formato non valido');

      const heads = parsed.meta.fields || Object.keys(parsed.data[0] || {});
      const normH = h => String(h || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const colOf = (...names) => {
        const wanted = names.map(normH);
        return heads.find(h => wanted.includes(normH(h))) || null;
      };
      const idCol = colOf('Numero pratica', 'Pratica ID', 'ID pratica', 'Id Pratica', 'pratica_id', 'Numero', 'N pratica', 'N. pratica', 'Codice pratica', 'Pratica', 'ID')
        || heads.find(h => /prat/.test(normH(h)) && !/fea|stato|tipolog/.test(normH(h))) || null;
      if (!idCol) throw new Error('Nel CSV non trovo la colonna con l\'ID pratica (es. "Numero pratica"). Colonne trovate: ' + heads.join(', '));
      const cols = {
        cognome: colOf('Cognome'), nome: colOf('Nome'), note: colOf('Note'), tipologia: colOf('Tipologia'),
        istituto_finanziario: colOf('Istituto finanziario'), agente_attuale: colOf('Agente attuale'),
        area_manager: colOf('Area Manager'), group_manager: colOf('Group Manager'), team_manager: colOf('Team Manager'),
        stato_attuale: colOf('Stato Attuale'), conformita_documentazione: colOf('Conformità Documentazione', 'Conformita Documentazione', 'Conformità'),
        originale_archiviato: colOf('Originale Archiviato'), pratica_fea: colOf('Pratica FEA'),
      };
      const val = (r, c) => (c && r[c] != null ? String(r[c]).trim() : '');
      const rows = parsed.data.map(r => {
        const o = { pratica_id: val(r, idCol) };
        for (const [k, c] of Object.entries(cols)) o[k] = val(r, c);
        return o;
      }).filter(o => o.pratica_id);
      if (!rows.length) throw new Error('Nessuna riga con ID pratica valorizzato nella colonna "' + idCol + '"');

      const report = await DB.createReport(file.name, rows.length);
      rows.forEach(r => { r.report_id = report.id; });

      UI.showLoader(`Inserimento ${rows.length} pratiche…`);
      await DB.insertPractices(rows);

      // Auto-distribuisci subito (saltando le pratiche gia' lavorate o nei pool)
      UI.showLoader('Distribuzione automatica…');
      await loadActiveReport({ fresh: true });

      const { autoAssignments } = runEngine([]);
      if (autoAssignments.length) {
        const { data: { user } } = await db.auth.getUser();
        await DB.bulkUpsertAssignments(autoAssignments.map(a => ({ ...a, assigned_by: user.id })));
      }

      UI.toast(`Report caricato: ${rows.length} pratiche, ${autoAssignments.length} assegnate`, 'success');
      await loadActiveReport({ fresh: true });
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
    if (!canSeeAll) { renderMyDashboard(el); return; }

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
        <div class="ec-kpis mb-3">
          ${UI.kpiTile('Pratiche totali',   fmt(practices.length),   iconDoc(),   'blue')}
          ${UI.kpiTile('Assegnate',         fmt(assignedCount),      iconCheck(), 'green')}
          ${UI.kpiTile('In Pool',           fmt(regularPool.length), iconPool(),  'orange', '', "App.goPool('assign')")}
          ${UI.kpiTile('Controllate oggi',  fmt(checkedToday),       iconEye(),   'teal')}
          ${kpi.sallyHooked ? UI.kpiTile('Agenti Sally (agganciati)', fmt(kpi.sallyHooked), iconExcl(), 'cyan') : ''}
          ${sallyPool.length ? UI.kpiTile('Agenti Sally (pool)', fmt(sallyPool.length), iconExcl(), 'red', '', "App.goPool('assign')") : ''}
          ${UI.kpiTile('Giorni lavorativi', config.working_days || 1, iconCal(),  'purple')}
        </div>`;
    }

    const pc = poolCounts();
    const poolTile = (key, label, icon, color) =>
      UI.kpiTile(label, fmt(pc[key].pool), icon, color, pc[key].today ? `+${fmt(pc[key].today)} alle 19` : '', `App.goPool('${key}')`);

    const noId = activeReport ? practices.reduce((n, p) => n + (p.pratica_id ? 0 : 1), 0) : 0;
    const noIdAlert = noId ? `
      <div class="alert alert-warning mb-3" role="alert">
        <strong>${fmt(noId)} pratiche senza ID pratica</strong>: senza ID non c'è il link alla pratica e non si possono salvare stato e nota.
        ${isAdmin ? 'Ricarica il CSV (colonna "Numero pratica" o "Pratica ID") con "Carica report".' : 'Chiedi a un admin di ricaricare il report.'}
      </div>` : '';

    el.innerHTML = `
      ${noIdAlert}
      ${top}
      <div class="ec-kpis mb-4">
        ${poolTile('da_chiamare', 'Pool Da chiamare', iconPhone(), 'orange')}
        ${poolTile('audit',       'Pool Audit',       iconFlag(),  'red')}
        ${poolTile('xflat',       'Pool xFlat',       iconFlag(),  'purple')}
        ${poolTile('help',        'Pool Help',        iconFlag(),  'cyan')}
      </div>

      ${chartsHtml()}

      <div class="ec-section-head mt-4 mb-3">
        <h3 class="mb-0">${svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', 22)} Numeri per utente</h3>
        <div class="btn-group ec-seg" role="group" aria-label="Periodo">
          ${Object.entries(PERIODS).map(([k, p]) => `
            <button type="button" class="btn ${k === statsPeriod ? 'btn-primary' : ''}" onclick="App.setPeriod('${k}')">${p.label}</button>`).join('')}
        </div>
      </div>
      ${colleagueBoxesHtml()}

      ${activeReport ? distributionHtml() : ''}`;
    UI.mountLineCharts(el);
  }

  // Dashboard di un utente semplice: solo i propri numeri
  function renderMyDashboard(el) {
    const per = PERIODS[statsPeriod];
    let kpis = '';
    if (!myColleagueId) {
      kpis = UI.emptyState(svg('<path d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>', 40),
        'Il tuo account non è collegato a nessun collega. Contatta un admin per il collegamento.');
    } else if (!activeReport) {
      kpis = UI.emptyState(svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', 40), 'Nessun report attivo. Contatta un admin.');
    } else {
      const { rows, calls } = planData(myColleagueId);
      const todo = rows.filter(p => !effStatus(p.pratica_id || '')).length;
      const checked = stats.reduce((n, r) => n + Number(r[per.field] || 0), 0);
      kpis = `
        <div class="ec-kpis mb-4">
          ${UI.kpiTile('Nel mio piano',   fmt(rows.length), iconDoc(),   'blue',   '', "App.goMine()")}
          ${UI.kpiTile('Da lavorare',     fmt(todo),        iconPool(),  'orange', '', "App.goMine()")}
          ${UI.kpiTile(`Controllate ${per.text}`, fmt(checked), iconEye(), 'teal')}
          ${UI.kpiTile('Da chiamare',     fmt(calls.length), iconPhone(), 'purple', '', "App.goMine()")}
        </div>`;
    }
    el.innerHTML = `
      ${kpis}
      ${chartsHtml()}
      <div class="ec-section-head mt-4 mb-3">
        <h3 class="mb-0">${svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>', 22)} I miei numeri</h3>
        <div class="btn-group ec-seg" role="group" aria-label="Periodo">
          ${Object.entries(PERIODS).map(([k, p]) => `
            <button type="button" class="btn ${k === statsPeriod ? 'btn-primary' : ''}" onclick="App.setPeriod('${k}')">${p.label}</button>`).join('')}
        </div>
      </div>
      ${colleagueBoxesHtml()}`;
    UI.mountLineCharts(el);
  }
  const goMine = () => navigate('mine', null, true);
  const goPool = tab => navigate('pool', tab, true);

  // Colleghi visibili in dashboard: tutti per Admin/Top, solo il proprio per un utente semplice
  const visibleColleagues = () => colleagues.filter(c => c.active && (canSeeAll || c.id === myColleagueId));

  // Ultimi N giorni (data italiana), ancorati al giorno di oggi a Roma
  function lastDays(n) {
    const p = romeParts(new Date());
    const base = Date.UTC(+p.year, +p.month - 1, +p.day);
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
    return out;
  }
  const itDate = iso => iso.split('-').reverse().join('/');

  function chartsHtml() {
    if (series === null) return chartsFallbackHtml();
    const days = lastDays(seriesDays);
    const idx = Object.fromEntries(days.map((d, i) => [d, i]));
    const zero = () => days.map(() => 0);
    const map = new Map();
    const get = (key, name, color) => { if (!map.has(key)) map.set(key, { key, name, color, values: zero() }); return map.get(key); };

    if (seriesMode === 'status') {
      for (const [k, st] of Object.entries(UI.WORK_STATUSES)) get(k, st.short, st.hex);
      for (const r of series) { const i = idx[r.check_day]; if (i !== undefined && map.has(r.status)) map.get(r.status).values[i] += Number(r.n || 0); }
    } else {
      visibleColleagues().forEach(c => get(c.id, c.name, UI.colleagueHex(c.color_idx)));
      const extra = ['#6b7280', '#0ea5a4', '#b45309', '#7c3aed'];
      for (const r of series) {
        const i = idx[r.check_day];
        if (i === undefined) continue;
        const key = r.colleague_id || ('u:' + r.user_id);
        let s = map.get(key);
        if (!s) {
          const col = colleagues.find(c => c.id === r.colleague_id);
          s = get(key, col ? col.name : userName(r.user_id), col ? UI.colleagueHex(col.color_idx) : extra[map.size % extra.length]);
        }
        s.values[i] += Number(r.n || 0);
      }
    }
    const list = [...map.values()];
    const total = list.reduce((a, s) => a + s.values.reduce((x, y) => x + y, 0), 0);

    return `
      <div class="card ec-chart-card">
        <div class="card-header">
          <h3 class="card-title">${svg('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>', 22)}
            <span>Pratiche controllate</span> <span class="text-muted fw-normal ms-1">· ${fmt(total)} negli ultimi ${seriesDays} giorni</span></h3>
          <div class="card-options ec-chart-controls">
            <div class="btn-group ec-seg" role="group" aria-label="Serie">
              <button type="button" class="btn ${seriesMode === 'user' ? 'btn-primary' : ''}" onclick="App.setSeriesMode('user')">Per utente</button>
              <button type="button" class="btn ${seriesMode === 'status' ? 'btn-primary' : ''}" onclick="App.setSeriesMode('status')">Per stato</button>
            </div>
            <label class="ec-days"><span>Giorni</span>
              <select class="form-select form-select-sm" onchange="App.setSeriesDays(this.value)" aria-label="Giorni">
                ${[7, 14, 30, 90].map(d => `<option value="${d}" ${d === seriesDays ? 'selected' : ''}>${d}</option>`).join('')}
              </select>
            </label>
          </div>
        </div>
        <div class="card-body">
          ${UI.lineChart('checks-' + seriesMode, days.map(itDate), list, { title: 'Pratiche controllate per giorno', empty: 'Nessuna pratica controllata nel periodo' })}
        </div>
      </div>`;
  }

  async function setSeriesDays(v) {
    const n = [7, 14, 30, 90].includes(+v) ? +v : 7;
    if (n === seriesDays) return;
    seriesDays = n;
    await loadSeries();
    if (currentTarget === 'dashboard') renderDashboard();
  }
  function setSeriesMode(m) {
    if (!['user', 'status'].includes(m) || m === seriesMode) return;
    seriesMode = m;
    if (currentTarget === 'dashboard') renderDashboard();
  }

  function chartsFallbackHtml() {
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
    const per = PERIODS[statsPeriod];
    const checkedToday = statsSum(per.field, ownerKey);

    const active = visibleColleagues();
    if (!active.length) return '<div class="text-muted small">Nessun collega attivo.</div>';

    return `
      <div class="row g-3">
        ${active.map(c => {
          const s = byColleague[c.id] || { total: 0, byTipologia: {} };
          const tipRows = Object.entries(s.byTipologia).sort((a, b) => b[1] - a[1]);
          const color = UI.colleagueColor(c.color_idx);
          return `
          <div class="col-sm-6 col-lg-4 col-xxl-3">
            <a class="card ec-user-box h-100" href="${c.id === myColleagueId && !canSeeAll ? '#mine' : '#scheda:' + encodeURIComponent(c.id)}" data-colleague="${esc(c.id)}"
              onclick="App.openScheda(this.dataset.colleague);return false;">
              <div class="card-body">
                <div class="d-flex align-items-center gap-2 mb-3">
                  <span class="avatar avatar-sm bg-${color}-lt">${esc(c.name[0] || '?')}</span>
                  <strong class="text-truncate">${esc(c.name)}</strong>
                  <span class="ms-auto text-muted small text-nowrap">Apri piano →</span>
                </div>
                <div class="ec-box-nums">
                  <div><strong>${fmt(s.total)}</strong><span>Assegnate</span></div>
                  <div><strong>${fmt(checkedToday[c.id] || 0)}</strong><span>Controllate ${per.text}</span></div>
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
  const PLAN_PAGE = 150;
  const planView  = {};  // colleague_id -> { rows, filtered, limit } (righe disegnate a blocchi)
  const dash = '<span class="text-muted">—</span>';
  const cell = v => `<td title="${esc(v)}">${v ? esc(v) : dash}</td>`;

  // Chi puo' modificare il piano di un collega: Admin tutti; Top se stesso e gli utenti semplici;
  // un utente semplice solo il proprio.
  function canEditColleague(colleagueId) {
    if (isAdmin) return true;
    if (colleagueId && colleagueId === myColleagueId) return true;
    if (!canSeeAll) return false;
    const owners = users.filter(u => u.colleague_id === colleagueId && u.status !== 'pending');
    return owners.every(u => u.role === 'user' || u.id === profile.id);
  }

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

  function planRowHtml(p, ro) {
    const pid = p.pratica_id || '';
    const { w } = workState(pid);
    const st  = effStatus(pid);
    const def = UI.WORK_STATUSES[st];
    const off = (pid && !ro) ? '' : 'disabled';

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
      <tr data-pid="${esc(pid)}" data-st="${st}"
          class="${def ? 'has-st' : ''}${pid in pending ? ' is-pending' : ''}" ${def ? `style="--st:${def.hex}"` : ''}>
        <td class="ec-col-id">${UI.praticaLink(pid)}</td>
        ${cells}
        <td class="ec-col-status">
          <select class="form-select form-select-sm ec-status-select" data-fkey="st:${esc(pid)}" ${off}
            aria-label="Stato pratica ${esc(pid)}" onchange="App.setStatus(this)">${statusOptions(st)}</select>
        </td>
      </tr>`;
  }

  function callPoolHtml(calls, colleagueId) {
    if (!calls.length) return '';
    const ro = colleagueId && !canEditColleague(colleagueId) ? 'disabled' : '';
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
                      aria-label="Chiamato" onchange="App.setCalled(this)" ${ro}>
                      <option value="0" ${w.called ? '' : 'selected'}>No</option>
                      <option value="1" ${w.called ? 'selected' : ''}>Sì</option>
                    </select>
                  </td>
                  <td class="ec-col-note">
                    <input type="text" class="form-control form-control-sm ec-note-input" data-fkey="pnote:${esc(w.pratica_id)}"
                      value="${esc(w.pool_note || '')}" placeholder="Esito della chiamata…" maxlength="1000" autocomplete="off"
                      aria-label="Note chiamata" onchange="App.setPoolNote(this)" onkeydown="if(event.key==='Enter')this.blur()" ${ro}/>
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
    planView[colleagueId] = { rows, filtered: rows, limit: (planView[colleagueId] || {}).limit || PLAN_PAGE };

    const noId = rows.reduce((n, p) => n + (p.pratica_id ? 0 : 1), 0);
    const grid = rows.length ? `
      ${noId ? `<div class="alert alert-warning m-3" role="alert">${fmt(noId)} pratiche senza ID pratica: stato e nota non sono modificabili. Chiedi a un admin di ricaricare il report.</div>` : ''}
      <div class="ec-grid-wrap">
        <table class="ec-grid" data-colleague="${cid}">
          <thead><tr>
            <th class="ec-col-id">Pratica</th>
            ${PLAN_COLS.map(([, label]) => `<th>${label}</th>`).join('')}
            <th class="ec-col-status">Stato</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="card-footer text-muted small d-flex flex-wrap gap-3">
        <span data-plan-count></span>
        <span class="ms-auto">Alle 19 le pratiche con uno stato lasciano il piano: Conforme e Richiesta integrazioni vengono eliminate dall'elenco e conteggiate nei rispettivi numeri; le altre passano ai rispettivi pool.</span>
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
      <div data-plan-call="${cid}">${callPoolHtml(calls, colleagueId)}</div>`;
  }

  // Chip di riepilogo/filtro sopra la griglia (contati sui dati, non sul DOM)
  function renderChips(card) {
    const box = card.querySelector('[data-plan-chips]');
    const v = planView[card.dataset.plan];
    if (!box || !v) return;
    const f = planFilter[card.dataset.plan] || { q: '', st: '' };
    const counts = { todo: 0 };
    for (const p of v.rows) { const s = effStatus(p.pratica_id || '') || 'todo'; counts[s] = (counts[s] || 0) + 1; }

    const chip = (key, label, n, hex) => `
      <button type="button" class="ec-chip ${f.st === key ? 'is-active' : ''}" data-chip="${key}" onclick="App.planChip(this)" aria-pressed="${f.st === key}">
        ${hex ? `<span class="ec-st-dot" style="background:${hex}"></span>` : ''}${label} <strong>${fmt(n)}</strong>
      </button>`;
    box.innerHTML =
      chip('', 'Tutte', v.rows.length) +
      chip('todo', 'Da lavorare', counts.todo) +
      Object.entries(UI.WORK_STATUSES).map(([k, s]) => chip(k, s.short, counts[k] || 0, s.hex)).join('');
  }

  // Il piano puo' avere migliaia di righe: se ne disegnano a blocchi (scroll infinito)
  const planMoreObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
        for (const e of entries) if (e.isIntersecting) planMore(e.target.querySelector('button'));
      }, { rootMargin: '800px' })
    : null;

  function planMoreRow(left) {
    return left > 0
      ? `<tr class="ec-more"><td colspan="${PLAN_COLS.length + 2}">
           <button type="button" class="btn btn-sm btn-outline-secondary" onclick="App.planMore(this)">Mostra altre ${fmt(Math.min(left, PLAN_PAGE))} di ${fmt(left)}</button>
         </td></tr>`
      : '';
  }

  function filterPlanRows(colleagueId) {
    const v = planView[colleagueId];
    const f = planFilter[colleagueId] || { q: '', st: '' };
    const q = f.q.toLowerCase().trim();
    v.filtered = v.rows.filter(p => {
      const pid = p.pratica_id || '';
      if (f.st) {
        const st = effStatus(pid);
        if (f.st === 'todo' ? st : st !== f.st) return false;
      }
      if (!q) return true;
      const w = workState(pid).w;
      return [pid, p.cognome, p.nome, p.tipologia, p.istituto_finanziario, p.agente_attuale, p.stato_attuale, w?.note]
        .join(' ').toLowerCase().includes(q);
    });
  }

  function renderPlanBody(card) {
    const cid = card.dataset.plan;
    const v = planView[cid];
    const tbody = card.querySelector('.ec-grid tbody');
    if (!v || !tbody) return;
    filterPlanRows(cid);
    const slice = v.filtered.slice(0, v.limit);
    const ro = !canEditColleague(cid);
    tbody.innerHTML = slice.map(p => planRowHtml(p, ro)).join('') + planMoreRow(v.filtered.length - slice.length);
    const more = tbody.querySelector('.ec-more');
    if (more && planMoreObserver) planMoreObserver.observe(more);
    const cnt = card.querySelector('[data-plan-count]');
    if (cnt) cnt.textContent = v.filtered.length === v.rows.length
      ? `${fmt(v.rows.length)} pratiche` : `${fmt(v.filtered.length)} di ${fmt(v.rows.length)} pratiche`;
  }

  function planMore(btn) {
    const card = btn && btn.closest('[data-plan]');
    const v = card && planView[card.dataset.plan];
    const more = btn && btn.closest('tr.ec-more');
    if (!v || !more) return;
    if (planMoreObserver) planMoreObserver.unobserve(more);
    const from = Math.min(v.limit, v.filtered.length);
    v.limit += PLAN_PAGE;
    const slice = v.filtered.slice(from, v.limit);
    const ro = !canEditColleague(card.dataset.plan);
    more.insertAdjacentHTML('beforebegin', slice.map(p => planRowHtml(p, ro)).join(''));
    more.remove();
    const left = v.filtered.length - from - slice.length;
    if (left > 0) {
      const tbody = card.querySelector('.ec-grid tbody');
      tbody.insertAdjacentHTML('beforeend', planMoreRow(left));
      if (planMoreObserver) planMoreObserver.observe(tbody.querySelector('.ec-more'));
    }
  }

  function mountPlan(container, colleagueId) {
    container.innerHTML = planHtml(colleagueId);
    const card = container.querySelector('[data-plan]');
    if (card) { renderChips(card); renderPlanBody(card); }
  }

  // Aggiorna chip + pool "Da chiamare" senza ridisegnare la griglia
  function renderPlanExtras(colleagueId) {
    if (!colleagueId) return;
    document.querySelectorAll('[data-plan]').forEach(card => {
      if (card.dataset.plan === colleagueId) renderChips(card);
    });
    document.querySelectorAll('[data-plan-call]').forEach(box => {
      if (box.dataset.planCall === colleagueId) box.innerHTML = callPoolHtml(planData(colleagueId).calls, colleagueId);
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
    });
    document.querySelectorAll('[data-plan]').forEach(renderChips);
  }

  function planSearch(input) {
    const card = input.closest('[data-plan]');
    if (!card) return;
    (planFilter[card.dataset.plan] || (planFilter[card.dataset.plan] = { q: '', st: '' })).q = input.value;
    planFilterSoon(card);
  }
  const planFilterSoon = debounce(card => {
    const v = planView[card.dataset.plan];
    if (v) v.limit = PLAN_PAGE;
    withFocus(() => renderPlanBody(card));
  }, 180);
  function planChip(btn) {
    const card = btn.closest('[data-plan]');
    if (!card) return;
    const key = btn.dataset.chip || '';
    const f = planFilter[card.dataset.plan] || (planFilter[card.dataset.plan] = { q: '', st: '' });
    f.st = f.st === key ? '' : key;
    const v = planView[card.dataset.plan];
    if (v) v.limit = PLAN_PAGE;
    renderChips(card);
    renderPlanBody(card);
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
      if (u.id === profile.id || u.status === 'pending') continue;
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
    const linkedUsers = users.filter(u => u.colleague_id === c.id);
    const linked = linkedUsers.map(u => u.full_name || u.email);
    const impTarget = Auth.getRealProfile()?.role === 'admin' && !Auth.isImpersonating()
      ? linkedUsers.find(u => u.id !== profile.id && u.status !== 'pending') : null;
    const num = (v, label) => `<div><strong>${fmt(v)}</strong><span>${label}</span></div>`;
    return `
      <div class="d-flex flex-wrap align-items-center gap-3 mb-3">
        <button type="button" class="btn btn-outline-secondary" onclick="App.backToDashboard()">
          ${svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>', 18)}<span class="ms-1">Dashboard</span>
        </button>
        <span class="avatar bg-${color}-lt">${esc(c.name[0] || '?')}</span>
        <div>
          <h2 class="mb-0">Piano di lavoro — ${esc(c.name)}</h2>
          <div class="text-muted small">${linked.length ? esc(linked.join(', ')) : 'Nessun utente collegato'}${canEditColleague(c.id) ? '' : ' · <span class="badge bg-secondary-lt">Sola lettura</span>'}</div>
        </div>
        ${impTarget ? `<button type="button" class="btn btn-outline-warning" onclick="App.impersonate('${esc(impTarget.id)}')">${svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>', 18)}<span class="ms-1">Impersonifica</span></button>` : ''}
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

  function openScheda(colleagueId) {
    if (!canSeeAll) { if (colleagueId === myColleagueId) navigate('mine', null, true); return; }
    navigate('scheda', colleagueId, true);
  }
  function backToDashboard()       { navigate('dashboard', null, true); }

  // ── 13. POOL (pratiche non assegnate) ──────────────────────────────
  const REASON_LABELS = {
    tipologia_no_match: 'Nessun collega per questa tipologia',
    filtro_stato:       'Filtro stato nessun collega',
    agente_escluso:     'Agente escluso per i colleghi compatibili',
    quota_full:         'Quota piena',
    other:              'Altro',
  };

  const POOL_LABELS = { assign: 'Da assegnare', da_chiamare: 'Da chiamare', audit: 'Audit', xflat: 'xFlat', help: 'Help' };
  const poolHex = k => (UI.WORK_STATUSES[k] || {}).hex || '#206bc4';

  function mgmtRows(status) {
    return Object.values(work)
      .filter(w => w.status === status && workState(w.pratica_id).phase === (status === 'da_chiamare' ? 'call' : 'mgmt'))
      .sort((a, b) => new Date(a.set_at) - new Date(b.set_at));
  }
  const colName = id => colleagues.find(c => c.id === id)?.name || '';

  // Righe di una scheda del pool, in forma uniforme per filtri e tabelle
  function poolItems(tab) {
    if (tab === 'assign') {
      const { unassigned, regularPool, sallyPool } = poolSplit();
      const sallyIds = new Set(sallyPool.map(p => p.id));
      const { poolPractices } = runEngine(manualAssignments());
      const reason = {};
      for (const p of poolPractices) reason[p.id] = p._reason;
      return unassigned.map(p => ({
        pid: p.pratica_id, p, sally: sallyIds.has(p.id), reason: reason[p.id],
        cognome: p.cognome || '', nome: p.nome || '', tipologia: p.tipologia || '',
        agente: p.agente_attuale || '', stato: p.stato_attuale || '',
      }));
    }
    return mgmtRows(tab).map(w => {
      const p = practiceByPid[w.pratica_id] || {};
      return {
        pid: w.pratica_id, w,
        cognome: w.cognome || p.cognome || '', nome: w.nome || p.nome || '',
        tipologia: w.tipologia || p.tipologia || '', agente: w.agente_attuale || p.agente_attuale || '',
        stato: p.stato_attuale || '',
      };
    });
  }
  function poolFiltered(items) {
    const q = poolFilter.q.toLowerCase().trim();
    return items.filter(it =>
      (!poolFilter.st  || it.stato === poolFilter.st) &&
      (!poolFilter.tip || it.tipologia === poolFilter.tip) &&
      (!poolFilter.ag  || it.agente === poolFilter.ag) &&
      (!q || [it.pid, it.cognome, it.nome, it.tipologia, it.agente, it.stato].join(' ').toLowerCase().includes(q)));
  }
  function poolFiltersHtml(items) {
    const opts = key => [...new Set(items.map(i => i[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'it'));
    const sel = (field, key, label) => `
      <label>${label}
        <select class="form-select form-select-sm" data-fkey="poolf:${field}" onchange="App.poolSet('${field}', this.value)" aria-label="${label}">
          <option value="">Tutti</option>
          ${opts(key).map(v => `<option value="${esc(v)}" ${v === poolFilter[field] ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
      </label>`;
    const active = poolFilter.q || poolFilter.st || poolFilter.tip || poolFilter.ag;
    return `
      <div class="ec-pool-filters">
        <input type="search" class="form-control form-control-sm" data-fkey="pool-search" placeholder="Cerca pratica, nome, agente…"
          value="${esc(poolFilter.q)}" oninput="App.filterPool(this.value)" aria-label="Cerca nel pool"/>
        ${sel('st', 'stato', 'Stato')}${sel('tip', 'tipologia', 'Tipologia')}${sel('ag', 'agente', 'Agente')}
        ${active ? '<button type="button" class="btn btn-sm btn-outline-secondary" onclick="App.poolReset()">Azzera filtri</button>' : ''}
      </div>`;
  }

  function renderPool() {
    const el = $('pool-content');
    if (!el) return;
    if (!dataLoaded) { el.innerHTML = spinner; return; }
    if (!activeReport) { el.innerHTML = UI.emptyState(svg('<circle cx="12" cy="12" r="10"/>', 40), 'Nessun report attivo'); return; }

    const counts = { assign: poolSplit().unassigned.length };
    for (const k of ['da_chiamare', ...UI.MGMT_STATUSES]) counts[k] = mgmtRows(k).length;
    const tabs = POOL_TABS.map(k => `
      <button type="button" class="ec-chip ${k === poolTab ? 'is-active' : ''}" onclick="App.goPool('${k}')" aria-pressed="${k === poolTab}">
        <span class="ec-st-dot" style="background:${poolHex(k)}"></span>${POOL_LABELS[k]} <strong>${fmt(counts[k])}</strong>
      </button>`).join('');

    const items = poolItems(poolTab);
    const rows = poolFiltered(items);
    const note = poolTab === 'assign' ? 'Pratiche non ancora assegnate a nessun collega'
      : 'Le pratiche arrivano qui alle 19 del giorno in cui vengono segnalate';

    let body;
    if (!items.length) {
      body = UI.emptyState(svg('<polyline points="20 6 9 17 4 12"/>', 40),
        poolTab === 'assign' ? 'Tutte le pratiche sono state assegnate' : `Nessuna pratica nel pool ${POOL_LABELS[poolTab]}`);
    } else if (!rows.length) {
      body = UI.emptyState(svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', 40), 'Nessuna pratica corrisponde ai filtri');
    } else if (poolTab === 'assign') {
      body = poolAssignHtml(rows);
    } else {
      body = poolWorkHtml(rows);
    }

    el.innerHTML = `
      <div class="card">
        <div class="card-header ec-plan-toolbar">
          <div class="ec-chips">${tabs}</div>
          <small class="text-muted ms-auto">${note}${items.length ? ` · ${rows.length === items.length ? fmt(items.length) : fmt(rows.length) + ' di ' + fmt(items.length)} pratiche` : ''}</small>
        </div>
        ${items.length ? poolFiltersHtml(items) : ''}
        ${body}
      </div>`;
  }

  function poolShowMore(total, shown) {
    return total > shown ? `
      <div class="card-footer text-center">
        <span class="text-muted small me-2">Mostrate ${fmt(shown)} su ${fmt(total)}</span>
        <button class="btn btn-sm btn-outline-secondary" onclick="App.showAllPool()">Mostra tutte</button>
      </div>` : '';
  }

  // Scheda "Da assegnare": pool normale (assegnazione manuale) + Agenti Sally
  function poolAssignHtml(rows) {
    const PAGE = 200;
    const regular = rows.filter(r => !r.sally), sally = rows.filter(r => r.sally);
    const assignOptions = colleagues.filter(c => c.active).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const poolRow = (r, showAssign) => `
      <tr class="pool-row">
        <td class="font-monospace small">${UI.praticaLink(r.pid)}</td>
        <td>${esc(r.cognome)} ${esc(r.nome)}</td>
        <td class="text-muted small">${esc(r.tipologia) || '—'}</td>
        <td>${UI.statoBadge(esc(r.stato))}</td>
        <td class="text-muted small">${REASON_LABELS[r.reason] || '—'}</td>
        ${showAssign ? `<td>
          <select class="form-select form-select-sm" style="width:auto" data-practice="${r.p.id}"
            onchange="App.assignFromPool(this.dataset.practice, this.value)">
            <option value="">— assegna —</option>${assignOptions}
          </select>
        </td>` : `<td class="text-muted small">${esc(r.agente) || '—'}</td>`}
      </tr>`;
    const shown = l => _poolShowAll ? l : l.slice(0, PAGE);
    return `
      ${regular.length ? `
        <div class="table-responsive">
          <table class="table table-sm table-vcenter card-table">
            <thead><tr><th>Pratica</th><th>Nominativo</th><th>Tipologia</th><th>Stato</th><th>Motivo</th><th>Assegna a</th></tr></thead>
            <tbody>${shown(regular).map(r => poolRow(r, true)).join('')}</tbody>
          </table>
        </div>
        ${_poolShowAll ? '' : poolShowMore(regular.length, Math.min(PAGE, regular.length))}` : ''}
      ${sally.length ? `
        <div class="card-header bg-danger-lt border-top">
          <h3 class="card-title text-danger">Agenti Sally — ${fmt(sally.length)} pratiche</h3>
          <div class="card-options"><small class="text-muted">Pool separata, non agganciata a nessun collega</small></div>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-vcenter card-table">
            <thead><tr><th>Pratica</th><th>Nominativo</th><th>Tipologia</th><th>Stato</th><th>Motivo</th><th>Agente attuale</th></tr></thead>
            <tbody>${shown(sally).map(r => poolRow(r, false)).join('')}</tbody>
          </table>
        </div>
        ${_poolShowAll ? '' : poolShowMore(sally.length, Math.min(PAGE, sally.length))}` : ''}`;
  }

  // Schede "Da chiamare" / Audit / xFlat / Help (righe di practice_work)
  function poolWorkHtml(rows) {
    const PAGE = 200;
    const calls = poolTab === 'da_chiamare';
    const shown = _poolShowAll ? rows : rows.slice(0, PAGE);
    return `
      <div class="ec-grid-wrap ec-grid-wrap--auto">
        <table class="ec-grid ec-grid--pool">
          <thead><tr>
            <th>Pratica</th><th>Cognome</th><th>Nome</th><th>Note</th><th>Tipologia</th><th>Istituto Finanziario</th>
            <th>Agente Attuale</th><th>Stato Attuale</th><th>Operatore</th><th>Segnalata</th>
            ${calls ? '<th>Chiamato</th><th>Note chiamata</th>' : '<th>Note gestione</th><th></th>'}
          </tr></thead>
          <tbody>
            ${shown.map(({ w, stato }) => `
              <tr data-pid="${esc(w.pratica_id)}" class="${calls && w.called ? 'is-called' : ''}">
                <td class="ec-col-id">${UI.praticaLink(w.pratica_id)}</td>
                ${cell(w.cognome)}${cell(w.nome)}
                <td class="ec-col-wrap" title="${esc(w.note)}">${esc(w.note) || dash}</td>
                ${cell(w.tipologia)}${cell(w.istituto_finanziario)}${cell(w.agente_attuale)}
                <td>${UI.statoBadge(esc(stato))}</td>
                ${cell(colName(w.colleague_id) || userName(w.set_by))}
                <td>${new Date(w.set_at).toLocaleDateString('it-IT')}</td>
                ${calls ? `
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
                </td>` : `
                <td class="ec-col-note">
                  <input type="text" class="form-control form-control-sm ec-note-input" data-fkey="pnote:${esc(w.pratica_id)}"
                    value="${esc(w.pool_note || '')}" placeholder="Esito / azioni…" maxlength="1000" autocomplete="off"
                    aria-label="Note gestione" onchange="App.setPoolNote(this)" onkeydown="if(event.key==='Enter')this.blur()"/>
                </td>
                <td><button type="button" class="btn btn-sm btn-outline-secondary" onclick="App.closePoolRow(this)">Chiudi</button></td>`}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${_poolShowAll ? '' : poolShowMore(rows.length, Math.min(PAGE, rows.length))}`;
  }

  // Filtri del pool
  const poolRenderSoon = debounce(() => withFocus(renderPool), 180);
  function filterPool(term) { poolFilter.q = term || ''; _poolShowAll = false; poolRenderSoon(); }
  function poolSet(field, value) { poolFilter[field] = value || ''; _poolShowAll = false; withFocus(renderPool); }
  function poolReset() { Object.assign(poolFilter, { q: '', st: '', tip: '', ag: '' }); _poolShowAll = false; renderPool(); }

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

  function showAllPool() {
    _poolShowAll = true;
    renderPool();
  }

  // ── 14. Export Excel ───────────────────────────────────────────────
  $('btn-export')?.addEventListener('click', exportExcel);

  async function exportExcel() {
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
    await needXlsx();
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
    setStatus, saveNote, planSearch, planChip, planMore, setSeriesDays, setSeriesMode,
    setCalled, setPoolNote, closePoolRow,
    openScheda, backToDashboard, setPeriod, goPool, goMine,
    assignFromPool, filterPool, showAllPool, poolSet, poolReset,
    sendChat, openNotification,
    impersonate: id => Auth.impersonate(id),
  };

  // Start (la prima navigazione avviene qui: tutte le funzioni di render sono definite)
  navigateFromHash();
  await Promise.all([loadActiveReport(), loadGlobalData()]);
  subscribeGlobalRealtime();
  scheduleCutoff();

})();
