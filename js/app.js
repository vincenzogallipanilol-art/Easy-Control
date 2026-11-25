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
  let chatConv         = 'group';   // conversazione aperta: 'group' oppure l'id dell'utente
  let chatReads        = {};        // ultima lettura per conversazione (DB)
  const chatDrafts     = {};        // testo non ancora inviato per conversazione

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
    if (w.status === 'da_chiamare') {
      // resta nel pool finche' non gli viene dato un esito (Conforme / Richiesta integrazioni): mai ripulita alle 19
      return { w, phase: 'call' };
    }
    if (UI.MGMT_STATUSES.includes(w.status)) return { w, phase: 'mgmt' };
    if (new Date(w.set_at).getTime() >= cutoff) return { w, phase: 'today' };
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
      if (!p) continue;
      const ws = workState(p.pratica_id);
      const sentToday = (ws.phase === 'call' || ws.phase === 'mgmt') && new Date(ws.w.set_at).getTime() >= cutoff;
      if (ws.phase === 'today' || sentToday) baseQuotas[a.colleague_id] = (baseQuotas[a.colleague_id] || 0) + 1;
    }
    return { lockedPids, baseQuotas };
  }
  // Agenti con occhio di riguardo (Configurazione): badge rosso + avviso, assegnazione opzionale a un collega
  let _watchKey = null, _watchMap = new Map();
  function watchFor(name) {
    const k = JSON.stringify(config.watched_agents || []);
    if (k !== _watchKey) {
      _watchKey = k;
      _watchMap = new Map((Array.isArray(config.watched_agents) ? config.watched_agents : []).filter(w => w && w.name).map(w => [norm(w.name), w]));
    }
    return name && _watchMap.size ? _watchMap.get(norm(name)) || null : null;
  }
  const watchTip = w => `Agente con occhio di riguardo${w.note ? ': ' + w.note : ''}`;
  const watchTag = name => { const w = watchFor(name); return w ? ` <span class="ec-watch-tag" title="${esc(watchTip(w))}">&#9888; ${esc(name)}</span>` : ''; };
  // Avviso prima di segnalare / chiedere integrazioni su una pratica di un agente da trattare con cautela
  function watchConfirm(pid, status) {
    if (!status || status === 'conforme') return true;
    const w = watchFor(practiceByPid[pid]?.agente_attuale || work[pid]?.agente_attuale);
    if (!w) return true;
    return UI.confirm(`ATTENZIONE: ${w.name} è un agente con occhio di riguardo${w.note ? ` (${w.note})` : ''}.\nImpostare "${(UI.WORK_STATUSES[status] || {}).label || status}" sulla pratica ${pid}?`);
  }
  function dedicatedAll() {
    const ded = JSON.parse(JSON.stringify(Engine.dedicatedFromConfig(config, agentExclusions)));
    for (const w of (Array.isArray(config.watched_agents) ? config.watched_agents : [])) {
      if (!w || !w.name || !w.colleague_id) continue;
      const d = ded[w.colleague_id] || (ded[w.colleague_id] = { agents: [], only: false });
      if (!d.agents.some(a => norm(a) === norm(w.name))) d.agents.push(w.name);
    }
    return ded;
  }
  function runEngine(manual) {
    return Engine.distribute(
      practices, colleagues, colleagueStateFilters, config.working_days || 1,
      manual, [], null,
      { ...engineOpts(), dedicated: dedicatedAll() }
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
    else if (target === 'chat') chatEnter();
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
  // Una pratica (stesso pratica_id) esiste una sola volta: se il report ne contiene piu' righe
  // si tiene quella gia' assegnata (altrimenti la prima), cosi' non puo' andare a piu' persone.
  function dedupePractices() {
    const seen = new Map(); let dup = false;
    for (const p of practices) {
      const k = p.pratica_id;
      if (!k) continue;
      const cur = seen.get(k);
      if (!cur) seen.set(k, p);
      else { dup = true; if (!assignments[cur.id] && assignments[p.id]) seen.set(k, p); }
    }
    if (!dup) return;
    const keep = new Set(seen.values());
    practices = practices.filter(p => !p.pratica_id || keep.has(p));
    const ids = new Set(practices.map(p => p.id));
    for (const id of Object.keys(assignments)) if (!ids.has(id)) delete assignments[id];
  }

  function indexPractices() {
    dedupePractices();
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

  async function loadActiveReport({ fresh = false, preloaded = null } = {}) {
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
            practicesOk ? cP : (preloaded || DB.getPractices(rid)),
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
      syncNewStates();
    } catch (e) {
      UI.toast('Errore caricamento: ' + e.message, 'danger');
    } finally {
      UI.hideLoader();
      if (/[?&]perf\b/.test(location.search)) console.table(_marks.map(([k, ms]) => ({ fase: k, ms })));
    }
  }

  // Stati presenti nel report ma non ancora nella configurazione colleghi: aggiunti come disattivati (solo admin)
  async function syncNewStates() {
    if (!isAdmin || !practices.length) return;
    try {
      const known = new Set((await DB.getStateFilters()).map(r => String(r.stato).trim().toLowerCase()));
      const found = new Map();
      for (const p of practices) {
        const st = String(p.stato_attuale || '').trim();
        const k = st.toLowerCase();
        if (st && !known.has(k) && !found.has(k)) found.set(k, st);
      }
      if (!found.size) return;
      const names = [...found.values()];
      for (const stato of names) await DB.upsertStateFilter({ stato, included: false, note_mode: 'empty', conf_mode: 'empty' });
      const rows = names.map(stato => ({ stato, included: false, note_mode: 'empty', conf_mode: 'empty' }));
      for (const c of colleagues) await DB.saveColleagueStateFilters(c.id, rows);
      colleagueStateFilters = await DB.getAllColleagueStateFilters();
      UI.toast(`${names.length} nuovi stati aggiunti alla configurazione colleghi (disattivati)`, 'info');
    } catch (e) { console.warn('sync stati', e); }
  }

  // 5b. Dati indipendenti dal report attivo
  async function loadGlobalData() {
    try {
      const [usersData, notifData, chatData, readsData] = await Promise.all([
        DB.getUsers(),
        DB.getNotifications(),
        DB.getChatMessages(),
        DB.getChatReads().catch(() => null),
        loadStats(),
        loadSeries(),
      ]);
      users = usersData;
      notifications = notifData;
      chatMessages = chatData;
      chatReads = readsData || {};

      renderNotifBell();
      updateChatBadge();
      if (currentTarget === 'chat') chatEnter();
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
          const known = new Set(chatMessages.map(m => m.id));
          const fresh = d.filter(m => !known.has(m.id) && m.author_id !== session.user.id);
          chatMessages = d;
          const viewing = currentTarget === 'chat' && !document.hidden;
          const last = fresh[fresh.length - 1];
          if (last && !(viewing && chatConvOf(last) === chatConv)) {
            UI.toast(`${(last.author && (last.author.full_name || last.author.email)) || 'Chat'}: ${String(last.body).slice(0, 70)}`, 'info');
          }
          if (viewing) chatMarkRead(chatConv);
          updateChatBadge();
          if (currentTarget === 'chat') withFocus(() => renderChat());
        }).catch(() => {});
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

  // Pratiche escluse dal report all'import (stati che non richiedono controllo)
  const EXCLUDED_STATES = ['provvigioni liquidabili', 'declinat', 'rinunciat', 'annullat', 'preparazione kit affida', 'anagrafica caricata'];
  const isExcludedState = st => {
    const n = String(st || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    return EXCLUDED_STATES.some(x => n.includes(x));
  };

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
      const total = rows.length;
      const kept = rows.filter(o => !isExcludedState(o.stato_attuale));
      const excluded = total - kept.length;
      if (!kept.length) throw new Error('Tutte le pratiche del file sono in stati esclusi: nessuna da caricare');
      // Stessa pratica ripetuta nel file: si tiene la prima riga
      const seenIds = new Set(); const uniq = [];
      for (const o of kept) { if (!seenIds.has(o.pratica_id)) { seenIds.add(o.pratica_id); uniq.push(o); } }
      const dupes = kept.length - uniq.length;
      rows.length = 0; rows.push(...uniq);
      // Pratiche gia' controllate su Sally (registro Admin): non rientrano in alcun report
      let sallySkipped = 0, sallyWarn = false;
      try {
        const nrm = x => (x || '').toLowerCase().trim();
        const ded = Engine.dedicatedFromConfig(config, agentExclusions);
        const ag = [], co = [];
        for (const [cid, d] of Object.entries(ded)) for (const a of d.agents || []) { ag.push(nrm(a)); co.push(cid); }
        if (ag.length) await DB.sallySync(ag, co);
        const reg = new Set((await DB.getSallyChecked()).map(r => r.pratica_id));
        if (reg.size) {
          const keep = rows.filter(o => !reg.has(o.pratica_id));
          sallySkipped = rows.length - keep.length;
          rows.length = 0; rows.push(...keep);
        }
      } catch (e) {
        if (!DB.isMissingSchema(e)) throw e;
        sallyWarn = true;
      }
      if (!rows.length) throw new Error('Tutte le pratiche del file sono già controllate su Sally: nessuna da caricare');
      // ID generati qui: dopo l'inserimento non serve riscaricare le pratiche
      const localIds = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
      if (localIds) rows.forEach(r => { r.id = crypto.randomUUID(); });

      const report = await DB.createReport(file.name, rows.length);
      rows.forEach(r => { r.report_id = report.id; });

      UI.showLoader(`Inserimento ${rows.length} pratiche…`);
      await DB.insertPractices(rows, (n, tot) => UI.showLoader(`Inserimento pratiche… ${fmt(n)} / ${fmt(tot)}`));

      // Auto-distribuisci subito (saltando le pratiche gia' lavorate o nei pool)
      UI.showLoader('Distribuzione automatica…');
      await loadActiveReport({ fresh: true, preloaded: localIds ? rows : null });

      const { autoAssignments } = runEngine([]);
      if (autoAssignments.length) {
        UI.showLoader(`Salvataggio assegnazioni… ${fmt(autoAssignments.length)}`);
        const { data: { user } } = await db.auth.getUser();
        const saved = autoAssignments.map(a => ({ ...a, assigned_by: user.id }));
        await DB.bulkUpsertAssignments(saved);
        if (localIds) {
          setAssignments(saved);
          Cache.set(ck('assign', activeReport.id), saved);
          fullRender();
        } else {
          await loadActiveReport({ fresh: true });
        }
      }

      UI.toast(`Report caricato: ${fmt(rows.length)} pratiche${excluded ? ` (${fmt(excluded)} escluse per stato)` : ''}${dupes ? `, ${fmt(dupes)} duplicate ignorate` : ''}${sallySkipped ? `, ${fmt(sallySkipped)} già controllate su Sally escluse` : ''}, ${fmt(autoAssignments.length)} assegnate`, 'success');
      if (sallyWarn) UI.toast('Registro Sally non attivo: esegui la migration 20261121000000_sally_checked.sql nel SQL Editor di Supabase.', 'warning');
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
    // Agenti Sally: le loro pratiche non entrano nella distribuzione normale (sono dedicate a un collega)
    const ded = Engine.dedicatedFromConfig(config, agentExclusions);
    const sallySet = new Set(Object.values(ded).flatMap(v => v.agents.map(norm)));
    const unassigned  = practices.filter(p => !assignments[p.id] && workState(p.pratica_id).phase === 'none');
    const isSally     = p => sallySet.size > 0 && sallySet.has(norm(p.agente_attuale));
    return {
      unassigned,
      sallyPool:   unassigned.filter(isSally),
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
      const checked = statsSum(per.field, ownerKey)[myColleagueId] || 0;
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
    const byColleague = {}; // colleague_id -> { total, inPlan, todo, byTipologia }
    for (const p of practices) {
      const a = assignments[p.id];
      if (!a) continue;
      const b = byColleague[a.colleague_id] || (byColleague[a.colleague_id] = { total: 0, inPlan: 0, todo: 0, byTipologia: {} });
      b.total++;
      // come nel piano di lavoro: restano fuori le pratiche gia' nei pool o chiuse
      const ph = workState(p.pratica_id).phase;
      if (ph === 'none' || ph === 'today') { b.inPlan++; if (!effStatus(p.pratica_id || '')) b.todo++; }
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
          const s = byColleague[c.id] || { total: 0, inPlan: 0, todo: 0, byTipologia: {} };
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
                  <div title="Tutte le pratiche assegnate, comprese quelle già chiuse o inviate ai pool"><strong>${fmt(s.total)}</strong><span>Assegnate</span></div>
                  <div title="Le pratiche presenti nel piano di lavoro"><strong>${fmt(s.inPlan)}</strong><span>Nel piano</span></div>
                  <div title="Nel piano e senza ancora uno stato"><strong>${fmt(s.todo)}</strong><span>Da lavorare</span></div>
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
  // Valori per filtri/ordinamento per colonna (stile Excel)
  const PLAN_CF = {
    pid: p => p.pratica_id || '',
    stato: p => { const s = effStatus(p.pratica_id || ''); return s ? ((UI.WORK_STATUSES[s] || {}).label || s) : 'Da lavorare'; },
    ...Object.fromEntries(PLAN_COLS.filter(([k]) => k !== '__note').map(([k]) => [k, p => p[k]])),
  };
  const planView  = {};  // colleague_id -> { rows, filtered, limit } (righe disegnate a blocchi)
  const dash = '<span class="text-muted">—</span>';
  const cell = v => `<td title="${esc(v)}">${v ? esc(v) : dash}</td>`;
  const agentCell = v => { const w = watchFor(v); return w ? `<td title="${esc(watchTip(w))}"><span class="ec-watch-agent">&#9888; ${esc(v)}</span></td>` : cell(v); };
  // Chi ha inserito lo stato (utente) e, se diverso, il piano di lavoro da cui arriva
  function senderCell(w) {
    const who = userName(w.set_by), plan = colName(w.colleague_id);
    const sub = plan && plan !== who && !who.toLowerCase().includes(plan.toLowerCase()) ? `<div class="text-muted small">piano di ${esc(plan)}</div>` : '';
    return `<td title="${esc(who)}"><strong>${esc(who)}</strong>${sub}</td>`;
  }

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
            value="${esc(w?.note || '')}" placeholder="Scrivi qui la nota della pratica…" maxlength="1000" autocomplete="off" ${off}
            aria-label="Nota pratica ${esc(pid)}"
            onchange="App.saveNote(this)" onkeydown="if(event.key==='Enter')this.blur()"/>
        </td>`;
      if (key === 'stato_attuale') return `<td>${UI.statoBadge(esc(p.stato_attuale))}</td>`;
      if (key === 'agente_attuale') return agentCell(p[key]);
      return cell(p[key]);
    }).join('');

    return `
      <tr data-pid="${esc(pid)}" data-st="${st}"
          class="${def ? 'has-st' : ''}${pid in pending ? ' is-pending' : ''}${planSel.has(p.id) ? ' ec-sel' : ''}" ${def ? `style="--st:${def.hex}"` : ''}>
        <td class="ec-col-status">
          <select class="form-select form-select-sm ec-status-select" data-fkey="st:${esc(pid)}" ${off}
            aria-label="Stato pratica ${esc(pid)}" onchange="App.setStatus(this)">${statusOptions(st)}</select>
        </td>
        <td class="ec-col-id">${canSeeAll && p.id ? `<input type="checkbox" class="form-check-input m-0 me-2 align-middle ec-plan-chk" data-practice="${esc(p.id)}" ${planSel.has(p.id) ? 'checked' : ''}
          onclick="App.planToggle(this, event)" aria-label="Seleziona pratica ${esc(pid)}"/>` : ''}${UI.praticaLink(pid)}${canSeeAll && p.id ? `
          <select class="form-select form-select-sm ec-move" data-practice="${esc(p.id)}" title="Sposta a un altro collega" aria-label="Sposta pratica ${esc(pid)}"
            onmouseenter="App.moveFill(this)" onfocus="App.moveFill(this)" onchange="App.moveFromPlan(this)"><option value="">⇄</option></select>` : ''}</td>
        ${cells}
      </tr>`;
  }

  // Pool "Da chiamare": pulsante Chiamato (con orario) ed esito diretto
  const callTime = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }); };
  const calledCell = (w, dis) => w.called
    ? `<button type="button" class="ec-called-badge" data-fkey="called:${esc(w.pratica_id)}" onclick="App.setCalled(this)" ${dis} title="Chiamata fatta: clicca per annullare">&#10003; Chiamato<small>${esc(callTime(w.called_at))}</small></button>`
    : `<button type="button" class="ec-call-btn" data-fkey="called:${esc(w.pratica_id)}" onclick="App.setCalled(this)" ${dis} title="Segna che hai chiamato">Segna chiamato</button>`;
  const outcomeCell = (w, dis) => `
    <select class="form-select form-select-sm ec-outcome-select" data-fkey="out:${esc(w.pratica_id)}" aria-label="Esito pratica ${esc(w.pratica_id)}"
      onchange="App.setCallOutcome(this)" ${dis} title="Quando il cliente ha integrato: dai l'esito e la pratica esce dal pool">
      <option value="">Esito…</option><option value="conforme">Conforme</option><option value="integrazioni">Richiesta integrazioni</option>
    </select>`;

  // Selezione multipla nel pool "Da chiamare" (top/admin): trasferisce le pratiche a un altro collega
  const callSel = new Set();
  let callLast = null;
  const callSelPids = () => [...callSel].filter(pid => work[pid] && workState(pid).phase === 'call');
  const callChk = pid => canSeeAll
    ? `<input type="checkbox" class="form-check-input m-0 me-2 align-middle ec-call-chk" data-pid="${esc(pid)}" ${callSel.has(pid) ? 'checked' : ''}
        onclick="App.callToggle(this, event)" aria-label="Seleziona pratica ${esc(pid)}"/>` : '';
  function callBarHtml() {
    if (!canSeeAll) return '';
    const n = callSelPids().length;
    const opts = colleagues.filter(c => c.active).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    return `
      <div class="card-body py-2 border-bottom d-flex flex-wrap align-items-center gap-2${n ? ' ec-bulk-bar' : ''}" data-call-bar>
        <label class="form-check m-0 d-flex align-items-center gap-1 small text-muted" title="Seleziona tutte le pratiche mostrate">
          <input type="checkbox" class="form-check-input m-0 ec-call-all" onclick="App.callToggleAll(this)" aria-label="Seleziona tutte le pratiche mostrate"/> Seleziona</label>
        ${n ? `<strong>${fmt(n)} selezionate</strong>
        <select class="form-select form-select-sm" style="width:auto" data-call-to><option value="">— trasferisci a —</option>${opts}</select>
        <button type="button" class="btn btn-sm btn-primary" onclick="App.callBulkMove(this)">Trasferisci</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="App.callClearSel(this)">Deseleziona</button>` : ''}
      </div>`;
  }
  const callScope = el => el.closest('[data-plan-call]') || $('pool-content') || document;
  function callSyncBar(scope) {
    const bar = scope.querySelector('[data-call-bar]');
    if (!bar) return;
    const keep = bar.querySelector('[data-call-to]')?.value || '';
    bar.outerHTML = callBarHtml();
    const nb = scope.querySelector('[data-call-bar]');
    const to = nb && nb.querySelector('[data-call-to]');
    if (to && keep) to.value = keep;
    const chks = [...scope.querySelectorAll('.ec-call-chk')];
    chks.forEach(c => c.closest('tr')?.classList.toggle('ec-sel', c.checked));
    const all = nb && nb.querySelector('.ec-call-all');
    if (all) { const n = chks.filter(c => c.checked).length; all.checked = chks.length > 0 && n === chks.length; all.indeterminate = n > 0 && n < chks.length; }
  }
  function callToggle(el, ev) {
    const scope = callScope(el), pid = el.dataset.pid;
    const chks = [...scope.querySelectorAll('.ec-call-chk')];
    if (ev && ev.shiftKey && callLast && callLast !== pid) {
      const a = chks.findIndex(c => c.dataset.pid === callLast), b = chks.findIndex(c => c.dataset.pid === pid);
      if (a > -1 && b > -1) for (const c of chks.slice(Math.min(a, b), Math.max(a, b) + 1)) { c.checked = el.checked; el.checked ? callSel.add(c.dataset.pid) : callSel.delete(c.dataset.pid); }
    } else if (el.checked) callSel.add(pid); else callSel.delete(pid);
    callLast = pid;
    callSyncBar(scope);
  }
  function callToggleAll(el) {
    const scope = callScope(el);
    scope.querySelectorAll('.ec-call-chk').forEach(c => { c.checked = el.checked; el.checked ? callSel.add(c.dataset.pid) : callSel.delete(c.dataset.pid); });
    callLast = null;
    callSyncBar(scope);
  }
  function callClearSel(btn) {
    const scope = callScope(btn);
    callSel.clear(); callLast = null;
    scope.querySelectorAll('.ec-call-chk').forEach(c => { c.checked = false; });
    callSyncBar(scope);
  }
  async function callBulkMove(btn) {
    const scope = callScope(btn);
    const to = scope.querySelector('[data-call-to]')?.value;
    if (!to) { UI.toast('Scegli il collega a cui trasferire', 'warning'); return; }
    const pids = callSelPids();
    if (!pids.length) return;
    if (!UI.confirm(`Trasferire ${pids.length} pratiche da chiamare a ${colName(to)}?`)) return;
    try {
      const rows = await DB.moveWork(pids, to);
      for (const r of rows) { work[r.pratica_id] = r; callSel.delete(r.pratica_id); }
      // la pratica passa anche nel piano del nuovo collega (dove tornera' con l'esito)
      const { data: { user } } = await db.auth.getUser();
      const now = new Date().toISOString();
      const asg = rows.map(r => practiceByPid[r.pratica_id])
        .filter(p => p && p.id && activeReport && assignments[p.id]?.colleague_id !== to)
        .map(p => ({ practice_id: p.id, report_id: activeReport.id, colleague_id: to, assigned_by: user.id, is_manual: true, assigned_at: now }));
      if (asg.length) {
        await DB.bulkUpsertAssignments(asg);
        for (const r of asg) assignments[r.practice_id] = { ...assignments[r.practice_id], ...r };
      }
      if (rows.length < pids.length) UI.toast(`${rows.length} pratiche trasferite su ${pids.length}: le altre non sono modificabili con il tuo ruolo`, 'warning');
      else UI.toast(`${rows.length} pratiche da chiamare trasferite a ${colName(to)}`, 'success');
      fullRenderSoon();
    } catch (e) { UI.toast('Errore trasferimento: ' + e.message, 'danger'); }
  }

  function callPoolHtml(calls, colleagueId) {
    if (!calls.length) return '';
    const ro = colleagueId && !canEditColleague(colleagueId) ? 'disabled' : '';
    return `
      <div class="card mt-4">
        <div class="card-header">
          <h3 class="card-title"><span class="ec-st-dot" style="background:${UI.WORK_STATUSES.da_chiamare.hex}"></span> Da chiamare — ${calls.length}</h3>
        </div>
        ${callBarHtml()}
        <div class="ec-grid-wrap ec-grid-wrap--auto">
          <table class="ec-grid ec-grid--pool">
            <thead><tr>
              <th>Pratica ID</th><th>Cognome</th><th>Note</th><th>Tipologia</th><th>Istituto Finanziario</th>
              <th>Agente Attuale</th><th>Chiamato</th><th>Note Chiamata</th><th>Esito</th>
            </tr></thead>
            <tbody>
              ${calls.map(w => `
                <tr data-pid="${esc(w.pratica_id)}" class="${w.called ? 'is-called' : ''}${callSel.has(w.pratica_id) ? ' ec-sel' : ''}">
                  <td class="ec-col-id">${callChk(w.pratica_id)}${UI.praticaLink(w.pratica_id)}</td>
                  ${cell(w.cognome)}
                  <td class="ec-col-wrap" title="${esc(w.note)}">${esc(w.note) || dash}</td>
                  ${cell(w.tipologia)}${cell(w.istituto_finanziario)}${agentCell(w.agente_attuale)}
                  <td>${calledCell(w, ro)}</td>
                  <td class="ec-col-note">
                    <input type="text" class="form-control form-control-sm ec-note-input" data-fkey="pnote:${esc(w.pratica_id)}"
                      value="${esc(w.pool_note || '')}" placeholder="Esito della chiamata…" maxlength="1000" autocomplete="off"
                      aria-label="Note chiamata" onchange="App.setPoolNote(this)" onkeydown="if(event.key==='Enter')this.blur()" ${ro}/>
                  </td>
                  <td>${outcomeCell(w, ro)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function planHtml(colleagueId) {
    const { rows, calls } = planData(colleagueId);
    const f = planFilter[colleagueId] || (planFilter[colleagueId] = { q: '', st: 'todo' });
    const cid = esc(colleagueId);
    planView[colleagueId] = { rows, filtered: rows, limit: (planView[colleagueId] || {}).limit || PLAN_PAGE };
    ColFilter.register('plan:' + colleagueId, {
      all: () => (planView[colleagueId] || { rows: [] }).rows,
      cols: PLAN_CF,
      onChange: () => {
        const v = planView[colleagueId];
        if (v) v.limit = PLAN_PAGE;
        document.querySelectorAll('[data-plan]').forEach(c => {
          if (c.dataset.plan === colleagueId) { renderChips(c); renderPlanBody(c); }
        });
      },
    });

    const noId = rows.reduce((n, p) => n + (p.pratica_id ? 0 : 1), 0);
    const grid = rows.length ? `
      ${noId ? `<div class="alert alert-warning m-3" role="alert">${fmt(noId)} pratiche senza ID pratica: stato e nota non sono modificabili. Chiedi a un admin di ricaricare il report.</div>` : ''}
      <div class="ec-grid-wrap">
        <table class="ec-grid" data-colleague="${cid}">
          <thead><tr>
            ${ColFilter.th('plan:' + colleagueId, 'stato', 'Stato', 'ec-col-status')}
            ${ColFilter.th('plan:' + colleagueId, 'pid', 'Pratica', 'ec-col-id')}
            ${PLAN_COLS.map(([k, label]) => k === '__note' ? '<th class="ec-th-note">Note pratica</th>' : ColFilter.th('plan:' + colleagueId, k, label)).join('')}
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="card-footer text-muted small d-flex flex-wrap gap-3">
        <span data-plan-count></span>
        <span class="ms-auto">Da chiamare, Audit, xFlat e Help passano subito ai rispettivi pool. Alle 19 Conforme e Richiesta integrazioni vengono eliminate dall'elenco e conteggiate nei rispettivi numeri.</span>
      </div>`
      : UI.emptyState(svg('<polyline points="20 6 9 17 4 12"/>', 40),
          activeReport ? 'Nessuna pratica da lavorare nel piano' : 'Nessun report attivo');

    return `
      <div class="card ec-plan" data-plan="${cid}">
        <div class="card-header ec-plan-toolbar">
          ${canSeeAll && rows.length ? `<label class="form-check m-0 d-flex align-items-center gap-1 text-muted small" title="Seleziona tutte le pratiche filtrate">
            <input type="checkbox" class="form-check-input m-0 ec-plan-all" onclick="App.planToggleAll(this)" aria-label="Seleziona tutte le pratiche filtrate"/> Seleziona</label>` : ''}
          <div class="ec-chips" data-plan-chips></div>
          <div class="ms-auto d-flex align-items-center gap-3">
            <small class="text-muted d-none d-xxl-inline">Scrivi @nome nella nota per taggare un collega</small>
            <button type="button" class="btn btn-orange fw-bold" onclick="App.openModelli()">Modelli</button>
            <input type="search" class="form-control form-control-sm ec-plan-search" data-fkey="plansearch:${cid}"
              placeholder="Cerca pratica, nome, agente…" value="${esc(f.q)}" aria-label="Cerca nel piano" oninput="App.planSearch(this)"/>
          </div>
        </div>
        <div data-plan-bulk></div>
        <div data-plan-refill="${cid}"></div>
        ${grid}
      </div>
      <div data-plan-call="${cid}">${callPoolHtml(calls, colleagueId)}</div>`;
  }

  // Chip di riepilogo/filtro sopra la griglia (contati sui dati, non sul DOM)
  function renderChips(card) {
    const box = card.querySelector('[data-plan-chips]');
    const v = planView[card.dataset.plan];
    if (!box || !v) return;
    const f = planFilter[card.dataset.plan] || { q: '', st: 'todo' };
    const counts = { todo: 0 };
    for (const p of v.rows) { const s = effStatus(p.pratica_id || '') || 'todo'; counts[s] = (counts[s] || 0) + 1; }

    // pratiche gia' inviate ai pool da questo collega
    const sent = {};
    for (const w of Object.values(work)) {
      if (w.colleague_id !== card.dataset.plan || !w.status) continue;
      const ph = workState(w.pratica_id).phase;
      if (ph === 'call' || ph === 'mgmt') sent[w.status] = (sent[w.status] || 0) + 1;
    }
    const isPool = k => k === 'da_chiamare' || UI.MGMT_STATUSES.includes(k);

    const chip = (key, label, n, hex) => `
      <button type="button" class="ec-chip ${f.st === key ? 'is-active' : ''}" data-chip="${key}" ${isPool(key) ? 'data-pool="1" title="Pratiche inviate al pool"' : ''} onclick="App.planChip(this)" aria-pressed="${f.st === key}">
        ${hex ? `<span class="ec-st-dot" style="background:${hex}"></span>` : ''}${label} <strong>${fmt(n)}</strong>
      </button>`;
    box.innerHTML =
      chip('', 'Tutte', v.rows.length) +
      chip('todo', 'Da lavorare', counts.todo) +
      Object.entries(UI.WORK_STATUSES).map(([k, s]) => chip(k, s.short, isPool(k) ? (sent[k] || 0) : (counts[k] || 0), s.hex)).join('') +
      (ColFilter.active('plan:' + card.dataset.plan)
        ? '<button type="button" class="ec-chip ec-chip--clear" onclick="App.planClearCols(this)">✕ Cancella filtri colonne</button>' : '');
    const rf = card.querySelector('[data-plan-refill]');
    if (rf) { const h = refillHtml(card.dataset.plan); if (rf.innerHTML !== h) rf.innerHTML = h; }
  }

  // Piano finito: compare il pulsante per richiedere altre pratiche dal pool
  function planFinished(cid) {
    if (!dataLoaded || !activeReport) return false;
    const c = colleagues.find(x => x.id === cid);
    if (!c || !c.active) return false;
    return !planData(cid).rows.some(p => workState(p.pratica_id).phase === 'none');
  }
  function refillHtml(cid) {
    if (!canEditColleague(cid) || !planFinished(cid)) return '';
    const mine = cid === myColleagueId;
    return `
      <div class="alert alert-success m-3 d-flex align-items-center gap-3 flex-wrap">
        <div class="flex-fill"><strong>${mine ? 'Hai finito le pratiche del tuo piano.' : 'Le pratiche di questo piano sono finite.'}</strong>
          Puoi richiedere altre pratiche libere dal pool, adatte alle tipologie e agli stati configurati.</div>
        <button type="button" class="btn btn-success" onclick="App.refillPlan('${esc(cid)}')">Richiedi altre pratiche</button>
      </div>`;
  }
  const refilling = new Set();
  async function refillPlan(cid) {
    if (refilling.has(cid) || !canEditColleague(cid) || !activeReport || !planFinished(cid)) return;
    const c = colleagues.find(x => x.id === cid);
    if (!c) return;
    refilling.add(cid);
    const btn = document.querySelector(`[data-plan-refill="${CSS.escape(cid)}"] button`);
    if (btn) { btn.disabled = true; btn.textContent = 'Ricerca in corso…'; }
    try {
      const nrm = x => (x || '').toLowerCase().trim();
      const dedicated = dedicatedAll();
      const tips = [...new Set([...(c.primary_tipologie || []), ...(c.secondary_tipologie || [])].map(nrm))].filter(Boolean);
      const agents = ((dedicated[cid] || {}).agents || []).map(nrm);
      const seenPid = new Set();
      const cand = (await DB.getPoolCandidates(activeReport.id, tips, agents)).filter(p => {
        if (!p.pratica_id) return true;
        if (seenPid.has(p.pratica_id) || (practiceByPid[p.pratica_id] && practiceByPid[p.pratica_id].id !== p.id)) return false;   // una pratica una volta sola
        seenPid.add(p.pratica_id); return true;
      });
      const batch = Math.max(1, c.min_quota || 20);
      const { autoAssignments } = Engine.distribute(cand, [{ ...c, max_quota: batch }], colleagueStateFilters, 1, [], [], null,
        { lockedPids: engineOpts().lockedPids, baseQuotas: {}, dedicated });
      const pick = autoAssignments.filter(a => a.colleague_id === cid);
      if (!pick.length) { UI.toast('Nessuna pratica libera adatta a te nel pool al momento', 'info'); return; }
      if (!UI.confirm(`Aggiungere ${pick.length} pratiche al piano di lavoro?`)) return;
      const got = await DB.claimPractices(cid, activeReport.id, pick.map(a => a.practice_id));
      const byId = new Map(cand.map(p => [p.id, p]));
      for (const r of got) {
        assignments[r.practice_id] = r;
        const p = byId.get(r.practice_id);
        if (p && !practiceById[p.id]) practices.push(p);
      }
      indexPractices();
      UI.toast(got.length === pick.length ? `${got.length} pratiche aggiunte al piano`
        : `${got.length} pratiche aggiunte (le altre erano appena state prese da qualcun altro)`, got.length ? 'success' : 'info');
      fullRenderSoon();
    } catch (e) {
      UI.toast(DB.isMissingSchema(e)
        ? 'Database da aggiornare: esegui la migration 20261120000000_refill_plan.sql nel SQL Editor di Supabase.'
        : 'Errore: ' + e.message, 'danger');
    } finally {
      refilling.delete(cid);
      document.querySelectorAll('[data-plan]').forEach(card => { if (card.dataset.plan === cid) renderChips(card); });
    }
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
    const f = planFilter[colleagueId] || { q: '', st: 'todo' };
    const q = f.q.toLowerCase().trim();
    // con la ricerca o i filtri colonna attivi "Da lavorare" non nasconde le pratiche gia' lavorate (altrimenti non si trovano)
    const wide = f.st === 'todo' && (q || ColFilter.active('plan:' + colleagueId));
    v.filtered = ColFilter.apply('plan:' + colleagueId, v.rows.filter(p => {
      const pid = p.pratica_id || '';
      if (f.st && !wide) {
        const st = effStatus(pid);
        if (f.st === 'todo' ? st : st !== f.st) return false;
      }
      if (!q) return true;
      const w = workState(pid).w;
      return [pid, p.cognome, p.nome, p.tipologia, p.istituto_finanziario, p.agente_attuale, p.stato_attuale, w?.note]
        .join(' ').toLowerCase().includes(q);
    }));
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
    if (canSeeAll) planSyncSel(card);
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
  // La pratica e' passata in un pool: via dal piano di lavoro, aggiornati contatori e elenco "Da chiamare"
  function leavePlan(pid) {
    for (const cid of Object.keys(planView)) {
      const v = planView[cid];
      if (!v.rows.some(p => (p.pratica_id || '') === pid)) continue;
      v.rows = v.rows.filter(p => (p.pratica_id || '') !== pid);
      document.querySelectorAll('[data-plan]').forEach(card => {
        if (card.dataset.plan === cid) { renderChips(card); renderPlanBody(card); }
      });
      renderPlanExtras(cid);
    }
    document.querySelectorAll('[data-plan]').forEach(renderChips);
  }
  function patchRow(pid) {
    const phase = workState(pid).phase;
    if (phase === 'call' || phase === 'mgmt') { leavePlan(pid); return; }
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
    (planFilter[card.dataset.plan] || (planFilter[card.dataset.plan] = { q: '', st: 'todo' })).q = input.value;
    planFilterSoon(card);
  }
  const planFilterSoon = debounce(card => {
    const v = planView[card.dataset.plan];
    if (v) v.limit = PLAN_PAGE;
    withFocus(() => renderPlanBody(card));
  }, 180);
  async function openModelli(pid) {
    // la tabella di verifica puo' essere stata cambiata da un Admin: si rilegge sempre la configurazione
    try { config = await DB.getConfig(); } catch (e) { /* si usa quella in memoria */ }
    Modelli.open({ practices: () => practices, pid, verifica: config.verifica_documenti, operator: (profile && profile.full_name) || colName(myColleagueId) || '' });
  }
  function planClearCols(btn) {
    const card = btn.closest('[data-plan]');
    if (!card) return;
    ColFilter.clear('plan:' + card.dataset.plan);
    const v = planView[card.dataset.plan];
    if (v) v.limit = PLAN_PAGE;
    renderChips(card);
    renderPlanBody(card);
  }
  function planChip(btn) {
    const card = btn.closest('[data-plan]');
    if (!card) return;
    const key = btn.dataset.chip || '';
    if (btn.dataset.pool) {
      // questi stati vivono nei pool: si apre il pool (o l'elenco "Da chiamare" sotto il piano)
      if (canSeeAll) goPool(key);
      else if (key === 'da_chiamare') {
        const box = document.querySelector('[data-plan-call]');
        if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    const f = planFilter[card.dataset.plan] || (planFilter[card.dataset.plan] = { q: '', st: 'todo' });
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
    if (!watchConfirm(pid, status)) { sel.value = effStatus(pid) || ''; return; }

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
    if (typeof Focus !== 'undefined') Focus.done(pid, status);
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
    if (typeof Focus !== 'undefined') Focus.done(pid, status);
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
      const ph = workState(pid).phase;
      if (ph === 'call' || ph === 'mgmt') UI.toast(`Pratica ${pid} spostata nel pool ${POOL_LABELS[row.status] || ''}`.trim(), 'success');

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
  async function setCalled(btn) {
    const pid = btn.closest('tr').dataset.pid;
    const called = !work[pid]?.called;
    btn.disabled = true;
    await updatePoolRow(pid, { called, called_at: called ? new Date().toISOString() : null });
    softRender();
  }
  // Esito diretto dal pool "Da chiamare": il cliente ha integrato -> Conforme / Richiesta integrazioni
  async function setCallOutcome(sel) {
    const tr = sel.closest('tr');
    const pid = tr.dataset.pid;
    const status = sel.value;
    const w = work[pid];
    if (!status || !w) return;
    const noteEl = tr.querySelector('[data-fkey^="pnote:"]');
    const note = ((noteEl && noteEl.value) || w.pool_note || '').trim();
    if (status !== 'conforme' && !note) {
      sel.value = '';
      UI.toast('Scrivi l\'esito nelle Note chiamata: per "Richiesta integrazioni" la nota è obbligatoria', 'warning');
      if (noteEl) noteEl.focus();
      return;
    }
    if (!watchConfirm(pid, status)) { sel.value = ''; return; }
    if (!UI.confirm(`Segnare la pratica ${pid} come "${UI.WORK_STATUSES[status].label}"? Uscirà dal pool Da chiamare.`)) { sel.value = ''; return; }
    try {
      const row = await DB.setPracticeWork({
        praticaId: pid, status, note,
        reportId: activeReport?.id || null,
        colleagueId: w.colleague_id || null,
        practice: practiceByPid[pid] || w,
      });
      if (row) work[pid] = row;
      if (typeof Focus !== 'undefined') Focus.done(pid, status);
      refreshStatsSoon();
      fullRender();
      UI.toast(`Pratica ${pid}: ${UI.WORK_STATUSES[status].label}`, 'success');
    } catch (e) {
      sel.value = '';
      UI.toast(DB.isMissingSchema(e) ? SCHEMA_MSG : 'Errore: ' + e.message, 'danger');
    }
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

  // Integra: il Top gestisce la pratica (Audit / xFlat / Help) e la rimanda a chi l'ha inviata con lo stato corretto
  function closeIntegra() { const m = $('ec-integra'); if (m) m.remove(); document.removeEventListener('keydown', onIntegraKey, true); }
  const onIntegraKey = e => { if (e.key === 'Escape') closeIntegra(); };
  function openIntegra(btn) {
    const pid = btn.closest('tr').dataset.pid, w = work[pid];
    if (!w) return;
    closeIntegra();
    const from = userName(w.set_by), plan = colName(w.colleague_id);
    const wrap = document.createElement('div');
    wrap.className = 'ec-modal'; wrap.id = 'ec-integra'; wrap.dataset.pid = pid;
    wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `
      <div class="ec-modal-box ec-log-box">
        <div class="ec-modal-head">
          <h3 class="m-0 fs-3">Integra pratica ${esc(pid)}</h3>
          <button type="button" class="btn-close ms-auto" data-close aria-label="Chiudi"></button>
        </div>
        <div class="ec-log-body">
          <p class="mb-2"><strong>${esc(w.cognome)} ${esc(w.nome)}</strong> — inviata da <strong>${esc(from)}</strong>${plan && !from.toLowerCase().includes(plan.toLowerCase()) ? ` (piano di ${esc(plan)})` : ''} come ${UI.workBadge(w.status)}</p>
          ${w.note ? `<div class="ec-src-note mb-3" style="max-width:none;white-space:normal">Nota di invio: ${esc(w.note)}</div>` : ''}
          <label class="form-label">Stato corretto</label>
          <select class="form-select mb-3" id="integra-st">
            <option value="conforme">${esc(UI.WORK_STATUSES.conforme.label)}</option>
            <option value="integrazioni">${esc(UI.WORK_STATUSES.integrazioni.label)}</option>
          </select>
          <label class="form-label">Nota per ${esc(from)} <span class="text-muted" id="integra-req"></span></label>
          <textarea class="form-control" id="integra-note" rows="3" maxlength="700" placeholder="Esito / cosa è stato fatto…">${esc(w.pool_note || '')}</textarea>
          <div class="text-muted small mt-2">La pratica esce dal pool e torna nel piano di lavoro di ${esc(plan || from)} con lo stato scelto; ${esc(from)} riceve una notifica.</div>
        </div>
        <div class="ec-log-foot">
          <button type="button" class="btn me-2" data-close>Annulla</button>
          <button type="button" class="btn btn-primary" id="integra-ok">Integra e rimanda</button>
        </div>
      </div>`;
    const sync = () => { $('integra-req').textContent = UI.WORK_STATUSES[$('integra-st').value].note ? '(obbligatoria)' : '(facoltativa)'; };
    wrap.addEventListener('click', e => {
      if (e.target === wrap || e.target.closest('[data-close]')) closeIntegra();
      else if (e.target.closest('#integra-ok')) confirmIntegra(pid);
    });
    wrap.addEventListener('change', e => { if (e.target.id === 'integra-st') sync(); });
    document.addEventListener('keydown', onIntegraKey, true);
    document.body.appendChild(wrap);
    sync();
    $('integra-note').focus();
  }
  async function confirmIntegra(pid) {
    const w = work[pid];
    if (!w) { closeIntegra(); return; }
    const st = $('integra-st').value, top = $('integra-note').value.trim(), def = UI.WORK_STATUSES[st];
    if (def.note && !top) { UI.toast(`La nota è obbligatoria per "${def.label}"`, 'warning'); $('integra-note').focus(); return; }
    const me = profile.full_name || profile.email, from = userName(w.set_by);
    const note = `Gestita da ${me}${top ? ': ' + top : ''} (${(UI.WORK_STATUSES[w.status] || {}).label || w.status} di ${from}${w.note ? ': ' + w.note : ''})`.slice(0, 1000);
    const ok = $('integra-ok'); ok.disabled = true;
    try {
      const p = practiceByPid[pid];
      // la pratica torna nel piano di chi l'ha inviata
      if (p && w.colleague_id && activeReport && assignments[p.id]?.colleague_id !== w.colleague_id) {
        const row = { practice_id: p.id, report_id: activeReport.id, colleague_id: w.colleague_id, assigned_by: profile.id, is_manual: true, assigned_at: new Date().toISOString() };
        await DB.upsertAssignment(row);
        assignments[p.id] = { ...assignments[p.id], ...row };
      }
      const row = await DB.setPracticeWork({
        praticaId: pid, status: st, note,
        reportId: (p && activeReport?.id) || w.report_id || null,
        colleagueId: w.colleague_id || null,
        practice: p || { cognome: w.cognome, nome: w.nome, tipologia: w.tipologia, istituto_finanziario: w.istituto_finanziario, agente_attuale: w.agente_attuale },
      });
      if (row) work[pid] = row;
      if (w.set_by && w.set_by !== profile.id) {
        DB.notifyMentions([w.set_by], {
          title: `${me} ha gestito la pratica ${pid}`,
          body: `${def.label}${top ? ': ' + top : ''}`, praticaId: pid,
        }).catch(() => { /* non bloccante */ });
      }
      closeIntegra();
      softRender(); refreshStatsSoon();
      UI.toast(`Pratica ${pid} integrata e rimandata a ${colName(w.colleague_id) || from} come "${def.label}"`, 'success');
    } catch (e) {
      ok.disabled = false;
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
  // Valori per filtri/ordinamento per colonna (stile Excel)
  const POOL_CF = {
    pid: r => r.pid, cognome: r => r.cognome, nome: r => r.nome,
    nominativo: r => `${r.cognome} ${r.nome}`.trim(),
    tipologia: r => r.tipologia, stato: r => r.stato, agente: r => r.agente,
    motivo: r => REASON_LABELS[r.reason] || '',
    controllata: r => wasChecked(r.pid) ? 'Già controllata' : (poolChecksFetched.has(r.pid) ? 'Non controllata' : '…'),
    istituto: r => (r.w && r.w.istituto_finanziario) || '',
    operatore: r => r.w ? (userName(r.w.set_by) || colName(r.w.colleague_id) || '') : '',
    segnalata: r => r.w ? new Date(r.w.set_at).toLocaleDateString('it-IT') : '',
  };
  const POOL_CF_SORT = { segnalata: r => r.w ? r.w.set_at : '' };

  // Pratiche del pool "Da assegnare" gia' controllate in passato (Conforme / Richiesta integrazioni), dal log dei controlli
  const poolChecked = {}, poolChecksFetched = new Set();
  let poolChecksBusy = false;
  async function ensurePoolChecks(pids) {
    const need = [...new Set(pids)].filter(p => p && !poolChecksFetched.has(p));
    if (!need.length) return false;
    const got = await DB.getLastChecks(need);
    for (const p of need) poolChecksFetched.add(p);
    Object.assign(poolChecked, got);
    return true;
  }
  function loadPoolChecks(items) {
    if (poolChecksBusy || !canSeeAll || typeof DB.getLastChecks !== 'function') return;
    const pids = items.map(r => r.pid);
    if (!pids.some(p => p && !poolChecksFetched.has(p))) return;
    poolChecksBusy = true;
    ensurePoolChecks(pids)
      .then(changed => { if (changed && currentTarget === 'pool' && poolTab === 'assign') withFocus(renderPool); })
      .catch(() => { /* il log non e' leggibile: nessun avviso */ })
      .finally(() => { poolChecksBusy = false; });
  }
  // Conformita' / Originale Archiviato gia' compilati nel report = pratica gia' lavorata prima
  const reportChecked = pid => {
    const p = practiceByPid[pid];
    if (!p) return null;
    const conf = String(p.conformita_documentazione || '').trim(), orig = String(p.originale_archiviato || '').trim();
    return conf || orig ? { conf, orig } : null;
  };
  const wasChecked = pid => !!(poolChecked[pid] || reportChecked(pid));
  const checkWhen = c => String(c.check_day || '').split('-').reverse().join('/');
  const checkWho = c => userName(c.user_id) || colName(c.colleague_id) || '';
  const checkedText = c => `${checkWhen(c)} · ${(UI.WORK_STATUSES[c.status] || {}).label || c.status}${checkWho(c) ? ' · ' + checkWho(c) : ''}`;
  const checkedCell = pid => {
    const c = poolChecked[pid];
    if (c) return `<td><span class="ec-checked-badge" title="Già controllata: ${esc(checkedText(c))}">&#10003; ${esc(checkWhen(c))}<small>${esc((UI.WORK_STATUSES[c.status] || {}).short || '')}${checkWho(c) ? ' · ' + esc(checkWho(c)) : ''}</small></span></td>`;
    const rc = reportChecked(pid);
    if (rc) {
      const det = [rc.conf && `Conformità: ${rc.conf}`, rc.orig && `Originale archiviato: ${rc.orig}`].filter(Boolean).join(' · ');
      return `<td><span class="ec-checked-badge" title="Già controllata: ${esc(det)} (dal report)">&#10003; Da report<small>${esc(det)}</small></span></td>`;
    }
    return `<td class="text-muted small">${poolChecksFetched.has(pid) ? '—' : '…'}</td>`;
  };
  // Finestra con piu' scelte: ritorna il valore del pulsante premuto (null = annulla)
  function askChoice(title, message, buttons) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'ec-modal'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
      wrap.innerHTML = `
        <div class="ec-modal-box ec-log-box">
          <div class="ec-modal-head"><h3 class="m-0 fs-3">${esc(title)}</h3></div>
          <div class="ec-log-body"><p class="mb-0">${message}</p></div>
          <div class="ec-log-foot d-flex flex-wrap gap-2 justify-content-end">
            <button type="button" class="btn" data-v="">Annulla</button>
            ${buttons.map(b => `<button type="button" class="btn ${b.cls || 'btn-primary'}" data-v="${esc(b.value)}">${esc(b.label)}</button>`).join('')}
          </div>
        </div>`;
      const end = v => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v || null); };
      const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); end(null); } };
      wrap.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) end(b.dataset.v); else if (e.target === wrap) end(null); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      const first = wrap.querySelector('.btn-primary'); if (first) first.focus();
    });
  }
  const pth = (col, label) => ColFilter.th('pool:' + poolTab, col, label);

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
    const active = poolFilter.q || poolFilter.st || poolFilter.tip || poolFilter.ag || ColFilter.active('pool:' + poolTab);
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
    if (poolTab === 'assign') loadPoolChecks(items);
    ColFilter.register('pool:' + poolTab, {
      all: () => items, cols: POOL_CF, sortKeys: POOL_CF_SORT,
      onChange: () => { _poolShowAll = false; withFocus(renderPool); },
    });
    const rows = ColFilter.apply('pool:' + poolTab, poolFiltered(items));
    const note = poolTab === 'assign' ? 'Pratiche non ancora assegnate a nessun collega'
      : 'Le pratiche arrivano qui appena viene inserito lo stato';

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
          <button type="button" class="btn btn-orange fw-bold" onclick="App.openModelli()">Modelli</button>
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
    _poolIds = rows.map(r => r.p.id);
    const poolRow = (r, showAssign) => `
      <tr class="pool-row${poolSel.has(r.p.id) ? ' table-active' : ''}">
        <td class="w-1"><input type="checkbox" class="form-check-input m-0 pool-chk" data-practice="${r.p.id}" ${poolSel.has(r.p.id) ? 'checked' : ''}
          onclick="App.poolToggle(this, event)" aria-label="Seleziona pratica ${esc(r.pid)}"/></td>
        <td class="font-monospace small">${UI.praticaLink(r.pid)}</td>
        <td>${esc(r.cognome)} ${esc(r.nome)}${showAssign ? watchTag(r.agente) : ''}</td>
        <td class="text-muted small">${esc(r.tipologia) || '—'}</td>
        <td>${UI.statoBadge(esc(r.stato))}</td>
        <td class="text-muted small">${REASON_LABELS[r.reason] || '—'}</td>
        ${checkedCell(r.pid)}
        ${showAssign ? '' : agentCell(r.agente)}
        <td>
          <select class="form-select form-select-sm" style="width:auto" data-practice="${r.p.id}"
            onchange="App.assignFromPool(this.dataset.practice, this.value)">
            <option value="">— assegna —</option>${assignOptions}
          </select>
        </td>
      </tr>`;
    const chkAll = `<th class="w-1"><input type="checkbox" class="form-check-input m-0" id="pool-chk-all" onclick="App.poolToggleAll(this)"
      ${rows.length && rows.every(r => poolSel.has(r.p.id)) ? 'checked' : ''} aria-label="Seleziona tutte le pratiche filtrate"/></th>`;
    const bar = poolSel.size ? `
      <div class="card-body py-2 border-bottom d-flex flex-wrap align-items-center gap-2 ec-bulk-bar">
        <strong>${fmt(poolSel.size)} selezionate</strong>
        <select class="form-select form-select-sm" style="width:auto" id="pool-bulk-to">
          <option value="">— assegna a —</option>${assignOptions}
        </select>
        <button type="button" class="btn btn-sm btn-primary" onclick="App.poolBulkAssign()">Assegna</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="App.poolClearSel()">Deseleziona</button>
      </div>` : '';
    const shown = l => _poolShowAll ? l : l.slice(0, PAGE);
    return `
      ${bar}
      ${regular.length ? `
        <div class="table-responsive">
          <table class="table table-sm table-vcenter card-table">
            <thead><tr>${chkAll}${pth('pid', 'Pratica')}${pth('nominativo', 'Nominativo')}${pth('tipologia', 'Tipologia')}${pth('stato', 'Stato')}${pth('motivo', 'Motivo')}${pth('controllata', 'Controllata')}<th>Assegna a</th></tr></thead>
            <tbody>${shown(regular).map(r => poolRow(r, true)).join('')}</tbody>
          </table>
        </div>
        ${_poolShowAll ? '' : poolShowMore(regular.length, Math.min(PAGE, regular.length))}` : ''}
      ${sally.length ? `
        <div class="card-header bg-danger-lt border-top">
          <h3 class="card-title text-danger">Agenti Sally — ${fmt(sally.length)} pratiche</h3>
          <div class="card-options"><small class="text-muted">Pratiche di agenti dedicati, non ancora assegnate</small></div>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-vcenter card-table">
            <thead><tr>${regular.length ? '<th class="w-1"></th>' : chkAll}${pth('pid', 'Pratica')}${pth('nominativo', 'Nominativo')}${pth('tipologia', 'Tipologia')}${pth('stato', 'Stato')}${pth('motivo', 'Motivo')}${pth('controllata', 'Controllata')}${pth('agente', 'Agente attuale')}<th>Assegna a</th></tr></thead>
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
      ${calls ? callBarHtml() : ''}
      <div class="ec-grid-wrap ec-grid-wrap--auto">
        <table class="ec-grid ec-grid--pool">
          <thead><tr>
            ${pth('pid', 'Pratica')}${pth('cognome', 'Cognome')}${pth('nome', 'Nome')}<th>Note</th>${pth('tipologia', 'Tipologia')}${pth('istituto', 'Istituto Finanziario')}
            ${pth('agente', 'Agente Attuale')}${pth('stato', 'Stato Attuale')}${pth('operatore', calls ? 'Operatore' : 'Inviata da')}${pth('segnalata', 'Segnalata')}
            ${calls ? '<th>Chiamato</th><th>Note chiamata</th><th>Esito</th>' : '<th>Note gestione</th><th></th>'}
          </tr></thead>
          <tbody>
            ${shown.map(({ w, stato }) => `
              <tr data-pid="${esc(w.pratica_id)}" class="${calls && w.called ? 'is-called' : ''}${calls && callSel.has(w.pratica_id) ? ' ec-sel' : ''}">
                <td class="ec-col-id">${calls ? callChk(w.pratica_id) : ''}${UI.praticaLink(w.pratica_id)}</td>
                ${cell(w.cognome)}${cell(w.nome)}
                <td class="ec-col-wrap" title="${esc(w.note)}">${esc(w.note) || dash}</td>
                ${cell(w.tipologia)}${cell(w.istituto_finanziario)}${agentCell(w.agente_attuale)}
                <td>${UI.statoBadge(esc(stato))}</td>
                ${senderCell(w)}
                <td>${new Date(w.set_at).toLocaleDateString('it-IT')}</td>
                ${calls ? `
                <td>${calledCell(w, '')}</td>
                <td class="ec-col-note">
                  <input type="text" class="form-control form-control-sm ec-note-input" data-fkey="pnote:${esc(w.pratica_id)}"
                    value="${esc(w.pool_note || '')}" placeholder="Esito della chiamata…" maxlength="1000" autocomplete="off"
                    aria-label="Note chiamata" onchange="App.setPoolNote(this)" onkeydown="if(event.key==='Enter')this.blur()"/>
                </td>
                <td>${outcomeCell(w, '')}</td>` : `
                <td class="ec-col-note">
                  <input type="text" class="form-control form-control-sm ec-note-input" data-fkey="pnote:${esc(w.pratica_id)}"
                    value="${esc(w.pool_note || '')}" placeholder="Esito / azioni…" maxlength="1000" autocomplete="off"
                    aria-label="Note gestione" onchange="App.setPoolNote(this)" onkeydown="if(event.key==='Enter')this.blur()"/>
                </td>
                <td class="text-nowrap">
                  <button type="button" class="btn btn-sm btn-primary" onclick="App.openIntegra(this)" title="Segna come gestita e rimanda la pratica a chi l'ha inviata">Integra</button>
                  <button type="button" class="btn btn-sm btn-outline-secondary ms-1" onclick="App.closePoolRow(this)" title="Rimuovi dal pool senza rimandarla">Chiudi</button>
                </td>`}
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
  function poolReset() { Object.assign(poolFilter, { q: '', st: '', tip: '', ag: '' }); ColFilter.clear('pool:'); _poolShowAll = false; renderPool(); }

  let poolSel = new Set(), _poolIds = [], _poolLast = null;
  function poolToggle(el, ev) {
    const id = el.dataset.practice;
    if (ev && ev.shiftKey && _poolLast && _poolLast !== id) {
      const a = _poolIds.indexOf(_poolLast), b = _poolIds.indexOf(id);
      if (a > -1 && b > -1) for (const x of _poolIds.slice(Math.min(a, b), Math.max(a, b) + 1)) el.checked ? poolSel.add(x) : poolSel.delete(x);
    } else if (el.checked) poolSel.add(id); else poolSel.delete(id);
    _poolLast = id;
    withFocus(renderPool);
  }
  function poolToggleAll(el) {
    for (const id of _poolIds) el.checked ? poolSel.add(id) : poolSel.delete(id);
    withFocus(renderPool);
  }
  function poolClearSel() { poolSel.clear(); _poolLast = null; renderPool(); }
  async function poolBulkAssign() {
    const to = $('pool-bulk-to')?.value;
    if (!to) { UI.toast('Scegli il collega a cui assegnare', 'warning'); return; }
    let ids = [...poolSel].filter(id => practiceById[id]);
    if (!ids.length) return;
    try { await ensurePoolChecks(ids.map(id => practiceById[id].pratica_id)); } catch (_) { /* log non leggibile */ }
    const done = ids.filter(id => wasChecked(practiceById[id].pratica_id));
    if (done.length) {
      const free = ids.length - done.length;
      const doneSet = new Set(done);
      const msg = free
        ? `Ne hai selezionate <strong>${fmt(ids.length)}</strong>, ma solo <strong>${fmt(free)}</strong> non sono ancora state controllate (<strong>${fmt(done.length)}</strong> già controllate in passato o con Conformità/Originale archiviato già compilati).<br>Vuoi assegnare a ${esc(colName(to))} solo le ${fmt(free)} non controllate?`
        : `Le <strong>${fmt(ids.length)}</strong> pratiche selezionate sono tutte già state controllate in passato. Vuoi assegnarle comunque a ${esc(colName(to))}?`;
      const buttons = free
        ? [{ value: 'free', label: `Solo le ${fmt(free)} non controllate` }, { value: 'all', label: `Tutte le ${fmt(ids.length)}`, cls: 'btn-outline-primary' }]
        : [{ value: 'all', label: 'Assegna comunque' }];
      const choice = await askChoice('Pratiche già controllate', msg, buttons);
      if (!choice) return;
      if (choice === 'free') ids = ids.filter(id => !doneSet.has(id));
    }
    if (!ids.length) return;
    try {
      const { data: { user } } = await db.auth.getUser();
      const now = new Date().toISOString();
      const rows = ids.map(id => ({ practice_id: id, report_id: activeReport.id, colleague_id: to, assigned_by: user.id, is_manual: true, assigned_at: now }));
      await DB.bulkUpsertAssignments(rows);
      for (const r of rows) assignments[r.practice_id] = { ...assignments[r.practice_id], ...r };
      poolSel.clear(); _poolLast = null;
      UI.toast(`${rows.length} pratiche assegnate a ${colName(to)}`, 'success');
      fullRenderSoon();
    } catch (e) { UI.toast('Errore assegnazione: ' + e.message, 'danger'); }
  }

  // Top/admin: sposta una pratica dalla scheda di un collega a un altro
  function moveFill(sel) {
    if (sel.dataset.filled) return;
    const cur = sel.closest('[data-colleague]')?.dataset.colleague;
    sel.insertAdjacentHTML('beforeend', colleagues.filter(c => c.active && c.id !== cur)
      .map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''));
    sel.dataset.filled = '1';
  }
  async function moveFromPlan(sel) {
    const to = sel.value;
    if (!to) return;
    const id = sel.dataset.practice, tr = sel.closest('tr');
    try {
      const { data: { user } } = await db.auth.getUser();
      const row = { practice_id: id, report_id: activeReport.id, colleague_id: to, assigned_by: user.id, is_manual: true, assigned_at: new Date().toISOString() };
      await DB.upsertAssignment(row);
      assignments[id] = { ...assignments[id], ...row };
      UI.toast(`Pratica ${tr?.dataset.pid || ''} spostata a ${colName(to)}`, 'success');
      fullRenderSoon();
    } catch (e) { sel.value = ''; UI.toast('Errore spostamento: ' + e.message, 'danger'); }
  }

  // Selezione multipla nel piano di lavoro (top/admin): sposta o togli piu' pratiche in una volta
  const planSel = new Set();
  let planLast = null;
  const planSelIds = cid => { const v = planView[cid]; return v ? v.rows.filter(p => p.id && planSel.has(p.id)).map(p => p.id) : []; };
  function planSyncSel(card) {
    const cid = card.dataset.plan, v = planView[cid];
    if (!v) return;
    card.querySelectorAll('tbody tr[data-pid]').forEach(tr => {
      const c = tr.querySelector('.ec-plan-chk');
      if (c) tr.classList.toggle('ec-sel', c.checked);
    });
    const f = v.filtered.filter(p => p.id), n = f.filter(p => planSel.has(p.id)).length;
    const all = card.querySelector('.ec-plan-all');
    if (all) { all.checked = f.length > 0 && n === f.length; all.indeterminate = n > 0 && n < f.length; }
    const box = card.querySelector('[data-plan-bulk]');
    if (!box) return;
    const total = planSelIds(cid).length;
    if (!total) { box.innerHTML = ''; return; }
    if (box.querySelector('.ec-bulk-bar')) { box.querySelector('[data-plan-count-sel]').textContent = `${fmt(total)} selezionate`; return; }
    const opts = colleagues.filter(c => c.active && c.id !== cid).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    box.innerHTML = `
      <div class="card-body py-2 border-bottom d-flex flex-wrap align-items-center gap-2 ec-bulk-bar">
        <strong data-plan-count-sel>${fmt(total)} selezionate</strong>
        <select class="form-select form-select-sm" style="width:auto" data-plan-bulk-to><option value="">— sposta a —</option>${opts}</select>
        <button type="button" class="btn btn-sm btn-primary" onclick="App.planBulkMove(this)">Sposta</button>
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="App.planBulkRemove(this)" title="Le pratiche tornano nel pool Da assegnare">Togli dal piano</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="App.planClearSel(this)">Deseleziona</button>
      </div>`;
  }
  function planToggle(el, ev) {
    const card = el.closest('[data-plan]'), id = el.dataset.practice;
    if (!card) return;
    const list = planView[card.dataset.plan].filtered.map(p => p.id);
    if (ev && ev.shiftKey && planLast && planLast !== id) {
      const a = list.indexOf(planLast), b = list.indexOf(id);
      if (a > -1 && b > -1) for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) {
        if (!x) continue;
        el.checked ? planSel.add(x) : planSel.delete(x);
        const cb = card.querySelector(`.ec-plan-chk[data-practice="${CSS.escape(x)}"]`);
        if (cb) cb.checked = el.checked;
      }
    } else if (el.checked) planSel.add(id); else planSel.delete(id);
    planLast = id;
    planSyncSel(card);
  }
  function planToggleAll(el) {
    const card = el.closest('[data-plan]');
    if (!card) return;
    for (const p of planView[card.dataset.plan].filtered) if (p.id) el.checked ? planSel.add(p.id) : planSel.delete(p.id);
    card.querySelectorAll('.ec-plan-chk').forEach(c => { c.checked = el.checked; });
    planLast = null;
    planSyncSel(card);
  }
  function planClearSel(btn) {
    const card = btn.closest('[data-plan]');
    if (!card) return;
    for (const p of planView[card.dataset.plan].rows) planSel.delete(p.id);
    card.querySelectorAll('.ec-plan-chk').forEach(c => { c.checked = false; });
    planLast = null;
    planSyncSel(card);
  }
  async function planBulkMove(btn) {
    const card = btn.closest('[data-plan]');
    const cid = card && card.dataset.plan;
    const to = card && card.querySelector('[data-plan-bulk-to]')?.value;
    if (!to) { UI.toast('Scegli il collega a cui spostare', 'warning'); return; }
    const ids = planSelIds(cid);
    if (!ids.length) return;
    if (!UI.confirm(`Spostare ${ids.length} pratiche da ${colName(cid)} a ${colName(to)}?`)) return;
    try {
      const { data: { user } } = await db.auth.getUser();
      const now = new Date().toISOString();
      const rows = ids.map(id => ({ practice_id: id, report_id: activeReport.id, colleague_id: to, assigned_by: user.id, is_manual: true, assigned_at: now }));
      await DB.bulkUpsertAssignments(rows);
      for (const r of rows) { assignments[r.practice_id] = { ...assignments[r.practice_id], ...r }; planSel.delete(r.practice_id); }
      UI.toast(`${rows.length} pratiche spostate a ${colName(to)}`, 'success');
      fullRenderSoon();
    } catch (e) { UI.toast('Errore spostamento: ' + e.message, 'danger'); }
  }
  async function planBulkRemove(btn) {
    const card = btn.closest('[data-plan]');
    const cid = card && card.dataset.plan;
    const ids = planSelIds(cid);
    if (!ids.length) return;
    if (!UI.confirm(`Togliere ${ids.length} pratiche dal piano di ${colName(cid)}? Tornano nel pool Da assegnare.`)) return;
    try {
      const done = await DB.deleteAssignmentsByPractice(ids);
      for (const id of done) { delete assignments[id]; planSel.delete(id); }
      if (done.length < ids.length) UI.toast(`${done.length} pratiche tolte su ${ids.length}: le altre non sono rimovibili con il tuo ruolo`, 'warning');
      else UI.toast(`${done.length} pratiche tolte dal piano di ${colName(cid)}`, 'success');
      fullRenderSoon();
    } catch (e) { UI.toast('Errore: ' + e.message, 'danger'); }
  }

  async function assignFromPool(practiceId, colleagueId) {
    if (!colleagueId) return;
    const pid = practiceById[practiceId]?.pratica_id;
    const c = pid && (poolChecked[pid] ? checkedText(poolChecked[pid]) : (reportChecked(pid) ? 'Conformità/Originale archiviato già compilati nel report' : ''));
    if (c && !UI.confirm(`La pratica ${pid} è già stata controllata (${c}). Assegnarla comunque?`)) { fullRenderSoon(); return; }
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

  // ── 15. CHAT (gruppo + messaggi privati, con messaggi da leggere) ───
  const chatStoreKey = () => 'ec_chat_' + session.user.id;
  function chatLocal() { try { return JSON.parse(localStorage.getItem(chatStoreKey()) || '{}'); } catch (e) { return {}; } }
  function chatLocalSave(o) { try { localStorage.setItem(chatStoreKey(), JSON.stringify(o)); } catch (e) { /* storage non disponibile */ } }
  // I messaggi precedenti al primo uso della chat non contano come da leggere
  function chatBaseline() {
    const l = chatLocal();
    if (!l.base) { l.base = new Date().toISOString(); chatLocalSave(l); }
    return Date.parse(l.base);
  }
  const chatConvOf = m => m.recipient_id ? (m.author_id === session.user.id ? m.recipient_id : m.author_id) : 'group';
  function chatLastRead(conv) {
    const l = chatLocal();
    return Math.max(chatBaseline(), Date.parse(chatReads[conv]) || 0, Date.parse((l.reads || {})[conv]) || 0);
  }
  function chatUnread() {
    const out = {}, lr = {};
    for (const m of chatMessages) {
      if (m.author_id === session.user.id) continue;
      const c = chatConvOf(m);
      if (!(c in lr)) lr[c] = chatLastRead(c);
      if (Date.parse(m.created_at) > lr[c]) out[c] = (out[c] || 0) + 1;
    }
    return out;
  }
  // Badge rosso lampeggiante sul menu + numero nel titolo della scheda del browser
  function updateChatBadge() {
    const u = chatUnread();
    const n = Object.values(u).reduce((a, b) => a + b, 0);
    const b = $('chat-badge');
    if (b) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = n ? '' : 'none'; }
    document.title = (n ? `(${n}) ` : '') + 'Easy Control';
    return u;
  }
  // Segna come letta la conversazione (fino all'ultimo messaggio ricevuto)
  function chatMarkRead(conv) {
    let latest = 0;
    for (const m of chatMessages) if (chatConvOf(m) === conv) latest = Math.max(latest, Date.parse(m.created_at) || 0);
    if (!latest || latest <= chatLastRead(conv)) return;
    const iso = new Date(latest).toISOString();
    chatReads[conv] = iso;
    const l = chatLocal(); l.reads = l.reads || {}; l.reads[conv] = iso; chatLocalSave(l);
    DB.markChatRead(conv, iso).catch(() => {});
  }
  function chatEnter() {
    chatMarkRead(chatConv);
    renderChat({ bottom: true });
    $('chat-input')?.focus();
  }
  function chatOpen(conv) {
    const cur = $('chat-input'); if (cur) chatDrafts[chatConv] = cur.value;
    chatConv = conv;
    chatEnter();
  }

  const chatName = u => (u && (u.full_name || u.email)) || '—';
  function renderChat(opts = {}) {
    const el = $('chat-content');
    if (!el) return;
    const me = session.user.id;
    const box0 = $('chat-messages');
    const atBottom = !box0 || box0.scrollHeight - box0.scrollTop - box0.clientHeight < 60;
    const keepTop = box0 ? box0.scrollTop : 0;
    const cur0 = $('chat-input'); if (cur0) chatDrafts[chatConv] = cur0.value;

    const unread = updateChatBadge();
    const last = {};
    for (const m of chatMessages) last[chatConvOf(m)] = m;     // in ordine cronologico: l'ultimo vince
    const ts = c => (last[c] ? Date.parse(last[c].created_at) : 0);
    const people = users.filter(u => u.status === 'approved' && u.id !== me)
      .sort((a, b) => ts(b.id) - ts(a.id) || chatName(a).localeCompare(chatName(b), 'it'));
    const preview = (c, group) => {
      const m = last[c];
      if (!m) return 'Nessun messaggio';
      const who = m.author_id === me ? 'Tu' : (group ? String(chatName(m.author)).split(' ')[0] : '');
      return (who ? who + ': ' : '') + m.body;
    };
    const item = (c, title, avatar, group) => `
      <button type="button" class="ec-chat-conv${c === chatConv ? ' is-active' : ''}" onclick="App.chatOpen('${c}')">
        ${avatar}
        <span class="ec-chat-conv-main"><span class="ec-chat-conv-name">${esc(title)}</span><span class="ec-chat-conv-last">${esc(preview(c, group))}</span></span>
        <span class="ec-chat-conv-meta">${last[c] ? `<span class="ec-chat-conv-time">${UI.timeAgo(last[c].created_at)}</span>` : ''}${unread[c] ? `<span class="ec-unread">${unread[c]}</span>` : ''}</span>
      </button>`;
    const groupAvatar = '<span class="avatar avatar-sm bg-azure-lt"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>';
    const convs = item('group', 'Tutto il gruppo', groupAvatar, true)
      + people.map(u => item(u.id, chatName(u), `<span class="avatar avatar-sm bg-blue-lt">${esc(UI.initialsAvatar(chatName(u)))}</span>`, false)).join('');

    const peer = chatConv === 'group' ? null : users.find(u => u.id === chatConv);
    const title = chatConv === 'group' ? 'Tutto il gruppo' : chatName(peer);
    const msgs = chatMessages.filter(m => chatConvOf(m) === chatConv);
    const msgHtml = msgs.length ? msgs.map(m => {
      const mine = m.author_id === me;
      const showAuthor = !mine && chatConv === 'group';
      return `
      <div class="ec-chat-row ${mine ? 'ec-chat-row--mine' : ''}">
        ${showAuthor ? `<span class="avatar avatar-xs bg-blue-lt ec-chat-avatar">${esc(UI.initialsAvatar(chatName(m.author)))}</span>` : ''}
        <div class="ec-chat-bubble ${mine ? 'ec-chat-bubble--mine' : ''}">
          ${showAuthor ? `<div class="ec-chat-author">${esc(chatName(m.author))}</div>` : ''}
          <div class="ec-chat-body">${esc(m.body)}</div>
          <div class="ec-chat-time">${UI.timeAgo(m.created_at)}</div>
        </div>
      </div>`;
    }).join('') : `<div class="text-muted text-center py-4">${chatConv === 'group' ? 'Nessun messaggio ancora. Scrivi il primo!' : 'Nessun messaggio con ' + esc(title) + '. Scrivi il primo!'}</div>`;

    el.innerHTML = `
      <div class="card">
        <div class="ec-chat-layout">
          <aside class="ec-chat-side" aria-label="Conversazioni">
            <div class="ec-chat-side-head">Chat</div>
            <div class="ec-chat-convs">${convs}</div>
          </aside>
          <section class="ec-chat-main">
            <div class="ec-chat-head">${esc(title)}${chatConv === 'group' ? '' : ' <span class="text-muted fw-normal small">· messaggio privato</span>'}</div>
            <div id="chat-messages" class="ec-chat-messages">${msgHtml}</div>
            <div class="ec-chat-foot">
              <div class="input-group">
                <input type="text" id="chat-input" data-fkey="chat-input" class="form-control" autocomplete="off"
                  placeholder="${chatConv === 'group' ? 'Scrivi al gruppo…' : 'Scrivi a ' + esc(title) + '…'}"/>
                <button class="btn btn-primary" onclick="App.sendChat()">Invia</button>
              </div>
            </div>
          </section>
        </div>
      </div>`;

    const input = $('chat-input');
    if (input) {
      input.value = chatDrafts[chatConv] || '';
      input.addEventListener('input', () => { chatDrafts[chatConv] = input.value; });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
      });
    }
    const box = $('chat-messages');
    if (box) box.scrollTop = (opts.bottom || atBottom) ? box.scrollHeight : keepTop;
  }

  function scrollChatToBottom() {
    const box = $('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  async function sendChat() {
    const input = $('chat-input');
    const body = input?.value.trim();
    if (!body) return;
    input.value = ''; chatDrafts[chatConv] = '';
    const conv = chatConv;
    try {
      await DB.sendChatMessage(body, conv === 'group' ? null : conv);
      chatMessages = await DB.getChatMessages();
      chatMarkRead(conv);
      renderChat({ bottom: true });
      $('chat-input')?.focus();
    } catch (e) {
      const ci = $('chat-input'); if (ci) { ci.value = body; chatDrafts[conv] = body; }
      UI.toast(/recipient_id|chat_reads/.test(e.message || '')
        ? 'Messaggi privati non ancora attivi: esegui nel SQL Editor di Supabase la migration 20261119000000_chat_private.sql'
        : 'Errore invio messaggio: ' + e.message, 'danger');
    }
  }

  // Tornando sulla scheda del browser con la chat aperta, i messaggi arrivati si leggono subito
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentTarget === 'chat' && dataLoadedGlobal()) { chatMarkRead(chatConv); updateChatBadge(); renderChat(); }
  });
  const dataLoadedGlobal = () => !!(session && session.user);

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
    getPractices: () => practices,
    setStatus, saveNote, planSearch, planChip, planClearCols, openModelli, planMore, setSeriesDays, setSeriesMode,
    setCalled, setCallOutcome, setPoolNote, closePoolRow, openIntegra, refillPlan,
    openScheda, backToDashboard, setPeriod, goPool, goMine,
    assignFromPool, poolToggle, poolToggleAll, poolClearSel, poolBulkAssign, moveFill, moveFromPlan, callToggle, callToggleAll, callClearSel, callBulkMove, planToggle, planToggleAll, planClearSel, planBulkMove, planBulkRemove, filterPool, showAllPool, poolSet, poolReset,
    sendChat, chatOpen, openNotification,
    impersonate: id => Auth.impersonate(id),
  };

  // Start (la prima navigazione avviene qui: tutte le funzioni di render sono definite)
  navigateFromHash();
  await Promise.all([loadActiveReport(), loadGlobalData()]);
  subscribeGlobalRealtime();
  scheduleCutoff();

})();
