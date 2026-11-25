import { computeCritterStats } from "./catalog.js";
import { GRAVITY, safeNormalizeVec3 } from "./physics.js";
import { SDF_DIMS, type SdfWorld } from "./sdf.js";
import type {
  CarveOp,
  CritterState,
  EngineEvent,
  HazardState,
  ImpactEvent,
  Vec3,
} from "./types.js";

export const BARREL_CARVE_RADIUS = 2.8;
export const BARREL_DAMAGE = 28;
export const BARREL_KNOCKBACK = 14;
export const BARREL_CHAIN_MARGIN = 1.8;
export const BARREL_DAMAGE_RADIUS = 5.0;
export const MAX_BARREL_CHAIN_DEPTH = 6;
export const GEYSER_LAUNCH_HEIGHT = 9.0;
export const THORN_DAMAGE = 12;

const WORLD_MAX_X = SDF_DIMS.nx * SDF_DIMS.voxelSize;
const WORLD_MAX_Y = SDF_DIMS.ny * SDF_DIMS.voxelSize;
const WORLD_MAX_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize;
const CRITTER_HEIGHT_CENTER = 0.5;

/** Clone a HazardState cleanly for immutable match snapshots. */
export function cloneHazard(h: HazardState): HazardState {
  return {
    ...h,
    position: { ...h.position },
  };
}

/** Deterministically spawn 6-10 active interactive hazards for a match round. */
export function createRoundHazards(
  world: SdfWorld,
  round: number,
  spawns: readonly Vec3[],
): HazardState[] {
  const placements = world.findHazardPoints(spawns);
  return placements.map((p, idx) => ({
    id: `hazard-r${round}-${idx + 1}`,
    type: p.type,
    position: { ...p.position },
    radius: p.radius,
    active: true,
  }));
}

function settleKnockedCritter(
  world: SdfWorld,
  startPos: Vec3,
  initialVel: Vec3,
  waterLevel: number,
): { position: Vec3; drowned: boolean } {
  const pos: Vec3 = {
    x: startPos.x,
    y: startPos.y + 0.25,
    z: startPos.z,
  };
  const vel: Vec3 = { ...initialVel };
  const dt = 0.04;
  const maxSteps = 80;

  for (let i = 0; i < maxSteps; i++) {
    vel.y -= GRAVITY * dt;
    const nextX = pos.x + vel.x * dt;
    const nextY = pos.y + vel.y * dt;
    const nextZ = pos.z + vel.z * dt;

    if (
      nextY <= waterLevel ||
      nextX < -4 ||
      nextX > WORLD_MAX_X + 4 ||
      nextZ < -4 ||
      nextZ > WORLD_MAX_Z + 4
    ) {
      return {
        position: { x: nextX, y: Math.min(nextY, waterLevel), z: nextZ },
        drowned: true,
      };
    }

    if (world.isSolid(nextX, nextY, nextZ)) {
      if (vel.y <= 0) {
        let lo = nextY;
        let hi = pos.y;
        for (let step = 0; step < 6; step++) {
          const mid = (lo + hi) * 0.5;
          if (world.isSolid(nextX, mid, nextZ)) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        return {
          position: { x: nextX, y: hi, z: nextZ },
          drowned: hi <= waterLevel,
        };
      }
      vel.x *= -0.25;
      vel.z *= -0.25;
      vel.y = Math.min(0, -vel.y * 0.2);
      continue;
    }

    pos.x = nextX;
    pos.y = nextY;
    pos.z = nextZ;
  }

  return { position: pos, drowned: pos.y <= waterLevel };
}

/**
 * Evaluate ground-contact hazards (Thermal Steam Geysers & Bramble Thorn Patches)
 * for a moving or landing critter, mutating critter state and returning emitted events.
 */
export function applyGroundHazardsForCritter(
  world: SdfWorld,
  hazards: readonly HazardState[],
  critter: CritterState,
  thornTriggeredThisTurn: Set<string>,
  waterLevel: number,
): EngineEvent[] {
  if (!critter.alive) {
    return [];
  }

  const events: EngineEvent[] = [];

  // 1. Thermal Steam Geyser launchpad (+9m vertical catapult up to ceiling/sky cap)
  for (const h of hazards) {
    if (!h.active || h.type !== "steam_geyser") continue;
    const horizDist = Math.hypot(
      critter.position.x - h.position.x,
      critter.position.z - h.position.z,
    );
    const vertDist = Math.abs(critter.position.y - h.position.y);
    if (horizDist <= h.radius && vertDist <= 1.8) {
      const targetTopY = Math.min(
        WORLD_MAX_Y - 2.0,
        h.position.y + GEYSER_LAUNCH_HEIGHT,
      );
      let launchY = h.position.y + 0.5;
      for (let y = h.position.y + 1.0; y <= targetTopY; y += 0.5) {
        if (world.isSolid(critter.position.x, y + 0.6, critter.position.z)) {
          break;
        }
        launchY = y;
      }

      critter.position = {
        x: critter.position.x,
        y: Number(launchY.toFixed(4)),
        z: critter.position.z,
      };
      critter.velocity = {
        x: critter.velocity.x,
        y: 14.0,
        z: critter.velocity.z,
      };
      events.push({
        type: "HAZARD_TRIGGERED",
        hazardId: h.id,
        hazardType: "steam_geyser",
        position: { ...h.position },
        affectedCritterIds: [critter.id],
      });
      return events;
    }
  }

  // 2. Bramble Thorn Patch (12 chip damage + knockback nudge, max 1 trigger per turn per critter)
  if (!thornTriggeredThisTurn.has(critter.id)) {
    for (const h of hazards) {
      if (!h.active || h.type !== "thorn_patch") continue;
      const horizDist = Math.hypot(
        critter.position.x - h.position.x,
        critter.position.z - h.position.z,
      );
      const vertDist = Math.abs(critter.position.y - h.position.y);
      if (horizDist <= h.radius && vertDist <= 1.4) {
        thornTriggeredThisTurn.add(critter.id);

        if (critter.roundShieldRemaining > 0) {
          critter.roundShieldRemaining -= 1;
        } else {
          critter.hp = Math.max(0, critter.hp - THORN_DAMAGE);
        }

        const dx = critter.position.x - h.position.x;
        const dz = critter.position.z - h.position.z;
        const len = Math.hypot(dx, dz);
        const dirX = len > 1e-4 ? dx / len : 1.0;
        const dirZ = len > 1e-4 ? dz / len : 0.0;

        const nudgeX = Math.max(
          2.0,
          Math.min(WORLD_MAX_X - 2.0, critter.position.x + dirX * 1.35),
        );
        const nudgeZ = Math.max(
          2.0,
          Math.min(WORLD_MAX_Z - 2.0, critter.position.z + dirZ * 1.35),
        );
        const surfY = world.getSurfaceY(nudgeX, nudgeZ);
        const nudgeY =
          surfY !== null && Math.abs(surfY - critter.position.y) <= 2.4
            ? surfY
            : critter.position.y + 0.35;

        critter.position = { x: nudgeX, y: nudgeY, z: nudgeZ };
        critter.velocity = { x: dirX * 5.0, y: 4.5, z: dirZ * 5.0 };

        if (critter.hp <= 0 || critter.position.y <= waterLevel) {
          critter.alive = false;
          critter.hp = 0;
        }

        events.push({
          type: "HAZARD_TRIGGERED",
          hazardId: h.id,
          hazardType: "thorn_patch",
          position: { ...h.position },
          affectedCritterIds: [critter.id],
        });
        break;
      }
    }
  }

  return events;
}

/** Input parameters for Blast Barrel chain-detonation resolution. */
export interface BarrelChainParams {
  world: SdfWorld;
  hazards: HazardState[];
  critters: CritterState[];
  shooter: CritterState;
  initialImpacts: readonly ImpactEvent[];
  waterLevel: number;
  areTeammates: (a: CritterState, b: CritterState) => boolean;
  onEnemyKo: (shooter: CritterState) => void;
}

/**
 * Trigger BFS chain-detonations of Blast Barrels hit within `impactRadius + 1.8m`,
 * carving 2.8m sphere craters, dealing 28 damage + 14 knockback, and capping chain depth.
 */
export function resolveBarrelChainDetonations(
  params: BarrelChainParams,
): EngineEvent[] {
  const {
    world,
    hazards,
    critters,
    shooter,
    initialImpacts,
    waterLevel,
    areTeammates,
    onEnemyKo,
  } = params;

  const events: EngineEvent[] = [];
  const queue: Array<{ hazard: HazardState; depth: number }> = [];

  const enqueueNearbyBarrels = (
    origin: Vec3,
    blastRadius: number,
    depth: number,
  ): void => {
    if (depth > MAX_BARREL_CHAIN_DEPTH) {
      return;
    }
    const triggerDist = blastRadius + BARREL_CHAIN_MARGIN;
    for (const h of hazards) {
      if (!h.active || h.type !== "blast_barrel") continue;
      const dist = Math.hypot(
        h.position.x - origin.x,
        h.position.y - origin.y,
        h.position.z - origin.z,
      );
      if (dist <= triggerDist) {
        h.active = false;
        queue.push({ hazard: h, depth });
      }
    }
  };

  for (const imp of initialImpacts) {
    const impactRadius = Math.max(imp.damageRadius, imp.carveOp?.radius ?? 0);
    enqueueNearbyBarrels(imp.position, impactRadius, 1);
  }

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { hazard, depth } = next;

    const op: CarveOp = {
      shape: "sphere",
      center: { ...hazard.position },
      radius: BARREL_CARVE_RADIUS,
    };
    const dirtyChunks = world.applyCarve(op);
    events.push({ type: "TERRAIN_CARVED", op, dirtyChunks });

    const affectedCritterIds: string[] = [];

    for (const target of critters) {
      if (!target.alive) continue;
      const dx = target.position.x - hazard.position.x;
      const dy = target.position.y + CRITTER_HEIGHT_CENTER - hazard.position.y;
      const dz = target.position.z - hazard.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > BARREL_DAMAGE_RADIUS) continue;

      affectedCritterIds.push(target.id);
      const targetStats = computeCritterStats(target.species, target.equipped);

      let damage =
        dist <= 3.2
          ? BARREL_DAMAGE
          : Math.max(
              10,
              Math.round(
                BARREL_DAMAGE *
                  (1 - (dist - 3.2) / (BARREL_DAMAGE_RADIUS - 3.2 + 0.8)),
              ),
            );

      if (target.roundShieldRemaining > 0 && damage > 0) {
        target.roundShieldRemaining -= 1;
        damage = 0;
      }

      const kbDir = safeNormalizeVec3({
        x: Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4 ? 0.5 : dx,
        y: Math.max(0.55, dy + 0.9),
        z: dz,
      }) ?? { x: 0, y: 1, z: 0 };

      const falloff = Math.max(0.45, 1 - dist / (BARREL_DAMAGE_RADIUS + 1.0));
      const kbMag =
        BARREL_KNOCKBACK * falloff * (1 - targetStats.knockbackResist);
      const kbVel: Vec3 = {
        x: kbDir.x * kbMag,
        y: kbDir.y * kbMag,
        z: kbDir.z * kbMag,
      };

      const settled = settleKnockedCritter(
        world,
        target.position,
        kbVel,
        waterLevel,
      );
      target.position = settled.position;
      target.hp = settled.drowned ? 0 : Math.max(0, target.hp - damage);

      const isSelf = target.id === shooter.id;
      const isFriendly = !isSelf && areTeammates(shooter, target);
      if (!isSelf && !isFriendly) {
        shooter.damageDealt += damage;
      }

      if (target.hp <= 0 || settled.drowned) {
        target.alive = false;
        target.hp = 0;
        if (!isSelf && !isFriendly) {
          onEnemyKo(shooter);
        }
      }
    }

    events.push({
      type: "HAZARD_TRIGGERED",
      hazardId: hazard.id,
      hazardType: "blast_barrel",
      position: { ...hazard.position },
      affectedCritterIds,
    });

    enqueueNearbyBarrels(hazard.position, BARREL_CARVE_RADIUS, depth + 1);
  }

  return events;
}

/** Deactivate hazards submerged by rising tide or left floating after cliff crumble. */
export function pruneSubmergedHazards(
  world: SdfWorld,
  hazards: HazardState[],
  waterLevel: number,
): void {
  for (const h of hazards) {
    if (!h.active) continue;
    const surfY = world.getSurfaceY(h.position.x, h.position.z);
    if (
      h.position.y <= waterLevel ||
      surfY === null ||
      surfY < h.position.y - 1.5
    ) {
      h.active = false;
    }
  }
}
