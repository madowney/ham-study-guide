// Progress storage in the browser's IndexedDB. Nothing leaves your device.
const DB_NAME = 'ham-study-guide';
const DB_VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise;
const db = () => (dbPromise ||= open());

function tx(storeName, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  }));
}

// Records: { key: "<poolId>:<questionId>", pool, id, card, history }
export async function loadRecords(poolId) {
  const all = await tx('records', 'readonly', s => s.getAll());
  const out = {};
  for (const r of all) if (r.pool === poolId) out[r.id] = r;
  return out;
}

export function saveRecord(poolId, record) {
  return tx('records', 'readwrite', s => s.put({ ...record, key: `${poolId}:${record.id}`, pool: poolId }));
}

export async function resetPool(poolId) {
  const all = await tx('records', 'readonly', s => s.getAll());
  await tx('records', 'readwrite', s => { for (const r of all) if (r.pool === poolId) s.delete(r.key); });
}

export async function loadSettings() {
  const row = await tx('settings', 'readonly', s => s.get('settings'));
  return row?.value || {};
}

export function saveSettings(value) {
  return tx('settings', 'readwrite', s => s.put({ key: 'settings', value }));
}

export async function exportAll() {
  const [records, settings] = await Promise.all([
    tx('records', 'readonly', s => s.getAll()),
    loadSettings(),
  ]);
  return { app: 'ham-study-guide', version: 1, exportedAt: new Date().toISOString(), settings, records };
}

export async function importAll(data) {
  if (data?.app !== 'ham-study-guide' || !Array.isArray(data.records)) throw new Error('This file is not a ham study guide backup.');
  await tx('records', 'readwrite', s => { s.clear(); for (const r of data.records) s.put(r); });
  await saveSettings(data.settings || {});
  return data.records.length;
}
