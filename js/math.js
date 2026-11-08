export const DIAGONAL_FOV = 72;
export const SIZE_BASE = 1.6;

export function fovFromAspect(aspect, diagonalDeg = DIAGONAL_FOV) {
  const d = Math.tan((diagonalDeg * Math.PI) / 360);
  const tanV = d / Math.sqrt(1 + aspect * aspect);
  return { tanH: tanV * aspect, tanV };
}

export function screenSize(aspect, distance, size = 1) {
  const f = fovFromAspect(aspect);
  return { width: 2 * distance * f.tanH * size, height: 2 * distance * f.tanV * size };
}

export function sizeFromSlider(v) {
  return Math.pow(SIZE_BASE, v);
}

export function sliderFromSize(size) {
  return Math.log(size) / Math.log(SIZE_BASE);
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
