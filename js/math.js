export const MEAN = [0.485, 0.456, 0.406];
export const STD = [0.229, 0.224, 0.225];
export const PATCH = 14;
export const NEAR = 1.1;
export const SUBJECT = 3.0;
export const FAR_INV = 1 / 80;
export const SIZE_BASE = 2.5;

export const ASPECTS = [16 / 9, 4 / 3, 1, 3 / 4, 9 / 16];
export const TOKEN_LEVELS = [900, 640, 400];

export function snapAspect(aspect) {
  return ASPECTS.reduce((best, a) => (Math.abs(Math.log(a / aspect)) < Math.abs(Math.log(best / aspect)) ? a : best));
}

export function snapTokens(tokens) {
  return TOKEN_LEVELS.find((level) => level <= tokens) ?? TOKEN_LEVELS[TOKEN_LEVELS.length - 1];
}

export function modelSize(width, height, tokens = 900) {
  const aspect = snapAspect(width / height);
  const level = snapTokens(tokens);
  const rows = Math.max(6, Math.round(Math.sqrt(level / aspect)));
  const cols = Math.max(6, Math.round(rows * aspect));
  return { width: cols * PATCH, height: rows * PATCH };
}

export function storeSize(width, height, factor = 2) {
  return {
    width: Math.max(2, Math.round(width / factor)),
    height: Math.max(2, Math.round(height / factor)),
  };
}

export function toPixelValues(rgba, width, height, out = new Float32Array(3 * width * height)) {
  const n = width * height;
  const k0 = 1 / (255 * STD[0]);
  const k1 = 1 / (255 * STD[1]);
  const k2 = 1 / (255 * STD[2]);
  const b0 = MEAN[0] / STD[0];
  const b1 = MEAN[1] / STD[1];
  const b2 = MEAN[2] / STD[2];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = rgba[j] * k0 - b0;
    out[n + i] = rgba[j + 1] * k1 - b1;
    out[2 * n + i] = rgba[j + 2] * k2 - b2;
  }
  return out;
}

export function downsample(src, sw, sh, dw, dh, out = new Float32Array(dw * dh)) {
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.min(sh - 1, Math.floor(y * fy));
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((y + 1) * fy)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.min(sw - 1, Math.floor(x * fx));
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((x + 1) * fx)));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * sw;
        for (let xx = x0; xx < x1; xx++) sum += src[row + xx];
      }
      out[y * dw + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

export function sampleIndices(n, count) {
  const size = Math.min(n, count);
  const out = new Uint32Array(size);
  const phi = 0.6180339887498949;
  for (let i = 0; i < size; i++) {
    const f = (i * phi) % 1;
    out[i] = Math.min(n - 1, Math.floor(f * n));
  }
  return out;
}

export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}

export function sampled(values, idx) {
  const out = new Float32Array(idx.length);
  for (let k = 0; k < idx.length; k++) out[k] = values[idx[k]];
  return out;
}

function solve(src, ref, idx, keep) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let k = 0; k < idx.length; k++) {
    if (keep && !keep[k]) continue;
    const x = src[idx[k]];
    const y = ref[idx[k]];
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const den = n * sxx - sx * sx;
  if (n < 2 || Math.abs(den) < 1e-12) return { s: 1, t: n ? (sy - sx) / n : 0 };
  const s = (n * sxy - sx * sy) / den;
  return { s, t: (sy - s * sx) / n };
}

export function fitAffine(src, ref, idx, trim = 0.8) {
  let fit = solve(src, ref, idx, null);
  const res = new Float32Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    res[k] = Math.abs(fit.s * src[i] + fit.t - ref[i]);
  }
  const limit = quantile(Float32Array.from(res).sort(), trim);
  const keep = new Uint8Array(idx.length);
  for (let k = 0; k < idx.length; k++) keep[k] = res[k] <= limit ? 1 : 0;
  fit = solve(src, ref, idx, keep);
  let e = 0;
  let c = 0;
  for (let k = 0; k < idx.length; k++) {
    if (!keep[k]) continue;
    const i = idx[k];
    const d = fit.s * src[i] + fit.t - ref[i];
    e += d * d;
    c++;
  }
  return { s: fit.s, t: fit.t, rms: Math.sqrt(e / Math.max(1, c)) };
}

export class Stabilizer {
  constructor(width, height, options = {}) {
    this.n = width * height;
    this.idx = sampleIndices(this.n, options.samples ?? 3000);
    this.cutRms = options.cut ?? 0.11;
    this.pull = options.pull ?? 0.03;
    this.smooth = options.smooth ?? 0.4;
    this.range = options.range ?? 0.05;
    this.prev = null;
    this.samples = [];
    this.cuts = 0;
    this.frames = 0;
  }

  normalize(raw) {
    const s = sampled(raw, this.idx).sort();
    const lo = quantile(s, 0.02);
    const hi = quantile(s, 0.98);
    const k = 1 / Math.max(1e-6, hi - lo);
    return { s: k, t: -lo * k };
  }

  push(raw, out = new Float32Array(this.n)) {
    const norm = this.normalize(raw);
    let s = norm.s;
    let t = norm.t;
    let joined = false;
    if (this.prev) {
      const fit = fitAffine(raw, this.prev, this.idx);
      if (fit.s > 0 && fit.rms < this.cutRms) {
        s = fit.s * (1 - this.pull) + norm.s * this.pull;
        t = fit.t * (1 - this.pull) + norm.t * this.pull;
        joined = true;
      } else {
        this.cuts++;
      }
    }
    for (let i = 0; i < this.n; i++) out[i] = raw[i] * s + t;
    if (joined) {
      const prev = this.prev;
      const range = this.range;
      const smooth = this.smooth;
      for (let i = 0; i < this.n; i++) {
        const d = out[i] - prev[i];
        const a = d < 0 ? -d : d;
        if (a < range) out[i] -= d * smooth * (1 - a / range);
      }
    }
    if (!this.prev) this.prev = new Float32Array(this.n);
    this.prev.set(out);
    this.samples.push(sampled(out, this.idx));
    this.frames++;
    return out;
  }

  finish() {
    if (!this.samples.length) return { scale: 1, shift: 0, median: 0.5, cuts: 0 };
    const total = this.samples.reduce((a, s) => a + s.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const s of this.samples) {
      all.set(s, o);
      o += s.length;
    }
    all.sort();
    const lo = quantile(all, 0.01);
    const hi = quantile(all, 0.995);
    const scale = 1 / Math.max(1e-6, hi - lo);
    const shift = -lo * scale;
    const median = Math.min(0.95, Math.max(0.05, (quantile(all, 0.5) - lo) * scale));
    return { scale, shift, median, cuts: this.cuts };
  }
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 112;
  const mant = x & 0x7fffff;
  if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  if (exp <= 0) {
    if (exp < -10) return sign;
    const m = (mant | 0x800000) >> (1 - exp);
    return sign | ((m + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | ((exp << 10) + ((mant + 0x1000) >> 13));
}

export function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

export function toHalfArray(src, out = new Uint16Array(src.length), offset = 0) {
  for (let i = 0; i < src.length; i++) out[offset + i] = toHalf(src[i]);
  return out;
}

export function fromHalfArray(src, out = new Float32Array(src.length)) {
  for (let i = 0; i < src.length; i++) out[i] = fromHalf(src[i]);
  return out;
}

export function depthModel(median, strength = 1, size = 1) {
  const nearInv = 1 / NEAR;
  const medInv = 1 / SUBJECT;
  const slope = (nearInv - medInv) / Math.max(0.08, 1 - median);
  return { medInv, slope, median, strength, size };
}

export function depthAt(n, m) {
  const inv = Math.max(m.medInv + m.strength * m.slope * (n - m.median), FAR_INV);
  return m.size / inv;
}

export function fovFromAspect(aspect, diagonalDeg = 72) {
  const d = Math.tan((diagonalDeg * Math.PI) / 360);
  const tanV = d / Math.sqrt(1 + aspect * aspect);
  return { tanH: tanV * aspect, tanV };
}

export function sizeFromSlider(v) {
  return Math.pow(SIZE_BASE, v);
}

export function sliderFromSize(size) {
  return Math.log(size) / Math.log(SIZE_BASE);
}

export function progressiveOrder(n) {
  const order = [];
  const seen = new Uint8Array(n);
  const add = (i) => {
    if (i >= 0 && i < n && !seen[i]) {
      seen[i] = 1;
      order.push(i);
    }
  };
  add(0);
  add(n - 1);
  let step = 1;
  while (step * 2 < n) step *= 2;
  for (; step >= 1; step /= 2) {
    for (let i = 0; i < n; i += step) add(i);
  }
  return order;
}

export function chooseTokens(msPer900, duration, budgetMs, options = {}) {
  const max = options.max ?? 900;
  const min = options.min ?? 400;
  const fps = options.fps ?? 5;
  if (!msPer900) return max;
  const want = duration * fps + 1;
  const tokens = Math.round((max * budgetMs) / (msPer900 * want));
  return Math.max(min, Math.min(max, tokens));
}

export function bracket(times, t) {
  const n = times.length;
  if (!n || t <= times[0]) return { i0: 0, i1: 0, blend: 0 };
  if (t >= times[n - 1]) return { i0: n - 1, i1: n - 1, blend: 0 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  return { i0: lo, i1: hi, blend: span > 0 ? (t - times[lo]) / span : 0 };
}

export function frameTimes(meta) {
  if (Array.isArray(meta.times) && meta.times.length === meta.count) return meta.times;
  return Array.from({ length: meta.count }, (_, i) => i / meta.fps);
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.max(5, Math.round(seconds / 5) * 5)} s left`;
  return `${Math.round(seconds / 60)} min left`;
}
