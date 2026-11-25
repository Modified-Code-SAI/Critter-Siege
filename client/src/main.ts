import * as THREE from "three";
import {
  GADGET_CATALOG,
  SDF_DIMS,
  SPECIES_CATALOG,
  SdfWorld,
  computeCritterStats,
  type CritterState,
  type EngineEvent,
  type GadgetId,
  type GameMode,
  type HazardState,
  type ImpactEvent,
  type MatchState,
  type SpeciesId,
  type ThemeId,
  type Vec3,
} from "@critter/shared";
import { SynthAudio } from "./audio/synthAudio.js";
import { CameraRig, type CameraMode } from "./game/cameraRig.js";
import { InputController } from "./game/inputController.js";
import { TrajectoryPreview } from "./game/trajectoryPreview.js";
import { GameClient, type LobbyViewState } from "./net/gameClient.js";
import { ProgressionStore } from "./profile/progression.js";
import { CritterRig } from "./scene/critterMesh.js";
import { EnvironmentProps } from "./scene/environmentProps.js";
import { TerrainRenderer } from "./scene/terrainRenderer.js";
import { VfxSystem } from "./scene/vfx.js";
import { WorldScene } from "./scene/worldScene.js";
import {
  HudController,
  type LobbySelectionState,
  type MatchEssenceBreakdown,
} from "./ui/hud.js";

const STANDARD_GADGETS: readonly GadgetId[] = [
  "gale_mortar",
  "quake_club",
  "vine_grapple",
  "spore_burst",
  "burrow_bore",
  "seeker_firefly",
];

const BONUS_GADGETS: readonly GadgetId[] = [
  "gravity_mine",
  "prism_wall",
  "shock_magnet",
];

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

const GRAVITY = 18.0;
const MOVE_SYNC_INTERVAL_MS = 66;
const WORLD_SPAN_X = SDF_DIMS.nx * SDF_DIMS.voxelSize;
const WORLD_SPAN_Y = SDF_DIMS.ny * SDF_DIMS.voxelSize;
const WORLD_SPAN_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize;
const WORLD_CENTER_X = WORLD_SPAN_X * 0.5;
const WORLD_CENTER_Z = WORLD_SPAN_Z * 0.5;

interface ScheduledImpact extends ImpactEvent {
  triggered: boolean;
}

interface ShotPlayback {
  gadgetId: GadgetId;
  path: Vec3[];
  durationSec: number;
  elapsedSec: number;
  holdAfterSec: number;
  impacts: ScheduledImpact[];
  drownedPositions: Vec3[];
  splashesDone: boolean;
}

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
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

function findLocalGroundY(
  world: SdfWorld,
  x: number,
  z: number,
  refY: number,
): number | null {
  const startY = Math.min(WORLD_SPAN_Y - 1.5, refY + 1.2);
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
  if (topY !== null && topY <= refY + 1.0) {
    return topY;
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
 * Top-level Critter Siege browser application integrating 3D SDF island rendering,
 * sculpted critters, 4-mode camera rig, physics movement, Shot Cam playback,
 * WebAudio synthesis, progression, and Sandbox + WebSocket multiplayer.
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
  private appliedCarveCount = 0;
  private appliedCrumbleTurn = 0;

  private readonly onWindowResizeBound: () => void;
  private readonly onWindowKeyDownBound: (e: KeyboardEvent) => void;

  private onlineLobby: LobbyViewState | null = null;
  private matchState: MatchState | null = null;
  private inMatch = false;

  private readonly lobbySelection: LobbySelectionState;
  private previewTheme: ThemeId = "emerald_spire";
  private selectedGadget: GadgetId = "gale_mortar";
  private dronePing: Vec3 | null = null;

  // Local critter movement kinematics
  private readonly localPos = new THREE.Vector3(WORLD_CENTER_X, 10, WORLD_CENTER_Z);
  private readonly localVel = new THREE.Vector3(0, 0, 0);
  private localGrounded = true;
  private localTurnKey = "";
  private lastMoveSyncMs = 0;
  private lastSyncedPos = new THREE.Vector3(WORLD_CENTER_X, 10, WORLD_CENTER_Z);
  private lastSyncedYaw = 0;

  // Shot Cam animation & audio feedback state
  private shotPlayback: ShotPlayback | null = null;
  private lastChargeTickMs = 0;
  private lastCountdownSec = -1;

  // Match-over Siege Essence tracking
  private rewardedMatchId: string | null = null;
  private essenceBreakdown: MatchEssenceBreakdown | null = null;

  private rafId = 0;
  private lastFrameMs = 0;
  private elapsedSec = 0;

  public constructor(appContainer: HTMLElement, hudRoot: HTMLElement) {
    this.appContainer = appContainer;
    this.hudRoot = hudRoot;

    this.progression = new ProgressionStore();
    this.audio = new SynthAudio();

    const profile = this.progression.getProfile();
    this.lobbySelection = {
      theme: "emerald_spire",
      gameMode: "ffa",
      botCount: 3,
      bonusGadget: profile.unlockedBonusGadgets[0] ?? null,
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
    this.terrainRenderer = new TerrainRenderer(this.activeWorld);
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
        this.refreshLobbyHud();
      },
      onSelectSpecies: (species) => {
        this.audio.playUiClick();
        this.progression.selectSpecies(species);
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
        const p = this.progression.getProfile();
        this.gameClient.connectAndCreateRoom(
          getWsUrl(),
          p.displayName,
          p.selectedSpecies,
          {
            theme: this.lobbySelection.theme,
            mode: this.lobbySelection.gameMode,
            botCount: this.lobbySelection.botCount,
            bonusGadget: this.lobbySelection.bonusGadget,
          },
        );
      },
      onJoinRoom: (roomCode) => {
        this.audio.playUiClick();
        const p = this.progression.getProfile();
        this.gameClient.connectAndJoinRoom(
          getWsUrl(),
          roomCode,
          p.displayName,
          p.selectedSpecies,
          this.lobbySelection.bonusGadget,
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
      onPickMutation: (mutationId, replaceSlot) => {
        this.audio.playMutationChime();
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
        onDronePing: (point) => this.handleDronePing(point),
        onSelectGadgetIndex: (idx) => this.selectGadgetByIndex(idx),
        onToggleDrone: () => {
          if (!this.inMatch) return;
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
      } else if (e.code === "Digit7") {
        this.selectGadgetByIndex(6);
      }
    };

    window.addEventListener("resize", this.onWindowResizeBound);
    window.addEventListener("keydown", this.onWindowKeyDownBound);

    this.refreshLobbyHud();

    // Seamlessly reconnect to an active online room after browser refresh
    if (this.gameClient.tryAutoReconnect(getWsUrl())) {
      this.hud.showToast("Reconnecting to Critter Siege room...", "info");
    }

    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame((now) => this.loop(now));
  }

  private launchSandboxMatch(): void {
    this.audio.playUiClick();
    const p = this.progression.getProfile();
    this.rewardedMatchId = null;
    this.essenceBreakdown = null;
    this.dronePing = null;
    this.vfx.setDronePing(null);
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
      botCount: Math.max(1, this.lobbySelection.botCount),
      bonusGadget: this.lobbySelection.bonusGadget,
    });
  }

  private returnToLobby(): void {
    this.gameClient.disconnect();
    this.inMatch = false;
    this.matchState = null;
    this.onlineLobby = null;
    this.shotPlayback = null;
    this.dronePing = null;
    this.essenceBreakdown = null;
    this.vfx.setDronePing(null);
    this.vfx.setProjectileVisual(null);
    this.vfx.syncEvoPods([], 0);
    this.trajectoryPreview.update(
      this.activeWorld,
      {
        gadgetId: "gale_mortar",
        origin: { x: WORLD_CENTER_X, y: 10, z: WORLD_CENTER_Z },
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
    this.appliedCarveCount = 0;
    this.appliedCrumbleTurn = 0;
    this.rebuildLobbyPreview(this.lobbySelection.theme);
    this.refreshLobbyHud();
  }

  private copyInviteLink(): void {
    const code = this.onlineLobby?.roomCode;
    if (!code) {
      return;
    }
    const url = `${window.location.origin}${window.location.pathname}?room=${code}`;
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
      if (lobby.theme !== this.previewTheme) {
        this.rebuildLobbyPreview(lobby.theme);
      }
      this.refreshLobbyHud();
    }
  }

  private handleStateSnapshot(state: MatchState): void {
    this.matchState = state;
    this.inMatch = true;

    const worldKey = `${state.matchId}:${state.seed}:${state.round}:${state.theme}`;
    if (worldKey !== this.activeWorldKey) {
      this.activeWorldKey = worldKey;
      this.activeWorld = new SdfWorld(state.seed + state.round * 101, state.theme);
      this.appliedCarveCount = 0;
      this.appliedCrumbleTurn = 0;
      for (const op of state.carveLog) {
        this.activeWorld.applyCarve(op);
        this.appliedCarveCount += 1;
      }
      this.syncSuddenDeathCrumble(state, false);
      this.terrainRenderer.rebuildAll(this.activeWorld);
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
      if (state.carveLog.length > 0 || state.turnNumber >= 6) {
        this.environmentProps.pruneAfterCarve(this.activeWorld, state.waterLevel);
      }
      this.environmentProps.syncHazards(state.hazards ?? [], this.elapsedSec);

      this.dronePing = null;
      this.vfx.setDronePing(null);
      this.shotPlayback = null;
      this.cameraRig.setShotCamActive(false);
      this.localTurnKey = "";
      this.lastCountdownSec = -1;
    } else {
      if (!this.shotPlayback && state.carveLog.length > this.appliedCarveCount) {
        this.flushPendingCarves(state);
      }
      this.syncSuddenDeathCrumble(state, true);
    }

    this.worldScene.setWaterLevel(state.waterLevel);
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

      const distSq =
        (this.localPos.x - localCritter.position.x) ** 2 +
        (this.localPos.y - localCritter.position.y) ** 2 +
        (this.localPos.z - localCritter.position.z) ** 2;

      if (!isControlling || turnKey !== this.localTurnKey || distSq > 2.8 * 2.8) {
        this.localPos.set(
          localCritter.position.x,
          localCritter.position.y,
          localCritter.position.z,
        );
        this.localVel.set(0, 0, 0);
        this.localGrounded = true;
        this.lastSyncedPos.copy(this.localPos);

        if (isControlling && turnKey !== this.localTurnKey) {
          this.localTurnKey = turnKey;
          // Face toward nearest enemy at the start of your turn for instant aim feel
          const aimYaw = this.computeInitialTurnYaw(state, localCritter);
          this.input.setAim(aimYaw, 0.24);
        }
      }

      // Auto-fallback to Gale Mortar if currently selected gadget ran out of charges
      const curCharges = localCritter.gadgetCharges[this.selectedGadget];
      if (curCharges !== null && curCharges <= 0) {
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
    for (const ev of events) {
      switch (ev.type) {
        case "SHOT_RESOLVED": {
          this.audio.playLaunch(ev.gadgetId);
          const sim = ev.simulation;
          const drownedPositions = sim.hits
            .filter((h) => h.drowned)
            .map((h) => ({ ...h.newPosition }));

          this.shotPlayback = {
            gadgetId: ev.gadgetId,
            path: sim.path.length > 0 ? sim.path : [{ x: WORLD_CENTER_X, y: 10, z: WORLD_CENTER_Z }],
            durationSec: Math.max(0.24, sim.durationSec),
            elapsedSec: 0,
            holdAfterSec: 0.45,
            impacts: sim.impacts.map((imp) => ({ ...imp, triggered: false })),
            drownedPositions,
            splashesDone: false,
          };
          this.cameraRig.setShotCamActive(true);
          break;
        }
        case "HAZARD_TRIGGERED": {
          if (ev.hazardType === "blast_barrel") {
            this.vfx.spawnBarrelExplosion(ev.position, 2.8);
            this.audio.playExplosion(2.8);
            this.hud.showToast("BOOM! Blast Barrel chain detonation!", "error");
          } else if (ev.hazardType === "steam_geyser") {
            this.vfx.spawnGeyserBurst(ev.position);
            this.audio.playLaunch("vine_grapple");
            if (localId && ev.affectedCritterIds.includes(localId)) {
              this.localGrounded = false;
              this.localVel.y = 10.5;
            }
            this.hud.showToast("WHOOSH! Thermal Geyser launch!", "info");
          } else if (ev.hazardType === "thorn_patch") {
            this.vfx.spawnExplosion(ev.position, 0.85, false);
            this.audio.playLaunch("quake_club");
            this.hud.showToast("OUCH! Bramble Thorn snag (-12 HP)!", "error");
          }
          break;
        }
        case "EVO_POD_SPAWNED": {
          this.hud.showToast("Evo Pod parachuting onto the island!", "info");
          break;
        }
        case "EVO_POD_COLLECTED": {
          this.audio.playMutationChime();
          const collector = this.matchState?.critters.find(
            (c) => c.id === ev.playerId,
          );
          const bonusName = ev.bonusGadget
            ? ` + ${GADGET_CATALOG[ev.bonusGadget].name}`
            : "";
          if (collector) {
            this.hud.showToast(
              `${collector.name} grabbed an Evo Pod${bonusName}!`,
              "success",
            );
          }
          break;
        }
        case "MUTATION_EQUIPPED": {
          this.audio.playMutationChime();
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
          this.hud.showToast(
            `Round ${ev.round} winner: ${ev.winnerLabel}`,
            "success",
          );
          break;
        }
        default:
          break;
      }
    }
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
      this.terrainRenderer.rebuildChunks(this.activeWorld, Array.from(dirty));
      this.environmentProps.pruneAfterCarve(this.activeWorld, state.waterLevel);
    }
  }

  private syncSuddenDeathCrumble(
    state: MatchState,
    rebuildNow: boolean,
  ): void {
    if (state.turnNumber < 6 || state.turnNumber <= this.appliedCrumbleTurn) {
      return;
    }
    const dirty = new Set<string>();
    for (
      let t = Math.max(6, this.appliedCrumbleTurn + 1);
      t <= state.turnNumber;
      t++
    ) {
      const crumbleRadius = Math.max(10.0, 27.5 - (t - 6) * 1.3);
      for (const key of this.activeWorld.crumbleOuterRing(crumbleRadius)) {
        dirty.add(key);
      }
    }
    this.appliedCrumbleTurn = state.turnNumber;
    if (rebuildNow && dirty.size > 0) {
      this.terrainRenderer.rebuildChunks(this.activeWorld, Array.from(dirty));
      this.environmentProps.pruneAfterCarve(this.activeWorld, state.waterLevel);
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

    const utilityGadget: GadgetId =
      this.selectedGadget === "prism_wall" ? "prism_wall" : "vine_grapple";

    const moveSnap = this.input.update(0);
    const dir = computeAimDirection(moveSnap.yaw, moveSnap.pitch);
    this.audio.playLaunch(utilityGadget);
    this.gameClient.sendUtility(utilityGadget, dir);
  }

  private handleRetreatBurrow(): void {
    const state = this.matchState;
    const localId = this.gameClient.getPlayerId();
    if (!state || !localId || state.phase !== "RETREAT" || state.activePlayerId !== localId) {
      return;
    }
    const localCritter = state.critters.find((c) => c.id === localId);
    if (!localCritter || localCritter.equipped.offense !== "burrow_claws") {
      this.hud.showToast("Equip Burrow Claws to dig a retreat foxhole!", "info");
      return;
    }
    const moveSnap = this.input.update(0);
    const dir = computeAimDirection(moveSnap.yaw, Math.min(-0.1, moveSnap.pitch));
    this.audio.playLaunch("burrow_bore");
    this.gameClient.sendRetreatBurrow(dir);
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

  private handleDronePing(point: Vec3): void {
    this.dronePing = { x: point.x, y: point.y, z: point.z };
    this.vfx.setDronePing(this.dronePing);
    this.audio.playUiClick();
    this.hud.showToast("Drone target ping locked for Seeker Firefly!", "success");
  }

  private selectGadgetByIndex(index: number): void {
    if (!this.matchState) return;
    const localId = this.gameClient.getPlayerId();
    const localCritter = this.matchState.critters.find((c) => c.id === localId);
    if (!localCritter) return;

    const visible: GadgetId[] = [...STANDARD_GADGETS];
    for (const bonus of BONUS_GADGETS) {
      const c = localCritter.gadgetCharges[bonus];
      if (c !== null && c > 0) {
        visible.push(bonus);
      }
    }
    const picked = visible[index];
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
      this.worldScene.render(this.cameraRig.camera);
      return;
    }

    this.updateActiveMatchFrame(dtSec, nowMs);
    this.worldScene.render(this.cameraRig.camera);
  }

  private updateLobbyBackdrop(dtSec: number): void {
    this.vfx.updateWindRibbons({ x: 2.4, y: 0, z: 1.1 }, dtSec);
    this.environmentProps.syncHazards(this.previewHazards, this.elapsedSec);

    const orbitAngle = this.elapsedSec * 0.14;
    const dist = Math.max(24, WORLD_SPAN_X * 0.85);
    const camX = WORLD_CENTER_X + Math.sin(orbitAngle) * dist;
    const camZ = WORLD_CENTER_Z + Math.cos(orbitAngle) * dist;
    const camY = 23.5 + Math.sin(this.elapsedSec * 0.35) * 1.4;
    this.cameraRig.camera.position.set(camX, camY, camZ);
    this.cameraRig.camera.lookAt(WORLD_CENTER_X, 9.0, WORLD_CENTER_Z);

    for (const rig of this.critterRigs.values()) {
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
    const canMove =
      isMyTurn &&
      localAlive &&
      (state.phase === "ACTIVE" || state.phase === "RETREAT");
    const canFire = isMyTurn && localAlive && state.phase === "ACTIVE";
    const camMode: CameraMode = this.cameraRig.getMode();
    const isDroneMode =
      camMode === "drone_recon" || camMode === "spectator_drone";

    this.input.setCanAct(canMove, canFire, isDroneMode);
    this.input.setSelectedGadget(this.selectedGadget);
    const moveInput = this.input.update(dtSec);

    // Subtle charge sound ticks while holding fire power
    if (moveInput.charging && nowMs - this.lastChargeTickMs >= 115) {
      this.lastChargeTickMs = nowMs;
      this.audio.playChargeTick(moveInput.chargePower);
    }

    // Turn countdown audio ticks on local active turn
    if (canMove) {
      const secCeil = Math.ceil(state.phaseTimeRemainingSec);
      if (secCeil >= 1 && secCeil <= 4 && secCeil !== this.lastCountdownSec) {
        this.lastCountdownSec = secCeil;
        this.audio.playTurnTick(secCeil <= 2);
      } else if (secCeil > 4) {
        this.lastCountdownSec = -1;
      }
    }

    // Update Shot Cam projectile flight animation
    const shotPos = this.advanceShotPlayback(dtSec, state);

    // Smooth local critter kinematics + 15 Hz sync
    if (canMove && localCritter && !isDroneMode) {
      this.stepLocalCritterMovement(
        dtSec,
        nowMs,
        localCritter,
        state,
        moveInput.forward,
        moveInput.right,
        moveInput.jumpPressed,
        moveInput.glideHeld,
        moveInput.yaw,
        moveInput.pitch,
      );
    }

    // Sync VFX wind ribbons, Evo Pods, and animated interactive hazards
    this.vfx.updateWindRibbons(state.wind, dtSec);
    this.vfx.syncEvoPods(state.evoPods, this.elapsedSec);
    this.environmentProps.syncHazards(state.hazards ?? [], this.elapsedSec);

    // Update Camera Rig first so first_person visibility is 100% in sync this frame
    const focusCritter =
      isMyTurn && localCritter
        ? localCritter
        : activeCritter ?? localCritter;
    const focusPos: Vec3 =
      canMove && localCritter
        ? { x: this.localPos.x, y: this.localPos.y, z: this.localPos.z }
        : focusCritter
          ? focusCritter.position
          : { x: WORLD_CENTER_X, y: 9, z: WORLD_CENTER_Z };

    this.cameraRig.update({
      targetPos: focusPos,
      yaw: canMove ? moveInput.yaw : focusCritter?.yaw ?? 0,
      pitch: canMove ? moveInput.pitch : 0.15,
      phase: state.phase,
      localAlive,
      shotPos,
      world: this.activeWorld,
      dtSec,
    });

    const effectiveCamMode = this.cameraRig.getMode();
    const trackedCritterId = focusCritter?.id ?? localId;

    // Update all critter rigs (hiding tracked critter cleanly in First-Person Optic Visor)
    for (const c of state.critters) {
      const rig = this.critterRigs.get(c.id);
      if (!rig) continue;

      const isLocalControlled = canMove && c.id === localId;
      let moving = false;
      let vy = 0;

      if (isLocalControlled) {
        rig.root.position.copy(this.localPos);
        rig.root.rotation.y = moveInput.yaw;
        moving = moveInput.forward !== 0 || moveInput.right !== 0;
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

      rig.setHp(c.hp, c.maxHp, c.alive);
      if (
        effectiveCamMode === "first_person" &&
        (c.id === trackedCritterId || c.id === localId)
      ) {
        rig.root.visible = false;
      } else {
        rig.root.visible = c.alive;
      }
      rig.applyMutations(c.equipped, c.apex);
      rig.updateAnimation(dtSec, moving, vy, c.id === state.activePlayerId);
    }

    // Update live 3D Trajectory Preview during local aiming
    const gadgetDef = GADGET_CATALOG[this.selectedGadget];
    const showArc =
      canFire &&
      localCritter !== null &&
      this.cameraRig.getMode() !== "drone_recon" &&
      this.cameraRig.getMode() !== "shot_cam" &&
      gadgetDef.turnEnding &&
      this.selectedGadget !== "quake_club";

    if (showArc && localCritter) {
      const stats = computeCritterStats(localCritter.species, localCritter.equipped);
      const aimDir = computeAimDirection(moveInput.yaw, moveInput.pitch);
      this.trajectoryPreview.update(
        this.activeWorld,
        {
          gadgetId: this.selectedGadget,
          origin: {
            x: this.localPos.x,
            y: this.localPos.y + 0.6,
            z: this.localPos.z,
          },
          direction: aimDir,
          power: moveInput.charging ? moveInput.chargePower : 0.58,
          ...(this.dronePing ? { droneTarget: this.dronePing } : {}),
        },
        state.wind,
        stats.extendedTrajectory,
        true,
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
      );
    }

    // Update In-Game HUD
    this.hud.updateGameHud({
      matchState: state,
      localPlayerId: localId,
      cameraMode: this.cameraRig.getMode(),
      selectedGadget: this.selectedGadget,
      charging: moveInput.charging,
      chargePower: moveInput.chargePower,
      muted: this.audio.isMuted(),
      dronePingActive: this.dronePing !== null,
      essenceBreakdown: this.essenceBreakdown,
    });
  }

  private advanceShotPlayback(dtSec: number, state: MatchState): Vec3 | null {
    const pb = this.shotPlayback;
    if (!pb) {
      return null;
    }

    pb.elapsedSec += dtSec;
    const t = Math.max(0, Math.min(1, pb.elapsedSec / pb.durationSec));
    const idxFloat = t * Math.max(0, pb.path.length - 1);
    const i0 = Math.floor(idxFloat);
    const i1 = Math.min(pb.path.length - 1, i0 + 1);
    const frac = idxFloat - i0;
    const p0 = pb.path[i0] ?? { x: WORLD_CENTER_X, y: 10, z: WORLD_CENTER_Z };
    const p1 = pb.path[i1] ?? p0;

    const currentPos: Vec3 = {
      x: p0.x + (p1.x - p0.x) * frac,
      y: p0.y + (p1.y - p0.y) * frac,
      z: p0.z + (p1.z - p0.z) * frac,
    };

    const inFlight = pb.elapsedSec < pb.durationSec;
    this.vfx.setProjectileVisual(
      inFlight ? currentPos : null,
      GADGET_COLORS[pb.gadgetId],
    );

    for (const imp of pb.impacts) {
      if (!imp.triggered && pb.elapsedSec >= imp.time) {
        imp.triggered = true;
        this.flushPendingCarves(state);
        const blastRadius =
          imp.carveOp?.radius ?? Math.max(1.2, imp.damageRadius * 0.65);
        this.vfx.spawnExplosion(imp.position, blastRadius, Boolean(imp.isPull));
        this.audio.playExplosion(blastRadius);
      }
    }

    if (!inFlight && !pb.splashesDone) {
      pb.splashesDone = true;
      this.flushPendingCarves(state);
      for (const imp of pb.impacts) {
        if (!imp.triggered) {
          imp.triggered = true;
          const blastRadius =
            imp.carveOp?.radius ?? Math.max(1.2, imp.damageRadius * 0.65);
          this.vfx.spawnExplosion(imp.position, blastRadius, Boolean(imp.isPull));
          this.audio.playExplosion(blastRadius);
        }
      }
      for (const dp of pb.drownedPositions) {
        this.vfx.spawnSplash({ x: dp.x, y: state.waterLevel, z: dp.z });
        this.audio.playSplash();
      }
    }

    if (
      pb.elapsedSec >= pb.durationSec + pb.holdAfterSec ||
      state.phase !== "RESOLVING"
    ) {
      this.flushPendingCarves(state);
      this.vfx.setProjectileVisual(null);
      this.shotPlayback = null;
      this.cameraRig.setShotCamActive(false);
      return null;
    }

    return currentPos;
  }

  private stepLocalCritterMovement(
    dtSec: number,
    nowMs: number,
    critter: CritterState,
    state: MatchState,
    forward: number,
    right: number,
    jumpPressed: boolean,
    glideHeld: boolean,
    yaw: number,
    pitch: number,
  ): void {
    const stats = computeCritterStats(critter.species, critter.equipped);
    const speedMult = state.phase === "RETREAT" ? stats.retreatRollBoost : 1.0;
    const moveSpeed = stats.moveSpeed * speedMult;

    let moveX = 0;
    let moveZ = 0;
    if (forward !== 0 || right !== 0) {
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
    }

    if (moveX !== 0 || moveZ !== 0) {
      const nextX = Math.max(
        1.8,
        Math.min(WORLD_SPAN_X - 1.8, this.localPos.x + moveX * dtSec),
      );
      const nextZ = Math.max(
        1.8,
        Math.min(WORLD_SPAN_Z - 1.8, this.localPos.z + moveZ * dtSec),
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
          const minWalkNormal = stats.slopeCling ? 0.34 : 0.54;
          const hasHeadroom =
            this.activeWorld.sample(nextX, groundY + 0.65, nextZ) > -0.05;

          if (stepUp <= 0.95 && normal.y >= minWalkNormal && hasHeadroom) {
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
    }

    if (jumpPressed && this.localGrounded) {
      this.localVel.y = stats.jumpImpulse;
      this.localGrounded = false;
      this.audio.playUiClick();
    }

    if (!this.localGrounded) {
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
            this.localVel.y = 0;
            this.localGrounded = true;
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
        { x: moveX, y: this.localVel.y, z: moveZ },
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
      WORLD_CENTER_X - localCritter.position.x,
      WORLD_CENTER_Z - localCritter.position.z,
    );
  }

  private awardEndOfMatchEssence(
    state: MatchState,
    localCritter: CritterState | null,
  ): void {
    const kos = localCritter?.kills ?? 0;
    const pods = localCritter?.podsCollected ?? 0;
    const won =
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
    this.activeWorld = new SdfWorld(4242, theme);
    this.terrainRenderer.rebuildAll(this.activeWorld);
    this.worldScene.setWaterLevel(1.8);

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

  private spawnLobbyShowcaseCritters(): void {
    this.clearCritterRigs();
    const spawns = this.activeWorld.findSpawnPoints(LOBBY_SHOWCASE_SPECIES.length);
    for (let i = 0; i < LOBBY_SHOWCASE_SPECIES.length; i++) {
      const spec = LOBBY_SHOWCASE_SPECIES[i];
      if (!spec) continue;
      const pos = spawns[i] ?? {
        x: WORLD_CENTER_X - 6 + i * 4,
        y: 10,
        z: WORLD_CENTER_Z,
      };
      const rig = new CritterRig(spec.species, spec.color, spec.label);
      rig.root.position.set(pos.x, pos.y, pos.z);
      rig.root.rotation.y = Math.atan2(
        WORLD_CENTER_X - pos.x,
        WORLD_CENTER_Z - pos.z,
      );
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
      rig.setHp(c.hp, c.maxHp, c.alive);
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
  const appEl = document.getElementById("app");
  const hudEl = document.getElementById("hud-root");
  if (!appEl || !hudEl) {
    return;
  }
  const game = new CritterSiegeApp(appEl, hudEl);
  window.addEventListener("beforeunload", () => game.dispose());
}

bootstrap();
