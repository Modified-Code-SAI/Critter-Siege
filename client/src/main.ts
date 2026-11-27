import * as THREE from "three";
import {
  GADGET_CATALOG,
  GALE_SCATTER_REACH,
  GRAVITY,
  SDF_DIMS,
  SPECIES_CATALOG,
  SdfWorld,
  computeCritterStats,
  computeMaxMoveDistance,
  computeRetreatMoveDistance,
  type CarveOp,
  type CritterState,
  type EngineEvent,
  type GadgetId,
  type GameMode,
  type HazardState,
  type ImpactEvent,
  type MapScaleChoice,
  type MatchState,
  type SpeciesId,
  type ThemeId,
  type Vec3,
} from "@critter/shared";
import {
  deriveMusicGameplayContext,
  shouldPlayEvolutionStinger,
} from "./audio/musicContextMapper.js";
import { SynthAudio, type MusicGameplayContext } from "./audio/synthAudio.js";
import { CameraRig, type CameraMode } from "./game/cameraRig.js";
import { evaluateCountdownCue } from "./game/countdownCue.js";
import {
  projectDroneMarkers,
  resolveDronePingTarget,
} from "./game/droneProjection.js";
import {
  capturePreImpactCritters,
  isShotVisualFreezeActive,
  releaseShotVisualFreeze,
  resolveCritterVisualState,
  type PreImpactCritterSnapshot,
} from "./game/shotVisualFreeze.js";
import {
  createGrappleAnimState,
  shouldExitDroneForGrapple,
  stepGrappleAnim,
  type GrappleAnimState,
} from "./game/grappleAnimation.js";
import { InputController } from "./game/inputController.js";
import { TrajectoryPreview } from "./game/trajectoryPreview.js";
import { GameClient, type LobbyViewState } from "./net/gameClient.js";
import {
  COSMETIC_ACCENT_CATALOG,
  ProgressionStore,
} from "./profile/progression.js";
import { CritterRig } from "./scene/critterMesh.js";
import { EnvironmentProps } from "./scene/environmentProps.js";
import { preloadAllSpeciesModels } from "./scene/modelLoader.js";
import { TerrainRenderer } from "./scene/terrainRenderer.js";
import { VfxSystem, type DroneBeaconInput } from "./scene/vfx.js";
import { WorldScene, getThemeAtmosphere } from "./scene/worldScene.js";
import {
  HudController,
  type HudCompassState,
  type LobbySelectionState,
  type MatchEssenceBreakdown,
  type SelectableCameraMode,
} from "./ui/hud.js";

/** Compute the normalized directional sun vector matching a biome theme's atmosphere preset. */
export function getThemeSunDirection(theme: ThemeId): THREE.Vector3 {
  const { sunOffset } = getThemeAtmosphere(theme);
  return new THREE.Vector3(sunOffset.x, sunOffset.y, sunOffset.z).normalize();
}
const GADGET_COLORS: Record<GadgetId, number> = {
  gale_mortar: 0xffa73b,
  quake_club: 0xf43f5e,
  vine_grapple: 0x34d399,
  spore_burst: 0x84cc16,
  burrow_bore: 0xf97316,
  seeker_firefly: 0x38f5ff,
  gravity_mine: 0xa855f7,
  prism_wall: 0x67e8f9,
  shock_magnet: 0x60a5fa,
  mend_brew: 0x22c55e,
};

const LOBBY_SHOWCASE_SPECIES: readonly {
  species: SpeciesId;
  color: string;
  label: string;
}[] = [
  { species: "mole", color: "#f97316", label: "Tunnel Mole" },
  { species: "norway_rat", color: "#38bdf8", label: "Norway Rat" },
  { species: "badger", color: "#22c55e", label: "Ridge Badger" },
  { species: "glider_squirrel", color: "#f43f5e", label: "Glider Squirrel" },
];

const MOVE_SYNC_INTERVAL_MS = 66;
const AUTO_HOP_MAX_STEP_M = 1.0;
const BACKFLIP_JUMP_MULT = 1.48;
const BACKFLIP_BACKWARD_SPEED = 3.8;
const BACKFLIP_GRACE_SEC = 0.32;
const WORLD_SPAN_X = SDF_DIMS.nx * SDF_DIMS.voxelSize;
const WORLD_SPAN_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize;
const WORLD_CENTER_X = WORLD_SPAN_X * 0.5;
const WORLD_CENTER_Z = WORLD_SPAN_Z * 0.5;

interface ScheduledImpact extends ImpactEvent {
  triggered: boolean;
}

interface ShotHitPopup {
  critterId: string;
  damage: number;
  shieldAbsorbed: boolean;
  newPosition: Vec3;
  knockedOut?: boolean;
}

const MUSIC_CONTEXT_FLOAT_EPSILON = 0.02;

function hasMusicContextChanged(
  prev: MusicGameplayContext | null,
  next: MusicGameplayContext,
): boolean {
  if (!prev) {
    return true;
  }
  return (
    prev.mood !== next.mood ||
    prev.theme !== next.theme ||
    prev.round !== next.round ||
    prev.maxRounds !== next.maxRounds ||
    prev.isMyTurn !== next.isMyTurn ||
    prev.isCharging !== next.isCharging ||
    prev.isShotFlight !== next.isShotFlight ||
    prev.isDroneView !== next.isDroneView ||
    prev.isShowdown !== next.isShowdown ||
    Math.abs(prev.chargePower - next.chargePower) >= MUSIC_CONTEXT_FLOAT_EPSILON ||
    Math.abs(prev.hpRatio - next.hpRatio) >= MUSIC_CONTEXT_FLOAT_EPSILON ||
    Math.abs(prev.windSpeed - next.windSpeed) >= MUSIC_CONTEXT_FLOAT_EPSILON ||
    Math.abs(prev.waterLevel - next.waterLevel) >= MUSIC_CONTEXT_FLOAT_EPSILON ||
    Math.abs(prev.floodIntensity - next.floodIntensity) >= MUSIC_CONTEXT_FLOAT_EPSILON
  );
}

interface ShotPlayback {
  gadgetId: GadgetId;
  path: Vec3[];
  aimDir: Vec3;
  durationSec: number;
  elapsedSec: number;
  holdAfterSec: number;
  impacts: ScheduledImpact[];
  drownedPositions: Vec3[];
  splashesDone: boolean;
  hits?: ShotHitPopup[];
  hitsPopupsDone?: boolean;
  hitStopSec?: number;
  isPrismIntercept?: boolean;
  allowOutsideResolving?: boolean;
  seekerTargetPos?: Vec3 | null;
  boreCapsule?: {
    center: Vec3;
    end: Vec3;
    radius: number;
    startSec: number;
    slicedCount: number;
    lastGrindMs: number;
  } | null;
  scatterBlastDone?: boolean;
  preImpactCritters: ReadonlyMap<string, PreImpactCritterSnapshot>;
  impactReleased: boolean;
}

/** SessionStorage key preserving ?server= WebSocket URL across page reloads. */
export const WS_SERVER_STORAGE_KEY = "critter_siege_ws_server_v1";

const NO_WS_SERVER_TOAST =
  "Play Now works anytime! For online rooms on GitHub Pages, add ?server=wss://your-server-url (or run a Cloudflare tunnel).";

/** Optional environment overrides for deterministic WS URL resolution tests. */
export interface ResolveWsUrlOptions {
  search?: string;
  hostname?: string;
  locationHost?: string;
  locationProtocol?: string;
  envWsUrl?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/**
 * Normalize a custom multiplayer server URL (`wss://...`, `ws://...`, or `https://...`)
 * into a canonical WebSocket URL appending `/ws` when path is empty or `/`.
 */
export function normalizeServerWsUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const withScheme = trimmed.includes("://")
    ? trimmed
    : /^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed)
      ? `ws://${trimmed}`
      : `wss://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return "";
  }

  if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return "";
  }

  if (parsed.pathname === "" || parsed.pathname === "/") {
    parsed.pathname = "/ws";
  }

  return parsed.toString();
}

function isStaticGithubPagesHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === "github.io" || lower.endsWith(".github.io");
}

function readBrowserStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * Resolve any explicit custom multiplayer server URL from `?server=`,
 * persisted `sessionStorage`, or build-time `VITE_WS_URL`.
 */
export function resolveCustomServerUrl(opts?: ResolveWsUrlOptions): string {
  const search =
    opts?.search ??
    (typeof window !== "undefined" ? window.location.search : "");
  const storage =
    opts && "storage" in opts ? (opts.storage ?? null) : readBrowserStorage();

  try {
    const params = new URLSearchParams(search);
    if (params.has("server")) {
      const rawParam = params.get("server") ?? "";
      const normalized = normalizeServerWsUrl(rawParam);
      if (normalized) {
        try {
          storage?.setItem(WS_SERVER_STORAGE_KEY, normalized);
        } catch {
          // Ignore storage write errors
        }
        return normalized;
      }
      if (rawParam.trim() === "") {
        try {
          storage?.removeItem(WS_SERVER_STORAGE_KEY);
        } catch {
          // Ignore storage remove errors
        }
      }
    }
  } catch {
    // Ignore malformed query strings
  }

  try {
    const stored = storage?.getItem(WS_SERVER_STORAGE_KEY) ?? "";
    const normalizedStored = normalizeServerWsUrl(stored);
    if (normalizedStored) {
      return normalizedStored;
    }
  } catch {
    // Ignore storage read errors
  }

  const rawEnv: unknown =
    opts?.envWsUrl !== undefined ? opts.envWsUrl : import.meta.env?.VITE_WS_URL;
  if (typeof rawEnv === "string" && rawEnv.trim().length > 0) {
    const normalizedEnv = normalizeServerWsUrl(rawEnv);
    if (normalizedEnv) {
      return normalizedEnv;
    }
  }

  return "";
}

/**
 * Resolve the multiplayer WebSocket URL in priority order:
 * 1. `?server=` query param (persisted to `critter_siege_ws_server_v1`)
 * 2. `import.meta.env.VITE_WS_URL`
 * 3. Same-origin `/ws` on localhost / LAN / custom server, or `""` on `*.github.io`
 */
export function resolveWsUrl(opts?: ResolveWsUrlOptions): string {
  const customUrl = resolveCustomServerUrl(opts);
  if (customUrl) {
    return customUrl;
  }

  const hostname =
    opts?.hostname ??
    (typeof window !== "undefined" ? window.location.hostname : "localhost");
  if (isStaticGithubPagesHost(hostname)) {
    return "";
  }

  const locationProtocol =
    opts?.locationProtocol ??
    (typeof window !== "undefined" ? window.location.protocol : "http:");
  const locationHost =
    opts?.locationHost ??
    (typeof window !== "undefined" ? window.location.host : "localhost:5173");
  if (!locationHost) {
    return "";
  }
  const proto = locationProtocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${locationHost}/ws`;
}

/** Build a shareable invite link preserving `?server=` whenever a custom server is active. */
export function buildInviteUrl(
  origin: string,
  pathname: string,
  roomCode: string,
  customServerUrl?: string,
): string {
  const base = `${origin}${pathname}?room=${encodeURIComponent(roomCode)}`;
  if (customServerUrl && customServerUrl.trim().length > 0) {
    return `${base}&server=${encodeURIComponent(customServerUrl)}`;
  }
  return base;
}

function readRoomCodeFromUrl(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("room")?.trim().toUpperCase() ?? "";
    return /^[A-Z]{4}$/.test(raw) ? raw : "";
  } catch {
    return "";
  }
}

function computeAimDirection(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: Math.cos(yaw) * cosPitch,
  };
}

function normalizeVec3(
  v: Vec3,
  fallback: Vec3 = { x: 0, y: 0, z: 1 },
): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(len) || len < 1e-5) {
    return { x: fallback.x, y: fallback.y, z: fallback.z };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function findLocalGroundY(
  world: SdfWorld,
  x: number,
  z: number,
  refY: number,
): number | null {
  const startY = Math.min(world.worldHeight - 1.5, refY + 1.3);
  const endY = Math.max(0.5, refY - 1.6);
  const step = 0.2;

  let prevY = startY;
  let prevVal = world.sample(x, prevY, z);

  for (let y = startY - step; y >= endY; y -= step) {
    const currVal = world.sample(x, y, z);
    if (prevVal >= 0 && currVal < 0) {
      let lo = y;
      let hi = prevY;
      for (let i = 0; i < 4; i++) {
        const mid = (lo + hi) * 0.5;
        if (world.sample(x, mid, z) < 0) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      return (lo + hi) * 0.5;
    }
    prevY = y;
    prevVal = currVal;
  }

  const topY = world.getSurfaceY(x, z);
  if (topY !== null && topY <= refY + AUTO_HOP_MAX_STEP_M + 0.05) {
    return topY;
  }
  return null;
}

function findDropShadowGroundY(
  world: SdfWorld,
  x: number,
  z: number,
  refY: number,
  waterLevel: number,
): number | null {
  const startY = Math.min(world.worldHeight - 1.0, refY + 0.35);
  const endY = Math.max(0.4, waterLevel);
  if (startY <= endY) {
    return null;
  }
  const step = 0.25;
  let prevY = startY;
  let prevVal = world.sample(x, prevY, z);

  for (let y = startY - step; y >= endY; y -= step) {
    const currVal = world.sample(x, y, z);
    if (prevVal >= 0 && currVal < 0) {
      let lo = y;
      let hi = prevY;
      for (let i = 0; i < 4; i++) {
        const mid = (lo + hi) * 0.5;
        if (world.sample(x, mid, z) < 0) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      return (lo + hi) * 0.5;
    }
    prevY = y;
    prevVal = currVal;
  }

  return null;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") {
    return false;
  }
  const tag =
    "tagName" in target && typeof target.tagName === "string"
      ? target.tagName.toUpperCase()
      : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Top-level Critter Siege browser application integrating 3D SDF island rendering
 * (60m Duel & 144m Grand), sculpted critters with airborne ground shadows,
 * grandma-friendly Pointer-Lock & keyboard controls, 4-mode camera rig,
 * Auto-Hop + Double-Tap Space Backflip kinematics, Shot Cam playback, WebAudio
 * synthesis, progression, and Sandbox + WebSocket multiplayer.
 */
class CritterSiegeApp {
  private readonly appContainer: HTMLElement;
  private readonly hudRoot: HTMLElement;

  private readonly worldScene: WorldScene;
  private readonly cameraRig: CameraRig;
  private readonly vfx: VfxSystem;
  private readonly trajectoryPreview: TrajectoryPreview;
  private readonly audio: SynthAudio;
  private readonly progression: ProgressionStore;
  private readonly hud: HudController;
  private readonly gameClient: GameClient;
  private readonly input: InputController;

  private readonly critterRoot = new THREE.Group();
  private readonly critterRigs = new Map<string, CritterRig>();

  private activeWorld: SdfWorld;
  private terrainRenderer: TerrainRenderer;
  private readonly environmentProps: EnvironmentProps;
  private previewHazards: HazardState[] = [];
  private activeWorldKey = "";
  private lastMatchRound = 0;
  private appliedCarveCount = 0;
  private lastShorelineWaterLevel = 1.8;
  private shadowFocusPos: Vec3 = { x: WORLD_CENTER_X, y: 8, z: WORLD_CENTER_Z };
  private musicUnlocked = false;
  private lastMusicContext: MusicGameplayContext | null = null;

  private readonly onWindowResizeBound: () => void;
  private readonly onWindowKeyDownBound: (e: KeyboardEvent) => void;
  private readonly onUserGestureUnlockBound: () => void;

  private onlineLobby: LobbyViewState | null = null;
  private matchState: MatchState | null = null;
  private inMatch = false;

  private readonly lobbySelection: LobbySelectionState;
  private previewTheme: ThemeId = "emerald_spire";
  private selectedGadget: GadgetId = "gale_mortar";
  private dronePing: Vec3 | null = null;
  private dronePingCritterId: string | null = null;

  // Local critter movement kinematics (WASD + Auto-Hop + Double-Tap Space Backflip)
  private readonly localPos = new THREE.Vector3(WORLD_CENTER_X, 10, WORLD_CENTER_Z);
  private readonly localVel = new THREE.Vector3(0, 0, 0);
  private localGrounded = true;
  private localTimeSinceGroundedSec = 0;
  private backflipUsedThisJump = false;
  private localTurnKey = "";
  private localMoveStamina = 100;
  private staminaSpentToastShown = false;
  private lastMoveSyncMs = 0;
  private lastSyncedPos = new THREE.Vector3(WORLD_CENTER_X, 10, WORLD_CENTER_Z);
  private lastSyncedYaw = 0;
  private readonly popupProjVec = new THREE.Vector3();

  // Shot Cam animation, ghost aim memory, grapple reel-up glide & audio feedback state
  private shotPlayback: ShotPlayback | null = null;
  private lastLocalShotAim: {
    gadgetId: GadgetId;
    yaw: number;
    pitch: number;
    power: number;
  } | null = null;
  private readonly grappleGlides = new Map<string, GrappleAnimState>();
  private lastChargeTickMs = 0;
  private lastCountdownKey = "";
  private quickStartMoved = false;
  private quickStartFired = false;
  private lobbyHeroPos: Vec3 = { x: WORLD_CENTER_X, y: 10, z: WORLD_CENTER_Z };

  // Match-over Siege Essence tracking
  private rewardedMatchId: string | null = null;
  private essenceBreakdown: MatchEssenceBreakdown | null = null;

  private rafId = 0;
  private lastFrameMs = 0;
  private elapsedSec = 0;

  public constructor(appContainer: HTMLElement, hudRoot: HTMLElement) {
    this.appContainer = appContainer;
    this.hudRoot = hudRoot;

    // Warm the browser cache for all 4 Hunyuan3D GLB hero critter models immediately
    preloadAllSpeciesModels();

    this.progression = new ProgressionStore();
    this.audio = new SynthAudio();

    const profile = this.progression.getProfile();
    this.lobbySelection = {
      theme: "emerald_spire",
      gameMode: "ffa",
      mapScale: "auto",
      botCount: 3,
      bonusGadget: profile.unlockedBonusGadgets[0] ?? null,
      startingLoadout: ["gale_mortar", "quake_club", "vine_grapple"],
      joinCodeInput: readRoomCodeFromUrl(),
    };

    // 3D Scene setup
    this.worldScene = new WorldScene(this.appContainer);
    this.critterRoot.name = "critter_rigs";
    this.worldScene.scene.add(this.critterRoot);

    this.vfx = new VfxSystem();
    this.worldScene.scene.add(this.vfx.group);

    this.trajectoryPreview = new TrajectoryPreview();
    this.worldScene.scene.add(this.trajectoryPreview.group);

    const aspect =
      Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight);
    this.cameraRig = new CameraRig(aspect);

    // Build initial live Lobby sculpted sky-island + lush scenery + sample critters & hazards
    this.activeWorld = new SdfWorld(4242, this.lobbySelection.theme);
    this.worldScene.configureForWorldSize(
      this.activeWorld.worldWidth,
      this.activeWorld.worldHeight,
      this.activeWorld.worldDepth,
    );
    this.worldScene.setTheme(this.activeWorld.theme);
    this.worldScene.setWaterLevel(1.8);
    this.worldScene.updateShorelineFromWorld(this.activeWorld, 1.8);
    this.lastShorelineWaterLevel = 1.8;
    this.terrainRenderer = new TerrainRenderer(this.activeWorld);
    this.terrainRenderer.setWaterLevel(1.8);
    this.terrainRenderer.setSunDirection(
      getThemeSunDirection(this.activeWorld.theme),
    );
    this.worldScene.scene.add(this.terrainRenderer.group);

    const previewSpawns = this.activeWorld.findSpawnPoints(
      LOBBY_SHOWCASE_SPECIES.length,
    );
    this.previewHazards = this.activeWorld
      .findHazardPoints(previewSpawns)
      .map((p, idx) => ({
        id: `preview-haz-${idx + 1}`,
        type: p.type,
        position: { ...p.position },
        radius: p.radius,
        active: true,
      }));
    this.environmentProps = new EnvironmentProps(
      this.activeWorld,
      1.8,
      [...previewSpawns, ...this.previewHazards.map((h) => h.position)],
    );
    this.environmentProps.syncHazards(this.previewHazards, 0);
    this.worldScene.scene.add(this.environmentProps.group);

    this.spawnLobbyShowcaseCritters();

    // GameClient (Sandbox + WebSocket Online)
    this.gameClient = new GameClient({
      onLobbyUpdate: (lobby) => this.handleLobbyUpdate(lobby),
      onStateSnapshot: (state) => this.handleStateSnapshot(state),
      onEngineEvents: (events) => this.handleEngineEvents(events),
      onError: (msg) => this.hud.showToast(msg, "error"),
    });

    // HUD & Lobby Controller
    this.hud = new HudController(this.hudRoot, {
      onNameChange: (name) => {
        this.progression.setDisplayName(name);
        this.refreshLobbyHud();
      },
      onColorChange: (color) => {
        this.audio.playUiClick();
        this.progression.selectColor(color);
        if (!this.inMatch) {
          this.spawnLobbyShowcaseCritters();
        }
        this.refreshLobbyHud();
      },
      onSelectSpecies: (species) => {
        this.audio.playUiClick();
        this.progression.selectSpecies(species);
        if (!this.inMatch) {
          this.spawnLobbyShowcaseCritters();
        }
        if (this.onlineLobby?.mode === "online") {
          this.gameClient.sendLobbyConfig({ species });
        }
        this.refreshLobbyHud();
      },
      onUnlockSpecies: (species) => {
        const res = this.progression.purchaseSpecies(species);
        if (res.ok) {
          this.audio.playMutationChime();
          this.progression.selectSpecies(species);
          if (!this.inMatch) {
            this.spawnLobbyShowcaseCritters();
          }
          this.hud.showToast(
            `Unlocked ${SPECIES_CATALOG[species].name}!`,
            "success",
          );
          if (this.onlineLobby?.mode === "online") {
            this.gameClient.sendLobbyConfig({ species });
          }
        } else if (res.reason) {
          this.hud.showToast(res.reason, "error");
        }
        this.refreshLobbyHud();
      },
      onUnlockCosmetic: (cosmeticId) => {
        const res = this.progression.purchaseCosmetic(cosmeticId);
        if (res.ok) {
          this.audio.playMutationChime();
          if (!this.inMatch) {
            this.spawnLobbyShowcaseCritters();
          }
          const def = COSMETIC_ACCENT_CATALOG.find((c) => c.id === cosmeticId);
          this.hud.showToast(
            `Unlocked ${def ? def.name : cosmeticId} collar accent!`,
            "success",
          );
        } else if (res.reason) {
          this.hud.showToast(res.reason, "error");
        }
        this.refreshLobbyHud();
      },
      onSelectBonusGadget: (gadget) => {
        this.audio.playUiClick();
        this.lobbySelection.bonusGadget = gadget;
        if (this.onlineLobby?.mode === "online") {
          this.gameClient.sendLobbyConfig({ bonusGadget: gadget });
        }
        this.refreshLobbyHud();
      },
      onUnlockBonusGadget: (gadget) => {
        const res = this.progression.purchaseBonusGadget(gadget);
        if (res.ok) {
          this.audio.playMutationChime();
          this.lobbySelection.bonusGadget = gadget;
          this.hud.showToast(
            `Unlocked ${GADGET_CATALOG[gadget].name}!`,
            "success",
          );
          if (this.onlineLobby?.mode === "online") {
            this.gameClient.sendLobbyConfig({ bonusGadget: gadget });
          }
        } else if (res.reason) {
          this.hud.showToast(res.reason, "error");
        }
        this.refreshLobbyHud();
      },
      onStartingLoadoutChange: (loadout) => {
        this.audio.playUiClick();
        this.lobbySelection.startingLoadout = [...loadout];
        if (this.onlineLobby?.mode === "online") {
          this.gameClient.sendLobbyConfig({ startingLoadout: loadout });
        }
        this.refreshLobbyHud();
      },
      onThemeChange: (theme) => {
        this.audio.playUiClick();
        this.lobbySelection.theme = theme;
        if (!this.inMatch) {
          this.rebuildLobbyPreview(theme);
        }
        if (this.onlineLobby?.mode === "online") {
          this.gameClient.sendLobbyConfig({ theme });
        }
        this.refreshLobbyHud();
      },
      onGameModeChange: (mode: GameMode) => {
        this.audio.playUiClick();
        this.lobbySelection.gameMode = mode;
        if (this.onlineLobby?.mode === "online") {
          this.gameClient.sendLobbyConfig({ mode });
        }
        this.refreshLobbyHud();
      },
      onMapScaleChange: (mapScale: MapScaleChoice) => {
        this.audio.playUiClick();
        this.lobbySelection.mapScale = mapScale;
        if (this.onlineLobby?.mode === "online") {
          this.gameClient.sendLobbyConfig({ mapScale });
        }
        this.refreshLobbyHud();
      },
      onBotCountChange: (count) => {
        this.audio.playUiClick();
        this.lobbySelection.botCount = count;
        if (this.onlineLobby?.mode === "online") {
          this.gameClient.sendLobbyConfig({ botCount: count });
        }
        this.refreshLobbyHud();
      },
      onPlaySandbox: () => this.launchSandboxMatch(),
      onCreateRoom: () => {
        this.audio.playUiClick();
        const wsUrl = resolveWsUrl();
        if (!wsUrl) {
          this.hud.showToast(NO_WS_SERVER_TOAST, "info");
          return;
        }
        const p = this.progression.getProfile();
        this.gameClient.connectAndCreateRoom(
          wsUrl,
          p.displayName,
          p.selectedSpecies,
          {
            theme: this.lobbySelection.theme,
            mode: this.lobbySelection.gameMode,
            ...(this.lobbySelection.mapScale !== undefined
              ? { mapScale: this.lobbySelection.mapScale }
              : {}),
            botCount: this.lobbySelection.botCount,
            bonusGadget: this.lobbySelection.bonusGadget,
            ...(this.lobbySelection.startingLoadout !== undefined
              ? { startingLoadout: [...this.lobbySelection.startingLoadout] }
              : {}),
          },
        );
      },
      onJoinRoom: (roomCode) => {
        this.audio.playUiClick();
        const wsUrl = resolveWsUrl();
        if (!wsUrl) {
          this.hud.showToast(NO_WS_SERVER_TOAST, "info");
          return;
        }
        const p = this.progression.getProfile();
        this.gameClient.connectAndJoinRoom(
          wsUrl,
          roomCode,
          p.displayName,
          p.selectedSpecies,
          this.lobbySelection.bonusGadget,
          this.lobbySelection.startingLoadout,
        );
      },
      onStartOnlineMatch: () => {
        this.audio.playUiClick();
        this.gameClient.startOnlineMatch();
      },
      onLeaveRoom: () => {
        this.audio.playUiClick();
        this.returnToLobby();
      },
      onCopyInviteLink: () => this.copyInviteLink(),
      onSelectGadget: (gid) => {
        this.audio.playUiClick();
        this.selectedGadget = gid;
        this.input.setSelectedGadget(gid);
      },
      onBuyAbility: (gadgetId, replaceGadgetId) => {
        this.gameClient.sendBuyAbility(gadgetId, replaceGadgetId);
      },
      onPickMutation: (mutationId, replaceSlot) => {
        this.gameClient.sendPickMutation(mutationId, replaceSlot);
      },
      onRerollDraft: () => {
        this.audio.playUiClick();
        this.gameClient.sendRerollDraft();
      },
      onToggleMute: () => {
        const muted = this.audio.toggleMute();
        this.hud.showToast(muted ? "Audio muted" : "Audio enabled", "info");
      },
      onToggleMusicMute: () => {
        const muted = this.audio.toggleMusicMute();
        this.hud.showToast(muted ? "Music muted" : "Music enabled", "info");
      },
      onArmoryOpenChange: (open) => {
        if (open) {
          this.input.exitPointerLock();
        }
        this.updateAdaptiveMusicMood();
      },
      onPlayAgain: () => {
        this.audio.playUiClick();
        if (this.gameClient.getMode() === "sandbox") {
          this.launchSandboxMatch();
        } else {
          this.returnToLobby();
        }
      },
      onBackToLobby: () => {
        this.audio.playUiClick();
        this.returnToLobby();
      },
      onSelectCameraMode: (mode: SelectableCameraMode) => {
        if (!this.inMatch) return;
        this.audio.playUiClick();
        if (mode === "over_shoulder") {
          this.cameraRig.exitDroneRecon();
          this.cameraRig.setFirstPerson(false);
          this.input.syncFirstPerson(false);
        } else if (mode === "first_person") {
          this.cameraRig.exitDroneRecon();
          this.cameraRig.setFirstPerson(true);
          this.input.syncFirstPerson(true);
        } else if (this.cameraRig.getMode() !== "drone_recon") {
          this.input.exitPointerLock();
          this.input.syncFirstPerson(false);
          this.cameraRig.toggleDroneRecon();
        }
      },
      onUiFireStart: () => {
        this.input.startUiFireCharge();
      },
      onUiFireRelease: () => {
        this.input.releaseUiFireCharge();
      },
      onUiFireCancel: () => {
        this.input.cancelCharge();
      },
      onDronePingCritter: (critterId) => this.handleDronePingCritter(critterId),
    });

    // Gameplay Input Controller
    this.input = new InputController(
      this.worldScene.renderer.domElement,
      this.cameraRig.camera,
      {
        onFire: (power) => this.handleFireAction(power),
        onUtility: () => this.handleUtilityAction(),
        onRetreatBurrow: () => this.handleRetreatBurrow(),
        onDroneNudge: (dir) => this.handleDroneNudge(dir),
        onDronePing: (point, rayOrigin, rayDir) =>
          this.handleDronePing(point, rayOrigin, rayDir),
        onSelectGadgetIndex: (idx) => this.selectGadgetByIndex(idx),
        onToggleDrone: () => {
          if (!this.inMatch) return;
          if (this.cameraRig.getMode() !== "drone_recon") {
            this.input.exitPointerLock();
          }
          this.cameraRig.toggleDroneRecon();
        },
        onFirstPersonChange: (active) => {
          if (!this.inMatch) return;
          this.cameraRig.setFirstPerson(active);
        },
      },
      (dYaw, dPitch, dZoom) => {
        this.cameraRig.orbitDrone(dYaw, dPitch, dZoom);
      },
    );
    this.input.setRaycastTargets([this.terrainRenderer.group]);

    this.onWindowResizeBound = () => this.handleResize();
    this.onWindowKeyDownBound = (e: KeyboardEvent) => {
      if (isEditableElement(e.target) || e.repeat) {
        return;
      }
      if (e.code === "KeyM") {
        const muted = this.audio.toggleMute();
        this.hud.showToast(muted ? "Audio muted" : "Audio enabled", "info");
      } else if (e.code === "KeyN") {
        const muted = this.audio.toggleMusicMute();
        this.hud.showToast(muted ? "Music muted" : "Music enabled", "info");
      } else if (
        e.code === "KeyB" &&
        this.inMatch &&
        this.matchState &&
        this.matchState.phase !== "FINAL_FLOOD" &&
        this.matchState.phase !== "MATCH_OVER"
      ) {
        this.hud.toggleArmory();
        if (this.hud.isArmoryOpen()) {
          this.input.exitPointerLock();
        }
      } else if (e.code === "Escape" && this.hud.isArmoryOpen()) {
        this.hud.setArmoryOpen(false);
      } else if (e.code === "KeyL" && this.inMatch) {
        this.hud.toggleStandings();
      } else if (e.key === "?" && this.inMatch) {
        this.hud.toggleHelpCard();
      }
    };
    this.onUserGestureUnlockBound = () => {
      if (this.musicUnlocked) {
        return;
      }
      this.musicUnlocked = true;
      window.removeEventListener("pointerdown", this.onUserGestureUnlockBound);
      window.removeEventListener("keydown", this.onUserGestureUnlockBound);
      this.audio.unlockAndStartMusic();
      this.lastMusicContext = null;
      this.updateAdaptiveMusicMood();
    };

    window.addEventListener("resize", this.onWindowResizeBound);
    window.addEventListener("keydown", this.onWindowKeyDownBound);
    window.addEventListener("pointerdown", this.onUserGestureUnlockBound, {
      passive: true,
    });
    window.addEventListener("keydown", this.onUserGestureUnlockBound, {
      passive: true,
    });

    this.refreshLobbyHud();

    // Seamlessly reconnect to an active online room after browser refresh
    const reconnectWsUrl = resolveWsUrl();
    if (reconnectWsUrl && this.gameClient.tryAutoReconnect(reconnectWsUrl)) {
      this.hud.showToast("Reconnecting to Critter Siege room...", "info");
    }

    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame((now) => this.loop(now));
  }

  private clearGrappleGlides(): void {
    for (const id of this.grappleGlides.keys()) {
      this.vfx.setGrappleTether(id, null);
    }
    this.grappleGlides.clear();
  }

  private launchSandboxMatch(): void {
    this.audio.playUiClick();
    const p = this.progression.getProfile();
    this.rewardedMatchId = null;
    this.essenceBreakdown = null;
    this.dronePing = null;
    this.dronePingCritterId = null;
    this.lastMatchRound = 0;
    this.quickStartMoved = false;
    this.quickStartFired = false;
    this.lastLocalShotAim = null;
    this.lastCountdownKey = "";
    this.clearGrappleGlides();
    this.hud.setArmoryOpen(false);
    this.vfx.setDronePing(null);
    this.vfx.syncDronePlayerBeacons([], false, 0);
    this.vfx.syncPrismWalls([], 0);
    this.environmentProps.updateAimOcclusion(null);
    this.shotPlayback = null;
    this.cameraRig.setShotCamActive(false);
    this.cameraRig.exitDroneRecon();
    this.cameraRig.setFirstPerson(false);
    this.cameraRig.setSpectatorOverride(false);

    this.gameClient.startSandbox({
      playerName: p.displayName,
      species: p.selectedSpecies,
      color: p.selectedColor,
      gameMode: this.lobbySelection.gameMode,
      theme: this.lobbySelection.theme,
      ...(this.lobbySelection.mapScale !== undefined
        ? { mapScale: this.lobbySelection.mapScale }
        : {}),
      botCount: Math.max(1, this.lobbySelection.botCount),
      bonusGadget: this.lobbySelection.bonusGadget,
      ...(this.lobbySelection.startingLoadout !== undefined
        ? { startingLoadout: [...this.lobbySelection.startingLoadout] }
        : {}),
    });
  }

  private returnToLobby(): void {
    this.input.exitPointerLock();
    this.hud.setArmoryOpen(false);
    this.gameClient.disconnect();
    this.inMatch = false;
    this.matchState = null;
    this.onlineLobby = null;
    this.shotPlayback = null;
    this.lastLocalShotAim = null;
    this.lastCountdownKey = "";
    this.clearGrappleGlides();
    this.dronePing = null;
    this.dronePingCritterId = null;
    this.essenceBreakdown = null;
    this.vfx.setDronePing(null);
    this.vfx.syncDronePlayerBeacons([], false, 0);
    this.vfx.setProjectileVisual(null);
    this.vfx.syncEvoPods([], 0);
    this.vfx.syncPrismWalls([], 0);
    this.environmentProps.updateAimOcclusion(null);
    this.trajectoryPreview.update(
      this.activeWorld,
      {
        gadgetId: "gale_mortar",
        origin: { x: this.activeWorld.centerX, y: 10, z: this.activeWorld.centerZ },
        direction: { x: 0, y: 1, z: 0 },
        power: 0.5,
      },
      { x: 0, y: 0, z: 0 },
      false,
      false,
    );
    this.cameraRig.setShotCamActive(false);
    this.cameraRig.exitDroneRecon();
    this.cameraRig.setFirstPerson(false);
    this.cameraRig.setSpectatorOverride(false);
    this.input.setCanAct(false, false, false);

    this.activeWorldKey = "";
    this.lastMatchRound = 0;
    this.appliedCarveCount = 0;
    this.worldScene.setRoundAtmosphere(1, 5);
    this.worldScene.setFloodIntensity(0);
    this.rebuildLobbyPreview(this.lobbySelection.theme);
    this.refreshLobbyHud();
  }

  private copyInviteLink(): void {
    const code = this.onlineLobby?.roomCode;
    if (!code) {
      return;
    }
    const url = buildInviteUrl(
      window.location.origin,
      window.location.pathname,
      code,
      resolveCustomServerUrl(),
    );
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      void navigator.clipboard.writeText(url).then(
        () => this.hud.showToast(`Invite link copied (${code})!`, "success"),
        () => this.hud.showToast(`Share room code: ${code}`, "info"),
      );
    } else {
      this.hud.showToast(`Share room code: ${code}`, "info");
    }
  }

  private handleLobbyUpdate(lobby: LobbyViewState): void {
    this.onlineLobby = lobby;
    if (!this.inMatch) {
      if (lobby.startingLoadout && lobby.startingLoadout.length > 0) {
        this.lobbySelection.startingLoadout = [...lobby.startingLoadout];
      }
      if (lobby.theme !== this.previewTheme) {
        this.rebuildLobbyPreview(lobby.theme);
      }
      this.refreshLobbyHud();
    }
  }

  private handleStateSnapshot(state: MatchState): void {
    this.matchState = state;
    this.inMatch = true;

    // Release Pointer Lock automatically whenever a modal UI or flood sequence takes focus
    if (
      state.phase === "ROUND_DRAFT" ||
      state.phase === "DRAFT_IF_READY" ||
      state.phase === "FINAL_FLOOD" ||
      state.phase === "MATCH_OVER"
    ) {
      this.input.exitPointerLock();
    }

    const worldKey = `${state.matchId}:${state.seed}:${state.theme}:${state.mapScale}`;
    let roundSnappedWater = false;

    if (worldKey !== this.activeWorldKey) {
      this.activeWorldKey = worldKey;
      this.lastMatchRound = state.round;
      this.activeWorld = new SdfWorld(
        state.seed,
        state.theme,
        state.mapScale,
      );
      this.worldScene.configureForWorldSize(
        this.activeWorld.worldWidth,
        this.activeWorld.worldHeight,
        this.activeWorld.worldDepth,
      );
      this.worldScene.setTheme(this.activeWorld.theme);
      this.terrainRenderer.setSunDirection(
        getThemeSunDirection(this.activeWorld.theme),
      );
      this.worldScene.setRoundAtmosphere(state.round, state.maxRounds);
      this.worldScene.setWaterLevel(state.waterLevel, true);
      this.worldScene.setFloodIntensity(0);
      roundSnappedWater = true;
      this.vfx.setWorldBounds(
        this.activeWorld.worldWidth,
        this.activeWorld.worldHeight,
        this.activeWorld.worldDepth,
      );
      this.appliedCarveCount = 0;
      for (const op of state.carveLog) {
        this.activeWorld.applyCarve(op);
        this.appliedCarveCount += 1;
      }
      this.terrainRenderer.rebuildAll(this.activeWorld);
      this.terrainRenderer.setWaterLevel(state.waterLevel);
      this.worldScene.updateShorelineFromWorld(this.activeWorld, state.waterLevel);
      this.lastShorelineWaterLevel = state.waterLevel;
      this.input.setRaycastTargets([this.terrainRenderer.group]);

      const avoidPoints: Vec3[] = [
        ...state.critters.map((c) => c.position),
        ...(state.hazards ?? []).map((h) => h.position),
      ];
      this.environmentProps.rebuild(
        this.activeWorld,
        state.waterLevel,
        avoidPoints,
      );
      if (state.carveLog.length > 0) {
        this.environmentProps.pruneAfterCarve(this.activeWorld, state.waterLevel);
      }
      this.environmentProps.syncHazards(state.hazards ?? [], this.elapsedSec);

      this.dronePing = null;
      this.dronePingCritterId = null;
      this.vfx.setDronePing(null);
      this.shotPlayback = null;
      this.lastLocalShotAim = null;
      this.clearGrappleGlides();
      this.cameraRig.setShotCamActive(false);
      this.localTurnKey = "";
      this.lastCountdownKey = "";
    } else {
      if (state.round !== this.lastMatchRound) {
        this.lastMatchRound = state.round;
        this.worldScene.setRoundAtmosphere(state.round, state.maxRounds);
        this.worldScene.setWaterLevel(state.waterLevel, true);
        this.worldScene.setFloodIntensity(0);
        roundSnappedWater = true;

        this.dronePing = null;
        this.dronePingCritterId = null;
        this.vfx.setDronePing(null);
        this.shotPlayback = null;
        this.lastLocalShotAim = null;
        this.clearGrappleGlides();
        this.cameraRig.setShotCamActive(false);
        this.localTurnKey = "";
        this.lastCountdownKey = "";
        this.environmentProps.syncHazards(state.hazards ?? [], this.elapsedSec);

        if (state.round > 1) {
          this.hud.showTurnBanner(
            `ROUND ${state.round} / ${state.maxRounds}`,
            "Battle scars remain — fresh hazards dropped!",
            "pod",
          );
        }
      }

      if (!this.shotPlayback && state.carveLog.length > this.appliedCarveCount) {
        this.flushPendingCarves(state);
      }
    }

    if (!roundSnappedWater) {
      this.worldScene.setWaterTargetLevel(state.waterLevel);
    }
    this.terrainRenderer.setWaterLevel(state.waterLevel);
    if (Math.abs(state.waterLevel - this.lastShorelineWaterLevel) >= 0.1) {
      this.worldScene.updateShorelineFromWorld(this.activeWorld, state.waterLevel);
      this.lastShorelineWaterLevel = state.waterLevel;
    }

    let floodIntensity = 0;
    if (state.phase === "FINAL_FLOOD") {
      const targetY = state.floodTargetWaterLevel ?? 24;
      const frac = Math.max(
        0,
        Math.min(1, (state.waterLevel - 4.0) / Math.max(1, targetY - 4.0)),
      );
      floodIntensity = 0.5 + 0.5 * frac;
    } else if (
      state.round >= state.maxRounds &&
      state.roundTimeRemainingSec <= 60
    ) {
      const warnFrac = Math.max(
        0,
        Math.min(1, 1 - state.roundTimeRemainingSec / 60),
      );
      floodIntensity = 0.45 * warnFrac;
    }
    this.worldScene.setFloodIntensity(floodIntensity);
    this.syncCritterRigsFromState(state);

    // Snap local movement state when turn/round changes or when not actively controlling
    const localId = this.gameClient.getPlayerId();
    const localCritter = state.critters.find((c) => c.id === localId) ?? null;
    if (localCritter) {
      const turnKey = `${state.round}:${state.turnNumber}:${state.phase}`;
      const isControlling =
        state.activePlayerId === localId &&
        localCritter.alive &&
        (state.phase === "ACTIVE" || state.phase === "RETREAT");
      const localGliding = localId !== null && this.grappleGlides.has(localId);

      const distSq =
        (this.localPos.x - localCritter.position.x) ** 2 +
        (this.localPos.y - localCritter.position.y) ** 2 +
        (this.localPos.z - localCritter.position.z) ** 2;

      const freezeLocalPos = isShotVisualFreezeActive(this.shotPlayback);
      if (
        !freezeLocalPos &&
        (!isControlling ||
          turnKey !== this.localTurnKey ||
          (!localGliding && distSq > 2.8 * 2.8))
      ) {
        this.localPos.set(
          localCritter.position.x,
          localCritter.position.y,
          localCritter.position.z,
        );
        this.localVel.set(0, 0, 0);
        this.localGrounded = true;
        this.localTimeSinceGroundedSec = 0;
        this.backflipUsedThisJump = false;
        this.lastSyncedPos.copy(this.localPos);
        this.localMoveStamina = localCritter.moveStamina;

        if (isControlling && turnKey !== this.localTurnKey) {
          this.localTurnKey = turnKey;
          this.staminaSpentToastShown = false;
          if (state.phase === "ACTIVE") {
            this.hud.showTurnBanner(
              "YOUR TURN",
              "Move · Click to Look · Hold Click or Enter to Fire",
              "mine",
              localCritter.species,
            );
            // Face toward nearest enemy at the start of your turn for instant aim feel
            const aimYaw = this.computeInitialTurnYaw(state, localCritter);
            this.input.setAim(aimYaw, 0.24);
          } else if (state.phase === "RETREAT") {
            this.hud.showTurnBanner(
              "RETREAT! 6s",
              "Fresh dash burst — Run to cover!",
              "retreat",
              localCritter.species,
            );
          }
        }
      } else if (isControlling && localCritter.moveStamina < this.localMoveStamina - 6) {
        this.localMoveStamina = localCritter.moveStamina;
      }

      // Auto-fallback to Gale Mortar if selected gadget is not in loadout or out of charges
      const curCharges = localCritter.gadgetCharges[this.selectedGadget];
      if (
        !localCritter.loadout.includes(this.selectedGadget) ||
        (curCharges !== null && curCharges <= 0)
      ) {
        this.selectedGadget = "gale_mortar";
        this.input.setSelectedGadget("gale_mortar");
      }
    }

    // Award Siege Essence once upon reaching MATCH_OVER
    if (state.phase === "MATCH_OVER" && this.rewardedMatchId !== state.matchId) {
      this.rewardedMatchId = state.matchId;
      this.awardEndOfMatchEssence(state, localCritter);
    }
  }

  private handleEngineEvents(events: EngineEvent[]): void {
    const localId = this.gameClient.getPlayerId();
    const hasBatchPrismIntercept = events.some(
      (e) =>
        e.type === "SHOT_RESOLVED" &&
        (e.simulation.shatteredPrismWallIds?.length ?? 0) > 0,
    );
    const entersResolving = events.some(
      (e) => e.type === "PHASE_CHANGED" && e.phase === "RESOLVING",
    );
    for (const ev of events) {
      switch (ev.type) {
        case "SHOT_RESOLVED": {
          this.audio.playLaunch(ev.gadgetId);
          const sim = ev.simulation;
          const drownedPositions = sim.hits
            .filter((h) => h.drowned)
            .map((h) => ({ ...h.newPosition }));
          const path: Vec3[] =
            sim.path.length > 0
              ? sim.path
              : [{ x: this.activeWorld.centerX, y: 10, z: this.activeWorld.centerZ }];
          const origin = path[0] ?? {
            x: this.activeWorld.centerX,
            y: 10,
            z: this.activeWorld.centerZ,
          };
          const nextPt = path[1];
          const shooter = this.matchState?.critters.find(
            (c) => c.id === ev.shooterId,
          );
          const fallbackDir = shooter
            ? computeAimDirection(shooter.yaw, shooter.pitch)
            : { x: 0, y: 0, z: 1 };
          const aimDir = nextPt
            ? normalizeVec3(
                {
                  x: nextPt.x - origin.x,
                  y: nextPt.y - origin.y,
                  z: nextPt.z - origin.z,
                },
                fallbackDir,
              )
            : fallbackDir;
          const durationSec = Math.max(0.24, sim.durationSec);

          let boreCapsule: ShotPlayback["boreCapsule"] = null;
          if (ev.gadgetId === "burrow_bore") {
            const cap = sim.carveOps.find(
              (op): op is CarveOp & { end: Vec3 } =>
                op.shape === "capsule" && op.end !== undefined,
            );
            if (cap) {
              const tunnelDuration =
                GADGET_CATALOG.burrow_bore.tunnelDurationSec ?? 0.6;
              boreCapsule = {
                center: { ...cap.center },
                end: { ...cap.end },
                radius: cap.radius,
                startSec: Math.max(0.05, durationSec - tunnelDuration),
                slicedCount: 0,
                lastGrindMs: 0,
              };
            }
          }

          const seekerTargetPos =
            ev.gadgetId === "seeker_firefly"
              ? (path[path.length - 1] ?? this.dronePing)
              : null;

          const preImpactCritters = capturePreImpactCritters(
            this.matchState?.critters ?? [],
            this.collectLiveCritterPositions(),
          );

          this.shotPlayback = {
            gadgetId: ev.gadgetId,
            path,
            aimDir,
            durationSec,
            elapsedSec: 0,
            holdAfterSec: 0.45,
            impacts: sim.impacts.map((imp) => ({ ...imp, triggered: false })),
            drownedPositions,
            splashesDone: false,
            hits: sim.hits.map((h) => ({
              critterId: h.critterId,
              damage: h.damage,
              shieldAbsorbed: h.shieldAbsorbed,
              newPosition: { ...h.newPosition },
              knockedOut: h.knockedOut,
            })),
            hitsPopupsDone: false,
            hitStopSec: 0,
            isPrismIntercept: (sim.shatteredPrismWallIds?.length ?? 0) > 0,
            allowOutsideResolving:
              !entersResolving && this.matchState?.phase !== "RESOLVING",
            seekerTargetPos,
            boreCapsule,
            scatterBlastDone: ev.gadgetId === "quake_club",
            preImpactCritters,
            impactReleased: ev.gadgetId === "quake_club",
          };

          if (ev.gadgetId === "quake_club") {
            // Stay in Over-the-Shoulder / First Person to see Gale Scatter's wind-shotgun blast directly!
            this.vfx.spawnWindShotgunBlast(origin, aimDir, GALE_SCATTER_REACH);
            this.cameraRig.triggerShake(0.32, 0.22);
          } else {
            this.cameraRig.setShotCamActive(true);
          }
          break;
        }
        case "VINE_GRAPPLED": {
          const isPodPull = Boolean(ev.isPodPull);
          const glide = createGrappleAnimState(ev.from, ev.to, isPodPull);
          this.grappleGlides.set(ev.playerId, glide);
          if (ev.playerId !== localId) {
            this.audio.playLaunch("vine_grapple");
          } else {
            if (shouldExitDroneForGrapple(this.cameraRig.getMode())) {
              this.cameraRig.exitDroneRecon();
            }
            this.localPos.set(ev.from.x, ev.from.y, ev.from.z);
            this.localVel.set(0, 0, 0);
            if (!isPodPull) {
              this.localGrounded = false;
            }
            this.localTimeSinceGroundedSec = 0;
            this.backflipUsedThisJump = false;
            const finalTarget = isPodPull ? ev.from : ev.to;
            this.lastSyncedPos.set(finalTarget.x, finalTarget.y, finalTarget.z);
          }
          break;
        }
        case "WATER_RESCUED": {
          if (this.grappleGlides.has(ev.playerId)) {
            this.grappleGlides.delete(ev.playerId);
            this.vfx.setGrappleTether(ev.playerId, null);
          }
          this.vfx.spawnSplash({
            x: ev.position.x,
            y: this.matchState?.waterLevel ?? 1.8,
            z: ev.position.z,
          });
          this.audio.playSplash();
          this.spawnWorldPopup(
            { x: ev.position.x, y: ev.position.y + 1.4, z: ev.position.z },
            `RESCUE! -${Math.round(ev.damage)}`,
            "damage",
          );
          const rescued = this.matchState?.critters.find(
            (c) => c.id === ev.playerId,
          );
          const who = rescued ? rescued.name : "Critter";
          this.hud.showToast(
            `Parachute Rescue! ${who} pulled back ashore (-${Math.round(ev.damage)} HP)`,
            "info",
          );
          if (ev.playerId === localId) {
            this.localPos.set(ev.position.x, ev.position.y, ev.position.z);
            this.localVel.set(0, 0, 0);
            this.localGrounded = true;
            this.localTimeSinceGroundedSec = 0;
            this.backflipUsedThisJump = false;
            this.lastSyncedPos.copy(this.localPos);
          }
          break;
        }
        case "HAZARD_TRIGGERED": {
          if (ev.hazardType === "blast_barrel") {
            this.vfx.spawnBarrelExplosion(ev.position, 2.8);
            this.audio.playExplosion(2.8);
            this.cameraRig.triggerShake(0.9, 0.38);
            this.spawnWorldPopup(
              { x: ev.position.x, y: ev.position.y + 1.5, z: ev.position.z },
              "CHAIN BLAST!",
              "event",
            );
            this.hud.showToast("BOOM! Blast Barrel chain detonation!", "error");
          } else if (ev.hazardType === "spark_mine") {
            this.vfx.spawnBarrelExplosion(ev.position, 2.2);
            this.audio.playExplosion(2.2);
            this.cameraRig.triggerShake(0.7, 0.32);
            this.spawnWorldPopup(
              { x: ev.position.x, y: ev.position.y + 1.4, z: ev.position.z },
              "ZAP! -24",
              "damage",
            );
            this.hud.showToast("ZAP! Spark Mine proximity blast!", "error");
          } else if (ev.hazardType === "steam_geyser") {
            this.vfx.spawnGeyserBurst(ev.position);
            this.audio.playLaunch("vine_grapple");
            this.spawnWorldPopup(
              { x: ev.position.x, y: ev.position.y + 1.6, z: ev.position.z },
              "GEYSER!",
              "shield",
            );
            if (localId && ev.affectedCritterIds.includes(localId)) {
              this.localGrounded = false;
              this.localVel.y = this.activeWorld.mapScale === "grand" ? 13.5 : 10.5;
            }
            this.hud.showToast("WHOOSH! Thermal Geyser launch!", "info");
          } else if (ev.hazardType === "thorn_patch") {
            this.vfx.spawnExplosion(ev.position, 0.85, false);
            this.audio.playLaunch("quake_club");
            this.spawnWorldPopup(
              { x: ev.position.x, y: ev.position.y + 1.3, z: ev.position.z },
              "THORNS! -12",
              "damage",
            );
            this.hud.showToast("OUCH! Bramble Thorn snag (-12 HP)!", "error");
          }
          break;
        }
        case "EVO_POD_SPAWNED": {
          const kind = ev.pod.kind ?? "evo_dna";
          if (kind === "med_berry") {
            this.hud.showTurnBanner("MED-BERRY DROPPED!", "Grab it for +55 HP!", "pod");
          } else if (kind === "super_gadget") {
            this.hud.showTurnBanner("SUPER CRATE DROPPED!", "Rare Ordnance +25 Evo!", "pod");
          } else {
            this.hud.showTurnBanner("EVO POD DROPPED!", "Grab it to evolve!", "pod");
          }
          break;
        }
        case "EVO_POD_COLLECTED": {
          this.audio.playMutationChime();
          const collector = this.matchState?.critters.find(
            (c) => c.id === ev.playerId,
          );
          const kind = ev.podKind ?? "evo_dna";
          const bonusName = ev.bonusGadget
            ? GADGET_CATALOG[ev.bonusGadget].name
            : null;
          if (collector) {
            const popupPos: Vec3 = {
              x: collector.position.x,
              y: collector.position.y + 1.65,
              z: collector.position.z,
            };
            if (kind === "med_berry") {
              const healed = Math.round(ev.healedHp ?? 55);
              this.spawnWorldPopup(
                popupPos,
                healed > 0 ? `+${healed} HP!` : "MAX HP!",
                "heal",
              );
              this.hud.showToast(
                `${collector.name} grabbed a Med-Berry Crate (+${healed} HP)!`,
                "success",
              );
            } else if (kind === "super_gadget") {
              this.spawnWorldPopup(
                popupPos,
                bonusName ? `+${bonusName.toUpperCase()}!` : "SUPER CRATE!",
                "event",
              );
              this.hud.showToast(
                `${collector.name} grabbed a Super Crate${bonusName ? ` + ${bonusName}` : ""}!`,
                "success",
              );
            } else {
              this.spawnWorldPopup(popupPos, "+50 EVO!", "shield");
              this.hud.showToast(
                `${collector.name} grabbed an Evo Pod${bonusName ? ` + ${bonusName}` : ""}!`,
                "success",
              );
            }
          }
          break;
        }
        case "MUTATION_EQUIPPED": {
          if (shouldPlayEvolutionStinger(ev.playerId, localId)) {
            this.audio.playStinger("evolution", ev.apex !== null);
          }
          break;
        }
        case "COINS_EARNED": {
          if (ev.playerId === localId) {
            this.audio.playCoinEarned();
            const rig = this.critterRigs.get(ev.playerId);
            const c = this.matchState?.critters.find((cr) => cr.id === ev.playerId);
            const anchor: Vec3 = rig
              ? {
                  x: rig.root.position.x,
                  y: rig.root.position.y + 1.9,
                  z: rig.root.position.z,
                }
              : c
                ? {
                    x: c.position.x,
                    y: c.position.y + 1.9,
                    z: c.position.z,
                  }
                : {
                    x: this.localPos.x,
                    y: this.localPos.y + 1.9,
                    z: this.localPos.z,
                  };
            this.spawnWorldPopup(anchor, `+${Math.round(ev.amount)} 🪙`, "event");
          }
          break;
        }
        case "ABILITY_PURCHASED": {
          if (ev.playerId === localId) {
            this.audio.playShopBuy();
            this.audio.playStinger("purchase");
            const name = GADGET_CATALOG[ev.gadgetId].name;
            if (ev.isRefill) {
              this.hud.showToast(
                `Refilled ${name} (-${ev.cost} 🪙)`,
                "success",
              );
            } else if (ev.replacedGadgetId) {
              const oldName = GADGET_CATALOG[ev.replacedGadgetId].name;
              const costText =
                ev.cost > 0
                  ? `Net -${ev.cost} 🪙`
                  : ev.cost < 0
                    ? `+${Math.abs(ev.cost)} 🪙 back`
                    : "Even swap";
              this.hud.showToast(
                `Swapped ${oldName} → ${name} (${costText})`,
                "success",
              );
            } else {
              this.hud.showToast(
                `Equipped ${name} (-${ev.cost} 🪙)`,
                "success",
              );
            }
          }
          break;
        }
        case "ABILITY_HEALED": {
          this.audio.playHealChime();
          const healedCritter = this.matchState?.critters.find(
            (c) => c.id === ev.playerId,
          );
          const rig = this.critterRigs.get(ev.playerId);
          const pos: Vec3 = rig
            ? {
                x: rig.root.position.x,
                y: rig.root.position.y + 1.65,
                z: rig.root.position.z,
              }
            : healedCritter
              ? {
                  x: healedCritter.position.x,
                  y: healedCritter.position.y + 1.65,
                  z: healedCritter.position.z,
                }
              : {
                  x: this.localPos.x,
                  y: this.localPos.y + 1.65,
                  z: this.localPos.z,
                };
          this.spawnWorldPopup(pos, `+${Math.round(ev.amount)} HP!`, "heal");
          const who = healedCritter ? healedCritter.name : "Critter";
          this.hud.showToast(
            `${who} used Mend Brew (+${Math.round(ev.amount)} HP)!`,
            "success",
          );
          break;
        }
        case "FINAL_FLOOD_STARTED": {
          this.audio.playFloodRumble();
          this.audio.playStinger("flood_alarm");
          this.cameraRig.triggerShake(1.1, 1.0);
          this.hud.setArmoryOpen(false);
          this.input.exitPointerLock();
          this.hud.showTurnBanner(
            "FINAL DELUGE!",
            "The ocean is swallowing the island!",
            "retreat",
          );
          break;
        }
        case "CRITTER_ENGULFED": {
          this.vfx.spawnSplash({
            x: ev.position.x,
            y: ev.waterLevel,
            z: ev.position.z,
          });
          this.audio.playSplash();
          this.audio.playStinger("ko");
          this.spawnWorldPopup(
            { x: ev.position.x, y: ev.waterLevel + 1.4, z: ev.position.z },
            "ENGULFED!",
            "damage",
          );
          const victim = this.matchState?.critters.find(
            (c) => c.id === ev.playerId,
          );
          const who = victim ? victim.name : "Critter";
          this.hud.showToast(
            `${who} was engulfed by the rising ocean!`,
            "error",
          );
          break;
        }
        case "WATER_ROSE": {
          this.audio.playSplash();
          this.hud.showToast("Sudden Death! Ocean tide is rising!", "error");
          break;
        }
        case "WIND_NUDGED": {
          this.audio.playUiClick();
          this.hud.showToast("Spectator Drone shifted the island wind!", "info");
          break;
        }
        case "ROUND_ENDED": {
          this.audio.playStinger("round_end");
          this.hud.showToast(
            `Round ${ev.round} winner: ${ev.winnerLabel}`,
            "success",
          );
          break;
        }
        case "PRISM_WALL_DEPLOYED": {
          this.audio.playMutationChime();
          this.hud.showToast(
            "Prism Wall deployed — blocks incoming fire!",
            "success",
          );
          break;
        }
        case "PRISM_WALL_SHATTERED": {
          if (
            hasBatchPrismIntercept ||
            this.shotPlayback !== null
          ) {
            // Defer shatter VFX, sound, popup, and toast to exact impact arrival in advanceShotPlayback
            break;
          }
          this.vfx.spawnPrismShatter(ev.position);
          this.audio.playMutationChime();
          this.cameraRig.triggerShake(0.35, 0.22);
          this.spawnWorldPopup(
            { x: ev.position.x, y: ev.position.y + 1.8, z: ev.position.z },
            "SHIELD BLOCKED!",
            "shield",
          );
          this.hud.showToast("Prism Wall intercepted & shattered!", "info");
          break;
        }
        default:
          break;
      }
    }
  }

  private spawnWorldPopup(
    worldPos: Vec3,
    text: string,
    tone: "damage" | "heal" | "shield" | "event",
  ): void {
    const projected = this.popupProjVec
      .set(worldPos.x, worldPos.y, worldPos.z)
      .project(this.cameraRig.camera);
    if (
      !Number.isFinite(projected.x) ||
      !Number.isFinite(projected.y) ||
      !Number.isFinite(projected.z) ||
      projected.z < -1 ||
      projected.z > 1 ||
      Math.abs(projected.x) > 1.15 ||
      Math.abs(projected.y) > 1.15
    ) {
      return;
    }
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const screenX = (projected.x * 0.5 + 0.5) * width;
    const screenY = (-projected.y * 0.5 + 0.5) * height;
    this.hud.spawnFloatingPopup(text, screenX, screenY, tone);
  }

  private flushPendingCarves(state: MatchState): void {
    if (state.carveLog.length <= this.appliedCarveCount) {
      return;
    }
    const dirty = new Set<string>();
    for (let i = this.appliedCarveCount; i < state.carveLog.length; i++) {
      const op = state.carveLog[i];
      if (!op) continue;
      for (const key of this.activeWorld.applyCarve(op)) {
        dirty.add(key);
      }
    }
    this.appliedCarveCount = state.carveLog.length;
    if (dirty.size > 0) {
      const dirtyList = Array.from(dirty);
      this.terrainRenderer.rebuildChunks(this.activeWorld, dirtyList);
      this.environmentProps.pruneAfterCarve(this.activeWorld, state.waterLevel);
      if (dirtyList.some((key) => key.includes(",0,"))) {
        this.worldScene.updateShorelineFromWorld(this.activeWorld, state.waterLevel);
        this.lastShorelineWaterLevel = state.waterLevel;
      }
    }
  }

  private handleFireAction(power: number): void {
    const state = this.matchState;
    const localId = this.gameClient.getPlayerId();
    if (!state || !localId || state.phase !== "ACTIVE" || state.activePlayerId !== localId) {
      return;
    }
    const localCritter = state.critters.find((c) => c.id === localId);
    if (!localCritter || !localCritter.alive) {
      return;
    }

    const gadgetDef = GADGET_CATALOG[this.selectedGadget];
    if (gadgetDef.requiresDronePing && !this.dronePing) {
      this.hud.showToast(
        "Press [TAB] Drone Recon and click the island to ping a Seeker Firefly target!",
        "error",
      );
      return;
    }

    // Flush exact current position right before firing so server/engine matches visual origin
    const moveSnap = this.input.update(0);
    this.gameClient.sendMove(
      { x: this.localPos.x, y: this.localPos.y, z: this.localPos.z },
      moveSnap.yaw,
      moveSnap.pitch,
      { x: 0, y: 0, z: 0 },
    );

    const dir = computeAimDirection(moveSnap.yaw, moveSnap.pitch);
    if (gadgetDef.turnEnding && this.selectedGadget !== "quake_club") {
      this.lastLocalShotAim = {
        gadgetId: this.selectedGadget,
        yaw: moveSnap.yaw,
        pitch: moveSnap.pitch,
        power,
      };
    }
    this.quickStartFired = true;
    this.gameClient.sendFire(
      this.selectedGadget,
      dir,
      power,
      this.dronePing ?? undefined,
    );
  }

  private handleUtilityAction(): void {
    const state = this.matchState;
    const localId = this.gameClient.getPlayerId();
    if (!state || !localId || state.phase !== "ACTIVE" || state.activePlayerId !== localId) {
      return;
    }
    const localCritter = state.critters.find((c) => c.id === localId);
    if (!localCritter || !localCritter.alive) {
      return;
    }

    const utilityGadget: GadgetId =
      this.selectedGadget === "prism_wall"
        ? "prism_wall"
        : this.selectedGadget === "mend_brew"
          ? "mend_brew"
          : "vine_grapple";

    if (!localCritter.loadout.includes(utilityGadget)) {
      return;
    }
    const charges = localCritter.gadgetCharges[utilityGadget];
    if (charges !== null && charges <= 0) {
      return;
    }

    if (utilityGadget === "vine_grapple" && localCritter.grappleUsedThisTurn) {
      this.hud.showToast("Vine Grapple already used this turn!", "info");
      return;
    }
    if (utilityGadget === "mend_brew" && localCritter.hp >= localCritter.maxHp) {
      this.hud.showToast("Already at full HP!", "info");
      return;
    }

    const moveSnap = this.input.update(0);
    // Sync current local position before grappling/placing cover/healing
    this.gameClient.sendMove(
      { x: this.localPos.x, y: this.localPos.y, z: this.localPos.z },
      moveSnap.yaw,
      moveSnap.pitch,
      { x: 0, y: 0, z: 0 },
    );

    const dir = computeAimDirection(moveSnap.yaw, moveSnap.pitch);
    if (utilityGadget !== "mend_brew") {
      this.audio.playLaunch(utilityGadget);
    }
    this.gameClient.sendUtility(utilityGadget, dir);
  }

  private handleRetreatBurrow(): void {
    const state = this.matchState;
    const localId = this.gameClient.getPlayerId();
    if (
      !state ||
      !localId ||
      state.activePlayerId !== localId ||
      (state.phase !== "ACTIVE" && state.phase !== "RETREAT")
    ) {
      return;
    }
    const localCritter = state.critters.find((c) => c.id === localId);
    if (!localCritter || !localCritter.alive) {
      return;
    }
    const moveSnap = this.input.update(0);
    if (
      localCritter.apex === "sky_bomber" &&
      !localCritter.skyBomberDropUsedThisTurn
    ) {
      this.gameClient.sendMove(
        { x: this.localPos.x, y: this.localPos.y, z: this.localPos.z },
        moveSnap.yaw,
        moveSnap.pitch,
        { x: 0, y: 0, z: 0 },
      );
      this.audio.playLaunch("gale_mortar");
      this.gameClient.sendUtility("sky_bomber_drop", { x: 0, y: -1, z: 0 });
      this.hud.showToast("Sky Bomber air-drop away!", "success");
      return;
    }
    if (state.phase === "RETREAT") {
      if (localCritter.equipped.offense === "burrow_claws") {
        if (localCritter.retreatBurrowUsedThisTurn) {
          this.hud.showToast("Retreat foxhole already dug this turn!", "info");
          return;
        }
        this.gameClient.sendMove(
          { x: this.localPos.x, y: this.localPos.y, z: this.localPos.z },
          moveSnap.yaw,
          moveSnap.pitch,
          { x: 0, y: 0, z: 0 },
        );
        const dir = computeAimDirection(
          moveSnap.yaw,
          Math.min(-0.1, moveSnap.pitch),
        );
        this.audio.playLaunch("burrow_bore");
        this.gameClient.sendRetreatBurrow(dir);
        return;
      }
      this.hud.showToast(
        "Equip Burrow Claws or Sky Bomber Apex for [F] Special!",
        "info",
      );
    }
  }

  private handleDroneNudge(dir: Vec3): void {
    const state = this.matchState;
    const localId = this.gameClient.getPlayerId();
    if (!state || !localId) return;
    const localCritter = state.critters.find((c) => c.id === localId);
    if (!localCritter || localCritter.alive || localCritter.droneNudgeUsedThisTurn) {
      return;
    }
    this.gameClient.sendDroneNudge({ x: dir.x * 1.5, y: 0, z: dir.z * 1.5 });
  }

  private collectLiveCritterPositions(): Map<string, Vec3> {
    const positions = new Map<string, Vec3>();
    for (const [id, rig] of this.critterRigs.entries()) {
      positions.set(id, {
        x: rig.root.position.x,
        y: rig.root.position.y,
        z: rig.root.position.z,
      });
    }
    return positions;
  }

  private handleDronePing(
    point: Vec3 | null,
    rayOrigin: Vec3,
    rayDir: Vec3,
  ): void {
    const state = this.matchState;
    const localId = this.gameClient.getPlayerId();
    const resolved = resolveDronePingTarget(
      point,
      rayOrigin,
      rayDir,
      state?.critters ?? [],
      localId,
      this.collectLiveCritterPositions(),
    );
    if (!resolved) {
      return;
    }
    this.dronePing = {
      x: resolved.point.x,
      y: resolved.point.y,
      z: resolved.point.z,
    };
    this.dronePingCritterId = resolved.lockedCritterId;
    this.vfx.setDronePing(
      this.dronePing,
      this.selectedGadget === "seeker_firefly",
    );
    this.audio.playUiClick();
    if (resolved.lockedCritterName) {
      this.hud.showToast(`GPS Lock: ${resolved.lockedCritterName}!`, "success");
    } else {
      this.hud.showToast(
        "Drone target ping locked for Seeker Firefly!",
        "success",
      );
    }
  }

  private handleDronePingCritter(critterId: string): void {
    const state = this.matchState;
    const localId = this.gameClient.getPlayerId();
    if (!state || critterId === localId) {
      return;
    }
    const critter = state.critters.find((c) => c.id === critterId && c.alive);
    if (!critter) {
      return;
    }
    const rig = this.critterRigs.get(critter.id);
    const pos: Vec3 = rig
      ? {
          x: rig.root.position.x,
          y: rig.root.position.y,
          z: rig.root.position.z,
        }
      : critter.position;
    this.dronePing = { x: pos.x, y: pos.y + 0.4, z: pos.z };
    this.dronePingCritterId = critter.id;
    this.vfx.setDronePing(
      this.dronePing,
      this.selectedGadget === "seeker_firefly",
    );
    this.audio.playUiClick();
    this.hud.showToast(`GPS Lock: ${critter.name}!`, "success");
  }

  private selectGadgetByIndex(index: number): void {
    if (!this.matchState) return;
    const localId = this.gameClient.getPlayerId();
    const localCritter = this.matchState.critters.find((c) => c.id === localId);
    if (!localCritter) return;

    const picked = localCritter.loadout[index];
    if (!picked) return;
    const charges = localCritter.gadgetCharges[picked];
    if (charges !== null && charges <= 0) {
      return;
    }
    this.audio.playUiClick();
    this.selectedGadget = picked;
    this.input.setSelectedGadget(picked);
  }

  private loop(nowMs: number): void {
    this.rafId = requestAnimationFrame((t) => this.loop(t));

    const dtSec = Math.min(0.05, Math.max(0.001, (nowMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = nowMs;
    this.elapsedSec += dtSec;

    this.worldScene.update(dtSec, this.elapsedSec);
    this.vfx.update(dtSec, this.elapsedSec);

    if (!this.inMatch || !this.matchState) {
      this.updateLobbyBackdrop(dtSec);
      this.worldScene.setShadowFocus(this.shadowFocusPos);
      this.worldScene.render(this.cameraRig.camera);
      return;
    }

    this.updateActiveMatchFrame(dtSec, nowMs);
    this.worldScene.setShadowFocus(this.shadowFocusPos);
    this.worldScene.render(this.cameraRig.camera);
  }

  private updateLobbyBackdrop(dtSec: number): void {
    this.updateAdaptiveMusicMood();
    const previewWind: Vec3 = { x: 2.4, y: 0, z: 1.1 };
    this.vfx.updateWindRibbons(previewWind, dtSec);
    this.environmentProps.updateWind(previewWind, this.elapsedSec);
    this.environmentProps.syncHazards(this.previewHazards, this.elapsedSec);
    this.shadowFocusPos = this.lobbyHeroPos;

    // Frame the rotating 3D GLB showcase hero critter on the right-center sunlit ridge
    // with the sweeping sculpted island, trees, arches, and ocean stretching behind it!
    const hero = this.lobbyHeroPos;
    const toCenterX = this.activeWorld.centerX - hero.x;
    const toCenterZ = this.activeWorld.centerZ - hero.z;
    const toCenterLen = Math.hypot(toCenterX, toCenterZ);
    const baseDirX = toCenterLen > 0.1 ? toCenterX / toCenterLen : 0.7;
    const baseDirZ = toCenterLen > 0.1 ? toCenterZ / toCenterLen : -0.7;

    // Gentle cinematic sway around the outward ocean vantage
    const sway = Math.sin(this.elapsedSec * 0.24) * 0.22;
    const cosS = Math.cos(sway);
    const sinS = Math.sin(sway);
    const dirX = baseDirX * cosS - baseDirZ * sinS;
    const dirZ = baseDirX * sinS + baseDirZ * cosS;

    // Right vector in Three.js (+Y up) = forward x up = (-dirZ, 0, dirX)
    const rightX = -dirZ;
    const rightZ = dirX;

    const camDist = 5.4;
    const camX = hero.x - dirX * camDist + rightX * 0.35;
    const camZ = hero.z - dirZ * camDist + rightZ * 0.35;
    const rawCamY = hero.y + 2.05 + Math.sin(this.elapsedSec * 0.45) * 0.12;
    const camGroundY = this.activeWorld.getSurfaceY(camX, camZ);
    const camY = Math.max(rawCamY, (camGroundY ?? 0) + 1.6);
    this.cameraRig.camera.position.set(camX, camY, camZ);

    // Shift look target slightly left so the hero sits cleanly clear of the floating left dock
    this.cameraRig.camera.lookAt(
      hero.x - rightX * 0.95 + dirX * 1.4,
      hero.y + 0.92,
      hero.z - rightZ * 0.95 + dirZ * 1.4,
    );

    const heroRig = this.critterRigs.get("preview-hero");
    if (heroRig) {
      const faceCamYaw = Math.atan2(camX - hero.x, camZ - hero.z);
      heroRig.root.rotation.y = faceCamYaw + this.elapsedSec * 0.42;
    }

    for (const rig of this.critterRigs.values()) {
      rig.updateDropShadow(rig.root.position.y);
      rig.updateAnimation(dtSec, false, 0, false);
    }
  }

  private updateActiveMatchFrame(dtSec: number, nowMs: number): void {
    const state = this.matchState;
    if (!state) return;

    const localId = this.gameClient.getPlayerId();
    const localCritter =
      state.critters.find((c) => c.id === localId) ?? state.critters[0] ?? null;
    const activeCritter =
      state.critters.find((c) => c.id === state.activePlayerId) ??
      localCritter ??
      null;

    const isMyTurn = localId !== null && state.activePlayerId === localId;
    const localAlive = Boolean(localCritter?.alive);
    const armoryOpen = this.hud.isArmoryOpen();
    const canMove =
      !armoryOpen &&
      isMyTurn &&
      localAlive &&
      (state.phase === "ACTIVE" || state.phase === "RETREAT");
    const canFire =
      !armoryOpen && isMyTurn && localAlive && state.phase === "ACTIVE";
    const camMode: CameraMode = this.cameraRig.getMode();
    const isDroneMode =
      camMode === "drone_recon" || camMode === "spectator_drone";

    this.input.setCanAct(canMove, canFire, isDroneMode);
    this.input.setSelectedGadget(this.selectedGadget);
    const moveInput = this.input.update(dtSec);

    if (canMove && (moveInput.forward !== 0 || moveInput.right !== 0)) {
      this.quickStartMoved = true;
    }

    // Subtle charge sound ticks while holding fire power
    if (moveInput.charging && nowMs - this.lastChargeTickMs >= 115) {
      this.lastChargeTickMs = nowMs;
      this.audio.playChargeTick(moveInput.chargePower);
    }

    // Turn & retreat countdown audio cues on local active turn
    const countdown = evaluateCountdownCue(
      state.phase,
      canMove,
      state.phaseTimeRemainingSec,
      this.lastCountdownKey,
    );
    this.lastCountdownKey = countdown.nextKey;
    switch (countdown.cue) {
      case "active_tick":
        this.audio.playTurnTick(false);
        break;
      case "active_tick_urgent":
        this.audio.playTurnTick(true);
        break;
      case "retreat_beep":
        this.audio.playRetreatBeep(false);
        break;
      case "retreat_beep_urgent":
        this.audio.playRetreatBeep(true);
        break;
      default:
        break;
    }

    // Update Shot Cam projectile flight animation
    const shotPos = this.advanceShotPlayback(dtSec, state);

    // Keep locked rival GPS ping synced while the rival is still moving (e.g. during their turn/RETREAT)
    if (
      this.dronePingCritterId !== null &&
      !isShotVisualFreezeActive(this.shotPlayback)
    ) {
      const lockedRival = state.critters.find(
        (c) => c.id === this.dronePingCritterId && c.alive,
      );
      if (!lockedRival) {
        this.dronePingCritterId = null;
      } else if (
        !isMyTurn ||
        (state.phase === "RETREAT" &&
          state.activePlayerId === this.dronePingCritterId)
      ) {
        const lockedRig = this.critterRigs.get(lockedRival.id);
        const lockedPos: Vec3 = lockedRig
          ? {
              x: lockedRig.root.position.x,
              y: lockedRig.root.position.y,
              z: lockedRig.root.position.z,
            }
          : lockedRival.position;
        this.dronePing = {
          x: lockedPos.x,
          y: lockedPos.y + 0.4,
          z: lockedPos.z,
        };
      }
    }

    // Sync Seeker Firefly GPS target-lock crosshair mode vs standard Drone Recon ring
    const seekerLocked =
      (this.selectedGadget === "seeker_firefly" && this.dronePing !== null) ||
      this.shotPlayback?.gadgetId === "seeker_firefly";
    const pingTargetPos =
      this.shotPlayback?.gadgetId === "seeker_firefly"
        ? (this.shotPlayback.seekerTargetPos ?? this.dronePing)
        : this.dronePing;
    this.vfx.setDronePing(pingTargetPos, seekerLocked);

    // Advance two-stage Vine Grapple animations (0.20s hook launch -> latch spark+clink -> 0.55s pull/retract)
    const activeGlidePositions = new Map<string, Vec3>();
    if (this.grappleGlides.size > 0) {
      const completedGlides: string[] = [];
      for (const [id, glide] of this.grappleGlides.entries()) {
        const frame = stepGrappleAnim(glide, dtSec);
        if (frame.justLatched) {
          this.vfx.spawnGrappleLatchSpark(glide.to);
          this.audio.playGrappleLatch();
        }
        activeGlidePositions.set(id, frame.critterPos);
        if (id === localId) {
          this.localPos.set(
            frame.critterPos.x,
            frame.critterPos.y,
            frame.critterPos.z,
          );
        }
        if (frame.phase === "done") {
          completedGlides.push(id);
          this.vfx.setGrappleTether(id, null);
          if (id === localId) {
            this.localPos.set(
              frame.critterPos.x,
              frame.critterPos.y,
              frame.critterPos.z,
            );
            this.localVel.set(0, 0, 0);
            this.localGrounded = true;
            this.localTimeSinceGroundedSec = 0;
            this.backflipUsedThisJump = false;
            this.lastSyncedPos.copy(this.localPos);
          }
        } else {
          this.vfx.setGrappleTether(id, frame.tetherFrom, frame.tetherTo);
        }
      }
      for (const id of completedGlides) {
        this.grappleGlides.delete(id);
      }
    }

    const localIsGliding = localId !== null && activeGlidePositions.has(localId);

    // Smooth local critter kinematics (WASD + Auto-Hop + Double-Tap Space Backflip) + 15 Hz sync
    if (canMove && localCritter && !isDroneMode && !localIsGliding) {
      this.stepLocalCritterMovement(
        dtSec,
        nowMs,
        localCritter,
        state,
        moveInput.forward,
        moveInput.right,
        moveInput.jumpPressed,
        moveInput.backflipPressed,
        moveInput.glideHeld,
        moveInput.yaw,
        moveInput.pitch,
      );
    }

    // Sync VFX wind ribbons, wind-swayed foliage, Evo Pods, 3D Prism Walls, and animated interactive hazards
    this.vfx.updateWindRibbons(state.wind, dtSec);
    this.environmentProps.updateWind(state.wind, this.elapsedSec);
    this.vfx.syncEvoPods(state.evoPods, this.elapsedSec);
    this.vfx.syncPrismWalls(state.prismWalls ?? [], this.elapsedSec);
    this.environmentProps.syncHazards(state.hazards ?? [], this.elapsedSec);

    // Update Camera Rig first so first_person visibility is 100% in sync this frame
    const focusCritter =
      isMyTurn && localCritter
        ? localCritter
        : activeCritter ?? localCritter;
    const focusVisual = focusCritter
      ? resolveCritterVisualState(focusCritter, this.shotPlayback)
      : null;
    const focusPos: Vec3 =
      canMove && localCritter
        ? { x: this.localPos.x, y: this.localPos.y, z: this.localPos.z }
        : focusCritter
          ? activeGlidePositions.get(focusCritter.id) ??
            (focusVisual ? focusVisual.position : focusCritter.position)
          : { x: this.activeWorld.centerX, y: 9, z: this.activeWorld.centerZ };
    this.shadowFocusPos =
      state.phase === "RESOLVING" && shotPos ? shotPos : focusPos;
    const viewerYaw = canMove ? moveInput.yaw : focusCritter?.yaw ?? 0;

    this.cameraRig.update({
      targetPos: focusPos,
      yaw: viewerYaw,
      pitch: canMove ? moveInput.pitch : 0.15,
      phase: state.phase,
      localAlive,
      shotPos,
      world: this.activeWorld,
      dtSec,
      waterLevel: state.waterLevel,
    });

    this.updateAdaptiveMusicMood(moveInput.charging, moveInput.chargePower);

    const effectiveCamMode = this.cameraRig.getMode();
    const effectiveIsDroneMode =
      effectiveCamMode === "drone_recon" ||
      effectiveCamMode === "spectator_drone";
    const trackedCritterId = focusCritter?.id ?? localId;

    // Dynamically hide obstructing trees/boulders/landmarks along active aiming sightline
    if (
      canFire &&
      localCritter !== null &&
      !effectiveIsDroneMode &&
      effectiveCamMode !== "shot_cam"
    ) {
      const aimDir = computeAimDirection(moveInput.yaw, moveInput.pitch);
      this.environmentProps.updateAimOcclusion({
        cameraPos: {
          x: this.cameraRig.camera.position.x,
          y: this.cameraRig.camera.position.y,
          z: this.cameraRig.camera.position.z,
        },
        critterPos: focusPos,
        aimDir,
        maxRange: 22,
      });
    } else {
      this.environmentProps.updateAimOcclusion(null);
    }

    // Update all critter rigs + airborne ground contact shadow discs
    const livePositions = new Map<string, Vec3>();
    const droneBeacons: DroneBeaconInput[] = [];
    for (const c of state.critters) {
      const rig = this.critterRigs.get(c.id);
      if (!rig) continue;

      const visual = resolveCritterVisualState(c, this.shotPlayback);
      const isLocalControlled = canMove && c.id === localId;
      const glidePos = activeGlidePositions.get(c.id);
      let moving = false;
      let vy = 0;

      if (visual.frozen) {
        rig.root.position.set(
          visual.position.x,
          visual.position.y,
          visual.position.z,
        );
        rig.root.rotation.y = c.yaw;
      } else if (glidePos) {
        const prevX = rig.root.position.x;
        const prevY = rig.root.position.y;
        const prevZ = rig.root.position.z;
        rig.root.position.set(glidePos.x, glidePos.y, glidePos.z);
        rig.root.rotation.y = isLocalControlled ? moveInput.yaw : c.yaw;
        moving =
          Math.hypot(glidePos.x - prevX, glidePos.z - prevZ) > 0.005 ||
          Math.abs(glidePos.y - prevY) > 0.005;
        vy = (glidePos.y - prevY) / Math.max(0.016, dtSec);
      } else if (isLocalControlled) {
        rig.root.position.copy(this.localPos);
        rig.root.rotation.y = moveInput.yaw;
        moving =
          this.localMoveStamina > 0 &&
          (moveInput.forward !== 0 || moveInput.right !== 0);
        vy = this.localVel.y;
      } else {
        const lerpAlpha = 1 - Math.exp(-14 * dtSec);
        const dx = c.position.x - rig.root.position.x;
        const dy = c.position.y - rig.root.position.y;
        const dz = c.position.z - rig.root.position.z;
        moving = Math.hypot(dx, dz) > 0.04;
        vy = dy / Math.max(0.016, dtSec);
        rig.root.position.x += dx * lerpAlpha;
        rig.root.position.y += dy * lerpAlpha;
        rig.root.position.z += dz * lerpAlpha;
        rig.root.rotation.y = c.yaw;
      }

      if (visual.alive) {
        const livePos: Vec3 = {
          x: rig.root.position.x,
          y: rig.root.position.y,
          z: rig.root.position.z,
        };
        livePositions.set(c.id, livePos);
        droneBeacons.push({
          id: c.id,
          position: livePos,
          color: c.color,
          isLocal: localId !== null && c.id === localId,
          isActiveTurn: c.id === state.activePlayerId,
        });
      }

      rig.setHp(visual.hp, visual.maxHp, visual.alive);
      if (
        effectiveCamMode === "first_person" &&
        (c.id === trackedCritterId || c.id === localId)
      ) {
        rig.root.visible = false;
      } else {
        rig.root.visible = visual.alive;
      }
      if (rig.root.visible) {
        const shadowGroundY = findDropShadowGroundY(
          this.activeWorld,
          rig.root.position.x,
          rig.root.position.z,
          rig.root.position.y,
          state.waterLevel,
        );
        rig.updateDropShadow(shadowGroundY);
      }
      rig.applyMutations(c.equipped, c.apex);
      const aimPitch = isLocalControlled ? moveInput.pitch : c.pitch;
      rig.updateAnimation(
        dtSec,
        moving,
        vy,
        c.id === state.activePlayerId,
        aimPitch,
      );
    }

    // Sync 3D Drone View light pillars + project 2D floating callout markers
    this.vfx.syncDronePlayerBeacons(
      droneBeacons,
      effectiveIsDroneMode,
      this.elapsedSec,
    );
    const droneMarkers = effectiveIsDroneMode
      ? projectDroneMarkers(
          state.critters,
          localId,
          state.activePlayerId,
          this.cameraRig.camera,
          window.innerWidth,
          window.innerHeight,
          livePositions,
        )
      : undefined;

    // Update live 3D Trajectory Preview (ballistic arc, Gale Scatter cone, Vine Grapple latch, + Last-Shot Ghost)
    const gadgetDef = GADGET_CATALOG[this.selectedGadget];
    const grappleCharges = localCritter?.gadgetCharges.vine_grapple ?? 0;
    const showGrapplePreview =
      this.selectedGadget === "vine_grapple" &&
      localCritter !== null &&
      !localCritter.grappleUsedThisTurn &&
      (grappleCharges === null || grappleCharges > 0);
    const showArc =
      canFire &&
      localCritter !== null &&
      effectiveCamMode !== "drone_recon" &&
      effectiveCamMode !== "shot_cam" &&
      (gadgetDef.turnEnding || showGrapplePreview);

    if (showArc && localCritter) {
      const stats = computeCritterStats(localCritter.species, localCritter.equipped);
      const aimDir = computeAimDirection(moveInput.yaw, moveInput.pitch);
      const aimOrigin: Vec3 = {
        x: this.localPos.x,
        y: this.localPos.y + 0.6,
        z: this.localPos.z,
      };
      const showGhost =
        this.lastLocalShotAim !== null &&
        this.selectedGadget !== "quake_club" &&
        this.selectedGadget !== "vine_grapple";
      const ghostParams =
        showGhost && this.lastLocalShotAim
          ? {
              gadgetId: this.lastLocalShotAim.gadgetId,
              origin: aimOrigin,
              direction: computeAimDirection(
                this.lastLocalShotAim.yaw,
                this.lastLocalShotAim.pitch,
              ),
              power: this.lastLocalShotAim.power,
              ...(this.dronePing ? { droneTarget: this.dronePing } : {}),
            }
          : null;
      const baseGrappleReach = state.mapScale === "grand" ? 26.0 : 18.0;
      const grappleReach = baseGrappleReach * stats.grappleReachBonus;
      this.trajectoryPreview.update(
        this.activeWorld,
        {
          gadgetId: this.selectedGadget,
          origin: aimOrigin,
          direction: aimDir,
          power: moveInput.charging ? moveInput.chargePower : 0.58,
          ...(this.dronePing ? { droneTarget: this.dronePing } : {}),
          grappleReach,
          waterLevel: state.waterLevel,
          evoPods: state.evoPods,
        },
        state.wind,
        stats.extendedTrajectory,
        true,
        ghostParams,
        state.prismWalls,
        localId ?? undefined,
      );
    } else {
      this.trajectoryPreview.update(
        this.activeWorld,
        {
          gadgetId: "gale_mortar",
          origin: focusPos,
          direction: { x: 0, y: 1, z: 0 },
          power: 0.5,
        },
        state.wind,
        false,
        false,
        null,
      );
    }

    // Compute directional compass pips for nearest rival & Evo Pod
    const compass = this.computeCompassState(
      state,
      localCritter,
      focusPos,
      viewerYaw,
    );
    const showQuickStartHint =
      isMyTurn &&
      state.phase === "ACTIVE" &&
      state.turnNumber <= 2 &&
      !(this.quickStartMoved && this.quickStartFired);

    // Update In-Game HUD
    this.hud.updateGameHud({
      matchState: state,
      localPlayerId: localId,
      cameraMode: effectiveCamMode,
      selectedGadget: this.selectedGadget,
      charging: moveInput.charging,
      chargePower: moveInput.chargePower,
      muted: this.audio.isMuted(),
      musicMuted: this.audio.isMusicMuted(),
      armoryOpen,
      dronePingActive: this.dronePing !== null,
      essenceBreakdown: this.essenceBreakdown,
      showQuickStartHint,
      compass,
      pointerLocked: this.input.isPointerLocked(),
      canFire,
      localMoveStamina: isMyTurn
        ? this.localMoveStamina
        : localCritter?.moveStamina,
      ...(droneMarkers ? { droneMarkers } : {}),
    });
  }

  private updateAdaptiveMusicMood(
    isCharging = false,
    chargePower = 0,
  ): void {
    const ctx = deriveMusicGameplayContext({
      inMatch: this.inMatch,
      matchState: this.matchState,
      lobbyTheme: this.previewTheme,
      localPlayerId: this.gameClient.getPlayerId(),
      armoryOpen: this.hud.isArmoryOpen(),
      isCharging,
      chargePower,
      isShotFlight: this.shotPlayback !== null,
      cameraMode: this.cameraRig.getMode(),
    });
    if (!hasMusicContextChanged(this.lastMusicContext, ctx)) {
      return;
    }
    this.lastMusicContext = ctx;
    this.audio.setMusicContext(ctx);
  }

  private advanceShotPlayback(dtSec: number, state: MatchState): Vec3 | null {
    const pb = this.shotPlayback;
    if (!pb) {
      return null;
    }

    if ((pb.hitStopSec ?? 0) > 0) {
      pb.hitStopSec = Math.max(0, (pb.hitStopSec ?? 0) - dtSec);
    } else {
      pb.elapsedSec += dtSec;
    }

    const t = Math.max(0, Math.min(1, pb.elapsedSec / pb.durationSec));
    const idxFloat = t * Math.max(0, pb.path.length - 1);
    const i0 = Math.floor(idxFloat);
    const i1 = Math.min(pb.path.length - 1, i0 + 1);
    const frac = idxFloat - i0;
    const p0 = pb.path[i0] ?? {
      x: this.activeWorld.centerX,
      y: 10,
      z: this.activeWorld.centerZ,
    };
    const p1 = pb.path[i1] ?? p0;

    const currentPos: Vec3 = {
      x: p0.x + (p1.x - p0.x) * frac,
      y: p0.y + (p1.y - p0.y) * frac,
      z: p0.z + (p1.z - p0.z) * frac,
    };

    const dir = normalizeVec3(
      {
        x: p1.x - p0.x,
        y: p1.y - p0.y,
        z: p1.z - p0.z,
      },
      pb.aimDir,
    );

    const inFlight = pb.elapsedSec < pb.durationSec;

    // Progressive 6-slice Burrow Bore capsule carving strictly inside the authoritative capsuleOp envelope
    let boring = false;
    if (
      pb.gadgetId === "burrow_bore" &&
      pb.boreCapsule &&
      inFlight &&
      pb.elapsedSec >= pb.boreCapsule.startSec
    ) {
      boring = true;
      const cap = pb.boreCapsule;
      const boreSpan = Math.max(0.05, pb.durationSec - cap.startSec);
      const boreT = Math.max(
        0,
        Math.min(1, (pb.elapsedSec - cap.startSec) / boreSpan),
      );
      const targetSlice = Math.min(6, Math.floor(boreT * 6) + 1);
      if (targetSlice > cap.slicedCount) {
        const boreDir = normalizeVec3(
          {
            x: cap.end.x - cap.center.x,
            y: cap.end.y - cap.center.y,
            z: cap.end.z - cap.center.z,
          },
          dir,
        );
        const dirty = new Set<string>();
        let lastSliceEnd: Vec3 = cap.center;
        for (let s = cap.slicedCount; s < targetSlice; s++) {
          const f0 = s / 6;
          const f1 = (s + 1) / 6;
          const sliceStart: Vec3 = {
            x: cap.center.x + (cap.end.x - cap.center.x) * f0,
            y: cap.center.y + (cap.end.y - cap.center.y) * f0,
            z: cap.center.z + (cap.end.z - cap.center.z) * f0,
          };
          const sliceEnd: Vec3 = {
            x: cap.center.x + (cap.end.x - cap.center.x) * f1,
            y: cap.center.y + (cap.end.y - cap.center.y) * f1,
            z: cap.center.z + (cap.end.z - cap.center.z) * f1,
          };
          lastSliceEnd = sliceEnd;
          for (const key of this.activeWorld.applyCarve({
            shape: "capsule",
            center: sliceStart,
            end: sliceEnd,
            radius: cap.radius,
          })) {
            dirty.add(key);
          }
        }
        cap.slicedCount = targetSlice;
        if (dirty.size > 0) {
          const dirtyList = Array.from(dirty);
          this.terrainRenderer.rebuildChunks(this.activeWorld, dirtyList);
          this.environmentProps.pruneAfterCarve(
            this.activeWorld,
            state.waterLevel,
          );
          if (dirtyList.some((key) => key.includes(",0,"))) {
            this.worldScene.updateShorelineFromWorld(
              this.activeWorld,
              state.waterLevel,
            );
            this.lastShorelineWaterLevel = state.waterLevel;
          }
        }
        this.vfx.spawnBoreDebris(lastSliceEnd, boreDir);
        this.cameraRig.triggerShake(0.18, 0.14);
        const nowMs = performance.now();
        if (nowMs - cap.lastGrindMs >= 70) {
          cap.lastGrindMs = nowMs;
          this.audio.playDrillGrindTick();
        }
      }
    }

    if (pb.gadgetId === "quake_club") {
      this.vfx.setProjectileVisual(null);
    } else {
      this.vfx.setProjectileVisual(
        inFlight ? currentPos : null,
        GADGET_COLORS[pb.gadgetId],
        {
          gadgetId: pb.gadgetId,
          direction: dir,
          boring,
          targetPos: pb.seekerTargetPos ?? null,
          dtSec,
        },
      );
    }

    const releaseImpactFreeze = (): void => {
      if (pb.impactReleased) {
        return;
      }
      releaseShotVisualFreeze(pb);
      const localId = this.gameClient.getPlayerId();
      if (localId && pb.hits?.some((h) => h.critterId === localId)) {
        const localC = state.critters.find((c) => c.id === localId);
        if (localC) {
          this.localPos.set(
            localC.position.x,
            localC.position.y,
            localC.position.z,
          );
          this.localVel.set(0, 0, 0);
          this.lastSyncedPos.copy(this.localPos);
        }
      }
    };

    const emitHitPopups = (): void => {
      releaseImpactFreeze();
      if (pb.hitsPopupsDone || !pb.hits || pb.hits.length === 0) {
        return;
      }
      pb.hitsPopupsDone = true;
      if (pb.hits.some((h) => h.knockedOut)) {
        this.audio.playStinger("ko");
      }
      for (const hit of pb.hits) {
        const rig = this.critterRigs.get(hit.critterId);
        const anchor = rig
          ? {
              x: rig.root.position.x,
              y: rig.root.position.y + 1.5,
              z: rig.root.position.z,
            }
          : {
              x: hit.newPosition.x,
              y: hit.newPosition.y + 1.5,
              z: hit.newPosition.z,
            };
        if (hit.shieldAbsorbed) {
          this.spawnWorldPopup(anchor, "SHIELD!", "shield");
        } else if (hit.damage > 0) {
          this.spawnWorldPopup(anchor, `-${Math.round(hit.damage)}`, "damage");
        }
      }
    };

    const triggerImpact = (imp: ScheduledImpact): void => {
      imp.triggered = true;
      releaseImpactFreeze();
      if (pb.isPrismIntercept && imp.carveOp === null && imp.baseDamage === 0) {
        this.vfx.spawnPrismShatter(imp.position);
        this.audio.playMutationChime();
        this.cameraRig.triggerShake(0.35, 0.22);
        this.spawnWorldPopup(
          { x: imp.position.x, y: imp.position.y + 1.2, z: imp.position.z },
          "SHIELD BLOCKED!",
          "shield",
        );
        this.hud.showToast("Prism Wall intercepted & shattered!", "info");
        return;
      }
      this.flushPendingCarves(state);
      if (pb.gadgetId === "quake_club") {
        // Gale Scatter uses its directional wind-shotgun blast rather than a generic round explosion sphere
        this.cameraRig.triggerShake(0.18, 0.16);
        emitHitPopups();
        return;
      }
      const blastRadius =
        imp.carveOp?.radius ?? Math.max(1.2, imp.damageRadius * 0.65);
      this.vfx.spawnExplosion(imp.position, blastRadius, Boolean(imp.isPull));
      this.audio.playExplosion(blastRadius);
      this.cameraRig.triggerShake(
        Math.min(1.15, 0.25 + blastRadius * 0.22),
        0.34,
      );
      if (blastRadius >= 1.8) {
        pb.hitStopSec = Math.max(pb.hitStopSec ?? 0, 0.055);
      }
      emitHitPopups();
    };

    for (const imp of pb.impacts) {
      if (!imp.triggered && pb.elapsedSec >= imp.time) {
        triggerImpact(imp);
      }
    }

    if (!inFlight && !pb.splashesDone) {
      pb.splashesDone = true;
      releaseImpactFreeze();
      this.flushPendingCarves(state);
      for (const imp of pb.impacts) {
        if (!imp.triggered) {
          triggerImpact(imp);
        }
      }
      emitHitPopups();
      for (const dp of pb.drownedPositions) {
        this.vfx.spawnSplash({ x: dp.x, y: state.waterLevel, z: dp.z });
        this.audio.playSplash();
      }
    }

    if (
      pb.elapsedSec >= pb.durationSec + pb.holdAfterSec ||
      (!pb.allowOutsideResolving && state.phase !== "RESOLVING")
    ) {
      releaseImpactFreeze();
      emitHitPopups();
      this.flushPendingCarves(state);
      this.vfx.setProjectileVisual(null);
      this.shotPlayback = null;
      this.cameraRig.setShotCamActive(false);
      return null;
    }

    return pb.gadgetId === "quake_club" ? null : currentPos;
  }

  private stepLocalCritterMovement(
    dtSec: number,
    nowMs: number,
    critter: CritterState,
    state: MatchState,
    forward: number,
    right: number,
    jumpPressed: boolean,
    backflipPressed: boolean,
    glideHeld: boolean,
    yaw: number,
    pitch: number,
  ): void {
    const stats = computeCritterStats(critter.species, critter.equipped);
    const isRetreat = state.phase === "RETREAT";
    const speedMult = isRetreat ? stats.retreatRollBoost : 1.0;
    const moveSpeed = stats.moveSpeed * speedMult;

    const budgetDist = Math.max(
      1.0,
      isRetreat
        ? computeRetreatMoveDistance(
            state.mapScale,
            critter.species,
            critter.equipped,
          )
        : computeMaxMoveDistance(
            state.mapScale,
            critter.species,
            critter.equipped,
          ),
    );
    const staminaScale = isRetreat ? 40 : 100;

    if (this.localGrounded) {
      this.localTimeSinceGroundedSec = 0;
    } else {
      this.localTimeSinceGroundedSec += dtSec;
    }

    let moveX = 0;
    let moveZ = 0;
    if (forward !== 0 || right !== 0) {
      if (this.localMoveStamina > 0) {
        const fwdX = Math.sin(yaw);
        const fwdZ = Math.cos(yaw);
        const rightX = -Math.cos(yaw);
        const rightZ = Math.sin(yaw);
        moveX = fwdX * forward + rightX * right;
        moveZ = fwdZ * forward + rightZ * right;
        const len = Math.hypot(moveX, moveZ);
        if (len > 1e-4) {
          const control = this.localGrounded ? 1.0 : Math.max(0.45, stats.airControl);
          moveX = (moveX / len) * moveSpeed * control;
          moveZ = (moveZ / len) * moveSpeed * control;
        }
      } else if (state.phase === "ACTIVE" && !this.staminaSpentToastShown) {
        this.staminaSpentToastShown = true;
        this.hud.showToast(
          "Move stamina spent — Aim, Grapple, or Fire!",
          "info",
        );
      }
    }

    // Combine airborne backflip momentum with player directional input
    const totalVx = this.localGrounded ? moveX : moveX + this.localVel.x;
    const totalVz = this.localGrounded ? moveZ : moveZ + this.localVel.z;

    const prevX = this.localPos.x;
    const prevZ = this.localPos.z;
    const remainingDist = Math.max(
      0,
      (this.localMoveStamina / staminaScale) * budgetDist,
    );

    if ((totalVx !== 0 || totalVz !== 0) && remainingDist > 1e-4) {
      let stepDx = totalVx * dtSec;
      let stepDz = totalVz * dtSec;
      const stepDist = Math.hypot(stepDx, stepDz);
      if (stepDist > remainingDist) {
        const scale = remainingDist / stepDist;
        stepDx *= scale;
        stepDz *= scale;
      }

      const nextX = Math.max(
        1.8,
        Math.min(this.activeWorld.worldWidth - 1.8, this.localPos.x + stepDx),
      );
      const nextZ = Math.max(
        1.8,
        Math.min(this.activeWorld.worldDepth - 1.8, this.localPos.z + stepDz),
      );

      if (this.localGrounded) {
        const groundY = findLocalGroundY(
          this.activeWorld,
          nextX,
          nextZ,
          this.localPos.y,
        );
        if (groundY !== null) {
          const stepUp = groundY - this.localPos.y;
          const normal = this.activeWorld.sampleNormal(nextX, groundY, nextZ);
          // Smooth Auto-Hop: forgiving climb over small bumps & crater rims up to 1.0m
          const minWalkNormal =
            stepUp > 0.22
              ? stats.slopeCling
                ? 0.28
                : 0.42
              : stats.slopeCling
                ? 0.34
                : 0.54;
          const hasHeadroom =
            this.activeWorld.sample(nextX, groundY + 0.65, nextZ) > -0.05;

          if (stepUp <= AUTO_HOP_MAX_STEP_M && normal.y >= minWalkNormal && hasHeadroom) {
            this.localPos.set(nextX, groundY, nextZ);
          }
        } else {
          // Walked off a cliff edge -> transition cleanly into airborne fall
          this.localPos.x = nextX;
          this.localPos.z = nextZ;
          this.localGrounded = false;
        }
      } else {
        if (!this.activeWorld.isSolid(nextX, this.localPos.y + 0.55, nextZ)) {
          this.localPos.x = nextX;
          this.localPos.z = nextZ;
        }
      }

      const movedDxz = Math.hypot(
        this.localPos.x - prevX,
        this.localPos.z - prevZ,
      );
      if (movedDxz > 1e-4) {
        const spent = (movedDxz / budgetDist) * staminaScale;
        this.localMoveStamina = Math.max(0, this.localMoveStamina - spent);
        if (this.localMoveStamina < 0.05) {
          this.localMoveStamina = 0;
          if (state.phase === "ACTIVE" && !this.staminaSpentToastShown) {
            this.staminaSpentToastShown = true;
            this.hud.showToast(
              "Move stamina spent — Aim, Grapple, or Fire!",
              "info",
            );
          }
        }
      }
    }

    // Classic 3D Artillery Double-Tap Space High Backflip (high vertical + slight backward vault!)
    if (
      backflipPressed &&
      !this.backflipUsedThisJump &&
      (this.localGrounded || this.localTimeSinceGroundedSec <= BACKFLIP_GRACE_SEC)
    ) {
      this.backflipUsedThisJump = true;
      this.localGrounded = false;
      this.localVel.y = stats.jumpImpulse * BACKFLIP_JUMP_MULT;
      if (this.localMoveStamina > 0) {
        this.localVel.x = -Math.sin(yaw) * BACKFLIP_BACKWARD_SPEED;
        this.localVel.z = -Math.cos(yaw) * BACKFLIP_BACKWARD_SPEED;
      } else {
        this.localVel.x = 0;
        this.localVel.z = 0;
      }
      this.critterRigs.get(critter.id)?.triggerBackflip();
      this.audio.playLaunch("vine_grapple");
    } else if (jumpPressed && this.localGrounded) {
      this.localVel.y = stats.jumpImpulse;
      this.localGrounded = false;
      this.audio.playUiClick();
    }

    if (!this.localGrounded) {
      const airDrag = Math.exp(-2.2 * dtSec);
      this.localVel.x *= airDrag;
      this.localVel.z *= airDrag;
      this.localVel.y -= GRAVITY * dtSec;
      const canGlide = stats.enablesGlide || stats.airControl >= 0.7;
      if (glideHeld && canGlide && this.localVel.y < -2.6) {
        this.localVel.y = -2.6;
      }
      const nextY = this.localPos.y + this.localVel.y * dtSec;
      if (
        this.localVel.y > 0 &&
        this.activeWorld.isSolid(this.localPos.x, nextY + 0.9, this.localPos.z)
      ) {
        this.localVel.y = 0;
      } else {
        this.localPos.y = nextY;
        if (this.localVel.y <= 0) {
          const landingY = findLocalGroundY(
            this.activeWorld,
            this.localPos.x,
            this.localPos.z,
            this.localPos.y + 0.25,
          );
          if (landingY !== null && this.localPos.y <= landingY + 0.08) {
            this.localPos.y = landingY;
            this.localVel.set(0, 0, 0);
            this.localGrounded = true;
            this.localTimeSinceGroundedSec = 0;
            this.backflipUsedThisJump = false;
          }
        }
      }
    } else {
      // Keep snapped to carved terrain if ground dropped out below feet
      const supportY = findLocalGroundY(
        this.activeWorld,
        this.localPos.x,
        this.localPos.z,
        this.localPos.y,
      );
      if (supportY === null || this.localPos.y - supportY > 0.45) {
        this.localGrounded = false;
      } else {
        this.localPos.y = supportY;
      }
    }

    const drowned = this.localPos.y <= state.waterLevel;
    const posMoved = this.lastSyncedPos.distanceToSquared(this.localPos) > 0.0008;
    const yawMoved = Math.abs(yaw - this.lastSyncedYaw) > 0.03;

    if (
      drowned ||
      ((posMoved || yawMoved) && nowMs - this.lastMoveSyncMs >= MOVE_SYNC_INTERVAL_MS)
    ) {
      this.lastMoveSyncMs = nowMs;
      this.lastSyncedPos.copy(this.localPos);
      this.lastSyncedYaw = yaw;
      if (drowned) {
        this.vfx.spawnSplash({
          x: this.localPos.x,
          y: state.waterLevel,
          z: this.localPos.z,
        });
        this.audio.playSplash();
      }
      this.gameClient.sendMove(
        { x: this.localPos.x, y: this.localPos.y, z: this.localPos.z },
        yaw,
        pitch,
        { x: totalVx, y: this.localVel.y, z: totalVz },
      );
    }
  }

  private computeInitialTurnYaw(
    state: MatchState,
    localCritter: CritterState,
  ): number {
    let bestEnemy: CritterState | null = null;
    let bestDist = Infinity;
    for (const c of state.critters) {
      if (!c.alive || c.id === localCritter.id) continue;
      if (state.mode === "2v2" && localCritter.team && c.team === localCritter.team) {
        continue;
      }
      const d = Math.hypot(
        c.position.x - localCritter.position.x,
        c.position.z - localCritter.position.z,
      );
      if (d < bestDist) {
        bestDist = d;
        bestEnemy = c;
      }
    }
    if (bestEnemy) {
      return Math.atan2(
        bestEnemy.position.x - localCritter.position.x,
        bestEnemy.position.z - localCritter.position.z,
      );
    }
    return Math.atan2(
      this.activeWorld.centerX - localCritter.position.x,
      this.activeWorld.centerZ - localCritter.position.z,
    );
  }

  private awardEndOfMatchEssence(
    state: MatchState,
    localCritter: CritterState | null,
  ): void {
    const kos = localCritter?.kills ?? 0;
    const pods = localCritter?.podsCollected ?? 0;
    const won =
      state.matchEndReason !== "flood_draw" &&
      localCritter !== null &&
      ((state.mode === "2v2" &&
        state.winnerTeam !== null &&
        localCritter.team === state.winnerTeam) ||
        (state.mode === "ffa" && state.winnerId === localCritter.id));

    const result = this.progression.awardMatchEssence({
      finished: true,
      kos,
      evoPodsCollected: pods,
      won,
    });

    this.essenceBreakdown = {
      finishedBonus: 20,
      koBonus: kos * 15,
      kos,
      podBonus: pods * 10,
      pods,
      winBonus: won ? 30 : 0,
      totalEarned: result.earned,
      newBalance: result.profile.essence,
    };
  }

  private rebuildLobbyPreview(theme: ThemeId): void {
    this.previewTheme = theme;
    this.audio.setMusicTheme(theme);
    this.lastMusicContext = null;
    this.activeWorld = new SdfWorld(4242, theme, "duel");
    this.worldScene.configureForWorldSize(
      this.activeWorld.worldWidth,
      this.activeWorld.worldHeight,
      this.activeWorld.worldDepth,
    );
    this.worldScene.setTheme(this.activeWorld.theme);
    this.terrainRenderer.setSunDirection(
      getThemeSunDirection(this.activeWorld.theme),
    );
    this.vfx.setWorldBounds(
      this.activeWorld.worldWidth,
      this.activeWorld.worldHeight,
      this.activeWorld.worldDepth,
    );
    this.terrainRenderer.rebuildAll(this.activeWorld);
    this.terrainRenderer.setWaterLevel(1.8);
    this.worldScene.setWaterLevel(1.8);
    this.worldScene.updateShorelineFromWorld(this.activeWorld, 1.8);
    this.lastShorelineWaterLevel = 1.8;

    const previewSpawns = this.activeWorld.findSpawnPoints(
      LOBBY_SHOWCASE_SPECIES.length,
    );
    this.previewHazards = this.activeWorld
      .findHazardPoints(previewSpawns)
      .map((p, idx) => ({
        id: `preview-haz-${idx + 1}`,
        type: p.type,
        position: { ...p.position },
        radius: p.radius,
        active: true,
      }));
    this.environmentProps.rebuild(
      this.activeWorld,
      1.8,
      [...previewSpawns, ...this.previewHazards.map((h) => h.position)],
    );
    this.environmentProps.syncHazards(this.previewHazards, this.elapsedSec);

    this.spawnLobbyShowcaseCritters();
  }

  private computeCompassState(
    state: MatchState,
    localCritter: CritterState | null,
    origin: Vec3,
    viewerYaw: number,
  ): HudCompassState {
    const sinY = Math.sin(viewerYaw);
    const cosY = Math.cos(viewerYaw);

    const calcBearing = (target: Vec3): { bearingRad: number; distanceM: number } => {
      const dx = target.x - origin.x;
      const dz = target.z - origin.z;
      const forwardDot = dx * sinY + dz * cosY;
      const rightDot = dx * -cosY + dz * sinY;
      return {
        bearingRad: Math.atan2(rightDot, forwardDot),
        distanceM: Math.hypot(dx, dz),
      };
    };

    let bestRival: HudCompassState["rival"] = null;
    for (const c of state.critters) {
      if (!c.alive) continue;
      if (localCritter && c.id === localCritter.id) continue;
      if (
        state.mode === "2v2" &&
        localCritter?.team &&
        c.team === localCritter.team
      ) {
        continue;
      }
      const res = calcBearing(c.position);
      if (!bestRival || res.distanceM < bestRival.distanceM) {
        bestRival = {
          bearingRad: res.bearingRad,
          distanceM: res.distanceM,
          color: c.color,
          label: c.name,
        };
      }
    }

    let bestPod: HudCompassState["evoPod"] = null;
    for (const pod of state.evoPods) {
      if (pod.collected) continue;
      const res = calcBearing(pod.position);
      if (!bestPod || res.distanceM < bestPod.distanceM) {
        bestPod = {
          bearingRad: res.bearingRad,
          distanceM: res.distanceM,
        };
      }
    }

    return { rival: bestRival, evoPod: bestPod };
  }

  private spawnLobbyShowcaseCritters(): void {
    this.clearCritterRigs();
    const profile = this.progression.getProfile();
    const spawns = this.activeWorld.findSpawnPoints(LOBBY_SHOWCASE_SPECIES.length);
    const heroPos = spawns[0] ?? {
      x: this.activeWorld.centerX - 10,
      y: 10,
      z: this.activeWorld.centerZ + 10,
    };
    this.lobbyHeroPos = { ...heroPos };

    // Featured rotating 3D GLB Hero Critter matching the player's current selection
    const heroRig = new CritterRig(
      profile.selectedSpecies,
      profile.selectedColor,
      profile.displayName,
    );
    heroRig.root.position.set(heroPos.x, heroPos.y, heroPos.z);
    const heroHp = heroRig.root.getObjectByName("hp_bar_sprite");
    if (heroHp) {
      heroHp.visible = false;
    }
    this.critterRoot.add(heroRig.root);
    this.critterRigs.set("preview-hero", heroRig);

    // Populate the remaining sunlit island ridges with background rival species
    const others = LOBBY_SHOWCASE_SPECIES.filter(
      (s) => s.species !== profile.selectedSpecies,
    );
    for (let i = 0; i < others.length; i++) {
      const spec = others[i];
      if (!spec) continue;
      const pos = spawns[i + 1] ?? {
        x: this.activeWorld.centerX - 6 + i * 6,
        y: 10,
        z: this.activeWorld.centerZ,
      };
      const rig = new CritterRig(spec.species, spec.color, spec.label);
      rig.root.position.set(pos.x, pos.y, pos.z);
      rig.root.rotation.y = Math.atan2(
        this.activeWorld.centerX - pos.x,
        this.activeWorld.centerZ - pos.z,
      );
      const hpBar = rig.root.getObjectByName("hp_bar_sprite");
      if (hpBar) {
        hpBar.visible = false;
      }
      this.critterRoot.add(rig.root);
      this.critterRigs.set(`preview-${i}`, rig);
    }
  }

  private syncCritterRigsFromState(state: MatchState): void {
    const activeIds = new Set<string>();
    for (const c of state.critters) {
      activeIds.add(c.id);
      let rig = this.critterRigs.get(c.id);
      if (!rig || rig.species !== c.species) {
        if (rig) {
          this.critterRoot.remove(rig.root);
          rig.dispose();
        }
        rig = new CritterRig(c.species, c.color, c.name);
        rig.root.position.set(c.position.x, c.position.y, c.position.z);
        rig.root.rotation.y = c.yaw;
        this.critterRoot.add(rig.root);
        this.critterRigs.set(c.id, rig);
      }
      const visual = resolveCritterVisualState(c, this.shotPlayback);
      rig.setHp(visual.hp, visual.maxHp, visual.alive);
      rig.applyMutations(c.equipped, c.apex);
    }

    for (const [id, rig] of this.critterRigs.entries()) {
      if (!activeIds.has(id)) {
        this.critterRoot.remove(rig.root);
        rig.dispose();
        this.critterRigs.delete(id);
      }
    }
  }

  private clearCritterRigs(): void {
    for (const rig of this.critterRigs.values()) {
      this.critterRoot.remove(rig.root);
      rig.dispose();
    }
    this.critterRigs.clear();
  }

  private refreshLobbyHud(): void {
    this.hud.showLobby(
      this.progression.getProfile(),
      this.lobbySelection,
      this.onlineLobby,
    );
  }

  private handleResize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.worldScene.resize(w, h);
    this.cameraRig.resize(w / h);
  }

  public dispose(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.onWindowResizeBound);
    window.removeEventListener("keydown", this.onWindowKeyDownBound);
    window.removeEventListener("pointerdown", this.onUserGestureUnlockBound);
    window.removeEventListener("keydown", this.onUserGestureUnlockBound);
    this.gameClient.disconnect();
    this.input.dispose();
    this.hud.dispose();
    this.clearCritterRigs();
    this.environmentProps.dispose();
    this.terrainRenderer.dispose();
    this.trajectoryPreview.dispose();
    this.vfx.dispose();
    this.audio.dispose();
    this.worldScene.dispose();
  }
}

function bootstrap(): void {
  if (typeof document === "undefined") {
    return;
  }
  const appEl = document.getElementById("app");
  const hudEl = document.getElementById("hud-root");
  if (!appEl || !hudEl) {
    return;
  }
  const game = new CritterSiegeApp(appEl, hudEl);
  window.addEventListener("beforeunload", () => game.dispose());
}

bootstrap();
