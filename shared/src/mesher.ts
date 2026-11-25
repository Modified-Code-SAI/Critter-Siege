import { SDF_DIMS, type SdfWorld } from "./sdf.js";

/** Indexed smooth triangle mesh buffers produced for a single terrain chunk. */
export interface ChunkMeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

const CORNER_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

const CUBE_EDGES: ReadonlyArray<readonly [number, number]> = [
  // X-aligned edges
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  // Y-aligned edges
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  // Z-aligned edges
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

const COLOR_GRASS: readonly [number, number, number] = [0.34, 0.74, 0.24];
const COLOR_CLIFF: readonly [number, number, number] = [0.78, 0.48, 0.28];
const COLOR_SLATE: readonly [number, number, number] = [0.46, 0.48, 0.52];
const COLOR_SAND: readonly [number, number, number] = [0.86, 0.78, 0.56];

function pickTerrainColor(
  worldY: number,
  normalY: number,
): readonly [number, number, number] {
  if (normalY < 0.2) {
    return COLOR_SLATE;
  }
  if (worldY <= 2.2) {
    return COLOR_SAND;
  }
  if (normalY > 0.62) {
    return COLOR_GRASS;
  }
  return COLOR_CLIFF;
}

function emitQuad(
  indices: number[],
  positions: number[],
  a: number,
  b: number,
  c: number,
  d: number,
  flipWinding: boolean,
): void {
  const ax = positions[a * 3] ?? 0;
  const ay = positions[a * 3 + 1] ?? 0;
  const az = positions[a * 3 + 2] ?? 0;
  const bx = positions[b * 3] ?? 0;
  const by = positions[b * 3 + 1] ?? 0;
  const bz = positions[b * 3 + 2] ?? 0;
  const cx = positions[c * 3] ?? 0;
  const cy = positions[c * 3 + 1] ?? 0;
  const cz = positions[c * 3 + 2] ?? 0;
  const dx = positions[d * 3] ?? 0;
  const dy = positions[d * 3 + 1] ?? 0;
  const dz = positions[d * 3 + 2] ?? 0;

  const diagAC = (cx - ax) * (cx - ax) + (cy - ay) * (cy - ay) + (cz - az) * (cz - az);
  const diagBD = (dx - bx) * (dx - bx) + (dy - by) * (dy - by) + (dz - bz) * (dz - bz);

  if (diagAC <= diagBD) {
    if (!flipWinding) {
      indices.push(a, b, c, a, c, d);
    } else {
      indices.push(a, c, b, a, d, c);
    }
  } else if (!flipWinding) {
    indices.push(a, b, d, b, c, d);
  } else {
    indices.push(a, d, b, b, d, c);
  }
}

/**
 * Extract a smooth Dual Surface Nets triangle mesh for chunk (cx, cy, cz).
 * Overlaps 1 cell on high borders so adjacent chunks stitch seamlessly with zero cracks.
 */
export function meshChunkSurfaceNets(
  world: SdfWorld,
  cx: number,
  cy: number,
  cz: number,
): ChunkMeshData {
  const cs = SDF_DIMS.chunkSize;
  const vs = SDF_DIMS.voxelSize;
  const maxCellLimitX = SDF_DIMS.nx - 2;
  const maxCellLimitY = SDF_DIMS.ny - 2;
  const maxCellLimitZ = SDF_DIMS.nz - 2;

  const startX = cx * cs;
  const startY = cy * cs;
  const startZ = cz * cs;

  if (
    !Number.isInteger(cx) ||
    !Number.isInteger(cy) ||
    !Number.isInteger(cz) ||
    startX < 0 ||
    startY < 0 ||
    startZ < 0 ||
    startX > maxCellLimitX ||
    startY > maxCellLimitY ||
    startZ > maxCellLimitZ
  ) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      colors: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  // Owned cells: [start .. ownedEnd - 1]; vertex cells include +1 high-border overlap
  const ownedEndX = Math.min(startX + cs, SDF_DIMS.nx - 1);
  const ownedEndY = Math.min(startY + cs, SDF_DIMS.ny - 1);
  const ownedEndZ = Math.min(startZ + cs, SDF_DIMS.nz - 1);

  const maxCellX = Math.min(ownedEndX, maxCellLimitX);
  const maxCellY = Math.min(ownedEndY, maxCellLimitY);
  const maxCellZ = Math.min(ownedEndZ, maxCellLimitZ);

  const sizeX = maxCellX - startX + 1;
  const sizeY = maxCellY - startY + 1;
  const sizeZ = maxCellZ - startZ + 1;

  const cellToVert = new Int32Array(sizeX * sizeY * sizeZ);
  cellToVert.fill(-1);

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const corners = new Float64Array(8);

  // Pass 1: Place one smooth dual vertex inside every sign-changing cell
  for (let lz = 0; lz < sizeZ; lz++) {
    const z = startZ + lz;
    for (let ly = 0; ly < sizeY; ly++) {
      const y = startY + ly;
      const rowOffset = sizeX * (ly + sizeY * lz);
      for (let lx = 0; lx < sizeX; lx++) {
        const x = startX + lx;

        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const offset = CORNER_OFFSETS[c];
          const val = offset
            ? world.getValue(x + offset[0], y + offset[1], z + offset[2])
            : 2.0;
          corners[c] = val;
          if (val < 0) {
            mask |= 1 << c;
          }
        }

        if (mask === 0 || mask === 255) {
          continue;
        }

        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        let edgeCount = 0;

        for (let e = 0; e < 12; e++) {
          const edge = CUBE_EDGES[e];
          if (!edge) {
            continue;
          }
          const c0 = edge[0];
          const c1 = edge[1];
          const v0 = corners[c0] ?? 2.0;
          const v1 = corners[c1] ?? 2.0;
          if ((v0 < 0) === (v1 < 0)) {
            continue;
          }
          const denom = v0 - v1;
          const rawT = Math.abs(denom) > 1e-6 ? v0 / denom : 0.5;
          const t = Math.max(0, Math.min(1, Number.isFinite(rawT) ? rawT : 0.5));
          const p0 = CORNER_OFFSETS[c0];
          const p1 = CORNER_OFFSETS[c1];
          if (!p0 || !p1) {
            continue;
          }
          sumX += p0[0] + (p1[0] - p0[0]) * t;
          sumY += p0[1] + (p1[1] - p0[1]) * t;
          sumZ += p0[2] + (p1[2] - p0[2]) * t;
          edgeCount += 1;
        }

        if (edgeCount === 0) {
          continue;
        }

        const invCount = 1 / edgeCount;
        const wx = (x + sumX * invCount) * vs;
        const wy = (y + sumY * invCount) * vs;
        const wz = (z + sumZ * invCount) * vs;

        if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) {
          continue;
        }

        const normal = world.sampleNormal(wx, wy, wz);
        const rgb = pickTerrainColor(wy, normal.y);

        const vertIdx = positions.length / 3;
        positions.push(wx, wy, wz);
        normals.push(normal.x, normal.y, normal.z);
        colors.push(rgb[0], rgb[1], rgb[2]);

        cellToVert[lx + rowOffset] = vertIdx;
      }
    }
  }

  const getVert = (lx: number, ly: number, lz: number): number => {
    return cellToVert[lx + sizeX * (ly + sizeY * lz)] ?? -1;
  };

  // Pass 2: Emit outward-facing quads across sign-changing interior +X, +Y, +Z edges
  const ownedCountX = ownedEndX - startX;
  const ownedCountY = ownedEndY - startY;
  const ownedCountZ = ownedEndZ - startZ;

  for (let lz = 0; lz < ownedCountZ; lz++) {
    const z = startZ + lz;
    for (let ly = 0; ly < ownedCountY; ly++) {
      const y = startY + ly;
      for (let lx = 0; lx < ownedCountX; lx++) {
        const x = startX + lx;
        const a = getVert(lx, ly, lz);
        if (a < 0) {
          continue;
        }

        // +X edge: (x, y+1, z+1) -> (x+1, y+1, z+1)
        if (ly + 1 < sizeY && lz + 1 < sizeZ) {
          const v0 = world.getValue(x, y + 1, z + 1);
          const v1 = world.getValue(x + 1, y + 1, z + 1);
          if ((v0 < 0) !== (v1 < 0)) {
            const b = getVert(lx, ly + 1, lz);
            const c = getVert(lx, ly + 1, lz + 1);
            const d = getVert(lx, ly, lz + 1);
            if (b >= 0 && c >= 0 && d >= 0) {
              emitQuad(indices, positions, a, b, c, d, v0 >= 0);
            }
          }
        }

        // +Y edge: (x+1, y, z+1) -> (x+1, y+1, z+1)
        if (lx + 1 < sizeX && lz + 1 < sizeZ) {
          const v0 = world.getValue(x + 1, y, z + 1);
          const v1 = world.getValue(x + 1, y + 1, z + 1);
          if ((v0 < 0) !== (v1 < 0)) {
            const b = getVert(lx, ly, lz + 1);
            const c = getVert(lx + 1, ly, lz + 1);
            const d = getVert(lx + 1, ly, lz);
            if (b >= 0 && c >= 0 && d >= 0) {
              emitQuad(indices, positions, a, b, c, d, v0 >= 0);
            }
          }
        }

        // +Z edge: (x+1, y+1, z) -> (x+1, y+1, z+1)
        if (lx + 1 < sizeX && ly + 1 < sizeY) {
          const v0 = world.getValue(x + 1, y + 1, z);
          const v1 = world.getValue(x + 1, y + 1, z + 1);
          if ((v0 < 0) !== (v1 < 0)) {
            const b = getVert(lx + 1, ly, lz);
            const c = getVert(lx + 1, ly + 1, lz);
            const d = getVert(lx, ly + 1, lz);
            if (b >= 0 && c >= 0 && d >= 0) {
              emitQuad(indices, positions, a, b, c, d, v0 >= 0);
            }
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
