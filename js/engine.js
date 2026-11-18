// ================================================================
// Distribution Engine — adattato da pratiche-distributor v8
// Filtri stato per-collega (colleagueStateFilters), agenti Sally dedicati
// a un collega (opts.dedicated), agenti esclusi
// per singolo collega (colleagues.excluded_agents), pratiche bloccate
// perche' gia' in lavorazione o in un pool (opts.lockedPids).
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

  // L'agente della pratica e' escluso per questo collega?
  function agentExcludedFor(p, c) {
    const agent = norm(p.agente_attuale);
    return !!agent && (c.excluded_agents || []).some(a => norm(a) === agent);
  }

  // Trova il collega migliore per una pratica (tipologia + filtro stato proprio del collega)
  function findColleague(p, colleagues, quotas, rrIdx, filterByColleague) {
    const tip   = norm(p.tipologia);
    const stato = norm(p.stato_attuale);

    const eligibleFor = c => !agentExcludedFor(p, c) && passesFilter(p, (filterByColleague[c.id] || {})[stato]);

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

  // opts.lockedPids  : Set di pratica_id da non (ri)distribuire
  // opts.baseQuotas  : { colleagueId: n } carico gia' presente da contare nella quota
  // Agenti Sally per collega: { colleagueId: { agents: [nomi], only: bool } }
  // Sta in app_config.colleague_agents; senza quella chiave si ricava dalla vecchia
  // configurazione globale (elenco agenti + collega agganciata + opzione "solo questi agenti").
  function dedicatedFromConfig(config, agentExclusions) {
    const cfg = config && config.colleague_agents;
    if (cfg && typeof cfg === 'object') {
      const out = {};
      for (const [id, v] of Object.entries(cfg)) {
        const agents = Array.isArray(v && v.agents) ? v.agents.filter(Boolean) : [];
        if (agents.length) out[id] = { agents, only: !!v.only };
      }
      return out;
    }
    const hook = config && config.sally_hook_colleague_id;
    const names = (agentExclusions || []).map(a => a.agent_name).filter(Boolean);
    return hook && names.length ? { [hook]: { agents: names, only: !!(config && config.sally_hook_exclusive) } } : {};
  }

  // opts.dedicated : mappa di dedicatedFromConfig
  function distribute(practices, colleagues, colleagueStateFilters, workingDays, existingManual = [], _unusedAgents = [], _unusedHook = null, opts = {}) {
    const filterByColleague = buildFilterByColleague(colleagueStateFilters);
    const lockedPids = opts.lockedPids || new Set();
    const baseQuotas = opts.baseQuotas || {};
    const isLocked   = p => lockedPids.has(p.pratica_id);

    const manualPracticeIds = new Set(existingManual.map(a => a.practice_id));

    // Agenti Sally: ogni agente (match SOLO su agente_attuale) appartiene a un solo collega
    const dedicated = opts.dedicated || {};
    const ownerOf = new Map();
    for (const [cid, v] of Object.entries(dedicated)) {
      for (const a of (v.agents || [])) if (!ownerOf.has(norm(a))) ownerOf.set(norm(a), cid);
    }
    const dedicatedPractices = ownerOf.size
      ? practices.filter(p => !manualPracticeIds.has(p.id) && !isLocked(p) && ownerOf.has(norm(p.agente_attuale)))
      : [];
    const dedicatedIds = new Set(dedicatedPractices.map(p => p.id));

    const activeColleagues = colleagues.filter(c => c.active);
    const quotas = {};
    for (const c of activeColleagues) quotas[c.id] = baseQuotas[c.id] || 0;

    const rrIdx = new Map();
    const autoAssignments = [];
    const poolPractices   = [];

    // Le pratiche degli agenti Sally vanno solo al collega a cui sono dedicate, e solo se il loro
    // stato e' tra quelli che il collega ha attivi (filtri stato); le altre restano da assegnare.
    const notTaken = [];
    for (const p of dedicatedPractices) {
      const cid = ownerOf.get(norm(p.agente_attuale));
      const owner = activeColleagues.find(c => c.id === cid);
      if (!owner || !passesFilter(p, (filterByColleague[cid] || {})[norm(p.stato_attuale)])) { notTaken.push(p); continue; }
      quotas[cid] = (quotas[cid] || 0) + 1;
      autoAssignments.push({ practice_id: p.id, report_id: p.report_id, colleague_id: cid, is_manual: false });
    }

    // Pratiche eleggibili alla distribuzione normale: esclude manuali, Agenti Sally e bloccate
    const eligible = practices.filter(p => !manualPracticeIds.has(p.id) && !dedicatedIds.has(p.id) && !isLocked(p));

    // Chi ha "solo questi agenti" non entra nella distribuzione normale
    const candidates = activeColleagues.filter(c => !(dedicated[c.id] && dedicated[c.id].only));

    for (const p of eligible) {
      const result = findColleague(p, candidates, quotas, rrIdx, filterByColleague);
      if (result) {
        quotas[result.colleague.id]++;
        autoAssignments.push({
          practice_id:  p.id,
          report_id:    p.report_id,
          colleague_id: result.colleague.id,
          is_manual:    false,
        });
      } else {
        poolPractices.push({ ...p, _reason: _poolReason(p, candidates, quotas, filterByColleague) });
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
      excluded:    notTaken.length,
      sallyHooked: dedicatedPractices.length - notTaken.length,
      manual:      existingManual.length,
      workingDays,
    };

    return { autoAssignments, poolPractices, excludedPractices: notTaken, stats, kpi };
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

    const allowed = passingFilter.filter(c => !agentExcludedFor(p, c));
    if (!allowed.length) return 'agente_escluso';

    const allFull = allowed.every(c => (quotas[c.id] || 0) >= c.max_quota);
    if (allFull) return 'quota_full';
    return 'other';
  }

  return { distribute, dedicatedFromConfig };
})();
