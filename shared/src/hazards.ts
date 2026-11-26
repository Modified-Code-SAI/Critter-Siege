import { computeCritterStats } from "./catalog.js";
import { GRAVITY, computeFallDamage, safeNormalizeVec3 } from "./physics.js";
import type { SdfWorld } from "./sdf.js";
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
export const SPARK_MINE_TRIGGER_RADIUS = 2.4;
export const SPARK_MINE_CARVE_RADIUS = 2.2;
export const SPARK_MINE_DAMAGE = 24;
export const SPARK_MINE_KNOCKBACK = 13;
export const SPARK_MINE_DAMAGE_RADIUS = 4.2;
export const GEYSER_LAUNCH_HEIGHT = 9.0;
export const GRAND_GEYSER_LAUNCH_HEIGHT = 14.0;
export const THORN_DAMAGE = 12;

const GRAND_CARVE_MULTIPLIER = 1.35;
const CRITTER_HEIGHT_CENTER = 0.5;

/** Clone a HazardState cleanly for immutable match snapshots. */
export function cloneHazard(h: HazardState): HazardState {
  return {
    ...h,
    position: { ...h.position },
  };
}

/** Deterministically spawn interactive hazards for a match round across all 4 types. */
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
    ...(p.type === "spark_mine" ? { armed: false } : {}),
  }));
}

function settleKnockedCritter(
  world: SdfWorld,
  startPos: Vec3,
  initialVel: Vec3,
  waterLevel: number,
): { position: Vec3; drowned: boolean; fallDrop: number } {
  const pos: Vec3 = {
    x: startPos.x,
    y: startPos.y + 0.25,
    z: startPos.z,
  };
  let peakY = pos.y;
  const vel: Vec3 = { ...initialVel };
  const dt = 0.04;
  const maxSteps = world.mapScale === "grand" ? 120 : 80;
  const maxX = world.worldWidth;
  const maxZ = world.worldDepth;

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
      nextX < -4 ||
      nextX > maxX + 4 ||
      nextZ < -4 ||
      nextZ > maxZ + 4
    ) {
      return {
        position: { x: nextX, y: Math.min(nextY, waterLevel), z: nextZ },
        drowned: true,
        fallDrop: 0,
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
        const drowned = hi <= waterLevel;
        return {
          position: { x: nextX, y: hi, z: nextZ },
          drowned,
          fallDrop: drowned ? 0 : Math.max(0, peakY - hi),
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

  const drowned = pos.y <= waterLevel;
  return {
    position: pos,
    drowned,
    fallDrop: drowned ? 0 : Math.max(0, peakY - pos.y),
  };
}

/** Optional multi-critter & KO-attribution context for ground-contact hazard evaluation. */
export interface GroundHazardContext {
  critters?: CritterState[];
  shooter?: CritterState | null;
  areTeammates?: (a: CritterState, b: CritterState) => boolean;
  onEnemyKo?: (shooter: CritterState) => void;
  onWaterContact?: (
    critter: CritterState,
    attacker?: CritterState | null,
  ) => EngineEvent[];
}

/**
 * Evaluate ground-contact hazards (Spark Mines, Thermal Steam Geysers & Bramble Thorn Patches)
 * for a moving or landing critter, mutating state and returning emitted events.
 */
export function applyGroundHazardsForCritter(
  world: SdfWorld,
  hazards: HazardState[],
  critter: CritterState,
  thornTriggeredThisTurn: Set<string>,
  waterLevel: number,
  context?: GroundHazardContext,
): EngineEvent[] {
  if (!critter.alive) {
    return [];
  }

  const events: EngineEvent[] = [];
  const maxX = world.worldWidth;
  const maxY = world.worldHeight;
  const maxZ = world.worldDepth;
  const carveScale = world.mapScale === "grand" ? GRAND_CARVE_MULTIPLIER : 1.0;

  // 1. Spark Mine proximity blast (within 2.4m arms & detonates 2.2m crater, 24 dmg, 13 knockback + chains barrels)
  for (const h of hazards) {
    if (!h.active || h.type !== "spark_mine") continue;
    const dist = Math.hypot(
      critter.position.x - h.position.x,
      critter.position.y - h.position.y,
      critter.position.z - h.position.z,
    );
    const triggerRadius = Math.max(h.radius, SPARK_MINE_TRIGGER_RADIUS);
    if (dist <= triggerRadius) {
      h.armed = true;
      h.active = false;

      const mineCarveRadius = Number(
        (SPARK_MINE_CARVE_RADIUS * carveScale).toFixed(4),
      );
      const op: CarveOp = {
        shape: "sphere",
        center: { ...h.position },
        radius: mineCarveRadius,
      };
      const dirtyChunks = world.applyCarve(op);
      events.push({ type: "TERRAIN_CARVED", op, dirtyChunks });

      const allCritters = context?.critters ?? [critter];
      const shooter = context?.shooter ?? null;
      const areTeammates = context?.areTeammates ?? (() => false);
      const onEnemyKo = context?.onEnemyKo ?? (() => {});
      const onWaterContact = context?.onWaterContact;
      const affectedCritterIds: string[] = [];
      const waterEvents: EngineEvent[] = [];

      for (const target of allCritters) {
        if (!target.alive) continue;
        const dx = target.position.x - h.position.x;
        const dy = target.position.y + CRITTER_HEIGHT_CENTER - h.position.y;
        const dz = target.position.z - h.position.z;
        const blastDist = Math.hypot(dx, dy, dz);
        if (blastDist > SPARK_MINE_DAMAGE_RADIUS) continue;

        affectedCritterIds.push(target.id);
        const targetStats = computeCritterStats(target.species, target.equipped);

        let damage =
          blastDist <= 2.6
            ? SPARK_MINE_DAMAGE
            : Math.max(
                10,
                Math.round(
                  SPARK_MINE_DAMAGE *
                    (1 -
                      (blastDist - 2.6) /
                        (SPARK_MINE_DAMAGE_RADIUS - 2.6 + 0.8)),
                ),
              );

        if (target.roundShieldRemaining > 0 && damage > 0) {
          target.roundShieldRemaining -= 1;
          damage = 0;
        }

        const kbDir = safeNormalizeVec3({
          x: Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4 ? 0.35 : dx,
          y: Math.max(0.75, dy + 1.15),
          z: dz,
        }) ?? { x: 0, y: 1, z: 0 };

        const falloff = Math.max(
          0.5,
          1 - blastDist / (SPARK_MINE_DAMAGE_RADIUS + 1.0),
        );
        const kbMag =
          SPARK_MINE_KNOCKBACK * falloff * (1 - targetStats.knockbackResist);
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
        const fallDmg = computeFallDamage(
          settled.fallDrop,
          targetStats.fallDamageResist,
        );
        const totalDamage = damage + fallDmg;
        target.position = settled.position;
        target.velocity = kbVel;
        target.hp = Math.max(0, target.hp - totalDamage);

        const isSelf = shooter !== null && target.id === shooter.id;
        const isFriendly =
          shooter !== null && !isSelf && areTeammates(shooter, target);
        if (shooter && !isSelf && !isFriendly) {
          shooter.damageDealt += totalDamage;
        }

        if (target.hp <= 0) {
          target.alive = false;
          target.hp = 0;
          if (shooter && !isSelf && !isFriendly) {
            onEnemyKo(shooter);
          }
        } else if (settled.drowned) {
          if (onWaterContact) {
            waterEvents.push(...onWaterContact(target, shooter));
          } else {
            target.alive = false;
            target.hp = 0;
            if (shooter && !isSelf && !isFriendly) {
              onEnemyKo(shooter);
            }
          }
        }
      }

      events.push({
        type: "HAZARD_TRIGGERED",
        hazardId: h.id,
        hazardType: "spark_mine",
        position: { ...h.position },
        affectedCritterIds,
      });
      events.push(...waterEvents);

      // Chain-trigger any nearby Blast Barrels caught in the Spark Mine blast!
      const chainShooter = context?.shooter ?? critter;
      const syntheticImpact: ImpactEvent = {
        time: 0,
        position: { ...h.position },
        carveOp: op,
        damageRadius: SPARK_MINE_DAMAGE_RADIUS,
        baseDamage: SPARK_MINE_DAMAGE,
        knockback: SPARK_MINE_KNOCKBACK,
      };
      events.push(
        ...resolveBarrelChainDetonations({
          world,
          hazards,
          critters: allCritters,
          shooter: chainShooter,
          initialImpacts: [syntheticImpact],
          waterLevel,
          areTeammates: context?.areTeammates ?? (() => false),
          onEnemyKo: context?.onEnemyKo ?? (() => {}),
          ...(onWaterContact ? { onWaterContact } : {}),
        }),
      );

      return events;
    }
  }

  // 2. Thermal Steam Geyser launchpad (+9m duel / +14m grand vertical catapult)
  const launchHeight =
    world.mapScale === "grand"
      ? GRAND_GEYSER_LAUNCH_HEIGHT
      : GEYSER_LAUNCH_HEIGHT;
  for (const h of hazards) {
    if (!h.active || h.type !== "steam_geyser") continue;
    const horizDist = Math.hypot(
      critter.position.x - h.position.x,
      critter.position.z - h.position.z,
    );
    const vertDist = Math.abs(critter.position.y - h.position.y);
    if (horizDist <= h.radius && vertDist <= 1.8) {
      const targetTopY = Math.min(maxY - 2.0, h.position.y + launchHeight);
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
        y: world.mapScale === "grand" ? 18.0 : 14.0,
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

  // 3. Bramble Thorn Patch (12 chip damage + knockback nudge, max 1 trigger per turn per critter)
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
          Math.min(maxX - 2.0, critter.position.x + dirX * 1.35),
        );
        const nudgeZ = Math.max(
          2.0,
          Math.min(maxZ - 2.0, critter.position.z + dirZ * 1.35),
        );
        const surfY = world.getSurfaceY(nudgeX, nudgeZ);
        const nudgeY =
          surfY !== null && Math.abs(surfY - critter.position.y) <= 2.4
            ? surfY
            : critter.position.y + 0.35;

        critter.position = { x: nudgeX, y: nudgeY, z: nudgeZ };
        critter.velocity = { x: dirX * 5.0, y: 4.5, z: dirZ * 5.0 };

        const thornWaterEvents: EngineEvent[] = [];
        if (critter.hp <= 0) {
          critter.alive = false;
          critter.hp = 0;
        } else if (critter.position.y <= waterLevel) {
          if (context?.onWaterContact) {
            thornWaterEvents.push(
              ...context.onWaterContact(critter, context.shooter ?? null),
            );
          } else {
            critter.alive = false;
            critter.hp = 0;
          }
        }

        events.push({
          type: "HAZARD_TRIGGERED",
          hazardId: h.id,
          hazardType: "thorn_patch",
          position: { ...h.position },
          affectedCritterIds: [critter.id],
        });
        events.push(...thornWaterEvents);
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
  preImpactPositions?: ReadonlyMap<string, Vec3>;
  areTeammates: (a: CritterState, b: CritterState) => boolean;
  onEnemyKo: (shooter: CritterState) => void;
  onWaterContact?: (
    critter: CritterState,
    attacker?: CritterState | null,
  ) => EngineEvent[];
}

/**
 * Trigger BFS chain-detonations of Blast Barrels hit within `impactRadius + 1.8m`,
 * carving sphere craters (2.8m duel / 3.78m grand), dealing 28 damage + 14 knockback,
 * and capping chain depth.
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
    preImpactPositions,
    areTeammates,
    onEnemyKo,
    onWaterContact,
  } = params;

  const events: EngineEvent[] = [];
  const queue: Array<{ hazard: HazardState; depth: number }> = [];
  const carveScale = world.mapScale === "grand" ? GRAND_CARVE_MULTIPLIER : 1.0;
  const barrelCarveRadius = Number(
    (BARREL_CARVE_RADIUS * carveScale).toFixed(4),
  );

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
      radius: barrelCarveRadius,
    };
    const dirtyChunks = world.applyCarve(op);
    events.push({ type: "TERRAIN_CARVED", op, dirtyChunks });

    const affectedCritterIds: string[] = [];
    const waterEvents: EngineEvent[] = [];

    for (const target of critters) {
      if (!target.alive) continue;
      const curDx = target.position.x - hazard.position.x;
      const curDy = target.position.y + CRITTER_HEIGHT_CENTER - hazard.position.y;
      const curDz = target.position.z - hazard.position.z;
      let dist = Math.hypot(curDx, curDy, curDz);
      let dx = curDx;
      let dy = curDy;
      let dz = curDz;

      // Primary barrel blasts occur simultaneously with projectile impact
      if (depth === 1 && preImpactPositions) {
        const pre = preImpactPositions.get(target.id);
        if (pre) {
          const preDx = pre.x - hazard.position.x;
          const preDy = pre.y + CRITTER_HEIGHT_CENTER - hazard.position.y;
          const preDz = pre.z - hazard.position.z;
          const preDist = Math.hypot(preDx, preDy, preDz);
          if (preDist < dist) {
            dist = preDist;
            dx = preDx;
            dy = preDy;
            dz = preDz;
          }
        }
      }

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
      const fallDmg = computeFallDamage(
        settled.fallDrop,
        targetStats.fallDamageResist,
      );
      const totalDamage = damage + fallDmg;
      target.position = settled.position;
      target.hp = Math.max(0, target.hp - totalDamage);

      const isSelf = target.id === shooter.id;
      const isFriendly = !isSelf && areTeammates(shooter, target);
      if (!isSelf && !isFriendly) {
        shooter.damageDealt += totalDamage;
      }

      if (target.hp <= 0) {
        target.alive = false;
        target.hp = 0;
        if (!isSelf && !isFriendly) {
          onEnemyKo(shooter);
        }
      } else if (settled.drowned) {
        if (onWaterContact) {
          waterEvents.push(...onWaterContact(target, shooter));
        } else {
          target.alive = false;
          target.hp = 0;
          if (!isSelf && !isFriendly) {
            onEnemyKo(shooter);
          }
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
    events.push(...waterEvents);

    enqueueNearbyBarrels(hazard.position, barrelCarveRadius, depth + 1);
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
