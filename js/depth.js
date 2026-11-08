import {
  modelSize,
  storeSize,
  toPixelValues,
  downsample,
  Stabilizer,
  toHalfArray,
  fromHalfArray,
} from './math.js';

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
const MODEL = 'onnx-community/depth-anything-v2-base';
const TOKENS = 900;
const FPS = 10;
const MAX_FRAMES = 900;

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

export async function prepClip(url, { onProgress, throttle, cancelled } = {}) {
  const { tf, model } = await loadModel();
  const video = await openVideo(url);
  try {
    const width = video.videoWidth;
    const height = video.videoHeight;
    const duration = video.duration;
    if (!width || !height || !Number.isFinite(duration) || duration <= 0) throw new Error('video');
    const fps = Math.min(FPS, MAX_FRAMES / duration);
    const count = Math.max(2, Math.floor(duration * fps) + 1);
    const m = modelSize(width, height, TOKENS);
    const s = storeSize(m.width, m.height);
    const plane = s.width * s.height;
    const canvas = document.createElement('canvas');
    canvas.width = m.width;
    canvas.height = m.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const buffers = [new Float32Array(3 * m.width * m.height), new Float32Array(3 * m.width * m.height)];
    const depth = new Uint16Array(count * plane);
    const stab = new Stabilizer(s.width, s.height);
    const small = new Float32Array(plane);
    const norm = new Float32Array(plane);
    const dims = [1, 3, m.height, m.width];
    let half = false;

    const capture = async (i) => {
      const t = Math.min(i / fps, Math.max(0, duration - 0.04));
      await seek(video, t);
      ctx.drawImage(video, 0, 0, m.width, m.height);
      const rgba = ctx.getImageData(0, 0, m.width, m.height).data;
      return toPixelValues(rgba, m.width, m.height, buffers[i % 2]);
    };

    const infer = async (px) => {
      const input = half ? new tf.Tensor('float16', toHalfArray(px), dims) : new tf.Tensor('float32', px, dims);
      try {
        const out = await model({ pixel_values: input });
        return out.predicted_depth;
      } catch (e) {
        if (!half && /float16|type/i.test(String((e && e.message) || e))) {
          half = true;
          return infer(px);
        }
        throw e;
      }
    };

    const times = [];
    let pending = capture(0);
    for (let i = 0; i < count; i++) {
      if (cancelled && cancelled()) throw new Cancelled();
      const started = performance.now();
      const px = await pending;
      const run = infer(px);
      pending = i + 1 < count ? capture(i + 1) : null;
      const out = await run;
      const od = out.dims;
      const oh = od[od.length - 2];
      const ow = od[od.length - 1];
      const raw = out.type === 'float16' && !(out.data instanceof Float32Array) ? fromHalfArray(out.data) : out.data;
      downsample(raw, ow, oh, s.width, s.height, small);
      stab.push(small, norm);
      toHalfArray(norm, depth, i * plane);
      if (typeof out.dispose === 'function') out.dispose();
      times.push(performance.now() - started);
      if (times.length > 12) times.shift();
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      if (onProgress) onProgress((i + 1) / count, ((count - i - 1) * avg) / 1000);
      if (throttle && throttle()) await sleep(700);
    }
    if (pending) await pending;
    const g = stab.finish();
    return {
      depth,
      meta: {
        width,
        height,
        duration,
        fps,
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
