/** 3D coordinate or direction vector in world meters. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Playable Critter Siege species identifiers. */
export type SpeciesId =
  | "mole"
  | "norway_rat"
  | "badger"
  | "glider_squirrel"
  | "hedgehog"
  | "armadillo";

/** Physical hardpoint attachment slots on every critter rig. */
export type HardpointSlot = "back" | "legs" | "offense" | "crest";

/** Physical evolution mutations that bolt onto critter hardpoints. */
export type MutationId =
  | "glider_wings"
  | "bramble_shell"
  | "spring_paws"
  | "anchor_talons"
  | "twin_pod"
  | "burrow_claws"
  | "optic_visor"
  | "aegis_crest";

/** Synergy archetypes unlocked when matching hardpoints combine. */
export type ApexId =
  | "sky_bomber"
  | "bastion_tank"
  | "tunnel_sapper"
  | "siege_sniper"
  | "apex_hybrid";

/** Artillery weapons and mobility/utility gadgets. */
export type GadgetId =
  | "gale_mortar"
  | "quake_club"
  | "vine_grapple"
  | "spore_burst"
  | "burrow_bore"
  | "seeker_firefly"
  | "gravity_mine"
  | "prism_wall"
  | "shock_magnet";

/** Sculpted SDF island biome themes. */
export type ThemeId = "emerald_spire" | "canyon_arch" | "twin_pillars";

/** Supported PvP match formats. */
export type GameMode = "ffa" | "2v2";

/** Team assignment identifier (used in 2v2 and lobby setup). */
export type TeamId = "A" | "B";

/** Authoritative state-machine turn phases. */
export type TurnPhase =
  | "LOBBY"
  | "ACTIVE"
  | "RESOLVING"
  | "RETREAT"
  | "DRAFT_IF_READY"
  | "ROUND_DRAFT"
  | "MATCH_OVER";

/** Deterministic terrain subtraction operation applied to the SDF grid. */
export interface CarveOp {
  center: Vec3;
  radius: number;
  shape: "sphere" | "capsule";
  end?: Vec3;
}

/** Static species definition and passive baseline attributes. */
export interface SpeciesDefinition {
  id: SpeciesId;
  name: string;
  description: string;
  starter: boolean;
  unlockCost: number;
  baseHp: number;
  moveSpeed: number;
  jumpImpulse: number;
  carveBonus: number;
  knockbackResist: number;
  grappleReachBonus: number;
  podMagnetRadius: number;
  airControl: number;
  retreatRollBoost: number;
  meleeThorns: number;
}

/** Static hardpoint mutation definition. */
export interface MutationDefinition {
  id: MutationId;
  name: string;
  slot: HardpointSlot;
  description: string;
  mobilityBonus?: number;
  carveBonus?: number;
  maxHpBonus?: number;
  knockbackResistBonus?: number;
  meleeThornsBonus?: number;
  jumpBonus?: number;
  fallDamageResist?: number;
  roundShieldHits?: number;
  enablesGlide?: boolean;
  slopeCling?: boolean;
  bonusMiniDart?: boolean;
  enablesRetreatBurrow?: boolean;
  extendedTrajectory?: boolean;
}

/** Static Apex synergy definition. */
export interface ApexDefinition {
  id: ApexId;
  name: string;
  description: string;
}

/** Static gadget definition covering weapons, utility tools, and bonus unlocks. */
export interface GadgetDefinition {
  id: GadgetId;
  name: string;
  description: string;
  bonusLobbyOnly: boolean;
  unlockCost: number;
  chargesPerRound: number | null;
  turnEnding: boolean;
  windAffected: boolean;
  baseDamage: number;
  carveRadius: number;
  knockback: number;
  subSporeCount?: number;
  tunnelDurationSec?: number;
  requiresDronePing?: boolean;
}

/** Resolved effective stats combining species passives and equipped hardpoints. */
export interface ComputedCritterStats {
  species: SpeciesId;
  maxHp: number;
  moveSpeed: number;
  jumpImpulse: number;
  carveMultiplier: number;
  knockbackResist: number;
  grappleReachBonus: number;
  podMagnetRadius: number;
  airControl: number;
  retreatRollBoost: number;
  meleeThorns: number;
  fallDamageResist: number;
  roundShieldHits: number;
  mobilityBonus: number;
  carveBonusPercent: number;
  enablesGlide: boolean;
  slopeCling: boolean;
  bonusMiniDart: boolean;
  enablesRetreatBurrow: boolean;
  extendedTrajectory: boolean;
  apex: ApexId | null;
}

/** Serializable per-critter runtime state inside a match. */
export interface CritterState {
  id: string;
  name: string;
  species: SpeciesId;
  isBot: boolean;
  team: TeamId | null;
  seatIndex: number;
  connected: boolean;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  evoCharge: number;
  equipped: Partial<Record<HardpointSlot, MutationId>>;
  apex: ApexId | null;
  gadgetCharges: Record<GadgetId, number | null>;
  roundShieldRemaining: number;
  kills: number;
  damageDealt: number;
  podsCollected: number;
  score: number;
  droneNudgeUsedThisTurn: boolean;
  colorIndex: number;
}

/** Parachuting or landed Evolution Pod pickup state. */
export interface EvoPodState {
  id: string;
  position: Vec3;
  collected: boolean;
  spawnedAtTurn: number;
  parachuting: boolean;
}

/** Queued 1-of-3 hardpoint mutation draft prompt for a critter. */
export interface PendingDraftState {
  playerId: string;
  options: MutationId[];
  rerollsRemaining: number;
  requiresSlotSwap: boolean;
}

/** Lobby participant configuration before match start. */
export interface LobbyPlayer {
  id: string;
  name: string;
  species: SpeciesId;
  team: TeamId;
  isBot: boolean;
  connected: boolean;
  bonusGadget?: GadgetId | null;
}

/** Serializable pre-match room lobby state. */
export interface LobbyState {
  roomCode: string;
  hostId: string;
  theme: ThemeId;
  mode: GameMode;
  botCount: number;
  started: boolean;
  players: LobbyPlayer[];
}

/** Player entry supplied when initializing a match. */
export interface MatchPlayerConfig {
  id: string;
  name: string;
  species: SpeciesId;
  team?: TeamId | null;
  isBot?: boolean;
  bonusGadget?: GadgetId | null;
}

/** Configuration required to instantiate an authoritative match. */
export interface MatchConfig {
  matchId?: string;
  seed: number;
  theme: ThemeId;
  mode: GameMode;
  roundCount?: number;
  turnDurationMs?: number;
  retreatDurationMs?: number;
  players: MatchPlayerConfig[];
}

/** Complete authoritative match state snapshot. */
export interface MatchState {
  matchId: string;
  seed: number;
  theme: ThemeId;
  mode: GameMode;
  phase: TurnPhase;
  round: number;
  maxRounds: number;
  turnNumber: number;
  activeCritterId: string | null;
  phaseTimerMs: number;
  waterLevel: number;
  wind: Vec3;
  critters: CritterState[];
  evoPods: EvoPodState[];
  pendingDrafts: PendingDraftState[];
  carveLog: CarveOp[];
  winnerId: string | null;
  winnerTeam: TeamId | null;
  roundWinners: Array<string | TeamId | null>;
}

/** Discrete match engine event emitted for VFX, SFX, and UI updates. */
export type EngineEvent =
  | {
      type: "TURN_STARTED";
      critterId: string;
      turnNumber: number;
      round: number;
      wind: Vec3;
    }
  | {
      type: "PROJECTILE_FIRED";
      critterId: string;
      gadgetId: GadgetId;
      origin: Vec3;
      direction: Vec3;
      power: number;
      path: Vec3[];
      impact: Vec3;
    }
  | {
      type: "CARVE_APPLIED";
      op: CarveOp;
    }
  | {
      type: "CRITTER_DAMAGED";
      critterId: string;
      sourceCritterId: string | null;
      amount: number;
      knockback: Vec3;
      remainingHp: number;
    }
  | {
      type: "CRITTER_KO";
      critterId: string;
      killerId: string | null;
      reason: "damage" | "water" | "self_ko";
    }
  | {
      type: "EVO_POD_SPAWNED";
      pod: EvoPodState;
    }
  | {
      type: "EVO_POD_COLLECTED";
      podId: string;
      critterId: string;
      newCharge: number;
    }
  | {
      type: "DRAFT_STARTED";
      draft: PendingDraftState;
    }
  | {
      type: "MUTATION_EQUIPPED";
      critterId: string;
      mutationId: MutationId;
      slot: HardpointSlot;
      replacedMutationId: MutationId | null;
      apex: ApexId | null;
    }
  | {
      type: "WATER_RISEN";
      waterLevel: number;
      turnNumber: number;
    }
  | {
      type: "WIND_NUDGED";
      critterId: string;
      wind: Vec3;
    }
  | {
      type: "ROUND_ENDED";
      round: number;
      winnerId: string | null;
      winnerTeam: TeamId | null;
    }
  | {
      type: "MATCH_ENDED";
      winnerId: string | null;
      winnerTeam: TeamId | null;
    };
