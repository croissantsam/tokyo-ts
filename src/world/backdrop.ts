// The land around an area: coarse terrain (backdrop.bin, a height grid some tens of kilometres wide) under an
// aerial photo — a coarse one of all of it and a sharper one of the land just beyond the last houses. It is
// what stands on the horizon (Mt Fuji behind Fujinomiya) and has no buildings. High ground carries snow.
import * as THREE from 'three';
import { lampUniforms } from './lamplight.ts';
import { Projection } from '../shared/geo.ts';
import { HeightGrid } from '../shared/terrain.ts';
import { WebGLRenderer } from 'three';

const MAX = 4096;          // photo texture pixels along a side
const SINK = 40;           // metres the backdrop is sunk under the area itself, so the detailed ground covers it
const SNOW_LINE = 2500;    // metres: about where the snow of a winter mountain ends (ragged, lower in the gullies)

interface BackdropManifest {
  backdrop: { file: string; x0: number; z0: number; step: number; w: number; h: number };
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

interface PhotoResult { texture: THREE.CanvasTexture; rect: [number, number, number, number] }

// The photo tiles in `dir` (index.json: { z, x0, x1, y0, y1 }) as one texture, and the rectangle it covers in the
// area's metres: { texture, rect: [x0, z0, width, depth] }, or null without tiles. clip: [x0, z0, width, depth]
// to keep to (the tiles may reach further).
async function photo(dir: string, proj: Projection, renderer: WebGLRenderer, clip?: number[]): Promise<PhotoResult | null> {
  const tiles = await fetch(`${dir}/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!tiles) return null;
  const { z, x0, x1, y0, y1 } = tiles;
  let [ax, az] = proj.project(tileLon(x0, z), tileLat(y0, z)), [bx, bz] = proj.project(tileLon(x1 + 1, z), tileLat(y1 + 1, z));
  if (clip) { ax = Math.max(ax, clip[0]); az = Math.max(az, clip[1]); bx = Math.min(bx, clip[0] + clip[2]); bz = Math.min(bz, clip[1] + clip[3]); }
  const k = Math.min(MAX, renderer.capabilities.maxTextureSize) / Math.max(bx - ax, bz - az);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((bx - ax) * k); canvas.height = Math.round((bz - az) * k);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#2c4a5e'; g.fillRect(0, 0, canvas.width, canvas.height); // (no photo: the sea)
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(fetch(`${dir}/${z}_${x}_${y}.jpg`).then((r) => (r.ok ? r.blob() : null)).then((blob) => blob && createImageBitmap(blob)).then((img) => {
      if (!img) return;
      // (over one tile the Mercator grid is as good as linear in the area's metres)
      const [px, pz] = proj.project(tileLon(x, z), tileLat(y, z)), [qx, qz] = proj.project(tileLon(x + 1, z), tileLat(y + 1, z));
      g.drawImage(img, (px - ax) * k, (pz - az) * k, (qx - px) * k + 0.5, (qz - pz) * k + 0.5);
    }).catch(() => {}));
  }
  await Promise.all(jobs);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { texture, rect: [ax, az, bx - ax, bz - az] };
}

// base: the area's tile directory; photoBase: its backdrop photo tiles; proj: makeProjection() of the area.
export async function loadBackdrop(base: string, photoBase: string, manifest: BackdropManifest, proj: Projection, renderer: WebGLRenderer) {
  const { file, x0, z0, step, w, h } = manifest.backdrop, b = manifest.bounds;
  const heights: Float32Array = new Float32Array(await (await fetch(`${base}/${file}`)).arrayBuffer());
  const rect = [x0, z0, (w - 1) * step, (h - 1) * step];

  // ---- the terrain: every grid cell; under the area itself it lies sunk below the detailed ground (and shows
  // where that has not been loaded yet)
  const pos = new Float32Array(w * h * 3);
  const inside = (x: number, z: number, m: number) => x > b.minX - m && x < b.maxX + m && z > b.minZ - m && z < b.maxZ + m;
  let top = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, x = x0 + i * step, z = z0 + j * step;
    pos.set([x, heights[k] - (inside(x, z, 0) ? SINK : 0), z], k * 3);
    if (heights[k] > heights[top]) top = k;
  }
  const index: number[] = [];
  for (let j = 0; j + 1 < h; j++) for (let i = 0; i + 1 < w; i++) {
    const a = j * w + i, c = a + w;
    index.push(a, c, a + 1, a + 1, c, c + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();

  const [far, near] = await Promise.all([photo(photoBase, proj, renderer, rect), photo(`${photoBase}/near`, proj, renderer)]);
  const material = new THREE.MeshStandardMaterial({ color: far ? 0xffffff : 0x6f7a66, roughness: 1, metalness: 0 });
  const uniforms = {
    uFar: { value: far?.texture ?? null }, uFarRect: { value: new THREE.Vector4(...(far?.rect ?? [0, 0, 1, 1])) }, uFarOn: { value: far ? 1 : 0 },
    uNear: { value: near?.texture ?? far?.texture ?? null }, uNearRect: { value: new THREE.Vector4(...(near?.rect ?? [0, 0, 1, 1])) }, uNearOn: { value: near ? 1 : 0 },
    uPeak: { value: new THREE.Vector2(pos[top * 3], pos[top * 3 + 2]) }, // the highest summit: its snow runs down from there
    uSnowLine: { value: SNOW_LINE },
  };
  material.onBeforeCompile = (shader: any) => {
    lampUniforms(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBack;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBack = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        varying vec3 vBack;
        uniform sampler2D uFar, uNear;
        uniform vec4 uFarRect, uNearRect;
        uniform float uFarOn, uNearOn, uSnowLine;
        uniform vec2 uPeak;
        float backHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float backNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(backHash(i), backHash(i + vec2(1.0, 0.0)), f.x), mix(backHash(i + vec2(0.0, 1.0)), backHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float backFbm(vec2 p) { return 0.5 * backNoise(p) + 0.25 * backNoise(p * 2.03) + 0.125 * backNoise(p * 4.01) + 0.0625 * backNoise(p * 8.1); }`)
      .replace('#include <map_fragment>', /* glsl */ `
        {
          // the photo: the sharp one near the area, the coarse one beyond
          vec2 fu = (vBack.xz - uFarRect.xy) / uFarRect.zw, nu = (vBack.xz - uNearRect.xy) / uNearRect.zw;
          vec3 land = uFarOn > 0.5 ? texture2D(uFar, vec2(fu.x, 1.0 - fu.y)).rgb : vec3(1.0);
          vec2 edge = min(nu, 1.0 - nu);
          float sharp = uNearOn * smoothstep(0.0, 0.06, min(edge.x, edge.y));
          if (sharp > 0.0) land = mix(land, texture2D(uNear, vec2(nu.x, 1.0 - nu.y)).rgb, sharp);
          // snow: above a ragged line, reaching further down in the gullies that run from the summit
          vec2 fromPeak = vBack.xz - uPeak;
          float around = atan(fromPeak.y, fromPeak.x), out_ = length(fromPeak);
          float gully = backFbm(vec2(around * 28.0, out_ * 0.00025)) - 0.47;
          float line = uSnowLine + 520.0 * gully + 260.0 * (backFbm(vBack.xz * 0.0012) - 0.47);
          float snow = smoothstep(line - 90.0, line + 160.0, vBack.y);
          snow *= 0.82 + 0.18 * backNoise(vBack.xz * 0.02);
          diffuseColor.rgb *= mix(land, vec3(0.93, 0.95, 0.98), snow);
        }`);
  };
  material.customProgramCacheKey = () => 'backdrop-v1';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'backdrop';
  mesh.frustumCulled = false;
  return mesh;
}

export interface TowerParams { x: number; z: number; y0: number; H: number; R: number; angle: number }

// Half-width of the tower at a fraction t of its height, as a fraction of the half-width of the foot.
const PROFILE: Array<[number, number]> = [[0, 1], [0.04, 0.86], [0.08, 0.73], [0.12, 0.62], [0.2, 0.46], [0.3, 0.33], [0.4, 0.25], [0.45, 0.22], [0.6, 0.14], [0.75, 0.085], [0.84, 0.06]];
const LEGS = 0.12;               // up to here the four legs stand apart
const MAIN: [number, number] = [0.415, 0.455], TOP: [number, number] = [0.74, 0.765]; // the decks
function profile(t: number): number {
  for (let i = 1; i < PROFILE.length; i++) if (t <= PROFILE[i][0]) {
    const [t0, r0] = PROFILE[i - 1], [t1, r1] = PROFILE[i];
    return r0 + ((r1 - r0) * (t - t0)) / (t1 - t0);
  }
  return PROFILE.at(-1)![1];
}
// international orange and white: orange up to the main deck, then alternating
const paint = (t: number): number[] => (t < 0.415 || (t > 0.455 && t < 0.57) || (t > 0.63 && t < 0.73) || t > 0.84 ? ORANGE : WHITE);

const ORANGE = [0.47, 0.1, 0.036], WHITE = [0.72, 0.72, 0.69], GLASS = [0.05, 0.07, 0.09]; // linear RGB
// Lamps: colours brighter than 1 mark them for the shader, which lights them at night (materials.ts).
const BEACON = [6.0, 0.25, 0.12], BULB = [5.0, 3.3, 1.5];
const FLASHER = [6.0, 0.2, 0.1]; // the aircraft warning lights at the top: they flash (the shader tells them by their colour)

// x, z: the axis; y0: the foot; H: height; R: half the width of the foot; angle: direction of one face's width.
export function buildTower({ x, z, y0, H, R, angle }: TowerParams, quad: (a: number[], b: number[], c: number[], d: number[], n: number[], colour: number[]) => void) {
  const e1 = [Math.cos(angle), Math.sin(angle)], e2 = [-e1[1], e1[0]];
  const P = (u: number, w: number, h: number): number[] => [x + e1[0] * u + e2[0] * w, y0 + h, z + e1[1] * u + e2[1] * w];
  const sub = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a: number[]): number[] => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // a steel member of square section from p to q
  const beam = (p: number[], q: number[], thick: number, colour: number[]) => {
    const d = unit(sub(q, p)), a = unit(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), b = cross(d, a), k = thick / 2;
    const at = (o: number[], sa: number, sb: number) => [o[0] + (a[0] * sa + b[0] * sb) * k, o[1] + (a[1] * sa + b[1] * sb) * k, o[2] + (a[2] * sa + b[2] * sb) * k];
    for (const [n, c1, c2] of [[a, [1, -1], [1, 1]], [b, [1, 1], [-1, 1]], [[-a[0], -a[1], -a[2]], [-1, 1], [-1, -1]], [[-b[0], -b[1], -b[2]], [-1, -1], [1, -1]]] as Array<[number[], number[], number[]]>)
      quad(at(p, c1[0], c1[1]), at(q, c1[0], c1[1]), at(q, c2[0], c2[1]), at(p, c2[0], c2[1]), n, colour);
  };
  // a closed box around the axis: half-width `half`, from h0 to h1
  const box = (h0: number, h1: number, half: number, colour: number[]) => {
    const c = (su: number, sw: number, h: number) => P(su * half, sw * half, h), ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    ring.forEach(([u, w], i) => {
      const [u2, w2] = ring[(i + 1) % 4], n = sub(P((u + u2) / 2, (w + w2) / 2, 0), P(0, 0, 0));
      quad(c(u, w, h0), c(u2, w2, h0), c(u2, w2, h1), c(u, w, h1), unit(n), colour);
    });
    quad(c(-1, -1, h1), c(1, -1, h1), c(1, 1, h1), c(-1, 1, h1), [0, 1, 0], colour);
    quad(c(-1, -1, h0), c(1, -1, h0), c(1, 1, h0), c(-1, 1, h0), [0, -1, 0], colour);
  };

  // A braced column of square section. square(h) -> [u0, w0, u1, w1], its extent at height h. Each side is
  // split into panels of about 9 m; every panel between two levels is cross-braced.
  const panels = (side: number) => Math.max(1, Math.min(6, Math.round(side / 9)));
  const column = (h0: number, h1: number, square: (h: number) => [number, number, number, number], thick: (side: number) => number) => {
    const levels: number[] = [];
    for (let h = h0; h < h1 - 0.5;) {
      levels.push(h);
      const [u0, , u1] = square(h), side = Math.abs(u1 - u0), div = panels(side);
      h += Math.min(Math.max(3.2, (side / div) * 1.05), h1 - h > 4 ? Infinity : h1 - h);
    }
    levels.push(h1);
    const ringAt = (h: number) => {
      const [u0, w0, u1, w1] = square(h), corners: number[][] = [[u0, w0], [u1, w0], [u1, w1], [u0, w1]], side = Math.abs(u1 - u0), div = panels(side), pts: number[][] = [];
      corners.forEach((a, i) => { const b = corners[(i + 1) % 4]; for (let j = 0; j < div; j++) pts.push(P(a[0] + ((b[0] - a[0]) * j) / div, a[1] + ((b[1] - a[1]) * j) / div, h)); });
      return { pts, div, t: thick(side) };
    };
    let below: { pts: number[][]; div: number; t: number; h: number } | null = null;
    for (const h of levels) {
      const ring = ringAt(h), n = ring.pts.length, colour = paint(h / H);
      for (let i = 0; i < n; i++) beam(ring.pts[i], ring.pts[(i + 1) % n], ring.t * 0.6, colour);        // horizontal struts
      if (below && below.pts.length === n) for (let i = 0; i < n; i++) {
        const c = paint((h + below.h) / 2 / H), corner = i % ring.div === 0;
        beam(below.pts[i], ring.pts[i], corner ? ring.t : ring.t * 0.6, c);                                // chords
        beam(below.pts[i], ring.pts[(i + 1) % n], ring.t * 0.45, c);                                       // cross-bracing
        beam(below.pts[(i + 1) % n], ring.pts[i], ring.t * 0.45, c);
      } else if (below) { // the panel count changes here: chords at the corners only
        for (let k = 0; k < 4; k++) beam(below.pts[k * below.div], ring.pts[k * ring.div], ring.t, colour);
      }
      below = { ...ring, h };
    }
  };
  const thick = (side: number) => Math.min(1.5, 0.3 + side * 0.035);

  // ---- the four legs, each a column leaning in; their inner edges meet where the shaft begins
  const hLegs = LEGS * H, r = (h: number) => R * profile(h / H);
  const legSide = (h: number) => { const k = h / hLegs; return R * 0.27 * (1 - k) + r(hLegs) * k; };
  for (const su of [-1, 1]) for (const sw of [-1, 1])
    column(0, hLegs, (h) => { const o = r(h), i = o - legSide(h); return [su > 0 ? i : -o, sw > 0 ? i : -o, su > 0 ? o : -i, sw > 0 ? o : -i]; }, thick);

  // ---- the arches between the legs: a curved chord from leg to leg under the first ring of the shaft
  const archFoot = 0.035 * H, archTop = hLegs * 0.9;
  for (let face = 0; face < 4; face++) {
    const at = (f: number, h: number) => { const u = f * (r(h) - legSide(h)), w = r(h); return face === 0 ? P(u, w, h) : face === 1 ? P(w, -u, h) : face === 2 ? P(-u, -w, h) : P(-w, u, h); };
    const top = (f: number) => { const u = f * r(hLegs) * 0.92, w = r(hLegs); return face === 0 ? P(u, w, hLegs) : face === 1 ? P(w, -u, hLegs) : face === 2 ? P(-u, -w, hLegs) : P(-w, u, hLegs); };
    const N = 12, hOf = (f: number) => archFoot + (archTop - archFoot) * (1 - f * f);
    for (let i = 0; i < N; i++) {
      const f0 = -1 + (2 * i) / N, f1 = -1 + (2 * (i + 1)) / N, a = at(f0, hOf(f0)), b = at(f1, hOf(f1));
      beam(a, b, 0.9, ORANGE);
      if (i > 0) beam(a, top(f0), 0.45, ORANGE);                      // spandrel struts up to the ring
      beam(i % 2 ? a : b, top(i % 2 ? f1 : f0), 0.4, ORANGE);        // and their bracing
    }
  }

  // ---- the shaft, up to the foot of the antenna
  column(hLegs, PROFILE.at(-1)![0] * H, (h) => { const o = r(h); return [-o, -o, o, o]; }, thick);

  // ---- observation decks: white, with a band of glass
  for (const [[t0, t1], half] of [[MAIN, R * 0.36], [TOP, R * 0.15]] as Array<[[number, number], number]>) {
    const h0 = t0 * H, h1 = t1 * H, g0 = h0 + (h1 - h0) * 0.35, g1 = h0 + (h1 - h0) * 0.8;
    box(h0, g0, half, WHITE); box(g0, g1, half * 0.98, GLASS); box(g1, h1, half, WHITE);
    box(h0 - (h1 - h0) * 0.5, h0, half * 0.8, WHITE); // the tapering underside
  }

  // ---- lights: warm bulbs up the four corners, red obstruction beacons at the top and on the decks
  const lamp = (u: number, w: number, h: number, size: number, colour: number[]) => {
    const c = P(u, w, h), k = size / 2, v = (sx: number, sy: number, sz: number) => [c[0] + sx * k, c[1] + sy * k, c[2] + sz * k];
    quad(v(-1, 1, -1), v(1, 1, -1), v(1, 1, 1), v(-1, 1, 1), [0, 1, 0], colour);
    quad(v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1), [0, -1, 0], colour);
    quad(v(-1, -1, -1), v(1, -1, -1), v(1, 1, -1), v(-1, 1, -1), [0, 0, -1], colour);
    quad(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1), [0, 0, 1], colour);
    quad(v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1), [-1, 0, 0], colour);
    quad(v(1, -1, -1), v(1, -1, 1), v(1, 1, 1), v(1, 1, -1), [1, 0, 0], colour);
  };
  // (the bulbs are what lights the tower at night: close together up the corners, and up the middle of each face)
  for (let h = 6; h < 0.84 * H; h += 5.5) for (const su of [-1, 1]) for (const sw of [-1, 1]) lamp(su * (r(h) + 0.5), sw * (r(h) + 0.5), h, 0.9, BULB);
  for (let h = 8.75; h < 0.84 * H; h += 11) for (const [su, sw] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) lamp(su * (r(h) + 0.5), sw * (r(h) + 0.5), h, 0.8, BULB);
  for (const t of [MAIN[1], TOP[1], 0.3, 0.6]) for (const su of [-1, 1]) for (const sw of [-1, 1]) {
    const half = t === MAIN[1] ? R * 0.36 : t === TOP[1] ? R * 0.15 : r(t * H) + 0.8;
    lamp(su * half, sw * half, t * H + 0.8, 1.3, BEACON);
  }
  lamp(0, 0, H + 0.8, 1.6, FLASHER);
  lamp(0, 0, 0.94 * H + 0.5, 1.3, FLASHER);

  // ---- antenna: a drum, then the mast in two steps
  box(0.84 * H, 0.86 * H, R * 0.075, ORANGE);
  box(0.86 * H, 0.94 * H, R * 0.035, ORANGE);
  box(0.94 * H, H, R * 0.016, WHITE);
}
