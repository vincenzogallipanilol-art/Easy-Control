// ================================================================
// Realtime — Supabase subscriptions
// ================================================================
const Realtime = (() => {
  let _channels = [];

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

  return { subscribe, unsubscribe };
})();
