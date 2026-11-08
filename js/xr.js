import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { Bar } from './bar.js';

const GROW_SECONDS = 2.6;
const START_SCALE = 0.04;
const START_DISTANCE = 1.1;
const rotation = new THREE.Matrix4();
const forward = new THREE.Vector3();

function ease(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function stick(slot) {
  const gp = slot && slot.source && slot.source.gamepad;
  if (!gp || !gp.axes) return [0, 0];
  const a = gp.axes;
  return a.length >= 4 ? [a[2] || 0, a[3] || 0] : [a[0] || 0, a[1] || 0];
}

export class XRMode {
  static async supported() {
    try {
      return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr'));
    } catch {
      return false;
    }
  }

  constructor(renderer, view, player) {
    this.renderer = renderer;
    this.view = view;
    this.player = player;
    this.session = null;
    this.anchor = null;
    this.grow = 1;
    this.head = new THREE.Vector3(0, 1.6, 0);
    this.headQuat = new THREE.Quaternion();
    this.hands = { left: null, right: null };
    this.slots = [];
    this.dragging = null;
    this.flickArmed = true;
    this.hoverId = null;
    this.raycaster = new THREE.Raycaster();
    this.bar = new Bar();
    view.scene.add(this.bar.mesh);
    view.scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 2.4));
    const factory = new XRControllerModelFactory();
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
      );
      ray.visible = false;
      controller.add(ray);
      view.scene.add(controller, grip);
      const slot = { controller, grip, ray, source: null, prev: [] };
      controller.addEventListener('connected', (e) => {
        slot.source = e.data;
        slot.prev = [];
        if (e.data.handedness === 'left' || e.data.handedness === 'right') this.hands[e.data.handedness] = slot;
      });
      controller.addEventListener('disconnected', () => {
        if (this.hands.left === slot) this.hands.left = null;
        if (this.hands.right === slot) this.hands.right = null;
        slot.source = null;
        slot.prev = [];
      });
      this.slots.push(slot);
    }
  }

  get active() {
    return !!this.session;
  }

  async enter() {
    if (this.session) return;
    const request = navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor'],
    });
    const session = await request;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    await this.renderer.xr.setSession(session);
    this.session = session;
    this.anchor = null;
    this.grow = 0;
    this.view.world.scale.setScalar(START_SCALE);
    this.view.bleedLevel = 0;
    this.view.fade = 0;
    this.view.fadeTarget = 1;
    session.addEventListener('end', () => {
      this.session = null;
      this.anchor = null;
      this.dragging = null;
      this.bar.hide();
      this.bar.tick(1);
      this.view.resetWorld();
      this.player.onExitVR();
    });
  }

  exit() {
    if (this.session) this.session.end().catch(() => {});
  }

  frame(dt, xrFrame) {
    const ref = this.renderer.xr.getReferenceSpace();
    const pose = xrFrame && ref ? xrFrame.getViewerPose(ref) : null;
    if (pose) {
      const p = pose.transform.position;
      const o = pose.transform.orientation;
      this.head.set(p.x, p.y, p.z);
      this.headQuat.set(o.x, o.y, o.z, o.w);
    }
    if (!this.anchor && pose) {
      this.setAnchor();
      this.grow = 0;
      this.player.onEnterVR();
    }
    if (this.anchor) this.place(dt);
    this.input(dt);
    this.bar.draw(this.player.barState(), this.hoverId);
    this.bar.tick(dt);
  }

  setAnchor() {
    forward.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.anchor = { pos: this.head.clone(), yaw: Math.atan2(-forward.x, -forward.z) };
  }

  place(dt) {
    this.grow = Math.min(1, this.grow + dt / GROW_SECONDS);
    const e = ease(this.grow);
    const a = this.anchor;
    const w = this.view.world;
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const ahead = START_DISTANCE * (1 - e);
    w.position.set(a.pos.x + fx * ahead, a.pos.y - 0.12 * (1 - e), a.pos.z + fz * ahead);
    w.rotation.set(0, a.yaw, 0);
    w.scale.setScalar(Math.exp(Math.log(START_SCALE) * (1 - e)));
    this.view.bleedLevel = e * e;
  }

  recenter() {
    this.setAnchor();
    this.grow = 1;
    this.view.flash();
  }

  input(dt) {
    const r = this.hands.right;
    const l = this.hands.left;
    let hit = null;
    if (r && this.bar.mesh.visible) hit = this.hitBar(r);
    this.hoverId = hit && hit.id !== 'panel' ? hit.id : null;
    if (hit) this.bar.show(2500);
    for (const s of this.slots) s.ray.visible = false;
    if (r && this.bar.mesh.visible) r.ray.visible = true;

    this.press(
      r,
      0,
      () => (hit ? this.click(hit) : this.player.togglePlay()),
      () => {
        this.dragging = null;
      },
    );
    if (this.dragging && hit && hit.id === this.dragging) this.slide(hit);
    this.press(l, 0, () => this.player.togglePlay());
    this.press(r, 1, () => this.recenter());
    this.press(l, 1, () => this.recenter());
    this.press(r, 4, () => {
      this.player.cycleSpeed();
      this.showBar();
    });
    this.press(r, 5, () => this.toggleBar());
    this.press(l, 5, () => this.toggleBar());
    this.press(l, 4, () => this.toggleBar());

    const [rx, ry] = stick(r);
    if (Math.abs(rx) > 0.3 && Math.abs(rx) >= Math.abs(ry)) {
      this.player.scrub(rx * Math.abs(rx) * dt * 10);
      this.showBar();
    } else {
      this.player.endScrub();
      if (Math.abs(ry) > 0.3) {
        this.player.nudgeStrength(-ry * dt * 0.9);
        this.showBar();
      }
    }

    const [lx, ly] = stick(l);
    if (this.flickArmed && Math.abs(lx) > 0.75 && Math.abs(lx) > Math.abs(ly)) {
      this.flickArmed = false;
      this.player.step(lx > 0 ? 1 : -1);
      this.showBar();
    }
    if (Math.abs(lx) < 0.3) this.flickArmed = true;
    if (Math.abs(ly) > 0.3 && Math.abs(ly) > Math.abs(lx)) {
      this.player.nudgeSize(-ly * dt * 0.8);
      this.showBar();
    }
  }

  press(slot, index, down, up) {
    const gp = slot && slot.source && slot.source.gamepad;
    if (!gp) return;
    const b = gp.buttons[index];
    const now = !!(b && b.pressed);
    const was = !!slot.prev[index];
    slot.prev[index] = now;
    if (now && !was && down) down();
    else if (!now && was && up) up();
  }

  hitBar(slot) {
    const c = slot.controller;
    c.updateMatrixWorld(true);
    rotation.identity().extractRotation(c.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotation);
    this.bar.mesh.updateMatrixWorld(true);
    const h = this.raycaster.intersectObject(this.bar.mesh, false)[0];
    slot.ray.scale.z = h ? h.distance : 1.2;
    if (!h || !h.uv) return null;
    return this.bar.regionAt(h.uv);
  }

  click(hit) {
    this.bar.show();
    switch (hit.id) {
      case 'play':
        this.player.togglePlay();
        break;
      case 'track':
      case 'depth':
      case 'size':
        this.dragging = hit.id;
        this.slide(hit);
        break;
      case 'last':
        this.player.step(-1);
        break;
      case 'next':
        this.player.step(1);
        break;
      case 'speed':
        this.player.cycleSpeed();
        break;
      case 'exit':
        this.exit();
        break;
      default:
        break;
    }
  }

  slide(hit) {
    if (hit.frac == null) return;
    if (hit.id === 'track') this.player.seekFraction(hit.frac);
    else if (hit.id === 'depth') this.player.setStrength(hit.frac * 2);
    else if (hit.id === 'size') this.player.setSizeSlider(hit.frac * 2 - 1);
  }

  showBar() {
    if (!this.bar.mesh.visible) this.placeBar();
    this.bar.show();
  }

  toggleBar() {
    if (this.bar.visible) this.bar.hide();
    else this.showBar();
  }

  placeBar() {
    const l = this.hands.left;
    const p = new THREE.Vector3();
    if (l) {
      l.grip.updateMatrixWorld(true);
      l.grip.getWorldPosition(p);
    }
    if (l && p.lengthSq() > 0.0001) {
      p.y += 0.16;
      p.lerp(this.head, 0.2);
    } else {
      forward.set(0, 0, -1).applyQuaternion(this.headQuat);
      forward.y = 0;
      forward.normalize();
      p.copy(this.head).addScaledVector(forward, 0.5);
      p.y -= 0.28;
    }
    this.bar.mesh.position.copy(p);
    this.bar.mesh.lookAt(this.head);
    this.bar.mesh.updateMatrixWorld(true);
  }
}
