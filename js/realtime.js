// ================================================================
// Realtime — Supabase subscriptions
// ================================================================
const Realtime = (() => {
  let _channels = [];
  let _globalChannels = [];
  let _reportId = null, _cb = {};
  let _globalUser = null, _gcb = {};

  // Stato dei canali: messaggi in console solo per diagnosi (la riconnessione e' automatica)
  const status = name => (st, err) => {
    if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') console.warn('[realtime]', name, st, err ? err.message || err : '');
  };

  function subscribe(reportId, callbacks = {}) {
    // Stesso report gia' sottoscritto: si aggiornano solo le funzioni, senza chiudere e riaprire
    // la connessione (chiuderla mentre si sta aprendo la fa fallire).
    if (_reportId === reportId && _channels.length) { _cb = callbacks; return; }
    unsubscribe(); // pulizia precedente
    _reportId = reportId; _cb = callbacks;

    // Assignments (aggiornamenti in tempo reale)
    const assignCh = db.channel('assignments-' + reportId)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'assignments',
        filter: `report_id=eq.${reportId}`,
      }, payload => {
        if (_cb.onAssignment) _cb.onAssignment(payload);
      })
      .subscribe(status('report'));

    // Report attivi (se un admin carica un nuovo report)
    const reportCh = db.channel('daily-reports')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'daily_reports',
      }, payload => {
        if (payload.new.active && _cb.onNewReport) {
          _cb.onNewReport(payload.new);
        }
      })
      .subscribe(status('report-attivo'));

    // Config/colleagues/state_filters per sync admin
    const configCh = db.channel('config-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'colleagues' },
        payload => _cb.onColleaguesChange && _cb.onColleaguesChange(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'state_filters' },
        payload => _cb.onFiltersChange && _cb.onFiltersChange(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_config' },
        payload => _cb.onConfigChange && _cb.onConfigChange(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_exclusions' },
        payload => _cb.onAgentExclusionsChange && _cb.onAgentExclusionsChange(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'colleague_state_filters' },
        payload => _cb.onColleagueFiltersChange && _cb.onColleagueFiltersChange(payload))
      .subscribe(status('config'));

    _channels = [assignCh, reportCh, configCh];
  }

  function unsubscribe() {
    for (const ch of _channels) {
      db.removeChannel(ch);
    }
    _channels = [];
    _reportId = null;
  }

  // Canale "di sessione": chat, piano di lavoro (stato/nota pratica), conteggi, notifiche.
  // Indipendente dal report attivo — attivo per tutta la durata del login.
  function subscribeGlobal(userId, callbacks = {}) {
    if (_globalUser === userId && _globalChannels.length) { _gcb = callbacks; return; }
    unsubscribeGlobal();
    _globalUser = userId; _gcb = callbacks;

    const sessionCh = db.channel('session-' + userId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        payload => _gcb.onChatMessage && _gcb.onChatMessage(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'practice_work' },
        payload => _gcb.onWorkChange && _gcb.onWorkChange(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'practice_checks' },
        payload => _gcb.onChecksChange && _gcb.onChecksChange(payload))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' },
        payload => {
          if (payload.new.user_id === userId && _gcb.onNotification) _gcb.onNotification(payload);
        })
      .subscribe(status('sessione'));

    _globalChannels = [sessionCh];
  }

  function unsubscribeGlobal() {
    for (const ch of _globalChannels) {
      db.removeChannel(ch);
    }
    _globalChannels = [];
    _globalUser = null;
  }

  return { subscribe, unsubscribe, subscribeGlobal, unsubscribeGlobal };
})();
