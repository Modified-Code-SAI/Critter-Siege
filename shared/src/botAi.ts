import { GRAVITY, safeNormalizeVec3 } from "./physics.js";
import type { SdfWorld } from "./sdf.js";
import type {
  CritterState,
  GadgetId,
  HazardState,
  MatchState,
  Vec3,
} from "./types.js";

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

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function distToHorizontalSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-6) {
    return Math.hypot(px - ax, pz - az);
  }
  const t = clamp(((px - ax) * abx + (pz - az) * abz) / lenSq, 0, 1);
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

function checkArcClearsObstacles(
  world: SdfWorld,
  origin: Vec3,
  dir: Vec3,
  speed: number,
  wind: Vec3,
  windAffected: boolean,
  gravityScale: number,
  flightTime: number,
): boolean {
  const wx = windAffected ? wind.x : 0;
  const wy = windAffected ? wind.y : 0;
  const wz = windAffected ? wind.z : 0;
  const effG = GRAVITY * gravityScale;
  const steps = Math.max(8, Math.ceil(flightTime / 0.12));
  // Check the middle 80% of the trajectory to verify it vaults cleanly over dividing walls
  const maxCheck = Math.max(1, Math.floor(steps * 0.82));
  for (let i = 1; i <= maxCheck; i++) {
    const t = (flightTime * i) / steps;
    const px = origin.x + dir.x * speed * t + 0.5 * wx * t * t;
    const py = origin.y + dir.y * speed * t + 0.5 * (wy - effG) * t * t;
    const pz = origin.z + dir.z * speed * t + 0.5 * wz * t * t;
    if (world.isSolid(px, py, pz)) {
      return false;
    }
  }
  return true;
}

function solveBallisticAim(
  world: SdfWorld,
  origin: Vec3,
  target: Vec3,
  wind: Vec3,
  windAffected: boolean,
  gravityScale: number,
  speedMin: number,
  speedRange: number,
  preferHighArc: boolean,
): { direction: Vec3; power: number } {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const dist = Math.hypot(dx, dy, dz);

  const wx = windAffected ? wind.x : 0;
  const wy = windAffected ? wind.y : 0;
  const wz = windAffected ? wind.z : 0;
  const effGravity = GRAVITY * gravityScale;

  const isGrand = world.mapScale === "grand";
  const maxTime = isGrand ? 5.2 : 3.6;
  const baseT = clamp(dist / (isGrand ? 21.0 : 16.5), 0.35, maxTime * 0.65);

  const candidates = preferHighArc
    ? [
        clamp(baseT * 1.45, 0.55, maxTime),
        clamp(baseT * 1.85, 0.7, maxTime),
        clamp(baseT * 2.25, 0.85, maxTime),
        clamp(baseT * 1.15, 0.45, maxTime),
        baseT,
      ]
    : [
        baseT,
        clamp(baseT * 1.28, 0.45, maxTime),
        clamp(baseT * 0.78, 0.3, maxTime),
        clamp(baseT * 1.65, 0.6, maxTime),
      ];

  let bestDir: Vec3 = FALLBACK_DIR;
  let bestPower = 0.7;
  let bestScore = Infinity;

  for (const t of candidates) {
    const vx = (dx - 0.5 * wx * t * t) / t;
    const vy = (dy + 0.5 * (effGravity - wy) * t * t) / t;
    const vz = (dz - 0.5 * wz * t * t) / t;
    const speed = Math.hypot(vx, vy, vz);
    const dir = safeNormalizeVec3({ x: vx, y: vy, z: vz });
    if (!dir) continue;

    const rawPower = (speed - speedMin) / speedRange;
    const clampedPower = clamp(rawPower, MIN_BOT_POWER, MAX_BOT_POWER);
    const actualSpeed = speedMin + clampedPower * speedRange;
    const speedError = Math.abs(rawPower - clampedPower);
    const clearsWalls = checkArcClearsObstacles(
      world,
      origin,
      dir,
      actualSpeed,
      wind,
      windAffected,
      gravityScale,
      t,
    );
    const wallPenalty = clearsWalls ? 0.0 : preferHighArc ? 2.5 : 0.8;
    const score = speedError * 3.0 + wallPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestDir = dir;
      bestPower = Number(clampedPower.toFixed(4));
    }
  }

  return { direction: bestDir, power: bestPower };
}

function isNearDangerousHazard(
  x: number,
  y: number,
  z: number,
  hazards: readonly HazardState[],
): boolean {
  for (const h of hazards) {
    if (!h.active) continue;
    if (h.type === "spark_mine") {
      if (Math.hypot(x - h.position.x, y - h.position.y, z - h.position.z) <= 2.65) {
        return true;
      }
    } else if (h.type === "thorn_patch") {
      if (
        Math.hypot(x - h.position.x, z - h.position.z) <= 2.05 &&
        Math.abs(y - h.position.y) <= 1.5
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Walk incrementally from `start` toward `(goalX, goalZ)` while verifying every
 * intermediate foothold stays on safe walkable terrain above `waterLevel` and clear of mines/thorns.
 */
function findSafeWalkStep(
  world: SdfWorld,
  start: Vec3,
  goalX: number,
  goalZ: number,
  maxStepDist: number,
  waterLevel: number,
  hazards: readonly HazardState[],
): Vec3 {
  const baseDx = goalX - start.x;
  const baseDz = goalZ - start.z;
  const baseDist = Math.hypot(baseDx, baseDz);
  if (baseDist < 0.25) {
    return { ...start };
  }

  const maxX = world.worldWidth;
  const maxZ = world.worldDepth;
  const baseAngle = Math.atan2(baseDx, baseDz);
  const angleOffsets = [0, 0.42, -0.42, 0.85, -0.85];
  const stepSize = world.mapScale === "grand" ? 1.4 : 1.0;

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
      if (nx < 3.0 || nx > maxX - 3.0 || nz < 3.0 || nz > maxZ - 3.0) {
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
      if (isNearDangerousHazard(nx, sy, nz, hazards)) {
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
  const hazards = state.hazards ?? [];
  const isGrand = world.mapScale === "grand";
  const walkReach = isGrand ? 10.5 : 6.5;

  // 1. Opportunistically grab nearby uncollected Evo Pods safely above water
  let bestPodPos: Vec3 | null = null;
  let bestPodDist = isGrand ? 20.0 : 12.0;
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
      walkReach + 1.0,
      state.waterLevel,
      hazards,
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
    bot.position.x - world.centerX,
    bot.position.z - world.centerZ,
  );
  const suddenDeathWarnTurn = isGrand ? 7 : 5;
  const safeInnerRadius = isGrand ? 56.0 : 22.5;
  if (
    bot.position.y < state.waterLevel + 2.2 ||
    (state.turnNumber >= suddenDeathWarnTurn &&
      radialFromCenter > safeInnerRadius)
  ) {
    const safeInward = findSafeWalkStep(
      world,
      bot.position,
      world.centerX,
      world.centerZ,
      walkReach,
      state.waterLevel,
      hazards,
    );
    if (safeInward.y >= bot.position.y - 0.5) {
      return safeInward;
    }
  }

  // 3. When lacking direct line of sight, consider stepping toward a nearby Steam Geyser or flanking pass
  if (primaryEnemy) {
    const obstructed = !world.hasDirectLineOfSight(
      bot.position,
      primaryEnemy.position,
      1.1,
    );
    if (obstructed) {
      let bestGeyser: HazardState | null = null;
      let bestGeyserDist = isGrand ? 24.0 : 14.0;
      for (const h of hazards) {
        if (!h.active || h.type !== "steam_geyser") continue;
        const d = Math.hypot(
          h.position.x - bot.position.x,
          h.position.y - bot.position.y,
          h.position.z - bot.position.z,
        );
        if (d > 1.8 && d < bestGeyserDist) {
          bestGeyserDist = d;
          bestGeyser = h;
        }
      }
      if (bestGeyser) {
        const towardGeyser = findSafeWalkStep(
          world,
          bot.position,
          bestGeyser.position.x,
          bestGeyser.position.z,
          walkReach,
          state.waterLevel,
          hazards,
        );
        if (
          Math.hypot(
            towardGeyser.x - bot.position.x,
            towardGeyser.z - bot.position.z,
          ) >= 0.8
        ) {
          return towardGeyser;
        }
      }
    }

    const enemyDist = Math.hypot(
      primaryEnemy.position.x - bot.position.x,
      primaryEnemy.position.z - bot.position.z,
    );
    const engageRange = isGrand ? 56.0 : 26.0;
    if (obstructed || state.turnNumber <= 3 || enemyDist > engageRange) {
      // Advance toward flanking passes / mid-island bridges
      const goalX = primaryEnemy.position.x * 0.52 + world.centerX * 0.48;
      const goalZ = primaryEnemy.position.z * 0.52 + world.centerZ * 0.48;
      return findSafeWalkStep(
        world,
        bot.position,
        goalX,
        goalZ,
        walkReach,
        state.waterLevel,
        hazards,
      );
    }
  }

  return { ...bot.position };
}

function findTacticalBarrelTarget(
  world: SdfWorld,
  hazards: readonly HazardState[],
  origin: Vec3,
  targetPos: Vec3,
  enemies: readonly CritterState[],
): Vec3 | null {
  const isGrand = world.mapScale === "grand";
  const corridorWidth = isGrand ? 22.0 : 11.0;
  const maxBarrelRange = isGrand ? 70.0 : 34.0;
  const targetDist = Math.hypot(
    targetPos.x - origin.x,
    targetPos.z - origin.z,
  );

  let bestBarrelPos: Vec3 | null = null;
  let bestScore = Infinity;

  for (const h of hazards) {
    if (!h.active || h.type !== "blast_barrel") continue;
    const distFromBot = Math.hypot(
      h.position.x - origin.x,
      h.position.y - origin.y,
      h.position.z - origin.z,
    );
    if (distFromBot < 5.5 || distFromBot > maxBarrelRange) continue;

    // Require direct line-of-sight to the barrel seam so the bot can actually detonate it
    const barrelAim: Vec3 = {
      x: h.position.x,
      y: h.position.y + 0.5,
      z: h.position.z,
    };
    if (
      !world.hasDirectLineOfSight(
        { x: origin.x, y: origin.y - 0.6, z: origin.z },
        h.position,
        0.9,
      )
    ) {
      continue;
    }

    const nearEnemy = enemies.some(
      (e) =>
        Math.hypot(
          e.position.x - h.position.x,
          e.position.y - h.position.y,
          e.position.z - h.position.z,
        ) <= 6.5,
    );
    const corridorDist = distToHorizontalSegment(
      h.position.x,
      h.position.z,
      origin.x,
      origin.z,
      targetPos.x,
      targetPos.z,
    );
    const liesBetween =
      distFromBot < targetDist + 6.0 && corridorDist <= corridorWidth;

    if (!nearEnemy && !liesBetween) continue;

    const score = (nearEnemy ? 0 : 12) + corridorDist + distFromBot * 0.15;
    if (score < bestScore) {
      bestScore = score;
      bestBarrelPos = barrelAim;
    }
  }

  return bestBarrelPos;
}

/**
 * Plan a deterministic tactical turn for an AI bot critter across both 60m Duel
 * and 144m Grand islands: picks nearest/weakest enemy (never own teammate in 2v2),
 * advances safely toward passes/geysers while avoiding Spark Mines & thorns, and
 * when obstructed by dividing walls smartly blasts wall Blast Barrels, drills with
 * Burrow Bore, launches Seeker Firefly, or lobs high wall-clearing mortar arcs.
 */
export function planBotTurn(
  state: MatchState,
  world: SdfWorld,
  botId: string,
): BotPlan {
  const bot = state.critters.find((c) => c.id === botId);
  if (!bot) {
    return {
      moveTarget: { x: world.centerX, y: 10, z: world.centerZ },
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

  const isGrand = world.mapScale === "grand";
  const mortarSpeedMin = isGrand ? 11.0 : 9.0;
  const mortarSpeedRange = isGrand ? 31.0 : 18.5;
  const boreSpeedMin = isGrand ? 20.0 : 15.0;
  const boreSpeedRange = isGrand ? 20.0 : 14.0;

  const obstructed = !world.hasDirectLineOfSight(
    moveTarget,
    target.position,
    1.1,
  );
  const hasCharge = (id: GadgetId): boolean => {
    const c = bot.gadgetCharges[id];
    return c === null || c > 0;
  };

  // 1. If obstructed, check for a Blast Barrel along the dividing wall or beside an enemy!
  if (obstructed) {
    const barrelTarget = findTacticalBarrelTarget(
      world,
      state.hazards ?? [],
      origin,
      targetAimPos,
      enemies,
    );
    if (barrelTarget) {
      const solvedBarrel = solveBallisticAim(
        world,
        origin,
        barrelTarget,
        state.wind,
        true,
        1.0,
        mortarSpeedMin,
        mortarSpeedRange,
        false,
      );
      return {
        moveTarget,
        gadgetId: "gale_mortar",
        direction: solvedBarrel.direction,
        power: solvedBarrel.power,
      };
    }
  }

  // 2. Drill straight through blocking cliffs with Burrow Bore
  const boreRange = isGrand ? 72.0 : 34.0;
  if (obstructed && hasCharge("burrow_bore") && dist <= boreRange) {
    const solved = solveBallisticAim(
      world,
      origin,
      targetAimPos,
      state.wind,
      false,
      0.25,
      boreSpeedMin,
      boreSpeedRange,
      false,
    );
    return {
      moveTarget,
      gadgetId: "burrow_bore",
      direction: solved.direction,
      power: solved.power,
    };
  }

  // 3. Vault over tall dividing walls & central spires with Seeker Firefly
  if (obstructed && hasCharge("seeker_firefly")) {
    const fireflyDir =
      safeNormalizeVec3({
        x: targetAimPos.x - origin.x,
        y: Math.max(0.75, targetAimPos.y - origin.y + (isGrand ? 12.0 : 7.0)),
        z: targetAimPos.z - origin.z,
      }) ?? FALLBACK_DIR;
    return {
      moveTarget,
      gadgetId: "seeker_firefly",
      direction: fireflyDir,
      power: 0.78,
      droneTarget: targetAimPos,
    };
  }

  // 4. Fire wall-clearing high mortar arc (or Spore Burst cluster) over dividing barriers
  const gadgetId: GadgetId =
    dist >= 10.0 && hasCharge("spore_burst") ? "spore_burst" : "gale_mortar";

  const solved = solveBallisticAim(
    world,
    origin,
    targetAimPos,
    state.wind,
    true,
    1.0,
    mortarSpeedMin,
    mortarSpeedRange,
    obstructed,
  );

  return {
    moveTarget,
    gadgetId,
    direction: solved.direction,
    power: solved.power,
  };
}
