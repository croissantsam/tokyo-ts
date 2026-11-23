# Universal Destruction System
## Implementation Guide for Any Game Engine

> **Status: implemented in this repo (adapted).** The system below is built as
> `src/world/destruction.js` (DamageSystem, StructuralSystem, DebrisSystem — destruction.md §2, §3, §4,
> §8, §10) and adapted to the Procedural Tokyo Three.js city rather than to a game engine:
> damage breaks structures and spawns debris bursts, instead of physics fragments of destructible
> components. Destructibles: buildings (facade meshes, per-building health), cars (all traffic cars,
> parked cars, the stolen car), trees and props (utility poles, street lights, signal heads, vending
> machines, benches...). Damage triggers: crashes of the stolen car into buildings and props
> (`src/world/player.js` `driveCollide`/`walkCollide`), and blasts — **`B` key while walking or
> driving**, or the *Blast* button in the Settings panel (radius/amount sliders). See the phase roadmap
> in §16 as the general architecture; the city adaptation covers phases 1–3 (damage, states, debris).

**Goal:** Build a reusable, modular, scalable destruction system inspired by Battlefield's Frostbite destruction technology.

The system must support destructible environments, buildings, walls, props, structural collapse, realistic debris physics, persistent damage, and multiplayer synchronization.

The implementation must remain engine-independent at the architecture level, allowing adaptation to Three.js, Unity, Unreal Engine, Godot, or custom game engines.

---

# 1. Core Philosophy

Do not implement destruction as a collection of isolated explosion animations.

Build a centralized destruction framework where every destructible object follows a common lifecycle.

The system should support three primary destruction approaches:

1. **Component-based destruction:** Objects are composed of independently destructible components.
2. **Pre-fractured destruction:** Objects contain predefined fragments that become physical when damaged.
3. **Procedural destruction:** Geometry is dynamically fractured when an object receives damage.

These approaches should coexist. The system must select the appropriate destruction method based on object complexity, importance, and performance requirements.

The architecture should separate:

- Damage calculation.
- Structural integrity.
- Geometry manipulation.
- Physics simulation.
- Visual effects.
- Network replication.
- Persistence.

# 2. System Architecture

Create a centralized `DestructionManager` responsible for coordinating destruction across the game.

Recommended architecture:

```text
DestructionManager
│
├── DamageSystem
│   ├── DamageCalculation
│   ├── MaterialResistance
│   ├── DamagePropagation
│   └── DamageFalloff
│
├── StructuralSystem
│   ├── ComponentDependencies
│   ├── StructuralIntegrity
│   ├── SupportDetection
│   └── CollapseCalculation
│
├── GeometrySystem
│   ├── PreFracturedGeometry
│   ├── ProceduralFracture
│   ├── MeshReplacement
│   └── GeometryOptimization
│
├── PhysicsSystem
│   ├── FragmentActivation
│   ├── RigidBodyManagement
│   ├── CollisionDetection
│   └── DebrisLifetime
│
├── EffectsSystem
│   ├── Dust
│   ├── Smoke
│   ├── Sparks
│   └── ImpactEffects
│
├── NetworkSystem
│   ├── DestructionEvents
│   ├── StateReplication
│   └── EventReconciliation
│
└── PersistenceSystem
    ├── DamageSnapshots
    ├── WorldState
    └── StateRestoration
```

Every subsystem should have a clear responsibility and communicate through well-defined interfaces.

# 3. Destructible Object Model

Every destructible object must implement a common interface.

Example:

```typescript
interface Destructible {
  id: string;

  health: number;
  maxHealth: number;

  material: DestructionMaterial;

  state: DestructionState;

  receiveDamage(event: DamageEvent): void;

  destroy(): void;

  restore(): void;

  serialize(): DestructionSnapshot;
}

type DestructionState =
  | "intact"
  | "damaged"
  | "critical"
  | "destroyed";
```

A destructible object should contain multiple components whenever appropriate.

Example: A building.

```text
Building
│
├── Foundation
├── StructuralFrame
│   ├── Pillar_01
│   ├── Pillar_02
│   └── Pillar_03
│
├── Floors
│   ├── Floor_01
│   └── Floor_02
│
├── Walls
│   ├── Wall_01
│   ├── Wall_02
│   └── Wall_03
│
├── Windows
└── Roof
```

Each component has independent health, material properties, structural dependencies, and destruction behavior.

Do not treat an entire building as a single destructible mesh.

# 4. Damage System

The DamageSystem calculates how much damage an object receives.

Every damage event must contain:

```typescript
interface DamageEvent {
  sourceId?: string;

  position: Vector3;
  direction: Vector3;

  radius?: number;

  amount: number;

  damageType:
    | "bullet"
    | "explosion"
    | "impact"
    | "fire"
    | "structural";

  impulse?: number;
}
```

## 4.1 Material Resistance

Different materials must react differently to damage.

Example material configuration:

```typescript
interface DestructionMaterial {
  name: string;

  bulletResistance: number;
  explosionResistance: number;
  impactResistance: number;

  fractureThreshold: number;

  mass: number;
}
```

Example materials:

| Material | Bullet Resistance | Explosion Resistance |
|---|---:|---:|
| Glass | 0.1 | 0.1 |
| Wood | 0.4 | 0.3 |
| Brick | 0.7 | 0.6 |
| Concrete | 0.9 | 0.9 |
| Steel | 1.0 | 1.0 |

These are illustrative values, not physical constants.

## 4.2 Damage Calculation

Damage must account for:

- Distance from impact.
- Explosion radius.
- Material resistance.
- Impact direction.
- Damage type.
- Optional shielding and occlusion.

Example:

```typescript
function calculateDamage(
  baseDamage: number,
  distance: number,
  radius: number,
  resistance: number
): number {
  if (distance >= radius) return 0;

  const falloff = 1 - distance / radius;

  return baseDamage * falloff * (1 - resistance);
}
```

Use different falloff curves for different weapons and damage types.

## 4.3 Damage Propagation

Damage should propagate to neighboring components when appropriate.

For example:

- An explosion damages a wall.
- The wall loses structural integrity.
- Nearby connected components receive secondary damage.
- Weak connections may break.
- Unsupported elements become unstable.

Avoid unlimited recursive propagation. Use bounded propagation depth and prevent duplicate processing within a single event.

# 5. Pre-Fractured Geometry

This is one of the most important parts of the system.

Instead of generating every fragment at runtime, prepare destructible geometry before the game starts.

A destructible wall can have:

```text
Wall
│
├── IntactMesh
│
├── DamagedMesh
│
├── FractureFragments
│   ├── Fragment_01
│   ├── Fragment_02
│   ├── Fragment_03
│   └── ...
│
└── CollisionGeometry
```

When the wall reaches its fracture threshold:

1. Hide or remove the intact mesh.
2. Activate the appropriate fragments.
3. Assign physics bodies.
4. Apply directional impulses.
5. Generate impact effects.
6. Update the structural graph.

The fragments should inherit the original object's world transform.

Do not activate every fragment simultaneously if only a small section was damaged.

Use localized fracture groups.

## 5.1 Fragment Generation

Support two methods:

**Offline fracture:**

Generate fragments in an editor or asset pipeline.

Advantages:
- Predictable geometry.
- Lower runtime CPU usage.
- Easier collision optimization.
- Better multiplayer consistency.

**Runtime fracture:**

Generate fragments dynamically using a geometry-fracture algorithm.

Advantages:
- More varied destruction.
- Less predefined content.
- Flexible damage locations.

Use offline fracture by default and runtime fracture selectively.

# 6. Procedural Fracture

When runtime fracture is required, implement a geometry-processing pipeline.

Recommended approach:

1. Identify the impact point.
2. Generate fracture sites around the impact.
3. Construct fragment regions using a Voronoi partition or another suitable fracture algorithm.
4. Clip the original geometry against the resulting regions.
5. Generate closed fragment meshes.
6. Recalculate normals and collision geometry.
7. Activate the resulting rigid bodies.

For a wall, the fracture algorithm should respect its thickness.

Avoid generating thousands of fragments from a single impact.

Implement maximum fragment counts, minimum fragment sizes, and computational budgets.

# 7. Structural Integrity System

Structural destruction must be more than simply reducing health.

Buildings need structural relationships.

Represent structural components as a dependency graph.

Example:

```text
Foundation
    │
    ├── Pillar A
    │     ├── Floor A
    │     └── Roof A
    │
    └── Pillar B
          ├── Floor B
          └── Roof B
```

Each component tracks:

- Structural strength.
- Current damage.
- Connected components.
- Supported weight.
- Stability.

When a supporting component is destroyed:

1. Identify dependent components.
2. Recalculate structural support.
3. Determine which components become unstable.
4. Trigger collapse if stability falls below the required threshold.
5. Activate physics for affected components.

For complex buildings, use an approximate structural model instead of a full engineering simulation.

A graph-based support system is usually sufficient for gameplay.

# 8. Physics and Debris Management

Destroyed fragments become physical objects.

Each fragment should support:

- Mass.
- Gravity.
- Collision.
- Friction.
- Restitution.
- Linear velocity.
- Angular velocity.
- Explosion impulses.

Example:

```typescript
interface DestructionFragment {
  id: string;

  position: Vector3;

  mass: number;

  linearVelocity: Vector3;
  angularVelocity: Vector3;

  collisionEnabled: boolean;

  lifetime: number;
}
```

## 8.1 Explosion Impulses

Apply an impulse based on the explosion origin.

```typescript
function calculateExplosionImpulse(
  fragmentPosition: Vector3,
  explosionPosition: Vector3,
  force: number,
  radius: number
): Vector3 {
  const direction = fragmentPosition
    .clone()
    .sub(explosionPosition);

  const distance = direction.length();

  if (distance >= radius) {
    return new Vector3(0, 0, 0);
  }

  const falloff = 1 - distance / radius;

  return direction.normalize().multiplyScalar(
    force * falloff
  );
}
```

Add slight variation to fragment velocities for visual realism.

## 8.2 Debris Optimization

Never simulate every debris fragment indefinitely.

Implement:

- Sleep states for stationary fragments.
- Distance-based physics deactivation.
- Fragment pooling.
- Maximum active rigid-body limits.
- Simplified collision meshes.
- Debris lifetime management.
- Instanced rendering where possible.

When a fragment becomes inactive, preserve its visual representation if necessary without keeping its physics simulation active.

# 9. Terrain Destruction

Terrain destruction should be handled independently from building destruction.

Support two possible implementations.

## 9.1 Heightfield Terrain

For terrain represented by a heightmap:

- Modify terrain heights.
- Rebuild affected terrain sections.
- Update collision geometry.
- Generate displaced dirt and debris.

This approach is efficient for craters and terrain deformation.

However, it cannot represent caves, tunnels, or arbitrary overhangs.

## 9.2 Voxel Terrain

For fully volumetric destruction:

- Divide the world into voxel chunks.
- Store material and density information.
- Modify voxels around the impact.
- Rebuild affected chunk meshes.
- Update collision data.
- Generate debris from removed material.

Use greedy meshing, surface nets, or marching cubes depending on the desired visual quality.

Implement chunk-based updates instead of rebuilding the entire world.

For large worlds, load and unload voxel chunks according to player proximity.

# 10. Destruction Lifecycle

Every destruction event should follow a predictable lifecycle.

```text
DAMAGE RECEIVED
      │
      ▼
CALCULATE DAMAGE
      │
      ▼
UPDATE COMPONENT HEALTH
      │
      ▼
CHECK FRACTURE THRESHOLD
      │
      ▼
CHECK STRUCTURAL DEPENDENCIES
      │
      ▼
ACTIVATE FRACTURE
      │
      ▼
ENABLE PHYSICS
      │
      ▼
GENERATE VISUAL EFFECTS
      │
      ▼
REPLICATE DESTRUCTION STATE
      │
      ▼
PERSIST WORLD CHANGES
```

Keep visual effects separate from authoritative destruction state.

A client should be able to recreate the visual effects from a destruction event without independently deciding whether the object was destroyed.

# 11. Multiplayer Synchronization

Multiplayer destruction requires a deterministic and authoritative approach.

The server should own the authoritative destruction state.

Clients should never independently decide the final state of important destructible objects.

## 11.1 Network Events

Use compact destruction events.

Example:

```typescript
interface DestructionNetworkEvent {
  eventId: string;

  objectId: string;

  componentId: string;

  eventType:
    | "damage"
    | "fracture"
    | "collapse";

  position: Vector3;

  damage: number;

  timestamp: number;

  revision: number;
}
```

The server processes damage and broadcasts confirmed state changes.

Clients receive events and update their local representation.

## 11.2 What Should Be Synchronized?

Do not synchronize every fragment's physics state continuously.

Prioritize:

**High priority:**
- Destruction of important structural components.
- Building collapse.
- Destruction of gameplay-critical objects.
- Changes affecting collision and player movement.

**Medium priority:**
- Major debris activation.
- Significant structural damage.
- Large environmental changes.

**Low priority:**
- Small debris.
- Dust particles.
- Sparks.
- Cosmetic fragments.

Small visual effects should generally be generated locally.

## 11.3 Deterministic Fracture

For predefined fracture assets, all clients should use the same fragment definitions.

Use stable fragment identifiers and event seeds.

This makes it possible for every client to activate the same fragments without transmitting every mesh.

However, do not assume that physics simulation will remain perfectly deterministic across different hardware.

For important gameplay interactions, the server must remain authoritative.

## 11.4 Late-Joining Players

A newly connected player must receive the current destruction state.

Do not replay the entire history of destruction events.

Instead, provide a world-state snapshot containing:

- Destroyed objects.
- Damaged components.
- Structural states.
- Persistent terrain modifications.
- Important debris states.

# 12. Persistence

Destruction should survive player disconnections and world reloads when the game requires persistent environments.

Store state changes rather than entire copies of every object.

Example:

```typescript
interface DestructionSnapshot {
  objectId: string;

  destroyedComponents: string[];

  damagedComponents: Record<string, number>;

  revision: number;
}
```

For large worlds:

- Store changes per world region.
- Use incremental snapshots.
- Batch writes.
- Compress persistent state.
- Avoid saving cosmetic debris.
- Restore only relevant regions.

Use a configurable persistence policy.

Some environments may reset after a match, while others should remain permanently modified.

# 13. Performance and Scalability

The destruction system must be designed around strict performance budgets.

## 13.1 Level of Detail

Use different destruction fidelity depending on distance.

| Distance | Destruction Fidelity |
|---|---|
| Close | Full component destruction and physics |
| Medium | Simplified fragments and collisions |
| Far | Static damaged geometry |
| Very far | State-only representation |

These distances should be configurable.

## 13.2 Object Pooling

Reuse:

- Debris objects.
- Physics bodies.
- Particle systems.
- Temporary geometries.
- Collision objects.

Avoid creating and destroying large numbers of objects during explosions.

## 13.3 Asynchronous Processing

Expensive geometry operations should run outside the main rendering loop whenever possible.

Use:

- Worker threads.
- Web Workers.
- Background jobs.
- Asynchronous geometry generation.
- Deferred collision rebuilding.

Never block rendering while generating a large fracture.

## 13.4 Spatial Partitioning

Use a spatial index to find nearby destructible objects.

Possible implementations:

- Spatial hash.
- Octree.
- BVH.
- Grid-based partitioning.

An explosion should only query objects within its effective radius.

Never iterate through every destructible object in the entire world for each damage event.

# 14. Engine Integration

The architecture must not depend directly on a specific game engine.

Define adapters for:

```typescript
interface PhysicsAdapter {
  createRigidBody(config: unknown): unknown;

  applyImpulse(
    body: unknown,
    impulse: Vector3
  ): void;

  removeRigidBody(body: unknown): void;
}

interface GeometryAdapter {
  activateFragment(id: string): void;

  hideOriginalMesh(id: string): void;

  generateFracture(
    objectId: string,
    position: Vector3
  ): Promise<unknown>;
}

interface NetworkAdapter {
  broadcast(event: DestructionNetworkEvent): void;

  requestSnapshot(regionId: string): Promise<unknown>;
}
```

The destruction framework should operate against these interfaces rather than importing engine-specific classes.

Possible integrations:

| Engine | Rendering | Physics |
|---|---|---|
| Three.js | Mesh / BufferGeometry | Rapier |
| Unity | GameObjects / Meshes | PhysX |
| Unreal | Static Mesh Components | Chaos |
| Godot | MeshInstance3D | Godot Physics |

Implement engine-specific adapters separately.

# 15. Suggested Project Structure

```text
destruction/
│
├── core/
│   ├── DestructionManager.ts
│   ├── Destructible.ts
│   ├── DestructionState.ts
│   └── DestructionConfig.ts
│
├── damage/
│   ├── DamageSystem.ts
│   ├── DamageCalculator.ts
│   ├── MaterialRegistry.ts
│   └── DamagePropagation.ts
│
├── structural/
│   ├── StructuralGraph.ts
│   ├── StructuralComponent.ts
│   └── CollapseSystem.ts
│
├── geometry/
│   ├── FractureSystem.ts
│   ├── PreFracturedGeometry.ts
│   ├── ProceduralFracture.ts
│   └── MeshReplacement.ts
│
├── physics/
│   ├── FragmentManager.ts
│   ├── DebrisManager.ts
│   └── PhysicsAdapter.ts
│
├── effects/
│   ├── DestructionEffects.ts
│   └── ParticleManager.ts
│
├── networking/
│   ├── DestructionReplicator.ts
│   ├── DestructionEvents.ts
│   └── StateReconciliation.ts
│
├── persistence/
│   ├── DestructionSerializer.ts
│   └── WorldStateManager.ts
│
└── adapters/
    ├── GeometryAdapter.ts
    ├── PhysicsAdapter.ts
    └── NetworkAdapter.ts
```

# 16. Implementation Roadmap

Implement the system incrementally.

## Phase 1 — Basic Destruction

- Create the DestructionManager.
- Implement the Destructible interface.
- Implement material resistance.
- Implement damage calculation.
- Support basic object destruction.

**Expected result:** Objects can receive damage and transition between destruction states.

## Phase 2 — Component-Based Destruction

- Support multiple components per object.
- Implement independent component health.
- Implement component dependencies.
- Implement localized mesh replacement.

**Expected result:** Walls, doors, windows, and other building components can be destroyed independently.

## Phase 3 — Pre-Fractured Geometry

- Implement fragment definitions.
- Activate fragments when thresholds are reached.
- Add rigid-body physics.
- Apply explosion impulses.
- Implement fragment pooling.

**Expected result:** Destroyed objects produce physically simulated debris.

## Phase 4 — Structural Collapse

- Implement structural dependency graphs.
- Detect unsupported components.
- Calculate approximate structural stability.
- Trigger cascading collapse.

**Expected result:** Destroying supporting structures can cause larger building collapses.

## Phase 5 — Procedural Fracture

- Implement runtime fracture generation.
- Support localized fracture.
