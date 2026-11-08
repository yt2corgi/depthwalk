import {
  modelSize,
  storeSize,
  toPixelValues,
  downsample,
  Stabilizer,
  toHalfArray,
  fromHalfArray,
  progressiveOrder,
  chooseTokens,
} from './math.js?v=mw8ewdhz';

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
const MODEL = 'onnx-community/depth-anything-v2-base';
const FPS = 10;
const MAX_FRAMES = 600;
const BUDGET_MS = 50000;
const SPEED_KEY = 'depthwalk.msPer900';

let loading = null;
let status = { phase: 'idle' };
const listeners = new Set();

function emit(next) {
  status = next;
  for (const fn of listeners) fn(status);
}

export function onModelStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

export async function gpuInfo() {
  try {
    if (!navigator.gpu) return { webgpu: false, f16: false };
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { webgpu: false, f16: false };
    return { webgpu: true, f16: adapter.features.has('shader-f16') };
  } catch {
    return { webgpu: false, f16: false };
  }
}

export function loadModel() {
  if (loading) return loading;
  loading = (async () => {
    emit({ phase: 'loading', progress: 0 });
    const tf = await import(TRANSFORMERS);
    tf.env.allowLocalModels = false;
    const gpu = await gpuInfo();
    const files = new Map();
    const progress_callback = (p) => {
      if (p && p.status === 'progress' && p.total) {
        files.set(p.file, [p.loaded, p.total]);
        let a = 0;
        let b = 0;
        for (const [l, t] of files.values()) {
          a += l;
          b += t;
        }
        emit({ phase: 'loading', progress: b ? a / b : 0 });
      }
    };
    const tries = gpu.webgpu
      ? [
          { device: 'webgpu', dtype: gpu.f16 ? 'q4f16' : 'q4' },
          { device: 'wasm', dtype: 'q8' },
        ]
      : [{ device: 'wasm', dtype: 'q8' }];
    let last = null;
    for (const opt of tries) {
      try {
        const model = await tf.AutoModel.from_pretrained(MODEL, { ...opt, progress_callback });
        emit({ phase: 'ready', device: opt.device, dtype: opt.dtype });
        return { tf, model, ...opt };
      } catch (e) {
        last = e;
      }
    }
    throw last || new Error('model');
  })();
  loading.catch(() => {
    loading = null;
    emit({ phase: 'error' });
  });
  return loading;
}

let lock = Promise.resolve();

function serial(fn) {
  const next = lock.then(fn, fn);
  lock = next.catch(() => null);
  return next;
}

let warming = null;

export function warmUp() {
  if (warming) return warming;
  warming = (async () => {
    const { tf, model } = await loadModel();
    const tokens = chooseTokens(readSpeed(), 20, BUDGET_MS * 0.85);
    for (const [w, h] of [
      [9, 16],
      [16, 9],
    ]) {
      const m = modelSize(w, h, tokens);
      const px = new Float32Array(3 * m.width * m.height);
      const out = await serial(() => model({ pixel_values: new tf.Tensor('float32', px, [1, 3, m.height, m.width]) }));
      const d = out && out.predicted_depth;
      if (d && typeof d.dispose === 'function') d.dispose();
    }
  })().catch(() => null);
  return warming;
}

function openVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const cleanup = () => {
      clearTimeout(timer);
      v.removeEventListener('loadeddata', ok);
      v.removeEventListener('error', fail);
    };
    const ok = () => {
      cleanup();
      resolve(v);
    };
    const fail = () => {
      cleanup();
      reject(new Error('video'));
    };
    const timer = setTimeout(fail, 30000);
    v.addEventListener('loadeddata', ok);
    v.addEventListener('error', fail);
    v.src = url;
  });
}

function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2 && !v.seeking) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, 8000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Cancelled extends Error {}

function readSpeed() {
  try {
    const v = parseFloat(localStorage.getItem(SPEED_KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeSpeed(ms) {
  try {
    const prev = readSpeed();
    localStorage.setItem(SPEED_KEY, String(prev ? prev * 0.4 + ms * 0.6 : ms));
  } catch {
    return;
  }
}

export async function prepClip(url, { onProgress, throttle, cancelled } = {}) {
  const { tf, model } = await loadModel();
  const t0 = performance.now();
  let paused = 0;
  const active = () => performance.now() - t0 - paused;
  const video = await openVideo(url);
  try {
    const width = video.videoWidth;
    const height = video.videoHeight;
    const duration = video.duration;
    if (!width || !height || !Number.isFinite(duration) || duration <= 0) throw new Error('video');
    const grid = Math.min(MAX_FRAMES, Math.max(2, Math.floor(duration * FPS) + 1));
    const last = Math.max(0, duration - 0.04);
    const timeOf = (i) => Math.min((i * last) / (grid - 1), last);
    const order = progressiveOrder(grid);
    const tokens = chooseTokens(readSpeed(), duration, BUDGET_MS * 0.85);
    const m = modelSize(width, height, tokens);
    const usedTokens = (m.width / 14) * (m.height / 14);
    const s = storeSize(m.width, m.height);
    const plane = s.width * s.height;
    const canvas = document.createElement('canvas');
    canvas.width = m.width;
    canvas.height = m.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const buffers = [new Float32Array(3 * m.width * m.height), new Float32Array(3 * m.width * m.height)];
    const raws = new Map();
    const small = new Float32Array(plane);
    const dims = [1, 3, m.height, m.width];
    let half = false;

    const capture = async (i) => {
      await seek(video, timeOf(i));
      ctx.drawImage(video, 0, 0, m.width, m.height);
      const rgba = ctx.getImageData(0, 0, m.width, m.height).data;
      return toPixelValues(rgba, m.width, m.height, buffers[i % 2]);
    };

    const infer = async (px) => {
      const input = half ? new tf.Tensor('float16', toHalfArray(px), dims) : new tf.Tensor('float32', px, dims);
      try {
        const out = await serial(() => model({ pixel_values: input }));
        return out.predicted_depth;
      } catch (e) {
        if (!half && /float16|type/i.test(String((e && e.message) || e))) {
          half = true;
          return infer(px);
        }
        throw e;
      }
    };

    const runs = [];
    const loops = [];
    let pending = capture(order[0]);
    for (let k = 0; k < order.length; k++) {
      if (cancelled && cancelled()) throw new Cancelled();
      const started = performance.now();
      const px = await pending;
      const ran = performance.now();
      const run = infer(px);
      const next = order[k + 1];
      pending = next !== undefined ? capture(next) : null;
      const out = await run;
      runs.push(performance.now() - ran);
      const od = out.dims;
      const oh = od[od.length - 2];
      const ow = od[od.length - 1];
      const raw = out.type === 'float16' && !(out.data instanceof Float32Array) ? fromHalfArray(out.data) : out.data;
      downsample(raw, ow, oh, s.width, s.height, small);
      raws.set(order[k], toHalfArray(small));
      if (typeof out.dispose === 'function') out.dispose();
      loops.push(performance.now() - started);
      if (loops.length > 12) loops.shift();
      const avg = loops.reduce((a, b) => a + b, 0) / loops.length;
      const spent = active();
      const left = Math.min((order.length - raws.size) * avg, Math.max(0, BUDGET_MS - spent));
      if (onProgress) onProgress(Math.max(raws.size / order.length, Math.min(0.99, spent / BUDGET_MS)), left / 1000);
      if (spent > BUDGET_MS && raws.size >= 2) break;
      if (throttle && throttle()) {
        const nap = performance.now();
        await sleep(700);
        paused += performance.now() - nap;
      }
    }
    if (pending) await pending.catch(() => null);
    if (runs.length >= 3) {
      const sorted = runs.slice(1).sort((a, b) => a - b);
      writeSpeed((sorted[sorted.length >> 1] * 900) / usedTokens);
    }
    const indices = [...raws.keys()].sort((a, b) => a - b);
    const count = indices.length;
    const depth = new Uint16Array(count * plane);
    const stab = new Stabilizer(s.width, s.height);
    const norm = new Float32Array(plane);
    indices.forEach((i, k) => {
      fromHalfArray(raws.get(i), small);
      stab.push(small, norm);
      toHalfArray(norm, depth, k * plane);
    });
    const g = stab.finish();
    return {
      depth,
      meta: {
        width,
        height,
        duration,
        fps: count / duration,
        times: indices.map(timeOf),
        tokens: usedTokens,
        count,
        depthW: s.width,
        depthH: s.height,
        nScale: g.scale,
        nShift: g.shift,
        nMed: g.median,
        cuts: g.cuts,
        model: MODEL,
      },
    };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
