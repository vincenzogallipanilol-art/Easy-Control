// Versione dell'applicativo (maggiore.minore.patch).
// Si aggiorna a ogni pubblicazione: minore (+1, patch a 0) per le nuove funzioni, patch (+1) per correzioni e ritocchi.
const APP_VERSION = '1.41.1';
(function () {
  const el = document.getElementById('app-version');
  if (el) el.textContent = 'v' + APP_VERSION;
})();
