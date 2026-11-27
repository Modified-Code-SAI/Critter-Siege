import type { TurnPhase } from "@critter/shared";
import { describe, expect, it } from "vitest";
import {
  evaluateCountdownCue,
  type CountdownCueKind,
} from "../src/game/countdownCue.js";

describe("evaluateCountdownCue (Review Focus #4)", () => {
  it("emits active_tick for 10..4s and active_tick_urgent for 3..1s in ACTIVE phase", () => {
    let lastKey = "";
    const observed: Array<{ sec: number; cue: CountdownCueKind; key: string }> = [];

    for (let sec = 10; sec >= 1; sec--) {
      const res = evaluateCountdownCue("ACTIVE", true, sec - 0.15, lastKey);
      observed.push({ sec, cue: res.cue, key: res.nextKey });
      lastKey = res.nextKey;
    }

    expect(observed).toEqual([
      { sec: 10, cue: "active_tick", key: "ACTIVE:10" },
      { sec: 9, cue: "active_tick", key: "ACTIVE:9" },
      { sec: 8, cue: "active_tick", key: "ACTIVE:8" },
      { sec: 7, cue: "active_tick", key: "ACTIVE:7" },
      { sec: 6, cue: "active_tick", key: "ACTIVE:6" },
      { sec: 5, cue: "active_tick", key: "ACTIVE:5" },
      { sec: 4, cue: "active_tick", key: "ACTIVE:4" },
      { sec: 3, cue: "active_tick_urgent", key: "ACTIVE:3" },
      { sec: 2, cue: "active_tick_urgent", key: "ACTIVE:2" },
      { sec: 1, cue: "active_tick_urgent", key: "ACTIVE:1" },
    ]);
  });

  it("emits retreat_beep for 5..3s and retreat_beep_urgent for 2..1s in RETREAT phase", () => {
    let lastKey = "";
    const observed: Array<{ sec: number; cue: CountdownCueKind; key: string }> = [];

    for (let sec = 5; sec >= 1; sec--) {
      const res = evaluateCountdownCue("RETREAT", true, sec - 0.2, lastKey);
      observed.push({ sec, cue: res.cue, key: res.nextKey });
      lastKey = res.nextKey;
    }

    expect(observed).toEqual([
      { sec: 5, cue: "retreat_beep", key: "RETREAT:5" },
      { sec: 4, cue: "retreat_beep", key: "RETREAT:4" },
      { sec: 3, cue: "retreat_beep", key: "RETREAT:3" },
      { sec: 2, cue: "retreat_beep_urgent", key: "RETREAT:2" },
      { sec: 1, cue: "retreat_beep_urgent", key: "RETREAT:1" },
    ]);
  });

  it("deduplicates repeated calls within the same ceiling second", () => {
    const first = evaluateCountdownCue("ACTIVE", true, 9.9, "");
    expect(first).toEqual({ cue: "active_tick", nextKey: "ACTIVE:10" });

    const dup1 = evaluateCountdownCue("ACTIVE", true, 9.5, first.nextKey);
    expect(dup1).toEqual({ cue: "none", nextKey: "ACTIVE:10" });

    const dup2 = evaluateCountdownCue("ACTIVE", true, 9.01, dup1.nextKey);
    expect(dup2).toEqual({ cue: "none", nextKey: "ACTIVE:10" });

    const retreatFirst = evaluateCountdownCue("RETREAT", true, 4.8, "");
    expect(retreatFirst).toEqual({ cue: "retreat_beep", nextKey: "RETREAT:5" });

    const retreatDup = evaluateCountdownCue("RETREAT", true, 4.1, retreatFirst.nextKey);
    expect(retreatDup).toEqual({ cue: "none", nextKey: "RETREAT:5" });
  });

  it("fires retreat_beep immediately when switching from ACTIVE:2 to RETREAT:5", () => {
    const active = evaluateCountdownCue("ACTIVE", true, 1.8, "ACTIVE:3");
    expect(active).toEqual({ cue: "active_tick_urgent", nextKey: "ACTIVE:2" });

    const switched = evaluateCountdownCue("RETREAT", true, 4.95, active.nextKey);
    expect(switched).toEqual({ cue: "retreat_beep", nextKey: "RETREAT:5" });
  });

  it("returns none and resets key when canMove is false, time is non-finite, out of range, or in non-countdown phases", () => {
    expect(evaluateCountdownCue("ACTIVE", false, 5, "ACTIVE:6")).toEqual({
      cue: "none",
      nextKey: "",
    });
    expect(evaluateCountdownCue("RETREAT", false, 3, "RETREAT:4")).toEqual({
      cue: "none",
      nextKey: "",
    });

    for (const badTime of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(evaluateCountdownCue("ACTIVE", true, badTime, "ACTIVE:5")).toEqual({
        cue: "none",
        nextKey: "",
      });
    }

    expect(evaluateCountdownCue("ACTIVE", true, 10.1, "ACTIVE:10")).toEqual({
      cue: "none",
      nextKey: "",
    });
    expect(evaluateCountdownCue("ACTIVE", true, 0, "ACTIVE:1")).toEqual({
      cue: "none",
      nextKey: "",
    });
    expect(evaluateCountdownCue("ACTIVE", true, -0.5, "ACTIVE:1")).toEqual({
      cue: "none",
      nextKey: "",
    });

    expect(evaluateCountdownCue("RETREAT", true, 5.1, "RETREAT:5")).toEqual({
      cue: "none",
      nextKey: "",
    });
    expect(evaluateCountdownCue("RETREAT", true, 0, "RETREAT:1")).toEqual({
      cue: "none",
      nextKey: "",
    });

    const otherPhases: readonly TurnPhase[] = [
      "LOBBY",
      "RESOLVING",
      "DRAFT_IF_READY",
      "ROUND_DRAFT",
      "FINAL_FLOOD",
      "MATCH_OVER",
    ];
    for (const phase of otherPhases) {
      expect(evaluateCountdownCue(phase, true, 3, "ACTIVE:4")).toEqual({
        cue: "none",
        nextKey: "",
      });
    }
  });
});
