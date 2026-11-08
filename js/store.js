const NAME = 'depthwalk';
const VERSION = 1;
const MAX_CLIPS = 12;
const MAX_BYTES = 700 * 1024 * 1024;

let opening = null;

function open() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('depth')) db.createObjectStore('depth');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('blocked'));
  });
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function list() {
  try {
    const db = await open();
    const t = db.transaction('clips', 'readonly');
    const all = await req(t.objectStore('clips').getAll());
    return all.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  } catch {
    return [];
  }
}

export async function get(key) {
  try {
    const db = await open();
    const t = db.transaction('clips', 'readonly');
    return (await req(t.objectStore('clips').get(key))) || null;
  } catch {
    return null;
  }
}

export async function depth(key) {
  try {
    const db = await open();
    const t = db.transaction('depth', 'readonly');
    const buf = await req(t.objectStore('depth').get(key));
    return buf ? new Uint16Array(buf) : null;
  } catch {
    return null;
  }
}

export async function save(meta, data) {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const db = await open();
    const t = db.transaction(['clips', 'depth'], 'readwrite');
    const buffer =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer;
    t.objectStore('clips').put({ ...meta, bytes: buffer.byteLength });
    t.objectStore('depth').put(buffer, meta.key);
    await done(t);
    await prune();
    return true;
  } catch {
    return false;
  }
}

export async function update(meta) {
  try {
    const db = await open();
    const t = db.transaction('clips', 'readwrite');
    const store = t.objectStore('clips');
    const current = await req(store.get(meta.key));
    if (current) store.put({ ...current, ...meta, bytes: current.bytes });
    await done(t);
  } catch {
    return;
  }
}

export async function remove(key) {
  try {
    const db = await open();
    const t = db.transaction(['clips', 'depth'], 'readwrite');
    t.objectStore('clips').delete(key);
    t.objectStore('depth').delete(key);
    await done(t);
  } catch {
    return;
  }
}

async function prune() {
  const all = await list();
  let bytes = 0;
  const drop = [];
  all.forEach((c, i) => {
    bytes += c.bytes || 0;
    if (i > 0 && (i >= MAX_CLIPS || bytes > MAX_BYTES)) drop.push(c.key);
  });
  for (const key of drop) await remove(key);
}
