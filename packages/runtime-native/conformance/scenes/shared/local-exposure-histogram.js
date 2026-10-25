import { float, pass, texture, vec4 } from "three/tsl";
import { LocalExposureNode } from "../../../../core/src/look/local-exposure.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

const CELL = 64;
const BINS = 32;
const f32 = Math.fround;

// Independent original algorithm: each bin sums 64 samples per row, then 64 row totals.
// It does not interpret the packed intermediate texture or reuse the production TSL graph.
function referenceGrid(logs, width, height) {
  const cellsX = Math.ceil(width / CELL);
  const cellsY = Math.ceil(height / CELL);
  const result = new Float32Array(cellsX * cellsY * BINS * 2);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      for (let bin = 0; bin < BINS; bin++) {
        let sum = 0;
        let count = 0;
        for (let row = 0; row < CELL; row++) {
          let rowSum = 0;
          let rowCount = 0;
          for (let tap = 0; tap < CELL; tap++) {
            const x = cx * CELL + tap;
            const y = cy * CELL + row;
            if (x >= width || y >= height) continue;
            const log = logs[y * width + x];
            assertCondition(Number.isFinite(log), "local histogram log readback is nonfinite");
            const normalized = Math.min(1, Math.max(0, f32(f32(log + 10) / 30)));
            const position = f32(normalized * (BINS - 1));
            const weight = Math.max(0, f32(1 - Math.abs(f32(position - bin))));
            rowSum = f32(rowSum + f32(weight * log));
            rowCount = f32(rowCount + weight);
          }
          sum = f32(sum + rowSum);
          count = f32(count + rowCount);
        }
        const index = ((cy * cellsX + cx) * BINS + bin) * 2;
        result[index] = sum;
        result[index + 1] = count;
      }
    }
  }
  return result;
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "local-exposure-histogram", async ({ renderer, scene, camera }) => {
    pass(scene, camera);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const width = size.x;
    const height = size.y;
    assertCondition(width === 1280 && height === 720, "histogram fixture requires the real default drawing buffer");
    const halfWidth = Math.ceil(width / 2);
    const halfHeight = Math.ceil(height / 2);
    const logWidth = Math.ceil(halfWidth / 4);
    const cellsX = Math.ceil(halfWidth / CELL);
    const cellsY = Math.ceil(halfHeight / CELL);
    const logs = [-10, -8.9, -7.5, -6.25, -4.7, -2.9, -1.35, 0.15, 1.7, 3.2, 4.7, 6.35, 8.2, 10.6, 12.3, 14.4, 15.9];
    const pixels = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        const value = 2 ** logs[(Math.floor(x / 8) + Math.floor(y / 6) * 7) % logs.length];
        pixels.set([value * 0.5, value, value * 1.5, 1], index);
      }
    }
    const source = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
    source.colorSpace = THREE.NoColorSpace;
    source.minFilter = source.magFilter = THREE.NearestFilter;
    source.generateMipmaps = false;
    source.needsUpdate = true;
    const local = new LocalExposureNode(texture(source), float(1));
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = vec4(local.gainNode, local.gainNode, local.gainNode, 1);
    const targets = [];
    const setTarget = renderer.setRenderTarget;
    renderer.setRenderTarget = function (target, ...args) {
      if (target !== null && !targets.includes(target)) targets.push(target);
      return setTarget.call(this, target, ...args);
    };
    try {
      await pipeline.render();
      if (targets.length === 0) {
        renderer.render(scene, camera);
        await new Promise(requestAnimationFrame);
        await pipeline.render();
      }
    } finally {
      renderer.setRenderTarget = setTarget;
    }
    assertCondition(targets.length === 6, `expected six actual local-exposure producers, observed ${targets.length}`);
    const logTarget = targets[0];
    const gridTarget = targets[5];
    assertCondition(logTarget.width === logWidth && logTarget.height === halfHeight && logTarget.texture.type === THREE.FloatType, "actual log target size/type differs");
    assertCondition(gridTarget.width === cellsX * BINS && gridTarget.height === cellsY && gridTarget.texture.type === THREE.FloatType, "actual final histogram size/type differs");
    const packedLogs = await renderer.readRenderTargetPixelsAsync(logTarget, 0, 0, logWidth, halfHeight);
    const gridPixels = await renderer.readRenderTargetPixelsAsync(gridTarget, 0, 0, cellsX * BINS, cellsY);
    assertCondition(packedLogs instanceof Float32Array && packedLogs.length === logWidth * halfHeight * 4, "missing packed Float32 GPU log readback");
    // Restore the logical half-resolution rows from four adjacent luminances per RGBA texel.
    const logPixels = new Float32Array(halfWidth * halfHeight);
    for (let y = 0; y < halfHeight; y++)
      for (let x = 0; x < halfWidth; x++)
        logPixels[y * halfWidth + x] = packedLogs[(y * logWidth + Math.floor(x / 4)) * 4 + x % 4];
    assertCondition(gridPixels instanceof Float32Array && gridPixels.length === cellsX * BINS * cellsY * 4, "missing Float32 GPU histogram readback");
    const expected = referenceGrid(logPixels, halfWidth, halfHeight);
    let maxAbsoluteError = 0;
    let maxLogSumError = 0;
    let maxWeightError = 0;
    let maxConservationError = 0;
    const populatedBins = new Set();
    for (let cell = 0; cell < cellsX * cellsY; cell++) {
      let totalWeight = 0;
      for (let bin = 0; bin < BINS; bin++) {
        const texel = cell * BINS + bin;
        for (let channel = 0; channel < 4; channel++) {
          const actual = gridPixels[texel * 4 + channel];
          const referenceBin = channel < 2 ? bin : Math.min(bin + 1, BINS - 1);
          const reference = expected[(cell * BINS + referenceBin) * 2 + channel % 2];
          const error = Math.abs(actual - reference);
          // The historical unpacked GPU control has the same 0.00953 max log-sum rounding error.
          // Packed and unpacked GPU arrays match exactly; keep absent-bin zeros exact.
          const tolerance = reference === 0 ? 0 : 0.02 + Math.abs(reference) * 0.00002;
          assertCondition(Number.isFinite(actual) && error <= tolerance, `histogram mismatch cell=${cell} bin=${bin} channel=${channel}: actual=${actual} expected=${reference} tolerance=${tolerance}`);
          maxAbsoluteError = Math.max(maxAbsoluteError, error);
          if (channel % 2 === 0) maxLogSumError = Math.max(maxLogSumError, error);
          else maxWeightError = Math.max(maxWeightError, error);
        }
        const nextTexel = cell * BINS + Math.min(bin + 1, BINS - 1);
        assertCondition(
          gridPixels[texel * 4 + 2] === gridPixels[nextTexel * 4] &&
          gridPixels[texel * 4 + 3] === gridPixels[nextTexel * 4 + 1],
          `next-bin lanes differ from adjacent RG cell=${cell} bin=${bin}`,
        );
        const weight = gridPixels[texel * 4 + 1];
        totalWeight += weight;
        if (weight > 0) populatedBins.add(bin);
      }
      const cy = Math.floor(cell / cellsX);
      const cx = cell % cellsX;
      const sampleCount = Math.min(CELL, halfWidth - cx * CELL) * Math.min(CELL, halfHeight - cy * CELL);
      maxConservationError = Math.max(maxConservationError, Math.abs(totalWeight - sampleCount));
      assertCondition(Math.abs(totalWeight - sampleCount) < 0.02, `partial-cell sample count mismatch cell=${cell}`);
    }
    assertCondition(populatedBins.has(0) && [...populatedBins].some(bin => bin % 2 === 1), "missing reachable low/odd-bin coverage");
    assertCondition(!populatedBins.has(31), "clamped real luminance unexpectedly populated bin31");
    const detail = {
      half: [halfWidth, halfHeight], packedLog: [logWidth, halfHeight], grid: [cellsX * BINS, cellsY],
      comparedChannels: expected.length * 2, nextBinLaneChecks: expected.length, maxAbsoluteError, maxLogSumError, maxWeightError, maxConservationError, populatedBins: [...populatedBins].sort((a, b) => a - b),
      partialY: halfHeight % CELL, oddXCovered: false,
      coverageLimit: "Default drawing buffer covers partial Y; odd/tiny X is unit-only. Real metering clamps below bin31, whose zero entries are still compared.",
    };
    console.info(`TN_LOCAL_EXPOSURE_GRID_PASS:${JSON.stringify(detail)}`);
    // All asynchronous assertions finish before startVisualScene publishes readiness.
    return { detail, render: () => pipeline.render() };
  });
}
