import {
  MatchEngine,
  MUTATION_CATALOG,
  SDF_DIMS,
  planBotTurn,
  type ClientMessage,
  type EngineEvent,
  type GadgetId,
  type GameMode,
  type HardpointSlot,
  type LobbyState,
  type MatchPlayerSeed,
  type MatchState,
  type MutationId,
  type ServerMessage,
  type SpeciesId,
  type TeamId,
  type ThemeId,
  type Vec3,
} from "@critter/shared";

/** SessionStorage key for automatic WebSocket room reconnect after page refresh. */
export const RECONNECT_STORAGE_KEY = "critter_siege_reconnect_v1";

/** Unified lobby view state consumed by the Critter Siege HUD. */
export interface LobbyViewState {
  mode: "sandbox" | "online";
  roomCode: string | null;
  playerId: string | null;
  hostId: string | null;
  gameMode: GameMode;
  theme: ThemeId;
  botCount: number;
  players: Array<{
    id: string;
    name: string;
    species: SpeciesId;
    team: 0 | 1;
    color: string;
    isBot: boolean;
    connected: boolean;
  }>;
  bonusGadget: GadgetId | null;
  connected: boolean;
  error: string | null;
}

/** Event hooks raised by GameClient for HUD and 3D scene synchronization. */
export interface GameClientCallbacks {
  onLobbyUpdate: (lobby: LobbyViewState) => void;
  onStateSnapshot: (state: MatchState) => void;
  onEngineEvents: (events: EngineEvent[]) => void;
  onError: (msg: string) => void;
}

/** Configuration payload for starting an instant local Play-vs-Bots sandbox match. */
export interface SandboxConfig {
  playerName: string;
  species: SpeciesId;
  color: string;
  gameMode: GameMode;
  theme: ThemeId;
  botCount: number;
  bonusGadget: GadgetId | null;
}

/** Lobby configuration update sent by a room host or participant. */
export interface LobbyConfigUpdate {
  theme?: ThemeId;
  mode?: GameMode;
  botCount?: number;
  species?: SpeciesId;
  team?: 0 | 1 | TeamId;
  bonusGadget?: GadgetId | null;
}

interface StoredReconnectSession {
  roomCode: string;
  playerId: string;
  reconnectToken: string;
}

const SEAT_COLORS: readonly string[] = [
  "#f97316",
  "#38bdf8",
  "#22c55e",
  "#f43f5e",
  "#a855f7",
  "#14b8a6",
];

const BOT_POOL: ReadonlyArray<{ species: SpeciesId; name: string }> = [
  { species: "mole", name: "Digby (Bot)" },
  { species: "norway_rat", name: "Pip (Bot)" },
  { species: "badger", name: "Bramble (Bot)" },
  { species: "glider_squirrel", name: "Zephyr (Bot)" },
  { species: "hedgehog", name: "Thistle (Bot)" },
  { species: "armadillo", name: "Tumble (Bot)" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readReconnectSession(): StoredReconnectSession | null {
  try {
    if (typeof sessionStorage === "undefined") {
      return null;
    }
    const raw = sessionStorage.getItem(RECONNECT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    if (
      typeof parsed.roomCode === "string" &&
      typeof parsed.playerId === "string" &&
      typeof parsed.reconnectToken === "string" &&
      parsed.roomCode.length === 4 &&
      parsed.playerId.length > 0 &&
      parsed.reconnectToken.length > 0
    ) {
      return {
        roomCode: parsed.roomCode.toUpperCase(),
        playerId: parsed.playerId,
        reconnectToken: parsed.reconnectToken,
      };
    }
  } catch {
    // Ignore storage read errors in restricted environments
  }
  return null;
}

function saveReconnectSession(session: StoredReconnectSession): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(RECONNECT_STORAGE_KEY, JSON.stringify(session));
    }
  } catch {
    // Ignore storage write errors
  }
}

function clearReconnectSession(): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(RECONNECT_STORAGE_KEY);
    }
  } catch {
    // Ignore storage delete errors
  }
}

function parseServerMessage(raw: string): ServerMessage | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(decoded) || typeof decoded.type !== "string") {
    return null;
  }
  switch (decoded.type) {
    case "ROOM_JOINED":
    case "LOBBY_UPDATED":
    case "STATE_SNAPSHOT":
    case "ENGINE_EVENTS":
    case "ERROR":
      return decoded as unknown as ServerMessage;
    default:
      return null;
  }
}

function mapLobbyToView(
  lobby: LobbyState,
  playerId: string | null,
  connected: boolean,
  error: string | null,
): LobbyViewState {
  const localPlayer = lobby.players.find((p) => p.id === playerId);
  return {
    mode: "online",
    roomCode: lobby.roomCode,
    playerId,
    hostId: lobby.hostId,
    gameMode: lobby.mode,
    theme: lobby.theme,
    botCount: lobby.botCount,
    players: lobby.players.map((p, idx) => ({
      id: p.id,
      name: p.name,
      species: p.species,
      team: p.team === "B" ? 1 : 0,
      color: SEAT_COLORS[idx % SEAT_COLORS.length] ?? "#f97316",
      isBot: p.isBot,
      connected: p.connected,
    })),
    bonusGadget: localPlayer?.bonusGadget ?? null,
    connected,
    error,
  };
}

/**
 * Unified Critter Siege game transport supporting both zero-latency local
 * Play-vs-Bots sandbox matches and online 4-letter WebSocket multiplayer rooms.
 */
export class GameClient {
  private readonly callbacks: GameClientCallbacks;

  private mode: "sandbox" | "online" | null = null;
  private playerId: string | null = null;
  private lobbyView: LobbyViewState | null = null;
  private lastState: MatchState | null = null;

  // Local Sandbox runtime
  private sandboxEngine: MatchEngine | null = null;
  private sandboxTickTimer: ReturnType<typeof setInterval> | null = null;
  private sandboxLastTickMs = 0;
  private sandboxLastSnapMs = 0;
  private sandboxBotTurnKey: string | null = null;
  private sandboxBotMoveTimer: ReturnType<typeof setTimeout> | null = null;
  private sandboxBotFireTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sandboxBotDraftTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  // Online WebSocket runtime
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private pendingOpenMessages: ClientMessage[] = [];

  public constructor(callbacks: GameClientCallbacks) {
    this.callbacks = callbacks;
  }

  /** Return the local player's seat ID (`p1` in sandbox or assigned server seat ID). */
  public getPlayerId(): string | null {
    return this.playerId;
  }

  /** Return the active session mode (`sandbox`, `online`, or `null` when idle). */
  public getMode(): "sandbox" | "online" | null {
    return this.mode;
  }

  /** Return the most recent authoritative MatchState snapshot. */
  public getLastState(): MatchState | null {
    return this.lastState;
  }

  /** Return the most recent LobbyViewState. */
  public getLobbyState(): LobbyViewState | null {
    return this.lobbyView;
  }

  /**
   * Launch an instant local Play-vs-Bots match using the shared deterministic
   * MatchEngine + planBotTurn AI with zero network requirement.
   */
  public startSandbox(config: SandboxConfig): void {
    this.cleanupSession(false);

    this.mode = "sandbox";
    this.playerId = "p1";

    const clampedBots = Math.max(1, Math.min(3, Math.floor(config.botCount)));
    const safeName = config.playerName.trim().slice(0, 20) || "Critter";

    const botCandidates = [
      ...BOT_POOL.filter((b) => b.species !== config.species),
      ...BOT_POOL.filter((b) => b.species === config.species),
    ];

    const players: MatchPlayerSeed[] = [
      {
        id: "p1",
        name: safeName,
        species: config.species,
        team: config.gameMode === "2v2" ? "A" : null,
        isBot: false,
        color: config.color || "#f97316",
        bonusGadget: config.bonusGadget,
      },
    ];

    for (let i = 0; i < clampedBots; i++) {
      const candidate = botCandidates[i % botCandidates.length] ?? {
        species: "badger" as SpeciesId,
        name: `Bot ${i + 1}`,
      };
      const seatColor =
        SEAT_COLORS.find((c) => c.toLowerCase() !== config.color.toLowerCase() && !players.some((p) => p.color === c)) ??
        SEAT_COLORS[(i + 1) % SEAT_COLORS.length] ??
        "#38bdf8";

      const team: TeamId | null =
        config.gameMode === "2v2" ? (i % 2 === 0 ? "B" : "A") : null;

      players.push({
        id: `bot-${i + 1}`,
        name: candidate.name,
        species: candidate.species,
        team,
        isBot: true,
        color: seatColor,
        bonusGadget: null,
      });
    }

    const seed = Math.floor(Math.random() * 0x7ffffffe) + 1;
    this.sandboxEngine = new MatchEngine({
      roomCode: "BOTS",
      seed,
      theme: config.theme,
      mode: config.gameMode,
      players,
    });

    this.lobbyView = {
      mode: "sandbox",
      roomCode: "BOTS",
      playerId: "p1",
      hostId: "p1",
      gameMode: config.gameMode,
      theme: config.theme,
      botCount: clampedBots,
      players: players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        species: p.species,
        team: p.team === "B" ? 1 : 0,
        color: p.color ?? SEAT_COLORS[idx % SEAT_COLORS.length] ?? "#f97316",
        isBot: Boolean(p.isBot),
        connected: true,
      })),
      bonusGadget: config.bonusGadget,
      connected: true,
      error: null,
    };

    this.callbacks.onLobbyUpdate(this.lobbyView);
    this.emitSandboxSnapshot();

    this.sandboxLastTickMs = Date.now();
    this.sandboxLastSnapMs = this.sandboxLastTickMs;
    this.sandboxTickTimer = setInterval(() => {
      this.tickSandbox();
    }, 60);

    this.syncSandboxBots();
  }

  /** Open a WebSocket connection and create a new 4-letter multiplayer room. */
  public connectAndCreateRoom(
    wsUrl: string,
    playerName: string,
    species: SpeciesId,
    options?: {
      theme?: ThemeId;
      mode?: GameMode;
      botCount?: number;
      bonusGadget?: GadgetId | null;
    },
  ): void {
    const safeName = playerName.trim().slice(0, 20) || "Critter";
    const createMsg: Extract<ClientMessage, { type: "CREATE_ROOM" }> = {
      type: "CREATE_ROOM",
      playerName: safeName,
      species,
      ...(options?.theme !== undefined ? { theme: options.theme } : {}),
      ...(options?.mode !== undefined ? { mode: options.mode } : {}),
      ...(options?.botCount !== undefined
        ? { botCount: Math.max(0, Math.min(3, Math.floor(options.botCount))) }
        : {}),
      ...(options?.bonusGadget !== undefined
        ? { bonusGadget: options.bonusGadget }
        : {}),
    };
    this.openOnlineSocket(wsUrl, createMsg);
  }

  /** Open a WebSocket connection and join an existing 4-letter multiplayer room. */
  public connectAndJoinRoom(
    wsUrl: string,
    roomCode: string,
    playerName: string,
    species: SpeciesId,
    bonusGadget?: GadgetId | null,
  ): void {
    const cleanedCode = roomCode.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(cleanedCode)) {
      this.callbacks.onError("Enter a valid 4-letter room code.");
      return;
    }
    const safeName = playerName.trim().slice(0, 20) || "Critter";
    const joinMsg: Extract<ClientMessage, { type: "JOIN_ROOM" }> = {
      type: "JOIN_ROOM",
      roomCode: cleanedCode,
      playerName: safeName,
      species,
      ...(bonusGadget !== undefined ? { bonusGadget } : {}),
    };
    this.openOnlineSocket(wsUrl, joinMsg);
  }

  /**
   * Attempt automatic room reconnect using credentials persisted in sessionStorage.
   * Returns `true` if a reconnect attempt was initiated.
   */
  public tryAutoReconnect(wsUrl: string): boolean {
    const stored = readReconnectSession();
    if (!stored) {
      return false;
    }
    this.openOnlineSocket(wsUrl, {
      type: "RECONNECT_ROOM",
      roomCode: stored.roomCode,
      playerId: stored.playerId,
      reconnectToken: stored.reconnectToken,
    });
    return true;
  }

  /** Update lobby settings (theme, mode, bot count, species, team, bonus gadget). */
  public sendLobbyConfig(config: LobbyConfigUpdate): void {
    if (this.mode !== "online") {
      return;
    }
    const team: TeamId | undefined =
      config.team === 0 || config.team === "A"
        ? "A"
        : config.team === 1 || config.team === "B"
          ? "B"
          : undefined;

    const msg: Extract<ClientMessage, { type: "LOBBY_CONFIG" }> = {
      type: "LOBBY_CONFIG",
      ...(config.theme !== undefined ? { theme: config.theme } : {}),
      ...(config.mode !== undefined ? { mode: config.mode } : {}),
      ...(config.botCount !== undefined
        ? { botCount: Math.max(0, Math.min(3, Math.floor(config.botCount))) }
        : {}),
      ...(config.species !== undefined ? { species: config.species } : {}),
      ...(team !== undefined ? { team } : {}),
      ...(config.bonusGadget !== undefined
        ? { bonusGadget: config.bonusGadget }
        : {}),
    };
    this.sendWsMessage(msg);
  }

  /** Request the room server to launch the match (host only). */
  public startOnlineMatch(): void {
    if (this.mode !== "online") {
      return;
    }
    this.sendWsMessage({ type: "START_MATCH" });
  }

  /** Sync local active critter position and orientation (~15 Hz during movement). */
  public sendMove(
    pos: Vec3,
    yaw: number,
    pitch: number,
    velocity?: Vec3,
  ): void {
    if (this.mode === "sandbox" && this.sandboxEngine && this.playerId) {
      const events = this.sandboxEngine.applyMove(this.playerId, pos, yaw, pitch);
      this.publishSandboxResult(events, true);
      return;
    }
    if (this.mode === "online") {
      this.sendWsMessage({
        type: "MOVE_STATE",
        position: { x: pos.x, y: pos.y, z: pos.z },
        velocity: velocity
          ? { x: velocity.x, y: velocity.y, z: velocity.z }
          : { x: 0, y: 0, z: 0 },
        yaw,
      });
    }
  }

  /** Trigger a non-turn-ending utility gadget (Vine Grapple or Prism Wall). */
  public sendUtility(gadgetId: GadgetId, dir: Vec3, target?: Vec3): void {
    if (this.mode === "sandbox" && this.sandboxEngine && this.playerId) {
      if (gadgetId !== "vine_grapple" && gadgetId !== "prism_wall") {
        return;
      }
      const events = this.sandboxEngine.applyUtility(this.playerId, {
        gadgetId,
        direction: dir,
        ...(target ? { target } : {}),
      });
      this.publishSandboxResult(events, true);
      return;
    }
    if (this.mode === "online") {
      const origin = this.getLocalAimOrigin();
      this.sendWsMessage({
        type: "UTILITY_ACTION",
        gadgetId,
        origin,
        direction: { x: dir.x, y: dir.y, z: dir.z },
        ...(target ? { target: { x: target.x, y: target.y, z: target.z } } : {}),
      });
    }
  }

  /** Fire a turn-ending artillery or melee gadget. */
  public sendFire(
    gadgetId: GadgetId,
    dir: Vec3,
    power: number,
    droneTarget?: Vec3,
  ): void {
    const safePower = Math.max(0.1, Math.min(1.0, Number.isFinite(power) ? power : 0.5));
    if (this.mode === "sandbox" && this.sandboxEngine && this.playerId) {
      const events = this.sandboxEngine.applyFire(this.playerId, {
        gadgetId,
        direction: dir,
        power: safePower,
        ...(droneTarget ? { droneTarget } : {}),
      });
      this.publishSandboxResult(events, true);
      return;
    }
    if (this.mode === "online") {
      const origin = this.getLocalAimOrigin();
      this.sendWsMessage({
        type: "FIRE_ACTION",
        gadgetId,
        origin,
        direction: { x: dir.x, y: dir.y, z: dir.z },
        power: safePower,
        ...(droneTarget
          ? {
              targetPing: {
                x: droneTarget.x,
                y: droneTarget.y,
                z: droneTarget.z,
              },
            }
          : {}),
      });
    }
  }

  /** Trigger Burrow Claws retreat foxhole carve during RETREAT. */
  public sendRetreatBurrow(dir: Vec3): void {
    if (this.mode === "sandbox" && this.sandboxEngine && this.playerId) {
      const events = this.sandboxEngine.applyRetreatBurrow(this.playerId, dir);
      this.publishSandboxResult(events, true);
      return;
    }
    if (this.mode === "online") {
      this.sendWsMessage({
        type: "RETREAT_BURROW",
        direction: { x: dir.x, y: dir.y, z: dir.z },
      });
    }
  }

  /** Trigger a KO'd Spectator Drone wind nudge. */
  public sendDroneNudge(delta: Vec3): void {
    if (this.mode === "sandbox" && this.sandboxEngine && this.playerId) {
      const events = this.sandboxEngine.applyDroneNudge(this.playerId, delta);
      this.publishSandboxResult(events, true);
      return;
    }
    if (this.mode === "online") {
      this.sendWsMessage({
        type: "DRONE_NUDGE",
        windDelta: { x: delta.x, y: delta.y, z: delta.z },
      });
    }
  }

  /** Confirm a 1-of-3 hardpoint mutation draft pick. */
  public sendPickMutation(
    mutationId: MutationId,
    replaceSlot?: HardpointSlot,
  ): void {
    if (this.mode === "sandbox" && this.sandboxEngine && this.playerId) {
      const events = this.sandboxEngine.applyMutationPick(
        this.playerId,
        mutationId,
        replaceSlot,
      );
      this.publishSandboxResult(events, true);
      return;
    }
    if (this.mode === "online") {
      this.sendWsMessage({
        type: "PICK_MUTATION",
        mutationId,
        ...(replaceSlot !== undefined ? { replaceSlot } : {}),
      });
    }
  }

  /** Spend a trailing-player free comeback reroll during mutation draft. */
  public sendRerollDraft(): void {
    if (this.mode === "sandbox" && this.sandboxEngine && this.playerId) {
      const events = this.sandboxEngine.applyRerollDraft(this.playerId);
      this.publishSandboxResult(events, true);
      return;
    }
    if (this.mode === "online") {
      this.sendWsMessage({ type: "REROLL_DRAFT" });
    }
  }

  /** Cleanly close any active WebSocket or local sandbox timers and clear reconnect state. */
  public disconnect(): void {
    this.cleanupSession(true);
  }

  private getLocalAimOrigin(): Vec3 {
    const localCritter = this.lastState?.critters.find(
      (c) => c.id === this.playerId,
    );
    if (!localCritter) {
      return {
        x: SDF_DIMS.nx * SDF_DIMS.voxelSize * 0.5,
        y: 8,
        z: SDF_DIMS.nz * SDF_DIMS.voxelSize * 0.5,
      };
    }
    return {
      x: localCritter.position.x,
      y: localCritter.position.y + 0.6,
      z: localCritter.position.z,
    };
  }

  private openOnlineSocket(wsUrl: string, initialMsg: ClientMessage): void {
    this.cleanupSession(false);

    this.mode = "online";
    this.pendingOpenMessages = [initialMsg];

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      this.mode = null;
      this.callbacks.onError("Could not open WebSocket connection to room server.");
      return;
    }

    this.ws = socket;
    this.wsConnected = false;

    socket.addEventListener("open", () => {
      if (this.ws !== socket) {
        return;
      }
      this.wsConnected = true;
      const queued = [...this.pendingOpenMessages];
      this.pendingOpenMessages = [];
      for (const msg of queued) {
        this.sendWsMessage(msg);
      }
    });

    socket.addEventListener("message", (event) => {
      if (this.ws !== socket || typeof event.data !== "string") {
        return;
      }
      this.handleServerMessage(event.data);
    });

    socket.addEventListener("error", () => {
      if (this.ws !== socket) {
        return;
      }
      this.callbacks.onError(
        "Unable to reach multiplayer room server. Play vs Bots is always available offline!",
      );
    });

    socket.addEventListener("close", () => {
      if (this.ws !== socket) {
        return;
      }
      this.wsConnected = false;
      this.ws = null;
      if (this.lobbyView) {
        this.lobbyView = { ...this.lobbyView, connected: false };
        this.callbacks.onLobbyUpdate(this.lobbyView);
      }
    });
  }

  private sendWsMessage(msg: ClientMessage): void {
    if (!this.ws) {
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else if (this.ws.readyState === WebSocket.CONNECTING) {
      this.pendingOpenMessages.push(msg);
    }
  }

  private handleServerMessage(raw: string): void {
    const msg = parseServerMessage(raw);
    if (!msg) {
      return;
    }

    switch (msg.type) {
      case "ROOM_JOINED": {
        this.playerId = msg.playerId;
        saveReconnectSession({
          roomCode: msg.roomCode,
          playerId: msg.playerId,
          reconnectToken: msg.reconnectToken,
        });
        this.lobbyView = mapLobbyToView(msg.lobby, this.playerId, true, null);
        this.callbacks.onLobbyUpdate(this.lobbyView);
        return;
      }
      case "LOBBY_UPDATED": {
        this.lobbyView = mapLobbyToView(
          msg.lobby,
          this.playerId,
          this.wsConnected,
          null,
        );
        this.callbacks.onLobbyUpdate(this.lobbyView);
        return;
      }
      case "STATE_SNAPSHOT": {
        this.lastState = msg.state;
        this.callbacks.onStateSnapshot(msg.state);
        return;
      }
      case "ENGINE_EVENTS": {
        if (msg.events.length > 0) {
          this.callbacks.onEngineEvents(msg.events);
        }
        return;
      }
      case "ERROR": {
        if (
          msg.code === "ROOM_NOT_FOUND" ||
          msg.code === "INVALID_RECONNECT_TOKEN"
        ) {
          clearReconnectSession();
        }
        if (this.lobbyView) {
          this.lobbyView = { ...this.lobbyView, error: msg.message };
          this.callbacks.onLobbyUpdate(this.lobbyView);
        }
        this.callbacks.onError(msg.message);
      }
    }
  }

  private tickSandbox(): void {
    if (!this.sandboxEngine) {
      return;
    }
    const now = Date.now();
    const dtSec = Math.min(0.15, Math.max(0.01, (now - this.sandboxLastTickMs) / 1000));
    this.sandboxLastTickMs = now;

    const events = this.sandboxEngine.tick(dtSec);
    const shouldSyncSnap = events.length > 0 || now - this.sandboxLastSnapMs >= 120;
    if (shouldSyncSnap) {
      this.sandboxLastSnapMs = now;
      this.publishSandboxResult(events, true);
    }
  }

  private publishSandboxResult(
    events: EngineEvent[],
    emitSnapshot: boolean,
  ): void {
    if (!this.sandboxEngine) {
      return;
    }
    if (events.length > 0) {
      this.callbacks.onEngineEvents(events);
    }
    if (emitSnapshot) {
      this.emitSandboxSnapshot();
    }
    this.syncSandboxBots();
  }

  private emitSandboxSnapshot(): void {
    if (!this.sandboxEngine) {
      return;
    }
    const snap = this.sandboxEngine.getSnapshot();
    this.lastState = snap;
    this.callbacks.onStateSnapshot(snap);
  }

  private syncSandboxBots(): void {
    if (!this.sandboxEngine) {
      return;
    }
    const snap = this.sandboxEngine.getSnapshot();

    if (snap.phase === "MATCH_OVER") {
      this.clearSandboxBotTimers();
      return;
    }

    // 1. Handle bot mutation drafts automatically
    if (snap.phase === "DRAFT_IF_READY" || snap.phase === "ROUND_DRAFT") {
      const pendingBotIds = new Set<string>();
      for (const draft of snap.pendingDrafts) {
        const critter = snap.critters.find((c) => c.id === draft.playerId);
        if (!critter || !critter.isBot) {
          continue;
        }
        pendingBotIds.add(critter.id);
        if (!this.sandboxBotDraftTimers.has(critter.id)) {
          const botId = critter.id;
          const timer = setTimeout(() => {
            this.sandboxBotDraftTimers.delete(botId);
            this.executeSandboxBotDraft(botId);
          }, 420);
          this.sandboxBotDraftTimers.set(botId, timer);
        }
      }
      for (const [botId, timer] of this.sandboxBotDraftTimers.entries()) {
        if (!pendingBotIds.has(botId)) {
          clearTimeout(timer);
          this.sandboxBotDraftTimers.delete(botId);
        }
      }
    }

    // 2. Handle active bot turn (move -> aim -> fire)
    const active = snap.critters.find((c) => c.id === snap.activePlayerId);
    if (!active || !active.isBot || !active.alive) {
      this.clearSandboxTurnTimers();
      return;
    }

    if (snap.phase === "ACTIVE") {
      const turnKey = `ACTIVE:${snap.round}:${snap.turnNumber}:${active.id}`;
      if (this.sandboxBotTurnKey === turnKey) {
        return;
      }
      this.clearSandboxTurnTimers();
      this.sandboxBotTurnKey = turnKey;

      const botId = active.id;
      this.sandboxBotMoveTimer = setTimeout(() => {
        this.sandboxBotMoveTimer = null;
        this.executeSandboxBotTurn(botId, turnKey);
      }, 650);
      return;
    }

    if (snap.phase === "RETREAT") {
      const retreatKey = `RETREAT:${snap.round}:${snap.turnNumber}:${active.id}`;
      if (this.sandboxBotTurnKey === retreatKey) {
        return;
      }
      this.clearSandboxTurnTimers();
      this.sandboxBotTurnKey = retreatKey;

      const botId = active.id;
      this.sandboxBotMoveTimer = setTimeout(() => {
        this.sandboxBotMoveTimer = null;
        this.executeSandboxBotRetreat(botId);
      }, 600);
    }
  }

  private executeSandboxBotTurn(botId: string, expectedKey: string): void {
    if (!this.sandboxEngine || this.sandboxBotTurnKey !== expectedKey) {
      return;
    }
    const snap = this.sandboxEngine.getSnapshot();
    if (snap.phase !== "ACTIVE" || snap.activePlayerId !== botId) {
      return;
    }

    const plan = planBotTurn(snap, this.sandboxEngine.world, botId);
    const yaw = Math.atan2(plan.direction.x, plan.direction.z);
    const pitch = Math.asin(Math.max(-0.95, Math.min(0.95, plan.direction.y)));

    const moveEvents = this.sandboxEngine.applyMove(
      botId,
      plan.moveTarget,
      yaw,
      pitch,
    );
    this.publishSandboxResult(moveEvents, true);

    this.sandboxBotFireTimer = setTimeout(() => {
      this.sandboxBotFireTimer = null;
      if (!this.sandboxEngine || this.sandboxBotTurnKey !== expectedKey) {
        return;
      }
      const postSnap = this.sandboxEngine.getSnapshot();
      if (postSnap.phase !== "ACTIVE" || postSnap.activePlayerId !== botId) {
        return;
      }
      const fireEvents = this.sandboxEngine.applyFire(botId, {
        gadgetId: plan.gadgetId,
        direction: plan.direction,
        power: plan.power,
        ...(plan.droneTarget ? { droneTarget: plan.droneTarget } : {}),
      });
      this.publishSandboxResult(fireEvents, true);
    }, 450);
  }

  private executeSandboxBotRetreat(botId: string): void {
    if (!this.sandboxEngine) {
      return;
    }
    const snap = this.sandboxEngine.getSnapshot();
    if (snap.phase !== "RETREAT" || snap.activePlayerId !== botId) {
      return;
    }
    const bot = snap.critters.find((c) => c.id === botId);
    if (!bot || !bot.alive) {
      return;
    }

    if (
      bot.equipped.offense === "burrow_claws" &&
      !bot.retreatBurrowUsedThisTurn
    ) {
      const burrowEvents = this.sandboxEngine.applyRetreatBurrow(botId, {
        x: Math.sin(bot.yaw),
        y: -0.25,
        z: Math.cos(bot.yaw),
      });
      this.publishSandboxResult(burrowEvents, true);
      return;
    }

    // Nudge slightly toward island center for safety during retreat
    const centerX = SDF_DIMS.nx * SDF_DIMS.voxelSize * 0.5;
    const centerZ = SDF_DIMS.nz * SDF_DIMS.voxelSize * 0.5;
    const dx = centerX - bot.position.x;
    const dz = centerZ - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.5) {
      const step = Math.min(2.2, dist);
      const nx = bot.position.x + (dx / dist) * step;
      const nz = bot.position.z + (dz / dist) * step;
      const sy = this.sandboxEngine.world.getSurfaceY(nx, nz);
      if (sy !== null && sy > snap.waterLevel + 0.6) {
        const events = this.sandboxEngine.applyMove(
          botId,
          { x: nx, y: sy, z: nz },
          Math.atan2(dx, dz),
          0,
        );
        this.publishSandboxResult(events, true);
      }
    }
  }

  private executeSandboxBotDraft(botId: string): void {
    if (!this.sandboxEngine) {
      return;
    }
    const snap = this.sandboxEngine.getSnapshot();
    const draft = snap.pendingDrafts.find((d) => d.playerId === botId);
    const bot = snap.critters.find((c) => c.id === botId);
    if (!draft || !bot) {
      return;
    }

    // Prefer a mutation filling an empty hardpoint slot first
    let chosen: MutationId | undefined = draft.options.find((opt) => {
      const def = MUTATION_CATALOG[opt];
      return def !== undefined && bot.equipped[def.slot] === undefined;
    });
    if (!chosen) {
      chosen = draft.options[0];
    }
    if (!chosen) {
      return;
    }

    const events = this.sandboxEngine.applyMutationPick(botId, chosen);
    this.publishSandboxResult(events, true);
  }

  private clearSandboxTurnTimers(): void {
    this.sandboxBotTurnKey = null;
    if (this.sandboxBotMoveTimer !== null) {
      clearTimeout(this.sandboxBotMoveTimer);
      this.sandboxBotMoveTimer = null;
    }
    if (this.sandboxBotFireTimer !== null) {
      clearTimeout(this.sandboxBotFireTimer);
      this.sandboxBotFireTimer = null;
    }
  }

  private clearSandboxBotTimers(): void {
    this.clearSandboxTurnTimers();
    for (const timer of this.sandboxBotDraftTimers.values()) {
      clearTimeout(timer);
    }
    this.sandboxBotDraftTimers.clear();
  }

  private cleanupSession(clearReconnect: boolean): void {
    if (this.sandboxTickTimer !== null) {
      clearInterval(this.sandboxTickTimer);
      this.sandboxTickTimer = null;
    }
    this.clearSandboxBotTimers();
    this.sandboxEngine = null;

    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      this.wsConnected = false;
      try {
        oldWs.close();
      } catch {
        // Safe close
      }
    }
    this.pendingOpenMessages = [];

    if (clearReconnect) {
      clearReconnectSession();
    }

    this.mode = null;
    this.playerId = null;
    this.lobbyView = null;
    this.lastState = null;
  }
}
