import {
  DEFAULT_FLOOD_DURATION_SEC,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_ROUND_DURATION_SEC,
  DEFAULT_STARTING_COINS,
  GADGET_CATALOG,
  HARDPOINT_SLOTS,
  MAX_LOADOUT_SLOTS,
  MUTATION_CATALOG,
  MUTATION_IDS,
  PLAYER_COLOR_PALETTE,
  ROUND5_WARNING_TIDE_RISE,
  ROUND5_WARNING_WINDOW_SEC,
  SPECIES_CATALOG,
  computeApexSynergy,
  computeCritterStats,
  computeMaxMoveDistance as computeSharedMaxMoveDistance,
  computeRetreatMoveDistance as computeSharedRetreatMoveDistance,
  createRoundLoadoutCharges,
  validateAndBuildStartingLoadout,
} from "./catalog.js";
import * as Hazards from "./hazards.js";
import {
  FALL_DAMAGE_THRESHOLD_M,
  computeFallDamage,
  safeNormalizeVec3,
  simulateShot,
  type ShotParams,
} from "./physics.js";
import { createSeededRng } from "./rng.js";
import { SdfWorld } from "./sdf.js";
import type {
  CarveOp,
  CritterState,
  DraftCardOption,
  EngineEvent,
  EvoPodState,
  GadgetId,
  GameMode,
  HardpointSlot,
  HazardState,
  MapScale,
  MapScaleChoice,
  MatchConfig,
  MatchEndReason,
  MatchPlayerSeed,
  MatchState,
  MutationId,
  PendingDraftState,
  PrismWallState,
  TeamId,
  TurnPhase,
  Vec3,
} from "./types.js";

export type { EngineEvent, MatchConfig, MatchPlayerSeed, PrismWallState };

const DUEL_TURN_DURATION_SEC = 28.0;
const GRAND_TURN_DURATION_SEC = 35.0;
const DEFAULT_RETREAT_DURATION_SEC = 6.0;
const DEFAULT_DRAFT_DURATION_SEC = 18.0;
const INITIAL_WATER_LEVEL = 1.5;
const MAX_WIND_SPEED = 6.0;
const MAX_ACTIVE_PODS = 4;

const COINS_ENEMY_KO = 40;
const COINS_POD_COLLECTED = 25;
const COINS_BARREL_CHAIN_HIT = 15;
const COINS_ROUND_STIPEND = 35;
const COINS_TRAILING_BONUS = 15;
const COINS_UNLIMITED_POD_FALLBACK = 15;

const STANDARD_LIMITED_GADGETS: readonly GadgetId[] = [
  "vine_grapple",
  "spore_burst",
  "burrow_bore",
  "seeker_firefly",
  "mend_brew",
];

const DEFAULT_COLORS = PLAYER_COLOR_PALETTE;

/** Resolve a lobby map-scale selection (`'auto' | 'duel' | 'grand'`) using total critter count. */
export function resolveMapScale(
  choice: MapScaleChoice | undefined,
  playerCount: number,
): MapScale {
  if (choice === "duel" || choice === "grand") {
    return choice;
  }
  return playerCount >= 3 ? "grand" : "duel";
}

function normalizeTeam(
  mode: GameMode,
  rawTeam: TeamId | 0 | 1 | null | undefined,
  index: number,
): TeamId | null {
  if (mode !== "2v2") {
    return null;
  }
  if (rawTeam === 0 || rawTeam === "A") {
    return "A";
  }
  if (rawTeam === 1 || rawTeam === "B") {
    return "B";
  }
  return index % 2 === 0 ? "A" : "B";
}

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function clampWind(wind: Vec3): Vec3 {
  const horizLen = Math.hypot(wind.x, wind.z);
  if (horizLen <= MAX_WIND_SPEED) {
    return {
      x: Number(wind.x.toFixed(4)),
      y: 0,
      z: Number(wind.z.toFixed(4)),
    };
  }
  const scale = MAX_WIND_SPEED / horizLen;
  return {
    x: Number((wind.x * scale).toFixed(4)),
    y: 0,
    z: Number((wind.z * scale).toFixed(4)),
  };
}

function cloneCritter(c: CritterState): CritterState {
  return {
    ...c,
    position: { ...c.position },
    velocity: { ...c.velocity },
    equipped: { ...c.equipped },
    loadout: [...c.loadout],
    gadgetCharges: { ...c.gadgetCharges },
  };
}

function clonePod(p: EvoPodState): EvoPodState {
  return {
    ...p,
    position: { ...p.position },
  };
}

function cloneDraft(d: PendingDraftState): PendingDraftState {
  return {
    ...d,
    options: [...d.options],
    cards: d.cards.map((card) => ({ ...card })),
  };
}

function clonePrismWall(w: PrismWallState): PrismWallState {
  return {
    ...w,
    position: { ...w.position },
    normal: { ...w.normal },
  };
}

/**
 * Authoritative deterministic PvP match state machine for Critter Siege.
 * Drives 5-round persistent-island FFA and 2v2 matches, Siege Coins & Anytime Armory,
 * dynamic 60m Duel vs 144m Grand SDF maps, terrain carving, Spark Mines & interactive hazards,
 * fall damage, Evo Pod deferred drafting, Round 5 Two-Stage Ocean Deluge, and Apex evolution.
 */
export class MatchEngine {
  private readonly config: MatchConfig;
  private readonly roomCode: string;
  private readonly matchId: string;
  private readonly mapScale: MapScale;
  private readonly maxRounds: number;
  private readonly roundDurationSec: number;
  private readonly startingCoins: number;
  private readonly floodDurationSec: number;
  private readonly turnDurationSec: number;
  private readonly retreatDurationSec: number;
  private readonly unlockedBonusGadgets: GadgetId[];
  private readonly rng: () => number;

  private readonly _world: SdfWorld;
  private round = 1;
  private turnNumber = 1;
  private phase: TurnPhase = "ACTIVE";
  private activePlayerId: string | null = null;
  private phaseTimeRemainingSec: number;
  private roundTimeRemainingSec: number;
  private waterLevel = INITIAL_WATER_LEVEL;
  private floodStartWaterLevel = INITIAL_WATER_LEVEL;
  private floodTargetWaterLevel: number | null = null;
  private matchEndReason: MatchEndReason | null = null;
  private wind: Vec3 = { x: 0, y: 0, z: 0 };
  private critters: CritterState[] = [];
  private evoPods: EvoPodState[] = [];
  private hazards: HazardState[] = [];
  private readonly thornTriggeredThisTurn = new Set<string>();
  private readonly fallPeakY = new Map<string, number>();
  private pendingDrafts: PendingDraftState[] = [];
  private teamScores: Record<TeamId, number> = { A: 0, B: 0 };
  private winnerId: string | null = null;
  private winnerTeam: TeamId | null = null;
  private roundWinners: Array<string | TeamId | null> = [];
  private podCounter = 0;
  private prismWallCounter = 0;
  private ffaCursor = 0;
  private lastTeamTurn: TeamId | null = null;
  private teamCursor: Record<TeamId, number> = { A: 0, B: 0 };
  private prismWalls: PrismWallState[] = [];

  public constructor(config: MatchConfig) {
    this.config = config;
    this.roomCode = config.roomCode ?? config.matchId ?? "LOCAL";
    this.matchId = config.matchId ?? `match-${this.roomCode}-${config.seed}`;
    this.mapScale = resolveMapScale(config.mapScale, config.players.length);
    this.maxRounds = Math.max(
      1,
      config.maxRounds ?? config.roundCount ?? DEFAULT_MAX_ROUNDS,
    );
    this.roundDurationSec = Math.max(
      5,
      config.roundDurationSec ?? DEFAULT_ROUND_DURATION_SEC,
    );
    this.startingCoins = Math.max(
      0,
      Math.floor(config.startingCoins ?? DEFAULT_STARTING_COINS),
    );
    this.floodDurationSec = Math.max(
      0.5,
      config.floodDurationSec ?? DEFAULT_FLOOD_DURATION_SEC,
    );
    const defaultTurnSec =
      this.mapScale === "grand"
        ? GRAND_TURN_DURATION_SEC
        : DUEL_TURN_DURATION_SEC;
    this.turnDurationSec =
      (config.turnDurationMs ?? defaultTurnSec * 1000) / 1000;
    this.retreatDurationSec =
      (config.retreatDurationMs ?? DEFAULT_RETREAT_DURATION_SEC * 1000) / 1000;
    this.phaseTimeRemainingSec = this.turnDurationSec;
    this.roundTimeRemainingSec = this.roundDurationSec;
    this.rng = createSeededRng(config.seed ^ 0x2f6e2b1);

    const bonusSet = new Set<GadgetId>();
    for (const p of config.players) {
      if (p.bonusGadget && GADGET_CATALOG[p.bonusGadget]?.bonusLobbyOnly) {
        bonusSet.add(p.bonusGadget);
      }
      if (p.unlockedBonusGadgets) {
        for (const g of p.unlockedBonusGadgets) {
          if (GADGET_CATALOG[g]?.bonusLobbyOnly) {
            bonusSet.add(g);
          }
        }
      }
    }
    this.unlockedBonusGadgets = Array.from(bonusSet);

    // Construct persistent SDF island ONCE for the entire multi-round match!
    this._world = new SdfWorld(
      this.config.seed,
      this.config.theme,
      this.mapScale,
    );
    this.initializeCritters();
    this.rollWind();
    this.activePlayerId = this.selectInitialActiveCritter();
    this.phase = "ACTIVE";
    this.phaseTimeRemainingSec = this.turnDurationSec;
  }

  /** Persistent match SDF world (carved craters and tunnels remain across all rounds). */
  public get world(): SdfWorld {
    return this._world;
  }

  /** Update active critter movement during ACTIVE or RETREAT, handling pods, hazards, fall damage & drowning. */
  public applyMove(
    playerId: string,
    position: Vec3,
    yaw: number,
    pitch: number,
  ): EngineEvent[] {
    if (
      (this.phase !== "ACTIVE" && this.phase !== "RETREAT") ||
      playerId !== this.activePlayerId
    ) {
      return [];
    }
    if (!isFiniteVec3(position) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return [];
    }
    const critter = this.findCritter(playerId);
    if (!critter || !critter.alive) {
      return [];
    }

    const prevPos: Vec3 = { ...critter.position };
    const dxz = Math.hypot(position.x - prevPos.x, position.z - prevPos.z);
    const isRetreat = this.phase === "RETREAT";
    const budgetDist = isRetreat
      ? this.computeRetreatMoveDistance(critter.species, critter.equipped)
      : critter.maxMoveDistance;
    const staminaScale = isRetreat ? 40 : 100;
    const remainingDist = (critter.moveStamina / staminaScale) * budgetDist;

    let nextPos: Vec3 = { ...position };
    if (critter.moveStamina <= 0) {
      if (dxz > 0.05) {
        nextPos = { x: prevPos.x, y: position.y, z: prevPos.z };
      }
    } else if (dxz > remainingDist && dxz > 1e-6) {
      const scale = remainingDist / dxz;
      nextPos = {
        x: prevPos.x + (position.x - prevPos.x) * scale,
        y: position.y,
        z: prevPos.z + (position.z - prevPos.z) * scale,
      };
      critter.moveStamina = 0;
    } else if (dxz > 0) {
      const cost = (dxz / Math.max(0.01, budgetDist)) * staminaScale;
      const nextStamina = Math.max(
        0,
        Math.min(100, Number((critter.moveStamina - cost).toFixed(4))),
      );
      critter.moveStamina = nextStamina < 0.001 ? 0 : nextStamina;
    }

    critter.position = { ...nextPos };
    critter.yaw = yaw;
    critter.pitch = pitch;

    const events: EngineEvent[] = [];
    events.push(...this.collectPodsInRange(critter));

    const hazardEvents = Hazards.applyGroundHazardsForCritter(
      this._world,
      this.hazards,
      critter,
      this.thornTriggeredThisTurn,
      this.waterLevel,
      {
        critters: this.critters,
        shooter: critter,
        areTeammates: (a, b) => this.areTeammates(a, b),
        onEnemyDamage: (attacker, damage, source) =>
          this.awardHazardEnemyDamageCoins(attacker, damage, source),
        onEnemyKo: (attacker) => this.awardEnemyKo(attacker),
        onWaterContact: (target, attacker) =>
          this.resolveWaterContact(target, attacker),
      },
    );
    events.push(...hazardEvents);

    const hitGeyser = hazardEvents.some(
      (e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "steam_geyser",
    );
    const hitSparkMine = hazardEvents.some(
      (e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "spark_mine",
    );

    if (hitGeyser) {
      // Thermal geyser cushions landing & catapults upward; do not count upward launch as fall damage
      this.fallPeakY.set(playerId, prevPos.y);
    } else if (hitSparkMine) {
      this.fallPeakY.set(playerId, critter.position.y);
    } else if (critter.alive && critter.position.y > this.waterLevel) {
      const stepHoriz = Math.hypot(
        nextPos.x - prevPos.x,
        nextPos.z - prevPos.z,
      );
      const grounded = this._world.isSolid(
        nextPos.x,
        nextPos.y - 0.55,
        nextPos.z,
      );
      if (stepHoriz > 3.5) {
        // Large horizontal jump/teleport resets fall tracking cleanly
        this.fallPeakY.set(playerId, nextPos.y);
      } else if (!grounded) {
        const prevPeak = this.fallPeakY.get(playerId) ?? prevPos.y;
        this.fallPeakY.set(
          playerId,
          Math.max(prevPeak, prevPos.y, nextPos.y),
        );
      } else {
        const peakY = Math.max(
          this.fallPeakY.get(playerId) ?? prevPos.y,
          prevPos.y,
        );
        const drop = peakY - nextPos.y;
        if (drop > FALL_DAMAGE_THRESHOLD_M) {
          const stats = computeCritterStats(critter.species, critter.equipped);
          const fallDmg = computeFallDamage(drop, stats.fallDamageResist);
          if (fallDmg > 0) {
            critter.hp = Math.max(0, critter.hp - fallDmg);
            if (critter.hp <= 0) {
              critter.alive = false;
            }
          }
        }
        this.fallPeakY.set(playerId, nextPos.y);
      }
    }

    // Check water contact (Cycle 1-8 Rescue Parachute -35 HP vs Sudden Death Lethal)
    if (critter.alive && critter.position.y <= this.waterLevel) {
      events.push(...this.resolveWaterContact(critter));
    }

    // Check KO from drowning, spark mine, thorn, or fall
    if (!critter.alive) {
      critter.hp = 0;
      if (this.checkRoundEnded()) {
        events.push(...this.finishRound());
      } else {
        events.push(...this.enterDraftOrNextTurn());
      }
    } else if (this.checkRoundEnded()) {
      events.push(...this.finishRound());
    }

    return events;
  }

  /** Execute non-turn-ending utility actions (Vine Grapple, Prism Wall, Mend Brew, or Sky Bomber drop). */
  public applyUtility(
    playerId: string,
    action: {
      gadgetId: "vine_grapple" | "prism_wall" | "mend_brew" | "sky_bomber_drop";
      direction: Vec3;
      target?: Vec3;
    },
  ): EngineEvent[] {
    if (playerId !== this.activePlayerId) {
      return [];
    }
    const critter = this.findCritter(playerId);
    if (!critter || !critter.alive) {
      return [];
    }

    const events: EngineEvent[] = [];

    if (action.gadgetId === "mend_brew") {
      if (this.phase !== "ACTIVE") {
        return [];
      }
      if (!critter.loadout.includes("mend_brew")) {
        return [];
      }
      const charges = critter.gadgetCharges.mend_brew;
      if (charges === null || charges <= 0) {
        return [];
      }
      if (critter.hp >= critter.maxHp) {
        return [];
      }
      const healCap = GADGET_CATALOG.mend_brew.healAmount ?? 45;
      const amount = Math.min(critter.maxHp - critter.hp, healCap);
      critter.gadgetCharges.mend_brew = charges - 1;
      critter.hp += amount;
      events.push({
        type: "ABILITY_HEALED",
        playerId,
        amount,
        newHp: critter.hp,
      });
      return events;
    }

    const normDir = safeNormalizeVec3(action.direction);
    if (!normDir) {
      return [];
    }

    if (action.gadgetId === "vine_grapple") {
      if (this.phase !== "ACTIVE" || critter.grappleUsedThisTurn) {
        return [];
      }
      if (!critter.loadout.includes("vine_grapple")) {
        return [];
      }
      const charges = critter.gadgetCharges.vine_grapple;
      if (charges !== null && charges <= 0) {
        return [];
      }

      const prevPos: Vec3 = { ...critter.position };
      const baseReach = this.mapScale === "grand" ? 26.0 : 18.0;
      const reach = baseReach * SPECIES_CATALOG[critter.species].grappleReachBonus;

      // Check if an uncollected Evo Pod is near the grapple target -> yank it!
      let pulledPod: EvoPodState | null = null;
      for (const pod of this.evoPods) {
        if (pod.collected) continue;
        const distFromCritter = Math.hypot(
          pod.position.x - critter.position.x,
          pod.position.y - critter.position.y,
          pod.position.z - critter.position.z,
        );
        if (distFromCritter > reach) continue;

        if (action.target && isFiniteVec3(action.target)) {
          const distToTarget = Math.hypot(
            pod.position.x - action.target.x,
            pod.position.y - action.target.y,
            pod.position.z - action.target.z,
          );
          if (distToTarget <= 2.2) {
            pulledPod = pod;
            break;
          }
        }
      }

      if (pulledPod) {
        const podOrigin: Vec3 = { ...pulledPod.position };
        if (charges !== null) {
          critter.gadgetCharges.vine_grapple = charges - 1;
        }
        critter.grappleUsedThisTurn = true;
        pulledPod.position = { ...critter.position };
        events.push({
          type: "VINE_GRAPPLED",
          playerId,
          from: prevPos,
          to: podOrigin,
        });
        events.push(...this.collectPodsInRange(critter));
        return events;
      }

      // Otherwise grapple-tether upward onto cliffs OR rappel safely down steep cliff faces (0 moveStamina cost!)
      let destination: Vec3 | null = null;
      if (action.target && isFiniteVec3(action.target)) {
        const dx = action.target.x - critter.position.x;
        const dy = action.target.y - critter.position.y;
        const dz = action.target.z - critter.position.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 0.05) {
          const clampedDist = Math.min(dist, reach);
          const scale = clampedDist / dist;
          const destX = critter.position.x + dx * scale;
          let destY = critter.position.y + dy * scale;
          const destZ = critter.position.z + dz * scale;
          if (destY > this.waterLevel && this._world.isSolid(destX, destY, destZ)) {
            const surfY = this._world.getSurfaceY(destX, destZ);
            if (surfY !== null && (dy >= 0 || surfY <= destY + 1.8)) {
              destY = surfY + 0.1;
            }
          }
          destination = { x: destX, y: destY, z: destZ };
        }
      } else {
        let lastAirX = critter.position.x;
        let lastAirY = critter.position.y + 0.6;
        let lastAirZ = critter.position.z;
        for (let d = 1.0; d <= reach; d += 0.5) {
          const px = critter.position.x + normDir.x * d;
          const py = critter.position.y + 0.6 + normDir.y * d;
          const pz = critter.position.z + normDir.z * d;
          if (this._world.isSolid(px, py, pz)) {
            const surfY = this._world.getSurfaceY(px, pz);
            if (normDir.y < -0.15) {
              let rappelY: number | null = null;
              const startScan = lastAirY + 0.35;
              const minScan = Math.max(this.waterLevel + 0.2, lastAirY - 6.5);
              for (let sy = startScan; sy >= minScan; sy -= 0.25) {
                if (
                  !this._world.isSolid(lastAirX, sy + 0.25, lastAirZ) &&
                  this._world.isSolid(lastAirX, sy - 0.1, lastAirZ)
                ) {
                  rappelY = sy + 0.1;
                  break;
                }
              }
              if (rappelY !== null) {
                destination = { x: lastAirX, y: rappelY, z: lastAirZ };
              } else if (surfY !== null && surfY <= py + 1.5) {
                destination = { x: px, y: surfY + 0.1, z: pz };
              } else {
                destination = { x: lastAirX, y: Math.max(this.waterLevel + 0.3, lastAirY), z: lastAirZ };
              }
            } else if (surfY !== null && surfY <= py + 3.4) {
              destination = { x: px, y: surfY + 0.1, z: pz };
            } else {
              destination = { x: lastAirX, y: lastAirY + 0.15, z: lastAirZ };
            }
            break;
          }
          lastAirX = px;
          lastAirY = py;
          lastAirZ = pz;
        }
      }

      if (destination) {
        if (charges !== null) {
          critter.gadgetCharges.vine_grapple = charges - 1;
        }
        critter.grappleUsedThisTurn = true;
        critter.position = { ...destination };
        critter.velocity = { x: 0, y: 0, z: 0 };
        this.fallPeakY.set(playerId, destination.y);
        events.push({
          type: "VINE_GRAPPLED",
          playerId,
          from: prevPos,
          to: { ...destination },
        });
        events.push(...this.collectPodsInRange(critter));
        events.push(
          ...Hazards.applyGroundHazardsForCritter(
            this._world,
            this.hazards,
            critter,
            this.thornTriggeredThisTurn,
            this.waterLevel,
            {
              critters: this.critters,
              shooter: critter,
              areTeammates: (a, b) => this.areTeammates(a, b),
              onEnemyDamage: (attacker, damage, source) =>
                this.awardHazardEnemyDamageCoins(attacker, damage, source),
              onEnemyKo: (attacker) => this.awardEnemyKo(attacker),
              onWaterContact: (target, attacker) =>
                this.resolveWaterContact(target, attacker),
            },
          ),
        );
        if (critter.alive && critter.position.y <= this.waterLevel) {
          events.push(...this.resolveWaterContact(critter));
        }
        if (!critter.alive) {
          critter.hp = 0;
          if (this.checkRoundEnded()) {
            events.push(...this.finishRound());
          } else {
            events.push(...this.enterDraftOrNextTurn());
          }
        } else if (this.checkRoundEnded()) {
          events.push(...this.finishRound());
        }
      }
      return events;
    }

    if (action.gadgetId === "prism_wall") {
      if (this.phase !== "ACTIVE") {
        return [];
      }
      if (!critter.loadout.includes("prism_wall")) {
        return [];
      }
      const charges = critter.gadgetCharges.prism_wall;
      if (charges !== null && charges <= 0) {
        return [];
      }
      if (charges !== null) {
        critter.gadgetCharges.prism_wall = charges - 1;
      }
      const horizLen = Math.hypot(normDir.x, normDir.z);
      const normal: Vec3 =
        horizLen > 1e-6
          ? { x: normDir.x / horizLen, y: 0, z: normDir.z / horizLen }
          : { x: 0, y: 0, z: 1 };
      const wx = critter.position.x + normal.x * 2.4;
      const wz = critter.position.z + normal.z * 2.4;
      const surfY = this._world.getSurfaceY(wx, wz);
      const wy =
        surfY !== null && Math.abs(surfY - critter.position.y) <= 2.0
          ? surfY
          : critter.position.y;
      const wallPos: Vec3 = { x: wx, y: wy, z: wz };
      const wall: PrismWallState = {
        id: `wall-r${this.round}-${++this.prismWallCounter}`,
        ownerId: playerId,
        position: wallPos,
        normal,
        width: 3.6,
        height: 2.8,
        turnsLeft: Math.max(2, this.critters.length * 2),
        active: true,
      };
      this.prismWalls.push(wall);
      events.push({
        type: "PRISM_WALL_DEPLOYED",
        wall: clonePrismWall(wall),
      });
      return events;
    }

    if (action.gadgetId === "sky_bomber_drop") {
      if (
        (this.phase !== "ACTIVE" && this.phase !== "RETREAT") ||
        critter.apex !== "sky_bomber" ||
        critter.skyBomberDropUsedThisTurn
      ) {
        return [];
      }
      critter.skyBomberDropUsedThisTurn = true;
      const dropParams: ShotParams = {
        shooterId: playerId,
        gadgetId: "gale_mortar",
        origin: {
          x: critter.position.x,
          y: critter.position.y + 0.4,
          z: critter.position.z,
        },
        direction: { x: 0, y: -1, z: 0 },
        power: 0.25,
        species: critter.species,
        equipped: { ...critter.equipped },
        apex: critter.apex,
      };
      const sim = simulateShot(
        this._world,
        this.critters,
        dropParams,
        this.wind,
        this.waterLevel,
        this.prismWalls,
      );
      events.push(...this.applySimulationOutcome(critter, "gale_mortar", sim));
      if (this.checkRoundEnded()) {
        events.push(...this.finishRound());
      } else if (!critter.alive) {
        events.push(...this.enterDraftOrNextTurn());
      }
      return events;
    }

    return events;
  }

  /**
   * Anytime Armory purchase, refill, or 50% trade-in swap.
   * Allowed during ACTIVE, RESOLVING, RETREAT, DRAFT_IF_READY, and ROUND_DRAFT for any critter
   * in the match (even while waiting for rivals' turns). Disallowed in LOBBY, FINAL_FLOOD, MATCH_OVER.
   */
  public applyBuyAbility(
    playerId: string,
    gadgetId: GadgetId,
    replaceGadgetId?: GadgetId,
  ): EngineEvent[] {
    if (
      this.phase === "LOBBY" ||
      this.phase === "FINAL_FLOOD" ||
      this.phase === "MATCH_OVER"
    ) {
      return [];
    }
    const critter = this.findCritter(playerId);
    if (!critter) {
      return [];
    }
    if (!Object.prototype.hasOwnProperty.call(GADGET_CATALOG, gadgetId)) {
      return [];
    }
    const def = GADGET_CATALOG[gadgetId];

    // Case A — Refill Owned Limited Ability
    if (critter.loadout.includes(gadgetId)) {
      if (def.startingCharges === null || def.refillCost <= 0) {
        return [];
      }
      if (critter.coins < def.refillCost) {
        return [];
      }
      critter.coins -= def.refillCost;
      const current = critter.gadgetCharges[gadgetId] ?? 0;
      critter.gadgetCharges[gadgetId] = current + def.startingCharges;
      return [
        {
          type: "ABILITY_PURCHASED",
          playerId,
          gadgetId,
          isRefill: true,
          replacedGadgetId: null,
          cost: def.refillCost,
          refund: 0,
          newBalance: critter.coins,
        },
      ];
    }

    // Case B — Buy Into Open Slot (< MAX_LOADOUT_SLOTS)
    if (critter.loadout.length < MAX_LOADOUT_SLOTS) {
      if (critter.coins < def.shopCost) {
        return [];
      }
      critter.coins -= def.shopCost;
      critter.loadout.push(gadgetId);
      critter.gadgetCharges[gadgetId] = def.startingCharges;
      return [
        {
          type: "ABILITY_PURCHASED",
          playerId,
          gadgetId,
          isRefill: false,
          replacedGadgetId: null,
          cost: def.shopCost,
          refund: 0,
          newBalance: critter.coins,
        },
      ];
    }

    // Case C — Trade-In Swap (50% Refund) when loadout is full (6 slots)
    if (
      replaceGadgetId === undefined ||
      replaceGadgetId === "gale_mortar" ||
      replaceGadgetId === gadgetId ||
      !Object.prototype.hasOwnProperty.call(GADGET_CATALOG, replaceGadgetId)
    ) {
      return [];
    }
    const replaceIdx = critter.loadout.indexOf(replaceGadgetId);
    if (replaceIdx === -1) {
      return [];
    }

    const refund = Math.floor(GADGET_CATALOG[replaceGadgetId].shopCost * 0.5);
    const netCost = def.shopCost - refund;
    if (critter.coins < netCost) {
      return [];
    }

    critter.coins -= netCost;
    critter.loadout[replaceIdx] = gadgetId;
    critter.gadgetCharges[replaceGadgetId] = 0;
    critter.gadgetCharges[gadgetId] = def.startingCharges;

    return [
      {
        type: "ABILITY_PURCHASED",
        playerId,
        gadgetId,
        isRefill: false,
        replacedGadgetId: replaceGadgetId,
        cost: netCost,
        refund,
        newBalance: critter.coins,
      },
    ];
  }

  /** Fire a turn-ending weapon/gadget during ACTIVE phase, carving SDF terrain and entering RESOLVING. */
  public applyFire(
    playerId: string,
    fire: {
      gadgetId: GadgetId;
      direction: Vec3;
      power: number;
      droneTarget?: Vec3;
    },
  ): EngineEvent[] {
    if (this.phase !== "ACTIVE" || playerId !== this.activePlayerId) {
      return [];
    }
    const shooter = this.findCritter(playerId);
    if (!shooter || !shooter.alive) {
      return [];
    }
    const normDir = safeNormalizeVec3(fire.direction);
    if (!normDir || !Number.isFinite(fire.power)) {
      return [];
    }
    const gadget = GADGET_CATALOG[fire.gadgetId];
    if (!gadget || !gadget.turnEnding) {
      return [];
    }
    if (!shooter.loadout.includes(fire.gadgetId)) {
      return [];
    }
    const charges = shooter.gadgetCharges[fire.gadgetId];
    if (charges !== null && charges <= 0) {
      return [];
    }
    if (charges !== null) {
      shooter.gadgetCharges[fire.gadgetId] = charges - 1;
    }

    const origin: Vec3 = {
      x: shooter.position.x,
      y: shooter.position.y + 0.6,
      z: shooter.position.z,
    };
    const params: ShotParams = {
      shooterId: playerId,
      gadgetId: fire.gadgetId,
      origin,
      direction: normDir,
      power: Math.max(0.1, Math.min(1.0, fire.power)),
      ...(fire.droneTarget && isFiniteVec3(fire.droneTarget)
        ? { droneTarget: { ...fire.droneTarget } }
        : {}),
      species: shooter.species,
      equipped: { ...shooter.equipped },
      apex: shooter.apex,
    };

    const simulation = simulateShot(
      this._world,
      this.critters,
      params,
      this.wind,
      this.waterLevel,
      this.prismWalls,
    );

    const events: EngineEvent[] = this.applySimulationOutcome(
      shooter,
      fire.gadgetId,
      simulation,
    );

    this.phase = "RESOLVING";
    this.phaseTimeRemainingSec = Number((simulation.durationSec + 1.2).toFixed(4));
    events.push({
      type: "PHASE_CHANGED",
      phase: "RESOLVING",
      activePlayerId: this.activePlayerId,
    });

    return events;
  }

  /**
   * Finalize RESOLVING phase: end round if decisive, enter RETREAT (6s) if shooter survived,
   * or skip RETREAT cleanly if shooter KO'd (Review Focus #2).
   */
  public completeResolving(): EngineEvent[] {
    if (this.phase !== "RESOLVING") {
      return [];
    }
    if (this.checkRoundEnded()) {
      return this.finishRound();
    }

    const active = this.activePlayerId
      ? this.findCritter(this.activePlayerId)
      : null;

    if (active && active.alive) {
      active.moveStamina = 40;
      this.phase = "RETREAT";
      this.phaseTimeRemainingSec = this.retreatDurationSec;
      return [
        {
          type: "PHASE_CHANGED",
          phase: "RETREAT",
          activePlayerId: this.activePlayerId,
        },
      ];
    }

    // Review Focus #2: Self-KO or thorns KO skips RETREAT entirely
    return this.enterDraftOrNextTurn();
  }

  /** Carve a protective foxhole capsule once per turn during RETREAT if Burrow Claws are equipped. */
  public applyRetreatBurrow(playerId: string, direction: Vec3): EngineEvent[] {
    if (this.phase !== "RETREAT" || playerId !== this.activePlayerId) {
      return [];
    }
    const critter = this.findCritter(playerId);
    if (!critter || !critter.alive || critter.retreatBurrowUsedThisTurn) {
      return [];
    }
    if (critter.equipped.offense !== "burrow_claws") {
      return [];
    }
    const normDir = safeNormalizeVec3(direction);
    if (!normDir) {
      return [];
    }

    critter.retreatBurrowUsedThisTurn = true;
    const stats = computeCritterStats(critter.species, critter.equipped);
    const carveScale = this.mapScale === "grand" ? 1.35 : 1.0;
    const start: Vec3 = {
      x: critter.position.x,
      y: critter.position.y + 0.3,
      z: critter.position.z,
    };
    const end: Vec3 = {
      x: start.x + normDir.x * 2.8 * carveScale,
      y: start.y + normDir.y * 2.8 * carveScale,
      z: start.z + normDir.z * 2.8 * carveScale,
    };
    const op: CarveOp = {
      shape: "capsule",
      center: start,
      end,
      radius: Number((1.25 * stats.carveMultiplier * carveScale).toFixed(4)),
    };
    const dirtyChunks = this._world.applyCarve(op);

    // Tuck critter slightly inside the newly carved burrow if above water
    const tuckPos: Vec3 = {
      x: start.x + normDir.x * 1.4,
      y: Math.max(this.waterLevel + 0.5, start.y + normDir.y * 1.4),
      z: start.z + normDir.z * 1.4,
    };
    critter.position = tuckPos;
    this.fallPeakY.set(playerId, tuckPos.y);

    return [{ type: "TERRAIN_CARVED", op, dirtyChunks }];
  }

  /** Allow KO'd spectator drone critters to nudge horizontal wind once per turn. */
  public applyDroneNudge(playerId: string, delta: Vec3): EngineEvent[] {
    if (
      this.phase === "MATCH_OVER" ||
      this.phase === "LOBBY" ||
      this.phase === "FINAL_FLOOD"
    ) {
      return [];
    }
    const critter = this.findCritter(playerId);
    if (!critter || critter.alive || critter.droneNudgeUsedThisTurn) {
      return [];
    }
    if (!isFiniteVec3(delta)) {
      return [];
    }
    const horizLen = Math.hypot(delta.x, delta.z);
    if (horizLen < 1e-6) {
      return [];
    }

    critter.droneNudgeUsedThisTurn = true;
    const maxStep = 1.5;
    const scale = Math.min(1, maxStep / horizLen);
    this.wind = clampWind({
      x: this.wind.x + delta.x * scale,
      y: 0,
      z: this.wind.z + delta.z * scale,
    });

    return [{ type: "WIND_NUDGED", playerId, wind: { ...this.wind } }];
  }

  /** Attach a drafted mutation during DRAFT_IF_READY or ROUND_DRAFT, updating stats & Apex synergy. */
  public applyMutationPick(
    playerId: string,
    mutationId: MutationId,
    replaceSlot?: HardpointSlot,
  ): EngineEvent[] {
    if (this.phase !== "DRAFT_IF_READY" && this.phase !== "ROUND_DRAFT") {
      return [];
    }
    const draftIndex = this.pendingDrafts.findIndex(
      (d) => d.playerId === playerId,
    );
    if (draftIndex === -1) {
      return [];
    }
    const draft = this.pendingDrafts[draftIndex];
    if (!draft || !draft.options.includes(mutationId)) {
      return [];
    }
    const critter = this.findCritter(playerId);
    const mutDef = MUTATION_CATALOG[mutationId];
    if (!critter || !mutDef) {
      return [];
    }
    if (replaceSlot !== undefined && replaceSlot !== mutDef.slot) {
      return [];
    }

    const oldMaxHp = critter.maxHp;
    const hadAegis = critter.equipped.crest === "aegis_crest";
    critter.equipped = {
      ...critter.equipped,
      [mutDef.slot]: mutationId,
    };

    const stats = computeCritterStats(critter.species, critter.equipped);
    critter.apex = computeApexSynergy(critter.equipped);
    critter.maxHp = stats.maxHp;
    critter.maxMoveDistance = this.computeMaxMoveDistance(
      critter.species,
      critter.equipped,
    );

    if (critter.alive) {
      if (stats.maxHp > oldMaxHp) {
        critter.hp = Math.min(stats.maxHp, critter.hp + (stats.maxHp - oldMaxHp));
      } else {
        critter.hp = Math.min(stats.maxHp, critter.hp);
      }
    }

    if (critter.equipped.crest === "aegis_crest" && !hadAegis) {
      critter.roundShieldRemaining = Math.max(
        critter.roundShieldRemaining,
        stats.roundShieldHits,
      );
    } else if (critter.equipped.crest !== "aegis_crest") {
      critter.roundShieldRemaining = 0;
    }

    this.pendingDrafts.splice(draftIndex, 1);

    const events: EngineEvent[] = [
      {
        type: "MUTATION_EQUIPPED",
        playerId,
        slot: mutDef.slot,
        mutationId,
        apex: critter.apex,
      },
    ];

    if (this.pendingDrafts.length === 0) {
      if (this.phase === "DRAFT_IF_READY") {
        events.push(...this.advanceToNextTurn());
      } else if (this.phase === "ROUND_DRAFT") {
        events.push(...this.startNextRound());
      }
    }

    return events;
  }

  /** Allow trailing player (or trailing 2v2 team) to use their free draft reroll during ROUND_DRAFT. */
  public applyRerollDraft(playerId: string): EngineEvent[] {
    if (this.phase !== "ROUND_DRAFT" && this.phase !== "DRAFT_IF_READY") {
      return [];
    }
    const idx = this.pendingDrafts.findIndex((d) => d.playerId === playerId);
    if (idx === -1) {
      return [];
    }
    const existing = this.pendingDrafts[idx];
    const critter = this.findCritter(playerId);
    if (!existing || !critter || existing.rerollsRemaining <= 0) {
      return [];
    }

    this.pendingDrafts[idx] = this.buildDraftForPlayer(
      critter,
      existing.rerollsRemaining - 1,
      existing.options,
    );
    return [];
  }

  /** Advance round clock, Round 5 Two-Stage Ocean Deluge, and phase countdown timers. */
  public tick(dtSec: number): EngineEvent[] {
    if (!Number.isFinite(dtSec) || dtSec <= 0) {
      return [];
    }
    if (this.phase === "MATCH_OVER" || this.phase === "LOBBY") {
      return [];
    }

    // Stage 2: Final Round Ocean Deluge engulfment sequence
    if (this.phase === "FINAL_FLOOD") {
      const events: EngineEvent[] = [];
      this.phaseTimeRemainingSec = Math.max(
        0,
        this.phaseTimeRemainingSec - dtSec,
      );
      const t =
        1 -
        this.phaseTimeRemainingSec / Math.max(0.001, this.floodDurationSec);
      const u = Math.pow(Math.max(0, Math.min(1, t)), 1.35);
      const target =
        this.floodTargetWaterLevel ??
        Math.max(
          this._world.getHighestSolidY() + 3.5,
          this._world.worldHeight * 0.78,
        );
      this.waterLevel = Number(
        (
          this.floodStartWaterLevel +
          (target - this.floodStartWaterLevel) * u
        ).toFixed(3),
      );

      for (const c of this.critters) {
        if (c.alive && this.waterLevel >= c.position.y + 0.35) {
          c.alive = false;
          c.hp = 0;
          events.push({
            type: "CRITTER_ENGULFED",
            playerId: c.id,
            position: { ...c.position },
            waterLevel: this.waterLevel,
          });
        }
      }

      if (this.phaseTimeRemainingSec <= 0) {
        this.waterLevel = Number(target.toFixed(3));
        for (const c of this.critters) {
          if (c.alive) {
            c.alive = false;
            c.hp = 0;
            events.push({
              type: "CRITTER_ENGULFED",
              playerId: c.id,
              position: { ...c.position },
              waterLevel: this.waterLevel,
            });
          }
        }
        this.winnerId = null;
        this.winnerTeam = null;
        this.matchEndReason = "flood_draw";
        this.phase = "MATCH_OVER";
        this.activePlayerId = null;
        events.push({
          type: "MATCH_ENDED",
          winnerLabel: "No Winner — Engulfed by the Ocean",
        });
        events.push({
          type: "PHASE_CHANGED",
          phase: "MATCH_OVER",
          activePlayerId: null,
        });
      }
      return events;
    }

    const events: EngineEvent[] = [];

    // Decrement 5-minute round timer during active combat phases
    if (
      this.phase === "ACTIVE" ||
      this.phase === "RESOLVING" ||
      this.phase === "RETREAT"
    ) {
      this.roundTimeRemainingSec = Math.max(
        0,
        this.roundTimeRemainingSec - dtSec,
      );

      // Round 5 Stage 1: Final 60s Warning Tide Creep
      const warnWindow = Math.min(
        ROUND5_WARNING_WINDOW_SEC,
        this.roundDurationSec * 0.5,
      );
      if (
        this.round >= this.maxRounds &&
        this.roundTimeRemainingSec > 0 &&
        this.roundTimeRemainingSec <= warnWindow
      ) {
        const p = 1 - this.roundTimeRemainingSec / Math.max(0.001, warnWindow);
        const desiredWater = Number(
          (INITIAL_WATER_LEVEL + ROUND5_WARNING_TIDE_RISE * p).toFixed(3),
        );
        if (desiredWater > this.waterLevel) {
          const prevStep = Math.floor(
            (this.waterLevel - INITIAL_WATER_LEVEL) / 0.5,
          );
          this.waterLevel = desiredWater;
          const nextStep = Math.floor(
            (this.waterLevel - INITIAL_WATER_LEVEL) / 0.5,
          );
          if (nextStep > prevStep) {
            events.push({ type: "WATER_ROSE", waterLevel: this.waterLevel });
          }
        }

        Hazards.pruneSubmergedHazards(
          this._world,
          this.hazards,
          this.waterLevel,
        );

        let submergedAny = false;
        for (const c of this.critters) {
          if (c.alive && c.position.y <= this.waterLevel) {
            c.alive = false;
            c.hp = 0;
            submergedAny = true;
          }
        }
        if (submergedAny) {
          if (this.checkRoundEnded()) {
            events.push(...this.finishRound());
            return events;
          }
          if (
            (this.phase === "ACTIVE" || this.phase === "RETREAT") &&
            this.activePlayerId
          ) {
            const active = this.findCritter(this.activePlayerId);
            if (active && !active.alive) {
              events.push(...this.enterDraftOrNextTurn());
              return events;
            }
          }
        }
      }

      // Round Clock Hit 0:00
      if (this.roundTimeRemainingSec <= 0) {
        if (this.round >= this.maxRounds) {
          this.roundWinners.push(null);
          events.push({
            type: "ROUND_ENDED",
            round: this.round,
            winnerLabel: "Draw",
          });
          events.push(...this.startFinalFlood());
          return events;
        }
        events.push(...this.finishRoundAsTimeUpDraw());
        return events;
      }
    }

    this.phaseTimeRemainingSec = Math.max(0, this.phaseTimeRemainingSec - dtSec);
    if (this.phaseTimeRemainingSec > 0) {
      return events;
    }

    if (this.phase === "ACTIVE") {
      events.push(...this.enterDraftOrNextTurn());
      return events;
    }
    if (this.phase === "RESOLVING") {
      events.push(...this.completeResolving());
      return events;
    }
    if (this.phase === "RETREAT") {
      events.push(...this.enterDraftOrNextTurn());
      return events;
    }
    if (this.phase === "DRAFT_IF_READY" || this.phase === "ROUND_DRAFT") {
      const pendingCopy = [...this.pendingDrafts];
      for (const d of pendingCopy) {
        const fallback = d.options[0];
        if (fallback) {
          events.push(...this.applyMutationPick(d.playerId, fallback));
        }
      }
      return events;
    }

    return events;
  }

  /** Return a clean JSON-serializable snapshot of the complete authoritative match state. */
  public getSnapshot(): MatchState {
    const scores: Record<string, number> = {};
    for (const c of this.critters) {
      scores[c.id] = c.score;
    }
    return {
      matchId: this.matchId,
      roomCode: this.roomCode,
      seed: this.config.seed,
      theme: this.config.theme,
      mode: this.config.mode,
      mapScale: this.mapScale,
      phase: this.phase,
      round: this.round,
      maxRounds: this.maxRounds,
      turnNumber: this.turnNumber,
      activeCritterId: this.activePlayerId,
      activePlayerId: this.activePlayerId,
      phaseTimerMs: Math.round(this.phaseTimeRemainingSec * 1000),
      phaseTimeRemainingSec: Number(this.phaseTimeRemainingSec.toFixed(4)),
      roundTimeRemainingSec: Number(this.roundTimeRemainingSec.toFixed(4)),
      roundDurationSec: this.roundDurationSec,
      waterLevel: this.waterLevel,
      floodTargetWaterLevel: this.floodTargetWaterLevel,
      matchEndReason: this.matchEndReason,
      wind: { ...this.wind },
      critters: this.critters.map(cloneCritter),
      evoPods: this.evoPods.map(clonePod),
      hazards: this.hazards.map(Hazards.cloneHazard),
      prismWalls: this.prismWalls
        .filter((w) => w.active)
        .map(clonePrismWall),
      pendingDrafts: this.pendingDrafts.map(cloneDraft),
      carveLog: this._world.getCarveLog(),
      scores,
      teamScores: { ...this.teamScores },
      winnerId: this.winnerId,
      winnerTeam: this.winnerTeam,
      roundWinners: [...this.roundWinners],
    };
  }

  private awardCoins(
    critter: CritterState,
    amount: number,
    reason: string,
  ): EngineEvent {
    critter.coins += amount;
    return {
      type: "COINS_EARNED",
      playerId: critter.id,
      amount,
      reason,
      newBalance: critter.coins,
    };
  }

  private awardHazardEnemyDamageCoins(
    attacker: CritterState,
    damage: number,
    source: "spark_mine" | "blast_barrel",
  ): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (damage > 0) {
      const dmgCoins = Math.max(5, Math.floor(damage / 3));
      events.push(this.awardCoins(attacker, dmgCoins, "enemy_damage"));
    }
    if (source === "blast_barrel") {
      events.push(
        this.awardCoins(attacker, COINS_BARREL_CHAIN_HIT, "barrel_chain_hit"),
      );
    }
    return events;
  }

  private computeMaxMoveDistance(
    species: CritterState["species"],
    equipped: Partial<Record<HardpointSlot, MutationId>>,
  ): number {
    return computeSharedMaxMoveDistance(this.mapScale, species, equipped);
  }

  private computeRetreatMoveDistance(
    species: CritterState["species"],
    equipped: Partial<Record<HardpointSlot, MutationId>>,
  ): number {
    return computeSharedRetreatMoveDistance(this.mapScale, species, equipped);
  }

  private getRoundCycle(): number {
    return (
      Math.floor((this.turnNumber - 1) / Math.max(1, this.critters.length)) + 1
    );
  }

  private isSuddenDeath(): boolean {
    const warnWindow = Math.min(
      ROUND5_WARNING_WINDOW_SEC,
      this.roundDurationSec * 0.5,
    );
    return (
      this.getRoundCycle() >= 9 ||
      (this.round >= this.maxRounds && this.roundTimeRemainingSec <= warnWindow)
    );
  }

  private findRescuePosition(critter: CritterState): Vec3 {
    const candidates = this._world.findPersistentRoundSpawnPoints(
      Math.max(4, this.critters.length),
      this.waterLevel,
    );
    const dry = candidates.filter((pt) => pt.y > this.waterLevel + 1.0);
    const chosen = dry[critter.seatIndex % Math.max(1, dry.length)] ?? dry[0];
    if (chosen) {
      return { ...chosen };
    }
    const centerSurf = this._world.getSurfaceY(
      this._world.centerX,
      this._world.centerZ,
    );
    return {
      x: this._world.centerX,
      y: Math.max(this.waterLevel + 2.0, centerSurf ?? 10.0),
      z: this._world.centerZ,
    };
  }

  private resolveWaterContact(
    critter: CritterState,
    attacker?: CritterState | null,
  ): EngineEvent[] {
    if (!critter.alive || critter.position.y > this.waterLevel) {
      return [];
    }
    if (!this.isSuddenDeath()) {
      const splashDamage = 35;
      critter.hp = Math.max(0, critter.hp - splashDamage);
      if (critter.hp <= 0) {
        critter.alive = false;
        critter.hp = 0;
        if (
          attacker &&
          attacker.id !== critter.id &&
          !this.areTeammates(attacker, critter)
        ) {
          return this.awardEnemyKo(attacker);
        }
        return [];
      }
      const safePos = this.findRescuePosition(critter);
      critter.position = { ...safePos };
      critter.velocity = { x: 0, y: 0, z: 0 };
      this.fallPeakY.set(critter.id, safePos.y);
      return [
        {
          type: "WATER_RESCUED",
          playerId: critter.id,
          position: safePos,
          damage: splashDamage,
        },
      ];
    }

    critter.alive = false;
    critter.hp = 0;
    if (
      attacker &&
      attacker.id !== critter.id &&
      !this.areTeammates(attacker, critter)
    ) {
      return this.awardEnemyKo(attacker);
    }
    return [];
  }

  private initializeCritters(): void {
    const spawns = this._world.findSpawnPoints(this.config.players.length);
    const centerX = this._world.centerX;
    const centerZ = this._world.centerZ;
    this.fallPeakY.clear();
    this.critters = this.config.players.map((p, idx) => {
      const spawn = spawns[idx] ?? { x: centerX + idx, y: 10.0, z: centerZ };
      const team = normalizeTeam(this.config.mode, p.team, idx);
      const stats = computeCritterStats(p.species, {});
      const startingKit = validateAndBuildStartingLoadout(
        p.startingLoadout,
        this.startingCoins,
      );
      this.fallPeakY.set(p.id, spawn.y);
      return {
        id: p.id,
        name: p.name,
        species: p.species,
        isBot: p.isBot ?? false,
        team,
        seatIndex: idx,
        connected: true,
        position: { ...spawn },
        velocity: { x: 0, y: 0, z: 0 },
        yaw: 0,
        pitch: 0,
        hp: stats.maxHp,
        maxHp: stats.maxHp,
        moveStamina: 100,
        maxMoveDistance: this.computeMaxMoveDistance(p.species, {}),
        alive: true,
        evoCharge: 0,
        pendingEvoDraft: false,
        equipped: {},
        apex: null,
        coins: startingKit.remainingCoins,
        loadout: startingKit.loadout,
        gadgetCharges: startingKit.gadgetCharges,
        roundShieldRemaining: stats.roundShieldHits,
        kills: 0,
        damageDealt: 0,
        podsCollected: 0,
        score: 0,
        droneNudgeUsedThisTurn: false,
        retreatBurrowUsedThisTurn: false,
        skyBomberDropUsedThisTurn: false,
        grappleUsedThisTurn: false,
        colorIndex: idx,
        color: p.color ?? DEFAULT_COLORS[idx % DEFAULT_COLORS.length] ?? "#e67e22",
      };
    });
    this.hazards = Hazards.createRoundHazards(this._world, this.round, spawns);
    this.thornTriggeredThisTurn.clear();
  }

  private findCritter(id: string): CritterState | undefined {
    return this.critters.find((c) => c.id === id);
  }

  private areTeammates(a: CritterState, b: CritterState): boolean {
    return (
      this.config.mode === "2v2" &&
      a.team !== null &&
      b.team !== null &&
      a.team === b.team
    );
  }

  private awardEnemyKo(attacker: CritterState): EngineEvent[] {
    attacker.kills += 1;
    attacker.score += 1;
    if (this.config.mode === "2v2" && attacker.team) {
      this.teamScores[attacker.team] += 1;
    }
    attacker.evoCharge = Math.min(100, attacker.evoCharge + 50);
    if (attacker.evoCharge >= 100) {
      attacker.pendingEvoDraft = true;
    }
    return [this.awardCoins(attacker, COINS_ENEMY_KO, "enemy_ko")];
  }

  private rollWind(): void {
    const wx = (this.rng() * 2 - 1) * 4.0;
    const wz = (this.rng() * 2 - 1) * 4.0;
    this.wind = clampWind({ x: wx, y: 0, z: wz });
  }

  private shiftWindSlightly(): void {
    const dx = (this.rng() * 2 - 1) * 1.2;
    const dz = (this.rng() * 2 - 1) * 1.2;
    this.wind = clampWind({
      x: this.wind.x + dx,
      y: 0,
      z: this.wind.z + dz,
    });
  }

  private selectInitialActiveCritter(): string | null {
    if (this.critters.length === 0) {
      return null;
    }
    if (this.config.mode === "2v2") {
      this.teamCursor = { A: 0, B: 0 };
      const teamA = this.critters.filter((c) => c.team === "A");
      const firstA = teamA.find((c) => c.alive);
      if (firstA) {
        const idxInTeam = teamA.indexOf(firstA);
        this.teamCursor.A = (idxInTeam + 1) % Math.max(1, teamA.length);
        this.lastTeamTurn = "A";
        return firstA.id;
      }
      const teamB = this.critters.filter((c) => c.team === "B");
      const firstB = teamB.find((c) => c.alive);
      if (firstB) {
        const idxInTeam = teamB.indexOf(firstB);
        this.teamCursor.B = (idxInTeam + 1) % Math.max(1, teamB.length);
        this.lastTeamTurn = "B";
        return firstB.id;
      }
      return null;
    }

    this.ffaCursor = 0;
    const firstAlive = this.critters.find((c) => c.alive);
    if (firstAlive) {
      this.ffaCursor = firstAlive.seatIndex;
      return firstAlive.id;
    }
    return null;
  }

  /**
   * Select next active critter.
   * Review Focus #3: In 2v2 mode, strictly alternates Team A <-> Team B turns
   * with per-team round-robin cursors even when one team has fewer alive critters.
   */
  private selectNextActiveCritter(): string | null {
    if (this.config.mode === "2v2") {
      const nextTeam: TeamId = this.lastTeamTurn === "A" ? "B" : "A";
      const candidateTeams: TeamId[] = [nextTeam, nextTeam === "A" ? "B" : "A"];

      for (const team of candidateTeams) {
        const members = this.critters.filter((c) => c.team === team);
        if (members.length === 0) continue;
        const start = this.teamCursor[team] % members.length;
        for (let offset = 0; offset < members.length; offset++) {
          const idx = (start + offset) % members.length;
          const member = members[idx];
          if (member && member.alive) {
            this.teamCursor[team] = (idx + 1) % members.length;
            this.lastTeamTurn = team;
            return member.id;
          }
        }
      }
      return null;
    }

    const count = this.critters.length;
    for (let offset = 1; offset <= count; offset++) {
      const idx = (this.ffaCursor + offset) % count;
      const cand = this.critters[idx];
      if (cand && cand.alive) {
        this.ffaCursor = idx;
        return cand.id;
      }
    }
    return null;
  }

  private grantPodBonusGadget(
    critter: CritterState,
    candidate: GadgetId,
    events: EngineEvent[],
  ): GadgetId | null {
    if (critter.loadout.includes(candidate)) {
      const prev = critter.gadgetCharges[candidate];
      if (prev !== null) {
        critter.gadgetCharges[candidate] = prev + 1;
        return candidate;
      }
    } else if (critter.loadout.length < MAX_LOADOUT_SLOTS) {
      critter.loadout.push(candidate);
      critter.gadgetCharges[candidate] =
        GADGET_CATALOG[candidate].startingCharges === null ? null : 1;
      return candidate;
    }

    // Loadout full (or candidate is unlimited) -> increment an owned limited gadget
    const ownedLimited = critter.loadout.filter(
      (id) => GADGET_CATALOG[id].startingCharges !== null,
    );
    if (ownedLimited.length > 0) {
      const chosen =
        ownedLimited[Math.floor(this.rng() * ownedLimited.length)] ??
        ownedLimited[0];
      if (chosen) {
        critter.gadgetCharges[chosen] =
          (critter.gadgetCharges[chosen] ?? 0) + 1;
        return chosen;
      }
    }

    // All owned gadgets are unlimited -> grant +15 extra Siege Coins!
    events.push(
      this.awardCoins(
        critter,
        COINS_UNLIMITED_POD_FALLBACK,
        "pod_bonus_coins",
      ),
    );
    return null;
  }

  private collectPodsInRange(critter: CritterState): EngineEvent[] {
    const events: EngineEvent[] = [];
    const magnet = SPECIES_CATALOG[critter.species].podMagnetRadius;
    const superGadgetPool: readonly GadgetId[] = [
      "gravity_mine",
      "shock_magnet",
      "spore_burst",
      "burrow_bore",
    ];

    for (const pod of this.evoPods) {
      if (pod.collected) continue;
      const dist = Math.hypot(
        critter.position.x - pod.position.x,
        critter.position.y - pod.position.y,
        critter.position.z - pod.position.z,
      );
      if (dist <= magnet) {
        pod.collected = true;
        critter.podsCollected += 1;
        const kind = pod.kind ?? "evo_dna";

        if (kind === "med_berry") {
          const prevHp = critter.hp;
          critter.hp = Math.min(critter.maxHp, critter.hp + 55);
          const healedHp = critter.hp - prevHp;
          events.push({
            type: "EVO_POD_COLLECTED",
            playerId: critter.id,
            podId: pod.id,
            bonusGadget: null,
            podKind: "med_berry",
            healedHp,
          });
          events.push(
            this.awardCoins(critter, COINS_POD_COLLECTED, "pod_collected"),
          );
          continue;
        }

        if (kind === "super_gadget") {
          critter.evoCharge = Math.min(100, critter.evoCharge + 25);
          if (critter.evoCharge >= 100) {
            critter.pendingEvoDraft = true;
          }
          const candidate =
            superGadgetPool[Math.floor(this.rng() * superGadgetPool.length)] ??
            "gravity_mine";
          const extraEvents: EngineEvent[] = [];
          const bonusGadget = this.grantPodBonusGadget(
            critter,
            candidate,
            extraEvents,
          );
          events.push({
            type: "EVO_POD_COLLECTED",
            playerId: critter.id,
            podId: pod.id,
            bonusGadget,
            podKind: "super_gadget",
            healedHp: 0,
          });
          events.push(
            this.awardCoins(critter, COINS_POD_COLLECTED, "pod_collected"),
          );
          events.push(...extraEvents);
          continue;
        }

        critter.evoCharge = Math.min(100, critter.evoCharge + 50);
        if (critter.evoCharge >= 100) {
          critter.pendingEvoDraft = true;
        }

        const pool: GadgetId[] = [
          ...STANDARD_LIMITED_GADGETS,
          ...this.unlockedBonusGadgets,
        ];
        const candidate =
          pool[Math.floor(this.rng() * pool.length)] ?? "spore_burst";
        const extraEvents: EngineEvent[] = [];
        const bonusGadget = this.grantPodBonusGadget(
          critter,
          candidate,
          extraEvents,
        );

        events.push({
          type: "EVO_POD_COLLECTED",
          playerId: critter.id,
          podId: pod.id,
          bonusGadget,
          podKind: "evo_dna",
          healedHp: 0,
        });
        events.push(
          this.awardCoins(critter, COINS_POD_COLLECTED, "pod_collected"),
        );
        events.push(...extraEvents);
      }
    }

    return events;
  }

  private applySimulationOutcome(
    shooter: CritterState,
    gadgetId: GadgetId,
    simulation: ReturnType<typeof simulateShot>,
  ): EngineEvent[] {
    const events: EngineEvent[] = [];
    const preImpactPositions = new Map<string, Vec3>();
    for (const c of this.critters) {
      preImpactPositions.set(c.id, { ...c.position });
    }

    for (const op of simulation.carveOps) {
      const dirtyChunks = this._world.applyCarve(op);
      events.push({ type: "TERRAIN_CARVED", op, dirtyChunks });
    }

    for (const hit of simulation.hits) {
      const target = this.findCritter(hit.critterId);
      if (!target) continue;

      const prevHp = target.hp;
      target.position = { ...hit.newPosition };
      if (hit.shieldAbsorbed && target.roundShieldRemaining > 0) {
        target.roundShieldRemaining -= 1;
      }

      const isSelf = target.id === shooter.id;
      const isFriendly = !isSelf && this.areTeammates(shooter, target);

      if (!isSelf && !isFriendly) {
        shooter.damageDealt += hit.damage;
        if (hit.damage > 0) {
          events.push(
            this.awardCoins(
              shooter,
              Math.max(5, Math.floor(hit.damage / 3)),
              "enemy_damage",
            ),
          );
        }
      }

      if (hit.drowned && !this.isSuddenDeath() && target.alive) {
        // Cycles 1-8 Water Rescue Parachute: blast damage + 35 splash damage, rescue if still > 0 HP
        target.hp = Math.max(0, prevHp - hit.damage);
        if (target.hp <= 0) {
          target.alive = false;
          if (!isSelf && !isFriendly) {
            events.push(...this.awardEnemyKo(shooter));
          }
        } else {
          target.position = {
            ...target.position,
            y: Math.min(target.position.y, this.waterLevel),
          };
          events.push(...this.resolveWaterContact(target, shooter));
        }
      } else {
        target.hp = hit.newHp;
        if (hit.knockedOut && target.alive) {
          target.alive = false;
          // Review Focus #2 & #3: Only true enemy KOs award +1 KO point, +50% Evo Charge & +40 Siege Coins!
          if (!isSelf && !isFriendly) {
            events.push(...this.awardEnemyKo(shooter));
          }
        }
      }
    }

    for (const wallId of simulation.shatteredPrismWallIds ?? []) {
      const wall = this.prismWalls.find((w) => w.id === wallId && w.active);
      if (wall) {
        wall.active = false;
        events.push({
          type: "PRISM_WALL_SHATTERED",
          wallId: wall.id,
          position: { ...wall.position },
        });
      }
    }

    events.push({
      type: "SHOT_RESOLVED",
      shooterId: shooter.id,
      gadgetId,
      simulation,
    });

    // Trigger Blast Barrel chain detonations from damaging projectile/melee impacts
    const damagingImpacts = simulation.impacts.filter(
      (imp) => imp.damageRadius > 0 || imp.baseDamage > 0,
    );
    events.push(
      ...Hazards.resolveBarrelChainDetonations({
        world: this._world,
        hazards: this.hazards,
        critters: this.critters,
        shooter,
        initialImpacts: damagingImpacts,
        waterLevel: this.waterLevel,
        preImpactPositions,
        areTeammates: (a, b) => this.areTeammates(a, b),
        onEnemyDamage: (attacker, damage) =>
          this.awardHazardEnemyDamageCoins(attacker, damage, "blast_barrel"),
        onEnemyKo: (attacker) => this.awardEnemyKo(attacker),
        onWaterContact: (target, attacker) =>
          this.resolveWaterContact(target, attacker),
      }),
    );

    // Check if any knocked-back surviving critter landed on a Spark Mine, Thermal Geyser, or Thorn Patch
    for (const hit of simulation.hits) {
      const target = this.findCritter(hit.critterId);
      if (target && target.alive) {
        events.push(
          ...Hazards.applyGroundHazardsForCritter(
            this._world,
            this.hazards,
            target,
            this.thornTriggeredThisTurn,
            this.waterLevel,
            {
              critters: this.critters,
              shooter,
              areTeammates: (a, b) => this.areTeammates(a, b),
              onEnemyDamage: (attacker, damage, source) =>
                this.awardHazardEnemyDamageCoins(attacker, damage, source),
              onEnemyKo: (attacker) => this.awardEnemyKo(attacker),
              onWaterContact: (affected, attacker) =>
                this.resolveWaterContact(affected, attacker),
            },
          ),
        );
      }
    }

    for (const c of this.critters) {
      this.fallPeakY.set(c.id, c.position.y);
    }

    return events;
  }

  private enterDraftOrNextTurn(): EngineEvent[] {
    const active = this.activePlayerId
      ? this.findCritter(this.activePlayerId)
      : null;

    if (active && active.pendingEvoDraft) {
      active.pendingEvoDraft = false;
      active.evoCharge = Math.max(0, active.evoCharge - 100);
      this.pendingDrafts = [this.buildDraftForPlayer(active, 0)];
      this.phase = "DRAFT_IF_READY";
      this.phaseTimeRemainingSec = DEFAULT_DRAFT_DURATION_SEC;
      return [
        {
          type: "PHASE_CHANGED",
          phase: "DRAFT_IF_READY",
          activePlayerId: active.id,
        },
      ];
    }

    return this.advanceToNextTurn();
  }

  private advanceToNextTurn(): EngineEvent[] {
    const events: EngineEvent[] = [];
    this.turnNumber += 1;
    this.thornTriggeredThisTurn.clear();

    for (const c of this.critters) {
      c.moveStamina = 100;
      c.grappleUsedThisTurn = false;
      c.droneNudgeUsedThisTurn = false;
      c.retreatBurrowUsedThisTurn = false;
      c.skyBomberDropUsedThisTurn = false;
      this.fallPeakY.set(c.id, c.position.y);
    }

    // Decay temporary prism walls & land parachuting pods
    this.prismWalls = this.prismWalls
      .filter((w) => w.active)
      .map((w) => ({ ...w, turnsLeft: w.turnsLeft - 1 }))
      .filter((w) => w.turnsLeft > 0);
    for (const pod of this.evoPods) {
      if (!pod.collected && pod.parachuting) {
        pod.parachuting = false;
      }
    }

    this.shiftWindSlightly();

    // Sudden Death rising water begins at Cycle 9 (preserves persistent island without crumbleOuterRing)
    const suddenDeathTurn = Math.max(1, this.critters.length) * 8 + 1;
    if (this.turnNumber >= suddenDeathTurn) {
      this.waterLevel = Number((this.waterLevel + 0.65).toFixed(2));
      Hazards.pruneSubmergedHazards(this._world, this.hazards, this.waterLevel);
      events.push({ type: "WATER_ROSE", waterLevel: this.waterLevel });

      for (const c of this.critters) {
        if (!c.alive) continue;
        if (c.position.y <= this.waterLevel) {
          c.position = {
            ...c.position,
            y: Math.min(c.position.y, this.waterLevel),
          };
          c.alive = false;
          c.hp = 0;
        }
      }

      if (this.checkRoundEnded()) {
        events.push(...this.finishRound());
        return events;
      }
    }

    // Spawn parachuting Evo Pods every 2 turns (every turn in Round 3+)
    const shouldSpawnPod = this.round >= 3 || this.turnNumber % 2 === 0;
    const activePods = this.evoPods.filter((p) => !p.collected).length;
    if (shouldSpawnPod && activePods < MAX_ACTIVE_PODS) {
      const pod = this.spawnEvoPod();
      if (pod) {
        events.push({ type: "EVO_POD_SPAWNED", pod: clonePod(pod) });
      }
    }

    this.activePlayerId = this.selectNextActiveCritter();
    if (!this.activePlayerId) {
      events.push(...this.finishRound());
      return events;
    }

    this.phase = "ACTIVE";
    this.phaseTimeRemainingSec = this.turnDurationSec;
    events.push({
      type: "PHASE_CHANGED",
      phase: "ACTIVE",
      activePlayerId: this.activePlayerId,
    });

    return events;
  }

  private spawnEvoPod(): EvoPodState | null {
    const candidates = this._world.findPersistentRoundSpawnPoints(
      6,
      this.waterLevel,
    );
    const valid = candidates.filter((pt) => pt.y > this.waterLevel + 0.8);
    if (valid.length === 0) {
      return null;
    }
    const chosen = valid[Math.floor(this.rng() * valid.length)] ?? valid[0];
    if (!chosen) {
      return null;
    }
    this.podCounter += 1;
    const podCycle = ["evo_dna", "med_berry", "super_gadget"] as const;
    const kind = podCycle[(this.podCounter - 1) % podCycle.length] ?? "evo_dna";
    const pod: EvoPodState = {
      id: `pod-r${this.round}-t${this.turnNumber}-${this.podCounter}`,
      position: { x: chosen.x, y: chosen.y + 0.35, z: chosen.z },
      collected: false,
      spawnedAtTurn: this.turnNumber,
      parachuting: true,
      kind,
    };
    this.evoPods.push(pod);
    return pod;
  }

  private checkRoundEnded(): boolean {
    if (this.config.mode === "2v2") {
      const aliveA = this.critters.some((c) => c.team === "A" && c.alive);
      const aliveB = this.critters.some((c) => c.team === "B" && c.alive);
      return !aliveA || !aliveB;
    }
    const aliveCount = this.critters.filter((c) => c.alive).length;
    return aliveCount <= 1;
  }

  private startFinalFlood(): EngineEvent[] {
    this.phase = "FINAL_FLOOD";
    this.activePlayerId = null;
    this.phaseTimeRemainingSec = this.floodDurationSec;
    this.floodStartWaterLevel = this.waterLevel;
    this.floodTargetWaterLevel = Number(
      Math.max(
        this._world.getHighestSolidY() + 3.5,
        this._world.worldHeight * 0.78,
      ).toFixed(3),
    );
    return [
      {
        type: "FINAL_FLOOD_STARTED",
        targetWaterLevel: this.floodTargetWaterLevel,
        durationSec: this.floodDurationSec,
      },
      {
        type: "PHASE_CHANGED",
        phase: "FINAL_FLOOD",
        activePlayerId: null,
      },
    ];
  }

  private awardEndOfRoundStipends(trailingIds: ReadonlySet<string>): EngineEvent[] {
    const events: EngineEvent[] = [];
    for (const c of this.critters) {
      const isTrailing = trailingIds.has(c.id);
      const amount = isTrailing
        ? COINS_ROUND_STIPEND + COINS_TRAILING_BONUS
        : COINS_ROUND_STIPEND;
      events.push(
        this.awardCoins(
          c,
          amount,
          isTrailing ? "round_stipend_comeback" : "round_stipend",
        ),
      );
    }
    return events;
  }

  private enterRoundDraft(): EngineEvent[] {
    const events: EngineEvent[] = [];
    const trailingIds = this.getTrailingPlayerIds();
    events.push(...this.awardEndOfRoundStipends(trailingIds));
    this.pendingDrafts = this.critters.map((c) =>
      this.buildDraftForPlayer(c, trailingIds.has(c.id) ? 1 : 0),
    );
    this.phase = "ROUND_DRAFT";
    this.activePlayerId = null;
    this.phaseTimeRemainingSec = DEFAULT_DRAFT_DURATION_SEC;
    events.push({
      type: "PHASE_CHANGED",
      phase: "ROUND_DRAFT",
      activePlayerId: null,
    });
    return events;
  }

  private finishRoundAsTimeUpDraw(): EngineEvent[] {
    const events: EngineEvent[] = [];
    this.roundWinners.push(null);
    events.push({
      type: "ROUND_ENDED",
      round: this.round,
      winnerLabel: "Draw",
    });
    events.push(...this.enterRoundDraft());
    return events;
  }

  private finishRound(): EngineEvent[] {
    const events: EngineEvent[] = [];
    let winnerLabel = "Draw";
    let roundWasDraw = false;

    if (this.config.mode === "2v2") {
      const aliveA = this.critters.some((c) => c.team === "A" && c.alive);
      const aliveB = this.critters.some((c) => c.team === "B" && c.alive);
      if (aliveA && !aliveB) {
        winnerLabel = "Team A";
        this.teamScores.A += 2;
        this.roundWinners.push("A");
      } else if (aliveB && !aliveA) {
        winnerLabel = "Team B";
        this.teamScores.B += 2;
        this.roundWinners.push("B");
      } else {
        roundWasDraw = true;
        this.roundWinners.push(null);
      }
    } else {
      const survivor = this.critters.find((c) => c.alive);
      if (survivor) {
        winnerLabel = survivor.name;
        survivor.score += 2;
        this.roundWinners.push(survivor.id);
      } else {
        roundWasDraw = true;
        this.roundWinners.push(null);
      }
    }

    events.push({
      type: "ROUND_ENDED",
      round: this.round,
      winnerLabel,
    });

    // Always play all rounds through maxRounds (default 5)
    if (this.round >= this.maxRounds) {
      // Round 5 simultaneous KO / draw triggers Stage 2 Ocean Deluge!
      if (roundWasDraw) {
        events.push(...this.startFinalFlood());
        return events;
      }

      const matchDecision = this.evaluateMatchWinner();
      this.phase = "MATCH_OVER";
      this.activePlayerId = null;
      this.phaseTimeRemainingSec = 0;
      this.winnerId = matchDecision.winnerId;
      this.winnerTeam = matchDecision.winnerTeam;
      this.matchEndReason = "score";
      events.push({
        type: "MATCH_ENDED",
        winnerLabel: matchDecision.label,
      });
      events.push({
        type: "PHASE_CHANGED",
        phase: "MATCH_OVER",
        activePlayerId: null,
      });
      return events;
    }

    events.push(...this.enterRoundDraft());
    return events;
  }

  /**
   * Evaluate final match winner by Total Score (+2/Round Win, +1/KO),
   * breaking ties by Total Kills, then Total Damage Dealt.
   */
  private evaluateMatchWinner(): {
    tied: boolean;
    winnerId: string | null;
    winnerTeam: TeamId | null;
    label: string;
  } {
    if (this.config.mode === "2v2") {
      if (this.teamScores.A !== this.teamScores.B) {
        const winTeam: TeamId = this.teamScores.A > this.teamScores.B ? "A" : "B";
        return {
          tied: false,
          winnerId: null,
          winnerTeam: winTeam,
          label: winTeam === "A" ? "Team A" : "Team B",
        };
      }

      const killsA = this.critters
        .filter((c) => c.team === "A")
        .reduce((sum, c) => sum + c.kills, 0);
      const killsB = this.critters
        .filter((c) => c.team === "B")
        .reduce((sum, c) => sum + c.kills, 0);
      if (killsA !== killsB) {
        const winTeam: TeamId = killsA > killsB ? "A" : "B";
        return {
          tied: false,
          winnerId: null,
          winnerTeam: winTeam,
          label: winTeam === "A" ? "Team A" : "Team B",
        };
      }

      const dmgA = this.critters
        .filter((c) => c.team === "A")
        .reduce((sum, c) => sum + c.damageDealt, 0);
      const dmgB = this.critters
        .filter((c) => c.team === "B")
        .reduce((sum, c) => sum + c.damageDealt, 0);
      if (dmgA !== dmgB) {
        const winTeam: TeamId = dmgA > dmgB ? "A" : "B";
        return {
          tied: false,
          winnerId: null,
          winnerTeam: winTeam,
          label: winTeam === "A" ? "Team A" : "Team B",
        };
      }

      return { tied: true, winnerId: null, winnerTeam: null, label: "Draw" };
    }

    const sorted = [...this.critters].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.kills !== a.kills) return b.kills - a.kills;
      return b.damageDealt - a.damageDealt;
    });
    const first = sorted[0];
    const second = sorted[1];
    if (!first) {
      return { tied: true, winnerId: null, winnerTeam: null, label: "Draw" };
    }
    if (
      second &&
      first.score === second.score &&
      first.kills === second.kills &&
      first.damageDealt === second.damageDealt
    ) {
      return { tied: true, winnerId: null, winnerTeam: null, label: "Draw" };
    }
    return {
      tied: false,
      winnerId: first.id,
      winnerTeam: null,
      label: first.name,
    };
  }

  private getTrailingPlayerIds(): Set<string> {
    const trailing = new Set<string>();
    if (this.config.mode === "2v2") {
      if (this.teamScores.A < this.teamScores.B) {
        for (const c of this.critters) {
          if (c.team === "A") trailing.add(c.id);
        }
      } else if (this.teamScores.B < this.teamScores.A) {
        for (const c of this.critters) {
          if (c.team === "B") trailing.add(c.id);
        }
      }
      return trailing;
    }

    let maxScore = -Infinity;
    for (const c of this.critters) {
      if (c.score > maxScore) maxScore = c.score;
    }
    for (const c of this.critters) {
      if (c.score < maxScore) {
        trailing.add(c.id);
      }
    }
    return trailing;
  }

  private buildDraftForPlayer(
    critter: CritterState,
    rerollsRemaining: number,
    avoidPrevious?: readonly MutationId[],
  ): PendingDraftState {
    const equippedSet = new Set<MutationId>();
    const emptySlots = new Set<HardpointSlot>();
    for (const slot of HARDPOINT_SLOTS) {
      const m = critter.equipped[slot];
      if (m) {
        equippedSet.add(m);
      } else {
        emptySlots.add(slot);
      }
    }

    const allSlotsFull = emptySlots.size === 0;
    const unequipped = MUTATION_IDS.filter((id) => !equippedSet.has(id));
    const emptySlotPool = unequipped.filter((id) =>
      emptySlots.has(MUTATION_CATALOG[id].slot),
    );
    const swapPool = unequipped.filter(
      (id) => !emptySlots.has(MUTATION_CATALOG[id].slot),
    );

    const shuffle = (arr: MutationId[]): MutationId[] => {
      const copy = [...arr];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        const a = copy[i];
        const b = copy[j];
        if (a !== undefined && b !== undefined) {
          copy[i] = b;
          copy[j] = a;
        }
      }
      return copy;
    };

    const prioritizeFresh = (arr: MutationId[]): MutationId[] => {
      if (!avoidPrevious || avoidPrevious.length === 0) {
        return shuffle(arr);
      }
      const prevSet = new Set(avoidPrevious);
      const fresh = shuffle(arr.filter((id) => !prevSet.has(id)));
      const repeated = shuffle(arr.filter((id) => prevSet.has(id)));
      return [...fresh, ...repeated];
    };

    const primary = allSlotsFull
      ? prioritizeFresh(swapPool)
      : [...prioritizeFresh(emptySlotPool), ...prioritizeFresh(swapPool)];

    const options = primary.slice(0, 3);
    const cards: DraftCardOption[] = options.map((mutationId) => {
      const slot = MUTATION_CATALOG[mutationId].slot;
      return {
        mutationId,
        slot,
        replacesMutationId: critter.equipped[slot] ?? null,
      };
    });

    return {
      playerId: critter.id,
      options,
      cards,
      rerollsRemaining,
      requiresSlotSwap: allSlotsFull,
    };
  }

  private startNextRound(): EngineEvent[] {
    this.round += 1;
    this.turnNumber = 1;
    this.roundTimeRemainingSec = this.roundDurationSec;
    this.waterLevel = INITIAL_WATER_LEVEL;
    this.floodTargetWaterLevel = null;
    this.evoPods = [];
    this.prismWalls = [];
    this.pendingDrafts = [];

    // Keep the persistent carved SDF world & cumulative carveLog intact across all rounds!
    const spawns = this._world.findPersistentRoundSpawnPoints(
      this.critters.length,
      this.waterLevel,
    );
    const centerX = this._world.centerX;
    const centerZ = this._world.centerZ;
    this.fallPeakY.clear();
    for (let i = 0; i < this.critters.length; i++) {
      const c = this.critters[i];
      if (!c) continue;
      const spawn = spawns[i] ?? {
        x: centerX + i,
        y: this.waterLevel + 2.0,
        z: centerZ,
      };
      const stats = computeCritterStats(c.species, c.equipped);
      c.position = { ...spawn };
      c.velocity = { x: 0, y: 0, z: 0 };
      c.alive = true;
      c.maxHp = stats.maxHp;
      c.hp = stats.maxHp;
      c.moveStamina = 100;
      c.maxMoveDistance = this.computeMaxMoveDistance(c.species, c.equipped);
      c.roundShieldRemaining = stats.roundShieldHits;
      // Persistent Build: KEEP loadout & unspent coins; refill all owned abilities free!
      c.gadgetCharges = createRoundLoadoutCharges(c.loadout);
      c.droneNudgeUsedThisTurn = false;
      c.retreatBurrowUsedThisTurn = false;
      c.skyBomberDropUsedThisTurn = false;
      c.grappleUsedThisTurn = false;
      c.pendingEvoDraft = c.evoCharge >= 100;
      this.fallPeakY.set(c.id, spawn.y);
    }

    // Spawn fresh tactical hazards on dry remaining terrain
    this.hazards = Hazards.createRoundHazards(
      this._world,
      this.round,
      spawns,
    ).filter((h) => h.position.y > this.waterLevel + 0.5);
    this.thornTriggeredThisTurn.clear();

    this.rollWind();
    this.activePlayerId = this.selectInitialActiveCritter();
    this.phase = "ACTIVE";
    this.phaseTimeRemainingSec = this.turnDurationSec;

    return [
      {
        type: "PHASE_CHANGED",
        phase: "ACTIVE",
        activePlayerId: this.activePlayerId,
      },
    ];
  }
}
