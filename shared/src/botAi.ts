import { GRAVITY, safeNormalizeVec3 } from "./physics.js";
import type { SdfWorld } from "./sdf.js";
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
  const steps = Math.ceil(dist / 0.6);
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

  // Try candidate flight times to find a clean launch speed within [speedMin..speedMin+speedRange]
  const baseT = clamp(dist / 12.0, 0.35, 1.85);
  const candidates = [baseT, clamp(baseT * 1.3, 0.4, 2.2), clamp(baseT * 0.75, 0.25, 1.4)];

  let bestDir: Vec3 = FALLBACK_DIR;
  let bestPower = 0.6;
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

function chooseMoveTarget(
  state: MatchState,
  world: SdfWorld,
  bot: CritterState,
): Vec3 {
  // Opportunistically grab nearby uncollected Evo Pods above water
  let bestPodPos: Vec3 | null = null;
  let bestPodDist = 5.0;
  for (const pod of state.evoPods) {
    if (pod.collected || pod.position.y <= state.waterLevel + 0.8) {
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
    return bestPodPos;
  }

  // If standing dangerously close to rising water, step toward higher nearby ground
  if (bot.position.y < state.waterLevel + 1.8) {
    let bestPos: Vec3 = { ...bot.position };
    let bestY = bot.position.y;
    const offsets: ReadonlyArray<[number, number]> = [
      [1.5, 0],
      [-1.5, 0],
      [0, 1.5],
      [0, -1.5],
      [1.2, 1.2],
      [-1.2, -1.2],
    ];
    for (const [ox, oz] of offsets) {
      const cx = bot.position.x + ox;
      const cz = bot.position.z + oz;
      const sy = world.getSurfaceY(cx, cz);
      if (sy !== null && sy > bestY) {
        bestY = sy;
        bestPos = { x: cx, y: sy, z: cz };
      }
    }
    return bestPos;
  }

  return { ...bot.position };
}

/**
 * Plan a deterministic tactical turn for an AI bot critter:
 * picks nearest/weakest enemy (never own teammate in 2v2), selects an optimal gadget,
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
      moveTarget: { x: 12, y: 7, z: 12 },
      gadgetId: "gale_mortar",
      direction: FALLBACK_DIR,
      power: 0.5,
    };
  }

  const moveTarget = chooseMoveTarget(state, world, bot);
  const enemies = state.critters.filter((c) => {
    if (!c.alive || c.id === bot.id) return false;
    if (state.mode === "2v2" && bot.team !== null && c.team === bot.team) {
      return false;
    }
    return true;
  });

  if (enemies.length === 0) {
    return {
      moveTarget,
      gadgetId: "gale_mortar",
      direction: FALLBACK_DIR,
      power: 0.5,
    };
  }

  // Pick nearest / weakest enemy using deterministic composite score
  let target = enemies[0];
  let bestScore = Infinity;
  for (const enemy of enemies) {
    const dist = Math.hypot(
      enemy.position.x - moveTarget.x,
      enemy.position.y - moveTarget.y,
      enemy.position.z - moveTarget.z,
    );
    const hpRatio = enemy.maxHp > 0 ? enemy.hp / enemy.maxHp : 1;
    const score = dist * 0.75 + hpRatio * 6.0;
    if (score < bestScore) {
      bestScore = score;
      target = enemy;
    }
  }

  if (!target) {
    return {
      moveTarget,
      gadgetId: "gale_mortar",
      direction: FALLBACK_DIR,
      power: 0.5,
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

  if (obstructed && hasCharge("burrow_bore")) {
    const solved = solveBallisticAim(
      origin,
      targetAimPos,
      state.wind,
      false,
      0.25,
      12.0,
      12.0,
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
        y: Math.max(0.5, targetAimPos.y - origin.y + 3.0),
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
    dist >= 6.5 && hasCharge("spore_burst") ? "spore_burst" : "gale_mortar";

  const solved = solveBallisticAim(
    origin,
    targetAimPos,
    state.wind,
    true,
    1.0,
    6.0,
    16.0,
  );

  return {
    moveTarget,
    gadgetId,
    direction: solved.direction,
    power: solved.power,
  };
}
