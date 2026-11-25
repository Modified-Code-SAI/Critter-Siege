import { describe, expect, it } from "vitest";
import { GAME_TITLE } from "@critter/shared";

describe("client smoke", () => {
  it("resolves shared GAME_TITLE for client", () => {
    expect(GAME_TITLE).toBe("Critter Siege");
  });
});
