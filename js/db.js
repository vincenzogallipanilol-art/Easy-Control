// ================================================================
// DB helpers — wraps Supabase queries
// ================================================================
const DB = (() => {

  // ── CONFIG ──────────────────────────────────────────────────────
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

  // ── STATE FILTERS ───────────────────────────────────────────────
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

  // ── COLLEAGUES ──────────────────────────────────────────────────
  async function getColleagues() {
    const { data, error } = await db.from('colleagues')
      .select('*').order('sort_order');
    if (error) throw error;
    return data;
  }
  async function upsertColleague(col) {
    const { error } = await db.from('colleagues').upsert(col);
    if (error) throw error;
  }
  async function deleteColleague(id) {
    const { error } = await db.from('colleagues').delete().eq('id', id);
    if (error) throw error;
  }

  // ── REPORTS ─────────────────────────────────────────────────────
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

  // ── PRACTICES ───────────────────────────────────────────────────
  async function insertPractices(practices) {
    // Batch insert in chunks of 1000
    const CHUNK = 1000;
    for (let i = 0; i < practices.length; i += CHUNK) {
      const { error } = await db.from('practices').insert(practices.slice(i, i + CHUNK));
      if (error) throw error;
    }
  }
  async function getPractices(reportId) {
    const PAGE = 5000;
    let all = [], from = 0;
    while (true) {
      const { data, error } = await db.from('practices')
        .select('*').eq('report_id', reportId)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all = all.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  // ── ASSIGNMENTS ─────────────────────────────────────────────────
  async function getAssignments(reportId) {
    const { data, error } = await db.from('assignments')
      .select('*').eq('report_id', reportId);
    if (error) throw error;
    return data;
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

  // ── AGENT EXCLUSIONS ────────────────────────────────────────────
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

  // ── USERS (admin) ───────────────────────────────────────────────
  async function getUsers() {
    const { data, error } = await db.from('profiles').select('*').order('email');
    if (error) throw error;
    return data;
  }
  async function setUserRole(userId, role) {
    const { error } = await db.from('profiles').update({ role }).eq('id', userId);
    if (error) throw error;
  }

  return {
    getConfig, setConfig,
    getStateFilters, upsertStateFilter,
    getColleagues, upsertColleague, deleteColleague,
    getReports, getActiveReport, createReport,
    insertPractices, getPractices,
    getAssignments, upsertAssignment, bulkUpsertAssignments, deleteAutoAssignments,
    getUsers, setUserRole,
    getAgentExclusions, addAgentExclusion, deleteAgentExclusion,
  };
})();
