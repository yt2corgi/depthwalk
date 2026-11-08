import * as THREE from 'three';
import { fovFromAspect } from './math.js?v=mw8f9zl5';

export const DISTANCE = 2.6;
const GLOW_GAIN = 0.38;

const SCREEN_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SCREEN_FRAG = `
uniform sampler2D map;
uniform float fade;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(map, vUv).rgb * fade, 1.0);
}
`;

const GLOW_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GLOW_FRAG = `
uniform sampler2D bleed;
uniform vec2 tanFov;
uniform float gain;
uniform float fade;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float front = smoothstep(0.02, 0.45, -d.z);
  vec2 p = d.xy / max(-d.z, 0.02);
  vec2 uv = clamp(p / tanFov * 0.5 + 0.5, 0.0, 1.0);
  vec2 q = max(abs(p) - tanFov, 0.0);
  float glow = exp(-length(q) * 2.2) * front;
  gl_FragColor = vec4(texture2D(bleed, uv).rgb * gain * glow * fade, 1.0);
}
`;

const audioFor = new WeakMap();

function unplug(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

export class ScreenView {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
    this.scene.add(this.camera);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blank.needsUpdate = true;
    this.uniforms = {
      map: { value: this.blank },
      bleed: { value: this.blank },
      tanFov: { value: new THREE.Vector2(0.6, 0.6) },
      gain: { value: GLOW_GAIN },
      fade: { value: 1 },
    };
    this.screen = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: SCREEN_VERT, fragmentShader: SCREEN_FRAG }),
    );
    this.screen.position.set(0, 0, -DISTANCE);
    this.screen.visible = false;
    this.world.add(this.screen);
    this.glow = new THREE.Mesh(
      new THREE.SphereGeometry(60, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    this.glow.frustumCulled = false;
    this.glow.renderOrder = -1;
    this.glow.visible = false;
    this.world.add(this.glow);
    this.meta = null;
    this.video = null;
    this.textures = [];
    this.size = 1;
    this.aspect = 1;
    this.clipAspect = 16 / 9;
    this.fade = 1;
    this.fadeTarget = 1;
    this.glowLevel = 1;
    this.lastTime = -1;
    this.painted = false;
    this.listener = null;
    this.audio = null;
  }

  setClip(meta, video) {
    this.clear();
    this.meta = meta;
    this.video = video;
    this.clipAspect = meta.width && meta.height ? meta.width / meta.height : 16 / 9;
    this.lastTime = -1;
    this.painted = false;
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.videoTexture.generateMipmaps = false;
    this.bleedCanvas = document.createElement('canvas');
    if (this.clipAspect >= 1) {
      this.bleedCanvas.width = 28;
      this.bleedCanvas.height = Math.max(2, Math.round(28 / this.clipAspect));
    } else {
      this.bleedCanvas.height = 28;
      this.bleedCanvas.width = Math.max(2, Math.round(28 * this.clipAspect));
    }
    this.bleedContext = this.bleedCanvas.getContext('2d');
    this.bleedTexture = new THREE.CanvasTexture(this.bleedCanvas);
    this.bleedTexture.minFilter = THREE.LinearFilter;
    this.bleedTexture.generateMipmaps = false;
    this.textures = [this.videoTexture, this.bleedTexture];
    this.uniforms.map.value = this.videoTexture;
    this.uniforms.bleed.value = this.bleedTexture;
    this.screen.visible = true;
    this.glow.visible = true;
    this.setSize(meta.size ?? 1);
    this.attachAudio(video);
    this.update(true);
  }

  clear() {
    for (const t of this.textures) t.dispose();
    this.textures = [];
    this.uniforms.map.value = this.blank;
    this.uniforms.bleed.value = this.blank;
    this.screen.visible = false;
    this.glow.visible = false;
    if (this.audio) {
      this.world.remove(this.audio);
      this.audio = null;
    }
    this.meta = null;
    this.video = null;
  }

  setSize(size) {
    this.size = size;
    const f = fovFromAspect(this.clipAspect);
    this.screen.scale.set(2 * DISTANCE * f.tanH * size, 2 * DISTANCE * f.tanV * size, 1);
    this.uniforms.tanFov.value.set(f.tanH * size, f.tanV * size);
    this.fit();
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
        a.setRefDistance(DISTANCE);
        a.setRolloffFactor(0.8);
        a.setDistanceModel('inverse');
        audioFor.set(video, a);
      }
      this.audio = a;
      a.position.set(0, 0, -DISTANCE);
      this.world.add(a);
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

  update(force = false) {
    const v = this.video;
    if (!v || v.readyState < 2) return;
    if (!force && v.currentTime === this.lastTime && this.painted) return;
    if (v.paused || !this.painted) this.videoTexture.needsUpdate = true;
    this.painted = true;
    this.lastTime = v.currentTime;
    try {
      const c = this.bleedCanvas;
      this.bleedContext.filter = 'blur(2px)';
      this.bleedContext.drawImage(v, -4, -4, c.width + 8, c.height + 8);
      this.bleedTexture.needsUpdate = true;
    } catch {
      return;
    }
  }

  tick(dt) {
    this.fade += (this.fadeTarget - this.fade) * (1 - Math.exp(-dt * 6));
    this.uniforms.fade.value = this.fade;
    this.uniforms.gain.value = GLOW_GAIN * this.glowLevel;
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
    const tanHalf = Math.max(t.y, t.x / this.aspect) * 1.18;
    this.camera.fov = (2 * Math.atan(tanHalf) * 180) / Math.PI;
    this.camera.aspect = this.aspect;
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  resetWorld() {
    this.world.position.set(0, 0, 0);
    this.world.rotation.set(0, 0, 0);
    this.world.scale.setScalar(1);
    this.fade = 1;
    this.fadeTarget = 1;
    this.glowLevel = 1;
    this.fit();
  }
}
