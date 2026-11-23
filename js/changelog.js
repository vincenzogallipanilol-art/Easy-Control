// Registro delle novità mostrato dopo un aggiornamento. Aggiungere in cima una voce a ogni rilascio.
const CHANGELOG = [
  { v: '1.28.0', date: '2026-11-23', items: [
    'Cliccando l\'ID di una pratica (si apre su EGG) la riga resta evidenziata con un contorno rosso pulsante e il tag "In controllo": tornando su Easy Control vedi subito quale pratica stavi controllando. Si spegne quando le dai uno stato, clicchi la X sul tag o apri un\'altra pratica.',
  ] },
  { v: '1.27.0', date: '2026-11-21', items: [
    'Admin: nuovo registro "Sally · pratiche già controllate". Le pratiche degli agenti migrati su Sally già controllate (Conforme / Richiesta integrazioni) non rientrano più nei nuovi report, così non vengono ricontrollate. Il registro si riempie da solo, si possono aggiungere o togliere ID a mano e si vede chi e quando ha controllato ogni pratica.',
  ] },
  { v: '1.26.1', date: '2026-11-20', items: [
    'Dashboard utente: "Controllate oggi" (e il periodo scelto) ora conta solo le tue pratiche controllate, non quelle di tutto il team.',
  ] },
  { v: '1.26.0', date: '2026-11-20', items: [
    'Piano di lavoro: di default mostra solo le pratiche "Da lavorare", così il piano resta sempre pulito. "Tutte" e gli altri chip mostrano le già lavorate; cercando una pratica o usando i filtri colonna si cerca in tutte.',
    'Dashboard, box dei colleghi: oltre ad "Assegnate" (tutte le pratiche assegnate, anche chiuse o già nei pool) ora ci sono "Nel piano" e "Da lavorare", che combaciano con il piano di lavoro del collega.',
  ] },
  { v: '1.25.0', date: '2026-11-20', items: [
    'Quando le pratiche del piano di lavoro sono finite compare il pulsante "Richiedi altre pratiche": assegna al collega un nuovo gruppo di pratiche libere del pool, adatte alle sue tipologie, agli stati e agli agenti configurati. Non toglie mai pratiche ad altri.',
  ] },
  { v: '1.24.0', date: '2026-11-20', items: [
    'Pool Audit / xFlat / Help: la colonna "Inviata da" indica chi ha inserito lo stato (e il piano di lavoro di provenienza).',
    'Nuovo pulsante "Integra": il Top sceglie lo stato corretto (Conforme o Richiesta integrazioni), scrive la nota e la pratica esce dal pool e torna nel piano di chi l\'aveva inviata, con una notifica. "Chiudi" resta per rimuoverla senza rimandarla.',
  ] },
  { v: '1.23.0', date: '2026-11-19', items: [
    'Avviso automatico quando è disponibile una nuova versione: basta un clic su "Aggiorna ora", senza F5.',
    'Dopo l\'aggiornamento compare questo riepilogo delle novità. Si riapre cliccando sulla versione sopra "Esci".',
  ] },
  { v: '1.22.2', date: '2026-11-19', items: [
    'Filtri di ricerca più grandi.',
    'Nel filtro colonna, cercando un valore (es. il numero di una pratica) resta selezionato solo quello: OK o Invio mostrano solo le righe trovate.',
  ] },
  { v: '1.22.0', date: '2026-11-19', items: [
    'Tema chiaro e scuro: si sceglie dal menu che si apre cliccando sul proprio nome in alto a destra.',
  ] },
  { v: '1.21.0', date: '2026-11-19', items: [
    'Utenze Top e Admin: nel piano di lavoro il pulsante ⇄ accanto alla pratica la sposta a un altro collega.',
    'Pool "Da assegnare": selezione multipla con caselle, "seleziona tutte" e intervallo con Maiusc, poi assegnazione in blocco a un collega.',
    'Le pratiche Agenti Sally nel pool hanno ora la casella e il menu "Assegna a".',
  ] },
  { v: '1.20.0', date: '2026-11-18', items: [
    'Chat: conversazioni private con un collega o con tutto il gruppo, con badge rosso lampeggiante dei messaggi da leggere.',
    'La versione dell\'applicativo è visibile sopra il pulsante "Esci".',
    'Agenti Sally spostati nella configurazione del singolo collega: ognuno può ricevere solo le pratiche dei propri agenti.',
    'Ordinamento su più colonne insieme nelle tabelle.',
  ] },
];
