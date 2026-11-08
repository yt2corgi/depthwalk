import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fovFromAspect, screenSize, sizeFromSlider, sliderFromSize, formatTime, DIAGONAL_FOV } from '../js/math.js';

test('field of view follows aspect with a fixed diagonal', () => {
  const d = Math.tan((DIAGONAL_FOV * Math.PI) / 360);
  for (const a of [16 / 9, 9 / 16, 1]) {
    const f = fovFromAspect(a);
    assert.ok(Math.abs(Math.hypot(f.tanH, f.tanV) - d) < 1e-9);
    assert.ok(Math.abs(f.tanH / f.tanV - a) < 1e-9);
  }
});

test('screen keeps the video aspect so nothing stretches', () => {
  for (const a of [16 / 9, 9 / 16, 4 / 3, 1]) {
    for (const size of [0.7, 1, 1.5]) {
      const s = screenSize(a, 2.6, size);
      assert.ok(Math.abs(s.width / s.height - a) < 1e-9);
    }
  }
  const wide = screenSize(16 / 9, 2.6, 1);
  assert.ok(wide.width > 3 && wide.width < 3.6, `width ${wide.width}`);
});

test('size slider round trips', () => {
  assert.equal(sizeFromSlider(0), 1);
  assert.ok(Math.abs(sliderFromSize(sizeFromSlider(0.3)) - 0.3) < 1e-9);
});

test('time formatting', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(75.9), '1:15');
  assert.equal(formatTime(NaN), '0:00');
});
