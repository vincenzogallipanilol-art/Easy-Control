// ================================================================
// Distribution Engine — adattato da pratiche-distributor v8
// ================================================================
const Engine = (() => {

  // Normalizza stringa per confronto
  const norm = s => (s || '').toLowerCase().trim();

  // Controlla se la pratica passa i filtri stato
  function passesFilter(p, filter) {
    if (!filter.included) return false;

    const noteVal  = norm(p.note);
    const confVal  = norm(p.conformita_documentazione);

    // note_mode: 'any' | 'empty' | 'filled'
    if (filter.note_mode === 'empty'  && noteVal !== '') return false;
    if (filter.note_mode === 'filled' && noteVal === '') return false;

    // conf_mode: 'any' | 'empty' | 'filled'
    if (filter.conf_mode === 'empty'  && confVal !== '') return false;
    if (filter.conf_mode === 'filled' && confVal === '') return false;

    return true;
  }

  // Trova il collega migliore per una pratica (per tipologia)
  function findColleague(tipologia, colleagues, quotas, rrIdx) {
    const tip = norm(tipologia);

    // Prima passa: primary tipologie
    const primaries = colleagues.filter(c =>
      c.active &&
      c.primary_tipologie.map(norm).includes(tip) &&
      (quotas[c.id] || 0) < c.max_quota
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
      (quotas[c.id] || 0) < c.max_quota
    );
    if (secondaries.length > 0) {
      const idx = (rrIdx.get(tip + '_secondary') || 0) % secondaries.length;
      rrIdx.set(tip + '_secondary', idx + 1);
      return { colleague: secondaries[idx], pass: 'secondary' };
    }

    return null;
  }

  function distribute(practices, colleagues, stateFilters, workingDays, existingManual = [], excludedAgents = []) {
    const filterMap = {};
    for (const f of stateFilters) filterMap[norm(f.stato)] = f;

    const manualPracticeIds = new Set(existingManual.map(a => a.practice_id));
    // Match SOLO su agente_attuale — group_manager/team_manager/area_manager ignorati
    const excludedSet = new Set((excludedAgents || []).map(a => norm(a.agent_name)));

    // Pool agenti esclusi: tutte le pratiche non-manuali il cui agente_attuale è in lista
    const excludedPractices = excludedSet.size > 0
      ? practices.filter(p => !manualPracticeIds.has(p.id) && excludedSet.has(norm(p.agente_attuale)))
      : [];
    const excludedIds = new Set(excludedPractices.map(p => p.id));

    // Pratiche eleggibili: esclude manuali + agenti esclusi, poi applica filtri stato
    const eligible = practices.filter(p => {
      if (manualPracticeIds.has(p.id)) return false;
      if (excludedIds.has(p.id)) return false;
      const filter = filterMap[norm(p.stato_attuale)];
      return filter ? passesFilter(p, filter) : false;
    });

    const activeColleagues = colleagues.filter(c => c.active);
    const quotas = {};
    for (const c of activeColleagues) quotas[c.id] = 0;

    const rrIdx = new Map();
    const autoAssignments = [];
    const poolPractices   = [];

    for (const p of eligible) {
      const result = findColleague(p.tipologia, activeColleagues, quotas, rrIdx);
      if (result) {
        quotas[result.colleague.id]++;
        autoAssignments.push({
          practice_id:  p.id,
          report_id:    p.report_id,
          colleague_id: result.colleague.id,
          is_manual:    false,
        });
      } else {
        poolPractices.push({ ...p, _reason: _poolReason(p, activeColleagues, quotas, filterMap) });
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
      excluded:    excludedPractices.length,
      manual:      existingManual.length,
      workingDays,
    };

    return { autoAssignments, poolPractices, excludedPractices, stats, kpi };
  }

  function _poolReason(p, colleagues, quotas, filterMap) {
    const tip = norm(p.tipologia);
    const hasTip = colleagues.some(c =>
      c.primary_tipologie.map(norm).includes(tip) ||
      c.secondary_tipologie.map(norm).includes(tip)
    );
    if (!hasTip) return 'tipologia_no_match';
    const allFull = colleagues
      .filter(c => c.primary_tipologie.map(norm).includes(tip) || c.secondary_tipologie.map(norm).includes(tip))
      .every(c => (quotas[c.id] || 0) >= c.max_quota);
    if (allFull) return 'quota_full';
    return 'other';
  }

  return { distribute };
})();
