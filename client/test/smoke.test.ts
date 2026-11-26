import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GAME_TITLE, SPECIES_IDS } from "@critter/shared";
import {
  WS_SERVER_STORAGE_KEY,
  buildInviteUrl,
  normalizeServerWsUrl,
  resolveWsUrl,
} from "../src/main.js";
import { getPropModelUrl, getSpeciesModelUrl } from "../src/scene/modelLoader.js";
import { getSpeciesPortraitUrl } from "../src/ui/hud.js";

function createMemoryStorage(initial?: Record<string, string>): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
} {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("client smoke", () => {
  it("resolves shared GAME_TITLE for client", () => {
    expect(GAME_TITLE).toBe("Critter Siege");
  });

  it("provides crisp 3D portrait JPG assets for all 6 playable species", () => {
    for (const species of SPECIES_IDS) {
      const url = getSpeciesPortraitUrl(species);
      expect(url).toBe(`/portraits/${species}.jpg`);
      expect(url.includes("//")).toBe(false);
      const diskPath = resolve(process.cwd(), "client/public", url.slice(1));
      expect(existsSync(diskPath)).toBe(true);
      expect(statSync(diskPath).size).toBeGreaterThan(2048);
    }
  });

  it("resolves species models, prop models, and portraits cleanly under / and /Critter-Siege/ subpath bases", () => {
    expect(getSpeciesModelUrl("mole")).toBe("/models/mole.glb");
    expect(getPropModelUrl("watchtower")).toBe("/models/props/watchtower.glb");
    expect(getSpeciesPortraitUrl("mole")).toBe("/portraits/mole.jpg");

    expect(getSpeciesModelUrl("mole", "/Critter-Siege/")).toBe(
      "/Critter-Siege/models/mole.glb",
    );
    expect(getSpeciesModelUrl("mole", "/Critter-Siege")).toBe(
      "/Critter-Siege/models/mole.glb",
    );
    expect(getPropModelUrl("watchtower", "/Critter-Siege/")).toBe(
      "/Critter-Siege/models/props/watchtower.glb",
    );
    expect(getPropModelUrl("watchtower", "/Critter-Siege")).toBe(
      "/Critter-Siege/models/props/watchtower.glb",
    );
    expect(getSpeciesPortraitUrl("mole", "/Critter-Siege/")).toBe(
      "/Critter-Siege/portraits/mole.jpg",
    );
    expect(getSpeciesPortraitUrl("mole", "/Critter-Siege")).toBe(
      "/Critter-Siege/portraits/mole.jpg",
    );
  });

  it("normalizes ?server= URLs and resolves WS routing priority cleanly", () => {
    expect(WS_SERVER_STORAGE_KEY).toBe("critter_siege_ws_server_v1");

    expect(normalizeServerWsUrl("https://critter.onrender.com")).toBe(
      "wss://critter.onrender.com/ws",
    );
    expect(normalizeServerWsUrl("https://critter.onrender.com/")).toBe(
      "wss://critter.onrender.com/ws",
    );
    expect(normalizeServerWsUrl("wss://tunnel.trycloudflare.com")).toBe(
      "wss://tunnel.trycloudflare.com/ws",
    );
    expect(normalizeServerWsUrl("ws://localhost:3001/ws")).toBe(
      "ws://localhost:3001/ws",
    );

    const storage = createMemoryStorage();
    expect(
      resolveWsUrl({
        search: "?server=https://my-room.trycloudflare.com",
        hostname: "modified-code-sai.github.io",
        locationHost: "modified-code-sai.github.io",
        locationProtocol: "https:",
        envWsUrl: "wss://env-fallback.example.com/ws",
        storage,
      }),
    ).toBe("wss://my-room.trycloudflare.com/ws");
    expect(storage.getItem(WS_SERVER_STORAGE_KEY)).toBe(
      "wss://my-room.trycloudflare.com/ws",
    );

    // Reload without ?server= keeps persisted sessionStorage URL
    expect(
      resolveWsUrl({
        search: "",
        hostname: "modified-code-sai.github.io",
        locationHost: "modified-code-sai.github.io",
        locationProtocol: "https:",
        envWsUrl: "wss://env-fallback.example.com/ws",
        storage,
      }),
    ).toBe("wss://my-room.trycloudflare.com/ws");

    // Static github.io without ?server= or VITE_WS_URL returns empty string
    expect(
      resolveWsUrl({
        search: "",
        hostname: "modified-code-sai.github.io",
        locationHost: "modified-code-sai.github.io",
        locationProtocol: "https:",
        envWsUrl: "",
        storage: createMemoryStorage(),
      }),
    ).toBe("");

    // Localhost falls back to same-origin /ws
    expect(
      resolveWsUrl({
        search: "",
        hostname: "localhost",
        locationHost: "localhost:5173",
        locationProtocol: "http:",
        envWsUrl: "",
        storage: createMemoryStorage(),
      }),
    ).toBe("ws://localhost:5173/ws");

    // Invite link preserves ?server= when custom server is active
    expect(
      buildInviteUrl(
        "https://modified-code-sai.github.io",
        "/Critter-Siege/",
        "ABCD",
        "wss://my-room.trycloudflare.com/ws",
      ),
    ).toBe(
      "https://modified-code-sai.github.io/Critter-Siege/?room=ABCD&server=wss%3A%2F%2Fmy-room.trycloudflare.com%2Fws",
    );
    expect(
      buildInviteUrl("http://localhost:5173", "/", "ABCD", ""),
    ).toBe("http://localhost:5173/?room=ABCD");
  });
});
