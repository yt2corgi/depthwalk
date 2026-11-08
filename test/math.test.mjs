import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelSize,
  storeSize,
  toHalf,
  fromHalf,
  fitAffine,
  sampleIndices,
  Stabilizer,
  depthModel,
  depthAt,
  fovFromAspect,
  downsample,
  toPixelValues,
  NEAR,
  SUBJECT,
  formatTime,
  formatEta,
  sizeFromSlider,
  sliderFromSize,
} from '../js/math.js';

test('model size is patch aligned and keeps aspect', () => {
  for (const [w, h] of [
    [1920, 1080],
    [720, 1280],
    [1080, 1080],
  ]) {
    const m = modelSize(w, h, 900);
    assert.equal(m.width % 14, 0);
    assert.equal(m.height % 14, 0);
    const tokens = (m.width / 14) * (m.height / 14);
    assert.ok(tokens > 780 && tokens < 1020, `tokens ${tokens}`);
    assert.ok(Math.abs(m.width / m.height - w / h) < 0.08);
    const s = storeSize(m.width, m.height);
    assert.equal(s.width, m.width / 2);
  }
});

test('half floats round trip', () => {
  for (const v of [0, 1, -2, 0.5, 0.333, 1.2345, 65504, 6.1e-5, 1e-6, 1000.5]) {
    const back = fromHalf(toHalf(v));
    const tol = Math.max(Math.abs(v) * 1e-3, 6e-8);
    assert.ok(Math.abs(back - v) <= tol, `${v} -> ${back}`);
  }
  assert.equal(fromHalf(toHalf(1e9)), Infinity);
  assert.equal(toHalf(1), 0x3c00);
});

test('affine fit recovers scale and shift with outliers', () => {
  const n = 5000;
  const src = new Float32Array(n);
  const ref = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    src[i] = Math.sin(i * 0.37) * 4 + 6;
    ref[i] = src[i] * 0.25 - 0.4;
    if (i % 17 === 0) ref[i] += 3;
  }
  const fit = fitAffine(src, ref, sampleIndices(n, 2000));
  assert.ok(Math.abs(fit.s - 0.25) < 1e-3, `s ${fit.s}`);
  assert.ok(Math.abs(fit.t + 0.4) < 1e-2, `t ${fit.t}`);
  assert.ok(fit.rms < 1e-3);
});

test('stabilizer removes per frame scale flicker and spots cuts', () => {
  const w = 40;
  const h = 30;
  const n = w * h;
  const base = new Float32Array(n);
  const other = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      base[y * w + x] = 1 + x / w + (y > 15 && x > 10 && x < 25 ? 2 : 0);
      other[y * w + x] = 3 - y / h + (x < 8 ? 1.5 : 0);
    }
  }
  const stab = new Stabilizer(w, h, { samples: 600 });
  const outs = [];
  const scales = [1, 1.6, 0.7, 2.2, 1.1];
  scales.forEach((s, k) => {
    const raw = base.map((v) => v * s * 37 + k * 5);
    outs.push(stab.push(raw).slice());
  });
  for (let k = 1; k < outs.length; k++) {
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(outs[k][i] - outs[0][i]));
    assert.ok(maxDiff < 0.06, `frame ${k} drift ${maxDiff}`);
  }
  assert.equal(stab.cuts, 0);
  stab.push(other.map((v) => v * 9));
  assert.equal(stab.cuts, 1);
  const g = stab.finish();
  assert.ok(g.scale > 0);
  assert.ok(g.median > 0 && g.median < 1);
});

test('depth model maps disparity to sensible distances', () => {
  const m = depthModel(0.45, 1, 1);
  assert.ok(Math.abs(depthAt(1, m) - NEAR) < 1e-9);
  assert.ok(Math.abs(depthAt(0.45, m) - SUBJECT) < 1e-9);
  assert.ok(depthAt(0, m) > SUBJECT);
  assert.ok(depthAt(-5, m) <= 80 + 1e-9);
  const flat = depthModel(0.45, 0, 1);
  assert.ok(Math.abs(depthAt(1, flat) - SUBJECT) < 1e-9);
  assert.ok(Math.abs(depthAt(0, flat) - SUBJECT) < 1e-9);
  const big = depthModel(0.45, 1, 2);
  assert.ok(Math.abs(depthAt(0.45, big) - SUBJECT * 2) < 1e-9);
});

test('field of view follows aspect with fixed diagonal', () => {
  const d = Math.tan((72 * Math.PI) / 360);
  for (const a of [16 / 9, 9 / 16, 1]) {
    const f = fovFromAspect(a);
    assert.ok(Math.abs(Math.hypot(f.tanH, f.tanV) - d) < 1e-9);
    assert.ok(Math.abs(f.tanH / f.tanV - a) < 1e-9);
  }
});

test('downsample averages blocks', () => {
  const src = Float32Array.from([1, 1, 3, 3, 1, 1, 3, 3, 5, 5, 7, 7, 5, 5, 7, 7]);
  assert.deepEqual(Array.from(downsample(src, 4, 4, 2, 2)), [1, 3, 5, 7]);
});

test('pixel values are normalized per channel', () => {
  const px = toPixelValues(Uint8ClampedArray.from([255, 0, 128, 255]), 1, 1);
  assert.ok(Math.abs(px[0] - (1 - 0.485) / 0.229) < 1e-5);
  assert.ok(Math.abs(px[1] - (0 - 0.456) / 0.224) < 1e-5);
});

test('formatting', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(75.9), '1:15');
  assert.equal(formatEta(42), '40 s left');
  assert.equal(formatEta(130), '2 min left');
  assert.ok(Math.abs(sliderFromSize(sizeFromSlider(0.3)) - 0.3) < 1e-9);
});
