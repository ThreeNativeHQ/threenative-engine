#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));

export function absoluteErrorRatio(rawValue, pixels, imageMagickVersion) {
  const value = Number.parseFloat(rawValue);
  if (!Number.isFinite(value) || !Number.isFinite(pixels) || pixels <= 0) return Number.NaN;
  if (value <= pixels) return value / pixels;
  const quantumBits = Number.parseInt(/\bQ(\d+)\b/u.exec(imageMagickVersion)?.[1] ?? "", 10);
  if (!Number.isInteger(quantumBits) || quantumBits < 8 || quantumBits > 32) return Number.NaN;
  return value / (2 ** quantumBits - 1) / pixels;
}

export function inspectCapture(contents, options = {}) {
  let png;
  try {
    png = PNG.sync.read(contents);
  } catch (error) {
    throw new Error(
      `capture is not a readable PNG: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (png.width <= 0 || png.height <= 0) throw new Error("capture has invalid dimensions");
  const first = png.data.subarray(0, 4);
  let uniform = true;
  let opaquePixels = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (png.data[offset + 3] > 0) opaquePixels += 1;
    if (
      png.data[offset] !== first[0] ||
      png.data[offset + 1] !== first[1] ||
      png.data[offset + 2] !== first[2] ||
      png.data[offset + 3] !== first[3]
    ) {
      uniform = false;
    }
  }
  if (opaquePixels === 0) throw new Error("capture is blank: it has no opaque pixels");
  if (uniform && options.allowUniform !== true) {
    throw new Error("capture is uniform: expected more than one RGBA color");
  }
  return { width: png.width, height: png.height, opaquePixels, uniform, png };
}

function linearChannel(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function lab(r, g, b) {
  const red = linearChannel(r);
  const green = linearChannel(g);
  const blue = linearChannel(b);
  const x = (red * 0.4124 + green * 0.3576 + blue * 0.1805) / 0.95047;
  const y = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const z = (red * 0.0193 + green * 0.1192 + blue * 0.9505) / 1.08883;
  const transform = (value) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
  const fx = transform(x);
  const fy = transform(y);
  const fz = transform(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function compareCaptures(referenceContents, candidateContents, levels = 0) {
  const reference = inspectCapture(referenceContents);
  const candidate = inspectCapture(candidateContents);
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `capture dimensions differ: reference=${reference.width}x${reference.height} candidate=${candidate.width}x${candidate.height}`,
    );
  }
  const pixels = reference.width * reference.height;
  // A reference with no alpha channel (an element screenshot) records only displayed colour, so
  // alpha is not compared: pngjs would report 255 there whatever the frame held.
  const channels = reference.png.alpha === false ? 3 : 4;
  let mismatched = 0;
  let deltaESum = 0;
  for (let offset = 0; offset < reference.png.data.length; offset += 4) {
    const different = reference.png.data
      .subarray(offset, offset + channels)
      .some((value, channel) => Math.abs(value - candidate.png.data[offset + channel]) > levels);
    if (different) mismatched += 1;
    const left = lab(...reference.png.data.subarray(offset, offset + 3));
    const right = lab(...candidate.png.data.subarray(offset, offset + 3));
    deltaESum += Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
  }
  return {
    pixelMismatchRatio: mismatched / pixels,
    perceptualDeltaE: deltaESum / pixels,
    width: reference.width,
    height: reference.height,
  };
}

export const SCREEN_SPACE_GLYPH_BRIGHT_FLOOR = 1_000;
export const SCREEN_SPACE_GLYPH_BOUNDS_TOLERANCE = 1;

export function inspectScreenSpaceGlyphs(contents) {
  const { png, width, height } = inspectCapture(contents);
  let brightPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue, alpha] = png.data.subarray(offset, offset + 4);
      if (red < 180 || green < 160 || blue > 160 || alpha === 0) continue;
      brightPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (brightPixels < SCREEN_SPACE_GLYPH_BRIGHT_FLOOR) {
    throw new Error(
      `screen-space glyph raster has ${brightPixels} bright pixels; expected at least ${SCREEN_SPACE_GLYPH_BRIGHT_FLOOR}`,
    );
  }
  return { brightPixels, bounds: [minX, minY, maxX, maxY] };
}

export function compareScreenSpaceGlyphs(referenceContents, candidateContents) {
  const reference = inspectScreenSpaceGlyphs(referenceContents);
  const candidate = inspectScreenSpaceGlyphs(candidateContents);
  const boundsDelta = reference.bounds.map((value, index) =>
    Math.abs(value - candidate.bounds[index]),
  );
  if (boundsDelta.some((value) => value > SCREEN_SPACE_GLYPH_BOUNDS_TOLERANCE)) {
    throw new Error(
      `screen-space glyph bounds drift ${boundsDelta.join(",")} exceeds ${SCREEN_SPACE_GLYPH_BOUNDS_TOLERANCE}px`,
    );
  }
  return {
    brightFloor: SCREEN_SPACE_GLYPH_BRIGHT_FLOOR,
    boundsTolerance: SCREEN_SPACE_GLYPH_BOUNDS_TOLERANCE,
    boundsDelta,
    reference,
    candidate,
  };
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function resolveFromRuntime(path) {
  return isAbsolute(path) ? path : resolve(runtimeRoot, path);
}

export function compareDirectories({ reference, candidate, registry }) {
  const results = [];
  for (const test of registry.tests) {
    if (test.status !== "implemented") {
      results.push({
        id: test.id,
        status: "blocked",
        blockedReason: "Registry row is not implemented.",
      });
      continue;
    }
    const referencePath = join(reference, `${test.id}.png`);
    const candidatePath = join(candidate, `${test.id}.png`);
    if (!existsSync(referencePath) || !existsSync(candidatePath)) {
      const missing = [referencePath, candidatePath].filter((path) => !existsSync(path));
      results.push({
        id: test.id,
        status: "blocked",
        blockedReason: `Missing capture: ${missing.join(", ")}`,
      });
      continue;
    }
    try {
      const metrics = compareCaptures(readFileSync(referencePath), readFileSync(candidatePath));
      const pass =
        metrics.pixelMismatchRatio <= test.tolerance.pixelMismatchRatio &&
        metrics.perceptualDeltaE <= test.tolerance.perceptualDeltaE;
      results.push({
        id: test.id,
        status: pass ? "pass" : "fail",
        metrics,
        tolerance: test.tolerance,
        ...(pass ? {} : { failureReason: "Capture metrics exceeded the registry tolerance." }),
      });
    } catch (error) {
      results.push({
        id: test.id,
        status: "fail",
        failureReason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    schemaVersion: 1,
    target: candidate.split(/[\\/]/).filter(Boolean).at(-1) || "candidate",
    summary: {
      pass: results.filter(({ status }) => status === "pass").length,
      fail: results.filter(({ status }) => status === "fail").length,
      blocked: results.filter(({ status }) => status === "blocked").length,
    },
    results,
  };
}

async function main(argv = process.argv.slice(2)) {
  const referenceArg = valueAfter(argv, "--reference");
  const candidateArg = valueAfter(argv, "--candidate");
  if (!referenceArg || !candidateArg) {
    throw new Error(
      "Usage: metrics.mjs --reference DIR --candidate DIR [--registry PATH] [--out PATH]",
    );
  }
  const registryArg = valueAfter(argv, "--registry") || "conformance/registry.json";
  const registry = JSON.parse(readFileSync(resolveFromRuntime(registryArg), "utf8"));
  const verdict = compareDirectories({
    reference: resolveFromRuntime(referenceArg),
    candidate: resolveFromRuntime(candidateArg),
    registry,
  });
  const outArg = valueAfter(argv, "--out");
  if (outArg) {
    const out = resolveFromRuntime(outArg);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(verdict, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exitCode = verdict.summary.fail > 0 ? 1 : verdict.summary.blocked > 0 ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
