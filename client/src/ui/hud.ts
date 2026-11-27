import {
  APEX_CATALOG,
  DEFAULT_STARTING_COINS,
  GADGET_CATALOG,
  GADGET_IDS,
  GAME_TITLE,
  HARDPOINT_SLOTS,
  MAX_LOADOUT_SLOTS,
  MUTATION_CATALOG,
  PLAYER_COLOR_PALETTE,
  SPECIES_CATALOG,
  SPECIES_IDS,
  validateAndBuildStartingLoadout,
  type CritterState,
  type GadgetId,
  type GameMode,
  type HardpointSlot,
  type MapScaleChoice,
  type MatchState,
  type MutationId,
  type PendingDraftState,
  type SpeciesId,
  type ThemeId,
} from "@critter/shared";
import type { CameraMode } from "../game/cameraRig.js";
import type { DronePlayerMarkerData } from "../game/droneProjection.js";
import type { LobbyViewState } from "../net/gameClient.js";
import {
  COSMETIC_ACCENT_CATALOG,
  type PlayerProfile,
} from "../profile/progression.js";

/** Default balanced starting 3-ability kit (cost 55, 45 Siege Coins remaining). */
export const DEFAULT_STARTING_LOADOUT: readonly GadgetId[] = [
  "gale_mortar",
  "quake_club",
  "vine_grapple",
];

/** Resolve the crisp 256px 3D rendered portrait URL for any playable Critter Siege species. */
export function getSpeciesPortraitUrl(
  species: SpeciesId,
  baseOverride?: string,
): string {
  const raw = (baseOverride ?? import.meta.env?.BASE_URL ?? "/").trim();
  const base = !raw ? "/" : raw.endsWith("/") ? raw : `${raw}/`;
  return `${base}portraits/${species}.jpg`;
}

/** Breakdown displayed on the Match Over Siege Essence summary modal. */
export interface MatchEssenceBreakdown {
  finishedBonus: number;
  koBonus: number;
  kos: number;
  podBonus: number;
  pods: number;
  winBonus: number;
  totalEarned: number;
  newBalance: number;
}

/** Directional target pip rendered on the top compass bar. */
export interface CompassPip {
  bearingRad: number;
  distanceM: number;
  color?: string;
  label?: string;
}

/** Nearest rival & Evo Pod directional markers for the top compass bar. */
export interface HudCompassState {
  rival: CompassPip | null;
  evoPod: CompassPip | null;
}

/** Selectable interactive camera modes from the top-right HUD pills. */
export type SelectableCameraMode =
  | "over_shoulder"
  | "first_person"
  | "drone_recon";

/** Callbacks raised by HudController when the user interacts with lobby or HUD controls. */
export interface HudCallbacks {
  onNameChange: (name: string) => void;
  onColorChange: (color: string) => void;
  onSelectSpecies: (species: SpeciesId) => void;
  onUnlockSpecies: (species: SpeciesId) => void;
  onUnlockCosmetic?: (cosmeticId: string) => void;
  onSelectBonusGadget?: (gadget: GadgetId | null) => void;
  onUnlockBonusGadget?: (gadget: GadgetId) => void;
  onStartingLoadoutChange: (loadout: GadgetId[]) => void;
  onThemeChange: (theme: ThemeId) => void;
  onGameModeChange: (mode: GameMode) => void;
  onMapScaleChange?: (mapScale: MapScaleChoice) => void;
  onBotCountChange: (count: number) => void;
  onPlaySandbox: () => void;
  onCreateRoom: () => void;
  onJoinRoom: (roomCode: string) => void;
  onStartOnlineMatch: () => void;
  onLeaveRoom: () => void;
  onCopyInviteLink: () => void;
  onSelectGadget: (gadgetId: GadgetId) => void;
  onBuyAbility: (gadgetId: GadgetId, replaceGadgetId?: GadgetId) => void;
  onPickMutation: (mutationId: MutationId, replaceSlot?: HardpointSlot) => void;
  onRerollDraft: () => void;
  onToggleMute: () => void;
  onToggleMusicMute: () => void;
  onArmoryOpenChange?: (open: boolean) => void;
  onPlayAgain: () => void;
  onBackToLobby: () => void;
  onSelectCameraMode?: (mode: SelectableCameraMode) => void;
  onUiFireStart?: () => void;
  onUiFireRelease?: () => void;
  onUiFireCancel?: () => void;
  onDronePingCritter?: (critterId: string) => void;
}

/** Per-frame dynamic HUD input during an active match. */
export interface HudFrameState {
  matchState: MatchState;
  localPlayerId: string | null;
  cameraMode: CameraMode;
  selectedGadget: GadgetId;
  charging: boolean;
  chargePower: number;
  muted: boolean;
  musicMuted: boolean;
  armoryOpen?: boolean;
  dronePingActive: boolean;
  essenceBreakdown: MatchEssenceBreakdown | null;
  showQuickStartHint?: boolean;
  compass?: HudCompassState;
  pointerLocked?: boolean;
  canFire?: boolean;
  localMoveStamina?: number;
  droneMarkers?: readonly DronePlayerMarkerData[];
}

/** Local lobby selection state managed between HudController and main.ts. */
export interface LobbySelectionState {
  theme: ThemeId;
  gameMode: GameMode;
  mapScale?: MapScaleChoice;
  botCount: number;
  bonusGadget: GadgetId | null;
  startingLoadout: GadgetId[];
  joinCodeInput: string;
}

const THEME_META: ReadonlyArray<{ id: ThemeId; shortLabel: string; label: string }> = [
  { id: "emerald_spire", shortLabel: "Emerald", label: "Emerald Spire" },
  { id: "canyon_arch", shortLabel: "Canyon", label: "Canyon Arch" },
  { id: "twin_pillars", shortLabel: "Pillars", label: "Twin Pillars" },
  { id: "mountain_spine", shortLabel: "Spine", label: "Mountain Spine" },
];

const MAP_SCALE_META: ReadonlyArray<{ id: MapScaleChoice; label: string; title: string }> = [
  { id: "auto", label: "Auto", title: "2p = 60m Duel · 3–4p = 144m Grand" },
  { id: "duel", label: "2p 60m", title: "Compact 60m Duel Island" },
  { id: "grand", label: "4p 144m", title: "Massive 144m Grand Archipelago" },
];

const SLOT_LABELS: Record<HardpointSlot, string> = {
  back: "BACK",
  legs: "LEGS",
  offense: "GEAR",
  crest: "CREST",
};

const SPECIES_BADGE_META: Record<
  SpeciesId,
  { shortName: string; chip: string; accent: string }
> = {
  mole: { shortName: "Mole", chip: "⛏ Dig", accent: "#f97316" },
  norway_rat: { shortName: "Rat", chip: "⚡ Fast", accent: "#38bdf8" },
  badger: { shortName: "Badger", chip: "🛡 Tank", accent: "#22c55e" },
  glider_squirrel: { shortName: "Squirrel", chip: "🪽 Glide", accent: "#fb7185" },
  hedgehog: { shortName: "Hedgehog", chip: "🌵 Thorns", accent: "#eab308" },
  armadillo: { shortName: "Armadillo", chip: "🌀 Roll", accent: "#c084fc" },
};

const MUTATION_STAT_CHIPS: Record<MutationId, readonly [string, string]> = {
  glider_wings: ["+35% Glide", "High Air Control"],
  bramble_shell: ["+50 Armor", "Knockback Resist"],
  spring_paws: ["+30% Jump", "+20% Move Stamina"],
  anchor_talons: ["+25 HP", "Slope Cling"],
  twin_pod: ["+1 Mini Dart", "Bonus Damage"],
  burrow_claws: ["+35% Carve", "[F] Foxhole"],
  optic_visor: ["Full Arc Sight", "+15% Accuracy"],
  aegis_crest: ["+45 Shield/Rd", "Blast Guard"],
};

const GADGET_SHORT_TOOLTIP: Record<GadgetId, string> = {
  gale_mortar: "Gale Mortar — Wind-curved explosive crater shell",
  quake_club: "Gale Scatter — Wide-cone pneumatic wind shotgun blast",
  vine_grapple: "Vine Grapple — Climb cliffs or rappel safely down (6/rd, 1/turn)",
  spore_burst: "Spore Burst — Splits into 5 buoyant cluster sub-spores",
  burrow_bore: "Burrow Bore — Drills straight through rock walls",
  seeker_firefly: "Seeker Firefly — Guided GPS homing missile onto your Drone Ping",
  gravity_mine: "Gravity Mine — Pulls rivals inward before blast",
  prism_wall: "Prism Wall — Raises sculpted cover shelter (non-turn-ending)",
  shock_magnet: "Shock Magnet — Snaps onto rock and jolts rivals away",
  mend_brew: "Mend Brew — Herbal tonic that heals +45 HP without ending your turn",
};

const GADGET_CONCISE_EFFECT: Record<GadgetId, string> = {
  gale_mortar: "Wind-curved explosive mortar · ∞",
  quake_club: "6m wind-shotgun knockback blast · ∞",
  vine_grapple: "Free-action cliff zip & rappel",
  spore_burst: "Splits into 5 fungal sub-spores",
  burrow_bore: "Drills 0.6s through solid rock",
  seeker_firefly: "Guided GPS homing missile",
  gravity_mine: "Vortex implosion yanks rivals",
  prism_wall: "Free-action crystal cover wall",
  shock_magnet: "Electrified ledge-jolt beacon",
  mend_brew: "Free-action +45 HP herbal heal",
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatRoundClock(seconds: number): string {
  const clamped = Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

function getWindCompassLabel(vx: number, vz: number): string {
  const speed = Math.hypot(vx, vz);
  if (speed < 0.15) {
    return "CALM";
  }
  const deg = ((Math.atan2(vx, -vz) * 180) / Math.PI + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(deg / 45) % 8;
  return dirs[idx] ?? "N";
}

function getGadgetSvgIcon(gadget: GadgetId): string {
  switch (gadget) {
    case "gale_mortar":
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 18h10l6-10-4-3-6 10"/>
        <circle cx="18.5" cy="5.5" r="2" fill="currentColor"/>
        <path d="M4 20h14"/>
      </svg>`;
    case "quake_club":
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 14l4.5-2.5 2 2-4.5 3z" fill="currentColor" opacity="0.28"/>
        <path d="M9 11l10-5.5M9.5 12.5h11M9 14l10 5.5"/>
        <path d="M16.5 5.5a9.5 9.5 0 0 1 0 13" opacity="0.75"/>
      </svg>`;
    case "vine_grapple":
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 19L17 7"/>
        <path d="M12 6h6v6"/>
        <path d="M14 14c1.5 1.5 3 1.5 4.5 0"/>
      </svg>`;
    case "spore_burst":
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="12" cy="7" r="3" fill="currentColor" opacity="0.3"/>
        <circle cx="7" cy="16" r="3" fill="currentColor" opacity="0.3"/>
        <circle cx="17" cy="16" r="3" fill="currentColor" opacity="0.3"/>
        <path d="M12 10v3M9.5 14.5l2.5-1.5 2.5 1.5" stroke-linecap="round"/>
      </svg>`;
    case "burrow_bore":
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 12h4l12-4-4 12-8-4z" fill="currentColor" opacity="0.22"/>
        <path d="M11 9.5l3 5M14.5 8.5l2 3.5"/>
      </svg>`;
    case "seeker_firefly":
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8" stroke-dasharray="3 3" opacity="0.75"/>
        <path d="M7.5 16.5L16.5 7.5" stroke-width="2.1"/>
        <path d="M12.5 7.5h4v4" fill="currentColor" opacity="0.3"/>
        <path d="M6.5 13.5l4 4M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22"/>
      </svg>`;
    case "gravity_mine":
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="12" cy="12" r="3.5" fill="currentColor"/>
        <circle cx="12" cy="12" r="8" stroke-dasharray="4 3"/>
      </svg>`;
    case "prism_wall":
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 18L12 5l8 13z" fill="currentColor" opacity="0.25"/>
        <path d="M12 5v13"/>
      </svg>`;
    case "shock_magnet":
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M6 5v7a6 6 0 0 0 12 0V5"/>
        <path d="M5 9h3M16 9h3"/>
      </svg>`;
    case "mend_brew":
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 3h6M10 3v4l-5 8a4 4 0 0 0 3.4 6h7.2a4 4 0 0 0 3.4-6l-5-8V3"/>
        <path d="M12 12v5M9.5 14.5h5"/>
      </svg>`;
  }
}

function getSlotSvgIcon(slot: HardpointSlot): string {
  switch (slot) {
    case "back":
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 10c2-4 5-5 7-3 2-2 5-1 7 3-2 4-5 5-7 3-2 2-5 1-7-3z"/>
      </svg>`;
    case "legs":
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7 4v5l-2 4h5M13 4v5l2 4h-5"/>
      </svg>`;
    case "offense":
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <path d="M4 15L15 4M11 4h4v4M6 11l3 3"/>
      </svg>`;
    case "crest":
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
        <path d="M10 3l5 6-5 8-5-8z"/>
      </svg>`;
  }
}

function getMutationSvgIcon(mutId: MutationId): string {
  switch (mutId) {
    case "glider_wings":
      return getSlotSvgIcon("back");
    case "bramble_shell":
      return `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 2l7 4v5c0 4-3 6-7 7-4-1-7-3-7-7V6z" fill="currentColor" opacity="0.22"/></svg>`;
    case "spring_paws":
      return `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 16h8M7 13l6-2M7 10l6-2M7 7l6-2"/></svg>`;
    case "anchor_talons":
      return `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 3v13M5 12c0 3 2 5 5 5s5-2 5-5M7 6h6"/></svg>`;
    case "twin_pod":
      return `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 15l4-9M11 15l4-9M4 15h12"/></svg>`;
    case "burrow_claws":
      return `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6l6 10 6-10M10 4v12"/></svg>`;
    case "optic_visor":
      return `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="10" cy="10" r="2.2" fill="currentColor"/></svg>`;
    case "aegis_crest":
      return `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M10 2l6 7-6 9-6-9z" fill="currentColor" opacity="0.25"/></svg>`;
  }
}

/**
 * Ultra-modern grandma-friendly DOM Lobby and In-Game HUD controller for Critter Siege.
 * Displays crisp 3D character portraits, 10-ability Lobby Loadout Customizer,
 * 5-round clock + Final Deluge alert, Anytime Siege Coin Armory modal (`B`),
 * independent Music (`N`) and Audio (`M`) toggles, clickable camera pills,
 * glowing Power Bar, accessible HOLD TO FIRE button, and `?` Quick Controls.
 */
export class HudController {
  private readonly root: HTMLElement;
  private readonly callbacks: HudCallbacks;

  private readonly lobbyLayer: HTMLDivElement;
  private readonly gameLayer: HTMLDivElement;
  private readonly visorOverlay: HTMLDivElement;
  private readonly droneOverlay: HTMLDivElement;
  private readonly draftModal: HTMLDivElement;
  private readonly armoryModal: HTMLDivElement;
  private readonly matchOverModal: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;

  // Fast-updated In-Game HUD references
  private readonly topRoundEl: HTMLSpanElement;
  private readonly topRoundTimerEl: HTMLSpanElement;
  private readonly topPhaseEl: HTMLSpanElement;
  private readonly topTimerEl: HTMLSpanElement;
  private readonly topActiveEl: HTMLSpanElement;
  private readonly windArrowEl: HTMLDivElement;
  private readonly windSpeedEl: HTMLSpanElement;

  private readonly compassBarEl: HTMLDivElement;
  private readonly compassRivalEl: HTMLDivElement;
  private readonly compassPodEl: HTMLDivElement;

  private readonly camShoulderBtn: HTMLButtonElement;
  private readonly camVisorBtn: HTMLButtonElement;
  private readonly camDroneBtn: HTMLButtonElement;
  private readonly helpBtnEl: HTMLButtonElement;
  private readonly helpCardEl: HTMLDivElement;
  private readonly standingsPanelEl: HTMLDivElement;
  private readonly standingsTitleEl: HTMLSpanElement;
  private readonly standingsChevronEl: HTMLSpanElement;
  private readonly standingsBodyEl: HTMLDivElement;
  private readonly musicMuteBtnEl: HTMLButtonElement;
  private readonly muteBtnEl: HTMLButtonElement;
  private readonly floodAlertEl: HTMLDivElement;

  private readonly turnBannerEl: HTMLDivElement;
  private readonly turnBannerAvatarEl: HTMLImageElement;
  private readonly turnBannerTitleEl: HTMLDivElement;
  private readonly turnBannerSubEl: HTMLDivElement;

  private readonly centerChargeEl: HTMLDivElement;
  private readonly centerChargeArcEl: SVGPathElement;
  private readonly centerChargePctEl: HTMLSpanElement;

  private readonly blAvatarEl: HTMLImageElement;
  private readonly blTeamEl: HTMLSpanElement;
  private readonly blShieldEl: HTMLSpanElement;
  private readonly blHpTextEl: HTMLSpanElement;
  private readonly blHpFillEl: HTMLDivElement;
  private blMoveFillEl: HTMLDivElement | null = null;
  private readonly blEvoCircleEl: SVGCircleElement;
  private readonly blEvoTextEl: HTMLSpanElement;
  private readonly blHardpointsEl: HTMLDivElement;
  private readonly blApexEl: HTMLDivElement;

  private readonly lookHintEl: HTMLDivElement;
  private readonly powerBarWrapEl: HTMLDivElement;
  private readonly powerBarFillEl: HTMLDivElement;
  private readonly powerBarPctEl: HTMLSpanElement;
  private readonly quickStartEl: HTMLDivElement;
  private readonly hotbarListEl: HTMLDivElement;
  private readonly armoryBtnEl: HTMLButtonElement;
  private readonly holdFireBtnEl: HTMLButtonElement;

  private readonly droneBadgeEl: HTMLDivElement;
  private readonly droneCompassEl: HTMLDivElement;
  private readonly droneMarkersEl: HTMLDivElement;
  private readonly droneMarkerEls = new Map<string, HTMLDivElement>();

  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly popupTimers = new Set<ReturnType<typeof setTimeout>>();

  private multiplayerOpen = false;
  private shopOpen = false;
  private loadoutOpen = false;
  private helpOpen = false;
  private standingsOpen = true;
  private armoryOpen = false;
  private pendingSwapTarget: GadgetId | null = null;
  private uiFireActive = false;

  private lastHudAvatarSpecies: SpeciesId | null = null;
  private lastPointerLocked: boolean | null = null;
  private lastMuted: boolean | null = null;
  private lastHardpointSig = "";
  private lastHotbarSig = "";
  private lastStandingsSig = "";
  private lastDraftSig = "";
  private lastArmorySig = "";
  private lastMatchOverSig = "";
  private lastLobbySig = "";

  public constructor(root: HTMLElement, callbacks: HudCallbacks) {
    this.root = root;
    this.callbacks = callbacks;

    this.root.innerHTML = "";

    // 1. Lobby Layer (full-screen open 3D stage + compact floating left glass dock)
    this.lobbyLayer = document.createElement("div");
    this.lobbyLayer.className = "cs-lobby-layer";
    this.root.appendChild(this.lobbyLayer);

    // 2. In-Game HUD Layer
    this.gameLayer = document.createElement("div");
    this.gameLayer.className = "cs-game-layer cs-hidden";
    this.root.appendChild(this.gameLayer);

    // Top-center compact telemetry pill + compass pips + top-right camera switcher + ? help + Music + SFX
    const topBar = document.createElement("div");
    topBar.className = "cs-top-bar";
    topBar.innerHTML = `
      <div class="cs-top-center-stack">
        <div class="cs-glass cs-turn-pill">
          <span class="cs-round-badge" data-ref="round">R1/5</span>
          <span class="cs-round-timer" data-ref="round-timer" title="Round Clock">5:00</span>
          <span class="cs-phase-badge" data-ref="phase">YOUR TURN</span>
          <span class="cs-timer-readout" data-ref="timer">28s</span>
          <span class="cs-divider"></span>
          <span class="cs-active-player" data-ref="active">Critter</span>
          <span class="cs-divider"></span>
          <div class="cs-wind-widget" title="Wind direction & speed">
            <div class="cs-wind-arrow" data-ref="wind-arrow">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M12 3l6 15-6-3.5L6 18z" fill="currentColor"></path>
              </svg>
            </div>
            <span class="cs-wind-speed" data-ref="wind-speed">0.0</span>
          </div>
        </div>
        <div class="cs-compass-strip cs-glass cs-hidden" data-ref="compass-bar">
          <div class="cs-compass-pip cs-compass-rival cs-hidden" data-ref="compass-rival"></div>
          <div class="cs-compass-pip cs-compass-pod cs-hidden" data-ref="compass-pod"></div>
        </div>
      </div>

      <div class="cs-top-right-controls">
        <div class="cs-cam-switcher cs-glass" role="group" aria-label="Camera Mode">
          <button type="button" class="cs-cam-pill" data-cam="over_shoulder" title="Over-the-Shoulder View">
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10" cy="6" r="3"/><path d="M4 17c0-3.3 2.7-5 6-5s6 1.7 6 5"/></svg>
            <span>Shoulder</span>
          </button>
          <button type="button" class="cs-cam-pill" data-cam="first_person" title="First-Person Optic Visor (Hold RMB or Press V)">
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2"/></svg>
            <span>Visor</span>
            <kbd>V</kbd>
          </button>
          <button type="button" class="cs-cam-pill" data-cam="drone_recon" title="Tactical Drone Recon (Press Tab)">
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10" cy="10" r="2.5"/><path d="M3 6l4 2M17 6l-4 2M3 14l4-2M17 14l-4-2"/></svg>
            <span>Drone</span>
            <kbd>Tab</kbd>
          </button>
        </div>
        <button type="button" class="cs-glass cs-mini-icon-btn cs-help-btn" data-ref="help-toggle" title="Controls Quick Guide (?)" aria-label="Controls Quick Guide">?</button>
        <button type="button" class="cs-glass cs-mini-icon-btn cs-music-btn" data-ref="music-mute" title="Toggle Music (N)" aria-label="Toggle Music">♪</button>
        <button type="button" class="cs-glass cs-mini-icon-btn" data-ref="mute" title="Toggle Audio (M)" aria-label="Toggle Audio"></button>
        <button type="button" class="cs-glass cs-mini-icon-btn" data-ref="exit-lobby" title="Return to Lobby" aria-label="Return to Lobby">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9.5L10 3l7 6.5"/><path d="M5.5 8.5V17h9V8.5"/></svg>
        </button>
      </div>
    `;
    this.gameLayer.appendChild(topBar);

    this.topRoundEl = topBar.querySelector('[data-ref="round"]') as HTMLSpanElement;
    this.topRoundTimerEl = topBar.querySelector('[data-ref="round-timer"]') as HTMLSpanElement;
    this.topPhaseEl = topBar.querySelector('[data-ref="phase"]') as HTMLSpanElement;
    this.topTimerEl = topBar.querySelector('[data-ref="timer"]') as HTMLSpanElement;
    this.topActiveEl = topBar.querySelector('[data-ref="active"]') as HTMLSpanElement;
    this.windArrowEl = topBar.querySelector('[data-ref="wind-arrow"]') as HTMLDivElement;
    this.windSpeedEl = topBar.querySelector('[data-ref="wind-speed"]') as HTMLSpanElement;
    this.compassBarEl = topBar.querySelector('[data-ref="compass-bar"]') as HTMLDivElement;
    this.compassRivalEl = topBar.querySelector('[data-ref="compass-rival"]') as HTMLDivElement;
    this.compassPodEl = topBar.querySelector('[data-ref="compass-pod"]') as HTMLDivElement;

    this.camShoulderBtn = topBar.querySelector('[data-cam="over_shoulder"]') as HTMLButtonElement;
    this.camVisorBtn = topBar.querySelector('[data-cam="first_person"]') as HTMLButtonElement;
    this.camDroneBtn = topBar.querySelector('[data-cam="drone_recon"]') as HTMLButtonElement;
    this.helpBtnEl = topBar.querySelector('[data-ref="help-toggle"]') as HTMLButtonElement;
    this.musicMuteBtnEl = topBar.querySelector('[data-ref="music-mute"]') as HTMLButtonElement;
    this.muteBtnEl = topBar.querySelector('[data-ref="mute"]') as HTMLButtonElement;

    // Non-blocking Round 5 Cataclysm Flood Alert Banner
    this.floodAlertEl = document.createElement("div");
    this.floodAlertEl.className = "cs-flood-alert cs-hidden";
    this.floodAlertEl.textContent = "🌊 CATACLYSM DELUGE — THE OCEAN IS RISING!";
    this.gameLayer.appendChild(this.floodAlertEl);

    // Sleek Quick-Reference Controls Card toggled by `?`
    this.helpCardEl = document.createElement("div");
    this.helpCardEl.className = "cs-help-card cs-glass cs-hidden";
    this.helpCardEl.innerHTML = `
      <div class="cs-help-head">
        <span>Quick Controls</span>
        <button type="button" class="cs-close-btn" data-ref="help-close" aria-label="Close Controls Guide">×</button>
      </div>
      <div class="cs-help-row">
        <div class="cs-help-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l4 4H8l4-4z"/><path d="M12 20l-4-4h8l-4 4z"/><path d="M4 12l4-4v8l-4-4z"/><path d="M20 12l-4 4V8l4 4z"/></svg>
        </div>
        <div class="cs-help-text">
          <strong>Move &amp; Backflip</strong>
          <span><kbd>WASD</kbd> / <kbd>Arrows</kbd> Walk · <kbd>Space</kbd> Jump · <kbd>2× Space</kbd> High Backflip</span>
        </div>
      </div>
      <div class="cs-help-row">
        <div class="cs-help-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
        </div>
        <div class="cs-help-text">
          <strong>Look &amp; Views</strong>
          <span><kbd>Click</kbd> Free Mouse-Look (<kbd>ESC</kbd> cursor) · <kbd>Q</kbd>/<kbd>E</kbd> Turn · <kbd>RMB</kbd>/<kbd>V</kbd> Visor · <kbd>Tab</kbd> Drone</span>
        </div>
      </div>
      <div class="cs-help-row">
        <div class="cs-help-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19L19 5"/><path d="M13 5h6v6"/><circle cx="7" cy="17" r="2.2" fill="currentColor"/></svg>
        </div>
        <div class="cs-help-text">
          <strong>Charge &amp; Shoot</strong>
          <span><kbd>Hold Click</kbd>, <kbd>Hold Enter</kbd>, or <b>HOLD TO FIRE</b> · <kbd>RMB</kbd> Cancel · <kbd>1–6</kbd> Gear</span>
        </div>
      </div>
      <div class="cs-help-row">
        <div class="cs-help-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 7v10M9 10h6M9 14h6"/></svg>
        </div>
        <div class="cs-help-text">
          <strong>Specials, Armory &amp; Audio</strong>
          <span><kbd>F</kbd> Special (Sky Bomber / Burrow) · <kbd>L</kbd> Standings · <kbd>B</kbd> Armory · <kbd>N</kbd> Music · <kbd>M</kbd> Mute</span>
        </div>
      </div>
    `;
    this.gameLayer.appendChild(this.helpCardEl);

    // Collapsible Live 5-Round Standings Panel (top-right below camera pills, toggled by [L])
    this.standingsPanelEl = document.createElement("div");
    this.standingsPanelEl.className = "cs-standings-panel cs-glass";
    this.standingsPanelEl.innerHTML = `
      <div class="cs-standings-head" data-ref="standings-head">
        <span class="cs-standings-title" data-ref="standings-title">STANDINGS · R1/5</span>
        <button type="button" class="cs-standings-toggle" data-ref="standings-toggle" title="Toggle Standings (L)" aria-label="Toggle Standings">
          <kbd>L</kbd>
          <span data-ref="standings-chevron">▾</span>
        </button>
      </div>
      <div class="cs-standings-body" data-ref="standings-body"></div>
    `;
    this.gameLayer.appendChild(this.standingsPanelEl);
    this.standingsTitleEl = this.standingsPanelEl.querySelector(
      '[data-ref="standings-title"]',
    ) as HTMLSpanElement;
    this.standingsChevronEl = this.standingsPanelEl.querySelector(
      '[data-ref="standings-chevron"]',
    ) as HTMLSpanElement;
    this.standingsBodyEl = this.standingsPanelEl.querySelector(
      '[data-ref="standings-body"]',
    ) as HTMLDivElement;
    const standingsHeadEl = this.standingsPanelEl.querySelector(
      '[data-ref="standings-head"]',
    ) as HTMLDivElement | null;
    standingsHeadEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleStandings();
    });

    this.camShoulderBtn.addEventListener("click", () =>
      this.callbacks.onSelectCameraMode?.("over_shoulder"),
    );
    this.camVisorBtn.addEventListener("click", () =>
      this.callbacks.onSelectCameraMode?.("first_person"),
    );
    this.camDroneBtn.addEventListener("click", () =>
      this.callbacks.onSelectCameraMode?.("drone_recon"),
    );
    this.helpBtnEl.addEventListener("click", () => this.toggleHelpCard());
    const helpCloseBtn = this.helpCardEl.querySelector(
      '[data-ref="help-close"]',
    ) as HTMLButtonElement | null;
    helpCloseBtn?.addEventListener("click", () => this.setHelpCardOpen(false));
    this.musicMuteBtnEl.addEventListener("click", () =>
      this.callbacks.onToggleMusicMute?.(),
    );
    this.muteBtnEl.addEventListener("click", () => this.callbacks.onToggleMute());
    const exitBtn = topBar.querySelector('[data-ref="exit-lobby"]') as HTMLButtonElement;
    exitBtn.addEventListener("click", () => this.callbacks.onBackToLobby());

    // Brief Animated Center Turn Banner with crisp 3D portrait (1.6s auto-fade)
    this.turnBannerEl = document.createElement("div");
    this.turnBannerEl.className = "cs-turn-banner cs-hidden";
    this.turnBannerEl.innerHTML = `
      <div class="cs-banner-inner">
        <img class="cs-banner-avatar cs-hidden" data-ref="banner-avatar" src="${getSpeciesPortraitUrl("mole")}" alt="" />
        <div class="cs-banner-copy">
          <div class="cs-banner-title" data-ref="banner-title">YOUR TURN</div>
          <div class="cs-banner-sub" data-ref="banner-sub">Move · Click to Look · Hold Click or Enter to Fire</div>
        </div>
      </div>
    `;
    this.gameLayer.appendChild(this.turnBannerEl);
    this.turnBannerAvatarEl = this.turnBannerEl.querySelector(
      '[data-ref="banner-avatar"]',
    ) as HTMLImageElement;
    this.turnBannerTitleEl = this.turnBannerEl.querySelector(
      '[data-ref="banner-title"]',
    ) as HTMLDivElement;
    this.turnBannerSubEl = this.turnBannerEl.querySelector(
      '[data-ref="banner-sub"]',
    ) as HTMLDivElement;

    // Live Center Glowing Charge Power Arc (works in EVERY camera mode!)
    this.centerChargeEl = document.createElement("div");
    this.centerChargeEl.className = "cs-center-charge cs-hidden";
    this.centerChargeEl.innerHTML = `
      <svg viewBox="0 0 140 140" width="140" height="140" aria-hidden="true">
        <defs>
          <linearGradient id="csChargeGrad" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#38f5ff"/>
            <stop offset="60%" stop-color="#fbbf24"/>
            <stop offset="100%" stop-color="#fb7185"/>
          </linearGradient>
        </defs>
        <path d="M 32 108 A 54 54 0 1 1 108 108" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="7" stroke-linecap="round"/>
        <path data-ref="center-arc" d="M 32 108 A 54 54 0 1 1 108 108" fill="none" stroke="url(#csChargeGrad)" stroke-width="7" stroke-linecap="round" stroke-dasharray="255" stroke-dashoffset="255"/>
        <circle cx="70" cy="70" r="3" fill="#ffffff" opacity="0.9"/>
      </svg>
      <span class="cs-center-charge-pct" data-ref="center-pct">15%</span>
    `;
    this.gameLayer.appendChild(this.centerChargeEl);
    this.centerChargeArcEl = this.centerChargeEl.querySelector(
      '[data-ref="center-arc"]',
    ) as SVGPathElement;
    this.centerChargePctEl = this.centerChargeEl.querySelector(
      '[data-ref="center-pct"]',
    ) as HTMLSpanElement;

    // Minimal Bottom-Left Floating Status Cluster (3D Portrait Avatar + Evo ring + HP pill + 4 slots)
    const bottomLeft = document.createElement("div");
    bottomLeft.className = "cs-bottom-left";
    bottomLeft.innerHTML = `
      <div class="cs-status-pill cs-glass">
        <img class="cs-hud-avatar" data-ref="bl-avatar" src="${getSpeciesPortraitUrl("mole")}" alt="Active Critter" />
        <div class="cs-evo-ring" title="Evo Charge">
          <svg viewBox="0 0 36 36" width="34" height="34" aria-hidden="true">
            <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="3.2"/>
            <circle data-ref="bl-evo-circle" cx="18" cy="18" r="14" fill="none" stroke="#4df4ff" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="88" stroke-dashoffset="88" transform="rotate(-90 18 18)"/>
          </svg>
          <span class="cs-evo-ring-text" data-ref="bl-evo-text">0</span>
        </div>
        <div class="cs-hp-cluster">
          <div class="cs-hp-num-row">
            <span class="cs-hp-big" data-ref="bl-hp-text">240</span>
            <span class="cs-bl-team cs-hidden" data-ref="bl-team">A</span>
            <span class="cs-bl-shield cs-hidden" data-ref="bl-shield">🛡</span>
          </div>
          <div class="cs-hp-track">
            <div class="cs-hp-fill" data-ref="bl-hp-fill"></div>
          </div>
          <div class="cs-move-row" title="Per-turn Walking Stamina (Grapple & Geysers are free!)">
            <span class="cs-move-label">MOVE</span>
            <div class="cs-move-track">
              <div class="cs-move-fill" data-ref="bl-move-fill"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="cs-hardpoints-row" data-ref="bl-hardpoints"></div>
      <div class="cs-apex-badge cs-hidden" data-ref="bl-apex"></div>
    `;
    this.gameLayer.appendChild(bottomLeft);
    this.blAvatarEl = bottomLeft.querySelector('[data-ref="bl-avatar"]') as HTMLImageElement;
    this.blTeamEl = bottomLeft.querySelector('[data-ref="bl-team"]') as HTMLSpanElement;
    this.blShieldEl = bottomLeft.querySelector('[data-ref="bl-shield"]') as HTMLSpanElement;
    this.blHpFillEl = bottomLeft.querySelector('[data-ref="bl-hp-fill"]') as HTMLDivElement;
    this.blMoveFillEl = bottomLeft.querySelector<HTMLDivElement>(
      '[data-ref="bl-move-fill"]',
    );
    this.blHpTextEl = bottomLeft.querySelector('[data-ref="bl-hp-text"]') as HTMLSpanElement;
    this.blEvoCircleEl = bottomLeft.querySelector(
      '[data-ref="bl-evo-circle"]',
    ) as unknown as SVGCircleElement;
    this.blEvoTextEl = bottomLeft.querySelector('[data-ref="bl-evo-text"]') as HTMLSpanElement;
    this.blHardpointsEl = bottomLeft.querySelector(
      '[data-ref="bl-hardpoints"]',
    ) as HTMLDivElement;
    this.blApexEl = bottomLeft.querySelector('[data-ref="bl-apex"]') as HTMLDivElement;

    // Bottom-center: Pointer-Lock hint + Big Glowing Power Bar + Quick-Start Pill + Gadget Dock + Armory Pill + HOLD TO FIRE
    const bottomCenter = document.createElement("div");
    bottomCenter.className = "cs-bottom-center";
    bottomCenter.innerHTML = `
      <div class="cs-look-hint-pill cs-glass cs-hidden" data-ref="look-hint">
        Click anywhere to look freely · <kbd>ESC</kbd> for cursor
      </div>
      <div class="cs-power-bar-wrap cs-glass cs-hidden" data-ref="power-bar-wrap">
        <div class="cs-power-bar-head">
          <span class="cs-power-bar-label">SHOT POWER · RELEASE TO FIRE · <kbd>RMB</kbd> CANCEL</span>
          <span class="cs-power-bar-pct" data-ref="power-bar-pct">15%</span>
        </div>
        <div class="cs-power-bar-track">
          <div class="cs-power-bar-fill" data-ref="power-bar-fill"></div>
        </div>
      </div>
      <div class="cs-quickstart-pill cs-glass cs-hidden" data-ref="quickstart">
        <span><kbd>WASD</kbd> Move</span>
        <span class="cs-qs-dot"></span>
        <span><kbd>2× Space</kbd> Backflip</span>
        <span class="cs-qs-dot"></span>
        <span><kbd>Click</kbd> Look · <kbd>Q</kbd>/<kbd>E</kbd> Turn</span>
        <span class="cs-qs-dot"></span>
        <span><kbd>B</kbd> Armory · <kbd>Hold Click</kbd> / <kbd>Enter</kbd> Fire</span>
      </div>
      <div class="cs-dock-row">
        <div class="cs-gadget-dock cs-glass" data-ref="hotbar"></div>
        <button type="button" class="cs-armory-pill-btn cs-glass" data-ref="armory-btn" title="Open Tactical Armory (B)">
          🪙 0 · Armory [B]
        </button>
        <button type="button" class="cs-hold-fire-btn cs-hidden" data-ref="hold-fire" title="Hold to charge shot power, release to fire">
          HOLD TO FIRE
        </button>
      </div>
    `;
    this.gameLayer.appendChild(bottomCenter);
    this.lookHintEl = bottomCenter.querySelector(
      '[data-ref="look-hint"]',
    ) as HTMLDivElement;
    this.powerBarWrapEl = bottomCenter.querySelector(
      '[data-ref="power-bar-wrap"]',
    ) as HTMLDivElement;
    this.powerBarFillEl = bottomCenter.querySelector(
      '[data-ref="power-bar-fill"]',
    ) as HTMLDivElement;
    this.powerBarPctEl = bottomCenter.querySelector(
      '[data-ref="power-bar-pct"]',
    ) as HTMLSpanElement;
    this.quickStartEl = bottomCenter.querySelector(
      '[data-ref="quickstart"]',
    ) as HTMLDivElement;
    this.hotbarListEl = bottomCenter.querySelector(
      '[data-ref="hotbar"]',
    ) as HTMLDivElement;
    this.armoryBtnEl = bottomCenter.querySelector(
      '[data-ref="armory-btn"]',
    ) as HTMLButtonElement;
    this.holdFireBtnEl = bottomCenter.querySelector(
      '[data-ref="hold-fire"]',
    ) as HTMLButtonElement;

    this.armoryBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleArmory();
    });

    this.holdFireBtnEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.uiFireActive = true;
      this.callbacks.onUiFireStart?.();
    });
    this.holdFireBtnEl.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      if (this.uiFireActive) {
        this.uiFireActive = false;
        this.callbacks.onUiFireRelease?.();
      }
    });
    this.holdFireBtnEl.addEventListener("pointercancel", () => {
      if (this.uiFireActive) {
        this.uiFireActive = false;
        this.callbacks.onUiFireCancel?.();
      }
    });
    this.holdFireBtnEl.addEventListener("pointerleave", () => {
      if (this.uiFireActive) {
        this.uiFireActive = false;
        this.callbacks.onUiFireCancel?.();
      }
    });

    // 3. First-Person Optic Visor Overlay (clean subtle reticle framing)
    this.visorOverlay = document.createElement("div");
    this.visorOverlay.className = "cs-visor-overlay cs-hidden";
    this.visorOverlay.innerHTML = `
      <div class="cs-visor-corner cs-vc-tl"></div>
      <div class="cs-visor-corner cs-vc-tr"></div>
      <div class="cs-visor-corner cs-vc-bl"></div>
      <div class="cs-visor-corner cs-vc-br"></div>
      <div class="cs-visor-reticle">
        <svg viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
          <circle cx="60" cy="60" r="24" fill="none" stroke="rgba(77,244,255,0.5)" stroke-width="1.4" stroke-dasharray="5 5"></circle>
          <line x1="60" y1="22" x2="60" y2="48" stroke="rgba(77,244,255,0.85)" stroke-width="1.4"></line>
          <line x1="60" y1="72" x2="60" y2="98" stroke="rgba(77,244,255,0.85)" stroke-width="1.4"></line>
          <line x1="22" y1="60" x2="48" y2="60" stroke="rgba(77,244,255,0.85)" stroke-width="1.4"></line>
          <line x1="72" y1="60" x2="98" y2="60" stroke="rgba(77,244,255,0.85)" stroke-width="1.4"></line>
          <circle cx="60" cy="60" r="2.5" fill="#4df4ff"></circle>
        </svg>
      </div>
    `;
    this.root.appendChild(this.visorOverlay);

    // 4. Tactical Drone Recon / Spectator Drone Overlay
    this.droneOverlay = document.createElement("div");
    this.droneOverlay.className = "cs-drone-overlay cs-hidden";
    this.droneOverlay.innerHTML = `
      <div class="cs-drone-markers" data-ref="drone-markers"></div>
      <div class="cs-drone-bracket cs-db-tl"></div>
      <div class="cs-drone-bracket cs-db-tr"></div>
      <div class="cs-drone-bracket cs-db-bl"></div>
      <div class="cs-drone-bracket cs-db-br"></div>
      <div class="cs-drone-badge cs-glass" data-ref="drone-badge">DRONE RECON · CLICK TO PING</div>
      <div class="cs-drone-compass cs-glass" data-ref="drone-compass">WIND CALM</div>
    `;
    this.root.appendChild(this.droneOverlay);
    this.droneMarkersEl = this.droneOverlay.querySelector(
      '[data-ref="drone-markers"]',
    ) as HTMLDivElement;
    this.droneMarkersEl.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".cs-dm-clickable")) {
        e.stopPropagation();
      }
    });
    this.droneMarkersEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      const markerEl = target?.closest<HTMLElement>("[data-critter-id]");
      const critterId = markerEl?.dataset.critterId;
      if (critterId) {
        e.stopPropagation();
        this.callbacks.onDronePingCritter?.(critterId);
      }
    });
    this.droneBadgeEl = this.droneOverlay.querySelector(
      '[data-ref="drone-badge"]',
    ) as HTMLDivElement;
    this.droneCompassEl = this.droneOverlay.querySelector(
      '[data-ref="drone-compass"]',
    ) as HTMLDivElement;

    // 5. Mutation Draft Modal
    this.draftModal = document.createElement("div");
    this.draftModal.className = "cs-modal-backdrop cs-hidden";
    this.root.appendChild(this.draftModal);

    // 6. Anytime Tactical Armory Modal (sits cleanly above Draft Modal when toggled between rounds)
    this.armoryModal = document.createElement("div");
    this.armoryModal.className = "cs-modal-backdrop cs-hidden";
    this.armoryModal.style.zIndex = "35";
    this.armoryModal.addEventListener("click", (e) => {
      if (e.target === this.armoryModal) {
        this.setArmoryOpen(false);
      }
    });
    this.root.appendChild(this.armoryModal);

    // 7. Match Over Summary Modal
    this.matchOverModal = document.createElement("div");
    this.matchOverModal.className = "cs-modal-backdrop cs-hidden";
    this.root.appendChild(this.matchOverModal);

    // 8. Floating Toast Notification
    this.toastEl = document.createElement("div");
    this.toastEl.className = "cs-toast cs-hidden";
    this.root.appendChild(this.toastEl);

    this.updateMuteIcon(false);
    this.updateMusicMuteIcon(false);
  }

  /** Toggle the `?` quick-reference controls overlay card. */
  public toggleHelpCard(): void {
    this.setHelpCardOpen(!this.helpOpen);
  }

  /** Explicitly open or close the `?` quick-reference controls card. */
  public setHelpCardOpen(open: boolean): void {
    this.helpOpen = open;
    this.helpCardEl.classList.toggle("cs-hidden", !open);
    this.helpBtnEl.classList.toggle("cs-cam-active", open);
    this.standingsPanelEl.classList.toggle("cs-standings-obscured", open);
  }

  /** Toggle the collapsible live 5-round standings panel (`L` key). */
  public toggleStandings(): void {
    this.setStandingsOpen(!this.standingsOpen);
  }

  /** Explicitly expand or collapse the live 5-round standings panel. */
  public setStandingsOpen(open: boolean): void {
    this.standingsOpen = open;
    this.standingsBodyEl.classList.toggle("cs-hidden", !open);
    this.standingsPanelEl.classList.toggle("cs-standings-collapsed", !open);
    this.standingsChevronEl.textContent = open ? "▾" : "▸";
  }

  /** Return whether the live 5-round standings panel is currently expanded. */
  public isStandingsOpen(): boolean {
    return this.standingsOpen;
  }

  /** Toggle the in-match Anytime Armory modal (`B` key). */
  public toggleArmory(): void {
    this.setArmoryOpen(!this.armoryOpen);
  }

  /** Explicitly open or close the in-match Anytime Armory modal. */
  public setArmoryOpen(open: boolean): void {
    const changed = this.armoryOpen !== open;
    this.armoryOpen = open;
    if (!open) {
      this.pendingSwapTarget = null;
      this.armoryModal.classList.add("cs-hidden");
    }
    this.armoryBtnEl.classList.toggle("cs-active", open);
    this.lastArmorySig = "";
    if (changed) {
      this.callbacks.onArmoryOpenChange?.(open);
    }
  }

  /** Return whether the in-match Anytime Armory modal is currently open. */
  public isArmoryOpen(): boolean {
    return this.armoryOpen;
  }

  /** Display a short translucent toast notification. */
  public showToast(message: string, tone: "info" | "success" | "error" = "info"): void {
    this.toastEl.textContent = message;
    this.toastEl.className = `cs-toast cs-toast-${tone}`;
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => {
      this.toastEl.classList.add("cs-hidden");
      this.toastTimer = null;
    }, 3000);
  }

  /**
   * Spawn a crisp rising animated floating damage or event popup projected from
   * 3D world space onto screen pixels (`-32`, `+55 HP!`, `SHIELD!`, `CHAIN BLAST!`).
   */
  public spawnFloatingPopup(
    text: string,
    screenX: number,
    screenY: number,
    tone: "damage" | "heal" | "shield" | "event" = "damage",
  ): void {
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY) || text.length === 0) {
      return;
    }
    let layer = this.gameLayer.querySelector<HTMLDivElement>(".cs-popup-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "cs-popup-layer";
      this.gameLayer.appendChild(layer);
    }
    const popup = document.createElement("div");
    popup.className = `cs-float-popup cs-float-${tone}`;
    popup.textContent = text;
    popup.style.left = `${Math.round(screenX)}px`;
    popup.style.top = `${Math.round(screenY)}px`;
    layer.appendChild(popup);
    const timer = setTimeout(() => {
      this.popupTimers.delete(timer);
      popup.remove();
    }, 1250);
    this.popupTimers.add(timer);
  }

  /** Show a brief bold animated center turn/event banner with optional 3D species portrait. */
  public showTurnBanner(
    title: string,
    subtitle = "",
    tone: "mine" | "retreat" | "pod" = "mine",
    species?: SpeciesId,
  ): void {
    if (species) {
      this.turnBannerAvatarEl.src = getSpeciesPortraitUrl(species);
      this.turnBannerAvatarEl.alt = SPECIES_CATALOG[species].name;
      this.turnBannerAvatarEl.classList.remove("cs-hidden");
    } else {
      this.turnBannerAvatarEl.classList.add("cs-hidden");
    }
    this.turnBannerTitleEl.textContent = title;
    this.turnBannerSubEl.textContent = subtitle;
    this.turnBannerSubEl.classList.toggle("cs-hidden", subtitle.length === 0);
    this.turnBannerEl.dataset.tone = tone;
    this.turnBannerEl.classList.remove("cs-hidden", "cs-banner-anim");
    void this.turnBannerEl.offsetWidth;
    this.turnBannerEl.classList.add("cs-banner-anim");

    if (this.bannerTimer !== null) {
      clearTimeout(this.bannerTimer);
    }
    this.bannerTimer = setTimeout(() => {
      this.turnBannerEl.classList.add("cs-hidden");
      this.turnBannerEl.classList.remove("cs-banner-anim");
      this.bannerTimer = null;
    }, 1650);
  }

  /** Show the minimal floating left-dock Lobby over the full-screen live 3D island. */
  public showLobby(
    profile: PlayerProfile,
    selection: LobbySelectionState,
    onlineLobby: LobbyViewState | null,
  ): void {
    this.lobbyLayer.classList.remove("cs-hidden");
    this.gameLayer.classList.add("cs-hidden");
    this.visorOverlay.classList.add("cs-hidden");
    this.droneOverlay.classList.add("cs-hidden");
    this.syncDroneMarkersDom(undefined, false);
    this.draftModal.classList.add("cs-hidden");
    this.matchOverModal.classList.add("cs-hidden");
    this.floodAlertEl.classList.add("cs-hidden");
    this.setHelpCardOpen(false);
    if (this.armoryOpen) {
      this.setArmoryOpen(false);
    } else {
      this.armoryModal.classList.add("cs-hidden");
    }

    const isOnlineRoom =
      onlineLobby !== null &&
      onlineLobby.mode === "online" &&
      onlineLobby.roomCode !== null;
    if (isOnlineRoom || selection.joinCodeInput.length === 4) {
      this.multiplayerOpen = true;
    }

    const sig = JSON.stringify({
      profile,
      selection,
      onlineLobby,
      multiplayerOpen: this.multiplayerOpen,
      shopOpen: this.shopOpen,
      loadoutOpen: this.loadoutOpen,
    });
    if (sig === this.lastLobbySig) {
      return;
    }
    this.lastLobbySig = sig;
    this.renderLobbyDom(profile, selection, onlineLobby);
  }

  /** Update the live in-game HUD, round clock, camera pills, Armory, glowing Power Bar, HOLD TO FIRE button, compass, and modals. */
  public updateGameHud(frame: HudFrameState): void {
    this.lobbyLayer.classList.add("cs-hidden");
    this.gameLayer.classList.remove("cs-hidden");
    this.lastLobbySig = "";

    const { matchState, localPlayerId, cameraMode, selectedGadget } = frame;
    const activeCritter = matchState.critters.find(
      (c) => c.id === matchState.activePlayerId,
    );
    const localCritter =
      matchState.critters.find((c) => c.id === localPlayerId) ??
      matchState.critters[0] ??
      null;

    if (
      frame.armoryOpen !== undefined &&
      frame.armoryOpen !== this.armoryOpen
    ) {
      this.setArmoryOpen(frame.armoryOpen);
    }

    const armoryLockedOut =
      matchState.phase === "FINAL_FLOOD" || matchState.phase === "MATCH_OVER";
    if (armoryLockedOut && this.armoryOpen) {
      this.setArmoryOpen(false);
    }

    // Top telemetry pill: Round badge + 5-minute Round Clock + Phase badge + Turn timer
    this.topRoundEl.textContent = `R${matchState.round}/${matchState.maxRounds}`;
    const isFinalFlood = matchState.phase === "FINAL_FLOOD";
    const roundSec = Math.max(0, Math.ceil(matchState.roundTimeRemainingSec));
    this.topRoundTimerEl.textContent = isFinalFlood
      ? "FLOOD!"
      : formatRoundClock(roundSec);
    this.topRoundTimerEl.classList.toggle("cs-rt-flood", isFinalFlood);
    this.topRoundTimerEl.classList.toggle(
      "cs-rt-urgent",
      !isFinalFlood && roundSec <= 20,
    );
    this.topRoundTimerEl.classList.toggle(
      "cs-rt-warn",
      !isFinalFlood && roundSec > 20 && roundSec <= 60,
    );

    const isMyTurn =
      localPlayerId !== null && matchState.activePlayerId === localPlayerId;
    const phaseLabel =
      matchState.phase === "RETREAT"
        ? isMyTurn
          ? "RETREAT!"
          : "RETREAT"
        : matchState.phase === "RESOLVING"
          ? "IN FLIGHT"
          : matchState.phase === "ROUND_DRAFT" ||
              matchState.phase === "DRAFT_IF_READY"
            ? "EVO DRAFT"
            : matchState.phase === "FINAL_FLOOD"
              ? "FINAL FLOOD"
              : matchState.phase === "MATCH_OVER"
                ? "FINISH"
                : isMyTurn
                  ? "YOUR TURN"
                  : "RIVAL";
    this.topPhaseEl.textContent = phaseLabel;
    this.topPhaseEl.dataset.tone =
      matchState.phase === "FINAL_FLOOD"
        ? "flood"
        : matchState.phase === "RETREAT"
          ? "retreat"
          : isMyTurn && matchState.phase === "ACTIVE"
            ? "mine"
            : "neutral";

    const secs = Math.max(0, Math.ceil(matchState.phaseTimeRemainingSec));
    this.topTimerEl.textContent = isFinalFlood ? "🌊" : `${secs}s`;
    this.topTimerEl.classList.toggle(
      "cs-timer-warn",
      !isFinalFlood && matchState.phase === "ACTIVE" && secs >= 4 && secs <= 10,
    );
    this.topTimerEl.classList.toggle(
      "cs-timer-urgent",
      !isFinalFlood &&
        ((matchState.phase === "ACTIVE" && secs >= 1 && secs <= 3) ||
          (matchState.phase === "RETREAT" && secs >= 1 && secs <= 5)),
    );

    this.topActiveEl.textContent = activeCritter ? activeCritter.name : "—";

    const windSpeed = Math.hypot(matchState.wind.x, matchState.wind.z);
    const windAngleDeg =
      (Math.atan2(matchState.wind.x, -matchState.wind.z) * 180) / Math.PI;
    this.windArrowEl.style.transform = `rotate(${windAngleDeg.toFixed(1)}deg)`;
    this.windArrowEl.style.opacity = windSpeed < 0.15 ? "0.35" : "1";
    this.windSpeedEl.textContent = `${windSpeed.toFixed(1)}`;

    // Non-blocking top-center Flood Alert overlay during Round 5 FINAL_FLOOD
    this.floodAlertEl.classList.toggle("cs-hidden", !isFinalFlood);

    // Camera switcher active highlight
    this.camShoulderBtn.classList.toggle(
      "cs-cam-active",
      cameraMode === "over_shoulder",
    );
    this.camVisorBtn.classList.toggle(
      "cs-cam-active",
      cameraMode === "first_person",
    );
    this.camDroneBtn.classList.toggle(
      "cs-cam-active",
      cameraMode === "drone_recon" || cameraMode === "spectator_drone",
    );

    this.updateMuteIcon(frame.muted);
    this.updateMusicMuteIcon(Boolean(frame.musicMuted));

    // Top compass pips (Rival + Evo Pod)
    this.syncCompassStrip(frame.compass);

    // Live Center Charge Arc + Unmistakable Glowing Power Bar above the Gadget Dock
    const chargeFrac = Math.max(0, Math.min(1, frame.chargePower));
    const chargePct = Math.round(chargeFrac * 100);
    this.centerChargeEl.classList.toggle("cs-hidden", !frame.charging);
    this.powerBarWrapEl.classList.toggle("cs-hidden", !frame.charging);
    if (frame.charging) {
      const arcTotal = 255;
      this.centerChargeArcEl.style.strokeDashoffset = `${(arcTotal * (1 - chargeFrac)).toFixed(1)}`;
      this.centerChargePctEl.textContent = `${chargePct}%`;
      this.powerBarFillEl.style.width = `${(chargeFrac * 100).toFixed(1)}%`;
      this.powerBarPctEl.textContent = `${chargePct}%`;
    }

    const isDrone =
      cameraMode === "drone_recon" || cameraMode === "spectator_drone";
    const canInteract =
      isMyTurn &&
      Boolean(localCritter?.alive) &&
      (matchState.phase === "ACTIVE" || matchState.phase === "RETREAT") &&
      !isDrone &&
      cameraMode !== "shot_cam" &&
      !this.armoryOpen;
    const canFireNow =
      !this.armoryOpen &&
      (frame.canFire !== undefined
        ? frame.canFire && !isDrone && cameraMode !== "shot_cam"
        : isMyTurn &&
          Boolean(localCritter?.alive) &&
          matchState.phase === "ACTIVE" &&
          !isDrone &&
          cameraMode !== "shot_cam");

    // Subtle Pointer-Lock free-look indicator pill (cached to avoid 60Hz DOM churn)
    const showLookHint = canInteract && !frame.charging;
    this.lookHintEl.classList.toggle("cs-hidden", !showLookHint);
    if (showLookHint) {
      const locked = Boolean(frame.pointerLocked);
      if (locked !== this.lastPointerLocked) {
        this.lastPointerLocked = locked;
        if (locked) {
          this.lookHintEl.classList.add("cs-look-locked");
          this.lookHintEl.innerHTML = `Mouse-Look Active · <kbd>ESC</kbd> for cursor`;
        } else {
          this.lookHintEl.classList.remove("cs-look-locked");
          this.lookHintEl.innerHTML = `Click anywhere to look freely · <kbd>ESC</kbd> for cursor`;
        }
      }
    }

    // Glowing Armory Pill Button beside the Hotbar
    const coinCount = localCritter ? Math.floor(localCritter.coins) : 0;
    this.armoryBtnEl.textContent = `🪙 ${coinCount} · Armory [B]`;
    this.armoryBtnEl.disabled = armoryLockedOut;
    this.armoryBtnEl.classList.toggle("cs-active", this.armoryOpen);

    // Accessible tactile HOLD TO FIRE button next to Gadget Dock
    this.holdFireBtnEl.classList.toggle("cs-hidden", !canFireNow);
    if (canFireNow) {
      const isUtility =
        selectedGadget === "vine_grapple" ||
        selectedGadget === "prism_wall" ||
        selectedGadget === "mend_brew";
      this.holdFireBtnEl.classList.toggle("cs-charging", frame.charging);
      this.holdFireBtnEl.textContent =
        selectedGadget === "quake_club"
          ? "FIRE BLAST"
          : selectedGadget === "vine_grapple"
            ? "SHOOT HOOK"
            : isUtility
              ? "USE GADGET"
              : frame.charging
                ? `RELEASE · ${chargePct}%`
                : "HOLD TO FIRE";
    } else if (this.uiFireActive) {
      this.uiFireActive = false;
    }

    // Dismissible Turn-1 Quick-Start Pill
    this.quickStartEl.classList.toggle(
      "cs-hidden",
      !frame.showQuickStartHint ||
        frame.charging ||
        isDrone ||
        cameraMode === "shot_cam" ||
        this.armoryOpen,
    );

    // Minimal Bottom-Left Status Cluster with real 3D character portrait
    if (localCritter) {
      if (this.lastHudAvatarSpecies !== localCritter.species) {
        this.lastHudAvatarSpecies = localCritter.species;
        this.blAvatarEl.src = getSpeciesPortraitUrl(localCritter.species);
        this.blAvatarEl.alt = SPECIES_CATALOG[localCritter.species].name;
      }
      this.blAvatarEl.style.borderColor = localCritter.color;

      if (matchState.mode === "2v2" && localCritter.team) {
        this.blTeamEl.textContent = `T${localCritter.team}`;
        this.blTeamEl.classList.remove("cs-hidden");
      } else {
        this.blTeamEl.classList.add("cs-hidden");
      }

      this.blShieldEl.classList.toggle(
        "cs-hidden",
        localCritter.roundShieldRemaining <= 0,
      );

      const hpPct = Math.max(
        0,
        Math.min(100, (localCritter.hp / Math.max(1, localCritter.maxHp)) * 100),
      );
      this.blHpFillEl.style.width = `${hpPct.toFixed(1)}%`;
      this.blHpFillEl.dataset.tier =
        hpPct > 55 ? "high" : hpPct > 25 ? "mid" : "low";
      this.blHpTextEl.textContent = `${Math.ceil(localCritter.hp)}`;

      if (this.blMoveFillEl) {
        const movePct = Math.max(
          0,
          Math.min(100, frame.localMoveStamina ?? localCritter.moveStamina),
        );
        this.blMoveFillEl.style.width = `${movePct.toFixed(1)}%`;
        this.blMoveFillEl.dataset.tier =
          movePct > 35 ? "high" : movePct > 0 ? "low" : "empty";
      }

      const evoFrac = localCritter.pendingEvoDraft
        ? 1
        : Math.max(0, Math.min(1, localCritter.evoCharge / 100));
      const evoCirc = 88;
      this.blEvoCircleEl.style.strokeDashoffset = `${(evoCirc * (1 - evoFrac)).toFixed(1)}`;
      this.blEvoTextEl.textContent = localCritter.pendingEvoDraft
        ? "★"
        : `${Math.round(evoFrac * 100)}`;

      this.syncHardpointsDom(localCritter);
      this.syncHotbarDom(localCritter, selectedGadget, frame.dronePingActive);
    }

    // First-Person Optic Visor subtle frame
    this.visorOverlay.classList.toggle("cs-hidden", cameraMode !== "first_person");

    // Tactical Drone Recon / Spectator Drone overlay
    this.droneOverlay.classList.toggle("cs-hidden", !isDrone);
    if (isDrone) {
      if (cameraMode === "spectator_drone") {
        const canNudge = localCritter ? !localCritter.droneNudgeUsedThisTurn : false;
        this.droneBadgeEl.textContent = canNudge
          ? "SPECTATOR DRONE · [X] NUDGE WIND"
          : "SPECTATOR DRONE · NUDGE USED";
      } else {
        this.droneBadgeEl.textContent =
          "DRONE RECON · CLICK ISLAND TO PING · [TAB] EXIT";
      }
      const compass = getWindCompassLabel(matchState.wind.x, matchState.wind.z);
      this.droneCompassEl.textContent = `WIND ${compass} · ${windSpeed.toFixed(1)} m/s`;
    }
    this.syncDroneMarkersDom(frame.droneMarkers, isDrone);

    // Live Collapsible 5-Round Standings Panel
    this.syncStandingsDom(matchState, localPlayerId);

    // Mutation Draft Modal, Anytime Armory Modal & Match Over Summary Modal
    this.syncDraftModal(matchState, localPlayerId);
    this.syncArmoryModal(matchState, localCritter);
    this.syncMatchOverModal(matchState, localPlayerId, frame.essenceBreakdown);
  }

  /** Clean up timers and detach HUD DOM. */
  public dispose(): void {
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    if (this.bannerTimer !== null) {
      clearTimeout(this.bannerTimer);
      this.bannerTimer = null;
    }
    for (const timer of this.popupTimers) {
      clearTimeout(timer);
    }
    this.popupTimers.clear();
    this.droneMarkerEls.clear();
    this.root.innerHTML = "";
  }

  private syncDroneMarkersDom(
    markers: readonly DronePlayerMarkerData[] | undefined,
    visible: boolean,
  ): void {
    if (!visible || !markers || markers.length === 0) {
      if (this.droneMarkerEls.size > 0) {
        this.droneMarkersEl.innerHTML = "";
        this.droneMarkerEls.clear();
      }
      return;
    }

    const seen = new Set<string>();
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      if (!m || !Number.isFinite(m.screenX) || !Number.isFinite(m.screenY)) {
        continue;
      }
      seen.add(m.id);

      let el = this.droneMarkerEls.get(m.id);
      if (!el) {
        el = document.createElement("div");
        el.dataset.markerId = m.id;
        this.droneMarkersEl.appendChild(el);
        this.droneMarkerEls.set(m.id, el);
      }

      const accentColor = m.isLocal ? "#facc15" : m.color;
      el.className = `cs-drone-marker${m.isLocal ? " cs-dm-local" : " cs-dm-clickable"}${m.isActiveTurn ? " cs-dm-active" : ""}${m.offscreen ? " cs-dm-offscreen" : ""}`;
      if (m.isLocal) {
        delete el.dataset.critterId;
        el.title = "";
      } else {
        el.dataset.critterId = m.id;
        el.title = "Click to GPS-lock Seeker Firefly";
      }
      el.style.setProperty("--dm-color", accentColor);
      el.style.transform = `translate3d(${m.screenX.toFixed(1)}px, ${m.screenY.toFixed(1)}px, 0) translate(-50%, -100%)`;

      if (m.offscreen) {
        const deg = Number.isFinite(m.edgeAngleRad)
          ? (m.edgeAngleRad * 180) / Math.PI
          : 0;
        el.style.setProperty("--dm-angle", `${deg.toFixed(1)}deg`);
      }

      const hpVal = Math.max(0, Math.ceil(m.hp));
      const sig = `${m.isLocal ? 1 : 0}|${m.isActiveTurn ? 1 : 0}|${m.offscreen ? 1 : 0}|${m.name}|${m.speciesName}|${hpVal}|${m.team ?? ""}|${m.distanceMeters ?? ""}`;
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        const turnDot = m.isActiveTurn
          ? `<span class="cs-dm-turn-dot" title="Active Turn"></span>`
          : "";
        const indicator = m.offscreen
          ? `<div class="cs-dm-arrow" aria-hidden="true">➤</div>`
          : `<div class="cs-dm-pin" aria-hidden="true"></div>`;

        if (m.isLocal) {
          el.innerHTML = `
            <div class="cs-dm-pill">
              <span class="cs-dm-star">★ YOU · ${escapeHtml(m.name)}</span>
              ${turnDot}
              <span class="cs-dm-hp">${hpVal} HP</span>
            </div>
            ${indicator}
          `;
        } else {
          const teamTag = m.team
            ? `<span class="cs-dm-team">TEAM ${escapeHtml(m.team)}</span>`
            : "";
          const distTag =
            m.distanceMeters !== null
              ? `<span class="cs-dm-dist">${m.distanceMeters}m</span>`
              : "";
          el.innerHTML = `
            <div class="cs-dm-pill">
              <span class="cs-dm-dot"></span>
              <span class="cs-dm-name">${escapeHtml(m.name)}</span>
              ${teamTag}
              ${turnDot}
              <span class="cs-dm-meta">${escapeHtml(m.speciesName)} · ${hpVal} HP</span>
              ${distTag}
            </div>
            ${indicator}
          `;
        }
      }
    }

    for (const [id, el] of this.droneMarkerEls.entries()) {
      if (!seen.has(id)) {
        el.remove();
        this.droneMarkerEls.delete(id);
      }
    }
  }

  private syncStandingsDom(
    state: MatchState,
    localPlayerId: string | null,
  ): void {
    let sig = `${state.round}/${state.maxRounds}|${state.mode}|${state.activePlayerId ?? ""}|${localPlayerId ?? ""}`;
    for (let i = 0; i < state.critters.length; i++) {
      const c = state.critters[i];
      if (!c) continue;
      sig += `|${c.id}:${c.score}:${c.kills}:${Math.round(c.damageDealt)}:${Math.ceil(c.hp)}/${c.maxHp}:${c.alive ? 1 : 0}:${c.color}`;
    }
    if (sig === this.lastStandingsSig) {
      return;
    }
    this.lastStandingsSig = sig;
    this.standingsTitleEl.textContent = `STANDINGS · R${state.round}/${state.maxRounds}`;

    const sorted = [...state.critters].sort(
      (a, b) =>
        b.score - a.score ||
        b.kills - a.kills ||
        b.damageDealt - a.damageDealt,
    );

    this.standingsBodyEl.innerHTML = sorted
      .map((c) => {
        const isActive = c.id === state.activePlayerId;
        const isLocal = localPlayerId !== null && c.id === localPlayerId;
        const hpPct = c.alive
          ? Math.max(0, Math.min(100, (c.hp / Math.max(1, c.maxHp)) * 100))
          : 0;
        const tier = hpPct > 55 ? "high" : hpPct > 25 ? "mid" : "low";
        const teamChip =
          state.mode === "2v2" && c.team
            ? `<span class="cs-st-team">T${escapeHtml(c.team)}</span>`
            : "";
        return `
          <div class="cs-standings-row ${isActive ? "cs-st-active" : ""} ${isLocal ? "cs-st-local" : ""} ${c.alive ? "" : "cs-st-ko"}">
            <span class="cs-st-pip" style="background:${escapeHtml(c.color)}"></span>
            <div class="cs-st-main">
              <div class="cs-st-name-line">
                <span class="cs-st-name">${escapeHtml(c.name)}</span>
                ${isLocal ? `<span class="cs-st-you">YOU</span>` : ""}
                ${teamChip}
              </div>
              <div class="cs-standings-hp">
                ${
                  c.alive
                    ? `<div class="cs-standings-hp-fill" data-tier="${tier}" style="width:${hpPct.toFixed(0)}%"></div>`
                    : `<span class="cs-st-ko-tag">KO</span>`
                }
              </div>
            </div>
            <span class="cs-st-kills" title="Kills">${c.kills}K</span>
            <strong class="cs-st-score" title="Match Points">${c.score}</strong>
          </div>
        `;
      })
      .join("");
  }

  private updateMuteIcon(muted: boolean): void {
    if (muted === this.lastMuted) {
      return;
    }
    this.lastMuted = muted;
    this.muteBtnEl.dataset.muted = muted ? "1" : "0";
    this.muteBtnEl.innerHTML = muted
      ? `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h3l4-3.5v11L6 12H3z"/><path d="M13.5 7.5l4 5M17.5 7.5l-4 5"/></svg>`
      : `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h3l4-3.5v11L6 12H3z"/><path d="M13.5 7.2a4.2 4.2 0 0 1 0 5.6M15.8 4.8a7.4 7.4 0 0 1 0 10.4"/></svg>`;
  }

  private updateMusicMuteIcon(muted: boolean): void {
    this.musicMuteBtnEl.dataset.muted = muted ? "1" : "0";
  }

  private syncCompassStrip(compass?: HudCompassState): void {
    const rival = compass?.rival ?? null;
    const pod = compass?.evoPod ?? null;
    const hasAny = rival !== null || pod !== null;
    this.compassBarEl.classList.toggle("cs-hidden", !hasAny);
    if (!hasAny) {
      return;
    }

    if (rival) {
      this.compassRivalEl.classList.remove("cs-hidden");
      const norm = Math.max(-1, Math.min(1, rival.bearingRad / (Math.PI * 0.72)));
      const pct = 50 + norm * 42;
      const arrow =
        rival.bearingRad < -0.32 ? "◂" : rival.bearingRad > 0.32 ? "▸" : "▼";
      this.compassRivalEl.style.left = `${pct.toFixed(1)}%`;
      this.compassRivalEl.style.setProperty(
        "--pip-color",
        rival.color ?? "#fb7185",
      );
      this.compassRivalEl.textContent = `${arrow} ${Math.round(rival.distanceM)}m`;
    } else {
      this.compassRivalEl.classList.add("cs-hidden");
    }

    if (pod) {
      this.compassPodEl.classList.remove("cs-hidden");
      const norm = Math.max(-1, Math.min(1, pod.bearingRad / (Math.PI * 0.72)));
      const pct = 50 + norm * 42;
      const arrow =
        pod.bearingRad < -0.32 ? "◂" : pod.bearingRad > 0.32 ? "▸" : "◆";
      this.compassPodEl.style.left = `${pct.toFixed(1)}%`;
      this.compassPodEl.textContent = `${arrow} POD ${Math.round(pod.distanceM)}m`;
    } else {
      this.compassPodEl.classList.add("cs-hidden");
    }
  }

  private renderLobbyDom(
    profile: PlayerProfile,
    selection: LobbySelectionState,
    onlineLobby: LobbyViewState | null,
  ): void {
    const activeTheme = onlineLobby ? onlineLobby.theme : selection.theme;
    const activeMode = onlineLobby ? onlineLobby.gameMode : selection.gameMode;
    const activeMapScale: MapScaleChoice = onlineLobby
      ? (onlineLobby.mapScale ?? "auto")
      : (selection.mapScale ?? "auto");
    const activeBots = onlineLobby ? onlineLobby.botCount : selection.botCount;
    const isOnlineRoom =
      onlineLobby !== null &&
      onlineLobby.mode === "online" &&
      onlineLobby.roomCode !== null;
    const isHost = !isOnlineRoom || onlineLobby.hostId === onlineLobby.playerId;

    const validatedLoadout = validateAndBuildStartingLoadout(
      selection.startingLoadout ?? DEFAULT_STARTING_LOADOUT,
      DEFAULT_STARTING_COINS,
    );
    const activeLoadout = validatedLoadout.loadout;
    const remainingStartCoins = validatedLoadout.remainingCoins;

    const canAffordAnything =
      SPECIES_IDS.some(
        (id) =>
          !profile.unlockedSpecies.includes(id) &&
          profile.essence >= SPECIES_CATALOG[id].unlockCost,
      ) ||
      COSMETIC_ACCENT_CATALOG.some(
        (c) =>
          !profile.unlockedCosmetics.includes(c.id) &&
          profile.essence >= c.cost,
      );

    const speciesTilesHtml = SPECIES_IDS.map((id) => {
      const def = SPECIES_CATALOG[id];
      const meta = SPECIES_BADGE_META[id];
      const unlocked = profile.unlockedSpecies.includes(id);
      const selected = profile.selectedSpecies === id;
      const canAfford = profile.essence >= def.unlockCost;
      return `
        <div
          class="cs-sp-tile ${selected ? "cs-selected" : ""} ${unlocked ? "" : "cs-locked"}"
          data-species-card="${id}"
          style="--sp-accent:${meta.accent}"
          title="${escapeHtml(def.name)} (${def.baseHp} HP)"
        >
          <div class="cs-sp-portrait">
            <img src="${getSpeciesPortraitUrl(id)}" alt="${escapeHtml(def.name)}" loading="eager" />
          </div>
          <div class="cs-sp-name">${escapeHtml(meta.shortName)}</div>
          ${
            unlocked
              ? `<span class="cs-sp-chip">${escapeHtml(meta.chip)}</span>`
              : `<button type="button" class="cs-sp-unlock" data-unlock-species="${id}" ${canAfford ? "" : "disabled"}>🔒 ${def.unlockCost}✦</button>`
          }
        </div>
      `;
    }).join("");

    const themePillsHtml = THEME_META.map(
      (t) => `
        <button type="button" class="cs-chip-btn ${activeTheme === t.id ? "cs-active" : ""}" data-theme="${t.id}" ${isHost ? "" : "disabled"}>
          ${escapeHtml(t.shortLabel)}
        </button>
      `,
    ).join("");

    const mapScalePillsHtml = MAP_SCALE_META.map(
      (m) => `
        <button type="button" class="cs-chip-btn ${activeMapScale === m.id ? "cs-active" : ""}" data-map-scale="${m.id}" title="${escapeHtml(m.title)}" ${isHost ? "" : "disabled"}>
          ${escapeHtml(m.label)}
        </button>
      `,
    ).join("");

    const botCounts = isOnlineRoom ? [0, 1, 2, 3] : [1, 2, 3];
    const botPillsHtml = botCounts
      .map(
        (n) => `
        <button type="button" class="cs-chip-btn ${activeBots === n ? "cs-active" : ""}" data-bots="${n}" ${isHost ? "" : "disabled"}>
          ${n}
        </button>
      `,
      )
      .join("");

    const colorSwatchesHtml = PLAYER_COLOR_PALETTE.map(
      (hex) => `
        <button type="button" class="cs-swatch ${profile.selectedColor.toLowerCase() === hex.toLowerCase() ? "cs-selected" : ""}" data-color="${hex}" style="background:${hex}" aria-label="Color ${hex}"></button>
      `,
    ).join("");

    const loadoutBarIconsHtml = activeLoadout
      .map(
        (gid) => `
        <span class="cs-loadout-icon-chip" title="${escapeHtml(GADGET_CATALOG[gid].name)}">
          ${getGadgetSvgIcon(gid)}
        </span>
      `,
      )
      .join("");

    const loadoutCardsHtml = GADGET_IDS.map((gid) => {
      const def = GADGET_CATALOG[gid];
      const isStarter = gid === "gale_mortar";
      const isSelected = activeLoadout.includes(gid);
      const canAdd =
        !isSelected &&
        activeLoadout.length < MAX_LOADOUT_SLOTS &&
        def.shopCost <= remainingStartCoins;
      const disabled = isStarter || (!isSelected && !canAdd);
      const chargeLabel =
        def.startingCharges === null ? "∞" : `×${def.startingCharges}`;
      const priceLabel = isStarter
        ? "FREE"
        : isSelected
          ? `✓ ${def.shopCost} 🪙`
          : `${def.shopCost} 🪙`;

      return `
        <button
          type="button"
          class="cs-loadout-card ${isSelected ? "cs-selected" : ""} ${isStarter ? "cs-starter" : ""}"
          data-loadout-gadget="${gid}"
          ${disabled ? "disabled" : ""}
        >
          <div class="cs-loadout-card-top">
            <span class="cs-loadout-card-icon">${getGadgetSvgIcon(gid)}</span>
            <span class="cs-loadout-card-name">${escapeHtml(def.name)}</span>
          </div>
          <div class="cs-loadout-card-desc">${escapeHtml(GADGET_CONCISE_EFFECT[gid])}</div>
          <div class="cs-loadout-card-foot">
            <span class="cs-loadout-charges">${chargeLabel}</span>
            <span class="cs-loadout-price">${priceLabel}</span>
          </div>
        </button>
      `;
    }).join("");

    const loadoutDrawerHtml = this.loadoutOpen
      ? `
        <aside class="cs-loadout-drawer cs-glass">
          <div class="cs-loadout-head">
            <span class="cs-loadout-title">Starting Loadout (${MAX_LOADOUT_SLOTS} Slots)</span>
            <div class="cs-loadout-head-right">
              <span class="cs-coin-badge">🪙 ${remainingStartCoins} / ${DEFAULT_STARTING_COINS}</span>
              <button type="button" class="cs-mini-pill-btn" data-action="reset-loadout">Reset</button>
              <button type="button" class="cs-close-btn" data-action="close-loadout" aria-label="Close Loadout Customizer">×</button>
            </div>
          </div>
          <div class="cs-shop-sub">Unspent Siege Coins carry straight into Round 1! Click equipped abilities to refund.</div>
          <div class="cs-loadout-grid">${loadoutCardsHtml}</div>
        </aside>
      `
      : "";

    const multiplayerDrawerHtml = isOnlineRoom
      ? `
        <div class="cs-mp-drawer">
          <div class="cs-room-top">
            <span class="cs-room-code">${escapeHtml(onlineLobby.roomCode ?? "")}</span>
            <div class="cs-room-actions">
              <button type="button" class="cs-mini-pill-btn" data-action="copy-invite" title="Copy Invite Link">Invite</button>
              <button type="button" class="cs-mini-pill-btn cs-danger-pill" data-action="leave-room">Leave</button>
            </div>
          </div>
          <div class="cs-roster">
            ${onlineLobby.players
              .map(
                (p) => `
              <div class="cs-roster-row">
                <img class="cs-roster-avatar" src="${getSpeciesPortraitUrl(p.species)}" alt="${escapeHtml(SPECIES_CATALOG[p.species].name)}" style="border-color:${escapeHtml(p.color)}" />
                <span class="cs-roster-name">${escapeHtml(p.name)}${p.id === onlineLobby.hostId ? " ★" : ""}</span>
                <span class="cs-roster-species">${escapeHtml(SPECIES_BADGE_META[p.species].shortName)}</span>
                ${activeMode === "2v2" ? `<span class="cs-team-chip">T${p.team === 0 ? "A" : "B"}</span>` : ""}
              </div>
            `,
              )
              .join("")}
          </div>
          ${
            isHost
              ? `<button type="button" class="cs-btn cs-btn-primary cs-btn-full" data-action="start-online" ${onlineLobby.players.length < 2 ? "disabled" : ""}>Launch Match (${onlineLobby.players.length})</button>`
              : `<div class="cs-wait-note">Waiting for host...</div>`
          }
        </div>
      `
      : this.multiplayerOpen
        ? `
        <div class="cs-mp-drawer">
          <button type="button" class="cs-btn cs-btn-secondary cs-btn-full" data-action="create-room">Create 4-Letter Room</button>
          <div class="cs-join-row">
            <input type="text" maxlength="4" class="cs-input cs-code-input" data-ref="join-code" placeholder="CODE" value="${escapeHtml(selection.joinCodeInput)}" />
            <button type="button" class="cs-btn cs-btn-secondary" data-action="join-room">Join</button>
          </div>
        </div>
      `
        : "";

    const unlockableSpeciesHtml = SPECIES_IDS.filter(
      (id) => !SPECIES_CATALOG[id].starter,
    )
      .map((id) => {
        const def = SPECIES_CATALOG[id];
        const meta = SPECIES_BADGE_META[id];
        const unlocked = profile.unlockedSpecies.includes(id);
        const selected = profile.selectedSpecies === id;
        const canAfford = profile.essence >= def.unlockCost;
        return `
          <div class="cs-shop-item ${selected ? "cs-selected" : ""}" data-species-card="${id}" title="${escapeHtml(def.description)}">
            <img class="cs-roster-avatar" src="${getSpeciesPortraitUrl(id)}" alt="${escapeHtml(def.name)}" style="border-color:${meta.accent}" />
            <div class="cs-shop-info">
              <strong>${escapeHtml(def.name)}</strong>
              <span>${def.baseHp} HP · ${escapeHtml(meta.chip)}</span>
            </div>
            ${
              unlocked
                ? `<span class="cs-shop-tag">${selected ? "Selected" : "Select"}</span>`
                : `<button type="button" class="cs-sp-unlock" data-unlock-species="${id}" ${canAfford ? "" : "disabled"}>${def.unlockCost}✦</button>`
            }
          </div>
        `;
      })
      .join("");

    const cosmeticCardsHtml = COSMETIC_ACCENT_CATALOG.map((cosmetic) => {
      const unlocked = profile.unlockedCosmetics.includes(cosmetic.id);
      const equipped =
        profile.selectedColor.toLowerCase() === cosmetic.hex.toLowerCase();
      const canAfford = profile.essence >= cosmetic.cost;
      return `
        <div class="cs-shop-item ${equipped ? "cs-selected" : ""}" data-cosmetic-card="${cosmetic.id}" title="${escapeHtml(cosmetic.description)}">
          <span class="cs-cosmetic-swatch" style="background:${escapeHtml(cosmetic.hex)};box-shadow:0 0 12px ${escapeHtml(cosmetic.hex)}88"></span>
          <div class="cs-shop-info">
            <strong>${escapeHtml(cosmetic.name)}</strong>
            <span>${escapeHtml(cosmetic.description)}</span>
          </div>
          ${
            unlocked
              ? `<span class="cs-shop-tag">${equipped ? "Equipped" : "Equip"}</span>`
              : `<button type="button" class="cs-sp-unlock" data-unlock-cosmetic="${cosmetic.id}" ${canAfford ? "" : "disabled"}>${cosmetic.cost}✦</button>`
          }
        </div>
      `;
    }).join("");

    const shopDrawerHtml = this.shopOpen
      ? `
        <aside class="cs-shop-drawer cs-glass">
          <div class="cs-shop-head">
            <span>✦ Essence Shop</span>
            <button type="button" class="cs-close-btn" data-action="close-shop" aria-label="Close Shop">×</button>
          </div>
          <div class="cs-shop-sub">Unlockable Critters</div>
          <div class="cs-shop-list">${unlockableSpeciesHtml}</div>
          <div class="cs-shop-sub">Cosmetic Collar Accents</div>
          <div class="cs-shop-list">${cosmeticCardsHtml}</div>
        </aside>
      `
      : "";

    const activeSpecDef = SPECIES_CATALOG[profile.selectedSpecies];
    const activeSpecMeta = SPECIES_BADGE_META[profile.selectedSpecies];

    this.lobbyLayer.innerHTML = `
      <div class="cs-dock-wrap">
        <div class="cs-left-dock cs-glass">
          <header class="cs-dock-head">
            <div class="cs-brand">
              <div class="cs-brand-mark" aria-hidden="true">
                <svg viewBox="0 0 32 32" width="26" height="26">
                  <circle cx="16" cy="16" r="15" fill="rgba(14,165,233,0.22)" stroke="#4df4ff" stroke-width="1.6"/>
                  <path d="M6 20c4-7 16-7 20 0-3 5-17 5-20 0z" fill="#34d399"/>
                  <path d="M9 22c3 4 11 4 14 0-2.5 6-11.5 6-14 0z" fill="#d97742"/>
                  <circle cx="16" cy="12" r="4.2" fill="#4df4ff"/>
                </svg>
              </div>
              <h1 class="cs-title">${escapeHtml(GAME_TITLE)}</h1>
            </div>
            <div class="cs-essence-pill" title="Siege Essence">
              <span>✦</span><strong>${profile.essence}</strong>
            </div>
          </header>

          <div class="cs-primary-actions">
            ${
              isOnlineRoom
                ? ""
                : `
              <button type="button" class="cs-btn cs-btn-primary cs-play-cta" data-action="play-sandbox">
                <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 4l11 6-11 6z"/></svg>
                <span>Play Now</span>
              </button>
              <button type="button" class="cs-btn cs-btn-secondary ${this.multiplayerOpen ? "cs-btn-open" : ""}" data-action="toggle-mp">
                Multiplayer
              </button>
            `
            }
          </div>

          ${multiplayerDrawerHtml}

          <div class="cs-species-grid">${speciesTilesHtml}</div>

          <div class="cs-settings-compact">
            <div class="cs-setting-line">
              <span class="cs-set-label">Island</span>
              <div class="cs-chip-group">${themePillsHtml}</div>
            </div>
            <div class="cs-setting-line">
              <span class="cs-set-label">Map</span>
              <div class="cs-chip-group">${mapScalePillsHtml}</div>
            </div>
            <div class="cs-setting-line cs-setting-split">
              <div class="cs-chip-group">
                <button type="button" class="cs-chip-btn ${activeMode === "ffa" ? "cs-active" : ""}" data-mode="ffa" ${isHost ? "" : "disabled"}>FFA</button>
                <button type="button" class="cs-chip-btn ${activeMode === "2v2" ? "cs-active" : ""}" data-mode="2v2" ${isHost ? "" : "disabled"}>2v2</button>
              </div>
              <div class="cs-chip-group">
                <span class="cs-set-label">Bots</span>
                ${botPillsHtml}
              </div>
            </div>
          </div>

          <div class="cs-loadout-bar">
            <div class="cs-loadout-bar-top">
              <div class="cs-loadout-icons">
                ${loadoutBarIconsHtml}
                <span class="cs-loadout-count">${activeLoadout.length}/${MAX_LOADOUT_SLOTS}</span>
              </div>
              <span class="cs-loadout-coins">🪙 ${remainingStartCoins} left</span>
            </div>
            <button type="button" class="cs-loadout-toggle ${this.loadoutOpen ? "cs-active" : ""}" data-action="toggle-loadout">
              ⚔ Customize Abilities (10 Arsenal)
            </button>
          </div>

          <footer class="cs-dock-footer">
            <div class="cs-id-row">
              <input type="text" maxlength="18" class="cs-input cs-name-input" data-ref="player-name" value="${escapeHtml(profile.displayName)}" placeholder="Name" aria-label="Player Name" />
              <div class="cs-swatches">${colorSwatchesHtml}</div>
            </div>
            <button type="button" class="cs-shop-toggle ${this.shopOpen ? "cs-active" : ""}" data-action="toggle-shop">
              ✦ Shop${canAffordAnything ? `<span class="cs-notif-dot"></span>` : ""}
            </button>
          </footer>
        </div>

        ${loadoutDrawerHtml}
        ${shopDrawerHtml}
      </div>

      <div class="cs-hero-stage-badge cs-glass">
        <img class="cs-hero-stage-avatar" src="${getSpeciesPortraitUrl(profile.selectedSpecies)}" alt="${escapeHtml(activeSpecDef.name)}" style="border-color:${activeSpecMeta.accent}" />
        <div class="cs-hero-stage-copy">
          <span class="cs-hero-stage-name">${escapeHtml(activeSpecDef.name)}</span>
          <span class="cs-hero-stage-chip">${activeSpecDef.baseHp} HP · ${escapeHtml(activeSpecMeta.chip)}</span>
        </div>
      </div>
    `;

    this.bindLobbyEvents(profile, selection, onlineLobby, activeLoadout, remainingStartCoins);
  }

  private bindLobbyEvents(
    profile: PlayerProfile,
    selection: LobbySelectionState,
    onlineLobby: LobbyViewState | null,
    activeLoadout: readonly GadgetId[],
    remainingStartCoins: number,
  ): void {
    const nameInput = this.lobbyLayer.querySelector(
      '[data-ref="player-name"]',
    ) as HTMLInputElement | null;
    if (nameInput) {
      nameInput.addEventListener("change", () => {
        this.callbacks.onNameChange(nameInput.value);
      });
    }

    const codeInput = this.lobbyLayer.querySelector(
      '[data-ref="join-code"]',
    ) as HTMLInputElement | null;
    if (codeInput) {
      codeInput.addEventListener("input", () => {
        codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, "");
        selection.joinCodeInput = codeInput.value;
      });
    }

    this.lobbyLayer
      .querySelectorAll<HTMLButtonElement>("[data-color]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const hex = btn.dataset.color;
          if (hex) this.callbacks.onColorChange(hex);
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLButtonElement>("[data-theme]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const theme = btn.dataset.theme as ThemeId | undefined;
          if (theme) this.callbacks.onThemeChange(theme);
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLButtonElement>("[data-map-scale]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const mapScale = btn.dataset.mapScale as MapScaleChoice | undefined;
          if (mapScale) this.callbacks.onMapScaleChange?.(mapScale);
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLButtonElement>("[data-mode]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = btn.dataset.mode as GameMode | undefined;
          if (mode) this.callbacks.onGameModeChange(mode);
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLButtonElement>("[data-bots]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const count = Number(btn.dataset.bots);
          if (Number.isInteger(count)) this.callbacks.onBotCountChange(count);
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLButtonElement>("[data-unlock-species]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const sp = btn.dataset.unlockSpecies as SpeciesId | undefined;
          if (sp) this.callbacks.onUnlockSpecies(sp);
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLDivElement>("[data-species-card]")
      .forEach((card) => {
        card.addEventListener("click", () => {
          const sp = card.dataset.speciesCard as SpeciesId | undefined;
          if (sp && profile.unlockedSpecies.includes(sp)) {
            this.callbacks.onSelectSpecies(sp);
          }
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLButtonElement>("[data-unlock-cosmetic]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const cid = btn.dataset.unlockCosmetic;
          if (cid) this.callbacks.onUnlockCosmetic?.(cid);
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLDivElement>("[data-cosmetic-card]")
      .forEach((card) => {
        card.addEventListener("click", () => {
          const cid = card.dataset.cosmeticCard;
          if (!cid || !profile.unlockedCosmetics.includes(cid)) {
            return;
          }
          const def = COSMETIC_ACCENT_CATALOG.find((c) => c.id === cid);
          if (def) {
            this.callbacks.onColorChange(def.hex);
          }
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLButtonElement>("[data-loadout-gadget]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const gid = btn.dataset.loadoutGadget as GadgetId | undefined;
          if (!gid || gid === "gale_mortar") {
            return;
          }
          if (activeLoadout.includes(gid)) {
            const nextLoadout = activeLoadout.filter((id) => id !== gid);
            this.callbacks.onStartingLoadoutChange?.(nextLoadout);
          } else {
            const def = GADGET_CATALOG[gid];
            if (
              activeLoadout.length < MAX_LOADOUT_SLOTS &&
              def.shopCost <= remainingStartCoins
            ) {
              const nextLoadout = [...activeLoadout, gid];
              this.callbacks.onStartingLoadoutChange?.(nextLoadout);
            }
          }
        });
      });

    const toggleLoadoutBtn = this.lobbyLayer.querySelector(
      '[data-action="toggle-loadout"]',
    );
    toggleLoadoutBtn?.addEventListener("click", () => {
      this.loadoutOpen = !this.loadoutOpen;
      if (this.loadoutOpen) {
        this.shopOpen = false;
      }
      this.lastLobbySig = "";
      this.showLobby(profile, selection, onlineLobby);
    });

    const closeLoadoutBtn = this.lobbyLayer.querySelector(
      '[data-action="close-loadout"]',
    );
    closeLoadoutBtn?.addEventListener("click", () => {
      this.loadoutOpen = false;
      this.lastLobbySig = "";
      this.showLobby(profile, selection, onlineLobby);
    });

    const resetLoadoutBtn = this.lobbyLayer.querySelector(
      '[data-action="reset-loadout"]',
    );
    resetLoadoutBtn?.addEventListener("click", () => {
      this.callbacks.onStartingLoadoutChange?.([...DEFAULT_STARTING_LOADOUT]);
    });

    const toggleMpBtn = this.lobbyLayer.querySelector('[data-action="toggle-mp"]');
    toggleMpBtn?.addEventListener("click", () => {
      this.multiplayerOpen = !this.multiplayerOpen;
      this.lastLobbySig = "";
      this.showLobby(profile, selection, onlineLobby);
    });

    const toggleShopBtn = this.lobbyLayer.querySelector(
      '[data-action="toggle-shop"]',
    );
    toggleShopBtn?.addEventListener("click", () => {
      this.shopOpen = !this.shopOpen;
      if (this.shopOpen) {
        this.loadoutOpen = false;
      }
      this.lastLobbySig = "";
      this.showLobby(profile, selection, onlineLobby);
    });

    const closeShopBtn = this.lobbyLayer.querySelector('[data-action="close-shop"]');
    closeShopBtn?.addEventListener("click", () => {
      this.shopOpen = false;
      this.lastLobbySig = "";
      this.showLobby(profile, selection, onlineLobby);
    });

    const playBtn = this.lobbyLayer.querySelector('[data-action="play-sandbox"]');
    playBtn?.addEventListener("click", () => this.callbacks.onPlaySandbox());

    const createBtn = this.lobbyLayer.querySelector('[data-action="create-room"]');
    createBtn?.addEventListener("click", () => this.callbacks.onCreateRoom());

    const joinBtn = this.lobbyLayer.querySelector('[data-action="join-room"]');
    joinBtn?.addEventListener("click", () => {
      const code = codeInput?.value ?? selection.joinCodeInput;
      this.callbacks.onJoinRoom(code);
    });

    const startOnlineBtn = this.lobbyLayer.querySelector(
      '[data-action="start-online"]',
    );
    startOnlineBtn?.addEventListener("click", () =>
      this.callbacks.onStartOnlineMatch(),
    );

    const leaveBtn = this.lobbyLayer.querySelector('[data-action="leave-room"]');
    leaveBtn?.addEventListener("click", () => this.callbacks.onLeaveRoom());

    const copyBtn = this.lobbyLayer.querySelector('[data-action="copy-invite"]');
    copyBtn?.addEventListener("click", () => this.callbacks.onCopyInviteLink());
  }

  private syncHardpointsDom(critter: CritterState): void {
    const sig = `${critter.equipped.back ?? ""}|${critter.equipped.legs ?? ""}|${critter.equipped.offense ?? ""}|${critter.equipped.crest ?? ""}|${critter.apex ?? ""}`;
    if (sig === this.lastHardpointSig) {
      return;
    }
    this.lastHardpointSig = sig;

    this.blHardpointsEl.innerHTML = HARDPOINT_SLOTS.map((slot) => {
      const mutId = critter.equipped[slot];
      const mutDef = mutId ? MUTATION_CATALOG[mutId] : null;
      const tip = mutDef
        ? `${SLOT_LABELS[slot]}: ${mutDef.name}`
        : `${SLOT_LABELS[slot]} hardpoint`;
      return `
        <div class="cs-hp-icon-slot cs-glass ${mutId ? "cs-hp-filled" : ""}" title="${escapeHtml(tip)}">
          ${mutId ? getMutationSvgIcon(mutId) : getSlotSvgIcon(slot)}
        </div>
      `;
    }).join("");

    if (critter.apex) {
      const apexDef = APEX_CATALOG[critter.apex];
      this.blApexEl.textContent = `★ ${apexDef.name.toUpperCase()}`;
      this.blApexEl.classList.remove("cs-hidden");
    } else {
      this.blApexEl.classList.add("cs-hidden");
    }
  }

  private syncHotbarDom(
    critter: CritterState,
    selectedGadget: GadgetId,
    dronePingActive: boolean,
  ): void {
    const ownedLoadout: GadgetId[] =
      critter.loadout.length > 0 ? critter.loadout : ["gale_mortar"];

    let sig = `${selectedGadget}|${dronePingActive ? 1 : 0}`;
    for (let i = 0; i < ownedLoadout.length; i++) {
      const gid = ownedLoadout[i];
      if (!gid) continue;
      const ch = critter.gadgetCharges[gid];
      sig += `|${gid}:${ch === null ? "i" : ch}`;
    }
    if (sig === this.lastHotbarSig) {
      return;
    }
    this.lastHotbarSig = sig;

    const equippedHtml = ownedLoadout
      .map((gid, idx) => {
        const def = GADGET_CATALOG[gid];
        const charges = critter.gadgetCharges[gid];
        const depleted = charges !== null && charges <= 0;
        const selected = gid === selectedGadget;
        const needsPing = Boolean(def.requiresDronePing) && !dronePingActive;
        const badgeText = charges === null ? "∞" : String(charges);
        return `
          <button
            type="button"
            class="cs-dock-slot ${selected ? "cs-slot-active" : ""} ${depleted ? "cs-slot-empty" : ""}"
            data-gadget="${gid}"
            data-tooltip="${escapeHtml(GADGET_SHORT_TOOLTIP[gid])}"
            aria-label="${escapeHtml(def.name)}"
            ${depleted ? "disabled" : ""}
          >
            <span class="cs-slot-key">${idx + 1}</span>
            <span class="cs-slot-svg">${getGadgetSvgIcon(gid)}</span>
            <span class="cs-slot-charges ${needsPing ? "cs-slot-ping" : ""}">${needsPing ? "PING" : badgeText}</span>
          </button>
        `;
      })
      .join("");

    const openSlotCount = Math.max(0, MAX_LOADOUT_SLOTS - ownedLoadout.length);
    const openSlotsHtml = Array.from({ length: openSlotCount }, () => `
      <button
        type="button"
        class="cs-dock-slot cs-slot-open"
        data-open-armory="1"
        data-tooltip="Empty Ability Slot — Open Armory [B]"
        aria-label="Open Armory"
      >
        <span class="cs-slot-open-plus">+</span>
        <span class="cs-slot-open-key">[B]</span>
      </button>
    `).join("");

    this.hotbarListEl.innerHTML = `${equippedHtml}${openSlotsHtml}`;

    this.hotbarListEl
      .querySelectorAll<HTMLButtonElement>("[data-gadget]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const gid = btn.dataset.gadget as GadgetId | undefined;
          if (gid) {
            this.callbacks.onSelectGadget(gid);
          }
        });
      });

    this.hotbarListEl
      .querySelectorAll<HTMLButtonElement>("[data-open-armory]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.setArmoryOpen(true);
        });
      });
  }

  private syncArmoryModal(
    state: MatchState,
    localCritter: CritterState | null,
  ): void {
    if (!this.armoryOpen || !localCritter) {
      this.armoryModal.classList.add("cs-hidden");
      this.lastArmorySig = "";
      return;
    }

    const purchasingDisabled =
      state.phase === "FINAL_FLOOD" || state.phase === "MATCH_OVER";
    const coins = Math.floor(localCritter.coins);
    const ownedCount = localCritter.loadout.length;

    if (
      this.pendingSwapTarget !== null &&
      (localCritter.loadout.includes(this.pendingSwapTarget) ||
        ownedCount < MAX_LOADOUT_SLOTS)
    ) {
      this.pendingSwapTarget = null;
    }

    let sig = `${state.phase}|${coins}|${this.pendingSwapTarget ?? ""}`;
    for (let i = 0; i < localCritter.loadout.length; i++) {
      const g = localCritter.loadout[i];
      if (!g) continue;
      sig += `,${g}`;
    }
    for (let i = 0; i < GADGET_IDS.length; i++) {
      const g = GADGET_IDS[i];
      if (!g) continue;
      const ch = localCritter.gadgetCharges[g];
      sig += `|${ch === null ? "i" : ch}`;
    }
    if (sig === this.lastArmorySig) {
      return;
    }
    this.lastArmorySig = sig;
    this.armoryModal.classList.remove("cs-hidden");

    const swapTarget = this.pendingSwapTarget;
    const swapBarHtml =
      swapTarget !== null
        ? (() => {
            const targetDef = GADGET_CATALOG[swapTarget];
            const swappable = localCritter.loadout.filter(
              (id) => id !== "gale_mortar",
            );
            const buttonsHtml = swappable
              .map((oldId) => {
                const oldDef = GADGET_CATALOG[oldId];
                const refund = Math.floor(oldDef.shopCost * 0.5);
                const netCost = targetDef.shopCost - refund;
                const canAffordSwap = !purchasingDisabled && coins >= netCost;
                const netLabel =
                  netCost > 0
                    ? `Net ${netCost} 🪙`
                    : netCost === 0
                      ? "FREE SWAP"
                      : `+${Math.abs(netCost)} 🪙 back`;
                return `
                  <button
                    type="button"
                    class="cs-swap-btn"
                    data-confirm-swap="${oldId}"
                    ${canAffordSwap ? "" : "disabled"}
                  >
                    Replace ${escapeHtml(oldDef.name)} (+${refund} 🪙 → ${netLabel})
                  </button>
                `;
              })
              .join("");

            return `
              <div class="cs-swap-bar">
                <div class="cs-swap-head">
                  <span>⇄ Trade-In Swap (50% Refund) — Equip ${escapeHtml(targetDef.name)} (${targetDef.shopCost} 🪙)</span>
                  <button type="button" class="cs-mini-pill-btn" data-action="cancel-swap">Cancel</button>
                </div>
                <div class="cs-swap-options">${buttonsHtml}</div>
              </div>
            `;
          })()
        : "";

    const cardsHtml = GADGET_IDS.map((gid) => {
      const def = GADGET_CATALOG[gid];
      const owned = localCritter.loadout.includes(gid);
      const curCharges = localCritter.gadgetCharges[gid];
      const chargeMeta =
        def.startingCharges === null
          ? "Unlimited · ∞"
          : `×${def.startingCharges} charges / rd`;

      let footerHtml = "";
      if (owned) {
        if (def.startingCharges === null || def.refillCost <= 0) {
          footerHtml = `<span class="cs-armory-badge">EQUIPPED · ∞</span>`;
        } else {
          const canRefill = !purchasingDisabled && coins >= def.refillCost;
          footerHtml = `
            <span class="cs-armory-badge">Owned (${curCharges ?? 0} left)</span>
            <button
              type="button"
              class="cs-armory-action"
              data-armory-buy="${gid}"
              ${canRefill ? "" : "disabled"}
            >
              Refill +${def.startingCharges} (${def.refillCost} 🪙)
            </button>
          `;
        }
      } else if (ownedCount < MAX_LOADOUT_SLOTS) {
        const canBuy = !purchasingDisabled && coins >= def.shopCost;
        footerHtml = `
          <button
            type="button"
            class="cs-armory-action"
            data-armory-buy="${gid}"
            ${canBuy ? "" : "disabled"}
          >
            Buy (${def.shopCost} 🪙)
          </button>
        `;
      } else {
        footerHtml = `
          <button
            type="button"
            class="cs-armory-action"
            data-armory-swap="${gid}"
            ${purchasingDisabled ? "disabled" : ""}
          >
            Swap In (${def.shopCost} 🪙)
          </button>
        `;
      }

      return `
        <div class="cs-armory-card ${owned ? "cs-owned" : ""}">
          <div class="cs-armory-card-head">
            <span class="cs-armory-card-icon">${getGadgetSvgIcon(gid)}</span>
            <div class="cs-armory-card-titles">
              <strong>${escapeHtml(def.name)}</strong>
              <span>${chargeMeta}</span>
            </div>
          </div>
          <div class="cs-armory-card-desc">${escapeHtml(def.description)}</div>
          <div class="cs-armory-card-foot">${footerHtml}</div>
        </div>
      `;
    }).join("");

    this.armoryModal.innerHTML = `
      <div class="cs-modal-card cs-glass cs-armory-modal">
        <div class="cs-armory-head">
          <div class="cs-armory-head-left">
            <div class="cs-kicker">ARMORY · SIEGE COINS</div>
            <h2>Tactical Arsenal</h2>
          </div>
          <div class="cs-armory-meta">
            <span class="cs-coin-badge">🪙 ${coins}</span>
            <span class="cs-armory-slots">${ownedCount}/${MAX_LOADOUT_SLOTS} Slots</span>
            <span class="cs-armory-hint">Press <kbd>B</kbd> or <kbd>ESC</kbd> to close</span>
            <button type="button" class="cs-close-btn" data-action="close-armory" aria-label="Close Armory">×</button>
          </div>
        </div>
        ${swapBarHtml}
        <div class="cs-armory-grid">${cardsHtml}</div>
      </div>
    `;

    this.armoryModal
      .querySelector('[data-action="close-armory"]')
      ?.addEventListener("click", () => this.setArmoryOpen(false));

    this.armoryModal
      .querySelector('[data-action="cancel-swap"]')
      ?.addEventListener("click", () => {
        this.pendingSwapTarget = null;
        this.lastArmorySig = "";
        this.syncArmoryModal(state, localCritter);
      });

    this.armoryModal
      .querySelectorAll<HTMLButtonElement>("[data-armory-buy]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const gid = btn.dataset.armoryBuy as GadgetId | undefined;
          if (gid) {
            this.callbacks.onBuyAbility?.(gid);
          }
        });
      });

    this.armoryModal
      .querySelectorAll<HTMLButtonElement>("[data-armory-swap]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const gid = btn.dataset.armorySwap as GadgetId | undefined;
          if (gid) {
            this.pendingSwapTarget = gid;
            this.lastArmorySig = "";
            this.syncArmoryModal(state, localCritter);
          }
        });
      });

    this.armoryModal
      .querySelectorAll<HTMLButtonElement>("[data-confirm-swap]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const oldId = btn.dataset.confirmSwap as GadgetId | undefined;
          const target = this.pendingSwapTarget;
          if (oldId && target) {
            this.pendingSwapTarget = null;
            this.callbacks.onBuyAbility?.(target, oldId);
          }
        });
      });
  }

  private syncDraftModal(
    state: MatchState,
    localPlayerId: string | null,
  ): void {
    const inDraftPhase =
      state.phase === "ROUND_DRAFT" || state.phase === "DRAFT_IF_READY";
    if (!inDraftPhase || !localPlayerId) {
      this.draftModal.classList.add("cs-hidden");
      this.lastDraftSig = "";
      return;
    }

    const localCritter = state.critters.find((c) => c.id === localPlayerId);
    const localCoins = localCritter ? Math.floor(localCritter.coins) : 0;

    const myDraft: PendingDraftState | undefined = state.pendingDrafts.find(
      (d) => d.playerId === localPlayerId,
    );

    if (!myDraft) {
      const waitSig = `WAIT:${state.phase}:${state.pendingDrafts.length}:${localCoins}`;
      if (waitSig !== this.lastDraftSig) {
        this.lastDraftSig = waitSig;
        this.draftModal.classList.remove("cs-hidden");
        this.draftModal.innerHTML = `
          <div class="cs-modal-card cs-glass cs-modal-sm">
            <div class="cs-kicker">EVOLUTION</div>
            <h2>Waiting for rivals...</h2>
            ${
              state.phase === "ROUND_DRAFT"
                ? `<div class="cs-draft-footer"><button type="button" class="cs-btn cs-btn-secondary cs-draft-armory-btn" data-action="open-draft-armory">🪙 Spend Siege Coins in Armory (${localCoins})</button></div>`
                : ""
            }
          </div>
        `;
        this.draftModal
          .querySelector('[data-action="open-draft-armory"]')
          ?.addEventListener("click", () => this.setArmoryOpen(true));
      }
      return;
    }

    let sig = `${state.phase}|${localCoins}|${myDraft.playerId}|${myDraft.rerollsRemaining}|${myDraft.requiresSlotSwap ? 1 : 0}`;
    for (let i = 0; i < myDraft.cards.length; i++) {
      const card = myDraft.cards[i];
      if (!card) continue;
      sig += `|${card.mutationId}:${card.slot}:${card.replacesMutationId ?? ""}`;
    }
    if (sig === this.lastDraftSig) {
      return;
    }
    this.lastDraftSig = sig;
    this.draftModal.classList.remove("cs-hidden");

    const cardsHtml = myDraft.cards
      .map((card) => {
        const def = MUTATION_CATALOG[card.mutationId];
        const chips = MUTATION_STAT_CHIPS[card.mutationId];
        const replacesDef = card.replacesMutationId
          ? MUTATION_CATALOG[card.replacesMutationId]
          : null;
        return `
          <button type="button" class="cs-draft-card" data-pick-mut="${card.mutationId}" data-pick-slot="${card.slot}">
            <div class="cs-draft-top">
              <span class="cs-draft-icon">${getMutationSvgIcon(card.mutationId)}</span>
              <span class="cs-draft-slot">${SLOT_LABELS[card.slot]}</span>
            </div>
            <h3>${escapeHtml(def.name)}</h3>
            <div class="cs-stat-chips">
              <span class="cs-stat-chip">${escapeHtml(chips[0])}</span>
              <span class="cs-stat-chip cs-stat-chip-alt">${escapeHtml(chips[1])}</span>
            </div>
            ${
              replacesDef
                ? `<div class="cs-swap-warning">⇄ Replaces ${escapeHtml(replacesDef.name)}</div>`
                : `<div class="cs-new-slot">+ Equip to ${SLOT_LABELS[card.slot]}</div>`
            }
          </button>
        `;
      })
      .join("");

    const showArmoryBtn = state.phase === "ROUND_DRAFT";
    const footerParts: string[] = [];
    if (myDraft.rerollsRemaining > 0) {
      footerParts.push(
        `<button type="button" class="cs-btn cs-btn-secondary" data-action="reroll-draft">↻ Reroll (${myDraft.rerollsRemaining})</button>`,
      );
    }
    if (showArmoryBtn) {
      footerParts.push(
        `<button type="button" class="cs-btn cs-btn-secondary cs-draft-armory-btn" data-action="open-draft-armory">🪙 Spend Siege Coins in Armory (${localCoins})</button>`,
      );
    }

    this.draftModal.innerHTML = `
      <div class="cs-modal-card cs-glass">
        <div class="cs-kicker">${state.phase === "ROUND_DRAFT" ? "ROUND INTERMISSION · EVOLUTION & ARMORY" : "EVO POD"}</div>
        <h2>Pick 1 Mutation</h2>
        <div class="cs-draft-grid">${cardsHtml}</div>
        ${
          footerParts.length > 0
            ? `<div class="cs-draft-footer">${footerParts.join("")}</div>`
            : ""
        }
      </div>
    `;

    this.draftModal
      .querySelectorAll<HTMLButtonElement>("[data-pick-mut]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const mutId = btn.dataset.pickMut as MutationId | undefined;
          const slot = btn.dataset.pickSlot as HardpointSlot | undefined;
          if (mutId) {
            this.callbacks.onPickMutation(
              mutId,
              myDraft.requiresSlotSwap ? slot : undefined,
            );
          }
        });
      });

    const rerollBtn = this.draftModal.querySelector('[data-action="reroll-draft"]');
    rerollBtn?.addEventListener("click", () => this.callbacks.onRerollDraft());

    const armoryBtn = this.draftModal.querySelector(
      '[data-action="open-draft-armory"]',
    );
    armoryBtn?.addEventListener("click", () => this.setArmoryOpen(true));
  }

  private syncMatchOverModal(
    state: MatchState,
    localPlayerId: string | null,
    breakdown: MatchEssenceBreakdown | null,
  ): void {
    if (state.phase !== "MATCH_OVER") {
      this.matchOverModal.classList.add("cs-hidden");
      this.lastMatchOverSig = "";
      return;
    }

    let sig = `${state.winnerId ?? ""}|${state.winnerTeam ?? ""}|${state.matchEndReason ?? ""}|${breakdown ? `${breakdown.totalEarned}:${breakdown.newBalance}` : ""}`;
    for (let i = 0; i < state.critters.length; i++) {
      const c = state.critters[i];
      if (!c) continue;
      sig += `|${c.id}:${c.score}:${c.kills}:${Math.round(c.damageDealt)}:${c.podsCollected}`;
    }
    if (sig === this.lastMatchOverSig) {
      return;
    }
    this.lastMatchOverSig = sig;
    this.matchOverModal.classList.remove("cs-hidden");

    const isFloodDraw = state.matchEndReason === "flood_draw";
    const localCritter = state.critters.find((c) => c.id === localPlayerId);
    const localWon =
      !isFloodDraw &&
      localCritter !== undefined &&
      ((state.mode === "2v2" &&
        state.winnerTeam !== null &&
        localCritter.team === state.winnerTeam) ||
        (state.mode === "ffa" && state.winnerId === localCritter.id));

    const winnerCritter = state.critters.find((c) => c.id === state.winnerId);
    const kicker = isFloodDraw ? "ROUND 5 CATACLYSM" : "SIEGE COMPLETE";
    const headline = isFloodDraw
      ? "ISLAND ENGULFED — NO WINNER!"
      : localWon
        ? "VICTORY!"
        : state.mode === "2v2" && state.winnerTeam
          ? `TEAM ${state.winnerTeam} WINS!`
          : winnerCritter
            ? `${winnerCritter.name} WINS!`
            : "MATCH COMPLETE";

    const sorted = [...state.critters].sort(
      (a, b) =>
        b.score - a.score ||
        b.kills - a.kills ||
        b.damageDealt - a.damageDealt,
    );
    const rowsHtml = sorted
      .map(
        (c) => `
        <tr class="${c.id === localPlayerId ? "cs-row-local" : ""}">
          <td>
            <div class="cs-score-player">
              <img class="cs-score-avatar" src="${getSpeciesPortraitUrl(c.species)}" alt="${escapeHtml(SPECIES_CATALOG[c.species].name)}" style="border-color:${escapeHtml(c.color)}" />
              <span>${escapeHtml(c.name)}</span>
            </div>
          </td>
          <td>${escapeHtml(SPECIES_BADGE_META[c.species].shortName)}</td>
          <td>${c.kills}</td>
          <td>${c.podsCollected}</td>
          <td>${Math.round(c.damageDealt)}</td>
          <td><strong>${c.score}</strong></td>
        </tr>
      `,
      )
      .join("");

    const essenceHtml = breakdown
      ? `
        <div class="cs-essence-summary">
          <div class="cs-essence-total">
            <span>✦ Earned <strong>+${breakdown.totalEarned}</strong></span>
            <span>Balance <strong>${breakdown.newBalance} ✦</strong></span>
          </div>
        </div>
      `
      : "";

    this.matchOverModal.innerHTML = `
      <div class="cs-modal-card cs-glass">
        <div class="cs-kicker">${escapeHtml(kicker)}</div>
        <h2 class="cs-winner-title">${escapeHtml(headline)}</h2>
        <table class="cs-scoreboard">
          <thead>
            <tr>
              <th>Critter</th>
              <th>Species</th>
              <th>KOs</th>
              <th>Pods</th>
              <th>Dmg</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${essenceHtml}
        <div class="cs-modal-actions">
          <button type="button" class="cs-btn cs-btn-primary" data-action="play-again">Play Again</button>
          <button type="button" class="cs-btn cs-btn-secondary" data-action="back-lobby">Lobby</button>
        </div>
      </div>
    `;

    this.matchOverModal
      .querySelector('[data-action="play-again"]')
      ?.addEventListener("click", () => this.callbacks.onPlayAgain());
    this.matchOverModal
      .querySelector('[data-action="back-lobby"]')
      ?.addEventListener("click", () => this.callbacks.onBackToLobby());
  }
}
