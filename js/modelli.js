// ================================================================
// Modelli — popup con modelli mail precompilati e compositore "Richiesta integrazione"
// ================================================================
const Modelli = (() => {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Modelli statici/dinamici: {{cognome}} {{nome}} {{pratica}} {{istituto}} {{agente}} {{tipologia}} {{operatore}} {{data}}
  const TEMPLATES = [
    {"g": "Esiti e solleciti", "t": "Perfetta", "x": "Perfetto,\nPratica conforme.\nTI auguriamo buona giornata e buon lavoro\n\nUfficio Controlli\nVj"},
    {"g": "Esiti e solleciti", "t": "Sollecito", "x": "Buongiorno,\n\nTi sollecitiamo in merito alla precedente richiesta di integrazione della pratica in oggetto, al fine di ottenerne conformità per poter proseguire con i corretti passaggi di stato.\n\nResto a disposizione per ulteriori chiarimenti.\nBuon lavoro,\n\nUfficio Controlli"},
    {"g": "Richieste", "t": "SAL", "x": "Carissim,\nRichiediamo il caricamento in EGG per la seconda tranche di questa pratica SAL,\n\nLe caratteristiche sono le seguenti;\nImporto : €\nIstituto di credito: {{istituto}}\n2025\ngrazie per la collaborazione"},
    {"g": "Esiti e solleciti", "t": "Pratiche ferme", "x": "Carissim,\nEffettuando un controllo sulle pratiche ferme per mancanza di documenti e sulle pratiche in Richiesta Integrazione KIT Affida-6-I rimangono da effettuare le seguenti integrazioni per la pratica in oggetto:\n\nTi preghiamo di provvedere all'allineamento della piattaforma entro il / /2025 e di darci riscontro in risposta alla presente mail.\nCerti della tua collaborazione ti auguriamo una buona giornata.\n\nPer ulteriori chiarimenti resto a disposizione\nL'ufficio controlli."},
    {"g": "Esiti e solleciti", "t": "Stato errato/No documenti", "x": "Carissim,\n\nA seguito della revisione del report bancario, abbiamo riscontrato un disallineamento rispetto allo stato della pratica in piattaforma. Ti ricordiamo, in futuro, di procedere con l’aggiornamento dello stato in EGG in concomitanza con quello sul portale della banca.\n\nConfidando nella tua collaborazione, ti auguriamo buon lavoro.\n\nCordiali saluti,\nL’Ufficio Controlli"},
    {"g": "Richieste", "t": "Richiesta sblocco anagrafica", "x": "Carissim,\nUn nostro collaboratore ha ricevuto una richiesta da parte del cliente per una nuova pratica, ho bisogno del tuo consenso per poter sbloccare la seguente\n\n{{cognome}} {{nome}} - CF\n{{cognome}} {{nome}} - CF\n\nResto in Attesa,\nBuon lavoro\nUfficio Controlli"},
    {"g": "Richieste", "t": "Comunicazione mediazione banca", "x": "a prescindere dall'istituto di Credito è previsto dalla normativa l'obbligo del mediatore a comunicare all'istituto di credito l'ammontare complessivo delle commissioni percepite al fine del corretto calcolo del TAEG. Qualsiasi pratica di Finanziamento Azienda ha bisogno di una delle seguenti \"prove\" dell'avvenuta comunicazione del compenso di mediazione:\nDi uno screenshot del portale dove viene riportato il compenso (ove l'istituto di credito preveda un portale)\nDella PEC inviata dal mediatore all'istituto di credito (o anche di una mail con risposta da parte dell'istituto di credito)\nModulo TEG firmato e timbrato dalla filiale di riferimento (ove applicabile)\nIn assenza di una di queste non sarà possibile incassare il compenso di mediazione che, in caso di incasso, dovrà essere restituito al cliente."},
    {"g": "Richieste", "t": "Integrazioni annullata", "x": "Buongiorno ,\nNonostante la pratica sia ora in stato di \" \" sono qua a richiedere i seguenti documenti per la conformità del kit:\n\nPossono essere caricati in EGG o allegati in risposta alla presente mail,\nnel caso di caricamento in EGG si prega comunque di scrivere una mail per avvenuto caricamento documento mancante.\n\nTi ringraziamo per l'attenzione e ti auguriamo buona giornata.\n\nUfficio Controlli"},
    {"g": "In attesa di caricamento", "t": "PIES", "x": "Carissimo\nresto in attesa del caricamento in EGG del modulo PIES o del DCM firmato e timbrato dalla filiale per effettuare l'ultima verifica sul compenso di mediazione prima del passaggio di stato\nBuon lavoro"},
    {"g": "In attesa di caricamento", "t": "Plico Cqs", "x": "Carissimo,\nresto in attesa del caricamento in EGG del Plico Completo per effettuare l'ultima verifica prima del passaggio di stato\nBuon lavoro"},
    {"g": "In attesa di caricamento", "t": "Fin.Promo.Ter", "x": "Carissim,\nRimaniamo in attesa del caricamento in EGG del contratto di Fin.Promo.Ter in cui si evince il compenso di mediazione per poter proseguire con i passaggi di stato.\nBuon lavoro"},
    {"g": "In attesa di caricamento", "t": "Banca Aidexa", "x": "Carissimo\nRimaniamo in attesa del caricamento in EGG del contratto di Banca Aidexa in cui si evince il compenso di mediazione per poter proseguire con i passaggi di stato.\nBuon lavoro"},
    {"g": "Nuovi", "t": "Kit affida (nuovi)", "x": "Buon pomeriggio\na seguito di controllo documentale mi sento di dover far luce sulla composizione del kit affida in Completo.\ni moduli che lo compongono sono i seguenti:\nContratto di mediazione(vedo allegato giustamente alla presente)\nDCM / Dichiarazione compenso di mediazione(allegato alla presente ma senza data)\nPrivacy(Vedo allegata in EGG)\nAdeguata verifica (Assente)\nScheda di valutazione del rischio(assente)\nDichiarazioni cliente e certificazioni collaboratore(assente)\nModulo POG (Assente)\nModulo Polizze(ove presenti)"}
  ];

  // Tabella di verifica: documento x soggetto (si spunta ciò che manca). Configurabile da Admin.
  const DEFAULT_VERIFICA = {
    persons: ['1° Intestatario', '2° Intestatario', '1° Garante', '2° Garante'],
    groups: [
      { g: 'Kit affida', d: ['Contratto di Mediazione', 'Adeguata Verifica', 'Dichiarazioni cliente e certificazioni collaboratore', 'Scheda di valutazione del rischio', 'Privacy', 'POG', 'Polizze (ove presenti)'] },
      { g: 'Mutui', d: ['Dichiarazione compenso di mediazione', 'PIES (dopo stipula)'] },
      { g: 'Prestiti Personali', d: ['Dichiarazioni Aggiuntive Prestiti'] },
      { g: 'Aziende', d: ['Modulo TEG', 'Visura Camerale'] },
    ],
  };
  let PERSONS = DEFAULT_VERIFICA.persons, MATRIX = DEFAULT_VERIFICA.groups, MDOCS = MATRIX.flatMap(m => m.d);
  function setVerifica(v) {
    const ok = v && Array.isArray(v.persons) && v.persons.length && Array.isArray(v.groups) && v.groups.length;
    PERSONS = ok ? v.persons : DEFAULT_VERIFICA.persons;
    MATRIX = ok ? v.groups : DEFAULT_VERIFICA.groups;
    MDOCS = MATRIX.flatMap(g => g.d);
  }

  const INTRO = [
    ['hello', 'Buongiorno,'],
    ['intro', 'la presente per segnalarti che, a seguito del controllo documentale della pratica in oggetto abbiamo riscontrato quanto segue:'],
  ];
  const CLOSE_A = [
    ['wait', "Attendiamo l'integrazione di quanto mancante in risposta a questa mail oltre che in piattaforma."],
    ['upload', 'Ti preghiamo, in caso di caricamento diretto in piattaforma di rispondere comunque alla presente per informarci dell\'avvenuto caricamento.'],
  ];
  const CLOSE_B = [
    ['thanks', 'Certi della tua collaborazione ti auguriamo buon lavoro,'],
    ['sign', "L'ufficio controlli."],
  ];

  let root = null, S = null, opts = null;

  const today = () => new Date().toLocaleDateString('it-IT');
  function fields() {
    const p = S.pratica || {};
    return {
      pratica: p.pratica_id, cognome: p.cognome, nome: p.nome, agente: p.agente_attuale,
      istituto: p.istituto_finanziario, tipologia: p.tipologia, operatore: opts.operator, data: today(),
    };
  }
  const fill = text => {
    const f = fields();
    return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (f[k] ? String(f[k]) : `[${k.toUpperCase()}]`));
  };

  function newState() {
    return {
      tab: 'modelli', pratica: null, results: [], tpl: 0, tplText: null, preview: null,
      items: [], mat: {}, free: {}, nfree: 0,
    };
  }

  // ── Composizione "Richiesta integrazione" ───────────────────────────
  function itemText(key) {
    const [k, i] = key.split(':');
    if (k === 'm') return `${MDOCS[+i]} assente (${[...S.mat[i]].sort().map(n => PERSONS[n]).join(', ')})`;
    return S.free[i] || '';
  }
  function compose() {
    const join = l => l.map(([, t]) => t).join('\n');
    const parts = [join(INTRO)];
    if (S.items.length) parts.push(S.items.map(k => '- ' + itemText(k)).join('\n'));
    parts.push(join(CLOSE_A));
    parts.push(join(CLOSE_B) + '\n' + fill('{{operatore}}'));
    return parts.join('\n\n');
  }
  // Rigenera l'anteprima dalle voci selezionate e ridisegna
  function refresh() { S.preview = compose(); renderBody(); }
  function subject() {
    return fill('Integrazioni pratica {{pratica}} - {{cognome}} {{nome}}');
  }

  // ── Interfaccia ─────────────────────────────────────────────────────
  function praticaBar() {
    const p = S.pratica;
    return p
      ? `<span class="ec-mod-chosen"><strong>${esc(p.pratica_id)}</strong> ${esc(p.cognome || '')} ${esc(p.nome || '')}
           <button type="button" data-act="unpick" aria-label="Rimuovi pratica">✕</button></span>`
      : `<input type="search" class="form-control form-control-sm" data-role="search" placeholder="Cerca pratica (ID o cognome) per compilare i dati…" autocomplete="off" aria-label="Cerca pratica"/>
         <div class="ec-mod-results" data-role="results"></div>`;
  }

  function modelliTab() {
    let g = '';
    const list = TEMPLATES.map((t, i) => {
      const head = t.g !== g ? `<div class="ec-mod-group">${esc(t.g)}</div>` : '';
      g = t.g;
      return head + `<button type="button" class="ec-mod-tpl${i === S.tpl ? ' is-on' : ''}" data-act="tpl" data-i="${i}">${esc(t.t)}</button>`;
    }).join('');
    const text = S.tplText != null ? S.tplText : fill(TEMPLATES[S.tpl].x);
    return `
      <div class="ec-mod-cols">
        <div class="ec-mod-side">${list}</div>
        <div class="ec-mod-main">
          <textarea class="form-control ec-mod-text" data-role="tpltext" spellcheck="false" aria-label="Testo del modello">${esc(text)}</textarea>
          <div class="ec-mod-actions">
            <small class="text-muted me-auto">I campi tra [PARENTESI] vanno completati a mano. Il testo è modificabile prima di copiarlo.</small>
            <button type="button" class="btn btn-sm" data-act="reset">Ripristina</button>
            <button type="button" class="btn btn-orange btn-lg" data-act="copy-tpl">Copia testo</button>
          </div>
        </div>
      </div>`;
  }

  function integrazioneTab() {
    let idx = 0;
    const matrix = MATRIX.map(m => {
      const rows = m.d.map(d => {
        const i = idx++;
        return `<tr><td>${esc(d)}</td>${PERSONS.map((_, n) =>
          `<td class="text-center"><input type="checkbox" data-mat="${i}:${n}" ${S.mat[i] && S.mat[i].has(n) ? 'checked' : ''} aria-label="${esc(d)} - ${esc(PERSONS[n])}"/></td>`).join('')}</tr>`;
      }).join('');
      return `<tr class="ec-mod-mg"><td colspan="${PERSONS.length + 1}">${esc(m.g)}</td></tr>${rows}`;
    }).join('');
    const items = S.items.length ? S.items.map((k, n) => `
      <li draggable="true" data-n="${n}">
        <span class="ec-mod-grip" aria-hidden="true">⠿</span><span class="ec-mod-it">${esc(itemText(k))}</span>
        <button type="button" data-act="up" data-n="${n}" aria-label="Su">↑</button>
        <button type="button" data-act="down" data-n="${n}" aria-label="Giù">↓</button>
        <button type="button" data-act="del" data-n="${n}" aria-label="Rimuovi">✕</button>
      </li>`).join('') : '<li class="ec-mod-empty">Spunta a sinistra i documenti mancanti</li>';
    return `
      <div class="ec-mod-cols">
        <div class="ec-mod-side ec-mod-side--wide">
          <div class="ec-mod-sec">Verifica per intestatario / garante (spunta ciò che manca)</div>
          <table class="ec-mod-mat"><thead><tr><th>Documento</th>${PERSONS.map(p => `<th>${esc(p)}</th>`).join('')}</tr></thead><tbody>${matrix}</tbody></table>
          <div class="ec-mod-sec">Altra voce</div>
          <div class="d-flex gap-2"><input type="text" class="form-control form-control-sm" data-role="free" placeholder="Scrivi una voce e premi Invio" maxlength="300"/>
            <button type="button" class="btn btn-sm" data-act="addfree">Aggiungi</button></div>
        </div>
        <div class="ec-mod-main">
          <div class="ec-mod-sec">Voci segnalate — trascina per riordinare</div>
          <ul class="ec-mod-items" data-role="items">${items}</ul>
          <div class="ec-mod-sec d-flex align-items-center">Oggetto
            <button type="button" class="btn btn-sm ms-auto" data-act="copy-subj">Copia oggetto</button></div>
          <div class="ec-mod-subj">${esc(subject())}</div>
          <div class="ec-mod-sec">Anteprima (modificabile: se cambi le voci viene rigenerata)</div>
          <textarea class="form-control ec-mod-preview" data-role="preview" spellcheck="false" aria-label="Anteprima">${esc(S.preview == null ? compose() : S.preview)}</textarea>
          <div class="ec-mod-actions"><button type="button" class="btn btn-sm" data-act="clearall">Svuota</button>
            <button type="button" class="btn btn-orange btn-lg ms-auto" data-act="copy-int">Copia anteprima</button></div>
        </div>
      </div>`;
  }

  function render() {
    root.querySelector('[data-role="pratica"]').innerHTML = praticaBar();
    root.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('is-on', b.dataset.tab === S.tab));
    root.querySelector('[data-role="body"]').innerHTML = S.tab === 'modelli' ? modelliTab() : integrazioneTab();
  }
  // Ridisegna solo la parte "Richiesta integrazione" senza perdere la posizione di scroll
  function renderBody() {
    const body = root.querySelector('[data-role="body"]');
    const sides = [...body.querySelectorAll('.ec-mod-side, .ec-mod-main')].map(e => e.scrollTop);
    body.innerHTML = S.tab === 'modelli' ? modelliTab() : integrazioneTab();
    body.querySelectorAll('.ec-mod-side, .ec-mod-main').forEach((e, i) => { e.scrollTop = sides[i] || 0; });
  }

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* niente */ }
      ta.remove();
    }
    UI.toast((what || 'Testo') + ' copiato', 'success');
  }

  function search(q) {
    q = q.toLowerCase().trim();
    const box = root.querySelector('[data-role="results"]');
    if (!box) return;
    if (q.length < 2) { box.innerHTML = ''; return; }
    const out = [];
    for (const p of opts.practices()) {
      if (`${p.pratica_id || ''} ${p.cognome || ''} ${p.nome || ''}`.toLowerCase().includes(q)) { out.push(p); if (out.length >= 8) break; }
    }
    S.results = out;
    box.innerHTML = out.map((p, i) => `<button type="button" data-act="pick" data-i="${i}"><strong>${esc(p.pratica_id)}</strong> ${esc(p.cognome || '')} ${esc(p.nome || '')}
      <small class="text-muted">${esc(p.tipologia || '')}</small></button>`).join('') || '<div class="ec-mod-none">Nessuna pratica trovata</div>';
  }

  function toggleItem(key, on) {
    const i = S.items.indexOf(key);
    if (on && i < 0) S.items.push(key); else if (!on && i >= 0) S.items.splice(i, 1);
  }
  function move(n, d) {
    const m = n + d;
    if (m < 0 || m >= S.items.length) return;
    S.items.splice(m, 0, S.items.splice(n, 1)[0]);
  }
  function addFree() {
    const inp = root.querySelector('[data-role="free"]');
    const t = inp && inp.value.trim();
    if (!t) return;
    const id = 'x:' + (++S.nfree);
    S.free[S.nfree] = t;
    S.items.push(id);
    refresh();
    const again = root.querySelector('[data-role="free"]');
    if (again) again.focus();
  }

  function onClick(e) {
    const t = e.target.closest('[data-act], [data-tab]');
    if (!t) return;
    if (t.dataset.tab) { S.tab = t.dataset.tab; if (S.preview == null) S.preview = compose(); render(); return; }
    const a = t.dataset.act, i = +t.dataset.i, n = +t.dataset.n;
    switch (a) {
      case 'close': close(); break;
      case 'pick': S.pratica = S.results[i]; S.tplText = null; render(); break;
      case 'unpick': S.pratica = null; S.tplText = null; render(); break;
      case 'tpl': S.tpl = i; S.tplText = null; renderBody(); break;
      case 'reset': S.tplText = null; renderBody(); break;
      case 'copy-tpl': copy(root.querySelector('[data-role="tpltext"]').value); break;
      case 'up': move(n, -1); refresh(); break;
      case 'down': move(n, 1); refresh(); break;
      case 'del': {
        const k = S.items[n];
        S.items.splice(n, 1);
        if (k.startsWith('m:')) delete S.mat[k.slice(2)];
        refresh(); break;
      }
      case 'addfree': addFree(); break;
      case 'clearall': S.items = []; S.mat = {}; S.free = {}; refresh(); break;
      case 'copy-subj': copy(subject(), 'Oggetto'); break;
      case 'copy-int': copy(root.querySelector('[data-role="preview"]').value); break;
    }
  }

  function onChange(e) {
    const el = e.target;
    if (el.dataset.mat) {
      const [i, n] = el.dataset.mat.split(':').map(Number);
      const set = S.mat[i] || (S.mat[i] = new Set());
      if (el.checked) set.add(n); else set.delete(n);
      toggleItem('m:' + i, set.size > 0);
      if (!set.size) delete S.mat[i];
      refresh();
    }
  }

  function onInput(e) {
    if (e.target.dataset.role === 'search') search(e.target.value);
    else if (e.target.dataset.role === 'tpltext') S.tplText = e.target.value;
    else if (e.target.dataset.role === 'preview') S.preview = e.target.value;
  }

  // Trascinamento delle voci
  let dragFrom = null;
  function onDragStart(e) { const li = e.target.closest('li[draggable]'); if (li) { dragFrom = +li.dataset.n; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (x) { /* niente */ } } }
  function onDragOver(e) { if (dragFrom != null && e.target.closest('li[draggable]')) e.preventDefault(); }
  function onDrop(e) {
    const li = e.target.closest('li[draggable]');
    if (dragFrom == null || !li) return;
    e.preventDefault();
    const to = +li.dataset.n;
    if (to !== dragFrom) S.items.splice(to, 0, S.items.splice(dragFrom, 1)[0]);
    dragFrom = null;
    refresh();
  }

  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.role === 'free') { e.preventDefault(); addFree(); }
  }

  function close() {
    if (!root) return;
    document.removeEventListener('keydown', onKey, true);
    root.remove(); root = null;
    if (opts && opts.returnFocus) opts.returnFocus.focus();
  }

  function open(o) {
    close();
    opts = Object.assign({ practices: () => [], operator: '' }, o || {});
    opts.returnFocus = document.activeElement;
    setVerifica(opts.verifica);
    S = newState();
    if (opts.pid) S.pratica = opts.practices().find(p => p.pratica_id === opts.pid) || null;
    root = document.createElement('div');
    root.className = 'ec-modal';
    root.innerHTML = `
      <div class="ec-modal-box" role="dialog" aria-modal="true" aria-label="Modelli">
        <div class="ec-modal-head">
          <h3 class="ec-modal-title">Modelli</h3>
          <div class="ec-mod-pratica" data-role="pratica"></div>
          <button type="button" class="btn-close" data-act="close" aria-label="Chiudi"></button>
        </div>
        <div class="ec-modal-tabs">
          <button type="button" data-tab="modelli">Modelli mail</button>
          <button type="button" data-tab="integrazione">Richiesta integrazione</button>
        </div>
        <div class="ec-modal-body" data-role="body"></div>
      </div>`;
    document.body.appendChild(root);
    render();
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('drop', onDrop);
    document.addEventListener('keydown', onKey, true);
    const s = root.querySelector('[data-role="search"]');
    if (s) s.focus();
  }

  return { open, close, defaults: () => JSON.parse(JSON.stringify(DEFAULT_VERIFICA)) };
})();
