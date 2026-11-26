import { randomInt, randomUUID } from "node:crypto";
import {
  MatchEngine,
  parseClientMessage,
  planBotTurn,
  type ClientMessage,
  type EngineEvent,
  type GadgetId,
  type GameMode,
  type LobbyPlayer,
  type LobbyState,
  type MapScaleChoice,
  type MatchPlayerSeed,
  type MatchState,
  type ServerMessage,
  type SpeciesId,
  type TeamId,
  type ThemeId,
} from "@critter/shared";

/** Configurable timing options for RoomManager (overridable for fast deterministic tests). */
export interface RoomManagerOptions {
  tickIntervalMs?: number;
  disconnectGraceMs?: number;
  botThinkDelayMs?: number;
}

/** Minimal WebSocket-compatible interface for decoupling room logic from concrete socket implementations. */
export interface ClientSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
}

const WS_READY_OPEN = 1;
const DEFAULT_TICK_INTERVAL_MS = 100;
const DEFAULT_DISCONNECT_GRACE_MS = 15_000;
const DEFAULT_BOT_THINK_DELAY_MS = 600;
const MAX_ROOM_PLAYERS = 4;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

const BOT_SPECIES_CYCLE: readonly SpeciesId[] = [
  "mole",
  "norway_rat",
  "badger",
  "glider_squirrel",
];

const BOT_NAMES: readonly string[] = [
  "Bot Mole",
  "Bot Rat",
  "Bot Badger",
  "Bot Squirrel",
];

interface HumanSeat {
  id: string;
  name: string;
  species: SpeciesId;
  team: TeamId;
  bonusGadget: GadgetId | null;
  reconnectToken: string;
  socket: ClientSocketLike | null;
  connected: boolean;
}

interface RoomRecord {
  roomCode: string;
  hostId: string;
  theme: ThemeId;
  mode: GameMode;
  botCount: number;
  mapScale?: MapScaleChoice;
  started: boolean;
  nextHumanSeq: number;
  humans: HumanSeat[];
  engine: MatchEngine | null;
  tickTimer: ReturnType<typeof setInterval> | null;
  lastTickMs: number;
  activeTurnAutomationKey: string | null;
  activeTurnTimer: ReturnType<typeof setTimeout> | null;
  draftTimers: Map<string, ReturnType<typeof setTimeout>>;
}

interface SocketBinding {
  roomCode: string;
  playerId: string;
}

/**
 * Authoritative 4-letter room manager for Critter Siege multiplayer lobbies.
 * Validates client messages, drives MatchEngine ticks, runs AI bots and
 * disconnect grace fallbacks, and replays full carveLog state on reconnect.
 */
export class RoomManager {
  private readonly tickIntervalMs: number;
  private readonly disconnectGraceMs: number;
  private readonly botThinkDelayMs: number;
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly socketBindings = new Map<ClientSocketLike, SocketBinding>();
  private disposed = false;

  public constructor(options?: RoomManagerOptions) {
    this.tickIntervalMs = Math.max(
      10,
      options?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
    );
    this.disconnectGraceMs = Math.max(
      10,
      options?.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS,
    );
    this.botThinkDelayMs = Math.max(
      10,
      options?.botThinkDelayMs ?? DEFAULT_BOT_THINK_DELAY_MS,
    );
  }

  /** Parse and dispatch a raw JSON payload received from a client socket. */
  public handleMessage(socket: ClientSocketLike, raw: string): void {
    if (this.disposed) {
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.sendError(socket, "INVALID_JSON", "Payload must be valid JSON.");
      return;
    }

    const msg = parseClientMessage(decoded);
    if (!msg) {
      this.sendError(
        socket,
        "INVALID_MESSAGE",
        "Message failed protocol validation.",
      );
      return;
    }

    switch (msg.type) {
      case "CREATE_ROOM":
        this.handleCreateRoom(socket, msg);
        return;
      case "JOIN_ROOM":
        this.handleJoinRoom(socket, msg);
        return;
      case "RECONNECT_ROOM":
        this.handleReconnectRoom(socket, msg);
        return;
      case "LOBBY_CONFIG":
        this.handleLobbyConfig(socket, msg);
        return;
      case "START_MATCH":
        this.handleStartMatch(socket);
        return;
      case "MOVE_STATE":
        this.handleMoveState(socket, msg);
        return;
      case "UTILITY_ACTION":
        this.handleUtilityAction(socket, msg);
        return;
      case "FIRE_ACTION":
        this.handleFireAction(socket, msg);
        return;
      case "RETREAT_BURROW":
        this.handleRetreatBurrow(socket, msg);
        return;
      case "DRONE_NUDGE":
        this.handleDroneNudge(socket, msg);
        return;
      case "PICK_MUTATION":
        this.handlePickMutation(socket, msg);
        return;
      case "REROLL_DRAFT":
        this.handleRerollDraft(socket);
        return;
    }
  }

  /**
   * Handle a dropped client socket while preserving the player's seat and reconnectToken.
   * If the match is running, arms disconnect grace fallback timers so the match never stalls.
   */
  public handleDisconnect(socket: ClientSocketLike): void {
    const binding = this.socketBindings.get(socket);
    if (!binding) {
      return;
    }
    this.socketBindings.delete(socket);

    const room = this.rooms.get(binding.roomCode);
    if (!room) {
      return;
    }

    const seat = room.humans.find((h) => h.id === binding.playerId);
    if (!seat || seat.socket !== socket) {
      return;
    }

    seat.socket = null;
    seat.connected = false;

    if (room.started && room.engine) {
      this.broadcastSnapshot(room);
      this.syncAutomation(room);
    } else {
      this.broadcastLobby(room);
    }
  }

  /** Clear all active room intervals and timers cleanly so Node/Vitest can exit immediately. */
  public dispose(): void {
    this.disposed = true;
    for (const room of this.rooms.values()) {
      this.clearRoomTimers(room);
    }
    this.rooms.clear();
    this.socketBindings.clear();
  }

  private handleCreateRoom(
    socket: ClientSocketLike,
    msg: Extract<ClientMessage, { type: "CREATE_ROOM" }>,
  ): void {
    if (this.socketBindings.has(socket)) {
      this.sendError(socket, "ALREADY_IN_ROOM", "Socket is already in a room.");
      return;
    }

    const roomCode = this.generateUniqueRoomCode();
    const hostId = "p1";
    const reconnectToken = randomUUID();
    const hostSeat: HumanSeat = {
      id: hostId,
      name: msg.playerName,
      species: msg.species,
      team: "A",
      bonusGadget: msg.bonusGadget ?? null,
      reconnectToken,
      socket,
      connected: true,
    };

    const room: RoomRecord = {
      roomCode,
      hostId,
      theme: msg.theme ?? "emerald_spire",
      mode: msg.mode ?? "ffa",
      botCount: Math.max(0, Math.min(MAX_ROOM_PLAYERS - 1, msg.botCount ?? 0)),
      mapScale: msg.mapScale ?? "auto",
      started: false,
      nextHumanSeq: 2,
      humans: [hostSeat],
      engine: null,
      tickTimer: null,
      lastTickMs: Date.now(),
      activeTurnAutomationKey: null,
      activeTurnTimer: null,
      draftTimers: new Map(),
    };

    this.rooms.set(roomCode, room);
    this.socketBindings.set(socket, { roomCode, playerId: hostId });

    const lobby = this.buildLobbyState(room);
    this.sendMessage(socket, {
      type: "ROOM_JOINED",
      roomCode,
      playerId: hostId,
      reconnectToken,
      hostId,
      lobby,
    });
    this.sendMessage(socket, {
      type: "LOBBY_UPDATED",
      lobby,
    });
  }

  private handleJoinRoom(
    socket: ClientSocketLike,
    msg: Extract<ClientMessage, { type: "JOIN_ROOM" }>,
  ): void {
    if (this.socketBindings.has(socket)) {
      this.sendError(socket, "ALREADY_IN_ROOM", "Socket is already in a room.");
      return;
    }

    const room = this.rooms.get(msg.roomCode);
    if (!room) {
      this.sendError(socket, "ROOM_NOT_FOUND", `Room ${msg.roomCode} not found.`);
      return;
    }
    if (room.started) {
      this.sendError(
        socket,
        "MATCH_ALREADY_STARTED",
        "Cannot join a match that has already started.",
      );
      return;
    }
    if (room.humans.length >= MAX_ROOM_PLAYERS) {
      this.sendError(socket, "ROOM_FULL", "Room is full (max 4 human players).");
      return;
    }

    const playerId = `p${room.nextHumanSeq}`;
    room.nextHumanSeq += 1;
    const reconnectToken = randomUUID();
    const teamA = room.humans.filter((h) => h.team === "A").length;
    const teamB = room.humans.filter((h) => h.team === "B").length;

    const seat: HumanSeat = {
      id: playerId,
      name: msg.playerName,
      species: msg.species,
      team: teamA <= teamB ? "A" : "B",
      bonusGadget: msg.bonusGadget ?? null,
      reconnectToken,
      socket,
      connected: true,
    };
    room.humans.push(seat);
    room.botCount = Math.min(
      room.botCount,
      Math.max(0, MAX_ROOM_PLAYERS - room.humans.length),
    );
    this.socketBindings.set(socket, { roomCode: room.roomCode, playerId });

    const lobby = this.buildLobbyState(room);
    this.sendMessage(socket, {
      type: "ROOM_JOINED",
      roomCode: room.roomCode,
      playerId,
      reconnectToken,
      hostId: room.hostId,
      lobby,
    });
    this.broadcastLobby(room);
  }

  private handleReconnectRoom(
    socket: ClientSocketLike,
    msg: Extract<ClientMessage, { type: "RECONNECT_ROOM" }>,
  ): void {
    if (this.socketBindings.has(socket)) {
      this.sendError(
        socket,
        "ALREADY_IN_ROOM",
        "Socket is already bound to a room seat.",
      );
      return;
    }

    const room = this.rooms.get(msg.roomCode);
    if (!room) {
      this.sendError(socket, "ROOM_NOT_FOUND", `Room ${msg.roomCode} not found.`);
      return;
    }

    const seat = room.humans.find(
      (h) => h.id === msg.playerId && h.reconnectToken === msg.reconnectToken,
    );
    if (!seat) {
      this.sendError(
        socket,
        "INVALID_RECONNECT_TOKEN",
        "Reconnect token does not match any player in this room.",
      );
      return;
    }

    if (seat.socket && seat.socket !== socket) {
      this.socketBindings.delete(seat.socket);
    }

    seat.socket = socket;
    seat.connected = true;
    this.socketBindings.set(socket, {
      roomCode: room.roomCode,
      playerId: seat.id,
    });

    const draftTimer = room.draftTimers.get(seat.id);
    if (draftTimer) {
      clearTimeout(draftTimer);
      room.draftTimers.delete(seat.id);
    }

    const lobby = this.buildLobbyState(room);
    this.sendMessage(socket, {
      type: "ROOM_JOINED",
      roomCode: room.roomCode,
      playerId: seat.id,
      reconnectToken: seat.reconnectToken,
      hostId: room.hostId,
      lobby,
    });

    if (room.started && room.engine) {
      this.syncAutomation(room);
      const snapshot = this.buildMatchSnapshot(room);
      this.sendMessage(socket, {
        type: "STATE_SNAPSHOT",
        state: snapshot,
      });
      this.broadcastSnapshot(room, socket);
    } else {
      this.broadcastLobby(room);
    }
  }

  private handleLobbyConfig(
    socket: ClientSocketLike,
    msg: Extract<ClientMessage, { type: "LOBBY_CONFIG" }>,
  ): void {
    const context = this.requireRoomSeat(socket);
    if (!context) return;
    const { room, seat } = context;

    if (room.started) {
      this.sendError(
        socket,
        "MATCH_ALREADY_STARTED",
        "Lobby settings cannot be changed after match start.",
      );
      return;
    }

    const touchesHostSettings =
      msg.theme !== undefined ||
      msg.mode !== undefined ||
      msg.botCount !== undefined ||
      msg.mapScale !== undefined;

    if (touchesHostSettings && seat.id !== room.hostId) {
      this.sendError(
        socket,
        "NOT_HOST",
        "Only the room host can update mode, theme, bot count, or map scale.",
      );
      return;
    }

    if (msg.theme !== undefined) {
      room.theme = msg.theme;
    }
    if (msg.mode !== undefined) {
      room.mode = msg.mode;
    }
    if (msg.botCount !== undefined) {
      const maxBots = Math.max(0, MAX_ROOM_PLAYERS - room.humans.length);
      room.botCount = Math.max(0, Math.min(maxBots, msg.botCount));
    }
    if (msg.mapScale !== undefined) {
      room.mapScale = msg.mapScale;
    }
    if (msg.species !== undefined) {
      seat.species = msg.species;
    }
    if (msg.team !== undefined) {
      seat.team = msg.team;
    }
    if (msg.bonusGadget !== undefined) {
      seat.bonusGadget = msg.bonusGadget;
    }

    this.broadcastLobby(room);
  }

  private handleStartMatch(socket: ClientSocketLike): void {
    const context = this.requireRoomSeat(socket);
    if (!context) return;
    const { room, seat } = context;

    if (seat.id !== room.hostId) {
      this.sendError(socket, "NOT_HOST", "Only the room host can start the match.");
      return;
    }
    if (room.started) {
      this.sendError(socket, "MATCH_ALREADY_STARTED", "Match has already started.");
      return;
    }

    const totalCritters = room.humans.length + room.botCount;
    if (totalCritters < 2) {
      this.sendError(
        socket,
        "NOT_ENOUGH_PLAYERS",
        "At least 2 critters (humans + bots) are required to start a match.",
      );
      return;
    }

    const players = this.buildMatchPlayers(room);
    const seed = randomInt(1, 0x7fffffff);
    const resolvedMapScale =
      room.mapScale === "duel" || room.mapScale === "grand"
        ? room.mapScale
        : totalCritters >= 3
          ? "grand"
          : "duel";

    room.engine = new MatchEngine({
      roomCode: room.roomCode,
      seed,
      theme: room.theme,
      mode: room.mode,
      mapScale: resolvedMapScale,
      players,
    });
    room.started = true;
    room.lastTickMs = Date.now();

    this.broadcastSnapshot(room);
    this.startRoomTickLoop(room);
    this.syncAutomation(room);
  }

  private handleMoveState(
    socket: ClientSocketLike,
    msg: Extract<ClientMessage, { type: "MOVE_STATE" }>,
  ): void {
    const context = this.requireActiveEngineSeat(socket);
    if (!context) return;
    const { room, seat, engine } = context;
    const snap = engine.getSnapshot();

    if (
      snap.activePlayerId !== seat.id ||
      (snap.phase !== "ACTIVE" && snap.phase !== "RETREAT")
    ) {
      this.sendError(
        socket,
        "NOT_YOUR_TURN",
        "Only the active critter can move during ACTIVE or RETREAT phases.",
      );
      return;
    }

    const events = engine.applyMove(seat.id, msg.position, msg.yaw, 0);
    this.publishEngineUpdate(room, events);
  }

  private handleUtilityAction(
    socket: ClientSocketLike,
    msg: Extract<ClientMessage, { type: "UTILITY_ACTION" }>,
  ): void {
    const context = this.requireActiveEngineSeat(socket);
    if (!context) return;
    const { room, seat, engine } = context;
    const snap = engine.getSnapshot();

    if (snap.activePlayerId !== seat.id || snap.phase !== "ACTIVE") {
      this.sendError(
        socket,
        "NOT_YOUR_TURN",
        "Only the active critter can use utility gadgets during ACTIVE phase.",
      );
      return;
    }

    if (msg.gadgetId !== "vine_grapple" && msg.gadgetId !== "prism_wall") {
      this.sendError(
        socket,
        "INVALID_UTILITY",
        `Gadget ${msg.gadgetId} is not a utility action.`,
      );
      return;
    }

    const events = engine.applyUtility(seat.id, {
      gadgetId: msg.gadgetId,
      direction: msg.direction,
      ...(msg.target ? { target: msg.target } : {}),
    });
    this.publishEngineUpdate(room, events);
  }

  private handleFireAction(
    socket: ClientSocketLike,
    msg: Extract<ClientMessage, { type: "FIRE_ACTION" }>,
  ): void {
    const context = this.requireActiveEngineSeat(socket);
    if (!context) return;
    const { room, seat, engine } = context;
    const snap = engine.getSnapshot();

    if (snap.activePlayerId !== seat.id || snap.phase !== "ACTIVE") {
      this.sendError(
        socket,
        "NOT_YOUR_TURN",
        "Only the active critter can fire during ACTIVE phase.",
      );
      return;
    }

    const events = engine.applyFire(seat.id, {
      gadgetId: msg.gadgetId,
      direction: msg.direction,
      power: msg.power,
      ...(msg.targetPing ? { droneTarget: msg.targetPing } : {}),
    });

    if (events.length === 0) {
      this.sendError(
        socket,
        "INVALID_FIRE_ACTION",
        "Shot could not be fired (insufficient charges or invalid gadget).",
      );
      return;
    }

    this.publishEngineUpdate(room, events);
  }

  private handleRetreatBurrow(
    socket: ClientSocketLike,
    msg: Extract<ClientMessage, { type: "RETREAT_BURROW" }>,
  ): void {
    const context = this.requireActiveEngineSeat(socket);
    if (!context) return;
    const { room, seat, engine } = context;
    const snap = engine.getSnapshot();

    if (snap.activePlayerId !== seat.id || snap.phase !== "RETREAT") {
      this.sendError(
        socket,
        "NOT_RETREAT_PHASE",
        "Retreat burrow is only available to the active critter during RETREAT.",
      );
      return;
    }

    const events = engine.applyRetreatBurrow(seat.id, msg.direction);
    if (events.length === 0) {
      this.sendError(
        socket,
        "INVALID_RETREAT_BURROW",
        "Retreat burrow unavailable (requires Burrow Claws and once per turn).",
      );
      return;
    }

    this.publishEngineUpdate(room, events);
  }

  private handleDroneNudge(
    socket: ClientSocketLike,
    msg: Extract<ClientMessage, { type: "DRONE_NUDGE" }>,
  ): void {
    const context = this.requireActiveEngineSeat(socket);
    if (!context) return;
    const { room, seat, engine } = context;

    const events = engine.applyDroneNudge(seat.id, msg.windDelta);
    if (events.length === 0) {
      this.sendError(
        socket,
        "INVALID_DRONE_NUDGE",
        "Drone wind nudge requires a KO'd critter and can only be used once per turn.",
      );
      return;
    }

    this.publishEngineUpdate(room, events);
  }

  private handlePickMutation(
    socket: ClientSocketLike,
    msg: Extract<ClientMessage, { type: "PICK_MUTATION" }>,
  ): void {
    const context = this.requireActiveEngineSeat(socket);
    if (!context) return;
    const { room, seat, engine } = context;
    const snap = engine.getSnapshot();

    if (snap.phase !== "DRAFT_IF_READY" && snap.phase !== "ROUND_DRAFT") {
      this.sendError(
        socket,
        "NOT_DRAFT_PHASE",
        "Mutation picking is only valid during draft phases.",
      );
      return;
    }

    const events = engine.applyMutationPick(
      seat.id,
      msg.mutationId,
      msg.replaceSlot,
    );
    if (events.length === 0) {
      this.sendError(
        socket,
        "INVALID_MUTATION_PICK",
        "Selected mutation is not available in your pending draft.",
      );
      return;
    }

    const timer = room.draftTimers.get(seat.id);
    if (timer) {
      clearTimeout(timer);
      room.draftTimers.delete(seat.id);
    }

    this.publishEngineUpdate(room, events);
  }

  private handleRerollDraft(socket: ClientSocketLike): void {
    const context = this.requireActiveEngineSeat(socket);
    if (!context) return;
    const { room, seat, engine } = context;
    const snap = engine.getSnapshot();

    const pending = snap.pendingDrafts.find((d) => d.playerId === seat.id);
    if (!pending || pending.rerollsRemaining <= 0) {
      this.sendError(
        socket,
        "NO_REROLLS_REMAINING",
        "No draft rerolls remaining for this player.",
      );
      return;
    }

    engine.applyRerollDraft(seat.id);
    this.broadcastSnapshot(room);
  }

  private startRoomTickLoop(room: RoomRecord): void {
    if (room.tickTimer) {
      clearInterval(room.tickTimer);
    }
    room.lastTickMs = Date.now();
    room.tickTimer = setInterval(() => {
      if (this.disposed || !room.engine) {
        return;
      }
      const now = Date.now();
      const dtSec = Math.min(0.25, Math.max(0.001, (now - room.lastTickMs) / 1000));
      room.lastTickMs = now;

      // Pause turn countdown while a disconnected active player's grace timer is armed
      if (
        room.activeTurnTimer !== null &&
        room.activeTurnAutomationKey?.startsWith("grace:")
      ) {
        return;
      }

      const events = room.engine.tick(dtSec);
      if (events.length > 0) {
        this.publishEngineUpdate(room, events);
      }
    }, this.tickIntervalMs);
  }

  private publishEngineUpdate(room: RoomRecord, events: EngineEvent[]): void {
    if (!room.engine) return;
    if (events.length > 0) {
      this.broadcastMessage(room, { type: "ENGINE_EVENTS", events });
    }
    this.broadcastSnapshot(room);

    const snap = room.engine.getSnapshot();
    if (snap.phase === "MATCH_OVER") {
      this.clearRoomTimers(room);
      return;
    }
    this.syncAutomation(room);
  }

  private syncAutomation(room: RoomRecord): void {
    if (this.disposed || !room.engine) {
      return;
    }

    const snap = room.engine.getSnapshot();

    // 1. Handle ACTIVE turn automation for AI bots and disconnected humans
    if (snap.phase === "ACTIVE" && snap.activePlayerId) {
      const activeId = snap.activePlayerId;
      const critter = snap.critters.find((c) => c.id === activeId);
      const seat = room.humans.find((h) => h.id === activeId);
      const turnKey = `${snap.round}:${snap.turnNumber}:${activeId}`;

      if (critter?.isBot) {
        const key = `bot:${turnKey}`;
        if (room.activeTurnAutomationKey !== key) {
          this.clearActiveTurnTimer(room);
          room.activeTurnAutomationKey = key;
          room.activeTurnTimer = setTimeout(() => {
            this.executeBotTurn(room, activeId, false);
          }, this.botThinkDelayMs);
        }
      } else if (seat && !seat.connected) {
        const key = `grace:${turnKey}`;
        if (room.activeTurnAutomationKey !== key) {
          this.clearActiveTurnTimer(room);
          room.activeTurnAutomationKey = key;
          room.activeTurnTimer = setTimeout(() => {
            if (this.disposed || !room.engine) return;
            if (seat.connected) return;
            room.activeTurnTimer = setTimeout(() => {
              this.executeBotTurn(room, activeId, true);
            }, this.botThinkDelayMs);
          }, this.disconnectGraceMs);
        }
      } else {
        this.clearActiveTurnTimer(room);
      }
    } else {
      this.clearActiveTurnTimer(room);
    }

    // 2. Handle DRAFT_IF_READY / ROUND_DRAFT automation for bots & disconnected humans
    if (snap.phase === "DRAFT_IF_READY" || snap.phase === "ROUND_DRAFT") {
      const activeDraftIds = new Set(snap.pendingDrafts.map((d) => d.playerId));
      for (const [playerId, timer] of room.draftTimers.entries()) {
        const seat = room.humans.find((h) => h.id === playerId);
        if (!activeDraftIds.has(playerId) || (seat && seat.connected)) {
          clearTimeout(timer);
          room.draftTimers.delete(playerId);
        }
      }

      for (const draft of snap.pendingDrafts) {
        if (room.draftTimers.has(draft.playerId)) {
          continue;
        }
        const critter = snap.critters.find((c) => c.id === draft.playerId);
        const seat = room.humans.find((h) => h.id === draft.playerId);

        if (critter?.isBot) {
          const timer = setTimeout(() => {
            room.draftTimers.delete(draft.playerId);
            this.executeAutoDraftPick(room, draft.playerId, false);
          }, this.botThinkDelayMs);
          room.draftTimers.set(draft.playerId, timer);
        } else if (seat && !seat.connected) {
          const graceTimer = setTimeout(() => {
            if (this.disposed || !room.engine || seat.connected) {
              room.draftTimers.delete(draft.playerId);
              return;
            }
            const pickTimer = setTimeout(() => {
              room.draftTimers.delete(draft.playerId);
              this.executeAutoDraftPick(room, draft.playerId, true);
            }, this.botThinkDelayMs);
            room.draftTimers.set(draft.playerId, pickTimer);
          }, this.disconnectGraceMs);
          room.draftTimers.set(draft.playerId, graceTimer);
        }
      }
    } else {
      this.clearDraftTimers(room);
    }
  }

  private executeBotTurn(
    room: RoomRecord,
    playerId: string,
    requireDisconnected: boolean,
  ): void {
    if (this.disposed || !room.engine) {
      return;
    }
    room.activeTurnTimer = null;

    if (requireDisconnected) {
      const seat = room.humans.find((h) => h.id === playerId);
      if (!seat || seat.connected) {
        return;
      }
    }

    const snap = room.engine.getSnapshot();
    if (snap.phase !== "ACTIVE" || snap.activePlayerId !== playerId) {
      return;
    }

    const plan = planBotTurn(snap, room.engine.world, playerId);
    const events: EngineEvent[] = [];
    const critter = snap.critters.find((c) => c.id === playerId);

    if (critter) {
      const dist = Math.hypot(
        plan.moveTarget.x - critter.position.x,
        plan.moveTarget.y - critter.position.y,
        plan.moveTarget.z - critter.position.z,
      );
      if (dist > 0.05) {
        const yaw = Math.atan2(plan.direction.x, plan.direction.z);
        events.push(...room.engine.applyMove(playerId, plan.moveTarget, yaw, 0));
      }
    }

    const postMove = room.engine.getSnapshot();
    if (postMove.phase === "ACTIVE" && postMove.activePlayerId === playerId) {
      let fireEvents = room.engine.applyFire(playerId, {
        gadgetId: plan.gadgetId,
        direction: plan.direction,
        power: plan.power,
        ...(plan.droneTarget ? { droneTarget: plan.droneTarget } : {}),
      });
      if (fireEvents.length === 0) {
        fireEvents = room.engine.applyFire(playerId, {
          gadgetId: "gale_mortar",
          direction: { x: 0.5, y: -0.7, z: 0.5 },
          power: 0.4,
        });
      }
      events.push(...fireEvents);
    }

    this.publishEngineUpdate(room, events);
  }

  private executeAutoDraftPick(
    room: RoomRecord,
    playerId: string,
    requireDisconnected: boolean,
  ): void {
    if (this.disposed || !room.engine) {
      return;
    }
    if (requireDisconnected) {
      const seat = room.humans.find((h) => h.id === playerId);
      if (!seat || seat.connected) {
        return;
      }
    }

    const snap = room.engine.getSnapshot();
    if (snap.phase !== "DRAFT_IF_READY" && snap.phase !== "ROUND_DRAFT") {
      return;
    }
    const draft = snap.pendingDrafts.find((d) => d.playerId === playerId);
    const firstOption = draft?.options[0];
    if (!firstOption) {
      return;
    }

    const events = room.engine.applyMutationPick(playerId, firstOption);
    this.publishEngineUpdate(room, events);
  }

  private buildLobbyState(room: RoomRecord): LobbyState {
    const players: LobbyPlayer[] = room.humans.map((h) => ({
      id: h.id,
      name: h.name,
      species: h.species,
      team: h.team,
      isBot: false,
      connected: h.connected,
      bonusGadget: h.bonusGadget,
    }));

    let countA = players.filter((p) => p.team === "A").length;
    let countB = players.filter((p) => p.team === "B").length;

    for (let i = 0; i < room.botCount; i++) {
      const species =
        BOT_SPECIES_CYCLE[i % BOT_SPECIES_CYCLE.length] ?? "mole";
      const name = BOT_NAMES[i % BOT_NAMES.length] ?? `Bot ${i + 1}`;
      const team: TeamId = countA <= countB ? "A" : "B";
      if (team === "A") {
        countA += 1;
      } else {
        countB += 1;
      }
      players.push({
        id: `bot-${i + 1}`,
        name,
        species,
        team,
        isBot: true,
        connected: true,
        bonusGadget: null,
      });
    }

    return {
      roomCode: room.roomCode,
      hostId: room.hostId,
      theme: room.theme,
      mode: room.mode,
      botCount: room.botCount,
      mapScale: room.mapScale ?? "auto",
      started: room.started,
      players,
    };
  }

  private buildMatchPlayers(room: RoomRecord): MatchPlayerSeed[] {
    const lobby = this.buildLobbyState(room);
    return lobby.players.map((p) => ({
      id: p.id,
      name: p.name,
      species: p.species,
      team: p.team,
      isBot: p.isBot,
      bonusGadget: p.bonusGadget ?? null,
    }));
  }

  private buildMatchSnapshot(room: RoomRecord): MatchState {
    if (!room.engine) {
      throw new Error("buildMatchSnapshot called without active engine");
    }
    const snap = room.engine.getSnapshot();
    const connectedById = new Map<string, boolean>();
    for (const h of room.humans) {
      connectedById.set(h.id, h.connected);
    }
    for (const c of snap.critters) {
      const status = connectedById.get(c.id);
      if (status !== undefined) {
        c.connected = status;
      }
    }
    return snap;
  }

  private requireRoomSeat(
    socket: ClientSocketLike,
  ): { room: RoomRecord; seat: HumanSeat } | null {
    const binding = this.socketBindings.get(socket);
    if (!binding) {
      this.sendError(socket, "NOT_IN_ROOM", "Join or create a room first.");
      return null;
    }
    const room = this.rooms.get(binding.roomCode);
    if (!room) {
      this.sendError(socket, "ROOM_NOT_FOUND", "Room no longer exists.");
      return null;
    }
    const seat = room.humans.find((h) => h.id === binding.playerId);
    if (!seat) {
      this.sendError(socket, "SEAT_NOT_FOUND", "Player seat not found in room.");
      return null;
    }
    return { room, seat };
  }

  private requireActiveEngineSeat(
    socket: ClientSocketLike,
  ): { room: RoomRecord; seat: HumanSeat; engine: MatchEngine } | null {
    const base = this.requireRoomSeat(socket);
    if (!base) return null;
    if (!base.room.started || !base.room.engine) {
      this.sendError(
        socket,
        "MATCH_NOT_STARTED",
        "Match has not started yet.",
      );
      return null;
    }
    return { room: base.room, seat: base.seat, engine: base.room.engine };
  }

  private generateUniqueRoomCode(): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = "";
      for (let i = 0; i < 4; i++) {
        const idx = randomInt(0, ROOM_CODE_ALPHABET.length);
        code += ROOM_CODE_ALPHABET.charAt(idx);
      }
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new Error("Unable to allocate unique 4-letter room code.");
  }

  private broadcastLobby(room: RoomRecord): void {
    this.broadcastMessage(room, {
      type: "LOBBY_UPDATED",
      lobby: this.buildLobbyState(room),
    });
  }

  private broadcastSnapshot(
    room: RoomRecord,
    excludeSocket?: ClientSocketLike,
  ): void {
    if (!room.engine) return;
    const msg: ServerMessage = {
      type: "STATE_SNAPSHOT",
      state: this.buildMatchSnapshot(room),
    };
    this.broadcastMessage(room, msg, excludeSocket);
  }

  private broadcastMessage(
    room: RoomRecord,
    msg: ServerMessage,
    excludeSocket?: ClientSocketLike,
  ): void {
    const serialized = JSON.stringify(msg);
    for (const human of room.humans) {
      const sock = human.socket;
      if (
        sock &&
        sock !== excludeSocket &&
        sock.readyState === WS_READY_OPEN
      ) {
        sock.send(serialized);
      }
    }
  }

  private sendMessage(socket: ClientSocketLike, msg: ServerMessage): void {
    if (socket.readyState === WS_READY_OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  private sendError(
    socket: ClientSocketLike,
    code: string,
    message: string,
  ): void {
    this.sendMessage(socket, { type: "ERROR", code, message });
  }

  private clearActiveTurnTimer(room: RoomRecord): void {
    if (room.activeTurnTimer) {
      clearTimeout(room.activeTurnTimer);
      room.activeTurnTimer = null;
    }
    room.activeTurnAutomationKey = null;
  }

  private clearDraftTimers(room: RoomRecord): void {
    for (const timer of room.draftTimers.values()) {
      clearTimeout(timer);
    }
    room.draftTimers.clear();
  }

  private clearRoomTimers(room: RoomRecord): void {
    if (room.tickTimer) {
      clearInterval(room.tickTimer);
      room.tickTimer = null;
    }
    this.clearActiveTurnTimer(room);
    this.clearDraftTimers(room);
  }
}
