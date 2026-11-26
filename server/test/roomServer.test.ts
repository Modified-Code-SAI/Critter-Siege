import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ClientMessage, MatchState, ServerMessage } from "@critter/shared";
import { startServer, type RunningServer } from "../src/index.js";

class TestWsClient {
  public readonly ws: WebSocket;
  public readonly messages: ServerMessage[] = [];
  private waiters: Array<{
    predicate: (msg: ServerMessage) => boolean;
    resolve: (msg: ServerMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const parsed = JSON.parse(text) as ServerMessage;
      this.messages.push(parsed);

      const remaining: typeof this.waiters = [];
      for (const waiter of this.waiters) {
        if (waiter.predicate(parsed)) {
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        } else {
          remaining.push(waiter);
        }
      }
      this.waiters = remaining;
    });
  }

  public static connect(port: number): Promise<TestWsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once("open", () => resolve(new TestWsClient(ws)));
      ws.once("error", reject);
    });
  }

  public send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  public sendRaw(payload: string): void {
    this.ws.send(payload);
  }

  public waitFor<T extends ServerMessage>(
    predicate: (msg: ServerMessage) => msg is T,
    timeoutMs?: number,
    fromIndex?: number,
  ): Promise<T>;
  public waitFor(
    predicate: (msg: ServerMessage) => boolean,
    timeoutMs?: number,
    fromIndex?: number,
  ): Promise<ServerMessage>;
  public waitFor(
    predicate: (msg: ServerMessage) => boolean,
    timeoutMs = 15000,
    fromIndex = 0,
  ): Promise<ServerMessage> {
    for (let i = fromIndex; i < this.messages.length; i++) {
      const existing = this.messages[i];
      if (existing && predicate(existing)) {
        return Promise.resolve(existing);
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`Timed out waiting for ServerMessage after ${timeoutMs}ms`));
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  public close(): Promise<void> {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Client closed"));
    }
    this.waiters = [];

    if (
      this.ws.readyState === WebSocket.CLOSED ||
      this.ws.readyState === WebSocket.CLOSING
    ) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

describe("authoritative WebSocket room server", () => {
  let server: RunningServer | null = null;
  const openClients: TestWsClient[] = [];

  async function trackClient(port: number): Promise<TestWsClient> {
    const client = await TestWsClient.connect(port);
    openClients.push(client);
    return client;
  }

  afterEach(async () => {
    while (openClients.length > 0) {
      const c = openClients.pop();
      if (c) {
        await c.close();
      }
    }
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("creates a 4-letter room, joins second player, configures 2 humans + 1 bot, and starts match with matching seed and 3 critters", async () => {
    server = await startServer(0, {
      tickIntervalMs: 40,
      disconnectGraceMs: 150,
      botThinkDelayMs: 60,
    });

    const healthRes = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as { ok: boolean; title: string };
    expect(healthBody).toEqual({ ok: true, title: "Critter Siege" });

    const host = await trackClient(server.port);
    host.send({
      type: "CREATE_ROOM",
      playerName: "HostMole",
      species: "mole",
    });

    const hostJoined = await host.waitFor(
      (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
        m.type === "ROOM_JOINED",
    );
    expect(hostJoined.roomCode).toMatch(/^[A-Z]{4}$/);
    expect(hostJoined.reconnectToken.length).toBeGreaterThan(8);

    const guest = await trackClient(server.port);
    guest.send({
      type: "JOIN_ROOM",
      roomCode: hostJoined.roomCode,
      playerName: "GuestRat",
      species: "norway_rat",
    });

    const guestJoined = await guest.waitFor(
      (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
        m.type === "ROOM_JOINED",
    );
    expect(guestJoined.roomCode).toBe(hostJoined.roomCode);
    expect(guestJoined.playerId).not.toBe(hostJoined.playerId);
    expect(guestJoined.reconnectToken.length).toBeGreaterThan(8);

    const hostLobbyIndex = host.messages.length;
    host.send({
      type: "LOBBY_CONFIG",
      mode: "ffa",
      theme: "canyon_arch",
      botCount: 1,
    });

    const updatedLobby = await host.waitFor(
      (m): m is Extract<ServerMessage, { type: "LOBBY_UPDATED" }> =>
        m.type === "LOBBY_UPDATED" &&
        m.lobby.botCount === 1 &&
        m.lobby.theme === "canyon_arch",
      15000,
      hostLobbyIndex,
    );
    expect(updatedLobby.lobby.players.length).toBe(3);

    host.send({ type: "START_MATCH" });

    const [hostSnap, guestSnap] = await Promise.all([
      host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT",
      ),
      guest.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT",
      ),
    ]);

    expect(hostSnap.state.seed).toBe(guestSnap.state.seed);
    expect(hostSnap.state.theme).toBe("canyon_arch");
    expect(hostSnap.state.mapScale).toBe("grand");
    expect(hostSnap.state.critters).toHaveLength(3);
    expect(guestSnap.state.critters).toHaveLength(3);
    expect(hostSnap.state.critters.filter((c) => c.isBot)).toHaveLength(1);
    expect(updatedLobby.lobby.mapScale).toBe("auto");
  });

  it("supports LOBBY_CONFIG mapScale override ('auto' | 'duel' | 'grand') and restricts changes to room host", async () => {
    server = await startServer(0, {
      tickIntervalMs: 40,
      disconnectGraceMs: 150,
      botThinkDelayMs: 60,
    });

    const host = await trackClient(server.port);
    host.send({
      type: "CREATE_ROOM",
      playerName: "HostMole",
      species: "mole",
    });
    const hostJoined = await host.waitFor(
      (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
        m.type === "ROOM_JOINED",
    );
    expect(hostJoined.lobby.mapScale).toBe("auto");

    const guest = await trackClient(server.port);
    guest.send({
      type: "JOIN_ROOM",
      roomCode: hostJoined.roomCode,
      playerName: "GuestRat",
      species: "norway_rat",
    });
    await guest.waitFor(
      (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
        m.type === "ROOM_JOINED",
    );

    // Guest attempting to change mapScale is rejected with NOT_HOST
    const guestErrIdx = guest.messages.length;
    guest.send({ type: "LOBBY_CONFIG", mapScale: "grand" });
    const notHostErr = await guest.waitFor(
      (m): m is Extract<ServerMessage, { type: "ERROR" }> => m.type === "ERROR",
      15000,
      guestErrIdx,
    );
    expect(notHostErr.code).toBe("NOT_HOST");

    // Host overrides 2-player match to 'grand'
    const lobbyIdx = host.messages.length;
    host.send({ type: "LOBBY_CONFIG", mapScale: "grand" });
    const lobbyUpdated = await host.waitFor(
      (m): m is Extract<ServerMessage, { type: "LOBBY_UPDATED" }> =>
        m.type === "LOBBY_UPDATED" && m.lobby.mapScale === "grand",
      15000,
      lobbyIdx,
    );
    expect(lobbyUpdated.lobby.mapScale).toBe("grand");

    host.send({ type: "START_MATCH" });
    const snap = await host.waitFor(
      (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
        m.type === "STATE_SNAPSHOT",
    );
    expect(snap.state.critters).toHaveLength(2);
    expect(snap.state.mapScale).toBe("grand");
    expect(snap.state.phaseTimeRemainingSec).toBe(35);
  });

  it("rejects FIRE_ACTION from non-active player with ERROR and does not advance the turn", async () => {
    server = await startServer(0, {
      tickIntervalMs: 40,
      disconnectGraceMs: 150,
      botThinkDelayMs: 60,
    });

    const host = await trackClient(server.port);
    host.send({
      type: "CREATE_ROOM",
      playerName: "HostBadger",
      species: "badger",
    });
    const hostJoined = await host.waitFor(
      (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
        m.type === "ROOM_JOINED",
    );

    const guest = await trackClient(server.port);
    guest.send({
      type: "JOIN_ROOM",
      roomCode: hostJoined.roomCode,
      playerName: "GuestSquirrel",
      species: "glider_squirrel",
    });
    const guestJoined = await guest.waitFor(
      (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
        m.type === "ROOM_JOINED",
    );

    host.send({ type: "START_MATCH" });
    const startSnap = await host.waitFor(
      (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
        m.type === "STATE_SNAPSHOT",
    );

    const inactiveClient =
      startSnap.state.activePlayerId === hostJoined.playerId ? guest : host;
    const inactiveId =
      startSnap.state.activePlayerId === hostJoined.playerId
        ? guestJoined.playerId
        : hostJoined.playerId;

    // Also verify malformed JSON returns ERROR without crashing
    inactiveClient.sendRaw("{not valid json");
    const parseErr = await inactiveClient.waitFor(
      (m): m is Extract<ServerMessage, { type: "ERROR" }> => m.type === "ERROR",
    );
    expect(parseErr.code).toBeTruthy();

    const errStartIdx = inactiveClient.messages.length;
    inactiveClient.send({
      type: "FIRE_ACTION",
      gadgetId: "gale_mortar",
      origin: { x: 30, y: 10, z: 30 },
      direction: { x: 1, y: 0.2, z: 0 },
      power: 0.5,
    });

    const fireErr = await inactiveClient.waitFor(
      (m): m is Extract<ServerMessage, { type: "ERROR" }> => m.type === "ERROR",
      15000,
      errStartIdx,
    );
    expect(fireErr.code).toBeTruthy();

    // Ensure turn did NOT advance and inactive player is still not active
    const latestHostSnap = [...host.messages]
      .reverse()
      .find(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT",
      );
    expect(latestHostSnap?.state.turnNumber).toBe(startSnap.state.turnNumber);
    expect(latestHostSnap?.state.phase).toBe("ACTIVE");
    expect(latestHostSnap?.state.activePlayerId).not.toBe(inactiveId);
  });

  it(
    "executes bot fallback turn after disconnect grace and replays exact carveLog on RECONNECT_ROOM (Review Focus #5)",
    async () => {
      server = await startServer(0, {
        tickIntervalMs: 40,
        disconnectGraceMs: 150,
        botThinkDelayMs: 60,
      });

      const host = await trackClient(server.port);
      host.send({
        type: "CREATE_ROOM",
        playerName: "AlphaMole",
        species: "mole",
      });
      const hostJoined = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
          m.type === "ROOM_JOINED",
      );

      const guest = await trackClient(server.port);
      guest.send({
        type: "JOIN_ROOM",
        roomCode: hostJoined.roomCode,
        playerName: "BetaBadger",
        species: "badger",
      });
      const guestJoined = await guest.waitFor(
        (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
          m.type === "ROOM_JOINED",
      );

      host.send({ type: "START_MATCH" });
      const initialSnap = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT",
      );
      expect(initialSnap.state.activePlayerId).toBe(hostJoined.playerId);

      // Active Player 1 fires gale_mortar straight down at their own solid spawn ledge
      // (deals <=34 dmg so mole stays alive with >=81 HP and always carves terrain on any seed)
      const p1 = initialSnap.state.critters.find(
        (c) => c.id === hostJoined.playerId,
      );
      expect(p1).toBeDefined();

      const afterFireIdx = host.messages.length;
      host.send({
        type: "FIRE_ACTION",
        gadgetId: "gale_mortar",
        origin: p1?.position ?? { x: 30, y: 10, z: 30 },
        direction: { x: 0, y: -1, z: 0 },
        power: 0.15,
      });

      const resolvingSnap = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT" &&
          m.state.phase === "RESOLVING" &&
          m.state.carveLog.length >= 1,
        15000,
        afterFireIdx,
      );
      expect(resolvingSnap.state.carveLog.length).toBeGreaterThanOrEqual(1);

      // Wait for Player 1's turn to complete and Player 2 to become active
      const p2TurnSnap = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT" &&
          m.state.phase === "ACTIVE" &&
          m.state.activePlayerId === guestJoined.playerId,
        20000,
        afterFireIdx,
      );
      const carveCountBeforeDrop = p2TurnSnap.state.carveLog.length;
      expect(carveCountBeforeDrop).toBeGreaterThanOrEqual(1);

      // Disconnect the currently active player (Player 2) without forfeiting
      const beforeDropIdx = host.messages.length;
      await guest.close();

      // Wait for disconnectGraceMs (150ms) + botThinkDelayMs (60ms) -> bot fallback fires!
      const fallbackSnap = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT" &&
          (m.state.phase === "RESOLVING" ||
            m.state.turnNumber > p2TurnSnap.state.turnNumber),
        15000,
        beforeDropIdx,
      );
      expect(
        fallbackSnap.state.phase === "RESOLVING" ||
          fallbackSnap.state.turnNumber > p2TurnSnap.state.turnNumber,
      ).toBe(true);

      // Reconnect dropped Player 2 with saved roomCode + playerId + reconnectToken
      const reconnectedGuest = await trackClient(server.port);
      reconnectedGuest.send({
        type: "RECONNECT_ROOM",
        roomCode: hostJoined.roomCode,
        playerId: guestJoined.playerId,
        reconnectToken: guestJoined.reconnectToken,
      });

      const reconJoined = await reconnectedGuest.waitFor(
        (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
          m.type === "ROOM_JOINED",
      );
      expect(reconJoined.roomCode).toBe(hostJoined.roomCode);
      expect(reconJoined.playerId).toBe(guestJoined.playerId);

      const reconSnap = await reconnectedGuest.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT",
      );

      // Compare against latest live room state received by host
      const liveHostState: MatchState | undefined = [...host.messages]
        .reverse()
        .find(
          (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
            m.type === "STATE_SNAPSHOT",
        )?.state;

      expect(liveHostState).toBeDefined();
      expect(reconSnap.state.seed).toBe(liveHostState?.seed);
      const restoredP2 = reconSnap.state.critters.find(
        (c) => c.id === guestJoined.playerId,
      );
      expect(restoredP2?.connected).toBe(true);
      expect(reconSnap.state.carveLog.length).toBeGreaterThanOrEqual(1);
      expect(reconSnap.state.carveLog).toEqual(liveHostState?.carveLog);
    },
    30000,
  );
});
