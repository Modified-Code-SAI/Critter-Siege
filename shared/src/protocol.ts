import {
  GADGET_CATALOG,
  HARDPOINT_SLOTS,
  MUTATION_CATALOG,
  SPECIES_CATALOG,
  THEME_IDS,
} from "./catalog.js";
import type {
  EngineEvent,
  GadgetId,
  GameMode,
  HardpointSlot,
  LobbyState,
  MatchState,
  MutationId,
  SpeciesId,
  TeamId,
  ThemeId,
  Vec3,
} from "./types.js";

/** Messages sent from browser clients to the authoritative room server. */
export type ClientMessage =
  | {
      type: "CREATE_ROOM";
      playerName: string;
      species: SpeciesId;
      theme?: ThemeId;
      mode?: GameMode;
      botCount?: number;
      bonusGadget?: GadgetId | null;
    }
  | {
      type: "JOIN_ROOM";
      roomCode: string;
      playerName: string;
      species: SpeciesId;
      bonusGadget?: GadgetId | null;
    }
  | {
      type: "RECONNECT_ROOM";
      roomCode: string;
      playerId: string;
      reconnectToken: string;
    }
  | {
      type: "LOBBY_CONFIG";
      theme?: ThemeId;
      mode?: GameMode;
      botCount?: number;
      species?: SpeciesId;
      team?: TeamId;
      bonusGadget?: GadgetId | null;
    }
  | {
      type: "START_MATCH";
    }
  | {
      type: "MOVE_STATE";
      position: Vec3;
      velocity: Vec3;
      yaw: number;
    }
  | {
      type: "UTILITY_ACTION";
      gadgetId: GadgetId;
      origin: Vec3;
      direction: Vec3;
      target?: Vec3;
    }
  | {
      type: "FIRE_ACTION";
      gadgetId: GadgetId;
      origin: Vec3;
      direction: Vec3;
      power: number;
      targetPing?: Vec3;
    }
  | {
      type: "RETREAT_BURROW";
      direction: Vec3;
    }
  | {
      type: "DRONE_NUDGE";
      windDelta: Vec3;
    }
  | {
      type: "PICK_MUTATION";
      mutationId: MutationId;
      replaceSlot?: HardpointSlot;
    }
  | {
      type: "REROLL_DRAFT";
    };

/** Messages pushed from the authoritative room server to connected clients. */
export type ServerMessage =
  | {
      type: "ROOM_JOINED";
      roomCode: string;
      playerId: string;
      reconnectToken: string;
      hostId: string;
      lobby: LobbyState;
    }
  | {
      type: "LOBBY_UPDATED";
      lobby: LobbyState;
    }
  | {
      type: "STATE_SNAPSHOT";
      state: MatchState;
    }
  | {
      type: "ENGINE_EVENTS";
      events: EngineEvent[];
    }
  | {
      type: "ERROR";
      code: string;
      message: string;
    };

const THEME_SET = new Set<string>(THEME_IDS);
const SLOT_SET = new Set<string>(HARDPOINT_SLOTS);
const MODE_SET = new Set<string>(["ffa", "2v2"]);
const TEAM_SET = new Set<string>(["A", "B"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseVec3(value: unknown): Vec3 | null {
  if (!isRecord(value)) return null;
  const { x, y, z } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    return null;
  }
  return { x, y, z };
}

function parseNonEmptyString(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}

function parseRoomCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z]{4}$/.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

function parseSpeciesId(value: unknown): SpeciesId | null {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(SPECIES_CATALOG, value)
  ) {
    return null;
  }
  return value as SpeciesId;
}

function parseMutationId(value: unknown): MutationId | null {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(MUTATION_CATALOG, value)
  ) {
    return null;
  }
  return value as MutationId;
}

function parseGadgetId(value: unknown): GadgetId | null {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(GADGET_CATALOG, value)
  ) {
    return null;
  }
  return value as GadgetId;
}

function parseOptionalBonusGadget(
  value: unknown,
): { ok: true; value: GadgetId | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  const parsed = parseGadgetId(value);
  if (!parsed) return { ok: false };
  return { ok: true, value: parsed };
}

function parseThemeId(value: unknown): ThemeId | null {
  if (typeof value !== "string" || !THEME_SET.has(value)) return null;
  return value as ThemeId;
}

function parseGameMode(value: unknown): GameMode | null {
  if (typeof value !== "string" || !MODE_SET.has(value)) return null;
  return value as GameMode;
}

function parseTeamId(value: unknown): TeamId | null {
  if (typeof value !== "string" || !TEAM_SET.has(value)) return null;
  return value as TeamId;
}

function parseHardpointSlot(value: unknown): HardpointSlot | null {
  if (typeof value !== "string" || !SLOT_SET.has(value)) return null;
  return value as HardpointSlot;
}

function parseBotCount(value: unknown): number | null {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) return null;
  if (value < 0 || value > 3) return null;
  return value;
}

function parseCreateRoom(raw: Record<string, unknown>): ClientMessage | null {
  const playerName = parseNonEmptyString(raw.playerName, 24);
  const species = parseSpeciesId(raw.species);
  if (!playerName || !species) return null;

  const msg: Extract<ClientMessage, { type: "CREATE_ROOM" }> = {
    type: "CREATE_ROOM",
    playerName,
    species,
  };

  if (raw.theme !== undefined) {
    const theme = parseThemeId(raw.theme);
    if (!theme) return null;
    msg.theme = theme;
  }
  if (raw.mode !== undefined) {
    const mode = parseGameMode(raw.mode);
    if (!mode) return null;
    msg.mode = mode;
  }
  if (raw.botCount !== undefined) {
    const botCount = parseBotCount(raw.botCount);
    if (botCount === null) return null;
    msg.botCount = botCount;
  }
  const bonus = parseOptionalBonusGadget(raw.bonusGadget);
  if (!bonus.ok) return null;
  if (bonus.value !== undefined) {
    msg.bonusGadget = bonus.value;
  }
  return msg;
}

function parseJoinRoom(raw: Record<string, unknown>): ClientMessage | null {
  const roomCode = parseRoomCode(raw.roomCode);
  const playerName = parseNonEmptyString(raw.playerName, 24);
  const species = parseSpeciesId(raw.species);
  if (!roomCode || !playerName || !species) return null;

  const bonus = parseOptionalBonusGadget(raw.bonusGadget);
  if (!bonus.ok) return null;

  const msg: Extract<ClientMessage, { type: "JOIN_ROOM" }> = {
    type: "JOIN_ROOM",
    roomCode,
    playerName,
    species,
  };
  if (bonus.value !== undefined) {
    msg.bonusGadget = bonus.value;
  }
  return msg;
}

function parseReconnectRoom(
  raw: Record<string, unknown>,
): ClientMessage | null {
  const roomCode = parseRoomCode(raw.roomCode);
  const playerId = parseNonEmptyString(raw.playerId, 64);
  const reconnectToken = parseNonEmptyString(raw.reconnectToken, 128);
  if (!roomCode || !playerId || !reconnectToken) return null;

  return {
    type: "RECONNECT_ROOM",
    roomCode,
    playerId,
    reconnectToken,
  };
}

function parseLobbyConfig(raw: Record<string, unknown>): ClientMessage | null {
  const msg: Extract<ClientMessage, { type: "LOBBY_CONFIG" }> = {
    type: "LOBBY_CONFIG",
  };

  if (raw.theme !== undefined) {
    const theme = parseThemeId(raw.theme);
    if (!theme) return null;
    msg.theme = theme;
  }
  if (raw.mode !== undefined) {
    const mode = parseGameMode(raw.mode);
    if (!mode) return null;
    msg.mode = mode;
  }
  if (raw.botCount !== undefined) {
    const botCount = parseBotCount(raw.botCount);
    if (botCount === null) return null;
    msg.botCount = botCount;
  }
  if (raw.species !== undefined) {
    const species = parseSpeciesId(raw.species);
    if (!species) return null;
    msg.species = species;
  }
  if (raw.team !== undefined) {
    const team = parseTeamId(raw.team);
    if (!team) return null;
    msg.team = team;
  }
  const bonus = parseOptionalBonusGadget(raw.bonusGadget);
  if (!bonus.ok) return null;
  if (bonus.value !== undefined) {
    msg.bonusGadget = bonus.value;
  }
  return msg;
}

function parseMoveState(raw: Record<string, unknown>): ClientMessage | null {
  const position = parseVec3(raw.position);
  const velocity = parseVec3(raw.velocity);
  if (!position || !velocity || !isFiniteNumber(raw.yaw)) return null;
  return {
    type: "MOVE_STATE",
    position,
    velocity,
    yaw: raw.yaw,
  };
}

function parseUtilityAction(
  raw: Record<string, unknown>,
): ClientMessage | null {
  const gadgetId = parseGadgetId(raw.gadgetId);
  const origin = parseVec3(raw.origin);
  const direction = parseVec3(raw.direction);
  if (!gadgetId || !origin || !direction) return null;

  const msg: Extract<ClientMessage, { type: "UTILITY_ACTION" }> = {
    type: "UTILITY_ACTION",
    gadgetId,
    origin,
    direction,
  };
  if (raw.target !== undefined) {
    const target = parseVec3(raw.target);
    if (!target) return null;
    msg.target = target;
  }
  return msg;
}

function parseFireAction(raw: Record<string, unknown>): ClientMessage | null {
  const gadgetId = parseGadgetId(raw.gadgetId);
  const origin = parseVec3(raw.origin);
  const direction = parseVec3(raw.direction);
  if (!gadgetId || !origin || !direction) return null;

  const dirLenSq =
    direction.x * direction.x +
    direction.y * direction.y +
    direction.z * direction.z;
  if (dirLenSq <= 1e-8) return null;

  if (!isFiniteNumber(raw.power) || raw.power < 0 || raw.power > 1) {
    return null;
  }

  const msg: Extract<ClientMessage, { type: "FIRE_ACTION" }> = {
    type: "FIRE_ACTION",
    gadgetId,
    origin,
    direction,
    power: raw.power,
  };

  if (raw.targetPing !== undefined) {
    const targetPing = parseVec3(raw.targetPing);
    if (!targetPing) return null;
    msg.targetPing = targetPing;
  }
  return msg;
}

function parsePickMutation(raw: Record<string, unknown>): ClientMessage | null {
  const mutationId = parseMutationId(raw.mutationId);
  if (!mutationId) return null;

  const msg: Extract<ClientMessage, { type: "PICK_MUTATION" }> = {
    type: "PICK_MUTATION",
    mutationId,
  };

  if (raw.replaceSlot !== undefined) {
    const replaceSlot = parseHardpointSlot(raw.replaceSlot);
    if (!replaceSlot) return null;
    msg.replaceSlot = replaceSlot;
  }
  return msg;
}

/**
 * Strictly validates an untrusted JSON-decoded payload into a typed ClientMessage.
 * Never throws on malformed or non-object inputs; returns `null` when invalid.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return null;
  }

  switch (raw.type) {
    case "CREATE_ROOM":
      return parseCreateRoom(raw);
    case "JOIN_ROOM":
      return parseJoinRoom(raw);
    case "RECONNECT_ROOM":
      return parseReconnectRoom(raw);
    case "LOBBY_CONFIG":
      return parseLobbyConfig(raw);
    case "START_MATCH":
      return { type: "START_MATCH" };
    case "MOVE_STATE":
      return parseMoveState(raw);
    case "UTILITY_ACTION":
      return parseUtilityAction(raw);
    case "FIRE_ACTION":
      return parseFireAction(raw);
    case "RETREAT_BURROW": {
      const direction = parseVec3(raw.direction);
      return direction ? { type: "RETREAT_BURROW", direction } : null;
    }
    case "DRONE_NUDGE": {
      const windDelta = parseVec3(raw.windDelta);
      return windDelta ? { type: "DRONE_NUDGE", windDelta } : null;
    }
    case "PICK_MUTATION":
      return parsePickMutation(raw);
    case "REROLL_DRAFT":
      return { type: "REROLL_DRAFT" };
    default:
      return null;
  }
}
