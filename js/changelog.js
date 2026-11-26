// Registro delle novità mostrato dopo un aggiornamento. Aggiungere in cima una voce a ogni rilascio.
const CHANGELOG = [
  { v: '1.36.1', date: '2026-11-26', items: [
    'Piani di lavoro: tolte le colonne Area Manager, Group Manager e Team Manager.',
  ] },
  { v: '1.36.0', date: '2026-11-26', items: [
    'Utenti (admin): nuovo pulsante "Password" per impostare direttamente la password di un utente e farlo accedere.',
  ] },
  { v: '1.35.0', date: '2026-11-26', items: [
    'Login: nuovo link "Password dimenticata?". Inserisci l\'email, ricevi il link e imposti la nuova password.',
  ] },
  { v: '1.34.0', date: '2026-11-25', items: [
    'Nuova lista "Agenti con occhio di riguardo" in Configurazione (admin): nome agente, nota e, se vuoi, un collega a cui assegnare sempre le sue pratiche (dopo il salvataggio premi Ricalcola).',
    'Le pratiche di questi agenti hanno il nome in rosso con badge in piani di lavoro, pool e Da chiamare. Impostando uno stato diverso da Conforme compare un avviso con la nota (es. non mandare mail).',
  ] },
  { v: '1.33.0', date: '2026-11-25', items: [
    'Pool "Da chiamare" (admin e top): selezione multipla delle pratiche, anche nella scheda "Da chiamare" del piano di un collega. Con "Trasferisci" le sposti a un altro collega: la pratica passa nel suo piano e tornerà a lui con l\'esito.',
  ] },
  { v: '1.32.0', date: '2026-11-25', items: [
    'Piani di lavoro (admin e top): selezione multipla con caselle accanto a ogni pratica, casella "Seleziona" per tutte le filtrate e selezione a intervallo con Maiusc. Dalla barra puoi spostare le pratiche selezionate a un altro utente o toglierle dal piano (tornano nel pool Da assegnare).',
    'Pool "Da assegnare": le pratiche con Conformità o Originale Archiviato già compilati nel report ora risultano "Già controllate" (badge "Da report") e compaiono nell\'avviso di assegnazione, non più come mai controllate.',
  ] },
  { v: '1.31.0', date: '2026-11-24', items: [
    'Configurazione colleghi: gli stati presenti nel report ma non ancora in elenco vengono aggiunti in automatico, disattivati per tutti i colleghi. Ad ogni nuovo report i nuovi stati compaiono da soli e li attivi tu.',
  ] },
  { v: '1.30.0', date: '2026-11-24', items: [
    'Pool "Da assegnare": nuova colonna "Controllata" che mostra le pratiche già controllate in passato (data, stato e chi le ha controllate). Si può filtrare e ordinare come le altre colonne.',
    'Assegnando pratiche selezionate (anche in blocco), se alcune sono già state controllate compare un avviso: "ne hai selezionate 100, solo 65 non sono state controllate" e scegli se assegnare solo quelle non controllate, tutte oppure annullare.',
  ] },
  { v: '1.29.1', date: '2026-11-24', items: [
    'Pool "Da chiamare": le pratiche, anche già chiamate, restano nel pool fino a quando non viene dato l\'esito Conforme o Richiesta integrazioni. Non tornano più nel piano alle 19.',
  ] },
  { v: '1.29.0', date: '2026-11-24', items: [
    'Pool "Da chiamare": il pulsante "Segna chiamato" diventa un badge verde "Chiamato" con data e ora, e la riga si colora di verde (clicca il badge per annullare).',
    'Nuova colonna "Esito": quando il cliente ha integrato scegli Conforme o Richiesta integrazioni direttamente dal pool; la pratica esce dal pool e torna nel piano con lo stato scelto.',
  ] },
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
