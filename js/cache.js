// ================================================================
// Cache locale (IndexedDB): dati pesanti e immutabili tra un caricamento
// e l'altro, cosi' F5 / nuova scheda non riscaricano migliaia di righe.
// Ogni errore (modalita' privata, quota, browser vecchio) = nessuna cache.
// ================================================================
const Cache = (() => {
  const STORE = 'kv';
  let _open = null;

  function open() {
    if (_open) return _open;
    _open = new Promise(resolve => {
      try {
        const r = indexedDB.open('easy-control-cache', 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => resolve(r.result);
        r.onerror = r.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return _open;
  }

  async function run(mode, fn) {
    const d = await open();
    if (!d) return null;
    return new Promise(resolve => {
      try {
        const tx = d.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && 'result' in req ? req.result : true);
        tx.onerror = tx.onabort = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  const get = async key => (await run('readonly', s => s.get(key))) ?? null;
  const set = (key, value) => run('readwrite', s => s.put(value, key));
  const del = key => run('readwrite', s => s.delete(key));
  const clear = () => run('readwrite', s => s.clear());
  const keys = async () => (await run('readonly', s => s.getAllKeys())) || [];

  // Elimina le voci che non riguardano il report indicato (report vecchi)
  async function dropOthers(keepReportId) {
    for (const k of await keys()) if (typeof k === 'string' && !k.endsWith(':' + keepReportId)) await del(k);
  }

  return { get, set, del, clear, dropOthers };
})();
