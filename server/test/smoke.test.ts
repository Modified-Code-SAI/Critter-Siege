import { describe, expect, it } from "vitest";
import { getServerBanner } from "../src/index.js";

describe("server smoke", () => {
  it("formats Critter Siege server banner", () => {
    expect(getServerBanner()).toBe("Critter Siege Server Ready");
  });
});
