const NAME = 'depthwalk';
const VERSION = 2;
const MAX_CLIPS = 40;

let opening = null;

function open() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'key' });
      if (db.objectStoreNames.contains('depth')) db.deleteObjectStore('depth');
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
    const all = await req(db.transaction('clips', 'readonly').objectStore('clips').getAll());
    return all.filter((c) => c.playUrl).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  } catch {
    return [];
  }
}

export async function get(key) {
  try {
    const db = await open();
    const clip = await req(db.transaction('clips', 'readonly').objectStore('clips').get(key));
    return clip && clip.playUrl ? clip : null;
  } catch {
    return null;
  }
}

export async function save(meta) {
  try {
    const db = await open();
    const t = db.transaction('clips', 'readwrite');
    const store = t.objectStore('clips');
    const current = await req(store.get(meta.key));
    store.put({ ...(current || {}), ...meta });
    await done(t);
    await prune();
    return true;
  } catch {
    return false;
  }
}

export async function remove(key) {
  try {
    const db = await open();
    const t = db.transaction('clips', 'readwrite');
    t.objectStore('clips').delete(key);
    await done(t);
  } catch {
    return;
  }
}

async function prune() {
  const all = await list();
  for (const c of all.slice(MAX_CLIPS)) await remove(c.key);
}
