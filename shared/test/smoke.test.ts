import { describe, expect, it } from "vitest";
import { GAME_TITLE } from "@critter/shared";

describe("shared smoke", () => {
  it("exports original Critter Siege title", () => {
    expect(GAME_TITLE).toBe("Critter Siege");
  });
});
