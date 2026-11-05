// ================================================================
// Realtime — Supabase subscriptions
// ================================================================
const Realtime = (() => {
  let _channels = [];
  let _globalChannels = [];

  function subscribe(reportId, callbacks = {}) {
    unsubscribe(); // pulizia precedente

    // Assignments (aggiornamenti in tempo reale)
    const assignCh = db.channel('assignments-' + reportId)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'assignments',
        filter: `report_id=eq.${reportId}`,
      }, payload => {
        if (callbacks.onAssignment) callbacks.onAssignment(payload);
      })
      .subscribe();

    // Report attivi (se un admin carica un nuovo report)
    const reportCh = db.channel('daily-reports')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'daily_reports',
      }, payload => {
        if (payload.new.active && callbacks.onNewReport) {
          callbacks.onNewReport(payload.new);
        }
      })
      .subscribe();

    // Config/colleagues/state_filters per sync admin
    const configCh = db.channel('config-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'colleagues' },
        payload => callbacks.onColleaguesChange && callbacks.onColleaguesChange(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'state_filters' },
        payload => callbacks.onFiltersChange && callbacks.onFiltersChange(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_config' },
        payload => callbacks.onConfigChange && callbacks.onConfigChange(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_exclusions' },
        payload => callbacks.onAgentExclusionsChange && callbacks.onAgentExclusionsChange(payload))
      .subscribe();

    _channels = [assignCh, reportCh, configCh];
  }

  function unsubscribe() {
    for (const ch of _channels) {
      db.removeChannel(ch);
    }
    _channels = [];
  }

  // Canale "di sessione": chat, note, stato pratica, notifiche.
  // Indipendente dal report attivo — attivo per tutta la durata del login.
  function subscribeGlobal(userId, callbacks = {}) {
    unsubscribeGlobal();

    const sessionCh = db.channel('session-' + userId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        payload => callbacks.onChatMessage && callbacks.onChatMessage(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'practice_status' },
        payload => callbacks.onPracticeStatusChange && callbacks.onPracticeStatusChange(payload))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'practice_notes' },
        payload => callbacks.onPracticeNote && callbacks.onPracticeNote(payload))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' },
        payload => {
          if (payload.new.user_id === userId && callbacks.onNotification) callbacks.onNotification(payload);
        })
      .subscribe();

    _globalChannels = [sessionCh];
  }

  function unsubscribeGlobal() {
    for (const ch of _globalChannels) {
      db.removeChannel(ch);
    }
    _globalChannels = [];
  }

  return { subscribe, unsubscribe, subscribeGlobal, unsubscribeGlobal };
})();
