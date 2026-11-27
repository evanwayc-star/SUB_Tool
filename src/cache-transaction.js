export async function cacheTransaction(indexedDB, databaseName, storeName, mode, run, timeoutMs = 1500, configureStore) {
  if (!indexedDB) return null;
  return new Promise(resolve => {
    let database = null, transaction = null, settled = false, result = null;
    const finish = value => {
      if (settled) return; settled = true; clearTimeout(timer);
      database?.close(); resolve(value);
    };
    const timer = setTimeout(() => { try { transaction?.abort(); } catch (_) {} finish(null); }, timeoutMs);
    let request;
    try { request = indexedDB.open(databaseName, 1); } catch (_) { finish(null); return; }
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(storeName, { keyPath: 'key' });
      configureStore?.(store);
    };
    request.onerror = request.onblocked = () => finish(null);
    request.onsuccess = () => {
      database = request.result;
      if (settled) { database.close(); return; }
      try {
        transaction = database.transaction(storeName, mode);
        transaction.oncomplete = () => finish(result);
        transaction.onerror = transaction.onabort = () => finish(null);
        run(transaction.objectStore(storeName), value => { result = value; });
      } catch (_) { try { transaction?.abort(); } catch (_) {} finish(null); }
    };
  });
}
