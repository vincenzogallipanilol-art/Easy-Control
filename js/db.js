// ================================================================
// DB helpers — wraps Supabase queries
// ================================================================
const DB = (() => {

  // ── LETTURA A PAGINE ────────────────────────────────────────────
  // Paginazione "keyset" (WHERE chiave > ultima): ogni pagina costa quanto se stessa.
  // L'OFFSET invece rilegge e rivaluta le regole RLS di tutte le righe saltate:
  // con migliaia di righe il tempo cresce col quadrato del numero di pagine.
  const PAGE = 1000;

  async function pageBy(build, key, { gt = null, gte = null, lt = null } = {}) {
    let q = build().order(key).limit(PAGE);
    if (gt != null)  q = q.gt(key, gt);
    if (gte != null) q = q.gte(key, gte);
    if (lt != null)  q = q.lt(key, lt);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  // Sequenziale su una chiave ordinabile (unica)
  async function fetchKeyset(build, key, bounds = {}) {
    const out = [];
    let cur = { ...bounds };
    while (true) {
      const data = await pageBy(build, key, cur);
      for (const r of data) out.push(r);
      if (data.length < PAGE) return out;
      cur = { gt: data[data.length - 1][key], lt: bounds.lt ?? null };
    }
  }

  // Chiave UUID (distribuita in modo uniforme): dopo la prima pagina il resto
  // viene letto in parallelo, un intervallo di prefissi per volta.
  const UUID_BUCKETS = 8;
  const uuidBound = i => i >= UUID_BUCKETS ? null : (i * (16 / UUID_BUCKETS)).toString(16) + '0000000-0000-0000-0000-000000000000';

  async function fetchAll(build, key = 'id') {
    const first = await pageBy(build, key);
    if (first.length < PAGE) return first;
    const last = first[first.length - 1][key];
    const jobs = [];
    for (let i = 0; i < UUID_BUCKETS; i++) {
      const lo = uuidBound(i), hi = uuidBound(i + 1);
      if (hi && hi <= last) continue;                       // gia' tutto nella prima pagina
      jobs.push(fetchKeyset(build, key, lo <= last ? { gt: last, lt: hi } : { gte: lo, lt: hi }));
    }
    const out = first.slice();
    for (const part of await Promise.all(jobs)) for (const r of part) out.push(r);
    return out;
  }

  // Tabella/colonna/funzione non ancora creata (migration SQL non eseguita)?
  function isMissingSchema(error) {
    const code = (error && error.code) || '';
    const msg  = ((error && error.message) || '').toLowerCase();
    return ['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(code)
      || msg.includes('does not exist') || msg.includes('could not find');
  }

  // ── CONFIG ──────────────────────────────────────────── */
  async function getConfig() {
    const { data, error } = await db.from('app_config').select('key,value');
    if (error) throw error;
    return Object.fromEntries(data.map(r => [r.key, r.value]));
  }
  async function setConfig(key, value) {
    const { data: { user } } = await db.auth.getUser();
    const { error } = await db.from('app_config')
      .upsert({ key, value, updated_at: new Date().toISOString(), updated_by: user.id });
    if (error) throw error;
  }

  // ── STATE FILTERS ──────────────────────────────────── */
  async function getStateFilters() {
    const { data, error } = await db.from('state_filters').select('*').order('stato');
    if (error) throw error;
    return data;
  }
  async function upsertStateFilter(filter) {
    const { error } = await db.from('state_filters')
      .upsert({ ...filter, updated_at: new Date().toISOString() });
    if (error) throw error;
  }

  // ── COLLEAGUES ────────────────────────────────────── */
  async function getColleagues() {
    const { data, error } = await db.from('colleagues')
      .select('*').order('sort_order');
    if (error) throw error;
    return data;
  }
  async function upsertColleague(col) {
    let { error } = await db.from('colleagues').upsert(col);
    if (error && isMissingSchema(error) && 'excluded_agents' in col) {
      // colonna excluded_agents non ancora creata: salva il resto
      const { excluded_agents, ...rest } = col;
      ({ error } = await db.from('colleagues').upsert(rest));
      if (!error) return { partial: true };
    }
    if (error) throw error;
    return { partial: false };
  }
  async function deleteColleague(id) {
    const { error } = await db.from('colleagues').delete().eq('id', id);
    if (error) throw error;
  }

  // ── REPORTS ──────────────────────────────────────── */
  async function getReports() {
    const { data, error } = await db.from('daily_reports')
      .select('*').order('uploaded_at', { ascending: false });
    if (error) throw error;
    return data;
  }
  async function getActiveReport() {
    const { data, error } = await db.from('daily_reports')
      .select('*').eq('active', true).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function createReport(filename, rowCount) {
    const { data: { user } } = await db.auth.getUser();
    // Disattiva tutti i report precedenti
    await db.from('daily_reports').update({ active: false }).eq('active', true);
    const { data, error } = await db.from('daily_reports').insert({
      filename,
      row_count: rowCount,
      active: true,
      uploaded_by: user.id,
    }).select().single();
    if (error) throw error;
    return data;
  }

  // ── PRACTICES ────────────────────────────────────── */
  async function insertPractices(practices) {
    // Batch insert in chunks of 1000
    const CHUNK = 1000;
    for (let i = 0; i < practices.length; i += CHUNK) {
      const { error } = await db.from('practices').insert(practices.slice(i, i + CHUNK));
      if (error) throw error;
    }
  }
  async function getPractices(reportId) {
    return fetchAll(() => db.from('practices').select('*').eq('report_id', reportId));
  }

  // ── ASSIGNMENTS ───────────────────────────────────── */
  async function getAssignments(reportId) {
    return fetchAll(() => db.from('assignments').select('*').eq('report_id', reportId));
  }
  async function upsertAssignment(assignment) {
    const { error } = await db.from('assignments')
      .upsert(assignment, { onConflict: 'practice_id' });
    if (error) throw error;
  }
  async function bulkUpsertAssignments(assignments) {
    const CHUNK = 500;
    for (let i = 0; i < assignments.length; i += CHUNK) {
      const { error } = await db.from('assignments')
        .upsert(assignments.slice(i, i + CHUNK), { onConflict: 'practice_id' });
      if (error) throw error;
    }
  }
  async function deleteAutoAssignments(reportId) {
    const { error } = await db.from('assignments')
      .delete().eq('report_id', reportId).eq('is_manual', false);
    if (error) throw error;
  }

  // ── AGENT EXCLUSIONS ──────────────────────────────── */
  async function getAgentExclusions() {
    const { data, error } = await db.from('agent_exclusions').select('*').order('agent_name');
    if (error) throw error;
    return data;
  }
  async function addAgentExclusion(agentName) {
    const { data, error } = await db.from('agent_exclusions')
      .insert({ agent_name: agentName }).select().single();
    if (error) throw error;
    return data;
  }
  async function deleteAgentExclusion(id) {
    const { error } = await db.from('agent_exclusions').delete().eq('id', id);
    if (error) throw error;
  }

  // ── VALORI DISTINTI dal report attivo (per il modal collega) ──────
  // Valori distinti per tipologia/agente: un solo scarico per report, poi in cache
  let _distinctCache = null; // { reportId, promise }
  async function getDistinct(column) {
    const report = await getActiveReport();
    if (!report) return [];
    if (!_distinctCache || _distinctCache.reportId !== report.id) {
      const promise = fetchAll(() => db.from('practices').select('id,tipologia,agente_attuale').eq('report_id', report.id))
        .catch(e => { _distinctCache = null; throw e; });
      _distinctCache = { reportId: report.id, promise };
    }
    const rows = await _distinctCache.promise;
    const set = new Set();
    for (const r of rows) {
      const t = (r[column] || '').trim();
      if (t) set.add(t);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'it'));
  }
  const getDistinctTipologie = () => getDistinct('tipologia');
  const getDistinctAgenti    = () => getDistinct('agente_attuale');

  // ── FILTRI STATO PER COLLEGA ─────────────────────────── */
  async function getAllColleagueStateFilters() {
    const { data, error } = await db.from('colleague_state_filters').select('*');
    if (error) throw error;
    return data;
  }
  async function getColleagueStateFilters(colleagueId) {
    const { data, error } = await db.from('colleague_state_filters').select('*').eq('colleague_id', colleagueId);
    if (error) throw error;
    return data;
  }
  async function saveColleagueStateFilters(colleagueId, rows) {
    // rows: [{ stato, included, note_mode, conf_mode }]
    const payload = rows.map(r => ({ colleague_id: colleagueId, ...r, updated_at: new Date().toISOString() }));
    const { error } = await db.from('colleague_state_filters')
      .upsert(payload, { onConflict: 'colleague_id,stato' });
    if (error) throw error;
  }

  // ── USERS (admin) ────────────────────────────────── */
  async function getUsers() {
    const { data, error } = await db.from('profiles').select('*').order('email');
    if (error) throw error;
    return data;
  }
  async function setUserRole(userId, role) {
    const { error } = await db.from('profiles').update({ role }).eq('id', userId);
    if (error) throw error;
  }
  async function setUserColleague(userId, colleagueId) {
    const { error } = await db.from('profiles').update({ colleague_id: colleagueId || null }).eq('id', userId);
    if (error) throw error;
  }
  async function approveUser(userId, colleagueId) {
    const { error } = await db.from('profiles')
      .update({ status: 'approved', colleague_id: colleagueId || null })
      .eq('id', userId);
    if (error) throw error;
  }
  async function rejectUser(userId) {
    // Riporta l'utente a 'pending' (nessuna cancellazione dell'account)
    const { error } = await db.from('profiles').update({ status: 'pending' }).eq('id', userId);
    if (error) throw error;
  }

  // ── PIANO DI LAVORO: stato/nota per pratica (chiave = pratica_id) ──
  // Carica solo le righe che servono: stati di oggi, pratiche nei pool,
  // note senza stato e chiusure del report attivo.
  async function getOpenWork(reportId, sinceIso) {
    const parts = [
      'status.is.null',
      'status.in.(audit,help,xflat)',
      `and(status.eq.da_chiamare,or(called.is.false,called_at.gte.${sinceIso}))`,
      `set_at.gte.${sinceIso}`,
    ];
    if (reportId) parts.push(`report_id.eq.${reportId}`);
    return fetchKeyset(() => db.from('practice_work').select('*')
      .is('closed_at', null).or(parts.join(',')), 'pratica_id');
  }

  // Imposta stato + nota. Ritorna la riga aggiornata, o null se rimossa.
  async function setPracticeWork({ praticaId, status, note, reportId, colleagueId, practice }) {
    const p = practice || {};
    const { data, error } = await db.rpc('set_practice_work', {
      p_pratica_id:   praticaId,
      p_status:       status || '',
      p_note:         note || '',
      p_report_id:    reportId || null,
      p_colleague_id: colleagueId || null,
      p_cognome:      p.cognome || '',
      p_nome:         p.nome || '',
      p_tipologia:    p.tipologia || '',
      p_istituto:     p.istituto_finanziario || '',
      p_agente:       p.agente_attuale || '',
    });
    if (error) throw error;
    return (data && data[0]) || null;
  }

  // Aggiornamenti nei pool (Chiamato, note chiamata/gestione, chiusura)
  async function updateWork(praticaId, patch) {
    const { data, error } = await db.from('practice_work')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('pratica_id', praticaId).select();
    if (error) throw error;
    return (data && data[0]) || null;
  }
  async function closeWork(praticaId) {
    const { data: { user } } = await db.auth.getUser();
    return updateWork(praticaId, { closed_at: new Date().toISOString(), closed_by: user.id });
  }

  // Conteggi delle pratiche controllate: per collega/stato, oggi/settimana/mese/totale
  async function getCheckStats() {
    const { data, error } = await db.rpc('check_stats');
    if (error) throw error;
    return data || [];
  }

  // Notifica gli utenti taggati (@nome) in una nota
  async function notifyMentions(userIds, { title, body, praticaId }) {
    if (!userIds || !userIds.length) return;
    const rows = userIds.map(uid => ({
      user_id: uid, type: 'mention', title, body: (body || '').slice(0, 200), pratica_id: praticaId,
    }));
    const { error } = await db.from('notifications').insert(rows);
    if (error) throw error;
  }

  // ── NOTIFICATIONS ─────────────────────────────────────── */
  async function getNotifications() {
    const { data, error } = await db.from('notifications')
      .select('*').order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    return data;
  }
  async function markNotificationRead(id) {
    const { error } = await db.from('notifications').update({ read: true }).eq('id', id);
    if (error) throw error;
  }
  async function markAllNotificationsRead(ids) {
    if (!ids || !ids.length) return;
    const { error } = await db.from('notifications').update({ read: true }).in('id', ids);
    if (error) throw error;
  }

  // ── CHAT (stanza unica) ───────────────────────────────── */
  async function getChatMessages() {
    const { data, error } = await db.from('chat_messages')
      .select('*, author:profiles(full_name,email)')
      .order('created_at', { ascending: true }).limit(300);
    if (error) throw error;
    return data;
  }
  async function sendChatMessage(body) {
    const { data: { user } } = await db.auth.getUser();
    const { error } = await db.from('chat_messages').insert({ author_id: user.id, body });
    if (error) throw error;
  }

  return {
    getConfig, setConfig,
    getStateFilters, upsertStateFilter,
    getColleagues, upsertColleague, deleteColleague,
    getReports, getActiveReport, createReport,
    insertPractices, getPractices,
    getAssignments, upsertAssignment, bulkUpsertAssignments, deleteAutoAssignments,
    getDistinctTipologie, getDistinctAgenti,
    getAllColleagueStateFilters, getColleagueStateFilters, saveColleagueStateFilters,
    getUsers, setUserRole, setUserColleague, approveUser, rejectUser,
    getAgentExclusions, addAgentExclusion, deleteAgentExclusion,
    getOpenWork, setPracticeWork, updateWork, closeWork, getCheckStats, notifyMentions,
    isMissingSchema,
    getNotifications, markNotificationRead, markAllNotificationsRead,
    getChatMessages, sendChatMessage,
  };
})();
