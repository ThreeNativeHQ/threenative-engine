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

// Upstream WebGPU keeps 256-byte row padding; the owned renderer returns tight rows.
async function readFloatTarget(renderer, target, width, height) {
  const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  assertCondition(raw instanceof Float32Array, "missing Float32 GPU readback");
  if (raw.length === width * height * 4) return raw;
  const stride = Math.ceil(width * 16 / 256) * 64;
  assertCondition(raw.length === stride * (height - 1) + width * 4, "unexpected GPU readback row layout");
  const tight = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) tight.set(raw.subarray(y * stride, y * stride + width * 4), y * width * 4);
  return tight;
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "local-exposure-histogram", async ({ renderer, scene, camera }) => {
    pass(scene, camera);
    const originalSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    assertCondition(originalSize.x === 1280 && originalSize.y === 720, "histogram fixture requires the real default drawing buffer");
    const cases = [];
    let finalPipeline;
    for (const [width, height, injectedLog] of [[1920, 1080], [1922, 1081], [1280, 720], [1280, 720, 129], [1280, 720, Number.POSITIVE_INFINITY], [1280, 720, Number.NaN]]) {
    renderer.setSize(width, height, false);
    const applied = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (applied.x !== width || applied.y !== height) {
      // A native host surface keeps its own size; record the refusal instead of failing the math.
      cases.push({ requested: [width, height], resizeRefused: [applied.x, applied.y], injectedLog: injectedLog === undefined ? null : String(injectedLog) });
      continue;
    }
    const halfWidth = Math.ceil(width / 2);
    const halfHeight = Math.ceil(height / 2);
    const logWidth = Math.ceil(halfWidth / 4);
    const cellsX = Math.ceil(halfWidth / CELL);
    const cellsY = Math.ceil(halfHeight / CELL);
    // Include both sides of integer support boundaries and widely separated ranges in adjacent rows.
    const logs = [-10, -8.9, -7.5, -6.25, -4.7, -2.9, -1.35, 0.15, 1.7, 3.2, 4.7, 6.35, 8.2, 10.6, 12.3, 14.4, 15.9,
      -10 + 30 * (7 - 0.0001) / 31, -10 + 30 * 7 / 31, -10 + 30 * (7 + 0.0001) / 31];
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
    const render = renderer.render;
    let activeTarget;
    let injectedTexture;
    const injectedMaterials = [];
    if (injectedLog !== undefined) {
      // Fixture-only raw-log seam: replace the producer of every packed-log sized target.
      injectedTexture = new THREE.DataTexture(new Float32Array(4).fill(injectedLog), 1, 1, THREE.RGBAFormat, THREE.FloatType);
      injectedTexture.minFilter = injectedTexture.magFilter = THREE.NearestFilter;
      injectedTexture.needsUpdate = true;
      renderer.render = function (object, ...args) {
        if (
          activeTarget?.width === logWidth && activeTarget?.height === halfHeight &&
          object.material?.fragmentNode !== undefined && !injectedMaterials.some((entry) => entry.material === object.material)
        ) {
          injectedMaterials.push({ material: object.material, fragmentNode: object.material.fragmentNode });
          object.material.fragmentNode = texture(injectedTexture);
          object.material.needsUpdate = true;
        }
        return render.call(this, object, ...args);
      };
    }
    renderer.setRenderTarget = function (target, ...args) {
      activeTarget = target;
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
      renderer.render = render;
      for (const entry of injectedMaterials) {
        entry.material.fragmentNode = entry.fragmentNode;
        entry.material.needsUpdate = true;
      }
    }
    // A size change can leave the previous render's targets in the list; the last six are this frame's.
    const producers = targets.slice(-6);
    assertCondition(producers.length === 6, `expected six actual local-exposure producers, observed ${targets.length}`);
    const logTarget = producers[0];
    const lumTarget = producers[1];
    const blurWidth = Math.ceil(width / 16);
    const blurHeight = Math.ceil(height / 16);
    const rangeStride = Math.ceil(cellsX * halfHeight / (blurWidth * blurHeight));
    assertCondition(lumTarget.width === blurWidth && lumTarget.height === blurHeight, "actual luminance target size differs");
    const lumPixels = await readFloatTarget(renderer, lumTarget, blurWidth, blurHeight);
    assertCondition(lumPixels instanceof Float32Array && lumPixels.length === blurWidth * blurHeight * 4, `missing Float32 GPU luminance readback: ${lumPixels?.constructor?.name}/${lumPixels?.length}, expected ${blurWidth * blurHeight * 4}, target type ${lumTarget.texture.type}`);
    let maxLuminanceError = 0;
    for (let y = 0; y < blurHeight; y++) for (let x = 0; x < blurWidth; x++) {
      const sum = [0, 0, 0];
      // Original pass: point taps at c + (tap - 7.5) / fullSize, clamp addressing, then log of RGB thirds.
      for (let tap = 0; tap < 256; tap++) {
        const sx = Math.min(width - 1, Math.max(0, Math.floor((x + 0.5) / blurWidth * width + tap % 16 - 7.5)));
        const sy = Math.min(height - 1, Math.max(0, Math.floor((y + 0.5) / blurHeight * height + Math.floor(tap / 16) - 7.5)));
        for (let channel = 0; channel < 3; channel++) sum[channel] = f32(sum[channel] + pixels[(sy * width + sx) * 4 + channel]);
      }
      let luminance = f32(f32(sum[0] / 256) * f32(1 / 3));
      luminance = f32(luminance + f32(f32(sum[1] / 256) * f32(1 / 3)));
      luminance = f32(luminance + f32(f32(sum[2] / 256) * f32(1 / 3)));
      const expectedR = Math.log2(Math.max(2 ** -10, Math.min(65504, Math.max(0.0001, luminance))));
      const index = (y * blurWidth + x) * 4;
      const error = Math.abs(lumPixels[index] - expectedR);
      assertCondition(Number.isFinite(error) && error < 0.0001, `luminance R changed at ${width}x${height} (${x},${y}): ${lumPixels[index]} vs ${expectedR}`);
      assertCondition(lumPixels[index + 3] === 1, `luminance alpha changed at ${width}x${height} (${x},${y}) alpha=${lumPixels[index + 3]} min=${lumPixels[index+1]} max=${lumPixels[index+2]}`);
      maxLuminanceError = Math.max(maxLuminanceError, error);
    }
    const gridTarget = producers[5];
    assertCondition(logTarget.width === logWidth && logTarget.height === halfHeight && logTarget.texture.type === THREE.FloatType, "actual log target size/type differs");
    assertCondition(gridTarget.width === cellsX * BINS && gridTarget.height === cellsY && gridTarget.texture.type === THREE.FloatType, "actual final histogram size/type differs");
    const packedLogs = await readFloatTarget(renderer, logTarget, logWidth, halfHeight);
    const gridPixels = await readFloatTarget(renderer, gridTarget, cellsX * BINS, cellsY);
    assertCondition(packedLogs instanceof Float32Array && packedLogs.length === logWidth * halfHeight * 4, "missing packed Float32 GPU log readback");
    // Restore the logical half-resolution rows from four adjacent luminances per RGBA texel.
    const logPixels = new Float32Array(halfWidth * halfHeight);
    for (let y = 0; y < halfHeight; y++)
      for (let x = 0; x < halfWidth; x++)
        logPixels[y * halfWidth + x] = packedLogs[(y * logWidth + Math.floor(x / 4)) * 4 + x % 4];
    assertCondition(gridPixels instanceof Float32Array && gridPixels.length === cellsX * BINS * cellsY * 4, "missing Float32 GPU histogram readback");
    if (injectedLog !== undefined) {
      assertCondition(logPixels.every(value => Object.is(value, injectedLog)), "raw-log injection was not observed on GPU");
      for (let slot = 0; slot < Math.ceil(cellsX * halfHeight / rangeStride); slot++)
        assertCondition(lumPixels[slot * 4 + 1] === 0 && lumPixels[slot * 4 + 2] === 31, "invalid raw log did not disable pruning");
    }
    if (injectedLog !== undefined && !Number.isFinite(injectedLog)) {
      assertCondition(gridPixels.some(value => !Number.isFinite(value)), "invalid raw log no longer propagates into the grid");
      cases.push({ full: [width, height], injectedLog: String(injectedLog), fallback: [0, 31], maxLuminanceError, rawGridNonfinite: true });
      pipeline.dispose(); local.dispose(); source.dispose(); injectedTexture.dispose();
      continue;
    }
    if (injectedLog === undefined)
      assertCondition(Array.from({ length: Math.ceil(cellsX * halfHeight / rangeStride) }, (_, slot) =>
        lumPixels[slot * 4 + 1] > 0 || lumPixels[slot * 4 + 2] < 31).some(Boolean), "finite source never produced a narrower support range");
    // A bin pair is skipped only when its triangular support cannot meet the row bounds.
    for (let row = 0; row < cellsX * halfHeight; row++) {
      const slot = Math.floor(row / rangeStride);
      const low = lumPixels[slot * 4 + 1];
      const high = lumPixels[slot * 4 + 2];
      const cell = row % cellsX;
      const y = Math.floor(row / cellsX);
      for (let bin = 0; bin < BINS; bin++) {
        if (high > bin - 1 && low < bin + 2) continue;
        let lowSum = 0;
        let highSum = 0;
        for (let x = cell * CELL; x < Math.min((cell + 1) * CELL, halfWidth); x++) {
          const position = f32(Math.min(1, Math.max(0, f32(f32(logPixels[y * halfWidth + x] + 10) / 30))) * 31);
          lowSum = f32(lowSum + Math.max(0, f32(1 - Math.abs(position - bin))));
          highSum = f32(highSum + Math.max(0, f32(1 - Math.abs(position - (bin + 1)))));
        }
        assertCondition(lowSum === 0 && highSum === 0, `guard drops support at ${width}x${height} row=${row} slot=${slot} bin=${bin} bounds=[${low},${high}] lowSum=${lowSum} highSum=${highSum}`);
      }
    }
    // Each occupied G/B slot bounds all logical cell rows assigned to it, including partial rows.
    for (let row = 0; row < cellsX * halfHeight; row++) {
      const slot = Math.floor(row / rangeStride);
      const low = lumPixels[slot * 4 + 1];
      const high = lumPixels[slot * 4 + 2];
      const cell = row % cellsX;
      const y = Math.floor(row / cellsX);
      assertCondition(Number.isFinite(low) && Number.isFinite(high) && low <= high, `invalid conservative range at ${width}x${height} slot=${slot} low=${low} high=${high} row=${row} lum=[${lumPixels.slice(0,8).join(",")}] logs=[${Array.from(logPixels.slice(0,8)).join(",")}]`);
      for (let x = cell * CELL; x < Math.min((cell + 1) * CELL, halfWidth); x++) {
        const position = f32(Math.min(1, Math.max(0, f32(f32(logPixels[y * halfWidth + x] + 10) / 30))) * 31);
        assertCondition(low <= position + 0.000002 && high >= position - 0.000002, `range omitted real support row=${row} x=${x}: [${low},${high}] vs ${position}`);
      }
    }
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
          assertCondition(Number.isFinite(actual) && error <= tolerance, `histogram mismatch at ${width}x${height} cell=${cell} bin=${bin} channel=${channel}: actual=${actual} expected=${reference} tolerance=${tolerance}`);
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
    if (width >= 1280 && injectedLog === undefined) assertCondition(populatedBins.has(0) && [...populatedBins].some(bin => bin % 2 === 1), "missing reachable low/odd-bin coverage");
    if (injectedLog === undefined) assertCondition(!populatedBins.has(31), "clamped real luminance unexpectedly populated bin31");
    else assertCondition(populatedBins.has(31), "finite raw-log fallback missed bin31");
    const detail = {
      half: [halfWidth, halfHeight], packedLog: [logWidth, halfHeight], grid: [cellsX * BINS, cellsY],
      comparedChannels: expected.length * 2, nextBinLaneChecks: expected.length, maxAbsoluteError, maxLogSumError, maxWeightError, maxConservationError, populatedBins: [...populatedBins].sort((a, b) => a - b),
      full: [width, height], injectedLog: injectedLog === undefined ? null : String(injectedLog), rangeStride, maxLuminanceError,
      partialY: halfHeight % CELL, oddXCovered: halfWidth % CELL !== 0,
      coverageLimit: "Real metering clamps below bin31, whose zero entries are still compared.",
    };
    cases.push(detail);
    if (width === originalSize.x && height === originalSize.y) finalPipeline = pipeline;
    else { pipeline.dispose(); local.dispose(); source.dispose(); injectedTexture?.dispose(); }
    }
    const detail = { cases };
    console.info(`TN_LOCAL_EXPOSURE_GRID_PASS:${JSON.stringify(detail)}`);
    // All asynchronous assertions finish before startVisualScene publishes readiness.
    return { detail, render: () => finalPipeline.render() };
  });
}
