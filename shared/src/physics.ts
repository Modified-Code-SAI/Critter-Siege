import { GADGET_CATALOG, computeCritterStats } from "./catalog.js";
import type { SdfWorld } from "./sdf.js";
import type {
  ApexId,
  CarveOp,
  CritterHitResult,
  CritterState,
  GadgetId,
  HardpointSlot,
  ImpactEvent,
  MapScale,
  MutationId,
  PrismWallState,
  ShotSimulationResult,
  SpeciesId,
  Vec3,
} from "./types.js";

export type {
  CritterHitResult,
  ImpactEvent,
  PrismWallState,
  ShotSimulationResult,
};

/** World gravitational acceleration in m/s^2. */
export const GRAVITY = 18.0;

/** Minimum vertical drop in meters onto solid rock before fall damage applies. */
export const FALL_DAMAGE_THRESHOLD_M = 7.5;
/** Fall damage dealt per meter dropped beyond the safe threshold. */
export const FALL_DAMAGE_PER_METER = 3.5;
/** Maximum fall damage dealt from a single drop onto solid rock. */
export const FALL_DAMAGE_MAX = 25;

const DUEL_MIN_LAUNCH_SPEED = 9.0;
const DUEL_MAX_LAUNCH_SPEED = 27.5;
const GRAND_MIN_LAUNCH_SPEED = 11.0;
const GRAND_MAX_LAUNCH_SPEED = 42.0;
const GRAND_CARVE_MULTIPLIER = 1.35;
const SIM_DT = 0.025;
const WORLD_MIN_XZ = -6.0;
const WORLD_MIN_Y = -6.0;
const CRITTER_RADIUS = 0.55;
const CRITTER_HEIGHT_CENTER = 0.5;

/** Complete input parameters for simulating a fired artillery or melee action. */
export interface ShotParams {
  shooterId: string;
  gadgetId: GadgetId;
  origin: Vec3;
  direction: Vec3;
  power: number;
  droneTarget?: Vec3;
  species: SpeciesId;
  equipped: Partial<Record<HardpointSlot, MutationId>>;
  apex: ApexId | null;
}

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Normalize a 3D vector, returning null if zero-length or non-finite. */
export function safeNormalizeVec3(v: Vec3): Vec3 | null {
  if (!isFiniteVec3(v)) {
    return null;
  }
  const len = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(len) || len < 1e-6) {
    return null;
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Compute fair fall damage when a critter drops more than 7.5m onto solid rock:
 * `(drop - 7.5) * 3.5` capped at 25, reduced by `fallDamageResist` (e.g. 0.5 for Spring Paws).
 */
export function computeFallDamage(
  dropMeters: number,
  fallDamageResist = 0,
): number {
  if (!Number.isFinite(dropMeters) || dropMeters <= FALL_DAMAGE_THRESHOLD_M) {
    return 0;
  }
  const clampedResist = Number.isFinite(fallDamageResist)
    ? Math.max(0, Math.min(1, fallDamageResist))
    : 0;
  const raw = Math.min(
    FALL_DAMAGE_MAX,
    (dropMeters - FALL_DAMAGE_THRESHOLD_M) * FALL_DAMAGE_PER_METER,
  );
  return Math.round(raw * (1 - clampedResist));
}

function clampPower(power: number): number {
  if (!Number.isFinite(power)) {
    return 0.5;
  }
  return Math.max(0.1, Math.min(1.0, power));
}

/** Compute deterministic projectile launch speed in m/s for a gadget, power [0.1..1.0], and mapScale. */
export function computeLaunchSpeed(
  gadgetId: GadgetId,
  power: number,
  mapScale: MapScale = "duel",
): number {
  const p = clampPower(power);
  const isGrand = mapScale === "grand";
  if (gadgetId === "burrow_bore") {
    return isGrand ? 20.0 + p * 20.0 : 15.0 + p * 14.0;
  }
  if (gadgetId === "seeker_firefly") {
    return isGrand ? 32.0 : 22.0;
  }
  const minSpd = isGrand ? GRAND_MIN_LAUNCH_SPEED : DUEL_MIN_LAUNCH_SPEED;
  const maxSpd = isGrand ? GRAND_MAX_LAUNCH_SPEED : DUEL_MAX_LAUNCH_SPEED;
  return minSpd + p * (maxSpd - minSpd);
}

function isOutOfBounds(world: SdfWorld, p: Vec3): boolean {
  return (
    p.x < WORLD_MIN_XZ ||
    p.x > world.worldWidth + 6.0 ||
    p.z < WORLD_MIN_XZ ||
    p.z > world.worldDepth + 6.0 ||
    p.y < WORLD_MIN_Y
  );
}

function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq < 1e-8) {
    return Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z);
  }
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lenSq,
    ),
  );
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  const cz = a.z + abz * t;
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz);
}

/** Evaluate whether a point remains solid after applying pending CarveOps without mutating SdfWorld. */
function isSolidAfterCarves(
  world: SdfWorld,
  carveOps: readonly CarveOp[],
  x: number,
  y: number,
  z: number,
): boolean {
  if (!world.isSolid(x, y, z)) {
    return false;
  }
  const pt: Vec3 = { x, y, z };
  for (const op of carveOps) {
    if (op.shape === "capsule" && op.end) {
      if (distToSegment(pt, op.center, op.end) < op.radius) {
        return false;
      }
    } else {
      const d = Math.hypot(x - op.center.x, y - op.center.y, z - op.center.z);
      if (d < op.radius) {
        return false;
      }
    }
  }
  return true;
}

function findCritterCollision(
  critters: readonly CritterState[],
  pos: Vec3,
  shooterId: string,
  elapsedSec: number,
): CritterState | null {
  for (const c of critters) {
    if (!c.alive) continue;
    if (c.id === shooterId && elapsedSec < 0.12) continue;
    const dx = pos.x - c.position.x;
    const dy = pos.y - (c.position.y + CRITTER_HEIGHT_CENTER);
    const dz = pos.z - c.position.z;
    if (Math.hypot(dx, dy, dz) <= CRITTER_RADIUS) {
      return c;
    }
  }
  return null;
}

function resolveSeekerTarget(
  world: SdfWorld,
  origin: Vec3,
  dir: Vec3,
  droneTarget?: Vec3,
): Vec3 {
  if (droneTarget && isFiniteVec3(droneTarget)) {
    return { ...droneTarget };
  }
  const maxDist = world.mapScale === "grand" ? 85.0 : 36.0;
  const step = world.dims.voxelSize;
  for (let dist = 1.0; dist <= maxDist; dist += step) {
    const px = origin.x + dir.x * dist;
    const py = origin.y + dir.y * dist;
    const pz = origin.z + dir.z * dist;
    if (world.isSolid(px, py, pz)) {
      return { x: px, y: py, z: pz };
    }
  }
  const fallbackDist = world.mapScale === "grand" ? 64.0 : 26.0;
  return {
    x: origin.x + dir.x * fallbackDist,
    y: origin.y + dir.y * fallbackDist,
    z: origin.z + dir.z * fallbackDist,
  };
}

function steerSeekerFirefly(
  world: SdfWorld,
  pos: Vec3,
  vel: Vec3,
  fallbackDir: Vec3,
  seekerTarget: Vec3,
  speed: number,
  dt: number,
): void {
  const dx = seekerTarget.x - pos.x;
  const dz = seekerTarget.z - pos.z;
  const horizDist = Math.hypot(dx, dz);
  const diveRadius = world.mapScale === "grand" ? 18.0 : 10.0;
  const cruiseAltitude = Math.max(
    seekerTarget.y + 6.0,
    world.worldHeight * 0.8,
  );
  const curDir = safeNormalizeVec3(vel) ?? fallbackDir;

  let steerVec: Vec3;
  if (horizDist > diveRadius) {
    // Climb promptly to high cruise altitude above dividing walls before diving onto target
    const lookahead = Math.min(horizDist, world.mapScale === "grand" ? 18.0 : 9.0);
    const ux = dx / Math.max(1e-5, horizDist);
    const uz = dz / Math.max(1e-5, horizDist);
    let dy = cruiseAltitude - pos.y;
    const probeDist = world.mapScale === "grand" ? 4.5 : 2.8;
    if (
      world.isSolid(
        pos.x + curDir.x * probeDist,
        pos.y + curDir.y * probeDist,
        pos.z + curDir.z * probeDist,
      )
    ) {
      dy = Math.max(dy, 10.0);
    }
    steerVec = {
      x: ux * lookahead,
      y: dy,
      z: uz * lookahead,
    };
  } else {
    steerVec = {
      x: dx,
      y: seekerTarget.y - pos.y,
      z: dz,
    };
  }

  const desired = safeNormalizeVec3(steerVec);
  if (!desired) {
    return;
  }

  const blend = Math.min(1, 9.5 * dt);
  const nextDir = safeNormalizeVec3({
    x: curDir.x + (desired.x - curDir.x) * blend,
    y: curDir.y + (desired.y - curDir.y) * blend,
    z: curDir.z + (desired.z - curDir.z) * blend,
  });
  if (nextDir) {
    vel.x = nextDir.x * speed;
    vel.y = nextDir.y * speed;
    vel.z = nextDir.z * speed;
  }
}

interface PrismWallHit {
  wall: PrismWallState;
  hitPos: Vec3;
}

function findPrismWallCollision(
  prismWalls: readonly PrismWallState[] | undefined,
  prevPos: Vec3,
  pos: Vec3,
  shooterId?: string,
): PrismWallHit | null {
  if (!prismWalls || prismWalls.length === 0) {
    return null;
  }
  const SLAB_HALF = 0.45;
  let bestHit: PrismWallHit | null = null;
  let bestT = Infinity;

  for (const wall of prismWalls) {
    if (!wall.active) continue;
    if (shooterId !== undefined && wall.ownerId === shooterId) {
      continue;
    }

    const nLen = Math.hypot(wall.normal.x, wall.normal.z);
    const nx = nLen > 1e-6 ? wall.normal.x / nLen : 0;
    const nz = nLen > 1e-6 ? wall.normal.z / nLen : 1;

    const d0 =
      (prevPos.x - wall.position.x) * nx + (prevPos.z - wall.position.z) * nz;
    const d1 =
      (pos.x - wall.position.x) * nx + (pos.z - wall.position.z) * nz;

    const touchesSlab =
      (d0 >= -SLAB_HALF && d1 <= SLAB_HALF) ||
      (d0 <= SLAB_HALF && d1 >= -SLAB_HALF);
    if (!touchesSlab) {
      continue;
    }

    const denom = d1 - d0;
    const rawT = Math.abs(denom) > 1e-6 ? -d0 / denom : 1;
    const t = Math.max(0, Math.min(1, rawT));

    const hx = prevPos.x + (pos.x - prevPos.x) * t;
    const hy = prevPos.y + (pos.y - prevPos.y) * t;
    const hz = prevPos.z + (pos.z - prevPos.z) * t;

    if (hy < wall.position.y - 0.25 || hy > wall.position.y + wall.height + 0.25) {
      continue;
    }

    const relX = hx - wall.position.x;
    const relZ = hz - wall.position.z;
    const tangentDist = Math.abs(relX * -nz + relZ * nx);
    if (tangentDist <= wall.width * 0.5 + 0.2 && t < bestT) {
      bestT = t;
      bestHit = {
        wall,
        hitPos: { x: hx, y: hy, z: hz },
      };
    }
  }
  return bestHit;
}

/**
 * Sample deterministic flight arc points for live 3D trajectory preview.
 * Returns up to 20 points normally, or 36 points when Optic Visor (`extended`) is equipped.
 */
export function sampleAimArc(
  world: SdfWorld,
  params: Pick<
    ShotParams,
    "gadgetId" | "origin" | "direction" | "power" | "droneTarget"
  >,
  wind: Vec3,
  extended: boolean,
  prismWalls?: readonly PrismWallState[],
  shooterId?: string,
): Vec3[] {
  if (!isFiniteVec3(params.origin)) {
    return [{ x: 0, y: 0, z: 0 }];
  }
  const dir = safeNormalizeVec3(params.direction);
  if (!dir) {
    return [{ ...params.origin }];
  }

  const maxPoints = extended ? 36 : 20;
  const points: Vec3[] = [{ ...params.origin }];

  if (params.gadgetId === "quake_club") {
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const dist = (2.8 * i) / steps;
      points.push({
        x: params.origin.x + dir.x * dist,
        y: params.origin.y + dir.y * dist,
        z: params.origin.z + dir.z * dist,
      });
    }
    return points;
  }

  const gadget = GADGET_CATALOG[params.gadgetId];
  const safeWind = isFiniteVec3(wind) ? wind : { x: 0, y: 0, z: 0 };
  const speed = computeLaunchSpeed(
    params.gadgetId,
    params.power,
    world.mapScale,
  );
  const dt = world.mapScale === "grand" ? 0.085 : 0.065;

  const pos: Vec3 = { ...params.origin };
  const vel: Vec3 = { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed };
  const seekerTarget =
    params.gadgetId === "seeker_firefly"
      ? resolveSeekerTarget(world, params.origin, dir, params.droneTarget)
      : null;

  for (let step = 1; step < maxPoints; step++) {
    const prevPos: Vec3 = { ...pos };
    if (params.gadgetId === "seeker_firefly" && seekerTarget) {
      steerSeekerFirefly(world, pos, vel, dir, seekerTarget, speed, dt);
    } else {
      const gravScale = params.gadgetId === "burrow_bore" ? 0.25 : 1.0;
      const ax = gadget.windAffected ? safeWind.x : 0;
      const ay = -GRAVITY * gravScale + (gadget.windAffected ? safeWind.y : 0);
      const az = gadget.windAffected ? safeWind.z : 0;
      vel.x += ax * dt;
      vel.y += ay * dt;
      vel.z += az * dt;
    }

    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;

    const wallHit = findPrismWallCollision(prismWalls, prevPos, pos, shooterId);
    if (wallHit !== null) {
      points.push({ ...wallHit.hitPos });
      break;
    }

    points.push({ ...pos });

    if (
      world.isSolid(pos.x, pos.y, pos.z) ||
      isOutOfBounds(world, pos)
    ) {
      break;
    }
    if (
      seekerTarget &&
      Math.hypot(
        pos.x - seekerTarget.x,
        pos.y - seekerTarget.y,
        pos.z - seekerTarget.z,
      ) <= 0.75
    ) {
      break;
    }
  }

  return points;
}

function settleCritterPosition(
  world: SdfWorld,
  carveOps: readonly CarveOp[],
  startPos: Vec3,
  initialVel: Vec3,
  waterLevel: number,
): { position: Vec3; drowned: boolean; fallDrop: number } {
  const pos: Vec3 = { ...startPos };
  const vel: Vec3 = { ...initialVel };
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  let peakY = startPos.y;

  // If stationary, check whether the floor beneath critter was carved away
  if (speed < 0.05) {
    if (pos.y <= waterLevel) {
      return { position: pos, drowned: true, fallDrop: 0 };
    }
    if (isSolidAfterCarves(world, carveOps, pos.x, pos.y - 0.35, pos.z)) {
      return { position: pos, drowned: false, fallDrop: 0 };
    }
  }

  // Lift slightly off ground if launching upward or sideways so we don't snag on starting voxel
  if (speed >= 0.05) {
    pos.y += 0.25;
    peakY = Math.max(peakY, pos.y);
  }

  const dt = 0.04;
  const maxSteps = world.mapScale === "grand" ? 120 : 80;

  for (let i = 0; i < maxSteps; i++) {
    vel.y -= GRAVITY * dt;
    const nextX = pos.x + vel.x * dt;
    const nextY = pos.y + vel.y * dt;
    const nextZ = pos.z + vel.z * dt;

    if (nextY > peakY) {
      peakY = nextY;
    }

    if (
      nextY <= waterLevel ||
      isOutOfBounds(world, { x: nextX, y: nextY, z: nextZ })
    ) {
      return {
        position: { x: nextX, y: Math.min(nextY, waterLevel), z: nextZ },
        drowned: true,
        fallDrop: 0,
      };
    }

    if (isSolidAfterCarves(world, carveOps, nextX, nextY, nextZ)) {
      if (vel.y <= 0) {
        let lo = nextY;
        let hi = pos.y;
        for (let step = 0; step < 6; step++) {
          const mid = (lo + hi) * 0.5;
          if (isSolidAfterCarves(world, carveOps, nextX, mid, nextZ)) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        const drowned = hi <= waterLevel;
        return {
          position: { x: nextX, y: hi, z: nextZ },
          drowned,
          fallDrop: drowned ? 0 : Math.max(0, peakY - hi),
        };
      }
      // Hit ceiling or wall while rising: damp velocity and continue falling
      vel.x *= -0.25;
      vel.z *= -0.25;
      vel.y = Math.min(0, -vel.y * 0.2);
      continue;
    }

    pos.x = nextX;
    pos.y = nextY;
    pos.z = nextZ;
  }

  const drowned = pos.y <= waterLevel;
  return {
    position: pos,
    drowned,
    fallDrop: drowned ? 0 : Math.max(0, peakY - pos.y),
  };
}

/**
 * Deterministically simulate any Critter Siege weapon or bonus gadget shot,
 * computing flight path, terrain carve ops, blast/melee damage, shield absorption,
 * thorns reflection, knockback trajectories, fall damage, and drowning outcomes.
 */
export function simulateShot(
  world: SdfWorld,
  critters: readonly CritterState[],
  params: ShotParams,
  wind: Vec3,
  waterLevel: number,
  prismWalls?: readonly PrismWallState[],
): ShotSimulationResult {
  if (!isFiniteVec3(params.origin)) {
    return { path: [], durationSec: 0, impacts: [], carveOps: [], hits: [] };
  }

  const normDir = safeNormalizeVec3(params.direction);
  if (!normDir) {
    return {
      path: [{ ...params.origin }],
      durationSec: 0,
      impacts: [],
      carveOps: [],
      hits: [],
    };
  }

  const gadget = GADGET_CATALOG[params.gadgetId];
  const shooterStats = computeCritterStats(params.species, params.equipped);
  const mapCarveScale =
    world.mapScale === "grand" ? GRAND_CARVE_MULTIPLIER : 1.0;
  const carveMult = shooterStats.carveMultiplier * mapCarveScale;
  const damageMult = params.apex === "apex_hybrid" ? 1.1 : 1.0;
  const safeWind = isFiniteVec3(wind) ? wind : { x: 0, y: 0, z: 0 };

  if (!gadget.turnEnding) {
    return {
      path: [{ ...params.origin }],
      durationSec: 0.1,
      impacts: [],
      carveOps: [],
      hits: [],
    };
  }

  const path: Vec3[] = [{ ...params.origin }];
  const impacts: ImpactEvent[] = [];
  const carveOps: CarveOp[] = [];
  let durationSec = 0;

  // --- 1. Quake Club close-range melee strike ---
  if (params.gadgetId === "quake_club") {
    durationSec = 0.25;
    const reach = 2.8;
    const strikeCenter: Vec3 = {
      x: params.origin.x + normDir.x * 1.4,
      y: params.origin.y + normDir.y * 1.4,
      z: params.origin.z + normDir.z * 1.4,
    };
    path.push(strikeCenter);

    const carveOp: CarveOp = {
      center: strikeCenter,
      radius: Number((gadget.carveRadius * carveMult).toFixed(4)),
      shape: "sphere",
    };
    carveOps.push(carveOp);
    impacts.push({
      time: durationSec,
      position: strikeCenter,
      carveOp,
      damageRadius: reach,
      baseDamage: gadget.baseDamage,
      knockback: gadget.knockback,
    });

    const hits: CritterHitResult[] = [];
    let totalThornsOnAttacker = 0;

    for (const target of critters) {
      if (!target.alive || target.id === params.shooterId) continue;
      const toTarget: Vec3 = {
        x: target.position.x - params.origin.x,
        y: target.position.y + CRITTER_HEIGHT_CENTER - params.origin.y,
        z: target.position.z - params.origin.z,
      };
      const dist = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
      if (dist > reach) continue;

      const toDir = safeNormalizeVec3(toTarget);
      const dot = toDir
        ? toDir.x * normDir.x + toDir.y * normDir.y + toDir.z * normDir.z
        : 1;
      if (dist > 1.6 && dot < 0.1) continue;

      const targetStats = computeCritterStats(target.species, target.equipped);
      let damage = Math.round(gadget.baseDamage * damageMult);
      let shieldAbsorbed = false;
      if (target.roundShieldRemaining > 0 && damage > 0) {
        shieldAbsorbed = true;
        damage = 0;
      }

      const kbScale = gadget.knockback * (1 - targetStats.knockbackResist);
      const kbDir = safeNormalizeVec3({
        x: normDir.x,
        y: Math.max(0.35, normDir.y + 0.45),
        z: normDir.z,
      }) ?? { x: 0, y: 1, z: 0 };
      const knockbackVelocity: Vec3 = {
        x: kbDir.x * kbScale,
        y: kbDir.y * kbScale,
        z: kbDir.z * kbScale,
      };

      const settled = settleCritterPosition(
        world,
        carveOps,
        target.position,
        knockbackVelocity,
        waterLevel,
      );
      const fallDmg = computeFallDamage(
        settled.fallDrop,
        targetStats.fallDamageResist,
      );
      const combinedDamage = damage + fallDmg;
      const newHp = settled.drowned
        ? 0
        : Math.max(0, target.hp - combinedDamage);
      hits.push({
        critterId: target.id,
        damage: combinedDamage,
        shieldAbsorbed,
        knockbackVelocity,
        newPosition: settled.position,
        newHp,
        drowned: settled.drowned,
        knockedOut: newHp <= 0 || settled.drowned,
      });

      if (targetStats.meleeThorns > 0) {
        totalThornsOnAttacker += targetStats.meleeThorns;
      }
    }

    if (totalThornsOnAttacker > 0) {
      const attacker = critters.find(
        (c) => c.id === params.shooterId && c.alive,
      );
      if (attacker) {
        let thornsDmg = totalThornsOnAttacker;
        let shieldAbsorbed = false;
        if (attacker.roundShieldRemaining > 0) {
          shieldAbsorbed = true;
          thornsDmg = 0;
        }
        const newHp = Math.max(0, attacker.hp - thornsDmg);
        hits.push({
          critterId: attacker.id,
          damage: thornsDmg,
          shieldAbsorbed,
          knockbackVelocity: { x: 0, y: 0, z: 0 },
          newPosition: { ...attacker.position },
          newHp,
          drowned: false,
          knockedOut: newHp <= 0,
        });
      }
    }

    return { path, durationSec, impacts, carveOps, hits };
  }

  // --- 2. Ranged ballistic / drill / homing projectiles ---
  const speed = computeLaunchSpeed(
    params.gadgetId,
    params.power,
    world.mapScale,
  );
  const maxFlightSec = world.mapScale === "grand" ? 8.5 : 5.5;
  const pos: Vec3 = { ...params.origin };
  const vel: Vec3 = {
    x: normDir.x * speed,
    y: normDir.y * speed,
    z: normDir.z * speed,
  };
  const seekerTarget =
    params.gadgetId === "seeker_firefly"
      ? resolveSeekerTarget(world, params.origin, normDir, params.droneTarget)
      : null;

  let bounced = false;
  let postBounceTime = 0;
  let impacted = false;
  let impactPos: Vec3 = { ...pos };
  let impactDir: Vec3 = { ...normDir };
  let hitTerrainForBore = false;

  for (let t = SIM_DT; t <= maxFlightSec; t += SIM_DT) {
    durationSec = Number(t.toFixed(4));
    const prevPos: Vec3 = { ...pos };

    if (params.gadgetId === "seeker_firefly" && seekerTarget) {
      steerSeekerFirefly(world, pos, vel, normDir, seekerTarget, speed, SIM_DT);
    } else {
      const gravScale = params.gadgetId === "burrow_bore" ? 0.25 : 1.0;
      const ax = gadget.windAffected ? safeWind.x : 0;
      const ay = -GRAVITY * gravScale + (gadget.windAffected ? safeWind.y : 0);
      const az = gadget.windAffected ? safeWind.z : 0;
      vel.x += ax * SIM_DT;
      vel.y += ay * SIM_DT;
      vel.z += az * SIM_DT;
    }

    pos.x += vel.x * SIM_DT;
    pos.y += vel.y * SIM_DT;
    pos.z += vel.z * SIM_DT;

    const hitPrismWall = findPrismWallCollision(
      prismWalls,
      prevPos,
      pos,
      params.shooterId,
    );
    if (hitPrismWall !== null) {
      const impactPoint: Vec3 = { ...hitPrismWall.hitPos };
      path.push(impactPoint);
      return {
        path,
        durationSec,
        impacts: [
          {
            time: durationSec,
            position: impactPoint,
            carveOp: null,
            damageRadius: 0,
            baseDamage: 0,
            knockback: 0,
          },
        ],
        carveOps: [],
        hits: [],
        shatteredPrismWallIds: [hitPrismWall.wall.id],
      };
    }

    if (Math.round(t / SIM_DT) % 2 === 0) {
      path.push({ ...pos });
    }

    if (pos.y <= waterLevel || isOutOfBounds(world, pos)) {
      path.push({ ...pos });
      break;
    }

    const hitCritter = findCritterCollision(critters, pos, params.shooterId, t);
    const hitSolid = world.isSolid(pos.x, pos.y, pos.z);
    const reachedSeekerTarget =
      seekerTarget !== null &&
      Math.hypot(
        pos.x - seekerTarget.x,
        pos.y - seekerTarget.y,
        pos.z - seekerTarget.z,
      ) <= 0.75;

    if (params.gadgetId === "spore_burst" && hitSolid && !hitCritter && !bounced) {
      bounced = true;
      const normal = world.sampleNormal(pos.x, pos.y, pos.z);
      const dot = vel.x * normal.x + vel.y * normal.y + vel.z * normal.z;
      vel.x = (vel.x - 2 * dot * normal.x) * 0.55;
      vel.y = (vel.y - 2 * dot * normal.y) * 0.55;
      vel.z = (vel.z - 2 * dot * normal.z) * 0.55;
      pos.x += normal.x * 0.25;
      pos.y += normal.y * 0.25;
      pos.z += normal.z * 0.25;
      path.push({ ...pos });
      continue;
    }

    if (bounced) {
      postBounceTime += SIM_DT;
    }

    if (
      hitCritter !== null ||
      hitSolid ||
      reachedSeekerTarget ||
      (bounced && postBounceTime >= 0.55)
    ) {
      impacted = true;
      impactPos = { ...pos };
      impactDir = safeNormalizeVec3(vel) ?? normDir;
      hitTerrainForBore = hitSolid;
      path.push({ ...impactPos });
      break;
    }
  }

  if (!impacted) {
    return { path, durationSec, impacts, carveOps, hits: [] };
  }

  // --- 3. Build weapon-specific impacts & carve ops ---
  if (params.gadgetId === "burrow_bore") {
    const tunnelDuration = gadget.tunnelDurationSec ?? 0.6;
    const tunnelSpeed = 6.0 * mapCarveScale;
    const entryPos: Vec3 = { ...impactPos };
    const endPos: Vec3 = hitTerrainForBore
      ? {
          x: entryPos.x + impactDir.x * tunnelSpeed * tunnelDuration,
          y: entryPos.y + impactDir.y * tunnelSpeed * tunnelDuration,
          z: entryPos.z + impactDir.z * tunnelSpeed * tunnelDuration,
        }
      : { ...entryPos };

    if (hitTerrainForBore) {
      const tunnelSteps = 6;
      for (let i = 1; i <= tunnelSteps; i++) {
        const f = i / tunnelSteps;
        path.push({
          x: entryPos.x + (endPos.x - entryPos.x) * f,
          y: entryPos.y + (endPos.y - entryPos.y) * f,
          z: entryPos.z + (endPos.z - entryPos.z) * f,
        });
      }
      durationSec = Number((durationSec + tunnelDuration).toFixed(4));

      const capsuleOp: CarveOp = {
        shape: "capsule",
        center: entryPos,
        end: endPos,
        radius: Number((1.25 * carveMult).toFixed(4)),
      };
      carveOps.push(capsuleOp);
    }

    const detonateOp: CarveOp = {
      shape: "sphere",
      center: endPos,
      radius: Number((gadget.carveRadius * carveMult).toFixed(4)),
    };
    carveOps.push(detonateOp);
    impacts.push({
      time: durationSec,
      position: endPos,
      carveOp: detonateOp,
      damageRadius: detonateOp.radius * 1.5,
      baseDamage: gadget.baseDamage,
      knockback: gadget.knockback,
    });
  } else if (params.gadgetId === "spore_burst") {
    const count = gadget.subSporeCount ?? 5;
    const spreadRadius = 2.4 * mapCarveScale;
    for (let i = 0; i < count; i++) {
      const angle = (i * Math.PI * 2) / count;
      const sx = impactPos.x + Math.cos(angle) * spreadRadius;
      const sz = impactPos.z + Math.sin(angle) * spreadRadius;
      const surfY = world.getSurfaceY(sx, sz);
      const sy =
        surfY !== null && Math.abs(surfY - impactPos.y) <= 3.0
          ? surfY + 0.1
          : impactPos.y;
      const subPos: Vec3 = { x: sx, y: sy, z: sz };
      const subCarve: CarveOp = {
        shape: "sphere",
        center: subPos,
        radius: Number((gadget.carveRadius * 0.65 * carveMult).toFixed(4)),
      };
      carveOps.push(subCarve);
      impacts.push({
        time: Number((durationSec + 0.18).toFixed(4)),
        position: subPos,
        carveOp: subCarve,
        damageRadius: 2.9 * mapCarveScale,
        baseDamage: gadget.baseDamage,
        knockback: gadget.knockback,
        isSubSpore: true,
      });
    }
    durationSec = Number((durationSec + 0.18).toFixed(4));
  } else {
    const isPull = params.gadgetId === "gravity_mine";
    const carveRadius = Number((gadget.carveRadius * carveMult).toFixed(4));
    const carveOp: CarveOp = {
      shape: "sphere",
      center: impactPos,
      radius: carveRadius,
    };
    carveOps.push(carveOp);

    const damageRadius = isPull
      ? Math.max(4.5, carveRadius * 2.2)
      : params.gadgetId === "shock_magnet"
        ? Math.max(3.8, carveRadius * 2.2)
        : Math.max(3.5, carveRadius * 1.45);

    impacts.push({
      time: durationSec,
      position: impactPos,
      carveOp,
      damageRadius,
      baseDamage: gadget.baseDamage,
      knockback: Math.abs(gadget.knockback),
      ...(isPull ? { isPull: true } : {}),
    });
  }

  // --- 4. Twin Shoulder Pod bonus mini-dart on direct hits ---
  if (shooterStats.bonusMiniDart && impacts.length > 0) {
    const firstImpact = impacts[0];
    if (firstImpact) {
      const directHit = critters.some((c) => {
        if (!c.alive) return false;
        const d = Math.hypot(
          c.position.x - firstImpact.position.x,
          c.position.y + CRITTER_HEIGHT_CENTER - firstImpact.position.y,
          c.position.z - firstImpact.position.z,
        );
        return d <= Math.min(2.0, firstImpact.damageRadius);
      });
      if (directHit) {
        const miniCarve: CarveOp = {
          shape: "sphere",
          center: { ...firstImpact.position },
          radius: Number((1.0 * carveMult).toFixed(4)),
        };
        carveOps.push(miniCarve);
        impacts.push({
          time: Number((durationSec + 0.08).toFixed(4)),
          position: { ...firstImpact.position },
          carveOp: miniCarve,
          damageRadius: 2.0,
          baseDamage: 10,
          knockback: 3,
        });
      }
    }
  }

  // --- 5. Resolve damage, Aegis Crest shield, knockback, fall damage & post-carve settling ---
  const hits: CritterHitResult[] = [];

  for (const critter of critters) {
    if (!critter.alive) continue;
    const targetStats = computeCritterStats(critter.species, critter.equipped);
    let remainingShield = critter.roundShieldRemaining;
    let totalDamage = 0;
    let shieldAbsorbed = false;
    let affected = false;
    const kbVel: Vec3 = { x: 0, y: 0, z: 0 };

    const centerY = critter.position.y + CRITTER_HEIGHT_CENTER;

    for (const imp of impacts) {
      const dx = critter.position.x - imp.position.x;
      const dy = centerY - imp.position.y;
      const dz = critter.position.z - imp.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > imp.damageRadius) continue;

      affected = true;
      const falloff = Math.max(0.25, 1 - (dist / imp.damageRadius) * 0.75);
      let dmg = Math.round(imp.baseDamage * falloff * damageMult);

      if (remainingShield > 0 && dmg > 0) {
        remainingShield -= 1;
        shieldAbsorbed = true;
        dmg = 0;
      }
      totalDamage += dmg;

      const kbMag = imp.knockback * falloff * (1 - targetStats.knockbackResist);
      if (kbMag > 0.01) {
        const rawDir: Vec3 = imp.isPull
          ? { x: -dx, y: Math.max(0.35, -dy + 0.4), z: -dz }
          : dist < 0.05
            ? { x: 0, y: 1, z: 0 }
            : { x: dx, y: Math.max(0.35, dy + 0.45), z: dz };
        const kbDir = safeNormalizeVec3(rawDir) ?? { x: 0, y: 1, z: 0 };
        kbVel.x += kbDir.x * kbMag;
        kbVel.y += kbDir.y * kbMag;
        kbVel.z += kbDir.z * kbMag;
      }
    }

    // Even if outside damageRadius, check if terrain directly underfoot was carved out
    const floorCarved = !isSolidAfterCarves(
      world,
      carveOps,
      critter.position.x,
      critter.position.y - 0.35,
      critter.position.z,
    );

    if (!affected && !floorCarved) {
      continue;
    }

    const settled = settleCritterPosition(
      world,
      carveOps,
      critter.position,
      kbVel,
      waterLevel,
    );
    const fallDmg = computeFallDamage(
      settled.fallDrop,
      targetStats.fallDamageResist,
    );
    totalDamage += fallDmg;
    const newHp = settled.drowned ? 0 : Math.max(0, critter.hp - totalDamage);
    hits.push({
      critterId: critter.id,
      damage: totalDamage,
      shieldAbsorbed,
      knockbackVelocity: kbVel,
      newPosition: settled.position,
      newHp,
      drowned: settled.drowned,
      knockedOut: newHp <= 0 || settled.drowned,
    });
  }

  return {
    path,
    durationSec,
    impacts,
    carveOps,
    hits,
  };
}
