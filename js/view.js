import * as THREE from 'three';
import { depthModel, depthAt, fovFromAspect, bracket, frameTimes, wrapSpans, wrapScale } from './math.js?v=mw8fr568';

const MESH_VERT = `
uniform sampler2D depthA;
uniform sampler2D depthB;
uniform float blend;
uniform vec2 res;
uniform float nScale;
uniform float nShift;
uniform float nMed;
uniform float medInv;
uniform float slope;
uniform float strength;
uniform float size;
uniform vec2 tanFov;
uniform vec2 span;
uniform float wrap;
varying vec2 vUv;
varying float vEdge;
varying vec2 vFar;

float dispAt(vec2 uv) {
  vec2 d = vec2(uv.x, 1.0 - uv.y);
  d = (d * (res - 1.0) + 0.5) / res;
  float a = texture2D(depthA, d).r;
  float b = texture2D(depthB, d).r;
  return mix(a, b, blend) * nScale + nShift;
}

float invAt(vec2 uv) {
  return max(medInv + strength * slope * (dispAt(uv) - nMed), 0.0125);
}

void main() {
  vUv = uv;
  vec2 px = 1.0 / (res - 1.0);
  float c = invAt(uv);
  float l = invAt(uv - vec2(px.x, 0.0));
  float r = invAt(uv + vec2(px.x, 0.0));
  float dn = invAt(uv - vec2(0.0, px.y));
  float up = invAt(uv + vec2(0.0, px.y));
  float jump = max(max(abs(l - c), abs(r - c)), max(abs(dn - c), abs(up - c))) / c;
  vEdge = smoothstep(0.06, 0.22, jump);
  vec2 g = vec2(l - r, dn - up);
  vFar = g / max(length(g), 1e-5);
  float z = max(size / c, 0.35);
  vec3 flatP = vec3((uv.x * 2.0 - 1.0) * tanFov.x, (uv.y * 2.0 - 1.0) * tanFov.y, -1.0) * z;
  float lon = (uv.x - 0.5) * span.x;
  float lat = (uv.y - 0.5) * span.y;
  vec3 roundP = vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat)) * z;
  vec3 p = mix(flatP, roundP, wrap);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const MESH_FRAG = `
uniform sampler2D map;
uniform sampler2D soft;
uniform sampler2D bleed;
uniform float fade;
uniform float bleedGain;
uniform float edgeFill;
varying vec2 vUv;
varying float vEdge;
varying vec2 vFar;

void main() {
  vec3 c = texture2D(map, vUv).rgb;
  vec3 s = texture2D(soft, clamp(vUv + vFar * 0.035, 0.0, 1.0)).rgb;
  c = mix(c, s * 0.55, clamp(vEdge * edgeFill, 0.0, 1.0));
  float e = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float border = smoothstep(0.0, 0.03, e);
  vec3 b = texture2D(bleed, vUv).rgb * bleedGain;
  c = mix(b, c, border);
  gl_FragColor = vec4(c * fade, 1.0);
}
`;

const DOME_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAG = `
uniform sampler2D bleed;
uniform vec2 tanFov;
uniform vec2 span;
uniform float wrap;
uniform float bleedGain;
uniform float fade;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float front = smoothstep(0.02, 0.45, -d.z);
  vec2 p = d.xy / max(-d.z, 0.02);
  vec2 uvFlat = clamp(p / tanFov * 0.5 + 0.5, 0.0, 1.0);
  float glowFlat = exp(-length(max(abs(p) - tanFov, 0.0)) * 1.6) * front;
  vec2 a = vec2(atan(d.x, -d.z), asin(clamp(d.y, -1.0, 1.0)));
  vec2 uvRound = clamp(a / span + 0.5, 0.0, 1.0);
  float glowRound = exp(-length(max(abs(a) - span * 0.5, 0.0)) * 2.2);
  vec2 uv = mix(uvFlat, uvRound, wrap);
  float glow = mix(glowFlat, glowRound, wrap);
  vec3 b = texture2D(bleed, uv).rgb;
  gl_FragColor = vec4(b * bleedGain * glow * fade, 1.0);
}
`;

const BLEED_GAIN = 0.55;
const audioFor = new WeakMap();

function unplug(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

function blurCanvas(base, aspect) {
  const c = document.createElement('canvas');
  if (aspect >= 1) {
    c.width = base;
    c.height = Math.max(2, Math.round(base / aspect));
  } else {
    c.height = base;
    c.width = Math.max(2, Math.round(base * aspect));
  }
  return c;
}

export class DepthView {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
    this.scene.add(this.camera);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blank.needsUpdate = true;
    this.uniforms = {
      map: { value: this.blank },
      soft: { value: this.blank },
      bleed: { value: this.blank },
      depthA: { value: this.blank },
      depthB: { value: this.blank },
      blend: { value: 0 },
      res: { value: new THREE.Vector2(2, 2) },
      nScale: { value: 1 },
      nShift: { value: 0 },
      nMed: { value: 0.5 },
      medInv: { value: 1 / 3 },
      slope: { value: 1 },
      strength: { value: 1 },
      size: { value: 1 },
      tanFov: { value: new THREE.Vector2(0.6, 0.6) },
      span: { value: new THREE.Vector2(Math.PI, Math.PI / 2) },
      wrap: { value: 1 },
      fade: { value: 1 },
      bleedGain: { value: BLEED_GAIN },
      edgeFill: { value: 1 },
    };
    this.meshMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: MESH_VERT,
      fragmentShader: MESH_FRAG,
    });
    this.domeMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(150, 48, 24), this.domeMaterial);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    this.dome.visible = false;
    this.world.add(this.dome);
    this.mesh = null;
    this.meta = null;
    this.depth = null;
    this.video = null;
    this.textures = [];
    this.ia = -1;
    this.ib = -1;
    this.lastTime = -1;
    this.aspect = 1;
    this.fade = 1;
    this.fadeTarget = 1;
    this.bleedLevel = 1;
    this.listener = null;
    this.audio = null;
    this.tweak = { strength: 1, size: 1 };
    this.wrapScale = 1;
    this.preview = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0 };
  }

  get hasClip() {
    return !!this.meta;
  }

  depthTexture(w, h) {
    const t = new THREE.DataTexture(new Uint16Array(w * h), w, h, THREE.RedFormat, THREE.HalfFloatType);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.unpackAlignment = 2;
    t.needsUpdate = true;
    return t;
  }

  setClip(meta, depth, video) {
    this.clear();
    this.meta = meta;
    this.depth = depth;
    this.video = video;
    this.times = frameTimes(meta);
    const w = meta.depthW;
    const h = meta.depthH;
    this.plane = w * h;
    this.texA = this.depthTexture(w, h);
    this.texB = this.depthTexture(w, h);
    this.ia = -1;
    this.ib = -1;
    this.lastTime = -1;
    this.painted = false;
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.videoTexture.generateMipmaps = false;
    const aspect = meta.width / meta.height;
    this.bleedCanvas = blurCanvas(28, aspect);
    this.softCanvas = blurCanvas(112, aspect);
    this.bleedContext = this.bleedCanvas.getContext('2d');
    this.softContext = this.softCanvas.getContext('2d');
    this.bleedTexture = canvasTexture(this.bleedCanvas);
    this.softTexture = canvasTexture(this.softCanvas);
    this.textures = [this.texA, this.texB, this.videoTexture, this.bleedTexture, this.softTexture];
    const fov = fovFromAspect(aspect);
    const u = this.uniforms;
    u.map.value = this.videoTexture;
    u.soft.value = this.softTexture;
    u.bleed.value = this.bleedTexture;
    u.depthA.value = this.texA;
    u.depthB.value = this.texB;
    u.res.value.set(w, h);
    u.tanFov.value.set(fov.tanH, fov.tanV);
    const spans = wrapSpans(aspect);
    u.span.value.set(spans.h, spans.v);
    this.wrapScale = wrapScale(aspect);
    u.nScale.value = meta.nScale;
    u.nShift.value = meta.nShift;
    u.nMed.value = meta.nMed;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, w - 1, h - 1), this.meshMaterial);
    this.mesh.frustumCulled = false;
    this.world.add(this.mesh);
    this.dome.visible = true;
    this.setTweak(meta.strength ?? 1, meta.size ?? 1);
    this.attachAudio(video);
    this.fit();
    this.update(true);
  }

  clear() {
    if (this.mesh) {
      this.world.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    for (const t of this.textures) t.dispose();
    this.textures = [];
    const u = this.uniforms;
    u.map.value = this.blank;
    u.soft.value = this.blank;
    u.bleed.value = this.blank;
    u.depthA.value = this.blank;
    u.depthB.value = this.blank;
    this.dome.visible = false;
    if (this.audio) {
      this.world.remove(this.audio);
      this.audio = null;
    }
    this.meta = null;
    this.depth = null;
    this.video = null;
  }

  setWrap(wrap) {
    this.uniforms.wrap.value = wrap;
    if (this.meta) this.setTweak(this.tweak.strength, this.tweak.size);
    this.fit();
  }

  setTweak(strength, size) {
    if (!this.meta) return;
    this.tweak = { strength, size };
    const wrap = this.uniforms.wrap.value;
    const dm = depthModel(this.meta.nMed, strength, size * (1 + ((this.wrapScale || 1) - 1) * wrap));
    const u = this.uniforms;
    u.medInv.value = dm.medInv;
    u.slope.value = dm.slope;
    u.strength.value = strength;
    u.size.value = size;
    this.subject = depthAt(this.meta.nMed, dm);
    if (this.audio) this.audio.position.set(0, 0, -this.subject);
  }

  attachAudio(video) {
    try {
      if (!this.listener) {
        this.listener = new THREE.AudioListener();
        this.camera.add(this.listener);
      }
      let a = audioFor.get(video);
      if (!a) {
        a = new THREE.PositionalAudio(this.listener);
        a.setMediaElementSource(video);
        a.setRefDistance(2.2);
        a.setRolloffFactor(1.1);
        a.setDistanceModel('inverse');
        audioFor.set(video, a);
      }
      this.audio = a;
      this.world.add(a);
      a.position.set(0, 0, -(this.subject || 3));
    } catch {
      this.audio = null;
    }
  }

  release(video) {
    const a = audioFor.get(video);
    if (!a) return;
    unplug(() => a.disconnect());
    unplug(() => a.gain.disconnect());
    if (a.parent) a.parent.remove(a);
    if (this.audio === a) this.audio = null;
    audioFor.delete(video);
  }

  resumeAudio() {
    const ctx = this.listener && this.listener.context;
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  setDepth(tex, i) {
    tex.image.data = this.depth.subarray(i * this.plane, (i + 1) * this.plane);
    tex.needsUpdate = true;
  }

  update(force = false) {
    if (!this.meta || !this.video) return;
    const v = this.video;
    const m = this.meta;
    const u = this.uniforms;
    const { i0, i1, blend } = bracket(this.times, v.currentTime || 0);
    if (i0 !== this.ia) {
      if (i0 === this.ib) {
        const t = this.texA;
        this.texA = this.texB;
        this.texB = t;
        this.ia = this.ib;
        this.ib = -1;
      } else {
        this.setDepth(this.texA, i0);
        this.ia = i0;
      }
      u.depthA.value = this.texA;
      u.depthB.value = this.texB;
    }
    if (i1 !== this.ib) {
      this.setDepth(this.texB, i1);
      this.ib = i1;
    }
    u.blend.value = i1 === i0 ? 0 : blend;
    if (v.readyState >= 2 && (force || v.currentTime !== this.lastTime || !this.painted)) {
      if (v.paused || !this.painted) this.videoTexture.needsUpdate = true;
      this.painted = true;
      this.lastTime = v.currentTime;
      this.paint(this.bleedContext, this.bleedCanvas, 2);
      this.paint(this.softContext, this.softCanvas, 3);
      this.bleedTexture.needsUpdate = true;
      this.softTexture.needsUpdate = true;
    }
  }

  paint(ctx, canvas, blur) {
    try {
      ctx.filter = `blur(${blur}px)`;
      const pad = blur * 2;
      ctx.drawImage(this.video, -pad, -pad, canvas.width + pad * 2, canvas.height + pad * 2);
    } catch {
      return;
    }
  }

  tick(dt) {
    const k = 1 - Math.exp(-dt * 6);
    this.fade += (this.fadeTarget - this.fade) * k;
    this.uniforms.fade.value = this.fade;
    this.uniforms.bleedGain.value = BLEED_GAIN * this.bleedLevel;
  }

  flash() {
    this.fade = 0;
    this.fadeTarget = 1;
  }

  setAspect(aspect) {
    this.aspect = aspect;
    this.fit();
  }

  fit() {
    const t = this.uniforms.tanFov.value;
    const tanHalf = Math.max(t.y, t.x / this.aspect) * 1.12;
    const flatFov = (2 * Math.atan(tanHalf) * 180) / Math.PI;
    this.camera.fov = flatFov + (100 - flatFov) * this.uniforms.wrap.value;
    this.camera.aspect = this.aspect;
    this.camera.near = 0.05;
    this.camera.far = 1000;
    this.camera.updateProjectionMatrix();
  }

  resetWorld() {
    this.world.position.set(0, 0, 0);
    this.world.rotation.set(0, 0, 0);
    this.world.scale.setScalar(1);
    this.fade = 1;
    this.fadeTarget = 1;
    this.bleedLevel = 1;
    this.fit();
  }

  previewDrag(dx, dy) {
    const p = this.preview;
    p.tx = Math.max(-0.3, Math.min(0.3, p.tx - dx * 0.8));
    p.ty = Math.max(-0.2, Math.min(0.2, p.ty + dy * 0.5));
  }

  previewZoom(delta) {
    const p = this.preview;
    p.tz = Math.max(-0.3, Math.min(0.6, p.tz - delta * 0.001));
  }

  previewReset() {
    const p = this.preview;
    p.tx = 0;
    p.ty = 0;
    p.tz = 0;
  }

  updatePreview(dt) {
    const p = this.preview;
    const k = 1 - Math.exp(-dt * 7);
    p.x += (p.tx - p.x) * k;
    p.y += (p.ty - p.y) * k;
    p.z += (p.tz - p.z) * k;
    const subject = this.subject || 3;
    this.camera.position.set(p.x, p.y, -p.z);
    this.camera.lookAt(0, 0, Math.min(-subject, -p.z - 0.6));
  }
}
