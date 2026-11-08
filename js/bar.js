import * as THREE from 'three';
import { formatTime } from './math.js?v=mw8fr568';

const W = 1280;
const H = 400;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const REGIONS = [
  { id: 'play', x: 40, y: 36, w: 120, h: 120 },
  { id: 'track', x: 270, y: 56, w: 760, h: 80, slider: true },
  { id: 'last', x: 40, y: 200, w: 140, h: 160 },
  { id: 'next', x: 192, y: 200, w: 140, h: 160 },
  { id: 'speed', x: 344, y: 200, w: 140, h: 160 },
  { id: 'view', x: 496, y: 200, w: 140, h: 160 },
  { id: 'depth', x: 648, y: 200, w: 230, h: 160, slider: true },
  { id: 'size', x: 890, y: 200, w: 190, h: 160, slider: true },
  { id: 'exit', x: 1092, y: 200, w: 148, h: 160 },
];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function sliderSpan(r) {
  if (r.id === 'track') return { x0: r.x, x1: r.x + r.w };
  return { x0: r.x + 28, x1: r.x + r.w - 28 };
}

export class Bar {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: 0,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.15), this.material);
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    this.until = 0;
    this.opacity = 0;
    this.hover = null;
    this.key = '';
  }

  get visible() {
    return performance.now() < this.until;
  }

  show(ms = 4000) {
    this.until = Math.max(this.until, performance.now() + ms);
  }

  hide() {
    this.until = 0;
  }

  regionAt(uv) {
    const x = uv.x * W;
    const y = (1 - uv.y) * H;
    const r = REGIONS.find((g) => x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h);
    if (!r) return { id: 'panel' };
    if (!r.slider) return { id: r.id };
    const s = sliderSpan(r);
    return { id: r.id, frac: Math.max(0, Math.min(1, (x - s.x0) / (s.x1 - s.x0))) };
  }

  tick(dt) {
    const target = this.visible ? 1 : 0;
    this.opacity += (target - this.opacity) * (1 - Math.exp(-dt * 10));
    if (Math.abs(this.opacity - target) < 0.01) this.opacity = target;
    this.material.opacity = this.opacity;
    this.mesh.visible = this.opacity > 0.01;
  }

  draw(s, hover) {
    const key = [
      s.playing ? 1 : 0,
      Math.floor(s.time * 4),
      Math.round(s.duration),
      s.speed,
      Math.round(s.strength * 50),
      Math.round(s.sizeSlider * 50),
      s.index,
      s.total,
      s.wrap ? 1 : 0,
      hover || '',
    ].join('|');
    if (key === this.key) return;
    this.key = key;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, 0, 0, W, H, 56);
    ctx.fillStyle = 'rgba(8, 8, 8, 0.94)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(100, 96, 56, 0, Math.PI * 2);
    ctx.fillStyle = hover === 'play' ? '#d9d9d9' : '#ffffff';
    ctx.fill();
    ctx.fillStyle = '#000000';
    if (s.playing) {
      roundRect(ctx, 80, 72, 14, 48, 4);
      ctx.fill();
      roundRect(ctx, 106, 72, 14, 48, 4);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(86, 68);
      ctx.lineTo(128, 96);
      ctx.lineTo(86, 124);
      ctx.closePath();
      ctx.fill();
    }

    ctx.font = `500 34px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ededed';
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(s.time), 248, 96);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8e8e8e';
    ctx.fillText(formatTime(s.duration), 1052, 96);

    const p = s.duration > 0 ? Math.max(0, Math.min(1, s.time / s.duration)) : 0;
    roundRect(ctx, 270, 90, 760, 12, 6);
    ctx.fillStyle = '#262626';
    ctx.fill();
    roundRect(ctx, 270, 90, Math.max(12, 760 * p), 12, 6);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(270 + 760 * p, 96, hover === 'track' ? 22 : 17, 0, Math.PI * 2);
    ctx.fill();

    const cell = (id, big, small) => {
      const r = REGIONS.find((g) => g.id === id);
      roundRect(ctx, r.x, r.y, r.w, r.h, 30);
      ctx.fillStyle = hover === id ? '#262626' : '#161616';
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ededed';
      ctx.font = `600 40px ${FONT}`;
      ctx.fillText(big, r.x + r.w / 2, r.y + (small ? 66 : r.h / 2));
      if (small) {
        ctx.font = `500 28px ${FONT}`;
        ctx.fillStyle = '#8e8e8e';
        ctx.fillText(small, r.x + r.w / 2, r.y + 112);
      }
    };

    const slider = (id, label, frac, value) => {
      const r = REGIONS.find((g) => g.id === id);
      roundRect(ctx, r.x, r.y, r.w, r.h, 30);
      ctx.fillStyle = hover === id ? '#262626' : '#161616';
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.font = `500 30px ${FONT}`;
      ctx.fillStyle = '#8e8e8e';
      ctx.fillText(label, r.x + 28, r.y + 50);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ededed';
      ctx.fillText(value, r.x + r.w - 28, r.y + 50);
      const sp = sliderSpan(r);
      const y = r.y + 108;
      roundRect(ctx, sp.x0, y - 6, sp.x1 - sp.x0, 12, 6);
      ctx.fillStyle = '#2c2c2c';
      ctx.fill();
      const f = Math.max(0, Math.min(1, frac));
      roundRect(ctx, sp.x0, y - 6, Math.max(12, (sp.x1 - sp.x0) * f), 12, 6);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sp.x0 + (sp.x1 - sp.x0) * f, y, 17, 0, Math.PI * 2);
      ctx.fill();
    };

    cell('last', 'Last', s.total > 1 ? `${s.index} of ${s.total}` : '');
    cell('next', 'Next', s.total > 1 ? `${s.index} of ${s.total}` : '');
    cell('speed', `${s.speed}x`, 'Speed');
    cell('view', s.wrap ? '180' : 'Real', 'View');
    slider('depth', '3D', s.strength / 2, `${Math.round(s.strength * 100)}`);
    slider('size', 'Size', (s.sizeSlider + 1) / 2, `${Math.round(s.size * 100)}`);
    cell('exit', 'Exit', '');
    this.texture.needsUpdate = true;
  }
}
