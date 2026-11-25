import type { CarveOp, HazardType, ThemeId, Vec3 } from "./types.js";
import { createSeededRng } from "./rng.js";

/** Fixed voxel grid & chunk geometry constants for Critter Siege 60m sculpted SDF worlds. */
export const SDF_DIMS = {
  nx: 80,
  ny: 36,
  nz: 80,
  voxelSize: 0.75,
  chunkSize: 16,
} as const;

/** Chunk index triple identifying one of the 75 terrain chunks (5 x 3 x 5). */
export interface ChunkCoord {
  cx: number;
  cy: number;
  cz: number;
}

/** Deterministic world placement specification for an interactive environmental hazard. */
export interface HazardPlacement {
  type: HazardType;
  position: Vec3;
  radius: number;
}

const OUTSIDE_AIR_VALUE = 2.0;
const BORDER_AIR_MIN = 1.5;
const CHUNKS_X = Math.ceil(SDF_DIMS.nx / SDF_DIMS.chunkSize);
const CHUNKS_Y = Math.ceil(SDF_DIMS.ny / SDF_DIMS.chunkSize);
const CHUNKS_Z = Math.ceil(SDF_DIMS.nz / SDF_DIMS.chunkSize);
const WORLD_CENTER_X = SDF_DIMS.nx * SDF_DIMS.voxelSize * 0.5;
const WORLD_CENTER_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize * 0.5;

/** Format a deterministic map key for a chunk coordinate. */
export function chunkKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Polynomial smooth minimum for organic sculpted SDF unions. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Polynomial smooth maximum for organic sculpted SDF intersections/subtractions. */
function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

function sdSphere(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
): number {
  return Math.hypot(px - cx, py - cy, pz - cz) - r;
}

function sdEllipsoid(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
): number {
  const qx = (px - cx) / rx;
  const qy = (py - cy) / ry;
  const qz = (pz - cz) / rz;
  const k0 = Math.hypot(qx, qy, qz);
  if (k0 < 1e-6) {
    return -Math.min(rx, ry, rz);
  }
  const k1 = Math.hypot(qx / rx, qy / ry, qz / rz);
  return (k0 * (k0 - 1.0)) / Math.max(k1, 1e-6);
}

function sdTaperedPlateau(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cz: number,
  bottomY: number,
  topY: number,
  bottomRadius: number,
  topRadius: number,
  bevel: number,
): number {
  const h = Math.max(0.2, topY - bottomY);
  const t = Math.max(0, Math.min(1, (py - bottomY) / h));
  const midRadius = Math.max(topRadius * 1.14, bottomRadius);
  let rAtY: number;
  if (t < 0.26) {
    // Floating rock underside tapers gracefully inward below the cliff waist
    const u = t / 0.26;
    const smoothU = u * u * (3 - 2 * u);
    rAtY = bottomRadius * 0.72 + (midRadius - bottomRadius * 0.72) * smoothU;
  } else {
    // Terracotta cliff faces slope smoothly inward toward the grassy plateau crown
    const u = (t - 0.26) / 0.74;
    const smoothU = u * u * (3 - 2 * u);
    rAtY = midRadius + (topRadius * 0.9 - midRadius) * smoothU;
  }
  const radial = Math.hypot(px - cx, pz - cz) - Math.max(0.1, rAtY - bevel);
  const halfH = Math.max(0.1, h * 0.5 - bevel);
  const midY = (bottomY + topY) * 0.5;
  const vertical = Math.abs(py - midY) - halfH;
  const outX = Math.max(radial, 0);
  const outY = Math.max(vertical, 0);
  return Math.hypot(outX, outY) + Math.min(Math.max(radial, vertical), 0) - bevel;
}

function sdStoneArch(
  px: number,
  py: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  baseY: number,
  apexY: number,
  width: number,
  thickness: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const span = Math.hypot(dx, dz);
  if (span < 1e-5) {
    return sdSphere(px, py, pz, ax, apexY, az, thickness);
  }
  const ux = dx / span;
  const uz = dz / span;
  const proj = (px - ax) * ux + (pz - az) * uz;
  const t = Math.max(0, Math.min(1, proj / span));
  const clampedProj = t * span;
  const cx = ax + ux * clampedProj;
  const cz = az + uz * clampedProj;
  const archY = baseY + 4 * t * (1 - t) * (apexY - baseY);

  const distXZ = Math.hypot(px - cx, pz - cz);
  const distY = Math.abs(py - archY);
  const nx = distXZ / Math.max(0.2, width);
  const ny = distY / Math.max(0.2, thickness);
  const normDist = Math.hypot(nx, ny);
  return (normDist - 1.0) * Math.min(width, thickness);
}

function distToSegment(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  if (abLenSq < 1e-8) {
    return Math.hypot(px - ax, py - ay, pz - az);
  }
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / abLenSq),
  );
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const cz = az + abz * t;
  return Math.hypot(px - cx, py - cy, pz - cz);
}

/** Deterministic 3D smooth value noise sampler seeded via Mulberry32. */
function createValueNoise3D(seed: number): (x: number, y: number, z: number) => number {
  const rng = createSeededRng(seed ^ 0x9e3779b9);
  const perm = new Uint8Array(256);
  const vals = new Float32Array(256);

  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    vals[i] = rng() * 2 - 1;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = perm[i] ?? 0;
    perm[i] = perm[j] ?? 0;
    perm[j] = tmp;
  }

  const hash = (ix: number, iy: number, iz: number): number => {
    const hx = perm[ix & 255] ?? 0;
    const hy = perm[(hx + iy) & 255] ?? 0;
    const hz = perm[(hy + iz) & 255] ?? 0;
    return vals[hz] ?? 0;
  };

  return (x: number, y: number, z: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fy = y - y0;
    const fz = z - z0;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const uz = fz * fz * (3 - 2 * fz);

    const c000 = hash(x0, y0, z0);
    const c100 = hash(x0 + 1, y0, z0);
    const c010 = hash(x0, y0 + 1, z0);
    const c110 = hash(x0 + 1, y0 + 1, z0);
    const c001 = hash(x0, y0, z0 + 1);
    const c101 = hash(x0 + 1, y0, z0 + 1);
    const c011 = hash(x0, y0 + 1, z0 + 1);
    const c111 = hash(x0 + 1, y0 + 1, z0 + 1);

    const x00 = c000 + (c100 - c000) * ux;
    const x10 = c010 + (c110 - c010) * ux;
    const x01 = c001 + (c101 - c001) * ux;
    const x11 = c011 + (c111 - c011) * ux;

    const y0v = x00 + (x10 - x00) * uy;
    const y1v = x01 + (x11 - x01) * uy;

    return y0v + (y1v - y0v) * uz;
  };
}

interface ThemeJitter {
  westHeight: number;
  eastHeight: number;
  archBoost: number;
  northShift: number;
  southShift: number;
}

function evaluateThemeSdf(
  theme: ThemeId,
  x: number,
  y: number,
  z: number,
  j: ThemeJitter,
  noise: (nx: number, ny: number, nz: number) => number,
): number {
  const n1 = noise(x * 0.13, y * 0.15, z * 0.13);
  const n2 = noise(x * 0.29 + 17.3, y * 0.29 + 5.1, z * 0.29 - 11.7);
  const organicNoise = n1 * 0.38 + n2 * 0.14;

  if (theme === "emerald_spire") {
    // Sunlit Archipelago Obstacle Course: 4 tiered plateau forts separated by deep water
    // channels & ravines, linked by 2 narrow high choke bridges, a towering central pinnacle
    // with a pass-through tunnel at its base, and blocking sculpted rock battlements.
    const nwPeninsula = sdTaperedPlateau(
      x,
      y,
      z,
      14.0 + j.northShift,
      14.5,
      1.9,
      11.8 + j.westHeight,
      5.4,
      9.4,
      1.35,
    );
    const nePeninsula = sdTaperedPlateau(
      x,
      y,
      z,
      46.0 + j.southShift,
      14.5,
      1.9,
      12.3 + j.eastHeight,
      5.4,
      9.4,
      1.35,
    );
    const swPeninsula = sdTaperedPlateau(
      x,
      y,
      z,
      14.0 - j.southShift * 0.6,
      45.5,
      1.9,
      12.0 + j.eastHeight * 0.7,
      5.4,
      9.4,
      1.35,
    );
    const sePeninsula = sdTaperedPlateau(
      x,
      y,
      z,
      46.0 - j.northShift * 0.6,
      45.5,
      1.9,
      12.5 + j.westHeight * 0.7,
      5.4,
      9.4,
      1.35,
    );

    // Multi-tier stepped ledges & coastal sandy coves near the waterline (y ~ 2.4-7.6)
    const nwCove = sdTaperedPlateau(x, y, z, 20.5, 20.8, 1.6, 3.1, 3.8, 5.2, 0.85);
    const seCove = sdTaperedPlateau(x, y, z, 39.5, 39.2, 1.6, 3.1, 3.8, 5.2, 0.85);
    const neTerrace = sdTaperedPlateau(x, y, z, 39.8, 20.5, 1.8, 7.2, 3.8, 5.2, 1.0);
    const swTerrace = sdTaperedPlateau(x, y, z, 20.2, 39.5, 1.8, 7.0, 3.8, 5.2, 1.0);
    const nwMidLedge = sdTaperedPlateau(x, y, z, 11.2, 26.8, 1.9, 6.4, 3.0, 4.2, 0.9);
    const seMidLedge = sdTaperedPlateau(x, y, z, 48.8, 33.2, 1.9, 6.6, 3.0, 4.2, 0.9);

    // Towering central pinnacle island + low beach apron
    const centralSpire = sdTaperedPlateau(
      x,
      y,
      z,
      30.0,
      30.0,
      1.8,
      16.0 + j.archBoost,
      4.8,
      6.0,
      1.25,
    );
    const spireBeach = sdTaperedPlateau(
      x,
      y,
      z,
      30.0,
      30.0,
      1.6,
      3.1,
      6.0,
      7.4,
      0.8,
    );

    // Organic sculpted rock battlements flanking the inner fort edges (tactical LoS cover)
    const nwBattlement = sdEllipsoid(x, y, z, 20.2, 13.0, 14.2, 1.35, 2.35, 2.45);
    const neBattlement = sdEllipsoid(x, y, z, 39.8, 13.4, 14.2, 1.35, 2.35, 2.45);
    const swBattlement = sdEllipsoid(x, y, z, 20.2, 13.2, 45.8, 1.35, 2.35, 2.45);
    const seBattlement = sdEllipsoid(x, y, z, 39.8, 13.5, 45.8, 1.35, 2.35, 2.45);

    let d = smin(nwPeninsula, nePeninsula, 2.0);
    d = smin(d, swPeninsula, 2.0);
    d = smin(d, sePeninsula, 2.0);
    d = smin(d, nwCove, 1.35);
    d = smin(d, seCove, 1.35);
    d = smin(d, neTerrace, 1.45);
    d = smin(d, swTerrace, 1.45);
    d = smin(d, nwMidLedge, 1.25);
    d = smin(d, seMidLedge, 1.25);
    d = smin(d, centralSpire, 1.5);
    d = smin(d, spireBeach, 1.1);
    d = smin(d, nwBattlement, 0.9);
    d = smin(d, neBattlement, 0.9);
    d = smin(d, swBattlement, 0.9);
    d = smin(d, seBattlement, 0.9);

    // Carved pass-through tunnel straight through the central pinnacle's base
    const spireTunnel =
      distToSegment(x, y, z, 21.5, 5.4, 30.0, 38.5, 5.4, 30.0) - 2.3;
    d = smax(d, -spireTunnel, 0.7);

    // Two narrow dramatic curved stone choke bridges crossing the lagoon via the spire
    const diagArchA = sdStoneArch(
      x,
      y,
      z,
      16.0 + j.northShift * 0.5,
      16.5,
      44.0 - j.northShift * 0.5,
      43.5,
      10.8,
      16.1 + j.archBoost,
      2.15,
      1.35,
    );
    const diagArchB = sdStoneArch(
      x,
      y,
      z,
      16.0 - j.southShift * 0.5,
      43.5,
      44.0 + j.southShift * 0.5,
      16.5,
      10.8,
      15.9 - j.archBoost * 0.5,
      2.15,
      1.35,
    );
    d = smin(d, diagArchA, 1.0);
    d = smin(d, diagArchB, 1.0);

    // Subtle floating-island skirt taper near outer archipelago rim
    const radial = Math.hypot(x - WORLD_CENTER_X, z - WORLD_CENTER_Z);
    const skirtCut = 1.9 - y + Math.max(0, radial - 23.0) * 0.32;
    d = smax(d, skirtCut, 0.85);
    return d + organicNoise;
  }

  if (theme === "canyon_arch") {
    // Grand Mesa Canyon: Multi-tier terraced mesas framing a dramatic gorge spanned by
    // a massive curved natural arch, a lower cave bypass tunnel, and rocky switchbacks.
    const northRim = sdTaperedPlateau(
      x,
      y,
      z,
      30.0 + j.northShift,
      13.5,
      1.9,
      14.8 + j.westHeight * 0.7,
      8.0,
      13.2,
      1.4,
    );
    const nwMesa = sdTaperedPlateau(
      x,
      y,
      z,
      14.0,
      16.5,
      1.9,
      12.8 + j.westHeight,
      5.8,
      9.6,
      1.3,
    );
    const neMesa = sdTaperedPlateau(
      x,
      y,
      z,
      46.0,
      16.5,
      1.9,
      13.2 + j.eastHeight,
      5.8,
      9.6,
      1.3,
    );
    const westRidge = sdTaperedPlateau(
      x,
      y,
      z,
      13.8,
      30.5,
      2.0,
      10.8,
      4.5,
      7.4,
      1.2,
    );
    const eastRidge = sdTaperedPlateau(
      x,
      y,
      z,
      46.2,
      30.5,
      2.0,
      11.0,
      4.5,
      7.4,
      1.2,
    );
    const swMesa = sdTaperedPlateau(
      x,
      y,
      z,
      14.5,
      44.5,
      1.9,
      12.0 + j.eastHeight * 0.6,
      5.8,
      9.6,
      1.3,
    );
    const seMesa = sdTaperedPlateau(
      x,
      y,
      z,
      45.5,
      44.5,
      1.9,
      12.2 + j.westHeight * 0.6,
      5.8,
      9.6,
      1.3,
    );
    // Low sandy canyon valley floor cove & rocky switchback ledges inside the gorge
    const valleyFloor = sdTaperedPlateau(
      x,
      y,
      z,
      30.0,
      27.0,
      1.6,
      3.1,
      6.4,
      8.2,
      0.85,
    );
    const swSwitchback = sdTaperedPlateau(x, y, z, 21.8, 35.8, 1.8, 6.4, 3.0, 4.4, 0.9);
    const seSwitchback = sdTaperedPlateau(x, y, z, 38.2, 35.8, 1.8, 6.6, 3.0, 4.4, 0.9);
    const westSpire = sdEllipsoid(x, y, z, 20.6, 13.0, 40.5, 1.5, 2.8, 1.8);
    const eastSpire = sdEllipsoid(x, y, z, 39.4, 13.2, 40.5, 1.5, 2.8, 1.8);

    let d = smin(northRim, nwMesa, 2.0);
    d = smin(d, neMesa, 2.0);
    d = smin(d, westRidge, 1.8);
    d = smin(d, eastRidge, 1.8);
    d = smin(d, swMesa, 1.9);
    d = smin(d, seMesa, 1.9);
    d = smin(d, valleyFloor, 1.2);
    d = smin(d, swSwitchback, 1.25);
    d = smin(d, seSwitchback, 1.25);
    d = smin(d, westSpire, 0.95);
    d = smin(d, eastSpire, 0.95);

    // Carve dramatic central gorge opening southward
    const gorgeCore =
      distToSegment(x, y, z, 30.0, 10.6, 24.0, 30.0, 9.6, 56.0) - 7.4;
    const gorgeUpper = sdEllipsoid(x, y, z, 30.0, 14.5, 34.0, 9.0, 7.2, 13.8);
    const gorgeCut = smin(gorgeCore, gorgeUpper, 1.6);
    d = smax(d, -gorgeCut, 1.2);

    // Lower cave bypass tunnel running beneath the north mesa rim
    const northCaveTunnel =
      distToSegment(x, y, z, 18.0, 6.0, 16.2, 42.0, 6.0, 16.2) - 2.25;
    d = smax(d, -northCaveTunnel, 0.75);

    // Sheltered carved ridge bunkers along inner west & east canyon walls
    const westBunker = sdEllipsoid(x, y, z, 20.5, 8.2, 29.0, 3.6, 2.4, 4.2);
    const eastBunker = sdEllipsoid(x, y, z, 39.5, 8.4, 31.0, 3.6, 2.4, 4.2);
    d = smax(d, -westBunker, 0.85);
    d = smax(d, -eastBunker, 0.85);

    // Massive sweeping natural rock arch spanning the southern gorge
    const grandArch = sdStoneArch(
      x,
      y,
      z,
      15.5,
      41.5,
      44.5,
      41.5,
      10.8,
      17.2 + j.archBoost,
      2.65,
      1.55,
    );
    d = smin(d, grandArch, 1.15);

    return d + organicNoise;
  }

  // 'twin_pillars' (Sky Twin Atolls): Steep twin cliff fortresses with elevated stone
  // overpasses, base tunnels, coastal sea-stacks, and canyon pinch points.
  const nwAtoll = sdTaperedPlateau(
    x,
    y,
    z,
    13.5,
    14.0 + j.northShift,
    1.9,
    11.0 + j.westHeight,
    5.2,
    8.9,
    1.3,
  );
  const neAtoll = sdTaperedPlateau(
    x,
    y,
    z,
    46.5,
    14.0 + j.southShift,
    1.9,
    11.4 + j.eastHeight,
    5.2,
    8.9,
    1.3,
  );
  const swAtoll = sdTaperedPlateau(
    x,
    y,
    z,
    13.5,
    46.0 - j.southShift,
    1.9,
    11.2 + j.eastHeight * 0.7,
    5.2,
    8.9,
    1.3,
  );
  const seAtoll = sdTaperedPlateau(
    x,
    y,
    z,
    46.5,
    46.0 - j.northShift,
    1.9,
    11.6 + j.westHeight * 0.7,
    5.2,
    8.9,
    1.3,
  );

  // Two towering central twin cliff fortresses
  const westPillar = sdTaperedPlateau(
    x,
    y,
    z,
    23.5,
    28.5,
    1.9,
    16.8 + j.westHeight,
    4.6,
    6.4,
    1.2,
  );
  const eastPillar = sdTaperedPlateau(
    x,
    y,
    z,
    36.5,
    31.5,
    1.9,
    17.2 + j.eastHeight,
    4.6,
    6.4,
    1.2,
  );

  // Sculpted coastal sea-stacks rising from outer turquoise channels
  const northStack = sdTaperedPlateau(x, y, z, 30.0, 10.2, 1.7, 9.2, 2.2, 3.0, 0.85);
  const southStack = sdTaperedPlateau(x, y, z, 30.0, 49.8, 1.7, 8.8, 2.2, 3.0, 0.85);
  const westStack = sdTaperedPlateau(x, y, z, 9.8, 30.0, 1.7, 8.5, 2.1, 2.9, 0.85);
  const eastStack = sdTaperedPlateau(x, y, z, 50.2, 30.0, 1.7, 8.7, 2.1, 2.9, 0.85);

  // Sandy coastal coves & scenic overhanging cliff ledges
  const nwBeach = sdTaperedPlateau(x, y, z, 18.8, 19.8, 1.6, 3.0, 3.8, 5.2, 0.8);
  const seBeach = sdTaperedPlateau(x, y, z, 41.2, 40.2, 1.6, 3.0, 3.8, 5.2, 0.8);
  const neLedge = sdEllipsoid(x, y, z, 41.5, 9.2, 19.5, 4.4, 1.5, 4.0);
  const swLedge = sdEllipsoid(x, y, z, 18.5, 9.0, 40.5, 4.4, 1.5, 4.0);

  // Narrow elevated stone overpasses linking the twin pillars and the 4 outer atolls
  const pillarBridge = sdStoneArch(
    x,
    y,
    z,
    23.5,
    28.5,
    36.5,
    31.5,
    14.8,
    16.8 + j.archBoost * 0.6,
    2.15,
    1.35,
  );
  const nwBridge = sdStoneArch(
    x,
    y,
    z,
    14.5,
    15.5,
    23.5,
    28.0,
    9.8,
    14.4,
    2.05,
    1.25,
  );
  const swBridge = sdStoneArch(
    x,
    y,
    z,
    14.5,
    44.5,
    23.5,
    29.5,
    9.8,
    14.2,
    2.05,
    1.25,
  );
  const neBridge = sdStoneArch(
    x,
    y,
    z,
    45.5,
    15.5,
    36.5,
    30.5,
    10.0,
    14.6,
    2.05,
    1.25,
  );
  const seBridge = sdStoneArch(
    x,
    y,
    z,
    45.5,
    44.5,
    36.5,
    32.0,
    10.0,
    14.6,
    2.05,
    1.25,
  );

  // Blocking ridge cover outcrops on inner bridge approaches
  const westPinchWall = sdEllipsoid(x, y, z, 19.5, 11.4, 21.8, 1.4, 2.2, 1.7);
  const eastPinchWall = sdEllipsoid(x, y, z, 40.5, 11.6, 38.2, 1.4, 2.2, 1.7);

  let d = smin(nwAtoll, neAtoll, 1.8);
  d = smin(d, swAtoll, 1.8);
  d = smin(d, seAtoll, 1.8);
  d = smin(d, westPillar, 1.6);
  d = smin(d, eastPillar, 1.6);
  d = smin(d, northStack, 1.0);
  d = smin(d, southStack, 1.0);
  d = smin(d, westStack, 1.0);
  d = smin(d, eastStack, 1.0);
  d = smin(d, nwBeach, 1.2);
  d = smin(d, seBeach, 1.2);
  d = smin(d, neLedge, 1.1);
  d = smin(d, swLedge, 1.1);
  d = smin(d, pillarBridge, 1.05);
  d = smin(d, nwBridge, 0.95);
  d = smin(d, swBridge, 0.95);
  d = smin(d, neBridge, 0.95);
  d = smin(d, seBridge, 0.95);
  d = smin(d, westPinchWall, 0.85);
  d = smin(d, eastPinchWall, 0.85);

  // Carved sea-cave bypass tunnels through the bases of the twin cliff fortresses
  const westPillarTunnel =
    distToSegment(x, y, z, 17.5, 5.6, 28.5, 29.5, 5.6, 28.5) - 2.15;
  const eastPillarTunnel =
    distToSegment(x, y, z, 30.5, 5.6, 31.5, 42.5, 5.6, 31.5) - 2.15;
  d = smax(d, -westPillarTunnel, 0.7);
  d = smax(d, -eastPillarTunnel, 0.7);

  // Carve dramatic underside hollows beneath the overhanging coastal ledges
  const underNE = sdEllipsoid(x, y, z, 41.8, 6.2, 19.2, 3.6, 2.0, 3.4);
  const underSW = sdEllipsoid(x, y, z, 18.2, 6.0, 40.8, 3.6, 2.0, 3.4);
  d = smax(d, -underNE, 0.75);
  d = smax(d, -underSW, 0.75);

  return d + organicNoise;
}

/**
 * Deterministic 3D Signed Distance Field sculpted sky-island terrain world.
 * Sign convention: negative (< 0) = solid rock/earth, positive (> 0) = air, 0 = smooth surface.
 */
export class SdfWorld {
  public readonly seed: number;
  public readonly theme: ThemeId;

  private readonly values: Float32Array;
  private readonly carveLog: CarveOp[] = [];

  public constructor(seed: number, theme: ThemeId) {
    this.seed = seed;
    this.theme = theme;
    this.values = new Float32Array(SDF_DIMS.nx * SDF_DIMS.ny * SDF_DIMS.nz);
    this.generateTerrain();
  }

  /** Read raw SDF grid value at integer voxel index, returning +2.0 outside bounds. */
  public getValue(ix: number, iy: number, iz: number): number {
    if (
      !(
        ix >= 0 &&
        ix < SDF_DIMS.nx &&
        iy >= 0 &&
        iy < SDF_DIMS.ny &&
        iz >= 0 &&
        iz < SDF_DIMS.nz
      )
    ) {
      return OUTSIDE_AIR_VALUE;
    }
    const x = Math.trunc(ix);
    const y = Math.trunc(iy);
    const z = Math.trunc(iz);
    const idx = x + SDF_DIMS.nx * (y + SDF_DIMS.ny * z);
    return this.values[idx] ?? OUTSIDE_AIR_VALUE;
  }

  /** Trilinearly sample the SDF in world meters ([0..60, 0..27, 0..60]), returning +2.0 outside. */
  public sample(x: number, y: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return OUTSIDE_AIR_VALUE;
    }
    const gx = x / SDF_DIMS.voxelSize;
    const gy = y / SDF_DIMS.voxelSize;
    const gz = z / SDF_DIMS.voxelSize;

    if (
      gx < 0 ||
      gy < 0 ||
      gz < 0 ||
      gx >= SDF_DIMS.nx ||
      gy >= SDF_DIMS.ny ||
      gz >= SDF_DIMS.nz
    ) {
      return OUTSIDE_AIR_VALUE;
    }

    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fy = gy - y0;
    const fz = gz - z0;

    const c000 = this.getValue(x0, y0, z0);
    const c100 = this.getValue(x0 + 1, y0, z0);
    const c010 = this.getValue(x0, y0 + 1, z0);
    const c110 = this.getValue(x0 + 1, y0 + 1, z0);
    const c001 = this.getValue(x0, y0, z0 + 1);
    const c101 = this.getValue(x0 + 1, y0, z0 + 1);
    const c011 = this.getValue(x0, y0 + 1, z0 + 1);
    const c111 = this.getValue(x0 + 1, y0 + 1, z0 + 1);

    const x00 = c000 + (c100 - c000) * fx;
    const x10 = c010 + (c110 - c010) * fx;
    const x01 = c001 + (c101 - c001) * fx;
    const x11 = c011 + (c111 - c011) * fx;

    const y0v = x00 + (x10 - x00) * fy;
    const y1v = x01 + (x11 - x01) * fy;

    return y0v + (y1v - y0v) * fz;
  }

  /** Compute outward-pointing unit normal via central differences; never returns NaN. */
  public sampleNormal(x: number, y: number, z: number): Vec3 {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return { x: 0, y: 1, z: 0 };
    }
    const eps = SDF_DIMS.voxelSize * 0.5;
    const dx = this.sample(x + eps, y, z) - this.sample(x - eps, y, z);
    const dy = this.sample(x, y + eps, z) - this.sample(x, y - eps, z);
    const dz = this.sample(x, y, z + eps) - this.sample(x, y, z - eps);
    const len = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(len) || len < 1e-5) {
      return { x: 0, y: 1, z: 0 };
    }
    return { x: dx / len, y: dy / len, z: dz / len };
  }

  /** Returns true when world coordinate (x, y, z) lies inside solid rock/earth. */
  public isSolid(x: number, y: number, z: number): boolean {
    return this.sample(x, y, z) < 0;
  }

  /**
   * Smoothly subtract a sphere or capsule volume from the SDF within clamped interior bounds.
   * Records the carve op and returns deduplicated dirty chunk keys.
   */
  public applyCarve(op: CarveOp): string[] {
    if (
      !Number.isFinite(op.radius) ||
      op.radius <= 0 ||
      !isFiniteVec3(op.center)
    ) {
      return [];
    }

    const endPoint =
      op.shape === "capsule" && op.end && isFiniteVec3(op.end)
        ? { ...op.end }
        : undefined;

    const recorded: CarveOp = endPoint
      ? {
          center: { ...op.center },
          radius: op.radius,
          shape: op.shape,
          end: endPoint,
        }
      : {
          center: { ...op.center },
          radius: op.radius,
          shape: op.shape,
        };
    this.carveLog.push(recorded);

    const vs = SDF_DIMS.voxelSize;
    const pad = op.radius + vs * 2;
    const bx = endPoint ? endPoint.x : op.center.x;
    const by = endPoint ? endPoint.y : op.center.y;
    const bz = endPoint ? endPoint.z : op.center.z;

    const minX = Math.min(op.center.x, bx) - pad;
    const maxX = Math.max(op.center.x, bx) + pad;
    const minY = Math.min(op.center.y, by) - pad;
    const maxY = Math.max(op.center.y, by) + pad;
    const minZ = Math.min(op.center.z, bz) - pad;
    const maxZ = Math.max(op.center.z, bz) + pad;

    // Clamp strictly inside [1..nx-2, 1..ny-2, 1..nz-2] so boundary air shell stays intact
    const minIx = Math.max(1, Math.floor(minX / vs));
    const maxIx = Math.min(SDF_DIMS.nx - 2, Math.ceil(maxX / vs));
    const minIy = Math.max(1, Math.floor(minY / vs));
    const maxIy = Math.min(SDF_DIMS.ny - 2, Math.ceil(maxY / vs));
    const minIz = Math.max(1, Math.floor(minZ / vs));
    const maxIz = Math.min(SDF_DIMS.nz - 2, Math.ceil(maxZ / vs));

    if (minIx > maxIx || minIy > maxIy || minIz > maxIz) {
      return [];
    }

    const dirtyChunks = new Set<string>();
    const isCapsule = op.shape === "capsule" && endPoint !== undefined;

    for (let iz = minIz; iz <= maxIz; iz++) {
      const wz = iz * vs;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const wy = iy * vs;
        const rowBase = SDF_DIMS.nx * (iy + SDF_DIMS.ny * iz);
        for (let ix = minIx; ix <= maxIx; ix++) {
          const wx = ix * vs;
          const dist = isCapsule
            ? distToSegment(
                wx,
                wy,
                wz,
                op.center.x,
                op.center.y,
                op.center.z,
                bx,
                by,
                bz,
              )
            : Math.hypot(
                wx - op.center.x,
                wy - op.center.y,
                wz - op.center.z,
              );
          const carvedVal = op.radius - dist;
          const idx = ix + rowBase;
          const oldVal = this.values[idx] ?? OUTSIDE_AIR_VALUE;
          if (carvedVal > oldVal) {
            this.values[idx] = carvedVal;
            this.markDirtyChunksForVoxel(ix, iy, iz, dirtyChunks);
          }
        }
      }
    }

    return Array.from(dirtyChunks);
  }

  /** Erode outer island terrain beyond radiusFromCenter around (30, 30) for sudden-death ledge crumble. */
  public crumbleOuterRing(radiusFromCenter: number): string[] {
    if (!Number.isFinite(radiusFromCenter)) {
      return [];
    }
    const radius = Math.max(0, radiusFromCenter);
    const vs = SDF_DIMS.voxelSize;
    const dirtyChunks = new Set<string>();

    for (let iz = 1; iz <= SDF_DIMS.nz - 2; iz++) {
      const dz = iz * vs - WORLD_CENTER_Z;
      for (let iy = 1; iy <= SDF_DIMS.ny - 2; iy++) {
        const rowBase = SDF_DIMS.nx * (iy + SDF_DIMS.ny * iz);
        for (let ix = 1; ix <= SDF_DIMS.nx - 2; ix++) {
          const dx = ix * vs - WORLD_CENTER_X;
          const radial = Math.hypot(dx, dz);
          const erodeVal = radial - radius;
          if (erodeVal <= -1.5) {
            continue;
          }
          const idx = ix + rowBase;
          const oldVal = this.values[idx] ?? OUTSIDE_AIR_VALUE;
          if (erodeVal > oldVal) {
            this.values[idx] = erodeVal;
            this.markDirtyChunksForVoxel(ix, iy, iz, dirtyChunks);
          }
        }
      }
    }

    return Array.from(dirtyChunks);
  }

  /**
   * Scan top-down at (x, z) for the highest air-to-solid crossing and refine
   * with 4 binary search steps. Returns null if the column is all air.
   */
  public getSurfaceY(x: number, z: number): number | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return null;
    }
    const step = SDF_DIMS.voxelSize * 0.5;
    const maxY = (SDF_DIMS.ny - 2) * SDF_DIMS.voxelSize;
    const minY = SDF_DIMS.voxelSize;

    let prevY = maxY;
    let prevVal = this.sample(x, prevY, z);

    for (let y = maxY - step; y >= minY; y -= step) {
      const currVal = this.sample(x, y, z);
      if (prevVal >= 0 && currVal < 0) {
        let lo = y;
        let hi = prevY;
        for (let iter = 0; iter < 4; iter++) {
          const mid = (lo + hi) * 0.5;
          if (this.sample(x, mid, z) < 0) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        return (lo + hi) * 0.5;
      }
      prevY = y;
      prevVal = currVal;
    }

    return null;
  }

  /**
   * Deterministically pick `count` well-separated walkable high-ground spawn
   * points (y >= 4.0, normal.y >= 0.65) across 4 distinct archipelago quadrants
   * separated by >= 22m for the primary 4 critters.
   */
  public findSpawnPoints(count: number): Vec3[] {
    if (!Number.isFinite(count) || count <= 0) {
      return [];
    }
    const targetCount = Math.floor(count);
    const rng = createSeededRng(this.seed ^ 0x51a9c3);

    interface SpawnCandidate {
      pos: Vec3;
      quadrant: number;
      radial: number;
      score: number;
    }

    const worldMaxX = SDF_DIMS.nx * SDF_DIMS.voxelSize;
    const worldMaxZ = SDF_DIMS.nz * SDF_DIMS.voxelSize;
    const candidates: SpawnCandidate[] = [];

    for (let x = 5.0; x <= worldMaxX - 5.0; x += 1.5) {
      for (let z = 5.0; z <= worldMaxZ - 5.0; z += 1.5) {
        const surfaceY = this.getSurfaceY(x, z);
        if (surfaceY === null || surfaceY < 4.0) {
          continue;
        }
        const normal = this.sampleNormal(x, surfaceY, z);
        if (normal.y < 0.65) {
          continue;
        }
        // Require clear headroom and solid footing underneath (broad walkable plateau)
        if (
          this.sample(x, surfaceY + 1.0, z) <= 0.1 ||
          this.sample(x, surfaceY + 2.0, z) <= 0.1 ||
          !this.isSolid(x, surfaceY - 1.5, z)
        ) {
          continue;
        }
        const stableFooting =
          this.isSolid(x + 1.4, surfaceY - 1.0, z) &&
          this.isSolid(x - 1.4, surfaceY - 1.0, z) &&
          this.isSolid(x, surfaceY - 1.0, z + 1.4) &&
          this.isSolid(x, surfaceY - 1.0, z - 1.4);

        const radial = Math.hypot(x - WORLD_CENTER_X, z - WORLD_CENTER_Z);
        const quadrant =
          (x < WORLD_CENTER_X ? 0 : 1) + (z < WORLD_CENTER_Z ? 0 : 2);
        const footingBonus = stableFooting ? 4.0 : 0.0;
        const score =
          surfaceY * 0.9 +
          normal.y * 3.0 +
          footingBonus +
          Math.min(radial, 24.0) * 0.18 +
          rng() * 0.35;
        candidates.push({ pos: { x, y: surfaceY, z }, quadrant, radial, score });
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    candidates.sort((a, b) => b.score - a.score);

    const selected: Vec3[] = [];
    const usedQuadrants = new Set<number>();

    // First pass: pick up to 4 spawns across 4 distinct outer-archipelago quadrants (>= 22m apart, inside Turn 6 crumble ring)
    const primaryTarget = Math.min(targetCount, 4);
    const outerPreferred = candidates.filter(
      (c) => c.radial >= 14.0 && c.radial <= 25.2,
    );
    const firstPool = outerPreferred.length > 0 ? outerPreferred : candidates;
    const first = firstPool[0];
    if (first) {
      selected.push({ ...first.pos });
      usedQuadrants.add(first.quadrant);
    }

    while (selected.length < primaryTarget && selected.length < candidates.length) {
      let bestCandidate: SpawnCandidate | null = null;
      let bestMetric = -Infinity;

      const unusedQuadPool = candidates.filter(
        (c) => !usedQuadrants.has(c.quadrant),
      );
      const searchPool = unusedQuadPool.length > 0 ? unusedQuadPool : candidates;

      for (const cand of searchPool) {
        let minDist = Infinity;
        for (const existing of selected) {
          const d = Math.hypot(
            cand.pos.x - existing.x,
            cand.pos.y - existing.y,
            cand.pos.z - existing.z,
          );
          if (d < minDist) {
            minDist = d;
          }
        }
        if (minDist < 0.01) {
          continue;
        }
        const meetsSeparation = minDist >= 22.0 ? 50.0 : 0.0;
        const safeInnerRing = cand.radial <= 25.2 ? 24.0 : 0.0;
        const outerBonus = cand.radial >= 14.0 && cand.radial <= 25.2 ? 10.0 : 0.0;
        const metric =
          meetsSeparation +
          safeInnerRing +
          outerBonus +
          Math.min(minDist, 32.0) +
          cand.score * 0.35;
        if (metric > bestMetric) {
          bestMetric = metric;
          bestCandidate = cand;
        }
      }

      if (!bestCandidate) {
        break;
      }
      selected.push({ ...bestCandidate.pos });
      usedQuadrants.add(bestCandidate.quadrant);
    }

    // Extra points beyond 4 (e.g. Evo Pod drop zones including central spire high-ground)
    while (selected.length < targetCount && selected.length < candidates.length) {
      let bestCandidate: SpawnCandidate | null = null;
      let bestMetric = -Infinity;

      for (const cand of candidates) {
        let minDist = Infinity;
        for (const existing of selected) {
          const d = Math.hypot(
            cand.pos.x - existing.x,
            cand.pos.y - existing.y,
            cand.pos.z - existing.z,
          );
          if (d < minDist) {
            minDist = d;
          }
        }
        if (minDist < 0.01) {
          continue;
        }
        const metric = minDist + cand.pos.y * 0.45 + cand.score * 0.1;
        if (metric > bestMetric) {
          bestMetric = metric;
          bestCandidate = cand;
        }
      }

      if (!bestCandidate) {
        break;
      }
      selected.push({ ...bestCandidate.pos });
    }

    return selected;
  }

  /**
   * Deterministically place 6-10 interactive environmental hazards across tactical
   * choke points, cliff corners, lower valleys, and canyon shortcuts, clear of spawns.
   */
  public findHazardPoints(spawnPoints: readonly Vec3[]): HazardPlacement[] {
    const rng = createSeededRng(this.seed ^ 0x7c3e91);
    const worldMaxX = SDF_DIMS.nx * SDF_DIMS.voxelSize;
    const worldMaxZ = SDF_DIMS.nz * SDF_DIMS.voxelSize;

    interface HazardCandidate {
      pos: Vec3;
      radial: number;
      isCliffChoke: boolean;
      isValleyLaunch: boolean;
      isShortcut: boolean;
      jitter: number;
    }

    const candidates: HazardCandidate[] = [];

    for (let x = 6.0; x <= worldMaxX - 6.0; x += 1.5) {
      for (let z = 6.0; z <= worldMaxZ - 6.0; z += 1.5) {
        const surfaceY = this.getSurfaceY(x, z);
        if (surfaceY === null || surfaceY < 2.25) {
          continue;
        }
        const normal = this.sampleNormal(x, surfaceY, z);
        if (normal.y < 0.65) {
          continue;
        }
        if (
          this.sample(x, surfaceY + 1.0, z) <= 0.1 ||
          this.sample(x, surfaceY + 2.0, z) <= 0.1 ||
          !this.isSolid(x, surfaceY - 1.0, z)
        ) {
          continue;
        }

        // Keep every hazard safely clear (>= 4.2m) of critter spawns
        let tooCloseToSpawn = false;
        for (const sp of spawnPoints) {
          if (Math.hypot(x - sp.x, surfaceY - sp.y, z - sp.z) < 4.2) {
            tooCloseToSpawn = true;
            break;
          }
        }
        if (tooCloseToSpawn) {
          continue;
        }

        const radial = Math.hypot(x - WORLD_CENTER_X, z - WORLD_CENTER_Z);
        if (radial > 25.5) {
          continue;
        }

        // Check nearby elevation drop/rise for tactical positioning
        let hasNearbyDrop = false;
        let hasNearbyHighCliff = false;
        const probes: ReadonlyArray<readonly [number, number]> = [
          [2.4, 0],
          [-2.4, 0],
          [0, 2.4],
          [0, -2.4],
        ];
        for (const [dx, dz] of probes) {
          const ny = this.getSurfaceY(x + dx, z + dz);
          if (ny === null || ny <= surfaceY - 2.2) {
            hasNearbyDrop = true;
          }
          if (ny !== null && ny >= surfaceY + 2.6) {
            hasNearbyHighCliff = true;
          }
        }

        // Verify clear sky overhead for thermal geyser launchpads
        let clearSky = true;
        for (let h = 2.5; h <= 9.0; h += 1.6) {
          if (this.isSolid(x, surfaceY + h, z)) {
            clearSky = false;
            break;
          }
        }

        const isCliffChoke =
          surfaceY >= 4.0 && (hasNearbyDrop || radial <= 20.0);
        const isValleyLaunch =
          clearSky &&
          surfaceY >= 2.25 &&
          surfaceY <= 11.2 &&
          (hasNearbyHighCliff || surfaceY <= 8.5);
        const isShortcut =
          surfaceY >= 3.0 && radial >= 5.5 && radial <= 23.5;

        candidates.push({
          pos: { x, y: surfaceY, z },
          radial,
          isCliffChoke,
          isValleyLaunch,
          isShortcut,
          jitter: rng(),
        });
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    const placed: HazardPlacement[] = [];

    const farEnough = (pos: Vec3, minDist: number): boolean => {
      for (const h of placed) {
        const d = Math.hypot(
          pos.x - h.position.x,
          pos.y - h.position.y,
          pos.z - h.position.z,
        );
        if (d < minDist) {
          return false;
        }
      }
      return true;
    };

    const pickFromPool = (
      pool: HazardCandidate[],
      type: HazardType,
      radius: number,
      count: number,
      minSpacing: number,
    ): void => {
      const sorted = [...pool].sort((a, b) => b.jitter - a.jitter);
      let added = 0;
      for (const cand of sorted) {
        if (added >= count) break;
        if (!farEnough(cand.pos, minSpacing)) continue;
        placed.push({ type, position: { ...cand.pos }, radius });
        added += 1;
      }
      if (added < count) {
        const fallback = [...candidates].sort((a, b) => b.jitter - a.jitter);
        for (const cand of fallback) {
          if (added >= count) break;
          if (!farEnough(cand.pos, Math.max(3.6, minSpacing * 0.65))) continue;
          placed.push({ type, position: { ...cand.pos }, radius });
          added += 1;
        }
      }
    };

    // 1. Place 3 primary Blast Barrels (radius 1.4) at cliff corners & bridge chokes
    const barrelPool = candidates.filter((c) => c.isCliffChoke);
    pickFromPool(barrelPool, "blast_barrel", 1.4, 3, 7.5);

    // Try placing 1 chain-reaction partner Blast Barrel within 3.2..4.2m of barrel #0
    const anchorBarrel = placed.find((h) => h.type === "blast_barrel");
    if (anchorBarrel) {
      const partner = candidates.find((c) => {
        const dAnchor = Math.hypot(
          c.pos.x - anchorBarrel.position.x,
          c.pos.y - anchorBarrel.position.y,
          c.pos.z - anchorBarrel.position.z,
        );
        if (dAnchor < 3.1 || dAnchor > 4.2) return false;
        return placed.every((other) => {
          if (other === anchorBarrel) return true;
          return (
            Math.hypot(
              c.pos.x - other.position.x,
              c.pos.y - other.position.y,
              c.pos.z - other.position.z,
            ) >= 4.5
          );
        });
      });
      if (partner) {
        placed.push({
          type: "blast_barrel",
          position: { ...partner.pos },
          radius: 1.4,
        });
      } else {
        pickFromPool(barrelPool, "blast_barrel", 1.4, 1, 6.0);
      }
    }

    // 2. Place 3 Thermal Steam Geysers (radius 1.7) in lower valleys & beside tall cliffs
    const geyserPool = candidates
      .filter((c) => c.isValleyLaunch)
      .sort((a, b) => a.pos.y - b.pos.y + (b.jitter - a.jitter) * 3.0);
    pickFromPool(geyserPool, "steam_geyser", 1.7, 3, 6.5);

    // 3. Place 2 Bramble Thorn Patches (radius 1.9) in canyon shortcuts & passes
    const thornPool = candidates.filter((c) => c.isShortcut);
    pickFromPool(thornPool, "thorn_patch", 1.9, 2, 6.0);

    return placed.slice(0, 10);
  }

  /** Return a shallow copy of all applied carve operations. */
  public getCarveLog(): CarveOp[] {
    return this.carveLog.map((op) =>
      op.end
        ? {
            center: { ...op.center },
            radius: op.radius,
            shape: op.shape,
            end: { ...op.end },
          }
        : {
            center: { ...op.center },
            radius: op.radius,
            shape: op.shape,
          },
    );
  }

  /** Return all 75 chunk coordinates covering the SDF world (5 x 3 x 5). */
  public getAllChunkCoords(): ChunkCoord[] {
    const coords: ChunkCoord[] = [];
    for (let cy = 0; cy < CHUNKS_Y; cy++) {
      for (let cz = 0; cz < CHUNKS_Z; cz++) {
        for (let cx = 0; cx < CHUNKS_X; cx++) {
          coords.push({ cx, cy, cz });
        }
      }
    }
    return coords;
  }

  private generateTerrain(): void {
    const rng = createSeededRng(this.seed);
    const jitter: ThemeJitter = {
      westHeight: (rng() - 0.5) * 1.4,
      eastHeight: (rng() - 0.5) * 1.4,
      archBoost: (rng() - 0.5) * 1.0,
      northShift: (rng() - 0.5) * 1.6,
      southShift: (rng() - 0.5) * 1.6,
    };
    const noise = createValueNoise3D(this.seed);
    const vs = SDF_DIMS.voxelSize;

    for (let iz = 0; iz < SDF_DIMS.nz; iz++) {
      const wz = iz * vs;
      const zBorder = iz <= 1 || iz >= SDF_DIMS.nz - 2;
      for (let iy = 0; iy < SDF_DIMS.ny; iy++) {
        const wy = iy * vs;
        const yBorder = iy <= 1 || iy >= SDF_DIMS.ny - 2;
        const rowBase = SDF_DIMS.nx * (iy + SDF_DIMS.ny * iz);
        for (let ix = 0; ix < SDF_DIMS.nx; ix++) {
          const xBorder = ix <= 1 || ix >= SDF_DIMS.nx - 2;
          const idx = ix + rowBase;
          if (xBorder || yBorder || zBorder) {
            this.values[idx] = BORDER_AIR_MIN;
            continue;
          }
          const wx = ix * vs;
          const d = evaluateThemeSdf(this.theme, wx, wy, wz, jitter, noise);
          this.values[idx] = Number.isFinite(d) ? d : BORDER_AIR_MIN;
        }
      }
    }
  }

  private markDirtyChunksForVoxel(
    ix: number,
    iy: number,
    iz: number,
    dirtyChunks: Set<string>,
  ): void {
    const cs = SDF_DIMS.chunkSize;
    const minCx = Math.max(0, Math.floor((ix - 2) / cs));
    const maxCx = Math.min(CHUNKS_X - 1, Math.floor((ix + 1) / cs));
    const minCy = Math.max(0, Math.floor((iy - 2) / cs));
    const maxCy = Math.min(CHUNKS_Y - 1, Math.floor((iy + 1) / cs));
    const minCz = Math.max(0, Math.floor((iz - 2) / cs));
    const maxCz = Math.min(CHUNKS_Z - 1, Math.floor((iz + 1) / cs));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          dirtyChunks.add(chunkKey(cx, cy, cz));
        }
      }
    }
  }
}
