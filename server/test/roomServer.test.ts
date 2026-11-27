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

  it("propagates startingLoadout via CREATE_ROOM/JOIN_ROOM/LOBBY_CONFIG and enforces authoritative BUY_ABILITY (valid rival-turn buy + rejected overspend)", async () => {
    server = await startServer(0, {
      tickIntervalMs: 40,
      disconnectGraceMs: 5000,
      botThinkDelayMs: 60,
    });

    const host = await trackClient(server.port);
    host.send({
      type: "CREATE_ROOM",
      playerName: "HostAlch",
      species: "mole",
      startingLoadout: ["gale_mortar", "mend_brew", "vine_grapple"],
    });
    const hostJoined = await host.waitFor(
      (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
        m.type === "ROOM_JOINED",
    );
    expect(
      hostJoined.lobby.players.find((p) => p.id === hostJoined.playerId)
        ?.startingLoadout,
    ).toEqual(["gale_mortar", "mend_brew", "vine_grapple"]);

    const guest = await trackClient(server.port);
    guest.send({
      type: "JOIN_ROOM",
      roomCode: hostJoined.roomCode,
      playerName: "GuestShop",
      species: "norway_rat",
      startingLoadout: ["gale_mortar", "quake_club"],
    });
    const guestJoined = await guest.waitFor(
      (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
        m.type === "ROOM_JOINED",
    );
    expect(
      guestJoined.lobby.players.find((p) => p.id === guestJoined.playerId)
        ?.startingLoadout,
    ).toEqual(["gale_mortar", "quake_club"]);

    // Guest updates own startingLoadout via LOBBY_CONFIG before match start
    const guestLobbyIdx = host.messages.length;
    guest.send({
      type: "LOBBY_CONFIG",
      startingLoadout: ["gale_mortar", "quake_club", "vine_grapple"],
    });
    const updatedLobby = await host.waitFor(
      (m): m is Extract<ServerMessage, { type: "LOBBY_UPDATED" }> =>
        m.type === "LOBBY_UPDATED" &&
        (m.lobby.players.find((p) => p.id === guestJoined.playerId)
          ?.startingLoadout?.length ?? 0) === 3,
      15000,
      guestLobbyIdx,
    );
    expect(
      updatedLobby.lobby.players.find((p) => p.id === guestJoined.playerId)
        ?.startingLoadout,
    ).toEqual(["gale_mortar", "quake_club", "vine_grapple"]);

    host.send({ type: "START_MATCH" });
    const startSnap = await host.waitFor(
      (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
        m.type === "STATE_SNAPSHOT",
    );
    const hostCritter = startSnap.state.critters.find(
      (c) => c.id === hostJoined.playerId,
    );
    const guestCritter = startSnap.state.critters.find(
      (c) => c.id === guestJoined.playerId,
    );
    expect(hostCritter?.loadout).toEqual([
      "gale_mortar",
      "mend_brew",
      "vine_grapple",
    ]);
    expect(hostCritter?.coins).toBe(30); // 100 - 40 - 30
    expect(guestCritter?.loadout).toEqual([
      "gale_mortar",
      "quake_club",
      "vine_grapple",
    ]);
    expect(guestCritter?.coins).toBe(45); // 100 - 25 - 30
    expect(startSnap.state.activePlayerId).toBe(hostJoined.playerId);

    // Valid Anytime Armory BUY_ABILITY by non-active guest during host's turn
    const buyEventIdx = guest.messages.length;
    guest.send({
      type: "BUY_ABILITY",
      gadgetId: "mend_brew",
    });
    const buyEvMsg = await guest.waitFor(
      (m): m is Extract<ServerMessage, { type: "ENGINE_EVENTS" }> =>
        m.type === "ENGINE_EVENTS" &&
        m.events.some(
          (e) =>
            e.type === "ABILITY_PURCHASED" &&
            e.playerId === guestJoined.playerId &&
            e.gadgetId === "mend_brew",
        ),
      15000,
      buyEventIdx,
    );
    expect(
      buyEvMsg.events.some(
        (e) =>
          e.type === "ABILITY_PURCHASED" && e.cost === 40 && e.newBalance === 5,
      ),
    ).toBe(true);

    const postBuySnap = await guest.waitFor(
      (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
        m.type === "STATE_SNAPSHOT" &&
        (m.state.critters
          .find((c) => c.id === guestJoined.playerId)
          ?.loadout.includes("mend_brew") ??
          false),
      15000,
      buyEventIdx,
    );
    const guestAfterBuy = postBuySnap.state.critters.find(
      (c) => c.id === guestJoined.playerId,
    );
    expect(guestAfterBuy?.coins).toBe(5);
    expect(guestAfterBuy?.gadgetCharges.mend_brew).toBe(2);

    // Rejected overspend BUY_ABILITY (seeker_firefly costs 70 > 5 coins remaining)
    const errIdx = guest.messages.length;
    guest.send({
      type: "BUY_ABILITY",
      gadgetId: "seeker_firefly",
    });
    const buyErr = await guest.waitFor(
      (m): m is Extract<ServerMessage, { type: "ERROR" }> => m.type === "ERROR",
      15000,
      errIdx,
    );
    expect(buyErr.code).toBe("INVALID_BUY_ABILITY");
  });

  it(
    "replays cumulative Round 1 + Round 2 carveLog accurately on RECONNECT_ROOM across persistent rounds",
    async () => {
      server = await startServer(0, {
        tickIntervalMs: 40,
        disconnectGraceMs: 5000,
        botThinkDelayMs: 60,
        roundDurationSec: 5,
        maxRounds: 5,
      });

      const host = await trackClient(server.port);
      host.send({
        type: "CREATE_ROOM",
        playerName: "CrossHost",
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
        playerName: "CrossGuest",
        species: "badger",
      });
      const guestJoined = await guest.waitFor(
        (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
          m.type === "ROOM_JOINED",
      );

      host.send({ type: "START_MATCH" });
      const r1Snap = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT" && m.state.round === 1,
      );

      // Carve terrain in Round 1
      const p1R1 = r1Snap.state.critters.find(
        (c) => c.id === hostJoined.playerId,
      );
      expect(p1R1).toBeDefined();
      const r1FireIdx = host.messages.length;
      host.send({
        type: "FIRE_ACTION",
        gadgetId: "gale_mortar",
        origin: p1R1?.position ?? { x: 30, y: 10, z: 30 },
        direction: { x: 0, y: -1, z: 0 },
        power: 0.15,
      });
      const r1CarvedSnap = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT" && m.state.carveLog.length >= 1,
        15000,
        r1FireIdx,
      );
      const r1CarveCount = r1CarvedSnap.state.carveLog.length;
      expect(r1CarveCount).toBeGreaterThanOrEqual(1);

      // Wait for 5s Round 1 clock to expire -> ROUND_DRAFT, then pick mutations to enter Round 2
      const draftSnap = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT" && m.state.phase === "ROUND_DRAFT",
        15000,
        r1FireIdx,
      );
      const hostDraft = draftSnap.state.pendingDrafts.find(
        (d) => d.playerId === hostJoined.playerId,
      );
      const guestDraft = draftSnap.state.pendingDrafts.find(
        (d) => d.playerId === guestJoined.playerId,
      );
      expect(hostDraft?.options[0]).toBeDefined();
      expect(guestDraft?.options[0]).toBeDefined();
      if (hostDraft?.options[0]) {
        host.send({ type: "PICK_MUTATION", mutationId: hostDraft.options[0] });
      }
      if (guestDraft?.options[0]) {
        guest.send({
          type: "PICK_MUTATION",
          mutationId: guestDraft.options[0],
        });
      }

      const r2StartSnap = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT" &&
          m.state.round === 2 &&
          m.state.phase === "ACTIVE",
        15000,
        r1FireIdx,
      );
      expect(r2StartSnap.state.carveLog.length).toBe(r1CarveCount);

      // Carve a second crater in Round 2 using whichever player is active
      const activeR2Client =
        r2StartSnap.state.activePlayerId === hostJoined.playerId ? host : guest;
      const activeR2Critter = r2StartSnap.state.critters.find(
        (c) => c.id === r2StartSnap.state.activePlayerId,
      );
      const r2FireIdx = host.messages.length;
      activeR2Client.send({
        type: "FIRE_ACTION",
        gadgetId: "gale_mortar",
        origin: activeR2Critter?.position ?? { x: 30, y: 10, z: 30 },
        direction: { x: 0, y: -1, z: 0 },
        power: 0.15,
      });
      const r2CarvedSnap = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT" &&
          m.state.round === 2 &&
          m.state.carveLog.length > r1CarveCount,
        15000,
        r2FireIdx,
      );
      const r2CarveCount = r2CarvedSnap.state.carveLog.length;
      expect(r2CarveCount).toBeGreaterThan(r1CarveCount);

      // Disconnect guest and reconnect in Round 2 -> must replay FULL cumulative R1+R2 carveLog!
      await guest.close();
      const reconGuest = await trackClient(server.port);
      reconGuest.send({
        type: "RECONNECT_ROOM",
        roomCode: hostJoined.roomCode,
        playerId: guestJoined.playerId,
        reconnectToken: guestJoined.reconnectToken,
      });

      const reconJoined = await reconGuest.waitFor(
        (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
          m.type === "ROOM_JOINED",
      );
      expect(reconJoined.playerId).toBe(guestJoined.playerId);

      const reconSnap = await reconGuest.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT",
      );
      expect(reconSnap.state.round).toBeGreaterThanOrEqual(2);
      expect(reconSnap.state.carveLog.length).toBeGreaterThanOrEqual(
        r2CarveCount,
      );
      expect(reconSnap.state.carveLog.slice(0, r1CarveCount)).toEqual(
        r1CarvedSnap.state.carveLog,
      );
      expect(reconSnap.state.carveLog.slice(0, r2CarveCount)).toEqual(
        r2CarvedSnap.state.carveLog,
      );
    },
    30000,
  );

  it(
    "broadcasts periodic STATE_SNAPSHOT frames with strictly increasing waterLevel during online FINAL_FLOOD before MATCH_OVER",
    async () => {
      server = await startServer(0, {
        tickIntervalMs: 30,
        disconnectGraceMs: 5000,
        botThinkDelayMs: 60,
        maxRounds: 1,
        roundDurationSec: 5,
        floodDurationSec: 1.0,
      });

      const host = await trackClient(server.port);
      host.send({
        type: "CREATE_ROOM",
        playerName: "FloodHost",
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
        playerName: "FloodGuest",
        species: "badger",
      });
      await guest.waitFor(
        (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
          m.type === "ROOM_JOINED",
      );

      host.send({ type: "START_MATCH" });

      // Wait for both clients to observe the FINAL_FLOOD engulfment finish into MATCH_OVER
      const [hostMatchOver, guestMatchOver] = await Promise.all([
        host.waitFor(
          (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
            m.type === "STATE_SNAPSHOT" && m.state.phase === "MATCH_OVER",
          20000,
        ),
        guest.waitFor(
          (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
            m.type === "STATE_SNAPSHOT" && m.state.phase === "MATCH_OVER",
          20000,
        ),
      ]);

      expect(hostMatchOver.state.matchEndReason).toBe("flood_draw");
      expect(guestMatchOver.state.matchEndReason).toBe("flood_draw");

      for (const client of [host, guest]) {
        const floodSnaps = client.messages.filter(
          (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
            m.type === "STATE_SNAPSHOT" && m.state.phase === "FINAL_FLOOD",
        );
        expect(floodSnaps.length).toBeGreaterThanOrEqual(4);
        for (let i = 1; i < floodSnaps.length; i++) {
          const prev = floodSnaps[i - 1];
          const curr = floodSnaps[i];
          expect(prev).toBeDefined();
          expect(curr).toBeDefined();
          if (prev && curr) {
            expect(curr.state.waterLevel).toBeGreaterThan(
              prev.state.waterLevel,
            );
          }
        }
      }
    },
    30000,
  );

  it(
    "forwards MOVE_STATE pitch to CritterState.pitch and accepts sky_bomber_drop UTILITY_ACTION in both ACTIVE and RETREAT phases",
    async () => {
      server = await startServer(0, {
        tickIntervalMs: 40,
        disconnectGraceMs: 5000,
        botThinkDelayMs: 60,
      });

      const host = await trackClient(server.port);
      host.send({
        type: "CREATE_ROOM",
        playerName: "PitchHost",
        species: "glider_squirrel",
      });
      const hostJoined = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
          m.type === "ROOM_JOINED",
      );

      const guest = await trackClient(server.port);
      guest.send({
        type: "JOIN_ROOM",
        roomCode: hostJoined.roomCode,
        playerName: "PitchGuest",
        species: "badger",
      });
      await guest.waitFor(
        (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
          m.type === "ROOM_JOINED",
      );

      host.send({ type: "START_MATCH" });
      const startSnap = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT",
      );
      const p1 = startSnap.state.critters.find(
        (c) => c.id === hostJoined.playerId,
      );
      expect(p1).toBeDefined();
      if (!p1) return;

      // Send MOVE_STATE with explicit pitch and verify both host & guest snapshots reflect it
      const moveIdxHost = host.messages.length;
      const moveIdxGuest = guest.messages.length;
      host.send({
        type: "MOVE_STATE",
        position: { ...p1.position },
        velocity: { x: 0, y: 0, z: 0 },
        yaw: 1.25,
        pitch: -0.42,
      });

      const [hostMoveSnap, guestMoveSnap] = await Promise.all([
        host.waitFor(
          (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
            m.type === "STATE_SNAPSHOT" &&
            Math.abs(
              (m.state.critters.find((c) => c.id === hostJoined.playerId)
                ?.pitch ?? 0) - -0.42,
            ) < 1e-4,
          15000,
          moveIdxHost,
        ),
        guest.waitFor(
          (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
            m.type === "STATE_SNAPSHOT" &&
            Math.abs(
              (m.state.critters.find((c) => c.id === hostJoined.playerId)
                ?.pitch ?? 0) - -0.42,
            ) < 1e-4,
          15000,
          moveIdxGuest,
        ),
      ]);
      expect(
        hostMoveSnap.state.critters.find((c) => c.id === hostJoined.playerId)
          ?.yaw,
      ).toBeCloseTo(1.25, 4);
      expect(
        guestMoveSnap.state.critters.find((c) => c.id === hostJoined.playerId)
          ?.pitch,
      ).toBeCloseTo(-0.42, 4);

      // Verify sky_bomber_drop UTILITY_ACTION passes protocol & server validation in ACTIVE
      const activeDropIdx = host.messages.length;
      host.send({
        type: "UTILITY_ACTION",
        gadgetId: "sky_bomber_drop",
        origin: { ...p1.position },
        direction: { x: 0, y: -1, z: 0 },
      });
      await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT",
        15000,
        activeDropIdx,
      );
      expect(
        host.messages
          .slice(activeDropIdx)
          .some((m) => m.type === "ERROR"),
      ).toBe(false);

      // Fire to enter RESOLVING -> RETREAT and verify sky_bomber_drop is also accepted in RETREAT
      const fireIdx = host.messages.length;
      host.send({
        type: "FIRE_ACTION",
        gadgetId: "gale_mortar",
        origin: { ...p1.position },
        direction: { x: 0, y: -1, z: 0 },
        power: 0.15,
      });
      await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT" && m.state.phase === "RETREAT",
        15000,
        fireIdx,
      );

      const retreatDropIdx = host.messages.length;
      host.send({
        type: "UTILITY_ACTION",
        gadgetId: "sky_bomber_drop",
        origin: { ...p1.position },
        direction: { x: 0, y: -1, z: 0 },
      });
      await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT",
        15000,
        retreatDropIdx,
      );
      expect(
        host.messages
          .slice(retreatDropIdx)
          .some((m) => m.type === "ERROR"),
      ).toBe(false);

      // Contrast: mend_brew during RETREAT must still be rejected with NOT_YOUR_TURN
      const retreatMendIdx = host.messages.length;
      host.send({
        type: "UTILITY_ACTION",
        gadgetId: "mend_brew",
        origin: { ...p1.position },
        direction: { x: 0, y: 1, z: 0 },
      });
      const mendErr = await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "ERROR" }> => m.type === "ERROR",
        15000,
        retreatMendIdx,
      );
      expect(mendErr.code).toBe("NOT_YOUR_TURN");
    },
    30000,
  );

  it(
    "automatically garbage-collects idle all-disconnected rooms and finished MATCH_OVER rooms after TTL",
    async () => {
      server = await startServer(0, {
        tickIntervalMs: 30,
        disconnectGraceMs: 5000,
        botThinkDelayMs: 60,
        maxRounds: 1,
        roundDurationSec: 5,
        floodDurationSec: 0.5,
        roomCleanupIntervalMs: 40,
        finishedRoomTtlMs: 80,
        idleRoomTtlMs: 80,
      });

      const waitUntil = async (
        cond: () => boolean,
        timeoutMs = 5000,
      ): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (!cond()) {
          if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };

      // Part A: Idle room where all humans disconnect is swept cleanly after idleRoomTtlMs
      const idleHost = await trackClient(server.port);
      idleHost.send({
        type: "CREATE_ROOM",
        playerName: "IdleMole",
        species: "mole",
      });
      await idleHost.waitFor(
        (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
          m.type === "ROOM_JOINED",
      );
      expect(server.manager.getRoomCount()).toBe(1);

      await idleHost.close();
      await waitUntil(() => server !== null && server.manager.getRoomCount() === 0);
      expect(server.manager.getRoomCount()).toBe(0);

      // Part B: Finished MATCH_OVER room is swept cleanly after finishedRoomTtlMs even while clients stay open
      const host = await trackClient(server.port);
      host.send({
        type: "CREATE_ROOM",
        playerName: "GcHost",
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
        playerName: "GcGuest",
        species: "badger",
      });
      await guest.waitFor(
        (m): m is Extract<ServerMessage, { type: "ROOM_JOINED" }> =>
          m.type === "ROOM_JOINED",
      );
      expect(server.manager.getRoomCount()).toBe(1);

      host.send({ type: "START_MATCH" });
      await host.waitFor(
        (m): m is Extract<ServerMessage, { type: "STATE_SNAPSHOT" }> =>
          m.type === "STATE_SNAPSHOT" && m.state.phase === "MATCH_OVER",
        20000,
      );

      await waitUntil(() => server !== null && server.manager.getRoomCount() === 0);
      expect(server.manager.getRoomCount()).toBe(0);
    },
    30000,
  );
});
