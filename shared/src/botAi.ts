import { GRAVITY, safeNormalizeVec3 } from "./physics.js";
import { SDF_DIMS, type SdfWorld } from "./sdf.js";
import type { CritterState, GadgetId, MatchState, Vec3 } from "./types.js";

/** Tactical move and firing plan computed for an AI bot critter's turn. */
export interface BotPlan {
  moveTarget: Vec3;
  gadgetId: GadgetId;
  direction: Vec3;
  power: number;
  droneTarget?: Vec3;
}

const MIN_BOT_POWER = 0.25;
const MAX_BOT_POWER = 1.0;
const FALLBACK_DIR: Vec3 = { x: 0.7071, y: 0.7071, z: 0 };
const WORLD_CENTER_X = SDF_DIMS.nx * SDF_DIMS.voxelSize * 0.5;
const WORLD_CENTER_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize * 0.5;
const WORLD_MAX_X = SDF_DIMS.nx * SDF_DIMS.voxelSize;
const WORLD_MAX_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function hasTerrainObstruction(
  world: SdfWorld,
  from: Vec3,
  to: Vec3,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1.0) {
    return false;
  }
  const steps = Math.ceil(dist / 0.85);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const px = from.x + dx * t;
    const py = from.y + dy * t;
    const pz = from.z + dz * t;
    if (world.isSolid(px, py, pz)) {
      return true;
    }
  }
  return false;
}

function solveBallisticAim(
  origin: Vec3,
  target: Vec3,
  wind: Vec3,
  windAffected: boolean,
  gravityScale: number,
  speedMin: number,
  speedRange: number,
): { direction: Vec3; power: number } {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const dist = Math.hypot(dx, dy, dz);

  const wx = windAffected ? wind.x : 0;
  const wy = windAffected ? wind.y : 0;
  const wz = windAffected ? wind.z : 0;
  const effGravity = GRAVITY * gravityScale;

  // Test candidate flight times spanning close-range to cross-archipelago high arcs
  const baseT = clamp(dist / 16.5, 0.35, 2.4);
  const candidates = [
    baseT,
    clamp(baseT * 1.28, 0.45, 2.9),
    clamp(baseT * 0.78, 0.3, 1.9),
    clamp(baseT * 1.55, 0.6, 3.3),
  ];

  let bestDir: Vec3 = FALLBACK_DIR;
  let bestPower = 0.65;
  let bestError = Infinity;

  for (const t of candidates) {
    const vx = (dx - 0.5 * wx * t * t) / t;
    const vy = (dy + 0.5 * (effGravity - wy) * t * t) / t;
    const vz = (dz - 0.5 * wz * t * t) / t;
    const speed = Math.hypot(vx, vy, vz);
    const dir = safeNormalizeVec3({ x: vx, y: vy, z: vz });
    if (!dir) continue;

    const rawPower = (speed - speedMin) / speedRange;
    const clampedPower = clamp(rawPower, MIN_BOT_POWER, MAX_BOT_POWER);
    const speedError = Math.abs(rawPower - clampedPower);
    if (speedError < bestError) {
      bestError = speedError;
      bestDir = dir;
      bestPower = Number(clampedPower.toFixed(4));
    }
  }

  return { direction: bestDir, power: bestPower };
}

/**
 * Walk incrementally from `start` toward `(goalX, goalZ)` while verifying every
 * intermediate foothold stays on safe walkable terrain above `waterLevel` (never off cliffs).
 */
function findSafeWalkStep(
  world: SdfWorld,
  start: Vec3,
  goalX: number,
  goalZ: number,
  maxStepDist: number,
  waterLevel: number,
): Vec3 {
  const baseDx = goalX - start.x;
  const baseDz = goalZ - start.z;
  const baseDist = Math.hypot(baseDx, baseDz);
  if (baseDist < 0.25) {
    return { ...start };
  }

  const baseAngle = Math.atan2(baseDx, baseDz);
  const angleOffsets = [0, 0.42, -0.42, 0.85, -0.85];
  const stepSize = 1.0;

  let bestPos: Vec3 = { ...start };
  let bestProgress = -Infinity;

  for (const offset of angleOffsets) {
    const angle = baseAngle + offset;
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);

    let curX = start.x;
    let curY = start.y;
    let curZ = start.z;
    const targetDist = Math.min(maxStepDist, baseDist);

    for (let d = stepSize; d <= targetDist + 0.01; d += stepSize) {
      const clampedD = Math.min(d, targetDist);
      const nx = start.x + dirX * clampedD;
      const nz = start.z + dirZ * clampedD;
      if (
        nx < 3.0 ||
        nx > WORLD_MAX_X - 3.0 ||
        nz < 3.0 ||
        nz > WORLD_MAX_Z - 3.0
      ) {
        break;
      }
      const sy = world.getSurfaceY(nx, nz);
      if (sy === null || sy <= waterLevel + 1.0) {
        break;
      }
      if (Math.abs(sy - curY) > 1.8) {
        break;
      }
      const normal = world.sampleNormal(nx, sy, nz);
      if (normal.y < 0.56) {
        break;
      }
      curX = nx;
      curY = sy;
      curZ = nz;
    }

    const moved = Math.hypot(curX - start.x, curZ - start.z);
    if (moved < 0.5) {
      continue;
    }
    const newGoalDist = Math.hypot(goalX - curX, goalZ - curZ);
    const progress = baseDist - newGoalDist;
    if (progress > bestProgress) {
      bestProgress = progress;
      bestPos = { x: curX, y: curY, z: curZ };
    }
  }

  return bestPos;
}

function chooseMoveTarget(
  state: MatchState,
  world: SdfWorld,
  bot: CritterState,
  primaryEnemy: CritterState | null,
): Vec3 {
  // 1. Opportunistically grab nearby uncollected Evo Pods safely above water
  let bestPodPos: Vec3 | null = null;
  let bestPodDist = 12.0;
  for (const pod of state.evoPods) {
    if (pod.collected || pod.position.y <= state.waterLevel + 1.0) {
      continue;
    }
    const d = Math.hypot(
      pod.position.x - bot.position.x,
      pod.position.y - bot.position.y,
      pod.position.z - bot.position.z,
    );
    if (d < bestPodDist) {
      bestPodDist = d;
      bestPodPos = { ...pod.position };
    }
  }
  if (bestPodPos) {
    const stepTowardPod = findSafeWalkStep(
      world,
      bot.position,
      bestPodPos.x,
      bestPodPos.z,
      7.5,
      state.waterLevel,
    );
    if (
      Math.hypot(
        stepTowardPod.x - bot.position.x,
        stepTowardPod.z - bot.position.z,
      ) >= 0.5
    ) {
      return stepTowardPod;
    }
  }

  // 2. Retreat inward/uphill if near rising water or outer sudden-death crumble zone
  const radialFromCenter = Math.hypot(
    bot.position.x - WORLD_CENTER_X,
    bot.position.z - WORLD_CENTER_Z,
  );
  if (
    bot.position.y < state.waterLevel + 2.2 ||
    (state.turnNumber >= 5 && radialFromCenter > 22.5)
  ) {
    const safeInward = findSafeWalkStep(
      world,
      bot.position,
      WORLD_CENTER_X,
      WORLD_CENTER_Z,
      6.0,
      state.waterLevel,
    );
    if (safeInward.y >= bot.position.y - 0.5) {
      return safeInward;
    }
  }

  // 3. On early turns or when out of optimal engagement range (> 26m), advance toward mid-island/enemy
  if (primaryEnemy) {
    const enemyDist = Math.hypot(
      primaryEnemy.position.x - bot.position.x,
      primaryEnemy.position.z - bot.position.z,
    );
    if (state.turnNumber <= 3 || enemyDist > 26.0) {
      // Blend target between enemy direction and central high-ground bridges
      const goalX = primaryEnemy.position.x * 0.55 + WORLD_CENTER_X * 0.45;
      const goalZ = primaryEnemy.position.z * 0.55 + WORLD_CENTER_Z * 0.45;
      return findSafeWalkStep(
        world,
        bot.position,
        goalX,
        goalZ,
        6.5,
        state.waterLevel,
      );
    }
  }

  return { ...bot.position };
}

/**
 * Plan a deterministic tactical turn for an AI bot critter:
 * picks nearest/weakest enemy (never own teammate in 2v2), advances safely across
 * the 60m archipelago without walking off cliffs, selects an optimal gadget,
 * and computes a gravity- and wind-compensated aim vector with power in [0.25..1.0].
 */
export function planBotTurn(
  state: MatchState,
  world: SdfWorld,
  botId: string,
): BotPlan {
  const bot = state.critters.find((c) => c.id === botId);
  if (!bot) {
    return {
      moveTarget: { x: WORLD_CENTER_X, y: 10, z: WORLD_CENTER_Z },
      gadgetId: "gale_mortar",
      direction: FALLBACK_DIR,
      power: 0.55,
    };
  }

  const enemies = state.critters.filter((c) => {
    if (!c.alive || c.id === bot.id) return false;
    if (state.mode === "2v2" && bot.team !== null && c.team === bot.team) {
      return false;
    }
    return true;
  });

  if (enemies.length === 0) {
    return {
      moveTarget: { ...bot.position },
      gadgetId: "gale_mortar",
      direction: FALLBACK_DIR,
      power: 0.55,
    };
  }

  // Pick nearest / weakest enemy using deterministic composite score
  let target = enemies[0] ?? null;
  let bestScore = Infinity;
  for (const enemy of enemies) {
    const dist = Math.hypot(
      enemy.position.x - bot.position.x,
      enemy.position.y - bot.position.y,
      enemy.position.z - bot.position.z,
    );
    const hpRatio = enemy.maxHp > 0 ? enemy.hp / enemy.maxHp : 1;
    const score = dist * 0.75 + hpRatio * 8.0;
    if (score < bestScore) {
      bestScore = score;
      target = enemy;
    }
  }

  const moveTarget = chooseMoveTarget(state, world, bot, target);

  if (!target) {
    return {
      moveTarget,
      gadgetId: "gale_mortar",
      direction: FALLBACK_DIR,
      power: 0.55,
    };
  }

  const origin: Vec3 = {
    x: moveTarget.x,
    y: moveTarget.y + 0.6,
    z: moveTarget.z,
  };
  const targetAimPos: Vec3 = {
    x: target.position.x,
    y: target.position.y + 0.45,
    z: target.position.z,
  };
  const dist = Math.hypot(
    targetAimPos.x - origin.x,
    targetAimPos.y - origin.y,
    targetAimPos.z - origin.z,
  );

  // Close-range knockback slam
  if (dist <= 2.6) {
    const meleeDir =
      safeNormalizeVec3({
        x: targetAimPos.x - origin.x,
        y: Math.max(0.15, targetAimPos.y - origin.y + 0.2),
        z: targetAimPos.z - origin.z,
      }) ?? FALLBACK_DIR;
    return {
      moveTarget,
      gadgetId: "quake_club",
      direction: meleeDir,
      power: 0.85,
    };
  }

  const obstructed = hasTerrainObstruction(world, origin, targetAimPos);
  const hasCharge = (id: GadgetId): boolean => {
    const c = bot.gadgetCharges[id];
    return c === null || c > 0;
  };

  if (obstructed && hasCharge("burrow_bore") && dist <= 32.0) {
    const solved = solveBallisticAim(
      origin,
      targetAimPos,
      state.wind,
      false,
      0.25,
      15.0,
      14.0,
    );
    return {
      moveTarget,
      gadgetId: "burrow_bore",
      direction: solved.direction,
      power: solved.power,
    };
  }

  if (obstructed && hasCharge("seeker_firefly")) {
    const fireflyDir =
      safeNormalizeVec3({
        x: targetAimPos.x - origin.x,
        y: Math.max(0.6, targetAimPos.y - origin.y + 5.0),
        z: targetAimPos.z - origin.z,
      }) ?? FALLBACK_DIR;
    return {
      moveTarget,
      gadgetId: "seeker_firefly",
      direction: fireflyDir,
      power: 0.75,
      droneTarget: targetAimPos,
    };
  }

  const gadgetId: GadgetId =
    dist >= 10.0 && hasCharge("spore_burst") ? "spore_burst" : "gale_mortar";

  const solved = solveBallisticAim(
    origin,
    targetAimPos,
    state.wind,
    true,
    1.0,
    9.0,
    18.5,
  );

  return {
    moveTarget,
    gadgetId,
    direction: solved.direction,
    power: solved.power,
  };
}
