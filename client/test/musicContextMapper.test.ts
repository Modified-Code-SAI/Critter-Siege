import { describe, expect, it } from "vitest";
import type {
  CritterState,
  GadgetId,
  MatchState,
  TeamId,
  ThemeId,
} from "@critter/shared";
import {
  deriveMusicGameplayContext,
  shouldPlayEvolutionStinger,
  type MusicContextInput,
} from "../src/audio/musicContextMapper.js";

function makeCritter(overrides: Partial<CritterState> & { id: string }): CritterState {
  const defaultCharges: Record<GadgetId, number | null> = {
    gale_mortar: null,
    quake_club: null,
    vine_grapple: 1,
    spore_burst: 2,
    burrow_bore: 2,
    seeker_firefly: 1,
    gravity_mine: 1,
    prism_wall: 1,
    shock_magnet: 1,
    mend_brew: 1,
  };

  return {
    name: overrides.id,
    species: "mole",
    isBot: false,
    team: null,
    seatIndex: 0,
    connected: true,
    position: { x: 30, y: 10, z: 30 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 100,
    maxHp: 100,
    moveStamina: 100,
    maxMoveDistance: 10,
    alive: true,
    evoCharge: 0,
    pendingEvoDraft: false,
    equipped: {},
    apex: null,
    coins: 0,
    loadout: ["gale_mortar", "quake_club", "vine_grapple"],
    gadgetCharges: defaultCharges,
    roundShieldRemaining: 0,
    kills: 0,
    damageDealt: 0,
    podsCollected: 0,
    score: 0,
    droneNudgeUsedThisTurn: false,
    retreatBurrowUsedThisTurn: false,
    skyBomberDropUsedThisTurn: false,
    grappleUsedThisTurn: false,
    colorIndex: 0,
    color: "#f97316",
    ...overrides,
  };
}

function makeMatchState(overrides: Partial<MatchState> = {}): MatchState {
  return {
    matchId: "match-1",
    roomCode: "ABCD",
    seed: 1234,
    theme: "emerald_spire",
    mode: "ffa",
    mapScale: "grand",
    phase: "ACTIVE",
    round: 1,
    maxRounds: 5,
    turnNumber: 1,
    activeCritterId: "p1",
    activePlayerId: "p1",
    phaseTimerMs: 25_000,
    phaseTimeRemainingSec: 25,
    roundTimeRemainingSec: 150,
    roundDurationSec: 180,
    waterLevel: 1.8,
    floodTargetWaterLevel: null,
    matchEndReason: null,
    wind: { x: 3, y: 0, z: 4 },
    critters: [
      makeCritter({ id: "p1", seatIndex: 0 }),
      makeCritter({ id: "p2", seatIndex: 1, isBot: true }),
      makeCritter({ id: "p3", seatIndex: 2, isBot: true }),
      makeCritter({ id: "p4", seatIndex: 3, isBot: true }),
    ],
    evoPods: [],
    pendingDrafts: [],
    carveLog: [],
    scores: {},
    teamScores: { A: 0, B: 0 },
    winnerId: null,
    winnerTeam: null,
    roundWinners: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<MusicContextInput> = {}): MusicContextInput {
  return {
    inMatch: true,
    matchState: makeMatchState(),
    lobbyTheme: "emerald_spire",
    localPlayerId: "p1",
    armoryOpen: false,
    isCharging: false,
    chargePower: 0,
    isShotFlight: false,
    cameraMode: "over_shoulder",
    ...overrides,
  };
}

describe("deriveMusicGameplayContext", () => {
  describe("lobby defaults", () => {
    it("returns canonical lobby context when not in match or matchState is null", () => {
      const themes: readonly ThemeId[] = [
        "emerald_spire",
        "canyon_arch",
        "twin_pillars",
        "mountain_spine",
      ];

      for (const theme of themes) {
        const ctx = deriveMusicGameplayContext(
          makeInput({
            inMatch: false,
            matchState: null,
            lobbyTheme: theme,
            armoryOpen: true,
            isCharging: true,
            chargePower: 0.9,
            isShotFlight: true,
            cameraMode: "drone_recon",
          }),
        );

        expect(ctx).toEqual({
          mood: "lobby",
          theme,
          round: 1,
          maxRounds: 5,
          isMyTurn: true,
          isCharging: false,
          chargePower: 0,
          isShotFlight: false,
          isDroneView: false,
          hpRatio: 1,
          windSpeed: 2.6,
          waterLevel: 1.8,
          floodIntensity: 0,
          isShowdown: false,
        });
      }
    });
  });

  describe("Review Focus #2: Duel-Safe 1v1 Showdown", () => {
    it("keeps 2-player FFA Duel on Round 1 Turn 1 in battle mood (isShowdown === false)", () => {
      const state = makeMatchState({
        mode: "ffa",
        mapScale: "duel",
        round: 1,
        turnNumber: 1,
        critters: [
          makeCritter({ id: "p1", seatIndex: 0, alive: true }),
          makeCritter({ id: "p2", seatIndex: 1, alive: true, isBot: true }),
        ],
      });

      const ctx = deriveMusicGameplayContext(makeInput({ matchState: state }));
      expect(ctx.isShowdown).toBe(false);
      expect(ctx.mood).toBe("battle");
    });

    it("triggers intense showdown when a 4-player FFA narrows down to 2 alive critters", () => {
      const state = makeMatchState({
        mode: "ffa",
        round: 1,
        critters: [
          makeCritter({ id: "p1", seatIndex: 0, alive: true }),
          makeCritter({ id: "p2", seatIndex: 1, alive: true, isBot: true }),
          makeCritter({ id: "p3", seatIndex: 2, alive: false, hp: 0, isBot: true }),
          makeCritter({ id: "p4", seatIndex: 3, alive: false, hp: 0, isBot: true }),
        ],
      });

      const ctx = deriveMusicGameplayContext(makeInput({ matchState: state }));
      expect(ctx.isShowdown).toBe(true);
      expect(ctx.mood).toBe("intense");
    });

    it("stays in battle when a 4-player FFA still has 3 alive critters", () => {
      const state = makeMatchState({
        mode: "ffa",
        round: 1,
        critters: [
          makeCritter({ id: "p1", seatIndex: 0, alive: true }),
          makeCritter({ id: "p2", seatIndex: 1, alive: true, isBot: true }),
          makeCritter({ id: "p3", seatIndex: 2, alive: true, isBot: true }),
          makeCritter({ id: "p4", seatIndex: 3, alive: false, hp: 0, isBot: true }),
        ],
      });

      const ctx = deriveMusicGameplayContext(makeInput({ matchState: state }));
      expect(ctx.isShowdown).toBe(false);
      expect(ctx.mood).toBe("battle");
    });

    it("triggers intense showdown in 2v2 when 1v1 remains (teamAAlive === 1 && teamBAlive === 1)", () => {
      const teamCritter = (id: string, team: TeamId, alive: boolean): CritterState =>
        makeCritter({ id, team, alive, hp: alive ? 100 : 0 });

      const state = makeMatchState({
        mode: "2v2",
        round: 1,
        critters: [
          teamCritter("p1", "A", true),
          teamCritter("p2", "A", false),
          teamCritter("p3", "B", true),
          teamCritter("p4", "B", false),
        ],
      });

      const ctx = deriveMusicGameplayContext(makeInput({ matchState: state }));
      expect(ctx.isShowdown).toBe(true);
      expect(ctx.mood).toBe("intense");
    });

    it("does NOT trigger showdown in 2v2 when 2v0 remains", () => {
      const teamCritter = (id: string, team: TeamId, alive: boolean): CritterState =>
        makeCritter({ id, team, alive, hp: alive ? 100 : 0 });

      const state = makeMatchState({
        mode: "2v2",
        round: 1,
        critters: [
          teamCritter("p1", "A", true),
          teamCritter("p2", "A", true),
          teamCritter("p3", "B", false),
          teamCritter("p4", "B", false),
        ],
      });

      const ctx = deriveMusicGameplayContext(makeInput({ matchState: state }));
      expect(ctx.isShowdown).toBe(false);
      expect(ctx.mood).toBe("battle");
    });
  });

  describe("MATCH_OVER victory vs defeat", () => {
    it("resolves victory for FFA winner and defeat for non-winner", () => {
      const wonState = makeMatchState({
        phase: "MATCH_OVER",
        mode: "ffa",
        winnerId: "p1",
        matchEndReason: "elimination",
      });
      expect(
        deriveMusicGameplayContext(makeInput({ matchState: wonState, armoryOpen: true })).mood,
      ).toBe("victory");

      const lostState = makeMatchState({
        phase: "MATCH_OVER",
        mode: "ffa",
        winnerId: "p2",
        matchEndReason: "elimination",
      });
      expect(deriveMusicGameplayContext(makeInput({ matchState: lostState })).mood).toBe(
        "defeat",
      );
    });

    it("resolves victory for winning 2v2 team and defeat for losing 2v2 team or flood_draw", () => {
      const state2v2 = makeMatchState({
        phase: "MATCH_OVER",
        mode: "2v2",
        winnerTeam: "A",
        matchEndReason: "score",
        critters: [
          makeCritter({ id: "p1", team: "A" }),
          makeCritter({ id: "p2", team: "A" }),
          makeCritter({ id: "p3", team: "B" }),
          makeCritter({ id: "p4", team: "B" }),
        ],
      });

      expect(
        deriveMusicGameplayContext(makeInput({ matchState: state2v2, localPlayerId: "p1" })).mood,
      ).toBe("victory");
      expect(
        deriveMusicGameplayContext(makeInput({ matchState: state2v2, localPlayerId: "p3" })).mood,
      ).toBe("defeat");

      const drawState = makeMatchState({
        ...state2v2,
        winnerTeam: null,
        matchEndReason: "flood_draw",
      });
      expect(
        deriveMusicGameplayContext(makeInput({ matchState: drawState, localPlayerId: "p1" })).mood,
      ).toBe("defeat");
    });
  });

  describe("FINAL_FLOOD and floodIntensity", () => {
    it("selects flood mood and scales floodIntensity from 0.5 to 1.0 during FINAL_FLOOD", () => {
      const floodStart = makeMatchState({
        phase: "FINAL_FLOOD",
        round: 5,
        waterLevel: 4.0,
        floodTargetWaterLevel: 16.0,
      });
      const startCtx = deriveMusicGameplayContext(
        makeInput({ matchState: floodStart, armoryOpen: true }),
      );
      expect(startCtx.mood).toBe("flood");
      expect(startCtx.floodIntensity).toBeCloseTo(0.5, 5);

      const floodMid = makeMatchState({
        phase: "FINAL_FLOOD",
        round: 5,
        waterLevel: 10.0,
        floodTargetWaterLevel: 16.0,
      });
      expect(deriveMusicGameplayContext(makeInput({ matchState: floodMid })).floodIntensity).toBeCloseTo(
        0.75,
        5,
      );

      const floodPeak = makeMatchState({
        phase: "FINAL_FLOOD",
        round: 5,
        waterLevel: 16.0,
        floodTargetWaterLevel: null,
      });
      expect(
        deriveMusicGameplayContext(makeInput({ matchState: floodPeak })).floodIntensity,
      ).toBeCloseTo(1.0, 5);
    });

    it("keeps floodIntensity at 0 in Rounds 1-3 with ample time and ramps 0.2..0.45 in Round 4+ or late clock", () => {
      const r1 = deriveMusicGameplayContext(
        makeInput({ matchState: makeMatchState({ round: 1, roundTimeRemainingSec: 120 }) }),
      );
      expect(r1.floodIntensity).toBe(0);

      const r3 = deriveMusicGameplayContext(
        makeInput({ matchState: makeMatchState({ round: 3, roundTimeRemainingSec: 75 }) }),
      );
      expect(r3.floodIntensity).toBe(0);

      const r4 = deriveMusicGameplayContext(
        makeInput({ matchState: makeMatchState({ round: 4, roundTimeRemainingSec: 120 }) }),
      );
      expect(r4.floodIntensity).toBeGreaterThanOrEqual(0.2);
      expect(r4.floodIntensity).toBeLessThanOrEqual(0.45);

      const lateClock = deriveMusicGameplayContext(
        makeInput({ matchState: makeMatchState({ round: 2, roundTimeRemainingSec: 15 }) }),
      );
      expect(lateClock.floodIntensity).toBeGreaterThanOrEqual(0.2);
      expect(lateClock.floodIntensity).toBeLessThanOrEqual(0.45);
    });
  });

  describe("shop and intense urgency moods", () => {
    it("selects shop mood when armory is open or phase is ROUND_DRAFT / DRAFT_IF_READY", () => {
      expect(deriveMusicGameplayContext(makeInput({ armoryOpen: true })).mood).toBe("shop");
      expect(
        deriveMusicGameplayContext(
          makeInput({ matchState: makeMatchState({ phase: "ROUND_DRAFT" }) }),
        ).mood,
      ).toBe("shop");
      expect(
        deriveMusicGameplayContext(
          makeInput({ matchState: makeMatchState({ phase: "DRAFT_IF_READY" }) }),
        ).mood,
      ).toBe("shop");
    });

    it("selects intense mood on late round clock, low turn timer on own turn, low HP, or late rounds", () => {
      // Late round clock <= 60s
      expect(
        deriveMusicGameplayContext(
          makeInput({ matchState: makeMatchState({ roundTimeRemainingSec: 60 }) }),
        ).mood,
      ).toBe("intense");

      // Own turn with <= 6s phase timer
      expect(
        deriveMusicGameplayContext(
          makeInput({ matchState: makeMatchState({ phaseTimeRemainingSec: 6 }) }),
        ).mood,
      ).toBe("intense");

      // Rival's turn with <= 6s phase timer stays battle
      expect(
        deriveMusicGameplayContext(
          makeInput({
            matchState: makeMatchState({
              activePlayerId: "p2",
              phaseTimeRemainingSec: 4,
            }),
          }),
        ).mood,
      ).toBe("battle");

      // Low HP (< 0.35) while alive
      expect(
        deriveMusicGameplayContext(
          makeInput({
            matchState: makeMatchState({
              critters: [
                makeCritter({ id: "p1", hp: 34, maxHp: 100, alive: true }),
                makeCritter({ id: "p2", alive: true }),
                makeCritter({ id: "p3", alive: true }),
              ],
            }),
          }),
        ).mood,
      ).toBe("intense");

      // Dead local critter does not trigger low-HP intense
      expect(
        deriveMusicGameplayContext(
          makeInput({
            matchState: makeMatchState({
              activePlayerId: "p2",
              critters: [
                makeCritter({ id: "p1", hp: 0, maxHp: 100, alive: false }),
                makeCritter({ id: "p2", alive: true }),
                makeCritter({ id: "p3", alive: true }),
                makeCritter({ id: "p4", alive: true }),
              ],
            }),
          }),
        ).mood,
      ).toBe("battle");

      // Round >= Math.max(4, maxRounds - 1)
      expect(
        deriveMusicGameplayContext(
          makeInput({ matchState: makeMatchState({ round: 4, maxRounds: 5 }) }),
        ).mood,
      ).toBe("intense");
    });
  });

  describe("micro-moment telemetry mapping", () => {
    it("maps charging, shotFlight, drone view, windSpeed, hpRatio, theme, waterLevel, and isMyTurn accurately", () => {
      const state = makeMatchState({
        theme: "canyon_arch",
        round: 2,
        maxRounds: 5,
        phase: "RETREAT",
        activePlayerId: "p1",
        waterLevel: 3.2,
        wind: { x: 6, y: 0, z: 8 },
        critters: [
          makeCritter({ id: "p1", hp: 60, maxHp: 120, alive: true }),
          makeCritter({ id: "p2", alive: true }),
          makeCritter({ id: "p3", alive: true }),
        ],
      });

      const ctx = deriveMusicGameplayContext(
        makeInput({
          matchState: state,
          isCharging: true,
          chargePower: 0.72,
          isShotFlight: true,
          cameraMode: "drone_recon",
        }),
      );

      expect(ctx.theme).toBe("canyon_arch");
      expect(ctx.round).toBe(2);
      expect(ctx.maxRounds).toBe(5);
      expect(ctx.isMyTurn).toBe(true);
      expect(ctx.isCharging).toBe(true);
      expect(ctx.chargePower).toBeCloseTo(0.72, 5);
      expect(ctx.isShotFlight).toBe(true);
      expect(ctx.isDroneView).toBe(true);
      expect(ctx.hpRatio).toBeCloseTo(0.5, 5);
      expect(ctx.windSpeed).toBeCloseTo(10, 5);
      expect(ctx.waterLevel).toBeCloseTo(3.2, 5);

      const specDroneCtx = deriveMusicGameplayContext(
        makeInput({
          matchState: { ...state, phase: "RESOLVING" },
          isCharging: false,
          chargePower: 0.5,
          cameraMode: "spectator_drone",
        }),
      );
      expect(specDroneCtx.isMyTurn).toBe(false);
      expect(specDroneCtx.isDroneView).toBe(true);
      expect(specDroneCtx.chargePower).toBe(0);

      const fpCtx = deriveMusicGameplayContext(
        makeInput({ matchState: state, cameraMode: "first_person" }),
      );
      expect(fpCtx.isDroneView).toBe(false);
    });
  });
});

describe("Review Focus #4: shouldPlayEvolutionStinger", () => {
  it("returns true only when eventPlayerId matches non-null localPlayerId", () => {
    expect(shouldPlayEvolutionStinger("p1", "p1")).toBe(true);
    expect(shouldPlayEvolutionStinger("bot-1", "p1")).toBe(false);
    expect(shouldPlayEvolutionStinger("p1", "p2")).toBe(false);
    expect(shouldPlayEvolutionStinger("p1", null)).toBe(false);
  });
});
