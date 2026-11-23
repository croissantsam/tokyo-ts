// Fetches, decodes and meshes tiles off the main thread.
import { decodeTile, DecodedTile } from '../shared/tileformat.ts';
import { buildTile } from './meshing.ts';
import { makeSurface } from '../shared/decks.ts';
import { HeightGrid } from '../shared/terrain.ts';
import { Deck } from '../shared/decks.ts';

let grid: HeightGrid | null = null, surface: ReturnType<typeof makeSurface> | null = null, marks: number[][] = [];

// All typed arrays in a result, so they are transferred rather than copied.
function buffers(o: unknown, out: ArrayBuffer[] = []): ArrayBuffer[] {
  for (const v of Object.values(o as object)) {
    if (ArrayBuffer.isView(v)) { const b = v.buffer as ArrayBuffer; if (!out.includes(b)) out.push(b); }
    else if (v && typeof v === 'object') buffers(v, out);
  }
  return out;
}

// Static mesh of a tile (PLATEAU models; format: encodeMesh in tools/pipeline/meshes.mjs) -> flat-shaded arrays.
async function models(url: string): Promise<{ position: Float32Array; normal: Float32Array; color: Float32Array } | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = (await res.arrayBuffer()) as ArrayBuffer, n = new DataView(buf).getUint32(0, true);
  const position = new Float32Array(buf.slice(4, 4 + n * 12) as ArrayBuffer), rgb = new Uint8Array(buf, 4 + n * 12, n * 3);
  const normal = new Float32Array(n * 3), color = new Float32Array(n * 3);
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  for (let i = 0; i < n * 3; i++) color[i] = lin(rgb[i] / 255);
  for (let i = 0; i < n * 3; i += 9) {
    const ux = position[i + 3] - position[i], uy = position[i + 4] - position[i + 1], uz = position[i + 5] - position[i + 2];
    const vx = position[i + 6] - position[i], vy = position[i + 7] - position[i + 1], vz = position[i + 8] - position[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 9; k += 3) { normal[i + k] = nx; normal[i + k + 1] = ny; normal[i + k + 2] = nz; }
  }
  return { position, normal, color };
}

self.onmessage = async ({ data: m }: MessageEvent<{ type: string; [k: string]: unknown }>) => {
  if (m.type === 'init') {
    const g = m.grid as HeightGrid;
    grid = { ...g, data: new Float32Array(g.data) };
    surface = makeSurface(grid, m.decks as Deck[]);
    marks = (m.marks as number[][] | undefined) ?? [];
    return;
  }
  if (m.type === 'tile') {
    try {
      const res = await fetch(m.url as string);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tile: DecodedTile = decodeTile(await res.arrayBuffer());
      const mesh = buildTile(tile, grid!, m.tileSize as number, surface!, marks);
      if (m.meshUrl) mesh.models = await models(m.meshUrl as string);
      self.postMessage({ type: 'tile', key: m.key, mesh }, buffers(mesh));
    } catch (e) {
      self.postMessage({ type: 'error', key: m.key, message: (e as Error).message });
    }
  }
};
