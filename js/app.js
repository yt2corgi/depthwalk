import * as THREE from 'three';
import { ScreenView } from './view.js?v=mw8f9zl5';
import { XRMode } from './xr.js?v=mw8f9zl5';
import { parseLinks, resolveTweet, pickFormats } from './resolve.js?v=mw8f9zl5';
import { formatTime, sizeFromSlider, sliderFromSize } from './math.js?v=mw8f9zl5';
import * as store from './store.js?v=mw8f9zl5';

const $ = (id) => document.getElementById(id);
const ui = {
  form: $('add'),
  link: $('link'),
  paste: $('paste'),
  hint: $('hint'),
  queue: $('queue'),
  queueEmpty: $('queue-empty'),
  recent: $('recent'),
  recentEmpty: $('recent-empty'),
  stage: $('stage'),
  canvas: $('view'),
  empty: $('empty'),
  play: $('play'),
  time: $('time'),
  speed: $('speed'),
  size: $('size'),
  vr: $('vr'),
  media: $('media'),
};

const SPEEDS = [1, 0.5, 0.25];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const items = [];
let active = null;
let speed = 1;
let seq = 0;
let working = false;
let scrubTo = null;
let saveTimer = 0;
let hintTimer = 0;
let vrReady = false;

const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.xr.enabled = true;
renderer.xr.setFoveation(0.2);

const view = new ScreenView();

const player = {
  togglePlay,
  cycleSpeed,
  step,
  scrub(delta) {
    const v = active && active.video;
    if (!v || !v.duration) return;
    scrubTo = clamp((scrubTo ?? v.currentTime) + delta, 0, Math.max(0, v.duration - 0.05));
  },
  endScrub() {
    scrubTo = null;
  },
  seekFraction(f) {
    const v = active && active.video;
    if (v && v.duration) v.currentTime = clamp(f, 0, 1) * Math.max(0, v.duration - 0.05);
  },
  setSizeSlider(x) {
    setSize(sizeFromSlider(clamp(x, -1, 1)));
  },
  nudgeSize(d) {
    if (active) setSize(clamp(active.meta.size * Math.exp(d), sizeFromSlider(-1), sizeFromSlider(1)));
  },
  onEnterVR() {
    syncControls();
  },
  onExitVR() {
    if (active && active.video) active.video.pause();
    resize();
    syncControls();
  },
  barState() {
    const v = active && active.video;
    const ready = readyItems();
    const m = active ? active.meta : null;
    const size = m ? m.size : 1;
    return {
      playing: !!v && !v.paused,
      time: v ? v.currentTime : 0,
      duration: (v && v.duration) || (m && m.duration) || 0,
      speed,
      size,
      sizeSlider: sliderFromSize(size),
      index: ready.indexOf(active) + 1,
      total: ready.length,
    };
  },
};

const xr = new XRMode(renderer, view, player);

function readyItems() {
  return items.filter((i) => i.status === 'ready');
}

function videoFor(item) {
  if (item.video) return item.video;
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.playsInline = true;
  v.loop = true;
  v.preload = 'auto';
  v.addEventListener('error', () => {
    const fallback = item.meta.prepUrl;
    if (fallback && !v.dataset.fallback && v.currentSrc !== fallback) {
      v.dataset.fallback = '1';
      v.src = fallback;
    }
  });
  v.addEventListener('play', syncControls);
  v.addEventListener('pause', syncControls);
  v.src = item.meta.playUrl || item.meta.prepUrl;
  ui.media.append(v);
  item.video = v;
  return v;
}

function dropVideo(item) {
  const v = item.video;
  if (!v) return;
  v.pause();
  view.release(v);
  v.removeAttribute('src');
  v.load();
  v.remove();
  item.video = null;
}

function playVideo(v) {
  view.resumeAudio();
  v.playbackRate = speed;
  const p = v.play();
  if (p && p.catch) p.catch(() => {});
}

function activate(item, play = false) {
  if (!item || item.status !== 'ready') return;
  if (active && active !== item) dropVideo(active);
  active = item;
  const v = videoFor(item);
  v.playbackRate = speed;
  view.setClip(item.meta, v);
  view.flash();
  item.meta.openedAt = Date.now();
  store.save(item.meta).then(refreshRecent);
  if (play) playVideo(v);
  syncControls();
  renderQueue();
}

function togglePlay() {
  const v = active && active.video;
  if (!v) return;
  if (v.paused) playVideo(v);
  else v.pause();
  syncControls();
}

function setSpeed(s) {
  speed = s;
  if (active && active.video) active.video.playbackRate = speed;
  syncControls();
}

function cycleSpeed() {
  setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]);
}

function step(dir) {
  const ready = readyItems();
  if (ready.length < 2) return;
  const i = ready.indexOf(active);
  const next = ready[(i + dir + ready.length) % ready.length];
  if (next === active) return;
  const wasPlaying = !!(active && active.video && !active.video.paused);
  activate(next, wasPlaying || xr.active);
}

function setSize(size) {
  if (!active) return;
  const meta = active.meta;
  meta.size = size;
  view.setSize(size);
  syncControls();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save({ key: meta.key, size: meta.size }), 700);
}

function hint(text) {
  ui.hint.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    ui.hint.textContent = '';
  }, 6000);
}

function addLinks(text) {
  const refs = parseLinks(text);
  if (!refs.length) {
    if (String(text || '').trim()) hint('That doesn’t look like an X post link');
    return 0;
  }
  for (const ref of refs) {
    const existing = items.find((i) => i.ref.key === ref.key);
    if (existing) {
      if (existing.status === 'ready') activate(existing);
      continue;
    }
    items.push({ uid: ++seq, ref, status: 'waiting', meta: null, video: null });
  }
  renderQueue();
  work();
  return refs.length;
}

async function work() {
  if (working) return;
  working = true;
  try {
    for (;;) {
      const item = items.find((i) => i.status === 'waiting');
      if (!item) break;
      await runItem(item);
    }
  } finally {
    working = false;
  }
}

function errorText(e) {
  if (e && e.code === 'novideo') return 'No video in this post';
  if (e && e.code === 'offline') return 'Couldn’t reach X right now';
  return 'This video wouldn’t load';
}

async function runItem(item) {
  try {
    item.status = 'finding';
    renderItem(item);
    const saved = await store.get(item.ref.key);
    if (saved) {
      item.meta = saved;
    } else {
      const info = await resolveTweet(item.ref);
      const video = info.videos[item.ref.index - 1] || info.videos[0];
      const formats = pickFormats(video);
      item.meta = {
        key: item.ref.key,
        id: item.ref.id,
        tweetUrl: info.url || `https://x.com/i/status/${item.ref.id}`,
        author: info.author,
        text: (info.text || '').slice(0, 160),
        thumb: video.thumb,
        playUrl: formats.play,
        prepUrl: formats.prep,
        width: video.width,
        height: video.height,
        duration: video.duration,
        size: 1,
        savedAt: Date.now(),
      };
    }
    if (item.removed) return;
    item.status = 'ready';
    if (!active) activate(item);
    else store.save(item.meta).then(refreshRecent);
    renderQueue();
    syncControls();
  } catch (e) {
    if (item.removed) return;
    item.status = 'error';
    item.error = errorText(e);
    renderItem(item);
  }
}

function removeItem(item) {
  item.removed = true;
  const i = items.indexOf(item);
  if (i >= 0) items.splice(i, 1);
  dropVideo(item);
  if (active === item) {
    view.clear();
    active = null;
    const next = readyItems()[0];
    if (next) activate(next);
  }
  renderQueue();
  syncControls();
}

function statusText(item) {
  if (item.status === 'waiting' || item.status === 'finding') return 'Finding the video';
  if (item.status === 'ready') return `Ready · ${formatTime(item.meta.duration)}`;
  if (item.status === 'error') return item.error;
  return '';
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function closeIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);
  return svg;
}

function makeRow(onOpen, onRemove, label) {
  const li = el('li', 'row');
  const thumb = el('div', 'thumb');
  const body = el('div', 'body');
  const title = el('div', 'title');
  const sub = el('div', 'sub');
  body.append(title, sub);
  const x = el('button', 'x');
  x.type = 'button';
  x.setAttribute('aria-label', label);
  x.append(closeIcon());
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    onRemove();
  });
  li.addEventListener('click', onOpen);
  li.append(thumb, body, x);
  return { li, thumb, title, sub, img: '' };
}

function setThumb(row, url) {
  if (!url || row.img === url) return;
  row.img = url;
  const img = new Image();
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.loading = 'lazy';
  img.src = url;
  row.thumb.replaceChildren(img);
}

function renderItem(item) {
  if (!item.row) {
    item.row = makeRow(
      () => {
        if (item.status === 'ready' && item !== active) activate(item);
      },
      () => removeItem(item),
      'Remove from queue',
    );
  }
  const r = item.row;
  r.li.classList.toggle('ready', item.status === 'ready');
  r.li.classList.toggle('on', item === active);
  r.li.classList.toggle('bad', item.status === 'error');
  setThumb(r, item.meta && item.meta.thumb);
  r.title.textContent = item.meta && item.meta.author ? `@${item.meta.author}` : `Post ${item.ref.id.slice(-6)}`;
  r.sub.textContent = statusText(item);
}

function renderQueue() {
  for (const item of items) renderItem(item);
  ui.queue.replaceChildren(...items.map((i) => i.row.li));
  ui.queueEmpty.hidden = items.length > 0;
}

function openRecent(meta) {
  const existing = items.find((i) => i.ref.key === meta.key);
  if (existing) {
    if (existing.status === 'ready') activate(existing);
    return;
  }
  const [id, index] = meta.key.split('-');
  const item = { uid: ++seq, ref: { id, user: null, index: +index || 1, key: meta.key }, status: 'ready', meta, video: null };
  items.push(item);
  activate(item);
}

async function refreshRecent() {
  const list = await store.list();
  const rows = list.map((meta) => {
    const r = makeRow(
      () => openRecent(meta),
      async () => {
        await store.remove(meta.key);
        refreshRecent();
      },
      'Forget this clip',
    );
    r.li.classList.add('ready');
    setThumb(r, meta.thumb);
    r.title.textContent = meta.author ? `@${meta.author}` : `Post ${String(meta.id).slice(-6)}`;
    r.sub.textContent = formatTime(meta.duration);
    return r.li;
  });
  ui.recent.replaceChildren(...rows);
  ui.recentEmpty.hidden = rows.length > 0;
}

function syncTime() {
  const v = active && active.video;
  ui.time.textContent = v ? `${formatTime(v.currentTime)} / ${formatTime(v.duration || active.meta.duration)}` : '0:00';
}

function syncControls() {
  const v = active && active.video;
  const playing = !!v && !v.paused;
  ui.play.dataset.playing = playing ? '1' : '0';
  ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  ui.play.disabled = !active;
  ui.empty.hidden = !!active;
  for (const b of ui.speed.querySelectorAll('button')) b.classList.toggle('on', +b.dataset.speed === speed);
  const slider = active ? sliderFromSize(active.meta.size || 1) : 0;
  if (document.activeElement !== ui.size) ui.size.value = String(slider);
  ui.size.style.setProperty('--fill', `${(((slider + 1) / 2) * 100).toFixed(1)}%`);
  ui.size.disabled = !active;
  if (!vrReady) {
    ui.vr.disabled = true;
    ui.vr.textContent = 'VR opens in the Quest browser';
  } else {
    ui.vr.disabled = !active || xr.active;
    ui.vr.textContent = active ? 'Enter VR' : 'Enter VR once a clip is ready';
  }
  syncTime();
}

function resize() {
  if (renderer.xr.isPresenting) return;
  const r = ui.stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  renderer.setSize(w, h, false);
  view.setAspect(w / h);
}

ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (addLinks(ui.link.value)) ui.link.value = '';
});

ui.link.addEventListener('paste', () => {
  setTimeout(() => {
    if (parseLinks(ui.link.value).length && addLinks(ui.link.value)) ui.link.value = '';
  }, 0);
});

ui.paste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text && addLinks(text)) {
      ui.link.value = '';
      return;
    }
  } catch {
    ui.link.focus();
  }
  ui.link.focus();
  hint('Long press the box and pick Paste');
});

ui.play.addEventListener('click', togglePlay);

ui.speed.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setSpeed(+b.dataset.speed);
});

ui.size.addEventListener('input', () => player.setSizeSlider(+ui.size.value));

ui.vr.addEventListener('click', async () => {
  if (!active || xr.active) return;
  const entering = xr.enter();
  playVideo(videoFor(active));
  try {
    await entering;
  } catch {
    hint('VR didn’t start so try again');
  }
  syncControls();
});

ui.canvas.addEventListener('click', togglePlay);

document.addEventListener('keydown', (e) => {
  if (e.target === ui.link) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  }
});

new ResizeObserver(resize).observe(ui.stage);

XRMode.supported().then((ok) => {
  vrReady = ok;
  syncControls();
});

let last = performance.now();
let uiClock = 0;
renderer.setAnimationLoop((t, frame) => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (xr.active) xr.frame(dt, frame);
  const v = active && active.video;
  if (scrubTo != null && v && !v.seeking && Math.abs(v.currentTime - scrubTo) > 0.03) v.currentTime = scrubTo;
  view.update();
  view.tick(dt);
  renderer.render(view.scene, view.camera);
  uiClock += dt;
  if (uiClock > 0.25 && !xr.active) {
    uiClock = 0;
    syncTime();
  }
});

resize();
syncControls();
renderQueue();
refreshRecent();

const params = new URLSearchParams(location.search);
const incoming = params.get('link') || params.get('url') || params.get('text');
if (incoming) addLinks(incoming);
