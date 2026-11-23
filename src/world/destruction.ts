// Universal destruction system — adapted from destruction.md to this app. Not voxel: the city's
// geometry stands; damage breaks buildings and spawns debris bursts.
//
//   DamageSystem     — material resistance, damage calculation and propagation (doc §4).
//   StructuralSystem — per-building destructibles with health and states (doc §3, §7).
//   DebrisSystem     — fragments with physics, pooling, lifetime (doc §8, §8.2).
//
// Damage events follow the doc's shape (§4.1): { origin, position, radius?, amount, damageType, impulse? }.
// Damage types: 'bullet' | 'explosion' | 'impact' | 'structural'.
import * as THREE from 'three';

// §4.2: material resistances per damage type — the doc's illustrative values (table in §4.2), plus a
// little damage resistance for a car body (structural damage crumples it).
export type DestructionMaterial = { name: string } & { [resistance: string]: number | string };
const materialResist = (material: DestructionMaterial, type: string): number => (material[type] as number | undefined) ?? 0;
export const MATERIALS = {
  GLASS:    { name: 'glass',    bullet: 0.1, explosion: 0.1, impact: 0.1 },
  WOOD:     { name: 'wood',     bullet: 0.4, explosion: 0.3, impact: 0.4 },
  BRICK:    { name: 'brick',    bullet: 0.7, explosion: 0.6, impact: 0.7 },
  CONCRETE: { name: 'concrete', bullet: 0.9, explosion: 0.9, impact: 0.9 },
  STEEL:    { name: 'steel',    bullet: 1.0, explosion: 1.0, impact: 0.6, structural: 0.3 },
};

// §4.2 formula, adapted: resistance per damage type (unlisted types take full damage).
export function calculateDamage(event: { origin: THREE.Vector3; position: THREE.Vector3; radius?: number; amount: number; damageType: string }, material: DestructionMaterial) {
  const r = event.radius ?? 0;
  const d = r > 0 ? Math.min(event.position.distanceTo(event.origin), r) : 0;
  if (r > 0 && d >= r) return 0;
  const falloff = r > 0 ? 1 - d / r : 1; // distance falloff, §4.2
  return event.amount * THREE.MathUtils.clamp(falloff, 0, 1) * (1 - materialResist(material, event.damageType));
}

// §3: a destructible object: health, maxHealth, material, state (intact / damaged / critical / destroyed).
export class Destructible {
  health: number;
  maxHealth: number;
  material: DestructionMaterial;
  state: 'intact' | 'damaged' | 'critical' | 'destroyed';
  mesh: THREE.Mesh | null;
  location: ((out: THREE.Vector3) => THREE.Vector3) | null;
  onDestroy: ((d: Destructible) => void) | null;
  bursted = false; // the destruction burst fired once
  constructor(params: { material?: DestructionMaterial; health?: number; mesh?: THREE.Mesh | null; location?: ((out: THREE.Vector3) => THREE.Vector3) | null; onDestroy?: ((d: Destructible) => void) | null } = {}) {
    const { material = MATERIALS.GLASS, health = 10, mesh = null, location = null, onDestroy = null } = params;
    this.material = material;
    this.health = this.maxHealth = health;
    this.state = 'intact';
    this.mesh = mesh;
    this.location = location;
    this.onDestroy = onDestroy;
  }
  pos(out = new THREE.Vector3()): THREE.Vector3 { // where it stands
    if (this.location) return this.location(out);
    if (this.mesh) return this.mesh.getWorldPosition(out);
    return out;
  }
  receiveDamage(event: { origin: THREE.Vector3; position: THREE.Vector3; radius?: number; amount: number; damageType: string }) { // §10: damage, state transitions
    if (this.state === 'destroyed') return 0;
    const amount = calculateDamage(event, this.material);
    if (amount > 0) {
      this.health = Math.max(0, this.health - amount);
      if (this.health <= 0) this.state = 'destroyed';
      else if (this.health < this.maxHealth * 0.25) this.state = 'critical';
      else if (this.health < this.maxHealth * 0.5) this.state = 'damaged';
    }
    return amount;
  }
  restore() { this.health = this.maxHealth; this.state = 'intact'; } // §3 interface
}

// §8: a debris piece — a fragment of a destroyed object with physics (§8, §8.2).
class DebrisPiece {
  mesh: THREE.Mesh;
  velocity = new THREE.Vector3();
  omega = new THREE.Vector3();
  life = 0;
  maxLife = 0;
  active = false;
  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, transparent: true, opacity: 1 })
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.mesh.visible = false;
  }
}

// §8: debris fragments with gravity, air drag, lifetime, fade-out and rest (sleep, §8.2).
export class DebrisSystem {
  scene: THREE.Scene;
  pieces: DebrisPiece[] = [];
  max: number;
  constructor({ scene, max = 600 }: { scene: THREE.Scene; max?: number }) {
    this.scene = scene;
    this.max = max;
  }
  piece(): DebrisPiece | null {
    for (const p of this.pieces) if (!p.active) return p;
    if (this.pieces.length < this.max) { const p = new DebrisPiece(this.scene); this.pieces.push(p); return p; }
    return null;
  }
  burst(position: THREE.Vector3, color: THREE.Color, count = 8, speed = 4, spread = 2.5) { // §8: emit a burst of fragments
    for (let i = 0; i < count; i++) {
      const p = this.piece();
      if (!p) return;
      p.active = true;
      p.mesh.visible = true;
      p.mesh.position.copy(position);
      p.mesh.rotation.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
      p.mesh.scale.setScalar(0.2 + Math.random() * 0.7);
      const mat = p.mesh.material as THREE.MeshStandardMaterial;
      mat.color.copy(color);
      mat.opacity = 1;
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.7 + 0.2, Math.random() - 0.5).normalize();
      p.velocity.copy(dir).multiplyScalar(speed * (0.5 + Math.random() * 0.8) + spread);
      p.omega.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      p.life = p.maxLife = 1.8 + Math.random() * 1.6;
    }
  }
  update(dt: number) {
    for (const p of this.pieces) {
      if (!p.active) continue;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.velocity.y += -9.8 * dt; // gravity, §8.1
      p.velocity.multiplyScalar(0.95);
      p.mesh.rotation.x += p.omega.x * dt; p.mesh.rotation.y += p.omega.y * dt; p.mesh.rotation.z += p.omega.z * dt;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        p.active = false;
      } else {
        (p.mesh.material as THREE.MeshStandardMaterial).opacity = THREE.MathUtils.clamp(p.life / p.maxLife, 0, 1);
        if (p.mesh.position.y < 0.05) { p.mesh.position.y = 0.05; p.velocity.y = 0; } // rest, §8.2
      }
    }
  }
}

// §4.2-style city materials: PLATEAU usage code (streamer.js / constants.js USAGE) -> destruction material.
export const USAGE_MATERIALS: Record<number, DestructionMaterial> = {
  411: MATERIALS.BRICK, 415: MATERIALS.BRICK, 412: MATERIALS.CONCRETE, 413: MATERIALS.BRICK, 414: MATERIALS.BRICK,
  401: MATERIALS.GLASS, 402: MATERIALS.GLASS, 403: MATERIALS.GLASS, 404: MATERIALS.GLASS,
  421: MATERIALS.STEEL, 422: MATERIALS.STEEL, 423: MATERIALS.STEEL, 424: MATERIALS.STEEL, 425: MATERIALS.STEEL,
  426: MATERIALS.STEEL, 427: MATERIALS.STEEL, 428: MATERIALS.STEEL, 429: MATERIALS.STEEL, 430: MATERIALS.STEEL,
  431: MATERIALS.STEEL, 432: MATERIALS.STEEL, 433: MATERIALS.STEEL, 434: MATERIALS.STEEL, 435: MATERIALS.STEEL,
  436: MATERIALS.STEEL, 437: MATERIALS.STEEL, 438: MATERIALS.STEEL, 439: MATERIALS.STEEL, 440: MATERIALS.STEEL,
  441: MATERIALS.STEEL, 442: MATERIALS.STEEL, 443: MATERIALS.STEEL, 444: MATERIALS.STEEL, 445: MATERIALS.STEEL,
  446: MATERIALS.STEEL, 447: MATERIALS.STEEL, 448: MATERIALS.STEEL, 449: MATERIALS.STEEL, 450: MATERIALS.STEEL,
  451: MATERIALS.STEEL, 452: MATERIALS.STEEL, 453: MATERIALS.STEEL, 454: MATERIALS.STEEL, 461: MATERIALS.BRICK,
};
export const BASE_HEALTH: Record<string, number> = { glass: 30, wood: 60, brick: 100, concrete: 160, steel: 100 }; // illustrative
export const DEBRIS_COLORS: Record<string, number> = { glass: 0x7ea2cc, wood: 0x9a6d45, brick: 0xb87333, concrete: 0x888888, steel: 0x9aa4ad };
// Whether the object has been destroyed. (State changes made by receiveDamage() are not visible to
// TypeScript's control flow, so the check goes through this helper.)
const destroyed = (d: Destructible): boolean => d.state === 'destroyed';

// Facade material patched so vertices flagged in `aDestroyed` are not rasterised (a destroyed
// building disappears while the city mesh stands). Must be applied before first compile.
export function patchDestructibleMaterial(material: THREE.Material) {
  const mat = material as THREE.Material & { userData: Record<string, any> };
  if (mat.userData.__destructiblePatched) return;
  mat.userData.__destructiblePatched = true;
  const previous = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    previous?.call(mat, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aDestroyed;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (aDestroyed > 0.5) transformed = vec3(0.0, -9999.0, 0.0);');
  };
  mat.customProgramCacheKey = () => 'tokyo-destructible';
  mat.needsUpdate = true;
}

// §2, §10: the central destruction coordinator for the city.
export class DestructionManager {
  scene: THREE.Scene;
  destructibles: Destructible[] = [];       // every building's Destructible (for blast radius queries)
  propMeshes: THREE.InstancedMesh[] = [];   // instanced prop meshes (trees, poles, parked cars...): damage by instance
  debris: DebrisSystem;
  blastRadius = 120;        // tuned through the panel
  blastAmount = 60;

  register(destructible: Destructible) { this.destructibles.push(destructible); }

  // Props (vending machines, poles, signals, lamps, trees, parked cars) are drawn as city-wide
  // InstancedMeshes. Each instance gets its own Destructible; when it breaks, the instance is
  // collapsed to a zero-scale matrix so it vanishes from the city mesh.
  propIndex = new Map<THREE.InstancedMesh, Array<{ index: number; d: Destructible; matrix: THREE.Matrix4 }>>();
  registerPropMesh(mesh: THREE.InstancedMesh) {
    if (this.propIndex.has(mesh)) return;
    const list: Array<{ index: number; d: Destructible; matrix: THREE.Matrix4 }> = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      if (m.elements[0] === 0 && m.elements[5] === 0 && m.elements[10] === 0) continue; // already hidden
      const d = new Destructible({ material: MATERIALS.CONCRETE, health: 40 });
      d.mesh = mesh as unknown as THREE.Mesh;
      d.location = (out: THREE.Vector3) => out.setFromMatrixPosition(m);
      this.destructibles.push(d);
      list.push({ index: i, d, matrix: m.clone() });
    }
    this.propIndex.set(mesh, list);
    if (!this.propMeshes.includes(mesh)) this.propMeshes.push(mesh);
  }

  // A bullet / crash hit on an instanced prop: resolve the instance and damage it.
  damagePropInstance(mesh: THREE.Object3D, instanceId: number | undefined, event: { origin: THREE.Vector3; position: THREE.Vector3; radius?: number; amount: number; damageType: string }) {
    if (instanceId == null) return;
    const list = this.propIndex.get(mesh as THREE.InstancedMesh);
    const entry = list?.find((e) => e.index === instanceId);
    if (!entry || destroyed(entry.d)) return;
    entry.d.receiveDamage(event);
    if (destroyed(entry.d)) this.handleDestroy(entry.d);
  }

  constructor({ scene }: { scene: THREE.Scene }) {
    this.scene = scene;
    this.debris = new DebrisSystem({ scene });
  }

  // §2: called by the Streamer as each tile's building mesh arrives: one destructible per building.
  onFacade(mesh: THREE.Mesh) {
    const user = mesh.userData ?? {};
    if (!user.info || user.destr) return;
    user.destr = user.info.map((usage: number) => {
      const d = new Destructible({ material: USAGE_MATERIALS[usage] ?? MATERIALS.BRICK, health: BASE_HEALTH[USAGE_MATERIALS[usage]?.name ?? 'brick'] ?? BASE_HEALTH.brick });
      d.mesh = mesh;
      this.destructibles.push(d);
      return d;
    });
  }
  destructibleAt(hit: THREE.Intersection) { // §3: the destructible of the building a picking raycast hit
    const mesh = hit.object, user = mesh.userData ?? {};
    if (!user.info || !user.ends || !hit.face) return null;
    const v = hit.face.a;
    let lo = 0, hi = user.ends.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (user.ends[mid] > v) hi = mid; else lo = mid + 1; }
    if (user.destr?.[lo]) return user.destr[lo];
    const material = USAGE_MATERIALS[user.info[lo][0]] ?? MATERIALS.BRICK;
    const d = new Destructible({ material, health: BASE_HEALTH[material.name] ?? BASE_HEALTH.brick });
    d.mesh = mesh as unknown as THREE.Mesh;
    user.destr ??= [];
    user.destr[lo] = d;
    this.destructibles.push(d);
    return d;
  }
  // §4.2 + §4.3: damage a building hit by a raycast; debris on destruction; propagation to neighbours.
  damageAt(hit: THREE.Intersection, event: { origin: THREE.Vector3; position: THREE.Vector3; radius?: number; amount: number; damageType: string }) {
    const d = this.destructibleAt(hit);
    if (!d) return null;
    d.receiveDamage(event);
    if (destroyed(d)) this.handleDestroy(d);
    return d;
  }
  propagate(event: { origin: THREE.Vector3; position: THREE.Vector3; radius?: number; amount: number; damageType: string }, position: THREE.Vector3, depth = 1) { // §4.3: secondary damage to nearby connected components
    if (depth > 2 || !event.radius) return;
    const q = { origin: position, position, radius: event.radius * 0.6, amount: event.amount * 0.5, damageType: event.damageType };
    const at = new THREE.Vector3();
    for (const d of this.destructibles) {
      if (destroyed(d)) continue;
      d.pos(at);
      if (at.distanceTo(position) > q.radius) continue;
      d.receiveDamage(q);
      if (destroyed(d)) this.propagate(q, at, depth + 1);
    }
  }
  // §10: destroy, firing the burst once, hiding the thing and calling the owner's onDestroy.
  handleDestroy(d: Destructible) {
    if (d.bursted) return;
    d.bursted = true;
    const at = d.pos();
    // a building: hide its triangles in the facade mesh
    const mesh = d.mesh as THREE.Mesh | null;
    const user = mesh?.userData;
    if (mesh && user?.facade && user.destr) {
      const i = (user.destr as unknown[]).indexOf(d as unknown);
      if (i >= 0 && user.ends) {
        const start = i === 0 ? 0 : (user.ends[i - 1] as number);
        const end = Math.min(user.ends[i] as number, (user.info as unknown[]).length ? Infinity : Infinity);
        const pos = mesh.geometry.getAttribute('position');
        if (pos && !mesh.geometry.getAttribute('aDestroyed')) {
          mesh.geometry.setAttribute('aDestroyed', new THREE.BufferAttribute(new Float32Array(pos.count), 1));
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) patchDestructibleMaterial(m as THREE.Material);
        }
        const attr = mesh.geometry.getAttribute('aDestroyed') as THREE.BufferAttribute | undefined;
        if (attr) { for (let v = start; v < Math.min(end, attr.count); v++) attr.setX(v, 1); attr.needsUpdate = true; }
      }
    }
    // an instanced prop: collapse its matrix to nothing
    for (const [inst, list] of this.propIndex) {
      const entry = list.find((e) => e.d === d);
      if (!entry) continue;
      const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
      hidden.setPosition(entry.matrix.elements[12], entry.matrix.elements[13], entry.matrix.elements[14]);
      inst.setMatrixAt(entry.index, hidden);
      inst.instanceMatrix.needsUpdate = true;
      break;
    }
    if (at) this.debris.burst(at, new THREE.Color(DEBRIS_COLORS[d.material.name] ?? 0x888888), 10, 5, 3);
    d.onDestroy?.(d);
  }
  // §10: an explosion: damage every destructible within the radius and emit debris bursts.
  blast(position: THREE.Vector3, radius = this.blastRadius, amount = this.blastAmount, damageType = 'explosion') {
    const event = { origin: position, position, radius, amount, damageType };
    const at = new THREE.Vector3();
    for (const d of this.destructibles) {
      if (destroyed(d)) continue;
      d.pos(at);
      if (at.distanceTo(position) > radius) continue;
      d.receiveDamage(event);
      if (destroyed(d)) this.propagate(event, at, 1);
    }
  }
  damageNear(position: THREE.Vector3, radius: number, event: { origin: THREE.Vector3; position: THREE.Vector3; radius?: number; amount: number; damageType: string }) { // §4.3: damage every destructible within a radius
    const at = new THREE.Vector3();
    for (const d of this.destructibles) {
      if (destroyed(d)) continue;
      d.pos(at);
      if (at.distanceTo(position) > radius) continue;
      d.receiveDamage(event);
      if (destroyed(d)) this.propagate(event, at, 1);
    }
  }
  update(dt: number) { this.debris.update(dt); } // debris is the only moving part of the destruction system here
}
