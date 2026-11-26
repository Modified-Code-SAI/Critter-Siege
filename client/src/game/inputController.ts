import * as THREE from "three";
import type { GadgetId, Vec3 } from "@critter/shared";

/** Callbacks invoked by InputController for discrete gameplay actions. */
export interface InputCallbacks {
  onFire: (power: number) => void;
  onUtility: () => void;
  onRetreatBurrow: () => void;
  onDroneNudge: (dir: Vec3) => void;
  onDronePing: (point: Vec3) => void;
  onSelectGadgetIndex: (index: number) => void;
  onToggleDrone: () => void;
  onFirstPersonChange: (active: boolean) => void;
}

/** Per-frame polled movement, aim, backflip, and power-charge snapshot. */
export interface MovementInput {
  forward: number;
  right: number;
  jumpPressed: boolean;
  backflipPressed: boolean;
  glideHeld: boolean;
  yaw: number;
  pitch: number;
  charging: boolean;
  chargePower: number;
}

/** Structural subset of HTMLElement required by InputController for canvas events. */
export interface InputCanvasTarget {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  requestPointerLock?: () => void | Promise<void>;
}

/** Structural subset of Window required by InputController for global key/mouse events. */
export interface InputGlobalTarget {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

/** Structural subset of Document required by InputController for Pointer Lock events. */
export interface InputDocumentTarget {
  readonly pointerLockElement: unknown;
  exitPointerLock?: () => void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

/** Optional callback for orbiting/zooming the drone camera during drone mode. */
export type DroneOrbitHandler = (
  deltaYaw: number,
  deltaPitch: number,
  deltaZoom: number,
) => void;

const MIN_PITCH = -0.85;
const MAX_PITCH = 1.15;
const MIN_CHARGE_POWER = 0.15;
const MAX_CHARGE_POWER = 1.0;
const CHARGE_RAMP_SEC = 1.4;
const CHARGE_RATE = (MAX_CHARGE_POWER - MIN_CHARGE_POWER) / CHARGE_RAMP_SEC;

const AIM_SENSITIVITY = 0.0044;
const KEY_TURN_SPEED_RAD = 2.15;
const DRONE_ORBIT_SENSITIVITY = 0.0065;
const DRAG_THRESHOLD_PX = 6;
const DOUBLE_TAP_SPACE_WINDOW_SEC = 0.28;
const MAX_LOCKED_DELTA_PX = 220;

const DIGIT_TO_INDEX: Readonly<Record<string, number>> = {
  Digit1: 0,
  Digit2: 1,
  Digit3: 2,
  Digit4: 3,
  Digit5: 4,
  Digit6: 5,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") {
    return false;
  }
  const tagName =
    "tagName" in target && typeof target.tagName === "string"
      ? target.tagName.toUpperCase()
      : "";
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  if (
    "isContentEditable" in target &&
    typeof target.isContentEditable === "boolean"
  ) {
    return target.isContentEditable;
  }
  return false;
}

function isUtilityGadget(gadgetId: GadgetId): boolean {
  return gadgetId === "vine_grapple" || gadgetId === "prism_wall";
}

/**
 * Grandma-friendly classic 3D artillery keyboard + mouse controller for Critter Siege.
 * Supports Pointer Lock free mouse-look with zero-misfire unlocked click/drag fallback,
 * smooth Q/E keyboard turning, double-tap Space backflip detection, accessible UI fire
 * charge methods, and strict listener cleanup in dispose().
 */
export class InputController {
  private readonly canvas: InputCanvasTarget;
  private readonly globalTarget: InputGlobalTarget | null;
  private readonly docTarget: InputDocumentTarget | null;
  private readonly camera: THREE.Camera;
  private readonly callbacks: InputCallbacks;
  private droneOrbitHandler: DroneOrbitHandler | null;

  private readonly keysHeld = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private raycastTargets: readonly THREE.Object3D[] = [];

  private canMove = false;
  private canFire = false;
  private isDroneMode = false;
  private selectedGadget: GadgetId = "gale_mortar";

  private yaw = 0;
  private pitch = 0.18;
  private jumpQueued = false;
  private backflipQueued = false;
  private spaceTapCooldownSec = 0;

  private charging = false;
  private chargePower = 0;
  private chargeSource: "mouse" | "key" | "ui" | null = null;

  private firstPersonToggled = false;
  private rmbEnteredFirstPerson = false;
  private rmbHeld = false;
  private lmbHeld = false;
  private mmbHeld = false;
  private unlockedOrbitActive = false;
  private pointerLastX = 0;
  private pointerLastY = 0;
  private pointerDownX = 0;
  private pointerDownY = 0;
  private pointerDragDist = 0;

  private disposed = false;

  private readonly onCanvasMouseDownBound: EventListener;
  private readonly onCanvasWheelBound: EventListener;
  private readonly onCanvasContextMenuBound: EventListener;
  private readonly onWindowKeyDownBound: EventListener;
  private readonly onWindowKeyUpBound: EventListener;
  private readonly onPointerMoveBound: EventListener;
  private readonly onWindowMouseUpBound: EventListener;
  private readonly onWindowBlurBound: EventListener;
  private readonly onPointerLockChangeBound: EventListener;

  public constructor(
    canvas: InputCanvasTarget,
    camera: THREE.Camera,
    callbacks: InputCallbacks,
    droneOrbitHandler?: DroneOrbitHandler,
    globalTarget?: InputGlobalTarget | null,
    docTarget?: InputDocumentTarget | null,
  ) {
    this.canvas = canvas;
    this.camera = camera;
    this.callbacks = callbacks;
    this.droneOrbitHandler = droneOrbitHandler ?? null;
    this.globalTarget =
      globalTarget !== undefined
        ? globalTarget
        : typeof window !== "undefined"
          ? window
          : null;
    this.docTarget =
      docTarget !== undefined
        ? docTarget
        : typeof document !== "undefined"
          ? document
          : null;

    this.onCanvasMouseDownBound = (event) => this.handleCanvasMouseDown(event);
    this.onCanvasWheelBound = (event) => this.handleCanvasWheel(event);
    this.onCanvasContextMenuBound = (event) => this.handleContextMenu(event);
    this.onWindowKeyDownBound = (event) => this.handleKeyDown(event);
    this.onWindowKeyUpBound = (event) => this.handleKeyUp(event);
    this.onPointerMoveBound = (event) => this.handlePointerMove(event);
    this.onWindowMouseUpBound = (event) => this.handleWindowMouseUp(event);
    this.onWindowBlurBound = () => this.handleWindowBlur();
    this.onPointerLockChangeBound = () => this.handlePointerLockChange();

    this.canvas.addEventListener("mousedown", this.onCanvasMouseDownBound);
    this.canvas.addEventListener("wheel", this.onCanvasWheelBound, {
      passive: false,
    });
    this.canvas.addEventListener("contextmenu", this.onCanvasContextMenuBound);

    if (this.globalTarget) {
      this.globalTarget.addEventListener("keydown", this.onWindowKeyDownBound);
      this.globalTarget.addEventListener("keyup", this.onWindowKeyUpBound);
      this.globalTarget.addEventListener("mousemove", this.onPointerMoveBound);
      this.globalTarget.addEventListener("mouseup", this.onWindowMouseUpBound);
      this.globalTarget.addEventListener("blur", this.onWindowBlurBound);
    } else {
      this.canvas.addEventListener("mousemove", this.onPointerMoveBound);
    }

    if (this.docTarget) {
      this.docTarget.addEventListener(
        "pointerlockchange",
        this.onPointerLockChangeBound,
      );
    }
  }

  /** Return true when Pointer Lock free mouse-look is currently active on the playfield canvas. */
  public isPointerLocked(): boolean {
    return (
      this.docTarget !== null &&
      this.docTarget.pointerLockElement === (this.canvas as unknown)
    );
  }

  /** Cleanly release Pointer Lock so the player immediately regains a visible cursor for UI/Drone clicks. */
  public exitPointerLock(): void {
    if (
      this.isPointerLocked() &&
      this.docTarget &&
      typeof this.docTarget.exitPointerLock === "function"
    ) {
      try {
        this.docTarget.exitPointerLock();
      } catch {
        // Safe cleanup if browser already released lock
      }
    }
  }

  /** Begin charging a shot from an accessible on-screen HOLD TO FIRE button. */
  public startUiFireCharge(): void {
    if (this.disposed || !this.canFire || this.isDroneMode) {
      return;
    }
    if (isUtilityGadget(this.selectedGadget)) {
      this.callbacks.onUtility();
      return;
    }
    this.charging = true;
    this.chargePower = MIN_CHARGE_POWER;
    this.chargeSource = "ui";
  }

  /** Release an on-screen HOLD TO FIRE charge and launch the shot at current power. */
  public releaseUiFireCharge(): void {
    if (this.disposed || !this.charging || this.chargeSource !== "ui") {
      return;
    }
    const power = clamp(this.chargePower, MIN_CHARGE_POWER, MAX_CHARGE_POWER);
    this.cancelCharge();
    if (this.canFire && !this.isDroneMode) {
      this.callbacks.onFire(power);
    }
  }

  /** Cancel any active shot charge cleanly with zero misfire. */
  public cancelCharge(): void {
    this.charging = false;
    this.chargePower = 0;
    this.chargeSource = null;
  }

  /** Sync external HUD camera-mode changes so pressing V always toggles cleanly in 1 keypress. */
  public syncFirstPerson(active: boolean): void {
    this.firstPersonToggled = active;
    if (!active) {
      this.rmbEnteredFirstPerson = false;
    }
  }

  /** Configure whether the local player can move, fire, or is in drone/spectator mode. */
  public setCanAct(
    canMove: boolean,
    canFire: boolean,
    isDroneMode: boolean,
  ): void {
    const enteringDrone = isDroneMode && !this.isDroneMode;
    this.canMove = canMove;
    this.canFire = canFire;
    this.isDroneMode = isDroneMode;

    if (enteringDrone) {
      this.exitPointerLock();
    }
    if (!this.canFire || this.isDroneMode) {
      this.cancelCharge();
    }
    if (!this.canMove || this.isDroneMode) {
      this.jumpQueued = false;
      this.backflipQueued = false;
      this.spaceTapCooldownSec = 0;
    }
  }

  /** Provide terrain meshes used for Drone Recon click-to-ping raycasting. */
  public setRaycastTargets(meshes: readonly THREE.Object3D[]): void {
    this.raycastTargets = meshes;
  }

  /** Sync currently selected gadget so utility gadgets fire directly on click. */
  public setSelectedGadget(gadgetId: GadgetId): void {
    this.selectedGadget = gadgetId;
  }

  /** Sync current aim yaw/pitch (e.g., when starting a new turn). */
  public setAim(yaw: number, pitch: number): void {
    if (Number.isFinite(yaw)) {
      this.yaw = yaw;
    }
    if (Number.isFinite(pitch)) {
      this.pitch = clamp(pitch, MIN_PITCH, MAX_PITCH);
    }
  }

  /** Attach or replace the drone camera orbit handler. */
  public setDroneOrbitHandler(handler: DroneOrbitHandler | null): void {
    this.droneOrbitHandler = handler;
  }

  /** Advance power charge ramping, Q/E turning, double-tap Space timer, and return movement/aim snapshot. */
  public update(dtSec: number): MovementInput {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.25)) : 0;

    if (this.spaceTapCooldownSec > 0) {
      this.spaceTapCooldownSec = Math.max(0, this.spaceTapCooldownSec - safeDt);
    }

    // Smooth Q (left) / E (right) keyboard camera turning for accessible keyboard-only play
    const turnDir =
      (this.keysHeld.has("KeyQ") ? 1 : 0) - (this.keysHeld.has("KeyE") ? 1 : 0);
    if (turnDir !== 0 && safeDt > 0) {
      if (this.isDroneMode) {
        this.droneOrbitHandler?.(turnDir * KEY_TURN_SPEED_RAD * safeDt, 0, 0);
      } else {
        this.yaw += turnDir * KEY_TURN_SPEED_RAD * safeDt;
      }
    }

    if (this.charging && this.canFire && !this.isDroneMode) {
      this.chargePower = Math.min(
        MAX_CHARGE_POWER,
        this.chargePower + CHARGE_RATE * safeDt,
      );
    } else if (this.charging) {
      this.cancelCharge();
    }

    let forward = 0;
    let right = 0;
    let jumpPressed = false;
    let backflipPressed = false;
    let glideHeld = false;

    if (this.canMove && !this.isDroneMode) {
      if (this.keysHeld.has("KeyW") || this.keysHeld.has("ArrowUp")) {
        forward += 1;
      }
      if (this.keysHeld.has("KeyS") || this.keysHeld.has("ArrowDown")) {
        forward -= 1;
      }
      if (this.keysHeld.has("KeyD") || this.keysHeld.has("ArrowRight")) {
        right += 1;
      }
      if (this.keysHeld.has("KeyA") || this.keysHeld.has("ArrowLeft")) {
        right -= 1;
      }
      jumpPressed = this.jumpQueued;
      backflipPressed = this.backflipQueued;
      this.jumpQueued = false;
      this.backflipQueued = false;
      glideHeld = this.keysHeld.has("Space");
    } else {
      this.jumpQueued = false;
      this.backflipQueued = false;
    }

    return {
      forward,
      right,
      jumpPressed,
      backflipPressed,
      glideHeld,
      yaw: this.yaw,
      pitch: this.pitch,
      charging: this.charging,
      chargePower: this.chargePower,
    };
  }

  /** Detach all canvas, window, and document event listeners cleanly. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    this.exitPointerLock();

    this.canvas.removeEventListener("mousedown", this.onCanvasMouseDownBound);
    this.canvas.removeEventListener("wheel", this.onCanvasWheelBound);
    this.canvas.removeEventListener(
      "contextmenu",
      this.onCanvasContextMenuBound,
    );

    if (this.globalTarget) {
      this.globalTarget.removeEventListener(
        "keydown",
        this.onWindowKeyDownBound,
      );
      this.globalTarget.removeEventListener("keyup", this.onWindowKeyUpBound);
      this.globalTarget.removeEventListener(
        "mousemove",
        this.onPointerMoveBound,
      );
      this.globalTarget.removeEventListener(
        "mouseup",
        this.onWindowMouseUpBound,
      );
      this.globalTarget.removeEventListener("blur", this.onWindowBlurBound);
    } else {
      this.canvas.removeEventListener("mousemove", this.onPointerMoveBound);
    }

    if (this.docTarget) {
      this.docTarget.removeEventListener(
        "pointerlockchange",
        this.onPointerLockChangeBound,
      );
    }

    this.keysHeld.clear();
    this.raycastTargets = [];
    this.cancelCharge();
    this.lmbHeld = false;
    this.rmbHeld = false;
    this.mmbHeld = false;
    this.rmbEnteredFirstPerson = false;
    this.unlockedOrbitActive = false;
    this.jumpQueued = false;
    this.backflipQueued = false;
    this.spaceTapCooldownSec = 0;
  }

  private isFirstPersonActive(): boolean {
    return this.firstPersonToggled || this.rmbEnteredFirstPerson;
  }

  private hasDirectionalMoveHeld(): boolean {
    return (
      this.keysHeld.has("KeyW") ||
      this.keysHeld.has("KeyS") ||
      this.keysHeld.has("KeyA") ||
      this.keysHeld.has("KeyD") ||
      this.keysHeld.has("ArrowUp") ||
      this.keysHeld.has("ArrowDown") ||
      this.keysHeld.has("ArrowLeft") ||
      this.keysHeld.has("ArrowRight")
    );
  }

  private requestPointerLockSafe(): void {
    if (typeof this.canvas.requestPointerLock !== "function") {
      return;
    }
    try {
      const maybePromise = this.canvas.requestPointerLock();
      if (
        maybePromise &&
        typeof (maybePromise as Promise<void>).catch === "function"
      ) {
        void (maybePromise as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Ignore pointer lock rejection in restricted/headless contexts
    }
  }

  private handlePointerLockChange(): void {
    if (this.disposed) {
      return;
    }
    if (!this.isPointerLocked()) {
      if (this.charging && this.chargeSource === "mouse") {
        this.cancelCharge();
      }
      if (this.rmbEnteredFirstPerson) {
        this.rmbEnteredFirstPerson = false;
        this.rmbHeld = false;
        if (!this.isFirstPersonActive()) {
          this.callbacks.onFirstPersonChange(false);
        }
      }
    }
  }

  private handleContextMenu(event: Event): void {
    event.preventDefault();
  }

  private handleCanvasMouseDown(event: Event): void {
    if (this.disposed) {
      return;
    }
    const mouse = event as MouseEvent;
    const button = typeof mouse.button === "number" ? mouse.button : 0;
    const cx = typeof mouse.clientX === "number" ? mouse.clientX : 0;
    const cy = typeof mouse.clientY === "number" ? mouse.clientY : 0;

    this.pointerLastX = cx;
    this.pointerLastY = cy;

    if (button === 2) {
      if (this.charging) {
        this.cancelCharge();
      }
      this.rmbHeld = true;
      this.pointerDownX = cx;
      this.pointerDownY = cy;
      this.pointerDragDist = 0;
      this.unlockedOrbitActive = false;

      if (this.isPointerLocked() && !this.isDroneMode) {
        const wasActive = this.isFirstPersonActive();
        this.rmbEnteredFirstPerson = true;
        if (!wasActive) {
          this.callbacks.onFirstPersonChange(true);
        }
      }
      return;
    }

    if (button === 1) {
      this.mmbHeld = true;
      this.pointerDownX = cx;
      this.pointerDownY = cy;
      this.pointerDragDist = 0;
      this.unlockedOrbitActive = false;
      return;
    }

    if (button !== 0) {
      return;
    }

    this.lmbHeld = true;
    this.pointerDownX = cx;
    this.pointerDownY = cy;
    this.pointerDragDist = 0;
    this.unlockedOrbitActive = false;

    if (this.isDroneMode) {
      return;
    }

    // Zero-misfire rule: unlocked click enters Pointer Lock (or orbits on drag) WITHOUT firing!
    if (!this.isPointerLocked()) {
      if (this.canMove || this.canFire) {
        this.requestPointerLockSafe();
      }
      return;
    }

    if (this.canFire) {
      if (isUtilityGadget(this.selectedGadget)) {
        this.callbacks.onUtility();
        return;
      }
      this.charging = true;
      this.chargePower = MIN_CHARGE_POWER;
      this.chargeSource = "mouse";
    }
  }

  private handlePointerMove(event: Event): void {
    if (this.disposed) {
      return;
    }
    const mouse = event as MouseEvent;
    const locked = this.isPointerLocked();
    const dragging = this.lmbHeld || this.rmbHeld || this.mmbHeld;

    if (!locked && !dragging) {
      if (typeof mouse.clientX === "number" && typeof mouse.clientY === "number") {
        this.pointerLastX = mouse.clientX;
        this.pointerLastY = mouse.clientY;
      }
      return;
    }

    let dx = 0;
    let dy = 0;
    if (
      locked &&
      typeof mouse.movementX === "number" &&
      typeof mouse.movementY === "number"
    ) {
      dx = clamp(mouse.movementX, -MAX_LOCKED_DELTA_PX, MAX_LOCKED_DELTA_PX);
      dy = clamp(mouse.movementY, -MAX_LOCKED_DELTA_PX, MAX_LOCKED_DELTA_PX);
    } else if (
      typeof mouse.clientX === "number" &&
      typeof mouse.clientY === "number"
    ) {
      dx = mouse.clientX - this.pointerLastX;
      dy = mouse.clientY - this.pointerLastY;
      this.pointerLastX = mouse.clientX;
      this.pointerLastY = mouse.clientY;
    }

    if (dragging) {
      this.pointerDragDist += Math.hypot(dx, dy);
    }

    if (dx === 0 && dy === 0) {
      return;
    }

    if (this.isDroneMode) {
      this.droneOrbitHandler?.(
        -dx * DRONE_ORBIT_SENSITIVITY,
        dy * DRONE_ORBIT_SENSITIVITY,
        0,
      );
      return;
    }

    if (!locked) {
      const cx = typeof mouse.clientX === "number" ? mouse.clientX : this.pointerDownX;
      const cy = typeof mouse.clientY === "number" ? mouse.clientY : this.pointerDownY;
      const totalDrag = Math.max(
        this.pointerDragDist,
        Math.hypot(cx - this.pointerDownX, cy - this.pointerDownY),
      );
      if (!this.unlockedOrbitActive) {
        if (totalDrag <= DRAG_THRESHOLD_PX) {
          return;
        }
        this.unlockedOrbitActive = true;
      }
    }

    this.yaw -= dx * AIM_SENSITIVITY;
    this.pitch = clamp(this.pitch - dy * AIM_SENSITIVITY, MIN_PITCH, MAX_PITCH);
  }

  private handleWindowMouseUp(event: Event): void {
    if (this.disposed) {
      return;
    }
    const mouse = event as MouseEvent;
    const button = typeof mouse.button === "number" ? mouse.button : 0;

    if (button === 2 && this.rmbHeld) {
      this.rmbHeld = false;
      this.unlockedOrbitActive = false;
      if (this.rmbEnteredFirstPerson) {
        this.rmbEnteredFirstPerson = false;
        if (!this.isFirstPersonActive()) {
          this.callbacks.onFirstPersonChange(false);
        }
      }
      return;
    }

    if (button === 1) {
      this.mmbHeld = false;
      this.unlockedOrbitActive = false;
      return;
    }

    if (button !== 0 || !this.lmbHeld) {
      return;
    }

    this.lmbHeld = false;
    this.unlockedOrbitActive = false;

    if (this.isDroneMode) {
      const cx =
        typeof mouse.clientX === "number" ? mouse.clientX : this.pointerDownX;
      const cy =
        typeof mouse.clientY === "number" ? mouse.clientY : this.pointerDownY;
      const totalMove = Math.max(
        this.pointerDragDist,
        Math.hypot(cx - this.pointerDownX, cy - this.pointerDownY),
      );
      if (totalMove < DRAG_THRESHOLD_PX) {
        this.tryDronePingRaycast(cx, cy);
      }
      return;
    }

    if (this.charging && this.chargeSource === "mouse") {
      const power = clamp(this.chargePower, MIN_CHARGE_POWER, MAX_CHARGE_POWER);
      this.cancelCharge();
      if (this.canFire) {
        this.callbacks.onFire(power);
      }
    }
  }

  private handleCanvasWheel(event: Event): void {
    if (this.disposed || !this.isDroneMode) {
      return;
    }
    const wheel = event as WheelEvent;
    if (typeof wheel.preventDefault === "function") {
      wheel.preventDefault();
    }
    const deltaY = typeof wheel.deltaY === "number" ? wheel.deltaY : 0;
    if (deltaY !== 0) {
      this.droneOrbitHandler?.(0, 0, Math.sign(deltaY) * 1.8);
    }
  }

  private handleKeyDown(event: Event): void {
    if (this.disposed || isEditableTarget(event.target)) {
      return;
    }
    const key = event as KeyboardEvent;
    const code = typeof key.code === "string" ? key.code : "";
    if (!code) {
      return;
    }

    if (code === "Tab") {
      if (typeof key.preventDefault === "function") {
        key.preventDefault();
      }
      if (!key.repeat) {
        this.callbacks.onToggleDrone();
      }
      return;
    }

    if (
      (code === "Space" ||
        code === "ArrowUp" ||
        code === "ArrowDown" ||
        code === "ArrowLeft" ||
        code === "ArrowRight") &&
      (this.canMove || this.canFire) &&
      typeof key.preventDefault === "function"
    ) {
      key.preventDefault();
    }

    this.keysHeld.add(code);

    if (key.repeat) {
      return;
    }

    if (code === "Space") {
      if (this.canMove && !this.isDroneMode) {
        if (this.spaceTapCooldownSec > 0 && !this.hasDirectionalMoveHeld()) {
          this.backflipQueued = true;
          this.jumpQueued = false;
          this.spaceTapCooldownSec = 0;
        } else {
          this.jumpQueued = true;
          this.spaceTapCooldownSec = DOUBLE_TAP_SPACE_WINDOW_SEC;
        }
      }
      return;
    }

    if (code === "Enter") {
      if (this.canFire && !this.isDroneMode) {
        if (isUtilityGadget(this.selectedGadget)) {
          this.callbacks.onUtility();
        } else {
          this.charging = true;
          this.chargePower = MIN_CHARGE_POWER;
          this.chargeSource = "key";
        }
      }
      return;
    }

    if (code === "KeyV") {
      const wasActive = this.isFirstPersonActive();
      this.firstPersonToggled = !this.firstPersonToggled;
      const nowActive = this.isFirstPersonActive();
      if (wasActive !== nowActive) {
        this.callbacks.onFirstPersonChange(nowActive);
      }
      return;
    }

    const gadgetIdx = DIGIT_TO_INDEX[code];
    if (gadgetIdx !== undefined) {
      this.callbacks.onSelectGadgetIndex(gadgetIdx);
      return;
    }

    if (code === "KeyF") {
      this.callbacks.onRetreatBurrow();
      return;
    }

    if (code === "KeyX") {
      this.callbacks.onDroneNudge({
        x: Math.sin(this.yaw),
        y: 0,
        z: Math.cos(this.yaw),
      });
      return;
    }

    if (code === "KeyG") {
      this.callbacks.onUtility();
    }
  }

  private handleKeyUp(event: Event): void {
    if (this.disposed) {
      return;
    }
    const key = event as KeyboardEvent;
    const code = typeof key.code === "string" ? key.code : "";
    if (!code) {
      return;
    }

    this.keysHeld.delete(code);

    if (code === "Enter" && this.charging && this.chargeSource === "key") {
      const power = clamp(this.chargePower, MIN_CHARGE_POWER, MAX_CHARGE_POWER);
      this.cancelCharge();
      if (this.canFire && !this.isDroneMode) {
        this.callbacks.onFire(power);
      }
    }
  }

  private handleWindowBlur(): void {
    this.keysHeld.clear();
    this.lmbHeld = false;
    this.mmbHeld = false;
    this.unlockedOrbitActive = false;
    if (this.rmbHeld || this.rmbEnteredFirstPerson) {
      this.rmbHeld = false;
      this.rmbEnteredFirstPerson = false;
      if (!this.isFirstPersonActive()) {
        this.callbacks.onFirstPersonChange(false);
      }
    }
    this.cancelCharge();
    this.jumpQueued = false;
    this.backflipQueued = false;
    this.spaceTapCooldownSec = 0;
  }

  private tryDronePingRaycast(clientX: number, clientY: number): void {
    if (this.raycastTargets.length === 0) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.ndc.set(ndcX, ndcY);

    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.raycastTargets as THREE.Object3D[],
      true,
    );
    const firstHit = hits[0];
    if (firstHit) {
      this.callbacks.onDronePing({
        x: firstHit.point.x,
        y: firstHit.point.y,
        z: firstHit.point.z,
      });
    }
  }
}
