// ================================================================
// Distribution Engine — adattato da pratiche-distributor v8
// Filtri stato ora per-collega (colleagueStateFilters), + aggancio
// pool "Agenti Sally" a un collega (sallyHookColleagueId).
// ================================================================
const Engine = (() => {

  // Normalizza stringa per confronto
  const norm = s => (s || '').toLowerCase().trim();

  // Costruisce { colleagueId: { stato_norm: {included, note_mode, conf_mode} } }
  function buildFilterByColleague(colleagueStateFilters) {
    const m = {};
    for (const r of (colleagueStateFilters || [])) {
      m[r.colleague_id] = m[r.colleague_id] || {};
      m[r.colleague_id][norm(r.stato)] = r;
    }
    return m;
  }

  // Controlla se la pratica passa il filtro stato di UN collega
  function passesFilter(p, filter) {
    if (!filter || !filter.included) return false;

    const noteVal = norm(p.note);
    const confVal = norm(p.conformita_documentazione);

    if (filter.note_mode === 'empty'  && noteVal !== '') return false;
    if (filter.note_mode === 'filled' && noteVal === '') return false;

    if (filter.conf_mode === 'empty'  && confVal !== '') return false;
    if (filter.conf_mode === 'filled' && confVal === '') return false;

    return true;
  }

  // Trova il collega migliore per una pratica (tipologia + filtro stato proprio del collega)
  function findColleague(p, colleagues, quotas, rrIdx, filterByColleague) {
    const tip   = norm(p.tipologia);
    const stato = norm(p.stato_attuale);

    const eligibleFor = c => passesFilter(p, (filterByColleague[c.id] || {})[stato]);

    // Prima passa: primary tipologie
    const primaries = colleagues.filter(c =>
      c.active &&
      c.primary_tipologie.map(norm).includes(tip) &&
      (quotas[c.id] || 0) < c.max_quota &&
      eligibleFor(c)
    );
    if (primaries.length > 0) {
      const idx = (rrIdx.get(tip + '_primary') || 0) % primaries.length;
      rrIdx.set(tip + '_primary', idx + 1);
      return { colleague: primaries[idx], pass: 'primary' };
    }

    // Seconda passa: secondary tipologie
    const secondaries = colleagues.filter(c =>
      c.active &&
      c.secondary_tipologie.map(norm).includes(tip) &&
      (quotas[c.id] || 0) < c.max_quota &&
      eligibleFor(c)
    );
    if (secondaries.length > 0) {
      const idx = (rrIdx.get(tip + '_secondary') || 0) % secondaries.length;
      rrIdx.set(tip + '_secondary', idx + 1);
      return { colleague: secondaries[idx], pass: 'secondary' };
    }

    return null;
  }

  function distribute(practices, colleagues, colleagueStateFilters, workingDays, existingManual = [], excludedAgents = [], sallyHookColleagueId = null) {
    const filterByColleague = buildFilterByColleague(colleagueStateFilters);

    const manualPracticeIds = new Set(existingManual.map(a => a.practice_id));
    // Match SOLO su agente_attuale — group_manager/team_manager/area_manager ignorati
    const excludedSet = new Set((excludedAgents || []).map(a => norm(a.agent_name)));

    // Pool "Agenti Sally": tutte le pratiche non-manuali il cui agente_attuale è in lista
    const excludedPractices = excludedSet.size > 0
      ? practices.filter(p => !manualPracticeIds.has(p.id) && excludedSet.has(norm(p.agente_attuale)))
      : [];
    const excludedIds = new Set(excludedPractices.map(p => p.id));

    const activeColleagues = colleagues.filter(c => c.active);
    const quotas = {};
    for (const c of activeColleagues) quotas[c.id] = 0;

    const rrIdx = new Map();
    const autoAssignments = [];
    const poolPractices   = [];

    // Se la pool Agenti Sally è agganciata a un collega attivo, tutte le sue
    // pratiche vanno assegnate automaticamente a quel collega (bypassa tipologia/filtri)
    const sallyHookValid = sallyHookColleagueId && activeColleagues.some(c => c.id === sallyHookColleagueId);
    if (sallyHookValid) {
      for (const p of excludedPractices) {
        quotas[sallyHookColleagueId] = (quotas[sallyHookColleagueId] || 0) + 1;
        autoAssignments.push({
          practice_id:  p.id,
          report_id:    p.report_id,
          colleague_id: sallyHookColleagueId,
          is_manual:    false,
        });
      }
    }

    // Pratiche eleggibili alla distribuzione normale: esclude manuali + Agenti Sally
    const eligible = practices.filter(p => !manualPracticeIds.has(p.id) && !excludedIds.has(p.id));

    for (const p of eligible) {
      const result = findColleague(p, activeColleagues, quotas, rrIdx, filterByColleague);
      if (result) {
        quotas[result.colleague.id]++;
        autoAssignments.push({
          practice_id:  p.id,
          report_id:    p.report_id,
          colleague_id: result.colleague.id,
          is_manual:    false,
        });
      } else {
        poolPractices.push({ ...p, _reason: _poolReason(p, activeColleagues, quotas, filterByColleague) });
      }
    }

    // Stats per collega
    const stats = {};
    for (const c of activeColleagues) {
      stats[c.id] = { total: quotas[c.id] || 0, perDay: workingDays > 0 ? Math.round((quotas[c.id] || 0) / workingDays) : 0 };
    }

    // KPI globali
    const kpi = {
      total:       practices.length,
      eligible:    eligible.length,
      assigned:    autoAssignments.length,
      pool:        poolPractices.length,
      excluded:    sallyHookValid ? 0 : excludedPractices.length,
      sallyHooked: sallyHookValid ? excludedPractices.length : 0,
      manual:      existingManual.length,
      workingDays,
    };

    return { autoAssignments, poolPractices, excludedPractices: sallyHookValid ? [] : excludedPractices, stats, kpi };
  }

  function _poolReason(p, colleagues, quotas, filterByColleague) {
    const tip   = norm(p.tipologia);
    const stato = norm(p.stato_attuale);
    const matching = colleagues.filter(c =>
      c.primary_tipologie.map(norm).includes(tip) ||
      c.secondary_tipologie.map(norm).includes(tip)
    );
    if (!matching.length) return 'tipologia_no_match';

    const passingFilter = matching.filter(c => passesFilter(p, (filterByColleague[c.id] || {})[stato]));
    if (!passingFilter.length) return 'filtro_stato';

    const allFull = passingFilter.every(c => (quotas[c.id] || 0) >= c.max_quota);
    if (allFull) return 'quota_full';
    return 'other';
  }

  return { distribute };
})();
