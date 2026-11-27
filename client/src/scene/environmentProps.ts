import * as THREE from "three";
import {
  createSeededRng,
  type HazardState,
  type SdfWorld,
  type Vec3,
} from "@critter/shared";
import { loadPropModel, type PropLandmarkKind } from "./modelLoader.js";

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

interface InstancedBinding {
  mesh: THREE.InstancedMesh;
  index: number;
}

interface TrackedPropAnchor {
  category: "tree" | "flora" | "boulder" | "landmark";
  pos: Vec3;
  visible: boolean;
  bindings: InstancedBinding[];
  landmarkGroup?: THREE.Group;
  glbKind?: PropLandmarkKind;
}

interface HazardVisual {
  type: HazardState["type"];
  group: THREE.Group;
  pulseMaterials: THREE.MeshStandardMaterial[];
  warningRing?: THREE.Mesh;
  steamPuffs?: THREE.Mesh[];
  glowHalo?: THREE.Sprite;
  glowBaseScale?: number;
  groundPool?: THREE.Mesh;
  groundPoolBaseOpacity?: number;
  phaseOffset: number;
}

interface WindSwayOptions {
  cacheKey: string;
  minY: number;
  heightSpan: number;
  amp: number;
  freq: number;
  baseSway: number;
}

/** Quantitative scenery & hazard counts for diagnostics and tests. */
export interface EnvironmentPropCounts {
  trees: number;
  flora: number;
  boulders: number;
  landmarks: number;
  activeHazards: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Bake a smooth vertical vertex-color AO gradient onto `geometry` using its Y bounds
 * so foliage crowns have cool shaded undersides & sunlit tips, and trunks/rocks feel grounded.
 */
function bakeVerticalVertexGradient(
  geometry: THREE.BufferGeometry,
  bottomRgb: readonly [number, number, number],
  topRgb: readonly [number, number, number],
): void {
  const pos = geometry.getAttribute("position");
  if (!(pos instanceof THREE.BufferAttribute) || pos.count === 0) {
    return;
  }

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const spanY = Math.max(1e-5, maxY - minY);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = clamp01((pos.getY(i) - minY) / spanY);
    const smoothT = t * t * (3.0 - 2.0 * t);
    colors[i * 3] = clamp01(
      bottomRgb[0] + (topRgb[0] - bottomRgb[0]) * smoothT,
    );
    colors[i * 3 + 1] = clamp01(
      bottomRgb[1] + (topRgb[1] - bottomRgb[1]) * smoothT,
    );
    colors[i * 3 + 2] = clamp01(
      bottomRgb[2] + (topRgb[2] - bottomRgb[2]) * smoothT,
    );
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/**
 * Deterministically displace boulder vertices along their normalized direction
 * so shared rocks read as weathered sculpted stone rather than uniform polyhedra.
 */
function perturbBoulderGeometry(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute("position");
  if (!(pos instanceof THREE.BufferAttribute) || pos.count === 0) {
    return;
  }

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const len = Math.hypot(vx, vy, vz);
    if (len < 1e-6) {
      continue;
    }
    const nx = vx / len;
    const ny = vy / len;
    const nz = vz / len;

    const waveA = Math.sin(nx * 3.7 + ny * 2.9 - nz * 4.1) * 0.12;
    const waveB = Math.cos(nz * 5.3 - nx * 4.4 + ny * 3.1) * 0.065;
    const ridge = Math.sin((nx - nz) * 6.1 + ny * 2.2) * 0.035;
    const flatBase = ny < -0.22 ? 1.0 + (ny + 0.22) * 0.18 : 1.0;
    const scale = Math.max(0.72, (1.0 + waveA + waveB + ridge) * flatBase);

    pos.setXYZ(i, vx * scale, vy * scale, vz * scale);
  }

  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

/**
 * Build a compact 3-blade splayed tapered grass cluster (BufferGeometry, zero BoxGeometry)
 * anchored at y = 0 with grounded dark-base-to-sunlit-tip vertex colors.
 */
function createSculptedGrassTuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const bladeSpecs: ReadonlyArray<{
    angle: number;
    height: number;
    lean: number;
    width: number;
    offset: number;
  }> = [
    { angle: 0.15, height: 0.48, lean: 0.17, width: 0.072, offset: 0.025 },
    { angle: 2.22, height: 0.43, lean: 0.19, width: 0.068, offset: 0.028 },
    { angle: 4.35, height: 0.39, lean: 0.16, width: 0.064, offset: 0.024 },
  ];

  const baseColor: readonly [number, number, number] = [0.46, 0.62, 0.42];
  const midColor: readonly [number, number, number] = [0.74, 0.88, 0.62];
  const tipColor: readonly [number, number, number] = [0.98, 1.0, 0.78];

  const pushVert = (
    x: number,
    y: number,
    z: number,
    rgb: readonly [number, number, number],
  ): number => {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    colors.push(rgb[0], rgb[1], rgb[2]);
    return idx;
  };

  for (const blade of bladeSpecs) {
    const dirX = Math.cos(blade.angle);
    const dirZ = Math.sin(blade.angle);
    const sideX = -dirZ;
    const sideZ = dirX;

    const bx = dirX * blade.offset;
    const bz = dirZ * blade.offset;
    const mx = bx + dirX * blade.lean * 0.42;
    const my = blade.height * 0.54;
    const mz = bz + dirZ * blade.lean * 0.42;
    const tx = bx + dirX * blade.lean;
    const ty = blade.height;
    const tz = bz + dirZ * blade.lean;

    const w0 = blade.width * 0.5;
    const w1 = blade.width * 0.32;
    const fold = blade.width * 0.22;

    // Slight V-fold along center spine gives natural 3D light catch from all camera angles
    const bL = pushVert(bx - sideX * w0, 0, bz - sideZ * w0, baseColor);
    const bC = pushVert(bx + dirX * fold, 0, bz + dirZ * fold, baseColor);
    const bR = pushVert(bx + sideX * w0, 0, bz + sideZ * w0, baseColor);

    const mL = pushVert(mx - sideX * w1, my, mz - sideZ * w1, midColor);
    const mC = pushVert(
      mx + dirX * (fold * 0.7),
      my,
      mz + dirZ * (fold * 0.7),
      midColor,
    );
    const mR = pushVert(mx + sideX * w1, my, mz + sideZ * w1, midColor);

    const tip = pushVert(tx, ty, tz, tipColor);

    // Lower left & right quads + upper left & right tapered tip triangles
    indices.push(
      bL,
      bC,
      mC,
      bL,
      mC,
      mL,
      bC,
      bR,
      mR,
      bC,
      mR,
      mC,
      mL,
      mC,
      tip,
      mC,
      mR,
      tip,
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Create ONE shared radial-gradient glow texture (CanvasTexture in browser, 16x16 DataTexture in Node). */
function createSharedGlowTexture(): THREE.Texture {
  if (typeof document !== "undefined") {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const half = size * 0.5;
      const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0.0, "rgba(255, 255, 255, 1.0)");
      grad.addColorStop(0.28, "rgba(255, 255, 255, 0.62)");
      grad.addColorStop(0.62, "rgba(255, 255, 255, 0.16)");
      grad.addColorStop(1.0, "rgba(255, 255, 255, 0.0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);

      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      return tex;
    }
  }

  const size = 16;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const dist = Math.hypot(dx, dy);
      const falloff = Math.pow(Math.max(0, 1.0 - dist), 2.2);
      const alpha = Math.round(clamp01(falloff) * 255);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = alpha;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Wrap-around 2D canvas drawing helper so 256x256 procedural prop paint tiles stay seamless. */
function drawTiledCanvas(
  size: number,
  x: number,
  y: number,
  margin: number,
  drawFn: (dx: number, dy: number) => void,
): void {
  const oxList: number[] = [0];
  if (x < margin) {
    oxList.push(size);
  } else if (x > size - margin) {
    oxList.push(-size);
  }
  const oyList: number[] = [0];
  if (y < margin) {
    oyList.push(size);
  } else if (y > size - margin) {
    oyList.push(-size);
  }
  for (const ox of oxList) {
    for (const oy of oyList) {
      drawFn(x + ox, y + oy);
    }
  }
}

/**
 * Create 3 shared hand-painted storybook 256x256 CanvasTextures (32x32 DataTexture headless fallback)
 * for foliage canopies, bark trunks, and chiseled boulders. Owned & disposed once by EnvironmentProps.
 */
function createHandPaintedPropTextures(): {
  foliagePaintTexture: THREE.Texture;
  barkPaintTexture: THREE.Texture;
  rockPaintTexture: THREE.Texture;
} {
  const configure = (tex: THREE.Texture): THREE.Texture => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  };

  if (typeof document !== "undefined") {
    const size = 256;
    const foliageCanvas = document.createElement("canvas");
    foliageCanvas.width = size;
    foliageCanvas.height = size;
    const barkCanvas = document.createElement("canvas");
    barkCanvas.width = size;
    barkCanvas.height = size;
    const rockCanvas = document.createElement("canvas");
    rockCanvas.width = size;
    rockCanvas.height = size;

    const fCtx = foliageCanvas.getContext("2d");
    const bCtx = barkCanvas.getContext("2d");
    const rCtx = rockCanvas.getContext("2d");

    if (fCtx && bCtx && rCtx) {
      // 1. Hand-painted gouache leafy dapple clusters (chartreuse-gold -> mid-green -> cool teal-emerald)
      const fRng = createSeededRng(0x5f31a7);
      fCtx.fillStyle = "#95c879";
      fCtx.fillRect(0, 0, size, size);

      const washPalette: readonly string[] = [
        "#48766a",
        "#5c9178",
        "#9fd080",
        "#b6dd8e",
        "#d8ef97",
      ];
      for (let i = 0; i < 42; i++) {
        const x = fRng() * size;
        const y = fRng() * size;
        const rx = 20 + fRng() * 34;
        const ry = 14 + fRng() * 24;
        const angle = fRng() * Math.PI;
        const color = washPalette[Math.floor(fRng() * washPalette.length)] ?? "#9fd080";
        const alpha = 0.28 + fRng() * 0.24;
        drawTiledCanvas(size, x, y, Math.max(rx, ry) + 4, (dx, dy) => {
          fCtx.save();
          fCtx.translate(dx, dy);
          fCtx.rotate(angle);
          fCtx.globalAlpha = alpha;
          fCtx.fillStyle = color;
          fCtx.beginPath();
          fCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
          fCtx.fill();
          fCtx.restore();
        });
      }

      const leafPalette: readonly string[] = [
        "#48766a",
        "#5d947b",
        "#86be78",
        "#9fd080",
        "#c5e68e",
        "#e8f5a2",
      ];
      for (let i = 0; i < 210; i++) {
        const x = fRng() * size;
        const y = fRng() * size;
        const len = 8 + fRng() * 16;
        const wid = 4 + fRng() * 8;
        const angle = fRng() * Math.PI * 2;
        const color = leafPalette[Math.floor(fRng() * leafPalette.length)] ?? "#9fd080";
        const alpha = 0.45 + fRng() * 0.42;
        drawTiledCanvas(size, x, y, len + 4, (dx, dy) => {
          fCtx.save();
          fCtx.translate(dx, dy);
          fCtx.rotate(angle);
          fCtx.globalAlpha = alpha;
          fCtx.fillStyle = color;
          fCtx.beginPath();
          fCtx.ellipse(0, 0, len * 0.5, wid * 0.5, 0, 0, Math.PI * 2);
          fCtx.fill();
          fCtx.restore();
        });
      }
      fCtx.globalAlpha = 1.0;

      // 2. Warm hand-painted vertical bark grain ridges, burnt-sienna strokes & dark wood crevices
      const bRng = createSeededRng(0x8c24d1);
      bCtx.fillStyle = "#9b6440";
      bCtx.fillRect(0, 0, size, size);

      const barkStripes: readonly string[] = [
        "#7d482a",
        "#9f6540",
        "#b87c4f",
        "#c98e5e",
        "#8a5030",
      ];
      const ridgeCount = 16;
      for (let r = 0; r < ridgeCount; r++) {
        const baseX = (r / ridgeCount) * size;
        const col = barkStripes[r % barkStripes.length] ?? "#9f6540";
        const ridgeW = size / ridgeCount + 4;
        bCtx.fillStyle = col;
        bCtx.globalAlpha = 0.68;
        bCtx.beginPath();
        for (let step = 0; step <= 32; step++) {
          const v = step / 32;
          const y = v * size;
          const wobble =
            Math.sin(v * Math.PI * 2 * 2 + r * 1.4) * 4.5 +
            Math.cos(v * Math.PI * 2 * 4 - r * 2.1) * 2.0;
          const x = baseX + wobble;
          if (step === 0) {
            bCtx.moveTo(x, y);
          } else {
            bCtx.lineTo(x, y);
          }
        }
        for (let step = 32; step >= 0; step--) {
          const v = step / 32;
          const y = v * size;
          const wobble =
            Math.sin(v * Math.PI * 2 * 2 + r * 1.4) * 4.5 +
            Math.cos(v * Math.PI * 2 * 4 - r * 2.1) * 2.0;
          bCtx.lineTo(baseX + wobble + ridgeW, y);
        }
        bCtx.closePath();
        bCtx.fill();
      }

      // Vertical sunlit grain highlights & deep painted bark crevices
      for (let r = 0; r < ridgeCount; r++) {
        const baseX = (r / ridgeCount) * size;
        for (const ox of [-size, 0, size]) {
          // Sunlit warm ridge edge
          bCtx.save();
          bCtx.strokeStyle = "#deb181";
          bCtx.lineWidth = 2.4;
          bCtx.globalAlpha = 0.56;
          bCtx.beginPath();
          for (let step = 0; step <= 32; step++) {
            const v = step / 32;
            const y = v * size;
            const x =
              baseX +
              ox +
              3.2 +
              Math.sin(v * Math.PI * 2 * 2 + r * 1.4) * 4.5 +
              Math.cos(v * Math.PI * 2 * 4 - r * 2.1) * 2.0;
            if (step === 0) bCtx.moveTo(x, y);
            else bCtx.lineTo(x, y);
          }
          bCtx.stroke();

          // Dark recessed wood crevice
          bCtx.strokeStyle = "#3f2113";
          bCtx.lineWidth = r % 3 === 0 ? 3.2 : 2.1;
          bCtx.globalAlpha = 0.85;
          bCtx.beginPath();
          for (let step = 0; step <= 32; step++) {
            const v = step / 32;
            const y = v * size;
            const x =
              baseX +
              ox +
              Math.sin(v * Math.PI * 2 * 2 + r * 1.4) * 4.5 +
              Math.cos(v * Math.PI * 2 * 4 - r * 2.1) * 2.0;
            if (step === 0) bCtx.moveTo(x, y);
            else bCtx.lineTo(x, y);
          }
          bCtx.stroke();
          bCtx.restore();
        }
      }

      // Subtle painted bark chips & wood knot accents
      for (let i = 0; i < 45; i++) {
        const x = bRng() * size;
        const y = bRng() * size;
        const rx = 2.5 + bRng() * 4.5;
        const ry = 10 + bRng() * 20;
        const tone = i % 3 === 0 ? "#d9a976" : i % 2 === 0 ? "#69381f" : "#ae6f44";
        drawTiledCanvas(size, x, y, ry + 4, (dx, dy) => {
          bCtx.save();
          bCtx.globalAlpha = 0.34;
          bCtx.fillStyle = tone;
          bCtx.beginPath();
          bCtx.ellipse(dx, dy, rx, ry, 0, 0, Math.PI * 2);
          bCtx.fill();
          bCtx.restore();
        });
      }
      bCtx.globalAlpha = 1.0;

      // 3. Hand-painted chiseled stone facets, warm ochre/cream edge highlights & hairline fissures
      const rRng = createSeededRng(0x3a91e5);
      rCtx.fillStyle = "#b4aba0";
      rCtx.fillRect(0, 0, size, size);

      const facetColors: readonly string[] = [
        "#d8c39f",
        "#c9b18d",
        "#b9b0a6",
        "#9d968e",
        "#828a96",
        "#e6d5b4",
      ];
      for (let i = 0; i < 95; i++) {
        const x = rRng() * size;
        const y = rRng() * size;
        const rad = 14 + rRng() * 28;
        const sides = 5 + Math.floor(rRng() * 3);
        const rot = rRng() * Math.PI * 2;
        const fill = facetColors[Math.floor(rRng() * facetColors.length)] ?? "#b9b0a6";
        const alpha = 0.34 + rRng() * 0.3;

        drawTiledCanvas(size, x, y, rad + 6, (dx, dy) => {
          rCtx.save();
          rCtx.translate(dx, dy);
          rCtx.rotate(rot);
          rCtx.globalAlpha = alpha;
          rCtx.fillStyle = fill;
          rCtx.beginPath();
          for (let s = 0; s < sides; s++) {
            const a = (s / sides) * Math.PI * 2;
            const rScale = 0.72 + ((s * 37 + i) % 5) * 0.08;
            const vx = Math.cos(a) * rad * rScale;
            const vy = Math.sin(a) * rad * rScale;
            if (s === 0) rCtx.moveTo(vx, vy);
            else rCtx.lineTo(vx, vy);
          }
          rCtx.closePath();
          rCtx.fill();

          // Warm cream chiseled edge glint on sunlit stone facet
          if (i % 2 === 0) {
            rCtx.globalAlpha = 0.5;
            rCtx.strokeStyle = "#f2e5cb";
            rCtx.lineWidth = 2.0;
            rCtx.stroke();
          }
          rCtx.restore();
        });
      }

      // Crisp dark hairline stone fissure cracks + subtle cream highlight lip
      for (let i = 0; i < 28; i++) {
        const x = rRng() * size;
        const y = rRng() * size;
        const angle = rRng() * Math.PI * 2;
        const len1 = 16 + rRng() * 26;
        const len2 = 12 + rRng() * 22;
        const bend = (rRng() - 0.5) * 0.9;
        const margin = len1 + len2 + 6;

        drawTiledCanvas(size, x, y, margin, (dx, dy) => {
          const x1 = dx + Math.cos(angle) * len1;
          const y1 = dy + Math.sin(angle) * len1;
          const x2 = x1 + Math.cos(angle + bend) * len2;
          const y2 = y1 + Math.sin(angle + bend) * len2;

          rCtx.save();
          rCtx.lineCap = "round";
          rCtx.strokeStyle = "#f0e1c4";
          rCtx.lineWidth = 2.1;
          rCtx.globalAlpha = 0.55;
          rCtx.beginPath();
          rCtx.moveTo(dx + 1.8, dy + 1.8);
          rCtx.lineTo(x1 + 1.8, y1 + 1.8);
          rCtx.lineTo(x2 + 1.8, y2 + 1.8);
          rCtx.stroke();

          rCtx.strokeStyle = "#463d38";
          rCtx.lineWidth = 1.9;
          rCtx.globalAlpha = 0.82;
          rCtx.beginPath();
          rCtx.moveTo(dx, dy);
          rCtx.lineTo(x1, y1);
          rCtx.lineTo(x2, y2);
          rCtx.stroke();
          rCtx.restore();
        });
      }
      rCtx.globalAlpha = 1.0;

      return {
        foliagePaintTexture: configure(new THREE.CanvasTexture(foliageCanvas)),
        barkPaintTexture: configure(new THREE.CanvasTexture(barkCanvas)),
        rockPaintTexture: configure(new THREE.CanvasTexture(rockCanvas)),
      };
    }
  }

  // Compact deterministic 32x32 DataTexture fallback for headless Node / Vitest
  const size = 32;
  const foliageData = new Uint8Array(size * size * 4);
  const barkData = new Uint8Array(size * size * 4);
  const rockData = new Uint8Array(size * size * 4);
  const tau = Math.PI * 2;

  for (let py = 0; py < size; py++) {
    const v = py / size;
    for (let px = 0; px < size; px++) {
      const u = px / size;
      const idx = (py * size + px) * 4;

      const leafWave =
        0.5 +
        0.3 * Math.sin(u * tau * 3 + Math.cos(v * tau * 3)) +
        0.2 * Math.cos(v * tau * 5 - u * tau * 2);
      foliageData[idx] = Math.round(clamp01(0.38 + leafWave * 0.52) * 255);
      foliageData[idx + 1] = Math.round(clamp01(0.56 + leafWave * 0.4) * 255);
      foliageData[idx + 2] = Math.round(clamp01(0.42 + leafWave * 0.22) * 255);
      foliageData[idx + 3] = 255;

      const barkGroove = 0.5 + 0.5 * Math.sin(u * tau * 6 + Math.sin(v * tau * 2) * 0.8);
      barkData[idx] = Math.round(clamp01(0.42 + barkGroove * 0.4) * 255);
      barkData[idx + 1] = Math.round(clamp01(0.25 + barkGroove * 0.28) * 255);
      barkData[idx + 2] = Math.round(clamp01(0.15 + barkGroove * 0.18) * 255);
      barkData[idx + 3] = 255;

      const stoneFacet =
        0.5 + 0.35 * Math.sin(u * tau * 4 + v * tau * 3) * Math.cos(v * tau * 4 - u * tau * 2);
      rockData[idx] = Math.round(clamp01(0.58 + stoneFacet * 0.32) * 255);
      rockData[idx + 1] = Math.round(clamp01(0.55 + stoneFacet * 0.3) * 255);
      rockData[idx + 2] = Math.round(clamp01(0.5 + stoneFacet * 0.28) * 255);
      rockData[idx + 3] = 255;
    }
  }

  return {
    foliagePaintTexture: configure(
      new THREE.DataTexture(foliageData, size, size, THREE.RGBAFormat),
    ),
    barkPaintTexture: configure(
      new THREE.DataTexture(barkData, size, size, THREE.RGBAFormat),
    ),
    rockPaintTexture: configure(
      new THREE.DataTexture(rockData, size, size, THREE.RGBAFormat),
    ),
  };
}

function disposeObjectTree(root: THREE.Object3D): void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  const addMat = (material: THREE.Material | THREE.Material[]): void => {
    if (Array.isArray(material)) {
      for (const item of material) {
        mats.add(item);
      }
      return;
    }
    mats.add(material);
  };

  const walk = (node: THREE.Object3D): void => {
    if (node.userData.isCachedGlbClone === true) {
      // Cached GLB templates own their shared GPU buffers; never dispose them per-instance
      return;
    }
    if (node instanceof THREE.InstancedMesh || node instanceof THREE.Mesh) {
      geos.add(node.geometry);
      addMat(node.material);
    } else if (node instanceof THREE.Sprite) {
      // Dispose per-sprite SpriteMaterial without disposing the class-owned shared glowTexture
      addMat(node.material);
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);

  for (const g of geos) {
    g.dispose();
  }
  for (const m of mats) {
    m.dispose();
  }
}

/**
 * Replace a landmark group's procedural fallback children with a loaded GLB prop clone,
 * cleanly disposing the superseded procedural meshes while protecting cached GLB buffers.
 */
export function attachLandmarkGlb(
  landmarkGroup: THREE.Group,
  glbClone: THREE.Group,
): void {
  for (let i = landmarkGroup.children.length - 1; i >= 0; i--) {
    const child = landmarkGroup.children[i];
    if (!child) continue;
    landmarkGroup.remove(child);
    disposeObjectTree(child);
  }
  landmarkGroup.add(glbClone);
}

/** Kick off an async GLB prop load for a landmark group with stale-load protection. */
export function loadLandmarkGlbIntoGroup(
  kind: PropLandmarkKind,
  landmarkGroup: THREE.Group,
  isStillValid: () => boolean,
): void {
  void loadPropModel(kind).then((clone) => {
    if (!clone) {
      return;
    }
    if (!isStillValid()) {
      if (clone.userData.isCachedGlbClone !== true) {
        disposeObjectTree(clone);
      }
      return;
    }
    attachLandmarkGlb(landmarkGroup, clone);
  });
}

function distSq3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Lush instanced 3D scenery (wind-swayed multi-tier pine/oak trees, sculpted grass tufts,
 * flowering shrubs, organically weathered boulders, ancient stone ruins, additive-glow lanterns)
 * AND animated 3D visuals for interactive environmental hazards with non-floating carve pruning.
 */
export class EnvironmentProps {
  public readonly group: THREE.Group;

  private readonly sceneryGroup: THREE.Group;
  private readonly hazardGroup: THREE.Group;
  private readonly glowTexture: THREE.Texture;
  private readonly foliagePaintTexture: THREE.Texture;
  private readonly barkPaintTexture: THREE.Texture;
  private readonly rockPaintTexture: THREE.Texture;
  private readonly windTimeUniform: { value: number } = { value: 0 };
  private readonly windVecUniform: { value: THREE.Vector2 } = {
    value: new THREE.Vector2(1.0, 0.35),
  };

  private readonly anchors: TrackedPropAnchor[] = [];
  private readonly hazardVisuals = new Map<string, HazardVisual>();

  private treeCount = 0;
  private floraCount = 0;
  private boulderCount = 0;
  private landmarkCount = 0;

  public constructor(
    world: SdfWorld,
    waterLevel = 1.5,
    avoidPoints: readonly Vec3[] = [],
  ) {
    this.group = new THREE.Group();
    this.group.name = "environment_props";

    this.sceneryGroup = new THREE.Group();
    this.sceneryGroup.name = "scenery_props";
    this.group.add(this.sceneryGroup);

    this.hazardGroup = new THREE.Group();
    this.hazardGroup.name = "interactive_hazards";
    this.group.add(this.hazardGroup);

    this.glowTexture = createSharedGlowTexture();
    const paintTextures = createHandPaintedPropTextures();
    this.foliagePaintTexture = paintTextures.foliagePaintTexture;
    this.barkPaintTexture = paintTextures.barkPaintTexture;
    this.rockPaintTexture = paintTextures.rockPaintTexture;

    this.rebuild(world, waterLevel, avoidPoints);
  }

  /** Advance lightweight GPU vertex-shader wind sway for instanced foliage & meadows. */
  public updateWind(wind: Vec3, elapsedSec: number): void {
    if (Number.isFinite(elapsedSec)) {
      this.windTimeUniform.value = elapsedSec;
    }
    const wx = Number.isFinite(wind.x) ? wind.x : 0;
    const wz = Number.isFinite(wind.z) ? wind.z : 0;
    this.windVecUniform.value.set(wx, wz);
  }

  /** Rebuild all deterministic instanced scenery for a new world, round, or theme. */
  public rebuild(
    world: SdfWorld,
    waterLevel = 1.5,
    avoidPoints: readonly Vec3[] = [],
  ): void {
    this.clearScenery();

    const rng = createSeededRng(world.seed ^ 0x4a7b2c);
    const placedTrees: Vec3[] = [];
    const placedLandmarks: Vec3[] = [];
    const placedBoulders: Vec3[] = [];

    const isClearOfAvoid = (p: Vec3, minDist: number): boolean => {
      const minSq = minDist * minDist;
      for (const av of avoidPoints) {
        if (distSq3(p, av) < minSq) {
          return false;
        }
      }
      return true;
    };

    const isClearOfList = (p: Vec3, list: readonly Vec3[], minDist: number): boolean => {
      const minSq = minDist * minDist;
      for (const item of list) {
        if (distSq3(p, item) < minSq) {
          return false;
        }
      }
      return true;
    };

    interface SurfaceSpot {
      pos: Vec3;
      normalY: number;
      isGrass: boolean;
      isRock: boolean;
      order: number;
    }

    const worldMaxX = world.worldWidth;
    const worldMaxZ = world.worldDepth;
    const isGrand = world.mapScale === "grand";
    const margin = isGrand ? 6.0 : 4.5;
    const gridStep = isGrand ? 2.4 : 1.35;
    const jitter = isGrand ? 1.4 : 0.9;
    const maxLandmarks = isGrand ? 22 : 10;
    const maxTrees = isGrand ? 90 : 38;
    const maxBoulders = isGrand ? 95 : 45;
    const maxFlora = isGrand ? 220 : 120;

    const spots: SurfaceSpot[] = [];
    for (let x = margin; x <= worldMaxX - margin; x += gridStep) {
      for (let z = margin; z <= worldMaxZ - margin; z += gridStep) {
        const jx = x + (rng() - 0.5) * jitter;
        const jz = z + (rng() - 0.5) * jitter;
        const sy = world.getSurfaceY(jx, jz);
        if (sy === null || sy <= waterLevel + 0.65) {
          continue;
        }
        const n = world.sampleNormal(jx, sy, jz);
        if (n.y < 0.48) {
          continue;
        }
        if (
          world.sample(jx, sy + 0.9, jz) <= 0.05 ||
          !world.isSolid(jx, sy - 0.65, jz)
        ) {
          continue;
        }
        spots.push({
          pos: { x: jx, y: sy, z: jz },
          normalY: n.y,
          isGrass: n.y >= 0.68 && sy > 3.1,
          isRock: n.y >= 0.48 && n.y <= 0.86,
          order: rng(),
        });
      }
    }

    spots.sort((a, b) => b.order - a.order);

    // 1. Pick scenic ridge & bridge-head landmarks (Blender GLB watchtower, ruin_arch, gnarled_pine + glowing lanterns)
    const landmarkSpots: Array<{
      pos: Vec3;
      kind: "lantern" | PropLandmarkKind;
      rotY: number;
    }> = [];
    const landmarkKindCycle: ReadonlyArray<"lantern" | PropLandmarkKind> = [
      "watchtower",
      "ruin_arch",
      "gnarled_pine",
      "lantern",
    ];
    // Prefer higher scenic ridges & bridge heads for the hero set-piece landmarks
    const ridgeFirst = [...spots].sort(
      (a, b) => b.pos.y - a.pos.y + (b.order - a.order) * 3.5,
    );
    for (const spot of ridgeFirst) {
      if (landmarkSpots.length >= maxLandmarks) break;
      if (spot.normalY < 0.72 || spot.pos.y < 3.2) continue;
      if (!isClearOfAvoid(spot.pos, 3.3)) continue;
      if (!isClearOfList(spot.pos, placedLandmarks, isGrand ? 8.6 : 6.2)) continue;
      placedLandmarks.push(spot.pos);
      const kind =
        landmarkKindCycle[landmarkSpots.length % landmarkKindCycle.length] ??
        "ruin_arch";
      landmarkSpots.push({
        pos: spot.pos,
        kind,
        rotY: rng() * Math.PI * 2,
      });
    }

    // 2. Pick multi-tier pine & oak trees on broad sunlit grassy tops
    const pineSpots: Array<{ pos: Vec3; scale: number; rotY: number; tint: number }> = [];
    const oakSpots: Array<{ pos: Vec3; scale: number; rotY: number; tint: number }> = [];
    for (const spot of spots) {
      if (pineSpots.length + oakSpots.length >= maxTrees) break;
      if (!spot.isGrass || spot.pos.y < 3.5) continue;
      if (world.sample(spot.pos.x, spot.pos.y + 3.2, spot.pos.z) <= 0.1) continue;
      if (!isClearOfAvoid(spot.pos, 3.1)) continue;
      if (!isClearOfList(spot.pos, placedLandmarks, 3.2)) continue;
      if (!isClearOfList(spot.pos, placedTrees, isGrand ? 3.8 : 2.9)) continue;

      placedTrees.push(spot.pos);
      const entry = {
        pos: spot.pos,
        scale: 0.78 + rng() * 0.56,
        rotY: rng() * Math.PI * 2,
        tint: rng(),
      };
      if ((pineSpots.length + oakSpots.length) % 5 < 3) {
        pineSpots.push(entry);
      } else {
        oakSpots.push(entry);
      }
    }

    // 3. Pick sculpted mossy boulders across cliff rims, coves, and meadows
    const boulderSpots: Array<{
      pos: Vec3;
      sx: number;
      sy: number;
      sz: number;
      rotX: number;
      rotY: number;
      rotZ: number;
      tint: number;
      mossy: boolean;
    }> = [];
    for (const spot of spots) {
      if (boulderSpots.length >= maxBoulders) break;
      if (!isClearOfAvoid(spot.pos, 2.8)) continue;
      if (!isClearOfList(spot.pos, placedLandmarks, 2.4)) continue;
      if (!isClearOfList(spot.pos, placedTrees, 1.9)) continue;
      if (!isClearOfList(spot.pos, placedBoulders, isGrand ? 2.9 : 2.2)) continue;

      placedBoulders.push(spot.pos);
      const base = 0.52 + rng() * 0.72;
      boulderSpots.push({
        pos: spot.pos,
        sx: base * (0.85 + rng() * 0.5),
        sy: base * (0.62 + rng() * 0.42),
        sz: base * (0.85 + rng() * 0.5),
        rotX: (rng() - 0.5) * 0.35,
        rotY: rng() * Math.PI * 2,
        rotZ: (rng() - 0.5) * 0.35,
        tint: rng(),
        mossy: spot.pos.y > 3.2 && rng() > 0.25,
      });
    }

    // 4. Pick lush grass tufts, flowering shrubs & wildflower clusters
    const floraSpots: Array<{
      pos: Vec3;
      scale: number;
      rotY: number;
      kind: "shrub" | "tuft";
      flowerColorIdx: number;
      hasFlowers: boolean;
    }> = [];
    for (const spot of spots) {
      if (floraSpots.length >= maxFlora) break;
      if (spot.normalY < 0.62 || spot.pos.y < 3.0) continue;
      if (!isClearOfAvoid(spot.pos, 2.65)) continue;
      if (!isClearOfList(spot.pos, placedLandmarks, 1.5)) continue;
      if (!isClearOfList(spot.pos, placedBoulders, 1.2)) continue;

      const kind = rng() > 0.45 ? "shrub" : "tuft";
      floraSpots.push({
        pos: spot.pos,
        scale: 0.65 + rng() * 0.65,
        rotY: rng() * Math.PI * 2,
        kind,
        flowerColorIdx: Math.floor(rng() * 4),
        hasFlowers: rng() > 0.38,
      });
    }

    this.buildInstancedPines(pineSpots);
    this.buildInstancedOaks(oakSpots);
    this.buildInstancedBoulders(boulderSpots);
    this.buildInstancedFlora(floraSpots);
    this.buildLandmarks(landmarkSpots);

    this.treeCount = pineSpots.length + oakSpots.length;
    this.boulderCount = boulderSpots.length;
    this.floraCount = floraSpots.length;
    this.landmarkCount = landmarkSpots.length;
  }

  /**
   * Synchronize and animate live 3D hazard visuals (pulsing Blast Barrels,
   * Spark Mines, bubbling Thermal Steam Geysers, and glowing Bramble Thorn Patches).
   * Detonated/inactive hazards are removed and GPU-disposed cleanly.
   */
  public syncHazards(
    hazards: readonly HazardState[],
    elapsedSec: number,
  ): void {
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;
    const activeIds = new Set<string>();

    for (const hazard of hazards) {
      if (!hazard.active) {
        continue;
      }
      activeIds.add(hazard.id);

      let visual = this.hazardVisuals.get(hazard.id);
      if (!visual || visual.type !== hazard.type) {
        if (visual) {
          this.hazardGroup.remove(visual.group);
          disposeObjectTree(visual.group);
        }
        visual = this.createHazardVisual(hazard);
        this.hazardVisuals.set(hazard.id, visual);
        this.hazardGroup.add(visual.group);
      }

      visual.group.position.set(
        hazard.position.x,
        hazard.position.y,
        hazard.position.z,
      );
      this.animateHazardVisual(visual, t);
    }

    for (const [id, visual] of this.hazardVisuals.entries()) {
      if (!activeIds.has(id)) {
        this.hazardGroup.remove(visual.group);
        disposeObjectTree(visual.group);
        this.hazardVisuals.delete(id);
      }
    }
  }

  /**
   * Hide any scenery prop whose supporting terrain was carved away or submerged
   * so no tree, shrub, boulder, or ruin ever floats in mid-air.
   */
  public pruneAfterCarve(world: SdfWorld, waterLevel: number): number {
    let pruned = 0;
    const dirtyMeshes = new Set<THREE.InstancedMesh>();

    for (const anchor of this.anchors) {
      if (!anchor.visible) {
        continue;
      }
      const submerged = anchor.pos.y <= waterLevel + 0.05;
      const supportLost =
        world.sample(anchor.pos.x, anchor.pos.y - 0.45, anchor.pos.z) > 0.05;

      if (submerged || supportLost) {
        anchor.visible = false;
        pruned += 1;
        for (const binding of anchor.bindings) {
          binding.mesh.setMatrixAt(binding.index, ZERO_MATRIX);
          dirtyMeshes.add(binding.mesh);
        }
        if (anchor.landmarkGroup) {
          anchor.landmarkGroup.visible = false;
          this.sceneryGroup.remove(anchor.landmarkGroup);
          disposeObjectTree(anchor.landmarkGroup);
          anchor.landmarkGroup.clear();
        }
      }
    }

    for (const mesh of dirtyMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    return pruned;
  }

  /** Return current scenery & active hazard counts. */
  public getPropCounts(): EnvironmentPropCounts {
    return {
      trees: this.treeCount,
      flora: this.floraCount,
      boulders: this.boulderCount,
      landmarks: this.landmarkCount,
      activeHazards: this.hazardVisuals.size,
    };
  }

  /** Return positions of all currently visible scenery anchors (useful for verification tests). */
  public getVisiblePropPositions(): Vec3[] {
    const result: Vec3[] = [];
    for (const a of this.anchors) {
      if (a.visible) {
        result.push({ ...a.pos });
      }
    }
    return result;
  }

  /** Dispose all instanced scenery meshes, landmarks, active hazards, and shared textures cleanly. */
  public dispose(): void {
    this.clearScenery();
    for (const visual of this.hazardVisuals.values()) {
      this.hazardGroup.remove(visual.group);
      disposeObjectTree(visual.group);
    }
    this.hazardVisuals.clear();
    this.glowTexture.dispose();
    this.foliagePaintTexture.dispose();
    this.barkPaintTexture.dispose();
    this.rockPaintTexture.dispose();
  }

  private clearScenery(): void {
    disposeObjectTree(this.sceneryGroup);
    this.sceneryGroup.clear();
    this.anchors.length = 0;
    this.treeCount = 0;
    this.floraCount = 0;
    this.boulderCount = 0;
    this.landmarkCount = 0;
  }

  private applyWindSway(
    material: THREE.MeshStandardMaterial,
    opts: WindSwayOptions,
  ): void {
    const minYStr = opts.minY.toFixed(3);
    const spanStr = Math.max(0.05, opts.heightSpan).toFixed(3);
    const ampStr = opts.amp.toFixed(4);
    const freqStr = opts.freq.toFixed(3);
    const baseStr = opts.baseSway.toFixed(3);

    const resolvedCacheKey = `${opts.cacheKey}_${minYStr}_${spanStr}_${ampStr}_${freqStr}_${baseStr}`;
    material.customProgramCacheKey = (): string => resolvedCacheKey;
    material.onBeforeCompile = (shader): void => {
      shader.uniforms.uWindTime = this.windTimeUniform;
      shader.uniforms.uWindVec = this.windVecUniform;

      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
uniform float uWindTime;
uniform vec2 uWindVec;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 windAnchor = instanceMatrix[3].xyz;
#else
  vec3 windAnchor = modelMatrix[3].xyz;
#endif
float windSpeed = length( uWindVec );
vec2 windDir = windSpeed > 0.001 ? ( uWindVec / windSpeed ) : vec2( 0.86, 0.51 );
float windMag = clamp( 0.45 + windSpeed * 0.14, 0.35, 1.65 );
float windPhase = uWindTime * ${freqStr} + windAnchor.x * 0.27 + windAnchor.z * 0.23;
float windWave = sin( windPhase ) + 0.35 * sin( windPhase * 2.13 + windAnchor.x * 0.11 );
float swayH = clamp( ( position.y - (${minYStr}) ) / ${spanStr}, 0.0, 1.0 );
float swayWeight = mix( ${baseStr}, 1.0, swayH * swayH );
vec2 swayXZ = ( windDir * ( 0.32 + windWave * 0.68 ) + vec2( -windDir.y, windDir.x ) * cos( windPhase * 0.85 ) * 0.24 ) * ( ${ampStr} * windMag * swayWeight );
#ifdef USE_INSTANCING
  float windRLen = length( instanceMatrix[0].xyz );
  float windFLen = length( instanceMatrix[2].xyz );
  if ( windRLen > 0.0001 && windFLen > 0.0001 ) {
    vec3 worldSway = vec3( swayXZ.x, 0.0, swayXZ.y );
    transformed.x += dot( worldSway, instanceMatrix[0].xyz / windRLen );
    transformed.z += dot( worldSway, instanceMatrix[2].xyz / windFLen );
  }
#else
  transformed.x += swayXZ.x;
  transformed.z += swayXZ.y;
#endif`,
        );
    };
  }

  private createGlowHaloSprite(
    colorHex: number,
    scale: number,
    opacity: number,
  ): THREE.Sprite {
    const mat = new THREE.SpriteMaterial({
      map: this.glowTexture,
      color: colorHex,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(scale, scale, 1);
    return sprite;
  }

  private createGroundLightPool(
    colorHex: number,
    radius: number,
    opacity: number,
  ): THREE.Mesh {
    const geo = new THREE.CircleGeometry(radius, 24);
    const mat = new THREE.MeshBasicMaterial({
      map: this.glowTexture,
      color: colorHex,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const pool = new THREE.Mesh(geo, mat);
    pool.rotation.x = -Math.PI * 0.5;
    pool.position.y = 0.06;
    pool.castShadow = false;
    pool.receiveShadow = false;
    return pool;
  }

  private buildInstancedPines(
    spots: ReadonlyArray<{ pos: Vec3; scale: number; rotY: number; tint: number }>,
  ): void {
    const count = spots.length;
    if (count === 0) return;

    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.24, 1.45, 7);
    bakeVerticalVertexGradient(trunkGeo, [0.66, 0.64, 0.62], [1.0, 1.0, 0.98]);
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0xb68b67,
      map: this.barkPaintTexture,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
    });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    trunks.castShadow = true;
    trunks.receiveShadow = true;

    const tier1Geo = new THREE.ConeGeometry(1.18, 1.65, 8);
    const tier2Geo = new THREE.ConeGeometry(0.92, 1.45, 8);
    const tier3Geo = new THREE.ConeGeometry(0.62, 1.25, 7);
    bakeVerticalVertexGradient(tier1Geo, [0.56, 0.72, 0.78], [1.06, 1.04, 0.88]);
    bakeVerticalVertexGradient(tier2Geo, [0.56, 0.72, 0.78], [1.06, 1.04, 0.88]);
    bakeVerticalVertexGradient(tier3Geo, [0.56, 0.72, 0.78], [1.06, 1.04, 0.88]);

    // Share ONE wind-swayed painterly foliage material across all 3 pine canopy tiers
    const foliageMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.foliagePaintTexture,
      vertexColors: true,
      roughness: 0.84,
      metalness: 0.02,
      flatShading: true,
    });
    this.applyWindSway(foliageMat, {
      cacheKey: "critter_foliage_wind_pine_v1",
      minY: -0.85,
      heightSpan: 1.7,
      amp: 0.085,
      freq: 1.75,
      baseSway: 0.34,
    });

    const tier1 = new THREE.InstancedMesh(tier1Geo, foliageMat, count);
    const tier2 = new THREE.InstancedMesh(tier2Geo, foliageMat, count);
    const tier3 = new THREE.InstancedMesh(tier3Geo, foliageMat, count);
    for (const m of [tier1, tier2, tier3]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const sp = spots[i];
      if (!sp) continue;
      const s = sp.scale;

      dummy.position.set(sp.pos.x, sp.pos.y + 0.62 * s, sp.pos.z);
      dummy.rotation.set(0, sp.rotY, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);

      dummy.position.set(sp.pos.x, sp.pos.y + 1.55 * s, sp.pos.z);
      dummy.rotation.set(0, sp.rotY, 0);
      dummy.updateMatrix();
      tier1.setMatrixAt(i, dummy.matrix);

      dummy.position.set(sp.pos.x, sp.pos.y + 2.38 * s, sp.pos.z);
      dummy.rotation.set(0, sp.rotY + 0.45, 0);
      dummy.updateMatrix();
      tier2.setMatrixAt(i, dummy.matrix);

      dummy.position.set(sp.pos.x, sp.pos.y + 3.12 * s, sp.pos.z);
      dummy.rotation.set(0, sp.rotY + 0.9, 0);
      dummy.updateMatrix();
      tier3.setMatrixAt(i, dummy.matrix);

      const hShift = 0.34 + sp.tint * 0.06;
      color.setHSL(hShift, 0.56, 0.33 + sp.tint * 0.07);
      tier1.setColorAt(i, color);
      color.setHSL(hShift - 0.01, 0.58, 0.39 + sp.tint * 0.07);
      tier2.setColorAt(i, color);
      color.setHSL(hShift - 0.02, 0.62, 0.46 + sp.tint * 0.07);
      tier3.setColorAt(i, color);

      this.anchors.push({
        category: "tree",
        pos: { ...sp.pos },
        visible: true,
        bindings: [
          { mesh: trunks, index: i },
          { mesh: tier1, index: i },
          { mesh: tier2, index: i },
          { mesh: tier3, index: i },
        ],
      });
    }

    for (const m of [trunks, tier1, tier2, tier3]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) {
        m.instanceColor.needsUpdate = true;
      }
      this.sceneryGroup.add(m);
    }
  }

  private buildInstancedOaks(
    spots: ReadonlyArray<{ pos: Vec3; scale: number; rotY: number; tint: number }>,
  ): void {
    const count = spots.length;
    if (count === 0) return;

    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.28, 1.65, 8);
    bakeVerticalVertexGradient(trunkGeo, [0.66, 0.64, 0.62], [1.0, 1.0, 0.98]);
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0xc29570,
      map: this.barkPaintTexture,
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.02,
    });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    trunks.castShadow = true;
    trunks.receiveShadow = true;

    const crownMainGeo = new THREE.IcosahedronGeometry(1.05, 1);
    const crownSideGeo = new THREE.IcosahedronGeometry(0.76, 1);
    bakeVerticalVertexGradient(crownMainGeo, [0.56, 0.72, 0.78], [1.06, 1.04, 0.88]);
    bakeVerticalVertexGradient(crownSideGeo, [0.56, 0.72, 0.78], [1.06, 1.04, 0.88]);

    // Share ONE lush smooth painterly wind-swayed leaf material across all 3 oak crowns
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.foliagePaintTexture,
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.02,
      flatShading: false,
    });
    this.applyWindSway(leafMat, {
      cacheKey: "critter_foliage_wind_oak_v1",
      minY: -1.05,
      heightSpan: 2.1,
      amp: 0.085,
      freq: 1.75,
      baseSway: 0.34,
    });

    const crownMain = new THREE.InstancedMesh(crownMainGeo, leafMat, count);
    const crownSideA = new THREE.InstancedMesh(crownSideGeo, leafMat, count);
    const crownSideB = new THREE.InstancedMesh(crownSideGeo, leafMat, count);
    for (const m of [crownMain, crownSideA, crownSideB]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const sp = spots[i];
      if (!sp) continue;
      const s = sp.scale;
      const cosR = Math.cos(sp.rotY);
      const sinR = Math.sin(sp.rotY);

      dummy.position.set(sp.pos.x, sp.pos.y + 0.75 * s, sp.pos.z);
      dummy.rotation.set(0, sp.rotY, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);

      dummy.position.set(sp.pos.x, sp.pos.y + 2.18 * s, sp.pos.z);
      dummy.rotation.set(0.15, sp.rotY, 0.1);
      dummy.scale.set(1.12 * s, 0.88 * s, 1.08 * s);
      dummy.updateMatrix();
      crownMain.setMatrixAt(i, dummy.matrix);

      dummy.position.set(
        sp.pos.x + cosR * 0.72 * s,
        sp.pos.y + 1.88 * s,
        sp.pos.z + sinR * 0.72 * s,
      );
      dummy.scale.set(0.95 * s, 0.82 * s, 0.95 * s);
      dummy.updateMatrix();
      crownSideA.setMatrixAt(i, dummy.matrix);

      dummy.position.set(
        sp.pos.x - cosR * 0.65 * s,
        sp.pos.y + 1.98 * s,
        sp.pos.z - sinR * 0.62 * s,
      );
      dummy.scale.set(0.9 * s, 0.8 * s, 0.9 * s);
      dummy.updateMatrix();
      crownSideB.setMatrixAt(i, dummy.matrix);

      const hue = 0.25 + sp.tint * 0.08;
      color.setHSL(hue, 0.56, 0.45 + sp.tint * 0.08);
      crownMain.setColorAt(i, color);
      color.setHSL(hue + 0.02, 0.54, 0.4 + sp.tint * 0.07);
      crownSideA.setColorAt(i, color);
      color.setHSL(hue - 0.02, 0.62, 0.51 + sp.tint * 0.08);
      crownSideB.setColorAt(i, color);

      this.anchors.push({
        category: "tree",
        pos: { ...sp.pos },
        visible: true,
        bindings: [
          { mesh: trunks, index: i },
          { mesh: crownMain, index: i },
          { mesh: crownSideA, index: i },
          { mesh: crownSideB, index: i },
        ],
      });
    }

    for (const m of [trunks, crownMain, crownSideA, crownSideB]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) {
        m.instanceColor.needsUpdate = true;
      }
      this.sceneryGroup.add(m);
    }
  }

  private buildInstancedBoulders(
    spots: ReadonlyArray<{
      pos: Vec3;
      sx: number;
      sy: number;
      sz: number;
      rotX: number;
      rotY: number;
      rotZ: number;
      tint: number;
      mossy: boolean;
    }>,
  ): void {
    const count = spots.length;
    if (count === 0) return;

    const rockGeo = new THREE.DodecahedronGeometry(0.56, 1);
    perturbBoulderGeometry(rockGeo);
    bakeVerticalVertexGradient(rockGeo, [0.64, 0.68, 0.74], [1.0, 1.0, 0.96]);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.rockPaintTexture,
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.05,
      flatShading: true,
    });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, count);
    rocks.castShadow = true;
    rocks.receiveShadow = true;

    const mossGeo = new THREE.SphereGeometry(0.42, 8, 6);
    bakeVerticalVertexGradient(mossGeo, [0.56, 0.72, 0.78], [1.06, 1.04, 0.88]);
    const mossMat = new THREE.MeshStandardMaterial({
      color: 0x62ab4c,
      map: this.foliagePaintTexture,
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.02,
      flatShading: false,
    });
    const mossCaps = new THREE.InstancedMesh(mossGeo, mossMat, count);
    mossCaps.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const sp = spots[i];
      if (!sp) continue;

      dummy.position.set(sp.pos.x, sp.pos.y + sp.sy * 0.28, sp.pos.z);
      dummy.rotation.set(sp.rotX, sp.rotY, sp.rotZ);
      dummy.scale.set(sp.sx, sp.sy, sp.sz);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);

      // Warm sandstone/slate palette variation lifted slightly for rockPaintTexture
      if (sp.tint < 0.45) {
        color.setHSL(0.07, 0.34, 0.52 + sp.tint * 0.16);
      } else {
        color.setHSL(0.58, 0.12, 0.5 + sp.tint * 0.14);
      }
      rocks.setColorAt(i, color);

      if (sp.mossy) {
        dummy.position.set(sp.pos.x, sp.pos.y + sp.sy * 0.56, sp.pos.z);
        dummy.rotation.set(0, sp.rotY, 0);
        dummy.scale.set(sp.sx * 0.92, sp.sy * 0.32, sp.sz * 0.92);
        dummy.updateMatrix();
        mossCaps.setMatrixAt(i, dummy.matrix);
      } else {
        mossCaps.setMatrixAt(i, ZERO_MATRIX);
      }

      this.anchors.push({
        category: "boulder",
        pos: { ...sp.pos },
        visible: true,
        bindings: [
          { mesh: rocks, index: i },
          { mesh: mossCaps, index: i },
        ],
      });
    }

    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    mossCaps.instanceMatrix.needsUpdate = true;
    this.sceneryGroup.add(rocks, mossCaps);
  }

  private buildInstancedFlora(
    spots: ReadonlyArray<{
      pos: Vec3;
      scale: number;
      rotY: number;
      kind: "shrub" | "tuft";
      flowerColorIdx: number;
      hasFlowers: boolean;
    }>,
  ): void {
    const count = spots.length;
    if (count === 0) return;

    const shrubGeo = new THREE.IcosahedronGeometry(0.42, 1);
    bakeVerticalVertexGradient(shrubGeo, [0.56, 0.72, 0.78], [1.06, 1.04, 0.88]);
    const shrubMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.foliagePaintTexture,
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.02,
      flatShading: false,
    });
    this.applyWindSway(shrubMat, {
      cacheKey: "critter_foliage_wind_shrub_v1",
      minY: -0.42,
      heightSpan: 0.84,
      amp: 0.045,
      freq: 2.25,
      baseSway: 0.0,
    });
    const shrubs = new THREE.InstancedMesh(shrubGeo, shrubMat, count);
    shrubs.castShadow = false;
    shrubs.receiveShadow = true;

    const tuftGeo = createSculptedGrassTuftGeometry();
    const tuftMat = new THREE.MeshStandardMaterial({
      color: 0x62b844,
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    this.applyWindSway(tuftMat, {
      cacheKey: "critter_foliage_wind_flora_v1",
      minY: 0.0,
      heightSpan: 0.48,
      amp: 0.095,
      freq: 2.65,
      baseSway: 0.0,
    });
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, count);
    tufts.castShadow = false;
    tufts.receiveShadow = true;

    const flowerGeo = new THREE.OctahedronGeometry(0.11, 0);
    const flowerMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x2a1a05,
      emissiveIntensity: 0.25,
      roughness: 0.55,
      metalness: 0.02,
    });
    const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, count);
    flowers.castShadow = false;
    flowers.receiveShadow = true;

    const flowerPalette = [0xffd84a, 0xff7062, 0x6ce5ff, 0xd896ff];
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const sp = spots[i];
      if (!sp) continue;
      const s = sp.scale;

      if (sp.kind === "shrub") {
        dummy.position.set(sp.pos.x, sp.pos.y + 0.22 * s, sp.pos.z);
        dummy.rotation.set(0, sp.rotY, 0);
        dummy.scale.set(1.22 * s, 0.74 * s, 1.18 * s);
        dummy.updateMatrix();
        shrubs.setMatrixAt(i, dummy.matrix);

        color.setHSL(0.27 + (i % 7) * 0.014, 0.58, 0.43 + (i % 5) * 0.03);
        shrubs.setColorAt(i, color);
        tufts.setMatrixAt(i, ZERO_MATRIX);
      } else {
        dummy.position.set(sp.pos.x, sp.pos.y - 0.02 * s, sp.pos.z);
        dummy.rotation.set(0, sp.rotY, 0);
        dummy.scale.set(1.18 * s, 1.05 * s, 1.18 * s);
        dummy.updateMatrix();
        tufts.setMatrixAt(i, dummy.matrix);
        shrubs.setMatrixAt(i, ZERO_MATRIX);
      }

      if (sp.hasFlowers) {
        const yOff = sp.kind === "shrub" ? 0.46 * s : 0.34 * s;
        dummy.position.set(
          sp.pos.x + Math.cos(sp.rotY) * 0.14 * s,
          sp.pos.y + yOff,
          sp.pos.z + Math.sin(sp.rotY) * 0.14 * s,
        );
        dummy.rotation.set(0.3, sp.rotY, 0.2);
        dummy.scale.setScalar(0.95 * s);
        dummy.updateMatrix();
        flowers.setMatrixAt(i, dummy.matrix);

        color.setHex(flowerPalette[sp.flowerColorIdx % flowerPalette.length] ?? 0xffd84a);
        flowers.setColorAt(i, color);
      } else {
        flowers.setMatrixAt(i, ZERO_MATRIX);
      }

      this.anchors.push({
        category: "flora",
        pos: { ...sp.pos },
        visible: true,
        bindings: [
          { mesh: shrubs, index: i },
          { mesh: tufts, index: i },
          { mesh: flowers, index: i },
        ],
      });
    }

    for (const m of [shrubs, tufts, flowers]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.sceneryGroup.add(m);
    }
  }

  private buildLandmarks(
    spots: ReadonlyArray<{
      pos: Vec3;
      kind: "ruin" | "lantern" | PropLandmarkKind;
      rotY: number;
    }>,
  ): void {
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      if (!sp) continue;

      const group = new THREE.Group();
      group.name = `${sp.kind}_${i}`;
      group.position.set(sp.pos.x, sp.pos.y, sp.pos.z);
      group.rotation.y = sp.rotY;

      let glbKind: PropLandmarkKind | undefined;

      if (sp.kind === "lantern") {
        // Warm glowing island lantern post + additive amber-gold halo + luminous ground light pool
        const woodMat = new THREE.MeshStandardMaterial({
          color: 0xb48562,
          map: this.barkPaintTexture,
          roughness: 0.86,
          metalness: 0.05,
        });
        const ironMat = new THREE.MeshStandardMaterial({
          color: 0x3b424d,
          roughness: 0.52,
          metalness: 0.65,
        });
        const glowMat = new THREE.MeshStandardMaterial({
          color: 0xffe49e,
          emissive: 0xffa62b,
          emissiveIntensity: 1.45,
          roughness: 0.25,
          metalness: 0.1,
        });

        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.08, 0.13, 2.35, 7),
          woodMat,
        );
        post.position.y = 1.12;
        post.castShadow = true;

        const footing = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.3, 0.24, 7),
          ironMat,
        );
        footing.position.y = 0.08;

        const arm = new THREE.Mesh(
          new THREE.CylinderGeometry(0.036, 0.044, 0.65, 6),
          ironMat,
        );
        arm.position.set(0.24, 2.22, 0);
        arm.rotation.z = -Math.PI * 0.38;

        const roof = new THREE.Mesh(
          new THREE.ConeGeometry(0.22, 0.2, 6),
          ironMat,
        );
        roof.position.set(0.48, 2.18, 0);

        const crystal = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.16, 0),
          glowMat,
        );
        crystal.position.set(0.48, 1.98, 0);

        const lanternHalo = this.createGlowHaloSprite(0xffbe55, 1.48, 0.72);
        lanternHalo.position.set(0.48, 1.98, 0);

        const lanternPool = this.createGroundLightPool(0xffc857, 1.65, 0.38);
        lanternPool.position.set(0.36, 0.06, 0);

        group.add(post, footing, arm, roof, crystal, lanternHalo, lanternPool);
      } else if (sp.kind === "watchtower") {
        glbKind = "watchtower";
        // Sculpted procedural lookout tower fallback (replaced asynchronously by watchtower.glb)
        const timberMat = new THREE.MeshStandardMaterial({
          color: 0xb98a64,
          map: this.barkPaintTexture,
          roughness: 0.88,
          metalness: 0.04,
          flatShading: true,
        });
        const roofMat = new THREE.MeshStandardMaterial({
          color: 0x9b3c2d,
          roughness: 0.82,
          metalness: 0.05,
          flatShading: true,
        });
        const base = new THREE.Mesh(
          new THREE.CylinderGeometry(0.62, 0.78, 2.6, 7),
          timberMat,
        );
        base.position.y = 1.3;
        base.castShadow = true;
        base.receiveShadow = true;

        const deck = new THREE.Mesh(
          new THREE.CylinderGeometry(0.95, 0.82, 0.35, 8),
          timberMat,
        );
        deck.position.y = 2.75;
        deck.castShadow = true;

        const roof = new THREE.Mesh(
          new THREE.ConeGeometry(1.15, 1.15, 8),
          roofMat,
        );
        roof.position.y = 3.55;
        roof.castShadow = true;

        group.add(base, deck, roof);
      } else if (sp.kind === "gnarled_pine") {
        glbKind = "gnarled_pine";
        // Sculpted gnarled cliff pine fallback (replaced asynchronously by gnarled_pine.glb)
        const barkMat = new THREE.MeshStandardMaterial({
          color: 0xa67c58,
          map: this.barkPaintTexture,
          roughness: 0.92,
          metalness: 0.02,
          flatShading: true,
        });
        const needleMat = new THREE.MeshStandardMaterial({
          color: 0x529264,
          map: this.foliagePaintTexture,
          roughness: 0.84,
          metalness: 0.02,
          flatShading: true,
        });
        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.34, 2.1, 7),
          barkMat,
        );
        trunk.position.y = 1.0;
        trunk.rotation.z = 0.14;
        trunk.castShadow = true;

        const canopyA = new THREE.Mesh(
          new THREE.ConeGeometry(1.35, 1.75, 8),
          needleMat,
        );
        canopyA.position.set(0.18, 2.25, 0);
        canopyA.castShadow = true;

        const canopyB = new THREE.Mesh(
          new THREE.ConeGeometry(0.92, 1.35, 7),
          needleMat,
        );
        canopyB.position.set(0.28, 3.2, 0);
        canopyB.castShadow = true;

        group.add(trunk, canopyA, canopyB);
      } else {
        glbKind = "ruin_arch";
        // Ancient carved stone ruin fallback (replaced asynchronously by ruin_arch.glb)
        const stoneMat = new THREE.MeshStandardMaterial({
          color: 0xd9cebc,
          map: this.rockPaintTexture,
          roughness: 0.88,
          metalness: 0.04,
          flatShading: true,
        });
        const base = new THREE.Mesh(
          new THREE.CylinderGeometry(0.46, 0.56, 0.34, 8),
          stoneMat,
        );
        base.position.y = 0.14;
        base.castShadow = true;
        base.receiveShadow = true;

        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(0.28, 0.35, 2.05, 8),
          stoneMat,
        );
        shaft.position.y = 1.24;
        shaft.castShadow = true;
        shaft.receiveShadow = true;

        const collar = new THREE.Mesh(
          new THREE.TorusGeometry(0.32, 0.06, 7, 16),
          stoneMat,
        );
        collar.rotation.x = Math.PI * 0.5;
        collar.position.y = 2.1;

        const cap = new THREE.Mesh(
          new THREE.CylinderGeometry(0.44, 0.3, 0.26, 8),
          stoneMat,
        );
        cap.position.y = 2.34;
        cap.rotation.z = 0.08;
        cap.castShadow = true;

        group.add(base, shaft, collar, cap);
      }

      this.sceneryGroup.add(group);
      const anchor: TrackedPropAnchor = {
        category: "landmark",
        pos: { ...sp.pos },
        visible: true,
        bindings: [],
        landmarkGroup: group,
        ...(glbKind ? { glbKind } : {}),
      };
      this.anchors.push(anchor);

      if (glbKind) {
        loadLandmarkGlbIntoGroup(
          glbKind,
          group,
          () => anchor.visible && group.parent === this.sceneryGroup,
        );
      }
    }
  }

  private createHazardVisual(hazard: HazardState): HazardVisual {
    const group = new THREE.Group();
    group.name = `hazard_${hazard.id}`;
    const pulseMaterials: THREE.MeshStandardMaterial[] = [];
    const phaseOffset =
      (hazard.position.x * 0.7 + hazard.position.z * 0.5) % (Math.PI * 2);

    if (hazard.type === "blast_barrel") {
      // Bulging sculpted explosive barrel via LatheGeometry + forged hoops + glowing core, halo & ground pool
      const profile = [
        new THREE.Vector2(0.01, 0.0),
        new THREE.Vector2(0.4, 0.0),
        new THREE.Vector2(0.48, 0.32),
        new THREE.Vector2(0.52, 0.62),
        new THREE.Vector2(0.48, 0.92),
        new THREE.Vector2(0.4, 1.18),
        new THREE.Vector2(0.01, 1.18),
      ];
      const barrelMat = new THREE.MeshStandardMaterial({
        color: 0xc93524,
        emissive: 0x6b1408,
        emissiveIntensity: 0.45,
        roughness: 0.52,
        metalness: 0.22,
      });
      pulseMaterials.push(barrelMat);

      const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 14), barrelMat);
      body.castShadow = true;
      body.receiveShadow = true;

      const hoopMat = new THREE.MeshStandardMaterial({
        color: 0x2c3038,
        roughness: 0.42,
        metalness: 0.75,
      });
      const lowHoop = new THREE.Mesh(
        new THREE.TorusGeometry(0.49, 0.038, 8, 20),
        hoopMat,
      );
      lowHoop.rotation.x = Math.PI * 0.5;
      lowHoop.position.y = 0.28;

      const highHoop = new THREE.Mesh(
        new THREE.TorusGeometry(0.49, 0.038, 8, 20),
        hoopMat.clone(),
      );
      highHoop.rotation.x = Math.PI * 0.5;
      highHoop.position.y = 0.88;

      const coreMat = new THREE.MeshStandardMaterial({
        color: 0xffc845,
        emissive: 0xff6214,
        emissiveIntensity: 1.5,
        roughness: 0.22,
        metalness: 0.1,
      });
      pulseMaterials.push(coreMat);

      const emberTop = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), coreMat);
      emberTop.position.y = 1.24;

      const glowHalo = this.createGlowHaloSprite(0xff8424, 1.35, 0.72);
      glowHalo.position.y = 1.24;

      const warningRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.74, 0.032, 8, 24),
        new THREE.MeshBasicMaterial({
          color: 0xff7b29,
          transparent: true,
          opacity: 0.58,
          depthWrite: false,
        }),
      );
      warningRing.rotation.x = Math.PI * 0.5;
      warningRing.position.y = 0.08;

      const groundPool = this.createGroundLightPool(0xff8c28, 1.8, 0.42);

      group.add(body, lowHoop, highHoop, emberTop, glowHalo, warningRing, groundPool);
      return {
        type: hazard.type,
        group,
        pulseMaterials,
        warningRing,
        glowHalo,
        glowBaseScale: 1.35,
        groundPool,
        groundPoolBaseOpacity: 0.42,
        phaseOffset,
      };
    }

    if (hazard.type === "steam_geyser") {
      // Sculpted volcanic geothermal vent + glowing spring pool + cyan halo, ground pool & rising steam puffs
      const rockMat = new THREE.MeshStandardMaterial({
        color: 0x76828e,
        map: this.rockPaintTexture,
        roughness: 0.9,
        metalness: 0.08,
        flatShading: true,
      });
      const mound = new THREE.Mesh(
        new THREE.CylinderGeometry(0.68, 1.15, 0.42, 10),
        rockMat,
      );
      mound.position.y = 0.18;
      mound.castShadow = true;
      mound.receiveShadow = true;

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.76, 0.22, 8, 18),
        rockMat.clone(),
      );
      rim.rotation.x = Math.PI * 0.5;
      rim.position.y = 0.34;

      const poolMat = new THREE.MeshStandardMaterial({
        color: 0x7ef9ff,
        emissive: 0x1fd8f0,
        emissiveIntensity: 1.2,
        roughness: 0.18,
        metalness: 0.1,
      });
      pulseMaterials.push(poolMat);

      const pool = new THREE.Mesh(
        new THREE.CylinderGeometry(0.62, 0.62, 0.08, 14),
        poolMat,
      );
      pool.position.y = 0.32;

      const glowHalo = this.createGlowHaloSprite(0x46f0ff, 1.85, 0.48);
      glowHalo.position.y = 0.44;

      const groundPool = this.createGroundLightPool(0x32f0ff, 2.1, 0.38);

      const steamPuffs: THREE.Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const puff = new THREE.Mesh(
          new THREE.SphereGeometry(0.3, 10, 8),
          new THREE.MeshBasicMaterial({
            color: 0xe8ffff,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          }),
        );
        puff.position.y = 0.55 + i * 0.55;
        group.add(puff);
        steamPuffs.push(puff);
      }

      group.add(mound, rim, pool, glowHalo, groundPool);
      return {
        type: hazard.type,
        group,
        pulseMaterials,
        steamPuffs,
        glowHalo,
        glowBaseScale: 1.85,
        groundPool,
        groundPoolBaseOpacity: 0.38,
        phaseOffset,
      };
    }

    if (hazard.type === "spark_mine") {
      // Sculpted proximity Spark Mine: dark metallic dome + pulsing crimson LED beacon + crimson halo + glowing sensor ring + fiery ground pool
      const hullMat = new THREE.MeshStandardMaterial({
        color: 0x262d38,
        roughness: 0.36,
        metalness: 0.78,
      });
      const baseRing = new THREE.Mesh(
        new THREE.CylinderGeometry(0.48, 0.58, 0.18, 14),
        hullMat,
      );
      baseRing.position.y = 0.09;
      baseRing.castShadow = true;
      baseRing.receiveShadow = true;

      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(0.44, 14, 10),
        hullMat.clone(),
      );
      dome.name = "spark_mine_dome";
      dome.scale.set(1.0, 0.56, 1.0);
      dome.position.y = 0.21;
      dome.castShadow = true;
      dome.receiveShadow = true;

      const collarMat = new THREE.MeshStandardMaterial({
        color: 0x3b4454,
        roughness: 0.34,
        metalness: 0.82,
      });
      const ledCollar = new THREE.Mesh(
        new THREE.TorusGeometry(0.16, 0.036, 8, 16),
        collarMat,
      );
      ledCollar.rotation.x = Math.PI * 0.5;
      ledCollar.position.y = 0.44;

      const beaconMat = new THREE.MeshStandardMaterial({
        color: 0xff3b5c,
        emissive: 0xff1744,
        emissiveIntensity: 1.9,
        roughness: 0.16,
        metalness: 0.1,
      });
      pulseMaterials.push(beaconMat);

      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.135, 12, 10),
        beaconMat,
      );
      beacon.name = "spark_mine_beacon";
      beacon.position.y = 0.51;

      const glowHalo = this.createGlowHaloSprite(0xff2954, 1.18, 0.78);
      glowHalo.position.y = 0.52;

      const prongMat = new THREE.MeshStandardMaterial({
        color: 0x525d70,
        emissive: 0xb91c1c,
        emissiveIntensity: 0.45,
        roughness: 0.34,
        metalness: 0.76,
      });
      pulseMaterials.push(prongMat);

      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const prong = new THREE.Mesh(
          new THREE.ConeGeometry(0.06, 0.24, 6),
          prongMat,
        );
        prong.position.set(Math.cos(a) * 0.44, 0.31, Math.sin(a) * 0.44);
        prong.rotation.set(Math.sin(a) * 0.78, -a, -Math.cos(a) * 0.78);
        prong.castShadow = true;
        group.add(prong);
      }

      const warningRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.88, 0.038, 8, 28),
        new THREE.MeshBasicMaterial({
          color: 0xff4769,
          transparent: true,
          opacity: 0.64,
          depthWrite: false,
        }),
      );
      warningRing.name = "spark_mine_ring";
      warningRing.rotation.x = Math.PI * 0.5;
      warningRing.position.y = 0.08;

      const groundPool = this.createGroundLightPool(0xff3824, 2.2, 0.48);

      group.add(baseRing, dome, ledCollar, beacon, glowHalo, warningRing, groundPool);
      return {
        type: hazard.type,
        group,
        pulseMaterials,
        warningRing,
        glowHalo,
        glowBaseScale: 1.18,
        groundPool,
        groundPoolBaseOpacity: 0.48,
        phaseOffset,
      };
    }

    // 'thorn_patch': Tangled bramble vine coils + sharp conical thorns + glowing magenta spores, halo & ground pool
    const vineMat = new THREE.MeshStandardMaterial({
      color: 0x3b1f3d,
      roughness: 0.85,
      metalness: 0.05,
    });
    const outerCoil = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.11, 8, 22),
      vineMat,
    );
    outerCoil.rotation.x = Math.PI * 0.5;
    outerCoil.position.y = 0.12;
    outerCoil.castShadow = true;

    const innerCoil = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.09, 7, 18),
      vineMat.clone(),
    );
    innerCoil.rotation.set(Math.PI * 0.42, 0.4, 0.25);
    innerCoil.position.y = 0.22;

    const thornMat = new THREE.MeshStandardMaterial({
      color: 0x6c246e,
      emissive: 0x420a48,
      emissiveIntensity: 0.4,
      roughness: 0.6,
      metalness: 0.15,
    });
    const sporeMat = new THREE.MeshStandardMaterial({
      color: 0xff62e8,
      emissive: 0xe61fd6,
      emissiveIntensity: 1.35,
      roughness: 0.25,
      metalness: 0.1,
    });
    pulseMaterials.push(sporeMat);

    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const rad = i % 2 === 0 ? 0.92 : 0.46;
      const thorn = new THREE.Mesh(
        new THREE.ConeGeometry(0.11, 0.72, 6),
        thornMat,
      );
      thorn.position.set(Math.cos(a) * rad, 0.34, Math.sin(a) * rad);
      thorn.rotation.set(Math.sin(a) * 0.38, -a, -Math.cos(a) * 0.38);
      thorn.castShadow = true;
      group.add(thorn);

      if (i % 2 === 0) {
        const bud = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.11, 0),
          sporeMat,
        );
        bud.position.set(Math.cos(a) * (rad * 0.85), 0.52, Math.sin(a) * (rad * 0.85));
        group.add(bud);
      }
    }

    const glowHalo = this.createGlowHaloSprite(0xf248e6, 1.72, 0.52);
    glowHalo.position.y = 0.48;

    const groundPool = this.createGroundLightPool(0xe048ff, 1.9, 0.35);

    group.add(outerCoil, innerCoil, glowHalo, groundPool);
    return {
      type: hazard.type,
      group,
      pulseMaterials,
      glowHalo,
      glowBaseScale: 1.72,
      groundPool,
      groundPoolBaseOpacity: 0.35,
      phaseOffset,
    };
  }

  private pulseGroundPool(visual: HazardVisual, pulseVal: number): void {
    if (!visual.groundPool) return;
    const s = 0.92 + pulseVal * 0.18;
    visual.groundPool.scale.set(s, s, 1);
    if (visual.groundPool.material instanceof THREE.MeshBasicMaterial) {
      const baseOp = visual.groundPoolBaseOpacity ?? 0.4;
      visual.groundPool.material.opacity = baseOp * (0.72 + pulseVal * 0.52);
    }
  }

  private animateHazardVisual(visual: HazardVisual, elapsedSec: number): void {
    const phase = elapsedSec * 3.6 + visual.phaseOffset;

    if (visual.type === "blast_barrel") {
      const pulse = 0.5 + 0.5 * Math.sin(phase * 1.4);
      const bodyMat = visual.pulseMaterials[0];
      const coreMat = visual.pulseMaterials[1];
      if (bodyMat) {
        bodyMat.emissiveIntensity = 0.3 + pulse * 0.55;
      }
      if (coreMat) {
        coreMat.emissiveIntensity = 1.0 + pulse * 1.1;
      }
      if (visual.warningRing) {
        const ringScale = 0.92 + pulse * 0.24;
        visual.warningRing.scale.set(ringScale, ringScale, 1);
      }
      if (visual.glowHalo) {
        const base = visual.glowBaseScale ?? 1.35;
        const s = base * (0.88 + pulse * 0.28);
        visual.glowHalo.scale.set(s, s, 1);
        visual.glowHalo.material.opacity = 0.48 + pulse * 0.36;
      }
      this.pulseGroundPool(visual, pulse);
      return;
    }

    if (visual.type === "spark_mine") {
      const pulse = 0.5 + 0.5 * Math.sin(phase * 2.1);
      const coreMat = visual.pulseMaterials[0];
      const prongMat = visual.pulseMaterials[1];
      if (coreMat) {
        coreMat.emissiveIntensity = 1.15 + pulse * 1.35;
      }
      if (prongMat) {
        prongMat.emissiveIntensity = 0.45 + pulse * 0.75;
      }
      if (visual.warningRing) {
        const ringScale = 0.9 + pulse * 0.28;
        visual.warningRing.scale.set(ringScale, ringScale, 1);
      }
      if (visual.glowHalo) {
        const base = visual.glowBaseScale ?? 1.18;
        const s = base * (0.84 + pulse * 0.38);
        visual.glowHalo.scale.set(s, s, 1);
        visual.glowHalo.material.opacity = 0.44 + pulse * 0.46;
      }
      this.pulseGroundPool(visual, pulse);
      return;
    }

    if (visual.type === "steam_geyser") {
      const pulse = 0.5 + 0.5 * Math.sin(phase);
      const poolMat = visual.pulseMaterials[0];
      if (poolMat) {
        poolMat.emissiveIntensity = 0.95 + Math.sin(phase) * 0.35;
      }
      if (visual.glowHalo) {
        const base = visual.glowBaseScale ?? 1.85;
        const s = base * (0.92 + pulse * 0.18);
        visual.glowHalo.scale.set(s, s, 1);
        visual.glowHalo.material.opacity = 0.34 + pulse * 0.22;
      }
      this.pulseGroundPool(visual, pulse);
      if (visual.steamPuffs) {
        const count = visual.steamPuffs.length;
        for (let i = 0; i < count; i++) {
          const puff = visual.steamPuffs[i];
          if (!puff) continue;
          const cycle = (elapsedSec * 0.75 + i / count + visual.phaseOffset * 0.1) % 1;
          const swirlAngle = cycle * Math.PI * 2 + i * 1.7;
          const spread = cycle * 0.34;
          puff.position.set(
            Math.cos(swirlAngle) * spread,
            0.42 + cycle * 2.55,
            Math.sin(swirlAngle) * spread,
          );
          const s = 0.45 + cycle * 1.15;
          puff.scale.setScalar(s);
          if (puff.material instanceof THREE.MeshBasicMaterial) {
            puff.material.opacity = Math.sin(cycle * Math.PI) * 0.58;
          }
        }
      }
      return;
    }

    const sporePulse = 0.5 + 0.5 * Math.sin(phase * 1.15);
    const sporeMat = visual.pulseMaterials[0];
    if (sporeMat) {
      sporeMat.emissiveIntensity = 0.85 + Math.sin(phase * 1.15) * 0.55;
    }
    if (visual.glowHalo) {
      const base = visual.glowBaseScale ?? 1.72;
      const s = base * (0.9 + sporePulse * 0.22);
      visual.glowHalo.scale.set(s, s, 1);
      visual.glowHalo.material.opacity = 0.34 + sporePulse * 0.28;
    }
    this.pulseGroundPool(visual, sporePulse);
  }
}
