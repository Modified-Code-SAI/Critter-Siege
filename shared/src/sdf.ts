import type {
  CarveOp,
  HazardType,
  MapScale,
  SdfDimensions,
  ThemeId,
  Vec3,
} from "./types.js";
import { createSeededRng } from "./rng.js";

/** Sculpted SDF voxel grid & chunk geometry presets for 2p Duel (60m) vs 4p Grand (144m). */
export const SDF_PRESETS = {
  duel: {
    nx: 80,
    ny: 36,
    nz: 80,
    voxelSize: 0.75,
    chunkSize: 16,
  },
  grand: {
    nx: 128,
    ny: 44,
    nz: 128,
    voxelSize: 1.125,
    chunkSize: 16,
  },
} as const satisfies Record<MapScale, SdfDimensions>;

/** Backward-compatible 60m Duel voxel grid & chunk geometry constants. */
export const SDF_DIMS = SDF_PRESETS.duel;

/** Chunk index triple identifying a single terrain chunk in the SDF grid. */
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
  const midRadius = Math.max(topRadius * 1.12, bottomRadius);
  let rAtY: number;
  if (t < 0.26) {
    const u = t / 0.26;
    const smoothU = u * u * (3 - 2 * u);
    rAtY = bottomRadius * 0.72 + (midRadius - bottomRadius * 0.72) * smoothU;
  } else {
    const u = (t - 0.26) / 0.74;
    const smoothU = u * u * (3 - 2 * u);
    rAtY = midRadius + (topRadius * 0.92 - midRadius) * smoothU;
  }
  const radial = Math.hypot(px - cx, pz - cz) - Math.max(0.1, rAtY - bevel);
  const halfH = Math.max(0.1, h * 0.5 - bevel);
  const midY = (bottomY + topY) * 0.5;
  const vertical = Math.abs(py - midY) - halfH;
  const outX = Math.max(radial, 0);
  const outY = Math.max(vertical, 0);
  return Math.hypot(outX, outY) + Math.min(Math.max(radial, vertical), 0) - bevel;
}

/**
 * Smooth sculpted destructible bastion wall / ridge fin between two XZ anchors,
 * featuring tapered sandstone flanks and a thinner central breach seam.
 */
function sdBastionWall(
  px: number,
  py: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  bottomY: number,
  topY: number,
  baseHalfThick: number,
  topHalfThick: number,
  bevel: number,
  seamPinchDepth = 0.22,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  const t =
    lenSq > 1e-8
      ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq))
      : 0;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  const distXZ = Math.hypot(px - cx, pz - cz);

  const h = Math.max(0.4, topY - bottomY);
  const v = Math.max(0, Math.min(1, (py - bottomY) / h));
  const smoothV = v * v * (3 - 2 * v);
  const seamFactor = 1.0 - seamPinchDepth * Math.sin(t * Math.PI);
  const halfThick =
    (baseHalfThick + (topHalfThick - baseHalfThick) * smoothV) * seamFactor;

  // Gentle organic ridge crest profile peaking slightly near the inner buttress & tips
  const crestWave = Math.sin(t * Math.PI * 2.0) * 0.35;
  const effTopY = topY + crestWave;
  const effH = Math.max(0.4, effTopY - bottomY);
  const midY = (bottomY + effTopY) * 0.5;

  const horiz = distXZ - Math.max(0.25, halfThick - bevel);
  const halfH = Math.max(0.25, effH * 0.5 - bevel);
  const vert = Math.abs(py - midY) - halfH;
  const outX = Math.max(horiz, 0);
  const outY = Math.max(vert, 0);
  return Math.hypot(outX, outY) + Math.min(Math.max(horiz, vert), 0) - bevel;
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

interface ThemeLayoutContext {
  cx: number;
  cz: number;
  halfSpan: number;
  worldHeight: number;
  wScale: number;
  hScale: number;
  isGrand: boolean;
  bottomY: number;
  spawnTopY: number;
  wallTopY: number;
  centralPeakY: number;
  tunnelY: number;
}

function evaluateThemeSdf(
  theme: ThemeId,
  x: number,
  y: number,
  z: number,
  ctx: ThemeLayoutContext,
  j: ThemeJitter,
  noise: (nx: number, ny: number, nz: number) => number,
): number {
  const {
    cx,
    cz,
    halfSpan,
    worldHeight,
    wScale,
    hScale,
    isGrand,
    bottomY,
    spawnTopY,
    wallTopY,
    centralPeakY,
    tunnelY,
  } = ctx;

  // Normalized radial coordinates u, v in ~[-1..1] across the playable island
  const u = (x - cx) / halfSpan;
  const v = (z - cz) / halfSpan;

  const n1 = noise(u * 3.4, (y / hScale) * 0.15, v * 3.4);
  const n2 = noise(
    u * 7.6 + 17.3,
    (y / hScale) * 0.29 + 5.1,
    v * 7.6 - 11.7,
  );
  const noiseAmp = isGrand ? 0.56 : 0.4;
  const organicNoise = (n1 * 0.72 + n2 * 0.28) * noiseAmp;

  const bevel = 1.15 * Math.min(1.65, wScale * 0.6 + 0.4);
  const wallBaseThick = isGrand ? 4.6 : 2.5;
  const wallTopThick = isGrand ? 3.1 : 1.72;
  const wallBevel = isGrand ? 1.1 : 0.75;
  const passY = worldHeight * 0.165;
  const passRadius = isGrand ? 2.55 : 1.55;
  const unionK = isGrand ? 3.4 : 1.7;
  const wallBottomY = Math.max(0.5, bottomY - 0.7);
  const plugBaseHalfThick = isGrand ? 1.85 : 1.48;
  const plugTopHalfThick = isGrand ? 1.55 : 1.24;
  const plugBevel = isGrand ? 0.55 : 0.42;
  const plugSpan = passRadius * 1.25;
  const plugTopY = passY + (isGrand ? 4.1 : 3.3);

  // Helper converting normalized (nu, nv) into world (x, z)
  const wx = (nu: number): number => cx + nu * halfSpan;
  const wz = (nv: number): number => cz + nv * halfSpan;

  const evalGatePlugs = (passOffset: number): number => {
    const bound = plugBaseHalfThick + 2.5;
    const dxCenter = Math.abs(x - cx);
    const dzCenter = Math.abs(z - cz);
    if (y > plugTopY + 2.5 || (dxCenter > bound && dzCenter > bound)) {
      return 10.0;
    }
    let best = 10.0;
    if (dxCenter <= bound) {
      const nPlug = sdBastionWall(
        x,
        y,
        z,
        cx,
        wz(-passOffset) - plugSpan,
        cx,
        wz(-passOffset) + plugSpan,
        wallBottomY,
        plugTopY,
        plugBaseHalfThick,
        plugTopHalfThick,
        plugBevel,
        0.06,
      );
      const sPlug = sdBastionWall(
        x,
        y,
        z,
        cx,
        wz(passOffset) - plugSpan,
        cx,
        wz(passOffset) + plugSpan,
        wallBottomY,
        plugTopY,
        plugBaseHalfThick,
        plugTopHalfThick,
        plugBevel,
        0.06,
      );
      best = Math.min(best, nPlug, sPlug);
    }
    if (dzCenter <= bound) {
      const wPlug = sdBastionWall(
        x,
        y,
        z,
        wx(-passOffset) - plugSpan,
        cz,
        wx(-passOffset) + plugSpan,
        cz,
        wallBottomY,
        plugTopY,
        plugBaseHalfThick,
        plugTopHalfThick,
        plugBevel,
        0.06,
      );
      const ePlug = sdBastionWall(
        x,
        y,
        z,
        wx(passOffset) - plugSpan,
        cz,
        wx(passOffset) + plugSpan,
        cz,
        wallBottomY,
        plugTopY,
        plugBaseHalfThick,
        plugTopHalfThick,
        plugBevel,
        0.06,
      );
      best = Math.min(best, wPlug, ePlug);
    }
    return best;
  };

  if (theme === "emerald_spire") {
    // 1. 4 sheltered quadrant emerald fort basins (NE, SW, NW, SE)
    const basinBotR = 0.22 * halfSpan;
    const basinTopR = 0.35 * halfSpan;
    const nwBasin = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.6 + j.northShift * 0.03),
      wz(-0.6),
      bottomY,
      spawnTopY + j.westHeight * 0.45,
      basinBotR,
      basinTopR,
      bevel,
    );
    const neBasin = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.6 + j.southShift * 0.03),
      wz(-0.6),
      bottomY,
      spawnTopY + 0.25 + j.eastHeight * 0.45,
      basinBotR,
      basinTopR,
      bevel,
    );
    const swBasin = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.6 - j.southShift * 0.025),
      wz(0.6),
      bottomY,
      spawnTopY + 0.15 + j.eastHeight * 0.35,
      basinBotR,
      basinTopR,
      bevel,
    );
    const seBasin = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.6 - j.northShift * 0.025),
      wz(0.6),
      bottomY,
      spawnTopY + 0.35 + j.westHeight * 0.35,
      basinBotR,
      basinTopR,
      bevel,
    );

    // 2. Stepped inner terraces & coastal sandy coves near waterline for flanking paths
    const coveTop = Math.max(bottomY + 1.3, worldHeight * 0.13);
    const terraceTop = worldHeight * 0.24;
    const nwCove = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.34),
      wz(-0.34),
      bottomY - 0.15,
      coveTop,
      0.15 * halfSpan,
      0.2 * halfSpan,
      bevel * 0.7,
    );
    const seCove = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.34),
      wz(0.34),
      bottomY - 0.15,
      coveTop,
      0.15 * halfSpan,
      0.2 * halfSpan,
      bevel * 0.7,
    );
    const neTerrace = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.35),
      wz(-0.35),
      bottomY,
      terraceTop,
      0.14 * halfSpan,
      0.2 * halfSpan,
      bevel * 0.8,
    );
    const swTerrace = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.35),
      wz(0.35),
      bottomY,
      terraceTop,
      0.14 * halfSpan,
      0.2 * halfSpan,
      bevel * 0.8,
    );

    // 3. Massive Central Emerald Citadel Spire (65-68% of worldHeight) + beach apron
    const centralSpire = sdTaperedPlateau(
      x,
      y,
      z,
      cx,
      cz,
      bottomY,
      centralPeakY + j.archBoost * 0.35,
      0.175 * halfSpan,
      0.2 * halfSpan,
      bevel,
    );
    const spireApron = sdTaperedPlateau(
      x,
      y,
      z,
      cx,
      cz,
      bottomY - 0.15,
      coveTop,
      0.22 * halfSpan,
      0.27 * halfSpan,
      bevel * 0.65,
    );

    // 4. 4 tall full-width radiating destructible bastion walls directly dividing NW/NE/SW/SE basins
    //    Extended past the outer shoreline into sheer coastal cliffs (zero coastal walk-around)
    const northWall = sdBastionWall(
      x,
      y,
      z,
      cx,
      wz(-0.08),
      cx,
      wz(-1.07),
      wallBottomY,
      wallTopY + j.westHeight * 0.25,
      wallBaseThick,
      wallTopThick,
      wallBevel,
    );
    const southWall = sdBastionWall(
      x,
      y,
      z,
      cx,
      wz(0.08),
      cx,
      wz(1.07),
      wallBottomY,
      wallTopY + j.eastHeight * 0.25,
      wallBaseThick,
      wallTopThick,
      wallBevel,
    );
    const westWall = sdBastionWall(
      x,
      y,
      z,
      wx(-0.08),
      cz,
      wx(-1.07),
      cz,
      wallBottomY,
      wallTopY + j.eastHeight * 0.2,
      wallBaseThick,
      wallTopThick,
      wallBevel,
    );
    const eastWall = sdBastionWall(
      x,
      y,
      z,
      wx(0.08),
      cz,
      wx(1.07),
      cz,
      wallBottomY,
      wallTopY + j.westHeight * 0.2,
      wallBaseThick,
      wallTopThick,
      wallBevel,
    );

    // 5. Two narrow curved diagonal stone arches crossing over the terraces via central spire
    const archWidth = isGrand ? 3.8 : 2.05;
    const archThick = isGrand ? 2.2 : 1.3;
    const diagArchA = sdStoneArch(
      x,
      y,
      z,
      wx(-0.54),
      wz(-0.54),
      wx(0.54),
      wz(0.54),
      spawnTopY + 1.0,
      centralPeakY - 0.5,
      archWidth,
      archThick,
    );
    const diagArchB = sdStoneArch(
      x,
      y,
      z,
      wx(-0.54),
      wz(0.54),
      wx(0.54),
      wz(-0.54),
      spawnTopY + 1.0,
      centralPeakY - 0.7,
      archWidth,
      archThick,
    );

    let d = smin(nwBasin, neBasin, unionK);
    d = smin(d, swBasin, unionK);
    d = smin(d, seBasin, unionK);
    d = smin(d, nwCove, unionK * 0.75);
    d = smin(d, seCove, unionK * 0.75);
    d = smin(d, neTerrace, unionK * 0.8);
    d = smin(d, swTerrace, unionK * 0.8);
    d = smin(d, centralSpire, unionK * 0.9);
    d = smin(d, spireApron, unionK * 0.65);
    d = smin(d, northWall, unionK * 0.7);
    d = smin(d, southWall, unionK * 0.7);
    d = smin(d, westWall, unionK * 0.7);
    d = smin(d, eastWall, unionK * 0.7);
    d = smin(d, diagArchA, unionK * 0.55);
    d = smin(d, diagArchB, unionK * 0.55);

    // 6. Carved pass-through cave tunnel straight through the central pinnacle's base
    const spireTunnelR = isGrand ? 3.8 : 2.3;
    const spireTunnel =
      distToSegment(
        x,
        y,
        z,
        wx(-0.34),
        tunnelY,
        cz,
        wx(0.34),
        tunnelY,
        cz,
      ) - spireTunnelR;
    d = smax(d, -spireTunnel, isGrand ? 1.1 : 0.65);

    // 7. Carved lower arched passes through the 4 radiating walls, sealed by thin destructible rock gate plugs
    const nPass =
      distToSegment(
        x,
        y,
        z,
        wx(-0.2),
        passY,
        wz(-0.58),
        wx(0.2),
        passY,
        wz(-0.58),
      ) - passRadius;
    const sPass =
      distToSegment(
        x,
        y,
        z,
        wx(-0.2),
        passY,
        wz(0.58),
        wx(0.2),
        passY,
        wz(0.58),
      ) - passRadius;
    const wPass =
      distToSegment(
        x,
        y,
        z,
        wx(-0.58),
        passY,
        wz(-0.2),
        wx(-0.58),
        passY,
        wz(0.2),
      ) - passRadius;
    const ePass =
      distToSegment(
        x,
        y,
        z,
        wx(0.58),
        passY,
        wz(-0.2),
        wx(0.58),
        passY,
        wz(0.2),
      ) - passRadius;

    d = smax(d, -nPass, 0.65);
    d = smax(d, -sPass, 0.65);
    d = smax(d, -wPass, 0.65);
    d = smax(d, -ePass, 0.65);
    d = smin(d, evalGatePlugs(0.58), isGrand ? 0.5 : 0.35);

    // Subtle floating-island skirt taper near outer archipelago rim (preserving sheer coastal bastion walls)
    const radialNorm = Math.hypot(u, v);
    const wallAxisRelief = Math.max(
      0,
      1 - Math.min(Math.abs(u), Math.abs(v)) / 0.18,
    );
    const skirtStart = 0.94 + wallAxisRelief * 0.14;
    const skirtCut =
      wallBottomY - y + Math.max(0, radialNorm - skirtStart) * halfSpan * 0.28;
    d = smax(d, skirtCut, 0.85);
    return d + organicNoise;
  }

  if (theme === "canyon_arch") {
    // Grand Redrock Gatehouse Canyon: 4 terraced sandstone mesas framing a towering
    // central redrock massif, 4 arched stone gatehouses dividing the quadrants, and
    // sweeping natural stone arches overhead.
    const mesaBotR = 0.23 * halfSpan;
    const mesaTopR = 0.36 * halfSpan;
    const nwMesa = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.6),
      wz(-0.6),
      bottomY,
      spawnTopY + 0.3 + j.westHeight * 0.45,
      mesaBotR,
      mesaTopR,
      bevel,
    );
    const neMesa = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.6),
      wz(-0.6),
      bottomY,
      spawnTopY + 0.4 + j.eastHeight * 0.45,
      mesaBotR,
      mesaTopR,
      bevel,
    );
    const swMesa = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.6),
      wz(0.6),
      bottomY,
      spawnTopY + 0.1 + j.eastHeight * 0.35,
      mesaBotR,
      mesaTopR,
      bevel,
    );
    const seMesa = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.6),
      wz(0.6),
      bottomY,
      spawnTopY + 0.2 + j.westHeight * 0.35,
      mesaBotR,
      mesaTopR,
      bevel,
    );

    // Low sandy canyon valley floor & switchback ledges inside the gorges
    const valleyTop = Math.max(bottomY + 1.25, worldHeight * 0.125);
    const switchTop = worldHeight * 0.235;
    const valleyFloor = sdTaperedPlateau(
      x,
      y,
      z,
      cx,
      cz,
      bottomY - 0.15,
      valleyTop,
      0.34 * halfSpan,
      0.4 * halfSpan,
      bevel * 0.75,
    );
    const nwSwitch = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.34),
      wz(-0.34),
      bottomY,
      switchTop,
      0.13 * halfSpan,
      0.19 * halfSpan,
      bevel * 0.8,
    );
    const neSwitch = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.34),
      wz(-0.34),
      bottomY,
      switchTop,
      0.13 * halfSpan,
      0.19 * halfSpan,
      bevel * 0.8,
    );
    const swSwitch = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.34),
      wz(0.34),
      bottomY,
      switchTop,
      0.13 * halfSpan,
      0.19 * halfSpan,
      bevel * 0.8,
    );
    const seSwitch = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.34),
      wz(0.34),
      bottomY,
      switchTop,
      0.13 * halfSpan,
      0.19 * halfSpan,
      bevel * 0.8,
    );

    // Massive Central Redrock Citadel Massif (64-68% of worldHeight)
    const centralMassif = sdTaperedPlateau(
      x,
      y,
      z,
      cx,
      cz,
      bottomY,
      centralPeakY - 0.2 + j.archBoost * 0.35,
      0.22 * halfSpan,
      0.26 * halfSpan,
      bevel,
    );

    // 4 Towering Full-Width Redrock Stone Gatehouse Walls extending out into sheer coastal cliffs
    const gateTop = wallTopY + 0.35;
    const northGate = sdBastionWall(
      x,
      y,
      z,
      cx,
      wz(-0.08),
      cx,
      wz(-1.07),
      wallBottomY,
      gateTop,
      wallBaseThick * 1.06,
      wallTopThick * 1.02,
      wallBevel,
      0.2,
    );
    const southGate = sdBastionWall(
      x,
      y,
      z,
      cx,
      wz(0.08),
      cx,
      wz(1.07),
      wallBottomY,
      gateTop,
      wallBaseThick * 1.06,
      wallTopThick * 1.02,
      wallBevel,
      0.2,
    );
    const westGate = sdBastionWall(
      x,
      y,
      z,
      wx(-0.08),
      cz,
      wx(-1.07),
      cz,
      wallBottomY,
      gateTop,
      wallBaseThick * 1.06,
      wallTopThick * 1.02,
      wallBevel,
      0.2,
    );
    const eastGate = sdBastionWall(
      x,
      y,
      z,
      wx(0.08),
      cz,
      wx(1.07),
      cz,
      wallBottomY,
      gateTop,
      wallBaseThick * 1.06,
      wallTopThick * 1.02,
      wallBevel,
      0.2,
    );

    // Sweeping natural canyon arches spanning North & South gorges
    const grandArchS = sdStoneArch(
      x,
      y,
      z,
      wx(-0.56),
      wz(0.46),
      wx(0.56),
      wz(0.46),
      spawnTopY + 0.8,
      centralPeakY + 0.2 + j.archBoost * 0.3,
      isGrand ? 4.4 : 2.35,
      isGrand ? 2.4 : 1.45,
    );
    const grandArchN = sdStoneArch(
      x,
      y,
      z,
      wx(-0.56),
      wz(-0.46),
      wx(0.56),
      wz(-0.46),
      spawnTopY + 0.8,
      centralPeakY - 0.3,
      isGrand ? 4.2 : 2.25,
      isGrand ? 2.3 : 1.4,
    );

    let d = smin(nwMesa, neMesa, unionK);
    d = smin(d, swMesa, unionK);
    d = smin(d, seMesa, unionK);
    d = smin(d, valleyFloor, unionK * 0.7);
    d = smin(d, nwSwitch, unionK * 0.75);
    d = smin(d, neSwitch, unionK * 0.75);
    d = smin(d, swSwitch, unionK * 0.75);
    d = smin(d, seSwitch, unionK * 0.75);
    d = smin(d, centralMassif, unionK * 0.9);
    d = smin(d, northGate, unionK * 0.7);
    d = smin(d, southGate, unionK * 0.7);
    d = smin(d, westGate, unionK * 0.7);
    d = smin(d, eastGate, unionK * 0.7);
    d = smin(d, grandArchS, unionK * 0.6);
    d = smin(d, grandArchN, unionK * 0.6);

    // Lower cave bypass tunnel running beneath the central redrock citadel
    const canyonCaveR = isGrand ? 3.5 : 2.1;
    const caveEW =
      distToSegment(
        x,
        y,
        z,
        wx(-0.34),
        tunnelY,
        cz,
        wx(0.34),
        tunnelY,
        cz,
      ) - canyonCaveR;
    d = smax(d, -caveEW, isGrand ? 1.0 : 0.65);

    // Carved lower stone gatehouse doorways beneath the 4 dividing walls, sealed with destructible plugs
    const gDoorN =
      distToSegment(
        x,
        y,
        z,
        wx(-0.2),
        passY,
        wz(-0.62),
        wx(0.2),
        passY,
        wz(-0.62),
      ) - passRadius;
    const gDoorS =
      distToSegment(
        x,
        y,
        z,
        wx(-0.2),
        passY,
        wz(0.62),
        wx(0.2),
        passY,
        wz(0.62),
      ) - passRadius;
    const gDoorW =
      distToSegment(
        x,
        y,
        z,
        wx(-0.62),
        passY,
        wz(-0.2),
        wx(-0.62),
        passY,
        wz(0.2),
      ) - passRadius;
    const gDoorE =
      distToSegment(
        x,
        y,
        z,
        wx(0.62),
        passY,
        wz(-0.2),
        wx(0.62),
        passY,
        wz(0.2),
      ) - passRadius;

    d = smax(d, -gDoorN, 0.7);
    d = smax(d, -gDoorS, 0.7);
    d = smax(d, -gDoorW, 0.7);
    d = smax(d, -gDoorE, 0.7);
    d = smin(d, evalGatePlugs(0.62), isGrand ? 0.5 : 0.35);

    // Sheltered carved canyon wall alcoves inside the inner mesa flanks
    const alcoveRX = 0.12 * halfSpan;
    const alcoveRY = 0.08 * worldHeight;
    const alcoveRZ = 0.14 * halfSpan;
    const westAlcove = sdEllipsoid(
      x,
      y,
      z,
      wx(-0.36),
      passY + 1.2 * hScale,
      wz(0.0),
      alcoveRX,
      alcoveRY,
      alcoveRZ,
    );
    const eastAlcove = sdEllipsoid(
      x,
      y,
      z,
      wx(0.36),
      passY + 1.2 * hScale,
      wz(0.0),
      alcoveRX,
      alcoveRY,
      alcoveRZ,
    );
    d = smax(d, -westAlcove, 0.8);
    d = smax(d, -eastAlcove, 0.8);

    return d + organicNoise;
  }

  if (theme === "mountain_spine") {
    // 'mountain_spine' (Swiss Cheese Multi-Story Mountain Corridor):
    // Winding narrow alpine spine with steep ocean flank drop-offs, staggered terraced
    // mountain perches, multi-story stacked caves, 2 stacked stone bridges, and thick
    // destructible rock peaks between every player.
    const ledgeBotR = 0.2 * halfSpan;
    const ledgeTopR = 0.32 * halfSpan;
    const nwLedge = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.6 + j.northShift * 0.025),
      wz(-0.59),
      bottomY,
      spawnTopY - 0.1 + j.westHeight * 0.35,
      ledgeBotR,
      ledgeTopR,
      bevel * 0.85,
    );
    const neLedge = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.6 + j.southShift * 0.025),
      wz(-0.58),
      bottomY,
      spawnTopY + 0.55 + j.eastHeight * 0.35,
      ledgeBotR,
      ledgeTopR,
      bevel * 0.85,
    );
    const swLedge = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.6 - j.southShift * 0.02),
      wz(0.58),
      bottomY,
      spawnTopY + 0.4 + j.eastHeight * 0.3,
      ledgeBotR,
      ledgeTopR,
      bevel * 0.85,
    );
    const seLedge = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.6 - j.northShift * 0.02),
      wz(0.59),
      bottomY,
      spawnTopY + 0.15 + j.westHeight * 0.3,
      ledgeBotR,
      ledgeTopR,
      bevel * 0.85,
    );

    // Narrow terraced alpine switchbacks hugging the inner gorge
    const lowTerraceY = Math.max(bottomY + 1.35, worldHeight * 0.14);
    const midTerraceY = worldHeight * 0.26;
    const nwTerrace = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.35),
      wz(-0.32),
      bottomY - 0.1,
      lowTerraceY,
      0.13 * halfSpan,
      0.18 * halfSpan,
      bevel * 0.65,
    );
    const seTerrace = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.35),
      wz(0.32),
      bottomY - 0.1,
      lowTerraceY,
      0.13 * halfSpan,
      0.18 * halfSpan,
      bevel * 0.65,
    );
    const neTerrace = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.34),
      wz(-0.36),
      bottomY,
      midTerraceY,
      0.12 * halfSpan,
      0.17 * halfSpan,
      bevel * 0.7,
    );
    const swTerrace = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.34),
      wz(0.36),
      bottomY,
      midTerraceY,
      0.12 * halfSpan,
      0.17 * halfSpan,
      bevel * 0.7,
    );

    // Towering Central Alpine Summit Crag + Winding S-Curve Spine Shoulders
    const summitPeak = sdTaperedPlateau(
      x,
      y,
      z,
      cx,
      cz,
      bottomY,
      Math.min(worldHeight - 2.6 * hScale, centralPeakY + 1.25 * hScale + j.archBoost * 0.25),
      0.21 * halfSpan,
      0.24 * halfSpan,
      bevel * 0.9,
    );
    const westShoulder = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.24),
      wz(0.16),
      bottomY,
      centralPeakY + 0.3 * hScale + j.westHeight * 0.25,
      0.15 * halfSpan,
      0.19 * halfSpan,
      bevel * 0.85,
    );
    const eastShoulder = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.24),
      wz(-0.16),
      bottomY,
      centralPeakY + 0.45 * hScale + j.eastHeight * 0.25,
      0.15 * halfSpan,
      0.19 * halfSpan,
      bevel * 0.85,
    );

    // Thick winding spine ridge linking the shoulders across the central summit
    const spineCoreWall = sdBastionWall(
      x,
      y,
      z,
      wx(-0.28),
      wz(0.18),
      wx(0.28),
      wz(-0.18),
      wallBottomY,
      centralPeakY + 0.4 * hScale,
      wallBaseThick * 1.18,
      wallTopThick * 1.1,
      wallBevel,
      0.1,
    );

    // 4 Towering Full-Width Destructible Mountain Ridge Barriers extending to sheer coastal cliffs
    const ridgeTop = wallTopY + 0.65 * hScale;
    const northRidge = sdBastionWall(
      x,
      y,
      z,
      cx,
      wz(-0.08),
      cx,
      wz(-1.07),
      wallBottomY,
      ridgeTop + j.westHeight * 0.2,
      wallBaseThick * 1.08,
      wallTopThick * 1.02,
      wallBevel,
      0.18,
    );
    const southRidge = sdBastionWall(
      x,
      y,
      z,
      cx,
      wz(0.08),
      cx,
      wz(1.07),
      wallBottomY,
      ridgeTop + j.eastHeight * 0.2,
      wallBaseThick * 1.08,
      wallTopThick * 1.02,
      wallBevel,
      0.18,
    );
    const westRidge = sdBastionWall(
      x,
      y,
      z,
      wx(-0.08),
      cz,
      wx(-1.07),
      cz,
      wallBottomY,
      ridgeTop + j.eastHeight * 0.2,
      wallBaseThick * 1.08,
      wallTopThick * 1.02,
      wallBevel,
      0.18,
    );
    const eastRidge = sdBastionWall(
      x,
      y,
      z,
      wx(0.08),
      cz,
      wx(1.07),
      cz,
      wallBottomY,
      ridgeTop + j.westHeight * 0.2,
      wallBaseThick * 1.08,
      wallTopThick * 1.02,
      wallBevel,
      0.18,
    );

    // 2 Stacked Stone Bridges: Lower canyon arch (SW <-> NE) + High sky-bridge (NW <-> SE)
    const bridgeW = isGrand ? 3.7 : 2.05;
    const bridgeT = isGrand ? 2.0 : 1.2;
    const lowerBridge = sdStoneArch(
      x,
      y,
      z,
      wx(-0.52),
      wz(0.48),
      wx(0.52),
      wz(-0.48),
      spawnTopY - 0.1,
      worldHeight * 0.34,
      bridgeW,
      bridgeT,
    );
    const upperBridge = sdStoneArch(
      x,
      y,
      z,
      wx(-0.54),
      wz(-0.5),
      wx(0.54),
      wz(0.5),
      spawnTopY + 1.2 * hScale,
      centralPeakY - 0.45 * hScale,
      bridgeW * 0.94,
      bridgeT,
    );

    let d = smin(nwLedge, neLedge, unionK * 0.9);
    d = smin(d, swLedge, unionK * 0.9);
    d = smin(d, seLedge, unionK * 0.9);
    d = smin(d, nwTerrace, unionK * 0.7);
    d = smin(d, seTerrace, unionK * 0.7);
    d = smin(d, neTerrace, unionK * 0.7);
    d = smin(d, swTerrace, unionK * 0.7);
    d = smin(d, summitPeak, unionK * 0.85);
    d = smin(d, westShoulder, unionK * 0.8);
    d = smin(d, eastShoulder, unionK * 0.8);
    d = smin(d, spineCoreWall, unionK * 0.75);
    d = smin(d, northRidge, unionK * 0.65);
    d = smin(d, southRidge, unionK * 0.65);
    d = smin(d, westRidge, unionK * 0.65);
    d = smin(d, eastRidge, unionK * 0.65);
    d = smin(d, lowerBridge, unionK * 0.5);
    d = smin(d, upperBridge, unionK * 0.5);

    // Multi-story "Swiss Cheese" Stacked Caves carved straight through the alpine spine!
    // Story 1: Lower East-West cavern tunnel at tunnelY (0.20 * worldHeight)
    const lowerCaveR = isGrand ? 3.55 : 2.15;
    const lowerCave =
      distToSegment(
        x,
        y,
        z,
        wx(-0.42),
        tunnelY,
        cz,
        wx(0.42),
        tunnelY,
        cz,
      ) - lowerCaveR;
    d = smax(d, -lowerCave, isGrand ? 0.95 : 0.6);

    // Story 2: Upper North-South cross-cave gallery at 0.42 * worldHeight (leaving solid summit overhead!)
    const upperCaveY = worldHeight * 0.42;
    const upperCaveR = isGrand ? 3.05 : 1.85;
    const upperCave =
      distToSegment(
        x,
        y,
        z,
        cx,
        upperCaveY,
        wz(-0.38),
        cx,
        upperCaveY,
        wz(0.38),
      ) - upperCaveR;
    d = smax(d, -upperCave, isGrand ? 0.85 : 0.55);

    // Mid-level flank chambers hollowed inside the twin spine shoulders
    const shoulderCaveY = worldHeight * 0.3;
    const shoulderCaveR = isGrand ? 2.8 : 1.7;
    const westShoulderCave =
      distToSegment(
        x,
        y,
        z,
        wx(-0.38),
        shoulderCaveY,
        wz(0.06),
        wx(-0.12),
        shoulderCaveY,
        wz(0.28),
      ) - shoulderCaveR;
    const eastShoulderCave =
      distToSegment(
        x,
        y,
        z,
        wx(0.12),
        shoulderCaveY,
        wz(-0.28),
        wx(0.38),
        shoulderCaveY,
        wz(-0.06),
      ) - shoulderCaveR;
    d = smax(d, -westShoulderCave, 0.55);
    d = smax(d, -eastShoulderCave, 0.55);

    // Carved lower arched mountain passes through the 4 dividing walls, sealed with destructible rock plugs
    const mPassN =
      distToSegment(
        x,
        y,
        z,
        wx(-0.2),
        passY,
        wz(-0.58),
        wx(0.2),
        passY,
        wz(-0.58),
      ) - passRadius;
    const mPassS =
      distToSegment(
        x,
        y,
        z,
        wx(-0.2),
        passY,
        wz(0.58),
        wx(0.2),
        passY,
        wz(0.58),
      ) - passRadius;
    const mPassW =
      distToSegment(
        x,
        y,
        z,
        wx(-0.58),
        passY,
        wz(-0.2),
        wx(-0.58),
        passY,
        wz(0.2),
      ) - passRadius;
    const mPassE =
      distToSegment(
        x,
        y,
        z,
        wx(0.58),
        passY,
        wz(-0.2),
        wx(0.58),
        passY,
        wz(0.2),
      ) - passRadius;

    d = smax(d, -mPassN, 0.65);
    d = smax(d, -mPassS, 0.65);
    d = smax(d, -mPassW, 0.65);
    d = smax(d, -mPassE, 0.65);
    d = smin(d, evalGatePlugs(0.58), isGrand ? 0.5 : 0.35);

    // Steep ocean flank drop-offs along the outer corners (preserving sheer coastal divider walls)
    const radialNorm = Math.hypot(u, v);
    const wallAxisRelief = Math.max(
      0,
      1 - Math.min(Math.abs(u), Math.abs(v)) / 0.16,
    );
    const flankSkirtStart = 0.89 + wallAxisRelief * 0.19;
    const flankDrop =
      wallBottomY - y + Math.max(0, radialNorm - flankSkirtStart) * halfSpan * 0.36;
    d = smax(d, flankDrop, 0.8);

    return d + organicNoise;
  }

  // 'twin_pillars' (Sky Twin Citadels): 4 outer sky-atoll basins separated by towering
  // cliff battlement walls & sea-stacks, flanking twin cliff citadels joined by a sky-wall.
  const atollBotR = 0.21 * halfSpan;
  const atollTopR = 0.34 * halfSpan;
  const nwAtoll = sdTaperedPlateau(
    x,
    y,
    z,
    wx(-0.61),
    wz(-0.6 + j.northShift * 0.025),
    bottomY,
    spawnTopY - 0.1 + j.westHeight * 0.4,
    atollBotR,
    atollTopR,
    bevel,
  );
  const neAtoll = sdTaperedPlateau(
    x,
    y,
    z,
    wx(0.61),
    wz(-0.6 + j.southShift * 0.025),
    bottomY,
    spawnTopY + 0.1 + j.eastHeight * 0.4,
    atollBotR,
    atollTopR,
    bevel,
  );
  const swAtoll = sdTaperedPlateau(
    x,
    y,
    z,
    wx(-0.61),
    wz(0.6 - j.southShift * 0.025),
    bottomY,
    spawnTopY + j.eastHeight * 0.3,
    atollBotR,
    atollTopR,
    bevel,
  );
  const seAtoll = sdTaperedPlateau(
    x,
    y,
    z,
    wx(0.61),
    wz(0.6 - j.northShift * 0.025),
    bottomY,
    spawnTopY + 0.2 + j.westHeight * 0.3,
    atollBotR,
    atollTopR,
    bevel,
  );

  // Twin towering central cliff fortresses + solid central citadel sky-wall bridge
  const westPillar = sdTaperedPlateau(
    x,
    y,
    z,
    wx(-0.17),
    wz(-0.04),
    bottomY,
    centralPeakY + 0.25 + j.westHeight * 0.3,
    0.16 * halfSpan,
    0.2 * halfSpan,
    bevel * 0.9,
  );
  const eastPillar = sdTaperedPlateau(
    x,
    y,
    z,
    wx(0.17),
    wz(0.04),
    bottomY,
    centralPeakY + 0.4 + j.eastHeight * 0.3,
    0.16 * halfSpan,
    0.2 * halfSpan,
    bevel * 0.9,
  );
  const centralSkyWall = sdBastionWall(
    x,
    y,
    z,
    wx(-0.2),
    wz(-0.05),
    wx(0.2),
    wz(0.05),
    bottomY,
    centralPeakY - 0.1,
    wallBaseThick * 1.15,
    wallTopThick * 1.15,
    wallBevel,
    0.12,
  );

  // 4 Tall Full-Width Radiating Cliff Battlement Walls extending past the shoreline into sheer cliffs
  const battlementTop = wallTopY + 0.15;
  const nBattlement = sdBastionWall(
    x,
    y,
    z,
    cx,
    wz(-0.08),
    cx,
    wz(-1.07),
    wallBottomY,
    battlementTop,
    wallBaseThick,
    wallTopThick,
    wallBevel,
  );
  const sBattlement = sdBastionWall(
    x,
    y,
    z,
    cx,
    wz(0.08),
    cx,
    wz(1.07),
    wallBottomY,
    battlementTop,
    wallBaseThick,
    wallTopThick,
    wallBevel,
  );
  const wBattlement = sdBastionWall(
    x,
    y,
    z,
    wx(-0.08),
    cz,
    wx(-1.07),
    cz,
    wallBottomY,
    battlementTop,
    wallBaseThick,
    wallTopThick,
    wallBevel,
  );
  const eBattlement = sdBastionWall(
    x,
    y,
    z,
    wx(0.08),
    cz,
    wx(1.07),
    cz,
    wallBottomY,
    battlementTop,
    wallBaseThick,
    wallTopThick,
    wallBevel,
  );

  // Sandy coastal coves & scenic overhanging cliff ledges
  const coveTop = Math.max(bottomY + 1.25, worldHeight * 0.125);
  const nwBeach = sdTaperedPlateau(
    x,
    y,
    z,
    wx(-0.36),
    wz(-0.34),
    bottomY - 0.15,
    coveTop,
    0.14 * halfSpan,
    0.2 * halfSpan,
    bevel * 0.7,
  );
  const seBeach = sdTaperedPlateau(
    x,
    y,
    z,
    wx(0.36),
    wz(0.34),
    bottomY - 0.15,
    coveTop,
    0.14 * halfSpan,
    0.2 * halfSpan,
    bevel * 0.7,
  );
  const neLedge = sdEllipsoid(
    x,
    y,
    z,
    wx(0.38),
    worldHeight * 0.31,
    wz(-0.35),
    0.16 * halfSpan,
    0.055 * worldHeight,
    0.15 * halfSpan,
  );
  const swLedge = sdEllipsoid(
    x,
    y,
    z,
    wx(-0.38),
    worldHeight * 0.3,
    wz(0.35),
    0.16 * halfSpan,
    0.055 * worldHeight,
    0.15 * halfSpan,
  );

  // Narrow elevated stone sky-bridges linking outer atolls to the twin citadels
  const brW = isGrand ? 3.5 : 1.95;
  const brT = isGrand ? 2.0 : 1.2;
  const nwBridge = sdStoneArch(
    x,
    y,
    z,
    wx(-0.55),
    wz(-0.52),
    wx(-0.18),
    wz(-0.06),
    spawnTopY + 0.5,
    wallTopY - 1.4,
    brW,
    brT,
  );
  const swBridge = sdStoneArch(
    x,
    y,
    z,
    wx(-0.55),
    wz(0.52),
    wx(-0.18),
    wz(0.02),
    spawnTopY + 0.5,
    wallTopY - 1.5,
    brW,
    brT,
  );
  const neBridge = sdStoneArch(
    x,
    y,
    z,
    wx(0.55),
    wz(-0.52),
    wx(0.18),
    wz(-0.02),
    spawnTopY + 0.5,
    wallTopY - 1.3,
    brW,
    brT,
  );
  const seBridge = sdStoneArch(
    x,
    y,
    z,
    wx(0.55),
    wz(0.52),
    wx(0.18),
    wz(0.06),
    spawnTopY + 0.5,
    wallTopY - 1.3,
    brW,
    brT,
  );

  let d = smin(nwAtoll, neAtoll, unionK);
  d = smin(d, swAtoll, unionK);
  d = smin(d, seAtoll, unionK);
  d = smin(d, westPillar, unionK * 0.85);
  d = smin(d, eastPillar, unionK * 0.85);
  d = smin(d, centralSkyWall, unionK * 0.75);
  d = smin(d, nBattlement, unionK * 0.7);
  d = smin(d, sBattlement, unionK * 0.7);
  d = smin(d, wBattlement, unionK * 0.7);
  d = smin(d, eBattlement, unionK * 0.7);
  d = smin(d, nwBeach, unionK * 0.65);
  d = smin(d, seBeach, unionK * 0.65);
  d = smin(d, neLedge, unionK * 0.6);
  d = smin(d, swLedge, unionK * 0.6);
  d = smin(d, nwBridge, unionK * 0.5);
  d = smin(d, swBridge, unionK * 0.5);
  d = smin(d, neBridge, unionK * 0.5);
  d = smin(d, seBridge, unionK * 0.5);

  // Carved sea-cave bypass tunnels through the bases of the twin citadels & walls
  const caveR = isGrand ? 3.3 : 2.05;
  const centralCave =
    distToSegment(x, y, z, wx(-0.36), tunnelY, cz, wx(0.36), tunnelY, cz) -
    caveR;
  d = smax(d, -centralCave, 0.7);

  const bPassN =
    distToSegment(
      x,
      y,
      z,
      wx(-0.2),
      passY,
      wz(-0.58),
      wx(0.2),
      passY,
      wz(-0.58),
    ) - passRadius;
  const bPassS =
    distToSegment(
      x,
      y,
      z,
      wx(-0.2),
      passY,
      wz(0.58),
      wx(0.2),
      passY,
      wz(0.58),
    ) - passRadius;
  const bPassW =
    distToSegment(
      x,
      y,
      z,
      wx(-0.58),
      passY,
      wz(-0.2),
      wx(-0.58),
      passY,
      wz(0.2),
    ) - passRadius;
  const bPassE =
    distToSegment(
      x,
      y,
      z,
      wx(0.58),
      passY,
      wz(-0.2),
      wx(0.58),
      passY,
      wz(0.2),
    ) - passRadius;

  d = smax(d, -bPassN, 0.65);
  d = smax(d, -bPassS, 0.65);
  d = smax(d, -bPassW, 0.65);
  d = smax(d, -bPassE, 0.65);
  d = smin(d, evalGatePlugs(0.58), isGrand ? 0.5 : 0.35);

  // Dramatic underside hollows beneath the overhanging coastal ledges
  const underNE = sdEllipsoid(
    x,
    y,
    z,
    wx(0.38),
    worldHeight * 0.21,
    wz(-0.35),
    0.13 * halfSpan,
    0.068 * worldHeight,
    0.12 * halfSpan,
  );
  const underSW = sdEllipsoid(
    x,
    y,
    z,
    wx(-0.38),
    worldHeight * 0.2,
    wz(0.35),
    0.13 * halfSpan,
    0.068 * worldHeight,
    0.12 * halfSpan,
  );
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
  public readonly mapScale: MapScale;
  public readonly dims: SdfDimensions;
  public readonly worldWidth: number;
  public readonly worldHeight: number;
  public readonly worldDepth: number;
  public readonly centerX: number;
  public readonly centerZ: number;

  private readonly chunksX: number;
  private readonly chunksY: number;
  private readonly chunksZ: number;
  private readonly values: Float32Array;
  private readonly carveLog: CarveOp[] = [];

  public constructor(
    seed: number,
    theme: ThemeId,
    mapScale: MapScale = "duel",
  ) {
    this.seed = seed;
    this.theme = theme;
    this.mapScale = mapScale;
    const preset = SDF_PRESETS[mapScale];
    this.dims = { ...preset };
    this.worldWidth = preset.nx * preset.voxelSize;
    this.worldHeight = preset.ny * preset.voxelSize;
    this.worldDepth = preset.nz * preset.voxelSize;
    this.centerX = this.worldWidth * 0.5;
    this.centerZ = this.worldDepth * 0.5;
    this.chunksX = Math.ceil(preset.nx / preset.chunkSize);
    this.chunksY = Math.ceil(preset.ny / preset.chunkSize);
    this.chunksZ = Math.ceil(preset.nz / preset.chunkSize);
    this.values = new Float32Array(preset.nx * preset.ny * preset.nz);
    this.generateTerrain();
  }

  /** Read raw SDF grid value at integer voxel index, returning +2.0 outside bounds. */
  public getValue(ix: number, iy: number, iz: number): number {
    const { nx, ny, nz } = this.dims;
    if (!(ix >= 0 && ix < nx && iy >= 0 && iy < ny && iz >= 0 && iz < nz)) {
      return OUTSIDE_AIR_VALUE;
    }
    const x = Math.trunc(ix);
    const y = Math.trunc(iy);
    const z = Math.trunc(iz);
    const idx = x + nx * (y + ny * z);
    return this.values[idx] ?? OUTSIDE_AIR_VALUE;
  }

  /** Trilinearly sample the SDF in world meters, returning +2.0 outside bounds. */
  public sample(x: number, y: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return OUTSIDE_AIR_VALUE;
    }
    const { nx, ny, nz, voxelSize } = this.dims;
    const gx = x / voxelSize;
    const gy = y / voxelSize;
    const gz = z / voxelSize;

    if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) {
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
    const eps = this.dims.voxelSize * 0.5;
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
   * March segment `(a + eyeOffsetY) -> (b + eyeOffsetY)` in `0.45 * dims.voxelSize` steps.
   * Returns `false` immediately upon intersecting any solid rock (`sample < 0`).
   */
  public hasDirectLineOfSight(a: Vec3, b: Vec3, eyeOffsetY = 1.1): boolean {
    if (!isFiniteVec3(a) || !isFiniteVec3(b) || !Number.isFinite(eyeOffsetY)) {
      return false;
    }
    const ax = a.x;
    const ay = a.y + eyeOffsetY;
    const az = a.z;
    const bx = b.x;
    const by = b.y + eyeOffsetY;
    const bz = b.z;
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-5) {
      return this.sample(ax, ay, az) >= 0;
    }
    const step = 0.45 * this.dims.voxelSize;
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (this.sample(ax + dx * t, ay + dy * t, az + dz * t) < 0) {
        return false;
      }
    }
    return true;
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

    const { nx, ny, nz, voxelSize: vs } = this.dims;
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
    const maxIx = Math.min(nx - 2, Math.ceil(maxX / vs));
    const minIy = Math.max(1, Math.floor(minY / vs));
    const maxIy = Math.min(ny - 2, Math.ceil(maxY / vs));
    const minIz = Math.max(1, Math.floor(minZ / vs));
    const maxIz = Math.min(nz - 2, Math.ceil(maxZ / vs));

    if (minIx > maxIx || minIy > maxIy || minIz > maxIz) {
      return [];
    }

    const dirtyChunks = new Set<string>();
    const isCapsule = op.shape === "capsule" && endPoint !== undefined;

    for (let iz = minIz; iz <= maxIz; iz++) {
      const wz = iz * vs;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const wy = iy * vs;
        const rowBase = nx * (iy + ny * iz);
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

  /** Erode outer island terrain beyond radiusFromCenter around world center for sudden-death ledge crumble. */
  public crumbleOuterRing(radiusFromCenter: number): string[] {
    if (!Number.isFinite(radiusFromCenter)) {
      return [];
    }
    const radius = Math.max(0, radiusFromCenter);
    const { nx, ny, nz, voxelSize: vs } = this.dims;
    const dirtyChunks = new Set<string>();

    for (let iz = 1; iz <= nz - 2; iz++) {
      const dz = iz * vs - this.centerZ;
      for (let iy = 1; iy <= ny - 2; iy++) {
        const rowBase = nx * (iy + ny * iz);
        for (let ix = 1; ix <= nx - 2; ix++) {
          const dx = ix * vs - this.centerX;
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
    const { ny, voxelSize: vs } = this.dims;
    const step = vs * 0.5;
    const maxY = (ny - 2) * vs;
    const minY = vs;

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
   * Deterministically pick `count` well-separated walkable spawn points in the 4
   * sheltered quadrant basins (`>= 24m` apart on duel, `>= 52m` apart on grand),
   * guaranteeing `hasDirectLineOfSight(spawns[i], spawns[j], 1.1) === false` for
   * every pair among the primary 4 spawns.
   */
  public findSpawnPoints(count: number): Vec3[] {
    if (!Number.isFinite(count) || count <= 0) {
      return [];
    }
    const targetCount = Math.floor(count);
    const rng = createSeededRng(this.seed ^ 0x51a9c3);
    const isGrand = this.mapScale === "grand";
    const halfSpan = this.worldWidth * 0.44;
    const minSep = isGrand ? 54.5 : 24.5;
    const minBasinRadial = halfSpan * 0.55;
    const maxSafeRadial = isGrand ? 55.5 : 24.5;
    const maxBasinY = isGrand ? 21.0 : 12.2;
    const minBasinY = isGrand ? 11.0 : 7.0;
    const margin = isGrand ? 9.0 : 5.0;
    const step = isGrand ? 2.25 : 1.5;

    interface SpawnCandidate {
      pos: Vec3;
      quadrant: number;
      radial: number;
      inBasin: boolean;
      score: number;
    }

    const candidates: SpawnCandidate[] = [];

    for (let x = margin; x <= this.worldWidth - margin; x += step) {
      for (let z = margin; z <= this.worldDepth - margin; z += step) {
        const surfaceY = this.getSurfaceY(x, z);
        if (surfaceY === null || surfaceY < 4.0) {
          continue;
        }
        const normal = this.sampleNormal(x, surfaceY, z);
        if (normal.y < 0.65) {
          continue;
        }
        if (
          this.sample(x, surfaceY + 1.0, z) <= 0.1 ||
          this.sample(x, surfaceY + 2.0, z) <= 0.1 ||
          !this.isSolid(x, surfaceY - 1.5, z)
        ) {
          continue;
        }

        const footOff = isGrand ? 2.0 : 1.4;
        const stableFooting =
          this.isSolid(x + footOff, surfaceY - 1.0, z) &&
          this.isSolid(x - footOff, surfaceY - 1.0, z) &&
          this.isSolid(x, surfaceY - 1.0, z + footOff) &&
          this.isSolid(x, surfaceY - 1.0, z - footOff);

        const u = (x - this.centerX) / halfSpan;
        const v = (z - this.centerZ) / halfSpan;
        const radial = Math.hypot(x - this.centerX, z - this.centerZ);
        const quadrant =
          (x < this.centerX ? 0 : 1) + (z < this.centerZ ? 0 : 2);
        const inBasin =
          Math.abs(u) >= 0.38 &&
          Math.abs(v) >= 0.38 &&
          radial >= minBasinRadial &&
          radial <= maxSafeRadial &&
          surfaceY >= minBasinY &&
          surfaceY <= maxBasinY;

        // Prefer broad central flats inside each sheltered quadrant basin (near |u|=0.6, |v|=0.6)
        const distFromBasinIdeal = Math.hypot(
          Math.abs(u) - 0.6,
          Math.abs(v) - 0.6,
        );
        const basinCenterBonus = Math.max(0, 1.0 - distFromBasinIdeal * 2.2) * 8.0;
        const footingBonus = stableFooting ? 5.0 : 0.0;
        const score =
          (inBasin ? 30.0 : 0.0) +
          basinCenterBonus +
          normal.y * 4.0 +
          footingBonus +
          Math.min(surfaceY, maxBasinY) * 0.35 +
          rng() * 0.35;

        candidates.push({
          pos: { x, y: surfaceY, z },
          quadrant,
          radial,
          inBasin,
          score,
        });
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    candidates.sort((a, b) => b.score - a.score);

    const selected: Vec3[] = [];
    const usedQuadrants = new Set<number>();

    const primaryTarget = Math.min(targetCount, 4);
    const basinPreferred = candidates.filter((c) => c.inBasin);
    const firstPool = basinPreferred.length > 0 ? basinPreferred : candidates;
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
        let blocksAllLos = true;
        for (const existing of selected) {
          const d = Math.hypot(
            cand.pos.x - existing.x,
            cand.pos.y - existing.y,
            cand.pos.z - existing.z,
          );
          if (d < minDist) {
            minDist = d;
          }
          if (blocksAllLos && this.hasDirectLineOfSight(cand.pos, existing, 1.1)) {
            blocksAllLos = false;
          }
        }
        if (minDist < 0.01) {
          continue;
        }
        const losBonus = blocksAllLos ? 500.0 : 0.0;
        const meetsSeparation = minDist >= minSep ? 120.0 : 0.0;
        const basinBonus = cand.inBasin ? 60.0 : 0.0;
        const safeInnerRing = cand.radial <= maxSafeRadial ? 25.0 : 0.0;
        const metric =
          losBonus +
          meetsSeparation +
          basinBonus +
          safeInnerRing +
          Math.min(minDist, minSep * 1.45) +
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

    // Extra points beyond 4 (Evo Pod drop zones including central high-ground spires & arches)
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
        const metric = minDist + cand.pos.y * 0.55 + cand.score * 0.1;
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
   * Deterministically place 8-10 interactive hazards on Duel (60m) and 14-18 hazards
   * on Grand (144m) across all 4 types (blast_barrel, spark_mine, steam_geyser, thorn_patch),
   * tucking Blast Barrels near destructible wall seams and Spark Mines in narrow passes.
   */
  public findHazardPoints(spawnPoints: readonly Vec3[]): HazardPlacement[] {
    const rng = createSeededRng(this.seed ^ 0x7c3e91);
    const isGrand = this.mapScale === "grand";
    const halfSpan = this.worldWidth * 0.44;
    const margin = isGrand ? 10.0 : 5.5;
    const step = isGrand ? 2.6 : 1.5;
    const spawnClearance = isGrand ? 5.2 : 4.2;
    const maxRadial = isGrand ? 61.5 : 25.5;

    interface HazardCandidate {
      pos: Vec3;
      radial: number;
      isWallSeam: boolean;
      isPassMine: boolean;
      isValleyLaunch: boolean;
      isShortcut: boolean;
      jitter: number;
    }

    const candidates: HazardCandidate[] = [];
    const probeDist = isGrand ? 3.8 : 2.4;

    for (let x = margin; x <= this.worldWidth - margin; x += step) {
      for (let z = margin; z <= this.worldDepth - margin; z += step) {
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

        let tooCloseToSpawn = false;
        for (const sp of spawnPoints) {
          if (Math.hypot(x - sp.x, surfaceY - sp.y, z - sp.z) < spawnClearance) {
            tooCloseToSpawn = true;
            break;
          }
        }
        if (tooCloseToSpawn) {
          continue;
        }

        const radial = Math.hypot(x - this.centerX, z - this.centerZ);
        if (radial > maxRadial) {
          continue;
        }

        let hasNearbyDrop = false;
        let hasNearbyHighCliff = false;
        const probes: ReadonlyArray<readonly [number, number]> = [
          [probeDist, 0],
          [-probeDist, 0],
          [0, probeDist],
          [0, -probeDist],
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

        let clearSky = true;
        const skyLimit = isGrand ? 14.0 : 9.0;
        for (let h = 2.5; h <= skyLimit; h += 1.8) {
          if (this.isSolid(x, surfaceY + h, z)) {
            clearSky = false;
            break;
          }
        }

        const u = Math.abs((x - this.centerX) / halfSpan);
        const v = Math.abs((z - this.centerZ) / halfSpan);
        const nearAxisWall = Math.min(u, v) <= 0.28;
        const hasOpenFlank =
          this.sample(x + 1.8, surfaceY + 0.8, z) > 0.05 &&
          this.sample(x - 1.8, surfaceY + 0.8, z) > 0.05 &&
          this.sample(x, surfaceY + 0.8, z + 1.8) > 0.05 &&
          this.sample(x, surfaceY + 0.8, z - 1.8) > 0.05;

        const isWallSeam =
          hasOpenFlank &&
          surfaceY >= 3.8 &&
          (nearAxisWall || hasNearbyHighCliff || hasNearbyDrop);
        const isPassMine =
          surfaceY >= 3.0 &&
          (nearAxisWall || (radial >= halfSpan * 0.2 && radial <= halfSpan * 0.85));
        const isValleyLaunch =
          clearSky &&
          surfaceY >= 2.25 &&
          surfaceY <= (isGrand ? 18.0 : 11.2) &&
          (hasNearbyHighCliff || surfaceY <= (isGrand ? 15.0 : 8.8));
        const isShortcut =
          surfaceY >= 3.0 &&
          radial >= halfSpan * 0.22 &&
          radial <= halfSpan * 0.9;

        candidates.push({
          pos: { x, y: surfaceY, z },
          radial,
          isWallSeam,
          isPassMine,
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
          if (!farEnough(cand.pos, Math.max(3.6, minSpacing * 0.6))) continue;
          placed.push({ type, position: { ...cand.pos }, radius });
          added += 1;
        }
      }
    };

    const spacingMult = isGrand ? 1.55 : 1.0;

    // 1. Blast Barrels (radius 1.4): guarantee 1 volatile barrel tucked near each of the 4 destructible gate seams
    const passOffset = this.theme === "canyon_arch" ? 0.62 : 0.58;
    const gateSeamAnchors: ReadonlyArray<readonly [number, number]> = [
      [this.centerX, this.centerZ - passOffset * halfSpan],
      [this.centerX, this.centerZ + passOffset * halfSpan],
      [this.centerX - passOffset * halfSpan, this.centerZ],
      [this.centerX + passOffset * halfSpan, this.centerZ],
    ];
    for (const [gx, gz] of gateSeamAnchors) {
      let bestGateCand: HazardCandidate | null = null;
      let bestGateScore = Infinity;
      for (const cand of candidates) {
        if (!farEnough(cand.pos, isGrand ? 5.0 : 3.6)) continue;
        const dSeam = Math.hypot(cand.pos.x - gx, cand.pos.z - gz);
        const score = dSeam - (cand.isWallSeam ? 1.2 : 0);
        if (score < bestGateScore) {
          bestGateScore = score;
          bestGateCand = cand;
        }
      }
      if (bestGateCand) {
        placed.push({
          type: "blast_barrel",
          position: { ...bestGateCand.pos },
          radius: 1.4,
        });
      }
    }

    // Add chain-detonation partner barrels on Grand (2 extra -> 6 total barrels)
    const barrelPool = candidates.filter((c) => c.isWallSeam);
    const partnerCount = isGrand ? 2 : 0;
    const primaryBarrels = placed.filter((h) => h.type === "blast_barrel");
    for (let pIdx = 0; pIdx < partnerCount; pIdx++) {
      const anchorBarrel = primaryBarrels[pIdx];
      if (!anchorBarrel) {
        pickFromPool(barrelPool, "blast_barrel", 1.4, 1, 5.5 * spacingMult);
        continue;
      }
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
        pickFromPool(barrelPool, "blast_barrel", 1.4, 1, 5.5 * spacingMult);
      }
    }

    // 2. Spark Mines (radius 2.4) guarding narrow passes & dividing-wall approaches
    const minePool = candidates.filter((c) => c.isPassMine);
    pickFromPool(
      minePool,
      "spark_mine",
      2.4,
      isGrand ? 4 : 2,
      6.4 * spacingMult,
    );

    // 3. Thermal Steam Geysers (radius 1.7) in valleys & beside tall walls for vertical flanking
    const geyserPool = candidates
      .filter((c) => c.isValleyLaunch)
      .sort((a, b) => a.pos.y - b.pos.y + (b.jitter - a.jitter) * 3.0);
    pickFromPool(
      geyserPool,
      "steam_geyser",
      1.7,
      isGrand ? 4 : 2,
      6.2 * spacingMult,
    );

    // 4. Bramble Thorn Patches (radius 1.9) in canyon shortcuts & flanking routes
    const thornPool = candidates.filter((c) => c.isShortcut);
    pickFromPool(
      thornPool,
      "thorn_patch",
      1.9,
      isGrand ? 3 : 2,
      5.8 * spacingMult,
    );

    return placed.slice(0, isGrand ? 18 : 10);
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

  /** Return all chunk coordinates covering the SDF world (75 on Duel, 192 on Grand). */
  public getAllChunkCoords(): ChunkCoord[] {
    const coords: ChunkCoord[] = [];
    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cz = 0; cz < this.chunksZ; cz++) {
        for (let cx = 0; cx < this.chunksX; cx++) {
          coords.push({ cx, cy, cz });
        }
      }
    }
    return coords;
  }

  private generateTerrain(): void {
    const rng = createSeededRng(this.seed);
    const jitter: ThemeJitter = {
      westHeight: (rng() - 0.5) * 1.2,
      eastHeight: (rng() - 0.5) * 1.2,
      archBoost: (rng() - 0.5) * 1.0,
      northShift: (rng() - 0.5) * 1.4,
      southShift: (rng() - 0.5) * 1.4,
    };
    const noise = createValueNoise3D(this.seed);
    const { nx, ny, nz, voxelSize: vs } = this.dims;
    const isGrand = this.mapScale === "grand";
    const halfSpan = this.worldWidth * 0.44;
    const spawnTopY = isGrand ? 16.0 : 9.1;
    const layout: ThemeLayoutContext = {
      cx: this.centerX,
      cz: this.centerZ,
      halfSpan,
      worldHeight: this.worldHeight,
      wScale: halfSpan / 26.4,
      hScale: this.worldHeight / 27.0,
      isGrand,
      bottomY: isGrand ? 2.4 : 1.85,
      spawnTopY,
      wallTopY: spawnTopY + (isGrand ? 11.4 : 8.5),
      centralPeakY: this.worldHeight * 0.66,
      tunnelY: this.worldHeight * 0.2,
    };

    for (let iz = 0; iz < nz; iz++) {
      const wz = iz * vs;
      const zBorder = iz <= 1 || iz >= nz - 2;
      for (let iy = 0; iy < ny; iy++) {
        const wy = iy * vs;
        const yBorder = iy <= 1 || iy >= ny - 2;
        const rowBase = nx * (iy + ny * iz);
        for (let ix = 0; ix < nx; ix++) {
          const xBorder = ix <= 1 || ix >= nx - 2;
          const idx = ix + rowBase;
          if (xBorder || yBorder || zBorder) {
            this.values[idx] = BORDER_AIR_MIN;
            continue;
          }
          const wx = ix * vs;
          const d = evaluateThemeSdf(this.theme, wx, wy, wz, layout, jitter, noise);
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
    const cs = this.dims.chunkSize;
    const minCx = Math.max(0, Math.floor((ix - 2) / cs));
    const maxCx = Math.min(this.chunksX - 1, Math.floor((ix + 1) / cs));
    const minCy = Math.max(0, Math.floor((iy - 2) / cs));
    const maxCy = Math.min(this.chunksY - 1, Math.floor((iy + 1) / cs));
    const minCz = Math.max(0, Math.floor((iz - 2) / cs));
    const maxCz = Math.min(this.chunksZ - 1, Math.floor((iz + 1) / cs));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          dirtyChunks.add(chunkKey(cx, cy, cz));
        }
      }
    }
  }
}
