/**
 * IndexedDB persistence for transactions, account names, and file metadata.
 * Survives page refresh — data is loaded back into APP on startup.
 */

const DB_NAME = 'gdpdu_pl_v1';
const DB_VERSION = 1;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('transactions')) {
        db.createObjectStore('transactions', { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

export async function saveTransactionsToDB(transactions, loadedFiles, accountNames) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['transactions', 'meta'], 'readwrite');
    // Clear old data
    tx.objectStore('transactions').clear();
    tx.objectStore('meta').clear();

    // Store transactions as a single serialised blob (fast & simple)
    // Dates need special handling — convert to ISO strings
    const serialised = transactions.map(t => ({
      ...t,
      datum: t.datum ? t.datum.toISOString() : null,
    }));
    tx.objectStore('transactions').add(serialised);

    // Store file metadata and account names
    tx.objectStore('meta').put(loadedFiles, 'loadedFiles');
    tx.objectStore('meta').put([...accountNames.entries()], 'accountNames');

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadTransactionsFromDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['transactions', 'meta'], 'readonly');
    let transactions = null, loadedFiles = null, accountNames = null;

    const tReq = tx.objectStore('transactions').getAll();
    tReq.onsuccess = () => {
      const rows = tReq.result;
      if (rows.length > 0) {
        // Deserialise dates back
        transactions = rows[0].map(t => ({
          ...t,
          datum: t.datum ? new Date(t.datum) : null,
        }));
      }
    };

    const lfReq = tx.objectStore('meta').get('loadedFiles');
    lfReq.onsuccess = () => { loadedFiles = lfReq.result || []; };

    const anReq = tx.objectStore('meta').get('accountNames');
    anReq.onsuccess = () => { accountNames = new Map(anReq.result || []); };

    tx.oncomplete = () => resolve({ transactions, loadedFiles, accountNames });
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['transactions', 'meta'], 'readwrite');
    tx.objectStore('transactions').clear();
    tx.objectStore('meta').clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
