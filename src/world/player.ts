// @ts-nocheck -- app entry scripts; behavior is unchanged from the JS originals (see tsconfig.json)
// A character the player controls: walks around the city with WASD (the camera's sight line is the
// direction of the walk) and can steal (F) and drive a car. While it drives the stolen car, the camera
// follows the car behind it instead.
//
// The stolen car stays one of the traffic cars: traffic only holds it in the lane's books while it is
// stolen; the player moves it by writing car.pos / car.h, and traffic writes it into its instance slot
// after that (see the stolen branch of update() in traffic.js).
import * as THREE from 'three';
import { MATERIALS, Destructible } from './destruction.ts';

const AVATAR_COLOUR = 0x3a3f4a;
const MAX_WALK = 1.4, MAX_RUN = 3.0; // m/s (shift = run)
const MAX_CAR = 8;                   // m/s while driving (the traffic cars are a bit faster)

export class Player {
  constructor({ scene, traffic, ground, camera, controls, destruction = null }) {
    Object.assign(this, { scene, traffic, ground, camera, controls, destruction });
    this.enabled = false;
    this.pos = new THREE.Vector3();
    this.fwd = new THREE.Vector3();
    this.car = null;         // the car the player drives (a traffic car, marked stolen)
    this.inCar = false;
    this.carH = 0;           // heading of the driven car (radians; the vehicle's local +z is 0)
    this.carV = 0;           // its speed (m/s)
    this._move = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this.ray = new THREE.Raycaster();      // a forward ray for the collisions below
    this._carTmp = new THREE.Vector3();
    this._carDir = new THREE.Vector3();
    // the character: a small humanoid (head, torso, arms and legs)
    const mat = new THREE.MeshStandardMaterial({ color: AVATAR_COLOUR });
    const part = (g) => { const m = new THREE.Mesh(g, mat); m.castShadow = true; return m; };
    const head = part(new THREE.SphereGeometry(0.3, 16, 12));
    const torso = part(new THREE.BoxGeometry(0.42, 1.0, 0.35));
    const legs = [part(new THREE.CylinderGeometry(0.11, 0.11, 0.88, 8)), part(new THREE.CylinderGeometry(0.11, 0.11, 0.88, 8))];
    const arms = [part(new THREE.CylinderGeometry(0.08, 0.08, 0.68, 8)), part(new THREE.CylinderGeometry(0.08, 0.08, 0.68, 8))];
    legs[0].position.set(-0.11, 0.44, 0); legs[1].position.set(0.11, 0.44, 0);
    arms[0].position.set(-0.21, 0.75, 0); arms[1].position.set(0.21, 0.75, 0);
    torso.position.y = 0.55; head.position.y = 0.95;
    const avatar = new THREE.Group();
    avatar.add(head, torso, ...legs, ...arms);
    this.avatar = avatar;
    scene.add(avatar);
  }

  // spawn the character on the ground at a world point; the free camera takes over off
  enable(at) {
    this.pos.copy(at).setY(this.ground(at.x, at.z) + 0.95);
    this.avatar.position.copy(this.pos);
    this.enabled = true;
    this.inCar = false;
    this.carV = 0;
    this.controls.enabled = false;
  }

  // the nearest car within `radius` of the character
  nearestCar(radius = 12) {
    let best = null, bestD = radius;
    const p = new THREE.Vector3();
    for (const car of this.traffic.cars) {
      if (car.stolen || !car.lane || car.lane.hidden) continue;
      this.traffic.carPos(car, p);
      const d = p.distanceTo(this.pos);
      if (d < bestD) { bestD = d; best = car; }
    }
    return best;
  }

  // steal a car: it stays visible where it was; from now on the player moves it by writing it
  steal(car) {
    car.stolen = true;
    this.car = car;
    this.inCar = true;
    this.carV = 0;
    this.traffic.carPos(car, this.pos);
    this.traffic.carDir(car, this.fwd);
    this.carH = Math.atan2(this.fwd.x, this.fwd.z);
    this.pos.y = this.ground(this.pos.x, this.pos.z) + 0.25;
    this.avatar.visible = false;
    const d = new Destructible({
      material: MATERIALS.STEEL, health: 100, // the body is steel — but the frames aren't indestructible forever
      onDestroy: () => this.onCarDestroyed(car),
    });
    car.destructible = d;
    this.destruction?.register(d);
  }

  // the stolen car was destroyed: step out of it
  onCarDestroyed(car) {
    if (this.inCar && this.car === car) this.exit();
  }

  // step back out into the city: the stolen car returns to the traffic (it was held in place)
  exit() {
    if (this.car) {
      this.car.stolen = false;
      if (this.car.lane?.cars) { const i = this.car.lane.cars.indexOf(this.car); if (i >= 0) this.car.lane.cars.splice(i, 1); }
    }
    this.car = null;
    this.inCar = false;
    this.carV = 0;
    this.pos.y = this.ground(this.pos.x, this.pos.z) + 0.95;
    this.avatar.visible = true;
  }

  // ---- collision

  // While walking: the character's move is shortened if a building ahead blocks the way (a raycast) or a car
  // lies ahead and the character moves toward it. Walking damages what it hits (buildings and props).
  walkCollide() {
    const m = this._move;
    if (m.lengthSq() < 1e-9) return;
    this.ray.set(this.pos, m.clone().normalize());
    this.ray.far = m.length() + 0.5;
    for (const h of this.ray.intersectObjects(this.scene.children, true)) {
      const o = h.object;
      if (o.userData.facade) {
        this.destruction?.damageAt(h, { origin: this.pos, position: h.point, amount: 14, damageType: 'impact' });
        m.setLength(Math.max(0, h.distance - 0.3)); // stop a little short of the wall
        return;
      }
      if (this.destruction?.propMeshes.includes(o)) { // parked car, tree, pole...
        this.destruction.damagePropInstance(o, h.instanceId, { origin: this.pos, position: h.point, amount: 8, damageType: 'impact' });
        m.setLength(Math.max(0, h.distance - 0.3));
        return;
      }
    }
    for (const car of this.traffic.cars) {
      if (car === this.car) continue;
      this.traffic.carPos(car, this._carTmp);
      this._carDir.subVectors(this._carTmp, this.pos);
      const d = this._carDir.length();
      if (d < 0.001 || m.dot(this._carDir.normalize()) <= 0) continue; // not moving toward it
      if (d < 2.0) m.setLength(Math.max(0, d - 1.5)); // keep a metre of space from the car's centre
    }
  }

  // While driving the stolen car: brake when a building is ahead of it, when another car is ahead, or when it
  // reaches the end of the road (a lane that ends). Crashes damage the building and the car.
  driveCollide() {
    if (this.carV < 0.5) return;
    this.ray.set(this.pos, this.fwd.clone());
    this.ray.far = this.carV * 0.8 + 3.0;
    for (const h of this.ray.intersectObjects(this.scene.children, true)) {
      const o = h.object;
      if (o.userData.facade) {
        this.carV = 0;
        this.destruction?.damageAt(h, { origin: this.pos, position: h.point, amount: 20, damageType: 'impact' }); // crash damage
      } else if (this.destruction?.propMeshes.includes(o)) {
        this.carV = 0;
        this.destruction.damagePropInstance(o, h.instanceId, { origin: this.pos, position: h.point, amount: 12, damageType: 'impact' });
      } else {
        continue;
      }
      break; // the hit ahead of the car: brake
    }
    for (const car of this.traffic.cars) {
      if (car === this.car) continue;
      this.traffic.carPos(car, this._carTmp);
      this._carDir.subVectors(this._carTmp, this.pos);
      const d = this._carDir.length();
      if (d < 0.001 || this.fwd.dot(this._carDir.normalize()) <= 0.3) continue;
      if (this.carV > 0 && d < this.carV * 0.8 + 1.5) this.carV = 0;
    }
    const lane = this.car?.lane;
    if (lane?.pts && this.pos.distanceTo(lane.pts.at(-1)) < 4.5) this.carV = 0; // at the end of the road
    if (this.car?.destructible?.state === 'destroyed') this.destruction.handleDestroy(this.car.destructible);
  }

  update(dt, keys) {
    if (!this.enabled) return;
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    if (el?.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number')) return; // typing in a panel
    // the direction of the walk: along the camera's sight line (set while driving to the car's direction)
    this.fwd.subVectors(this.controls.target, this.camera.position).setY(0);
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, 1);
    else this.fwd.normalize();
    if (this.inCar) {
      const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      const steer = THREE.MathUtils.clamp((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), -1, 1);
      const speed = THREE.MathUtils.clamp(this.carV / MAX_CAR, 0, 1);
      this.carH += steer * 3 * dt * (0.3 + 0.7 * speed);
      this.fwd.set(Math.sin(this.carH), 0, Math.cos(this.carH));
      const target = f === 0 ? this.carV * 0.85 : f > 0 ? MAX_CAR : -2; // throttle, brake/reverse
      this.carV += THREE.MathUtils.clamp(target - this.carV, -6 * dt, 6 * dt);
      this.driveCollide();
      this.pos.addScaledVector(this.fwd, this.carV * dt);
      this.pos.y = this.ground(this.pos.x, this.pos.z) + 0.25;
      this.car.pos = this.pos; this.car.h = this.carH; // traffic writes the car's instance after this
    } else {
      this._right.crossVectors(this.fwd, THREE.Object3D.DEFAULT_UP).normalize();
      const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? MAX_RUN : MAX_WALK;
      this._move.addScaledVector(this.fwd, f).addScaledVector(this._right, r).setLength(speed * dt);
      this.walkCollide();
      this.pos.add(this._move);
      this.pos.y = this.ground(this.pos.x, this.pos.z) + 0.95;
    }
    if (keys.has('KeyF')) {
      keys.delete('KeyF');
      if (this.inCar) this.exit();
      else { const car = this.nearestCar(); if (car) this.steal(car); }
    }
    if (keys.has('KeyB')) { // blast at the player or car
      keys.delete('KeyB');
      this.destruction?.blast(this.pos, this.destruction.blastRadius, this.destruction.blastAmount);
    }
    this.avatar.position.copy(this.pos);
  }

  // the camera follows: behind the character, or behind the stolen car
  follow() {
    if (!this.enabled) return;
    this.camera.position.copy(this.pos).addScaledVector(this.fwd, -(this.inCar ? 3.2 : 2.6));
    this.camera.position.add(this._v.set(0, this.inCar ? 0.7 : 1.3, 0));
    this.controls.target.copy(this.pos).add(this._v.set(0, 0.5, 0));
  }
}
