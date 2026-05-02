// IndexedDB-backed durable queue for events that fail to flush to Supabase.
// On next successful flush, drains in FIFO order before new events.

const DB_NAME = "scout";
const DB_VERSION = 1;
const STORE_EVENTS = "queued_events";
const STORE_SCREENSHOTS = "screenshots";

let _db: IDBDatabase | null = null;

export async function openDb(): Promise<IDBDatabase> {
  if (_db) return _db;
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        db.createObjectStore(STORE_EVENTS, { keyPath: "_localId" });
      }
      if (!db.objectStoreNames.contains(STORE_SCREENSHOTS)) {
        db.createObjectStore(STORE_SCREENSHOTS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function enqueueEvent(payload: unknown & { _localId: string }): Promise<void> {
  const db = await openDb();
  await tx(db, STORE_EVENTS, "readwrite", (s) => s.put(payload));
}

export async function drainEvents(handler: (rows: unknown[]) => Promise<void>, batchSize = 50): Promise<number> {
  const db = await openDb();
  const all = await tx<unknown[]>(db, STORE_EVENTS, "readonly", (s) =>
    new Promise<unknown[]>((res, rej) => {
      const r = s.getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    })
  );
  let drained = 0;
  for (let i = 0; i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize);
    await handler(batch);
    await tx(db, STORE_EVENTS, "readwrite", (s) => {
      for (const row of batch as Array<{ _localId: string }>) s.delete(row._localId);
    });
    drained += batch.length;
  }
  return drained;
}

export async function putScreenshot(id: string, dataUrl: string): Promise<void> {
  const db = await openDb();
  await tx(db, STORE_SCREENSHOTS, "readwrite", (s) => s.put({ id, dataUrl, ts: Date.now() }));
}

export async function getScreenshot(id: string): Promise<string | null> {
  const db = await openDb();
  return await tx<string | null>(db, STORE_SCREENSHOTS, "readonly", (s) =>
    new Promise<string | null>((res, rej) => {
      const r = s.get(id);
      r.onsuccess = () => res(r.result?.dataUrl ?? null);
      r.onerror = () => rej(r.error);
    })
  );
}

export async function deleteScreenshot(id: string): Promise<void> {
  const db = await openDb();
  await tx(db, STORE_SCREENSHOTS, "readwrite", (s) => s.delete(id));
}

function tx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => T | Promise<T> | void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result: T | undefined;
    const ret = fn(s);
    if (ret instanceof Promise) {
      ret.then((r) => (result = r)).catch(reject);
    } else if (ret !== undefined) {
      result = ret as T;
    }
    t.oncomplete = () => resolve(result as T);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
