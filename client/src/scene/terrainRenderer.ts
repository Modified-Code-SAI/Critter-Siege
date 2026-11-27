import * as THREE from "three";
import {
  chunkKey,
  meshChunkSurfaceNets,
  type SdfWorld,
} from "@critter/shared";

const UV_SCALE = 0.24;
const PAINT_TEX_SIZE = 512;
const HEADLESS_TEX_SIZE = 64;
const STRATA_BAND_COUNT = 8;

function parseChunkKey(
  key: string,
): { cx: number; cy: number; cz: number } | null {
  const parts = key.split(",");
  if (parts.length !== 3) {
    return null;
  }
  const cx = Number(parts[0]);
  const cy = Number(parts[1]);
  const cz = Number(parts[2]);
  if (!Number.isInteger(cx) || !Number.isInteger(cy) || !Number.isInteger(cz)) {
    return null;
  }
  return { cx, cy, cz };
}

/** Deterministic Mulberry32 PRNG for reproducible seamless hand-painted textures. */
function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw a canvas shape with automatic 3x3 periodic wrapping so 512x512 tiles stay 100% seamless. */
function drawTiled(
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

/** Deterministic seamless 2D periodic micro-noise in [0, 1] for crisp tileable terrain textures. */
function samplePeriodicDetail(u: number, v: number, seedOffset: number): number {
  const tau = Math.PI * 2;
  const a = u * tau;
  const b = v * tau;

  // Stratified horizontal sedimentary bands + fine organic pebble & grass-blade grain
  const strata =
    Math.sin(b * 4 + Math.sin(a * 2 + seedOffset) * 0.55) * 0.22 +
    Math.sin(b * 10 - Math.cos(a * 3 - seedOffset) * 0.4) * 0.14;
  const organic =
    Math.sin(a * 6 + b * 5 + seedOffset) * Math.cos(a * 5 - b * 7) * 0.24 +
    Math.sin(a * 13 - b * 11 + seedOffset * 1.7) * 0.14 +
    Math.cos(a * 21 + b * 19 - seedOffset * 0.9) * 0.1;

  // Crisp micro-speckle hash (periodic in [0..1])
  const ix = Math.floor(u * 64) & 63;
  const iy = Math.floor(v * 64) & 63;
  const h =
    Math.sin(ix * 127.1 + iy * 311.7 + seedOffset * 74.7) * 43758.5453123;
  const grain = (h - Math.floor(h) - 0.5) * 0.22;

  return Math.max(0, Math.min(1, 0.5 + strata + organic + grain));
}

/** Seamless horizontal sedimentary strata seam Y position (in pixels) for band index `band`. */
function sampleStrataSeamPx(band: number, u: number, size: number): number {
  const tau = Math.PI * 2;
  const wrappedBand = ((band % STRATA_BAND_COUNT) + STRATA_BAND_COUNT) % STRATA_BAND_COUNT;
  const baseY = (band / STRATA_BAND_COUNT) * size;
  const wave =
    Math.sin(u * tau * 2 + wrappedBand * 1.85) * (size * 0.013) +
    Math.cos(u * tau * 3 - wrappedBand * 2.35) * (size * 0.0065) +
    Math.sin(u * tau * 5 + wrappedBand * 0.9) * (size * 0.0028);
  return baseY + wave;
}

interface VerticalCrackSpec {
  band: number;
  uTop: number;
  uMid: number;
  uBot: number;
  width: number;
}

/** Generate staggered chiseled stone block joints shared between cliff albedo and bump relief. */
function buildCliffJointSpecs(rng: () => number): VerticalCrackSpec[] {
  const joints: VerticalCrackSpec[] = [];
  for (let band = 0; band < STRATA_BAND_COUNT; band++) {
    const blockCount = band % 2 === 0 ? 4 : 5;
    const stagger = (band % 2) * (0.5 / blockCount) + (band % 3) * 0.035;
    for (let j = 0; j < blockCount; j++) {
      const baseU = (j / blockCount + stagger + (rng() - 0.5) * 0.055 + 1) % 1;
      const driftA = (rng() - 0.5) * 0.022;
      const driftB = (rng() - 0.5) * 0.024;
      joints.push({
        band,
        uTop: baseU,
        uMid: baseU + driftA,
        uBot: baseU + driftB,
        width: 2.2 + rng() * 1.3,
      });
    }
  }
  return joints;
}

/** Bake a 512x512 seamless hand-painted storybook gouache grass texture with tufts and clover clusters. */
function paintGrassCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const size = canvas.width;
  const rng = createSeededRng(104729);

  // Neutral-lush gouache emerald base
  ctx.fillStyle = "#88bf78";
  ctx.fillRect(0, 0, size, size);

  // Layer 1: Broad organic sunlit yellow-green, mid-emerald, and cool teal-emerald washes
  const washColors: readonly string[] = [
    "#d8ec88",
    "#c2e082",
    "#88bf78",
    "#6da871",
    "#4a7d6c",
    "#558e72",
  ];
  for (let i = 0; i < 64; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const rx = 36 + rng() * 62;
    const ry = 22 + rng() * 44;
    const angle = rng() * Math.PI;
    const color = washColors[Math.floor(rng() * washColors.length)] ?? "#88bf78";
    const alpha = 0.2 + rng() * 0.2;
    const margin = Math.max(rx, ry) + 6;

    drawTiled(size, x, y, margin, (dx, dy) => {
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(angle);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  // Layer 2: Directional layered gouache brush dabs creating painterly meadow texture
  const dabColors: readonly string[] = [
    "#d8ec88",
    "#e1f19a",
    "#b0d878",
    "#88bf78",
    "#69a36f",
    "#4a7d6c",
    "#3f6f62",
  ];
  for (let i = 0; i < 230; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = 16 + rng() * 34;
    const wid = 6 + rng() * 12;
    const angle = (rng() - 0.5) * 1.15 - 0.25;
    const color = dabColors[Math.floor(rng() * dabColors.length)] ?? "#88bf78";
    const alpha = 0.28 + rng() * 0.26;
    const margin = len + 6;

    drawTiled(size, x, y, margin, (dx, dy) => {
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(angle);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(0, 0, len * 0.5, wid * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  // Layer 3: Crisp hand-painted grass-blade tufts with soft cool base shadows
  for (let i = 0; i < 210; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const blades = 3 + Math.floor(rng() * 3);
    const scale = 0.78 + rng() * 0.65;
    const isSunlit = rng() > 0.42;
    const bladeMain = isSunlit ? "#d8ec88" : "#9bd07c";
    const bladeTip = isSunlit ? "#edf8ae" : "#bce488";
    const margin = 24 * scale;

    drawTiled(size, x, y, margin, (dx, dy) => {
      ctx.save();
      ctx.translate(dx, dy);
      // Cool teal-green shadow pocket anchoring the tuft
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = "#3f6f60";
      ctx.beginPath();
      ctx.ellipse(0, 2 * scale, 7.5 * scale, 3.2 * scale, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.84;
      ctx.lineCap = "round";
      for (let b = 0; b < blades; b++) {
        const spread = (b - (blades - 1) * 0.5) * 4.4 * scale;
        const height = (9 + ((b * 7 + i) % 5) * 2.1) * scale;
        const lean = spread * 1.35 + (isSunlit ? 1.8 : -1.4) * scale;
        ctx.strokeStyle = b === 1 ? bladeTip : bladeMain;
        ctx.lineWidth = (2.1 - b * 0.15) * scale;
        ctx.beginPath();
        ctx.moveTo(spread * 0.4, 1.5 * scale);
        ctx.quadraticCurveTo(
          spread * 0.7 + lean * 0.35,
          -height * 0.55,
          lean,
          -height,
        );
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  // Layer 4: Tiny storybook clover leaf clusters & sunlit dew-petal accents
  for (let i = 0; i < 58; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const clusterScale = 0.8 + rng() * 0.55;
    const rot = rng() * Math.PI * 2;
    const hasAccentDot = rng() > 0.55;
    const margin = 16 * clusterScale;

    drawTiled(size, x, y, margin, (dx, dy) => {
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(rot);
      ctx.globalAlpha = 0.72;
      for (let leaf = 0; leaf < 3; leaf++) {
        const a = (leaf * Math.PI * 2) / 3;
        ctx.fillStyle = leaf === 0 ? "#a9da7e" : "#68a86d";
        ctx.beginPath();
        ctx.ellipse(
          Math.cos(a) * 3.8 * clusterScale,
          Math.sin(a) * 3.8 * clusterScale,
          3.4 * clusterScale,
          2.6 * clusterScale,
          a,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      if (hasAccentDot) {
        ctx.globalAlpha = 0.78;
        ctx.fillStyle = "#f4f6b8";
        ctx.beginPath();
        ctx.arc(0, 0, 1.7 * clusterScale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
  }

  ctx.globalAlpha = 1.0;
}

/** Bake 512x512 seamless carved sandstone / cliff strata albedo + matching relief bump & roughness maps. */
function paintCliffAndReliefCanvases(
  cliffCanvas: HTMLCanvasElement,
  bumpCanvas: HTMLCanvasElement,
  roughCanvas: HTMLCanvasElement,
): void {
  const cliffCtx = cliffCanvas.getContext("2d");
  const bumpCtx = bumpCanvas.getContext("2d");
  const roughCtx = roughCanvas.getContext("2d");
  if (!cliffCtx || !bumpCtx || !roughCtx) {
    return;
  }

  const size = cliffCanvas.width;
  const rng = createSeededRng(209713);
  const joints = buildCliffJointSpecs(rng);

  // 1. Seed base fine pebble/sandstone grain into bump & roughness pixel buffers
  const bumpImg = bumpCtx.createImageData(size, size);
  const roughImg = roughCtx.createImageData(size, size);
  for (let py = 0; py < size; py++) {
    const v = py / size;
    for (let px = 0; px < size; px++) {
      const u = px / size;
      const idx = (py * size + px) * 4;
      const h = samplePeriodicDetail(u, v, 1.3);
      const bumpByte = Math.round((0.52 + h * 0.34) * 255);
      bumpImg.data[idx] = bumpByte;
      bumpImg.data[idx + 1] = bumpByte;
      bumpImg.data[idx + 2] = bumpByte;
      bumpImg.data[idx + 3] = 255;

      const r = samplePeriodicDetail(u, v, 9.7);
      const roughByte = Math.round((0.68 + r * 0.24) * 255);
      roughImg.data[idx] = roughByte;
      roughImg.data[idx + 1] = roughByte;
      roughImg.data[idx + 2] = roughByte;
      roughImg.data[idx + 3] = 255;
    }
  }
  bumpCtx.putImageData(bumpImg, 0, 0);
  roughCtx.putImageData(roughImg, 0, 0);

  // 2. Fill hand-painted sedimentary rock strata bands across cliff albedo
  const strataPalette: readonly string[] = [
    "#d7a464",
    "#c47c4b",
    "#cf9458",
    "#a45a3a",
    "#dfb677",
    "#b56942",
    "#cc8b52",
    "#9d5437",
  ];
  const steps = 64;
  cliffCtx.fillStyle = "#c4814e";
  cliffCtx.fillRect(0, 0, size, size);

  for (let band = -1; band <= STRATA_BAND_COUNT; band++) {
    const color =
      strataPalette[
        ((band % strataPalette.length) + strataPalette.length) % strataPalette.length
      ] ?? "#c47c4b";

    cliffCtx.fillStyle = color;
    cliffCtx.beginPath();
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const x = u * size;
      const y = sampleStrataSeamPx(band, u, size);
      if (s === 0) {
        cliffCtx.moveTo(x, y);
      } else {
        cliffCtx.lineTo(x, y);
      }
    }
    for (let s = steps; s >= 0; s--) {
      const u = s / steps;
      const x = u * size;
      const y = sampleStrataSeamPx(band + 1, u, size);
      cliffCtx.lineTo(x, y);
    }
    cliffCtx.closePath();
    cliffCtx.fill();
  }

  // 3. Layered gouache stone brushstrokes & mineral flecks for illustrated depth
  const brushTones: readonly string[] = [
    "#e9c88c",
    "#d8a463",
    "#c17847",
    "#9f5536",
    "#824129",
    "#e3ba7c",
  ];
  for (let i = 0; i < 240; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const rx = 18 + rng() * 44;
    const ry = 4.5 + rng() * 11;
    const angle = (rng() - 0.5) * 0.24;
    const tone = brushTones[Math.floor(rng() * brushTones.length)] ?? "#c17847";
    const alpha = 0.16 + rng() * 0.22;
    const margin = rx + 6;

    drawTiled(size, x, y, margin, (dx, dy) => {
      cliffCtx.save();
      cliffCtx.translate(dx, dy);
      cliffCtx.rotate(angle);
      cliffCtx.globalAlpha = alpha;
      cliffCtx.fillStyle = tone;
      cliffCtx.beginPath();
      cliffCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      cliffCtx.fill();
      cliffCtx.restore();

      // Subtle painted gouache stone facet relief into bump map
      bumpCtx.save();
      bumpCtx.translate(dx, dy);
      bumpCtx.rotate(angle);
      bumpCtx.globalAlpha = 0.14;
      bumpCtx.fillStyle = i % 2 === 0 ? "#e8e8e8" : "#5e5e5e";
      bumpCtx.beginPath();
      bumpCtx.ellipse(0, 0, rx * 0.8, ry * 0.7, 0, 0, Math.PI * 2);
      bumpCtx.fill();
      bumpCtx.restore();
    });
  }

  // Helper to stroke a horizontal strata seam across all wrapped Y tiles
  const strokeHorizontalSeam = (
    ctx: CanvasRenderingContext2D,
    band: number,
    yOffsetPx: number,
    strokeStyle: string,
    lineWidth: number,
    alpha: number,
  ): void => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const x = u * size;
      const y = sampleStrataSeamPx(band, u, size) + yOffsetPx;
      if (s === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  };

  // 4. Horizontal strata seams: overhang shadow above + sunlit bevel highlight below + dark carved seam
  for (let band = -1; band <= STRATA_BAND_COUNT + 1; band++) {
    // Upper recessed ledge shadow
    strokeHorizontalSeam(cliffCtx, band, -4.2, "#6f3a24", 5.8, 0.42);
    // Crisp sunlit sandstone bevel highlight directly below each seam
    strokeHorizontalSeam(cliffCtx, band, 3.8, "#f2d69f", 3.6, 0.78);
    // Deep carved strata fissure line
    strokeHorizontalSeam(cliffCtx, band, 0, "#3b2016", 3.6, 0.92);

    // Matching carved relief in bumpMap (bright sunlit bevel below + deep carved groove on seam)
    strokeHorizontalSeam(bumpCtx, band, 4.2, "#fafafa", 4.6, 0.86);
    strokeHorizontalSeam(bumpCtx, band, -3.5, "#9c9c9c", 3.4, 0.45);
    strokeHorizontalSeam(bumpCtx, band, 0, "#121212", 4.8, 0.96);

    // Rougher matte crevices & slightly smoother sunlit sandstone bevels
    strokeHorizontalSeam(roughCtx, band, 4.0, "#a8a8a8", 3.6, 0.55);
    strokeHorizontalSeam(roughCtx, band, 0, "#f5f5f5", 5.0, 0.82);
  }

  // 5. Staggered vertical chiseled stone block cracks + sunlit bevel edge + T-junction fracture chips
  for (const joint of joints) {
    const drawJoint = (ox: number, oy: number): void => {
      const y0 = sampleStrataSeamPx(joint.band, joint.uTop, size) + oy;
      const y2 = sampleStrataSeamPx(joint.band + 1, joint.uBot, size) + oy;
      const y1 = (y0 + y2) * 0.5;
      const x0 = joint.uTop * size + ox;
      const x1 = joint.uMid * size + ox;
      const x2 = joint.uBot * size + ox;

      // Sunlit chiseled bevel beside the vertical crack
      cliffCtx.save();
      cliffCtx.strokeStyle = "#efd098";
      cliffCtx.lineWidth = joint.width * 0.95;
      cliffCtx.lineCap = "round";
      cliffCtx.globalAlpha = 0.68;
      cliffCtx.beginPath();
      cliffCtx.moveTo(x0 + 3.0, y0 + 2.0);
      cliffCtx.lineTo(x1 + 3.0, y1);
      cliffCtx.lineTo(x2 + 3.0, y2 - 2.0);
      cliffCtx.stroke();

      // Dark chiseled stone crack
      cliffCtx.strokeStyle = "#412418";
      cliffCtx.lineWidth = joint.width;
      cliffCtx.globalAlpha = 0.88;
      cliffCtx.beginPath();
      cliffCtx.moveTo(x0, y0);
      cliffCtx.lineTo(x1, y1);
      cliffCtx.lineTo(x2, y2);
      cliffCtx.stroke();

      // Subtle corner bevel chip at T-junction
      cliffCtx.fillStyle = "#3a1f14";
      cliffCtx.globalAlpha = 0.65;
      cliffCtx.beginPath();
      cliffCtx.arc(x0, y0, joint.width * 0.85, 0, Math.PI * 2);
      cliffCtx.fill();
      cliffCtx.restore();

      // Matching bump relief groove & raised bevel beside crack
      bumpCtx.save();
      bumpCtx.lineCap = "round";
      bumpCtx.strokeStyle = "#f4f4f4";
      bumpCtx.lineWidth = joint.width * 1.15;
      bumpCtx.globalAlpha = 0.78;
      bumpCtx.beginPath();
      bumpCtx.moveTo(x0 + 3.4, y0 + 2.0);
      bumpCtx.lineTo(x1 + 3.4, y1);
      bumpCtx.lineTo(x2 + 3.4, y2 - 2.0);
      bumpCtx.stroke();

      bumpCtx.strokeStyle = "#181818";
      bumpCtx.lineWidth = joint.width * 1.25;
      bumpCtx.globalAlpha = 0.94;
      bumpCtx.beginPath();
      bumpCtx.moveTo(x0, y0);
      bumpCtx.lineTo(x1, y1);
      bumpCtx.lineTo(x2, y2);
      bumpCtx.stroke();
      bumpCtx.restore();

      // Extra matte roughness inside carved crack
      roughCtx.save();
      roughCtx.strokeStyle = "#f2f2f2";
      roughCtx.lineWidth = joint.width * 1.3;
      roughCtx.globalAlpha = 0.75;
      roughCtx.beginPath();
      roughCtx.moveTo(x0, y0);
      roughCtx.lineTo(x1, y1);
      roughCtx.lineTo(x2, y2);
      roughCtx.stroke();
      roughCtx.restore();
    };

    const yOffsets = [0];
    if (joint.band === 0) {
      yOffsets.push(size);
    } else if (joint.band === STRATA_BAND_COUNT - 1) {
      yOffsets.push(-size);
    }
    const xOffsets = [0];
    if (joint.uTop < 0.08 || joint.uMid < 0.08 || joint.uBot < 0.08) {
      xOffsets.push(size);
    }
    if (joint.uTop > 0.92 || joint.uMid > 0.92 || joint.uBot > 0.92) {
      xOffsets.push(-size);
    }

    for (const ox of xOffsets) {
      for (const oy of yOffsets) {
        drawJoint(ox, oy);
      }
    }
  }

  cliffCtx.globalAlpha = 1.0;
  bumpCtx.globalAlpha = 1.0;
  roughCtx.globalAlpha = 1.0;
}

function createProceduralDetailTextures(): {
  grassPaintTexture: THREE.Texture;
  cliffPaintTexture: THREE.Texture;
  bumpTexture: THREE.Texture;
  roughnessTexture: THREE.Texture;
} {
  const configure = (tex: THREE.Texture, isSrgb: boolean): THREE.Texture => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 1);
    tex.anisotropy = 4;
    if (isSrgb) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    tex.needsUpdate = true;
    return tex;
  };

  if (typeof document !== "undefined") {
    const grassCanvas = document.createElement("canvas");
    grassCanvas.width = PAINT_TEX_SIZE;
    grassCanvas.height = PAINT_TEX_SIZE;

    const cliffCanvas = document.createElement("canvas");
    cliffCanvas.width = PAINT_TEX_SIZE;
    cliffCanvas.height = PAINT_TEX_SIZE;

    const bumpCanvas = document.createElement("canvas");
    bumpCanvas.width = PAINT_TEX_SIZE;
    bumpCanvas.height = PAINT_TEX_SIZE;

    const roughCanvas = document.createElement("canvas");
    roughCanvas.width = PAINT_TEX_SIZE;
    roughCanvas.height = PAINT_TEX_SIZE;

    const has2d =
      grassCanvas.getContext("2d") !== null &&
      cliffCanvas.getContext("2d") !== null &&
      bumpCanvas.getContext("2d") !== null &&
      roughCanvas.getContext("2d") !== null;

    if (has2d) {
      paintGrassCanvas(grassCanvas);
      paintCliffAndReliefCanvases(cliffCanvas, bumpCanvas, roughCanvas);

      return {
        grassPaintTexture: configure(new THREE.CanvasTexture(grassCanvas), true),
        cliffPaintTexture: configure(new THREE.CanvasTexture(cliffCanvas), true),
        bumpTexture: configure(new THREE.CanvasTexture(bumpCanvas), false),
        roughnessTexture: configure(new THREE.CanvasTexture(roughCanvas), false),
      };
    }
  }

  // Headless Node / Vitest fallback using compact deterministic 64x64 DataTextures
  const size = HEADLESS_TEX_SIZE;
  const grassData = new Uint8Array(size * size * 4);
  const cliffData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py++) {
    const v = py / size;
    for (let px = 0; px < size; px++) {
      const u = px / size;
      const idx = (py * size + px) * 4;

      const grassDab = samplePeriodicDetail(u, v, 3.1);
      grassData[idx] = Math.round((0.36 + grassDab * 0.48) * 255);
      grassData[idx + 1] = Math.round((0.52 + grassDab * 0.4) * 255);
      grassData[idx + 2] = Math.round((0.42 + (1 - grassDab) * 0.16) * 255);
      grassData[idx + 3] = 255;

      const strataBand = (v * STRATA_BAND_COUNT) % 1;
      const isSeam = strataBand < 0.08 || strataBand > 0.94;
      const cliffDab = samplePeriodicDetail(u, v, 6.4);
      const seamMult = isSeam ? 0.36 : 0.85 + cliffDab * 0.25;
      cliffData[idx] = Math.round(Math.min(1, 0.82 * seamMult) * 255);
      cliffData[idx + 1] = Math.round(Math.min(1, 0.54 * seamMult) * 255);
      cliffData[idx + 2] = Math.round(Math.min(1, 0.34 * seamMult) * 255);
      cliffData[idx + 3] = 255;

      const h = samplePeriodicDetail(u, v, 1.3);
      const bumpVal = isSeam ? 0.12 : 0.5 + h * 0.42;
      const bumpByte = Math.round(bumpVal * 255);
      bumpData[idx] = bumpByte;
      bumpData[idx + 1] = bumpByte;
      bumpData[idx + 2] = bumpByte;
      bumpData[idx + 3] = 255;

      const roughByte = Math.round(
        (0.68 + samplePeriodicDetail(u, v, 9.7) * 0.28) * 255,
      );
      roughData[idx] = roughByte;
      roughData[idx + 1] = roughByte;
      roughData[idx + 2] = roughByte;
      roughData[idx + 3] = 255;
    }
  }

  return {
    grassPaintTexture: configure(
      new THREE.DataTexture(grassData, size, size),
      true,
    ),
    cliffPaintTexture: configure(
      new THREE.DataTexture(cliffData, size, size),
      true,
    ),
    bumpTexture: configure(new THREE.DataTexture(bumpData, size, size), false),
    roughnessTexture: configure(
      new THREE.DataTexture(roughData, size, size),
      false,
    ),
  };
}

/**
 * Compute world-space box-projected (triplanar-style) UVs from vertex positions & normals
 * so flat grass hilltops and steep sandstone cliffs both display crisp zero-stretch micro-detail.
 */
function buildBoxProjectedUvs(
  positions: Float32Array,
  normals: Float32Array,
): Float32Array {
  const vertCount = positions.length / 3;
  const uvs = new Float32Array(vertCount * 2);

  for (let i = 0; i < vertCount; i++) {
    const px = positions[i * 3] ?? 0;
    const py = positions[i * 3 + 1] ?? 0;
    const pz = positions[i * 3 + 2] ?? 0;

    const ax = Math.abs(normals[i * 3] ?? 0);
    const ay = Math.abs(normals[i * 3 + 1] ?? 1);
    const az = Math.abs(normals[i * 3 + 2] ?? 0);

    if (ay >= ax && ay >= az) {
      uvs[i * 2] = px * UV_SCALE;
      uvs[i * 2 + 1] = pz * UV_SCALE;
    } else if (ax >= az) {
      uvs[i * 2] = pz * UV_SCALE;
      uvs[i * 2 + 1] = py * UV_SCALE;
    } else {
      uvs[i * 2] = px * UV_SCALE;
      uvs[i * 2 + 1] = py * UV_SCALE;
    }
  }

  return uvs;
}

const DEFAULT_WATER_LEVEL = 2.0;
const DEFAULT_SUN_DIR = new THREE.Vector3(1.25, 1.65, 0.95).normalize();

/**
 * Chunked Three.js Surface Nets renderer for sculpted Critter Siege SDF islands.
 * Uses hand-painted storybook gouache grass & carved sandstone triplanar textures,
 * scalloped mossy cliff-lip overhangs, warm-vs-cool stylized shadow contrast, and
 * wet shoreline shading via MeshStandardMaterial onBeforeCompile with strict GPU disposal.
 */
export class TerrainRenderer {
  public readonly group: THREE.Group;

  private readonly grassPaintTexture: THREE.Texture;
  private readonly cliffPaintTexture: THREE.Texture;
  private readonly bumpTexture: THREE.Texture;
  private readonly roughnessTexture: THREE.Texture;
  private readonly grassPaintUniform: { value: THREE.Texture };
  private readonly cliffPaintUniform: { value: THREE.Texture };
  private readonly waterLevelUniform: { value: number } = {
    value: DEFAULT_WATER_LEVEL,
  };
  private readonly sunDirUniform: { value: THREE.Vector3 } = {
    value: DEFAULT_SUN_DIR.clone(),
  };
  private readonly material: THREE.MeshStandardMaterial;
  private readonly chunkMeshes: Map<string, THREE.Mesh> = new Map();

  public constructor(world: SdfWorld) {
    this.group = new THREE.Group();
    this.group.name = "terrain_chunks";

    const textures = createProceduralDetailTextures();
    this.grassPaintTexture = textures.grassPaintTexture;
    this.cliffPaintTexture = textures.cliffPaintTexture;
    this.bumpTexture = textures.bumpTexture;
    this.roughnessTexture = textures.roughnessTexture;
    this.grassPaintUniform = { value: this.grassPaintTexture };
    this.cliffPaintUniform = { value: this.cliffPaintTexture };

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      roughnessMap: this.roughnessTexture,
      bumpMap: this.bumpTexture,
      bumpScale: 0.22,
      metalness: 0.04,
      envMapIntensity: 0.42,
    });
    this.material.customProgramCacheKey = (): string =>
      "critter_terrain_triplanar_v1";
    this.material.onBeforeCompile = (shader): void => {
      shader.uniforms.uGrassPaintMap = this.grassPaintUniform;
      shader.uniforms.uCliffPaintMap = this.cliffPaintUniform;
      shader.uniforms.uWaterLevel = this.waterLevelUniform;
      shader.uniforms.uSunDir = this.sunDirUniform;

      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vTerrainWorldPos;
varying vec3 vTerrainWorldNormal;`,
        )
        .replace(
          "#include <worldpos_vertex>",
          `#include <worldpos_vertex>
vec4 terrainWorldPos4 = modelMatrix * vec4( transformed, 1.0 );
vTerrainWorldPos = terrainWorldPos4.xyz;
vTerrainWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
uniform sampler2D uGrassPaintMap;
uniform sampler2D uCliffPaintMap;
uniform float uWaterLevel;
uniform vec3 uSunDir;
varying vec3 vTerrainWorldPos;
varying vec3 vTerrainWorldNormal;`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
vec3 triN = normalize( vTerrainWorldNormal );
vec3 triW = pow( max( abs( triN ), vec3( 0.001 ) ), vec3( 4.0 ) );
triW /= max( triW.x + triW.y + triW.z, 0.0001 );
float triScale = 0.16;
vec2 triUvX = vTerrainWorldPos.zy * triScale;
vec2 triUvY = vTerrainWorldPos.xz * triScale;
vec2 triUvZ = vTerrainWorldPos.xy * triScale;

#ifdef USE_BUMPMAP
  float triH_X = texture2D( bumpMap, triUvX ).x;
  float triH_Y = texture2D( bumpMap, triUvY ).x;
  float triH_Z = texture2D( bumpMap, triUvZ ).x;
  float triHeight = triH_X * triW.x + triH_Y * triW.y + triH_Z * triW.z;
#else
  float triHeight = 0.5;
#endif

// Hand-painted storybook gouache grass & triplanar carved sandstone cliff textures
vec3 grassPaint = texture2D( uGrassPaintMap, triUvY ).rgb;
vec3 cliffPaintX = texture2D( uCliffPaintMap, triUvX ).rgb;
vec3 cliffPaintZ = texture2D( uCliffPaintMap, triUvZ ).rgb;
vec3 cliffPaintY = texture2D( uCliffPaintMap, triUvY ).rgb;
float wallWeightSum = max( triW.x + triW.z, 0.0001 );
vec3 cliffWallPaint = ( cliffPaintX * triW.x + cliffPaintZ * triW.z ) / wallWeightSum;
vec3 cliffPaint = mix( cliffWallPaint, cliffPaintY, triW.y * 0.45 );

// Preserve raw vertex luminance before richness curve to detect snow caps & scorched craters
vec3 rawVertexCol = diffuseColor.rgb;
float rawVertexLum = dot( rawVertexCol, vec3( 0.299, 0.587, 0.114 ) );
float snowMask = smoothstep( 0.78, 0.90, min( rawVertexCol.r, min( rawVertexCol.g, rawVertexCol.b ) ) )
  * smoothstep( 0.45, 0.68, triN.y );

// Scalloped mossy cliff-lip overhang where lush meadow turf drips over sandstone walls
float aboveShore = smoothstep( uWaterLevel + 0.9, uWaterLevel + 1.8, vTerrainWorldPos.y );
float lipWave =
  sin( vTerrainWorldPos.x * 0.85 ) * cos( vTerrainWorldPos.z * 0.85 ) * 0.135 +
  sin( ( vTerrainWorldPos.x + vTerrainWorldPos.z ) * 1.65 ) * 0.045;
float scallopedNy = triN.y + lipWave * aboveShore;
float grassMask = smoothstep( 0.44, 0.66, scallopedNy ) * aboveShore;
float cliffMask = clamp( 1.0 - grassMask, 0.0, 1.0 );
float mossLipMask =
  smoothstep( 0.36, 0.49, scallopedNy ) *
  ( 1.0 - smoothstep( 0.52, 0.68, scallopedNy ) ) *
  aboveShore *
  ( 1.0 - snowMask );
float lipShadowMask =
  smoothstep( 0.16, 0.34, scallopedNy ) *
  ( 1.0 - smoothstep( 0.36, 0.50, scallopedNy ) ) *
  aboveShore;

// Stylized sRGB-to-linear richness curve: deepens mint -> lush emerald & tan -> warm terracotta
diffuseColor.rgb = pow( max( diffuseColor.rgb, vec3( 0.001 ) ), vec3( 1.44 ) );

// Painterly meadow gouache + world-space dappled warm-sunlit vs cool-teal shadow wave
float dappleWave =
  sin( vTerrainWorldPos.x * 0.22 + sin( vTerrainWorldPos.z * 0.18 ) * 1.35 ) *
  cos( vTerrainWorldPos.z * 0.21 - cos( vTerrainWorldPos.x * 0.16 ) * 1.15 );
float sunDapple = smoothstep( -0.68, 0.72, dappleWave );
vec3 dappleTint = mix( vec3( 0.80, 0.92, 0.98 ), vec3( 1.12, 1.08, 0.84 ), sunDapple );
vec3 grassPaintFactor = clamp( grassPaint / vec3( 0.30, 0.45, 0.21 ), 0.45, 1.68 );
vec3 paintedGrassCol = diffuseColor.rgb * mix( vec3( 1.0 ), grassPaintFactor, 0.64 ) * dappleTint;
paintedGrassCol = mix( paintedGrassCol, grassPaint * 1.12 * dappleTint, 0.22 * ( 1.0 - snowMask ) );
paintedGrassCol = mix( paintedGrassCol, diffuseColor.rgb * ( 0.92 + triHeight * 0.16 ), snowMask * 0.85 );

// Painterly carved sandstone / cliff blocks & fissures (respects scorched craters & alpine biomes)
float cliffPaintLum = dot( cliffPaint, vec3( 0.299, 0.587, 0.114 ) );
float cliffRelief = clamp( cliffPaintLum / 0.30, 0.24, 1.48 );
vec3 cliffChroma = clamp( ( cliffPaint / max( cliffPaintLum, 0.02 ) ) * 0.52 + 0.48, 0.60, 1.42 );
float unscorchedMask = smoothstep( 0.18, 0.40, rawVertexLum );
vec3 paintedCliffCol = diffuseColor.rgb * cliffRelief * mix( vec3( 1.0 ), cliffChroma, 0.55 * unscorchedMask );
paintedCliffCol = mix( paintedCliffCol, cliffPaint * 1.18, 0.24 * unscorchedMask * ( 1.0 - snowMask ) );

diffuseColor.rgb = mix( paintedCliffCol, paintedGrassCol, grassMask );

// Scalloped mossy lip accent + crisp cool overhang shadow band tucked right below the grass rim
diffuseColor.rgb = mix(
  diffuseColor.rgb,
  paintedGrassCol * vec3( 0.86, 1.06, 0.78 ),
  mossLipMask * 0.55
);
diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.68, 0.74, 0.84 ), lipShadowMask * 0.74 );
diffuseColor.rgb += vec3( 0.04, 0.05, 0.06 ) * snowMask * ( triHeight - 0.35 );

// Warm-vs-cool stylized shadow contrast: cool teal-indigo crevices & overhangs vs golden sunlit crests
vec3 sunDirN = normalize( uSunDir );
float sunFacing = clamp( dot( triN, sunDirN ), 0.0, 1.0 );
float overhangCool = clamp( smoothstep( 0.24, -0.32, triN.y ) + ( 1.0 - sunFacing ) * 0.42, 0.0, 1.0 );
float creviceCool = smoothstep( 0.52, 0.20, rawVertexLum );
float coolShadowWeight = clamp( max( overhangCool * 0.72, creviceCool * 0.65 ), 0.0, 1.0 );
diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.76, 0.88, 1.04 ), coolShadowWeight * 0.72 );
float sunlitCrest = grassMask * smoothstep( 0.34, 0.90, sunFacing ) * ( 1.0 - snowMask * 0.6 );
diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.06, 1.04, 0.90 ), sunlitCrest );

// Wet coastal shoreline band (uWaterLevel - 0.35 .. uWaterLevel + 0.95) darkens rock ~22%
float wetBand =
  smoothstep( uWaterLevel - 0.35, uWaterLevel + 0.05, vTerrainWorldPos.y ) *
  ( 1.0 - smoothstep( uWaterLevel + 0.25, uWaterLevel + 0.95, vTerrainWorldPos.y ) );
float submergedWet = 1.0 - smoothstep( uWaterLevel - 0.35, uWaterLevel + 0.05, vTerrainWorldPos.y );
float wetness = clamp( max( wetBand, submergedWet * 0.95 ), 0.0, 1.0 );
diffuseColor.rgb *= mix( 1.0, 0.78, wetness );`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  float triR_X = texture2D( roughnessMap, triUvX ).g;
  float triR_Y = texture2D( roughnessMap, triUvY ).g;
  float triR_Z = texture2D( roughnessMap, triUvZ ).g;
  float triRough = triR_X * triW.x + triR_Y * triW.y + triR_Z * triW.z;
#else
  float triRough = 0.85;
#endif
float biomeRough = mix( 0.76 + triRough * 0.14, 0.90 + ( triRough - 0.5 ) * 0.06, grassMask );
biomeRough = mix( biomeRough, 0.62 + triRough * 0.10, snowMask );
roughnessFactor = clamp( mix( biomeRough, 0.26, wetness ), 0.18, 0.98 );`,
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#ifdef USE_BUMPMAP
  float triBumpStrength = mix( bumpScale, bumpScale * 0.45, wetness ) * 1.55;
  vec2 triGrad = vec2( dFdx( triHeight ), dFdy( triHeight ) ) * triBumpStrength;
  normal = perturbNormalArb( - vViewPosition, normal, triGrad, faceDirection );
#endif`,
        );
    };
    this.rebuildAll(world);
  }

  /** Update the dynamic water height driving the glossy darkened wet-shoreline shader band. */
  public setWaterLevel(y: number): void {
    if (!Number.isFinite(y)) {
      return;
    }
    this.waterLevelUniform.value = y;
  }

  /** Update the normalized directional sunlight vector driving warm crest vs cool overhang tinting. */
  public setSunDirection(dir: THREE.Vector3): void {
    if (
      !Number.isFinite(dir.x) ||
      !Number.isFinite(dir.y) ||
      !Number.isFinite(dir.z)
    ) {
      return;
    }
    if (dir.lengthSq() < 1e-6) {
      return;
    }
    this.sunDirUniform.value.copy(dir).normalize();
  }

  /** Rebuild only the specified dirty chunk keys, disposing replaced BufferGeometries. */
  public rebuildChunks(world: SdfWorld, dirtyKeys: readonly string[]): void {
    const uniqueKeys = new Set<string>(dirtyKeys);
    for (const key of uniqueKeys) {
      const coord = parseChunkKey(key);
      if (!coord) {
        continue;
      }
      this.rebuildSingleChunk(world, coord.cx, coord.cy, coord.cz);
    }
  }

  /** Dispose all existing chunk geometries and mesh every chunk of the SDF world. */
  public rebuildAll(world: SdfWorld): void {
    this.clearAllChunks();
    for (const coord of world.getAllChunkCoords()) {
      this.rebuildSingleChunk(world, coord.cx, coord.cy, coord.cz);
    }
  }

  /** Dispose all chunk geometries, procedural textures, and the shared terrain material. */
  public dispose(): void {
    this.clearAllChunks();
    this.grassPaintTexture.dispose();
    this.cliffPaintTexture.dispose();
    this.bumpTexture.dispose();
    this.roughnessTexture.dispose();
    this.material.dispose();
  }

  private clearAllChunks(): void {
    for (const mesh of this.chunkMeshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.clear();
  }

  private rebuildSingleChunk(
    world: SdfWorld,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    const key = chunkKey(cx, cy, cz);
    const meshData = meshChunkSurfaceNets(world, cx, cy, cz);
    const existing = this.chunkMeshes.get(key);

    if (meshData.indices.length === 0 || meshData.positions.length === 0) {
      if (existing) {
        this.group.remove(existing);
        existing.geometry.dispose();
        this.chunkMeshes.delete(key);
      }
      return;
    }

    const uvs = buildBoxProjectedUvs(meshData.positions, meshData.normals);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(meshData.positions, 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(meshData.normals, 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(meshData.colors, 3),
    );
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geometry;
      return;
    }

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = `chunk_${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.chunkMeshes.set(key, mesh);
  }
}
