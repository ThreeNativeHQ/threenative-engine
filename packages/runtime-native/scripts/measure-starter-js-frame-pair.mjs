#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINUX_ARM64_V8_BUILD } from './build-linux-arm64-v8.mjs';

export const launchOrder = ['quickjs', 'v8', 'v8', 'quickjs', 'quickjs', 'v8'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function requireEvidence(condition, message) {
  if (!condition) throw new Error(`TN_STARTER_JS_PAIR: ${message}`);
}

export function compareRuns(runs) {
  requireEvidence(runs.length === 6, 'six paired runs required');
  let expectedSurface;
  let expectedFrames;
  let expectedAdapter;
  let expectedFeatures;
  const binaryHashes = new Map();
  const summaries = runs.map((run, index) => {
    const { engine, report, log } = run;
    requireEvidence(engine === launchOrder[index], 'launch order mismatch');
    requireEvidence(/^[a-f0-9]{64}$/.test(run.bundleSha256) && run.bundleSha256 === runs[0].bundleSha256, 'bundle identity mismatch');
    requireEvidence(/^[a-f0-9]{64}$/.test(run.binarySha256), 'binary identity missing');
    binaryHashes.set(engine, binaryHashes.get(engine) ?? run.binarySha256);
    requireEvidence(binaryHashes.get(engine) === run.binarySha256, 'binary changed between runs');
    const name = engine === 'v8' ? 'V8' : 'QuickJS';
    const other = engine === 'v8' ? 'QuickJS' : 'V8';
    requireEvidence(log.includes(`[${name}] Engine created successfully`) && !log.includes(`[${other}] Engine created successfully`), 'engine identity mismatch');
    const version = log.match(/\[V8\] Version: (\S+)/)?.[1];
    requireEvidence(engine !== 'v8' || version === LINUX_ARM64_V8_BUILD.version, 'V8 version differs from pinned producer');
    const adapter = log.match(/\[WebGPU\] Adapter: (.+)/)?.[1]?.trim();
    const backend = log.match(/\[WebGPU\] Backend: (.+)/)?.[1]?.trim();
    requireEvidence(adapter && /llvmpipe|lavapipe|software/i.test(adapter) && backend?.includes('Vulkan'), 'software Vulkan adapter not observed');
    const featureLines = [...log.matchAll(/TN_WORLD_ENVIRONMENT:(\{[^\r\n]+\})/g)];
    const features = featureLines.at(-1)?.[1];
    requireEvidence(features && Array.isArray(JSON.parse(features).stages) && JSON.parse(features).stages.length > 0 && !log.includes('TN_GRADE_TABLE '), 'render features missing or asset failed');
    expectedFeatures ??= features;
    requireEvidence(features === expectedFeatures, 'render feature workload changed');
    expectedAdapter ??= adapter;
    requireEvidence(adapter === expectedAdapter, 'adapter changed');
    requireEvidence(report?.pass === true && report.violations?.length === 0 && JSON.stringify(report.discardedWindows) === '[1]', 'perf reader rejected run or startup not discarded');
    requireEvidence(report.budgets?.length === 3, 'exactly startup plus two steady windows required');
    const windows = report.budgets.slice(1);
    for (const [offset, window] of windows.entries()) {
      requireEvidence(window.window === offset + 2 && Number.isInteger(window.frames) && window.frames > 0, 'steady window missing');
      requireEvidence(['mean', 'p50', 'p95'].every((key) => Number.isFinite(window.frame?.[key]) && window.frame[key] > 0), 'JS frame summary missing or malformed');
      const surface = window.surface;
      requireEvidence(surface && surface.drawingBufferWidth === 1280 && surface.drawingBufferHeight === 720 && surface.resolutionScale === 1 && Number.isInteger(surface.sampleCount) && surface.sampleCount > 0 && surface.compiling === false, 'resolution/sample/compilation observation missing or changed');
      const identity = JSON.stringify([surface.drawingBufferWidth, surface.drawingBufferHeight, surface.resolutionScale, surface.sampleCount]);
      expectedSurface ??= identity;
      expectedFrames ??= window.frames;
      requireEvidence(identity === expectedSurface && window.frames === expectedFrames, 'sample surface or frame count mismatch');
    }
    return { engine, version, adapter, backend, bundleSha256: run.bundleSha256, binarySha256: run.binarySha256, windowP50sMs: windows.map((w) => w.frame.p50), runP50Ms: windows[1].frame.p50 };
  });
  requireEvidence(binaryHashes.get('v8') !== binaryHashes.get('quickjs'), 'same binary used for both engines');
  const quickjsMedianMs = median(summaries.filter((run) => run.engine === 'quickjs').map((run) => run.runP50Ms));
  const v8MedianMs = median(summaries.filter((run) => run.engine === 'v8').map((run) => run.runP50Ms));
  return {
    pass: v8MedianMs < quickjsMedianMs,
    metric: 'JS callback frame duration: window 3 frame.p50 per run; arm = median of three run p50s',
    scope: 'same hosted Linux ARM64 VM; software Vulkan; no GPU performance claim',
    protocol: { launchOrder, warmup: 'discard window 1 per launch', steadyWindows: [2, 3], validationWindow: 2, sampleWindow: 3, framesPerWindow: expectedFrames, width: 1280, height: 720 },
    features: JSON.parse(expectedFeatures), quickjsMedianMs, v8MedianMs, runs: summaries,
  };
}

// The perf reader prints its verdict (violations such as TN_PERF_WINDOWS_MISSING) on stdout and leaves
// stderr empty, so a reason built from stderr alone read "failed:" with nothing after it.
export function failureReason(result) {
  const tail = (text) => (text ?? '').trim().slice(-1500);
  return [
    result.error?.message,
    `exit ${result.status ?? 'none'}${result.signal ? ` signal ${result.signal}` : ''}`,
    tail(result.stderr) && `stderr: ${tail(result.stderr)}`,
    tail(result.stdout) && `stdout: ${tail(result.stdout)}`,
  ].filter(Boolean).join('; ');
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024, ...options });
  requireEvidence(!result.error && result.status === 0, `${executable} failed: ${failureReason(result)}`);
  return result.stdout;
}

function main() {
  const [quickjs, v8, bundle, output] = process.argv.slice(2).map((path) => resolve(path));
  requireEvidence(quickjs && v8 && bundle && output && quickjs !== v8, 'usage: <quickjs> <v8> <shared-bundle> <output>');
  requireEvidence(process.platform === 'linux' && process.arch === 'arm64', 'requires Linux ARM64');
  mkdirSync(output, { recursive: true });
  const binaries = { quickjs, v8 };
  const bundleSha256 = hash(bundle);
  const binaryHashes = { quickjs: hash(quickjs), v8: hash(v8) };
  const cwd = resolve(dirname(bundle), '../public');
  const env = { ...process.env, SDL_VIDEODRIVER: 'x11' };
  // CPU profiling changes absolutes; inherited diagnostics must not contaminate either arm.
  for (const key of ['TN_JS_CPU_PROFILE', 'TN_JS_CPU_PROFILE_START_FRAME', 'TN_V8_FLAGS']) delete env[key];
  const runs = [];
  for (const [index, engine] of launchOrder.entries()) {
    requireEvidence(hash(bundle) === bundleSha256 && hash(binaries[engine]) === binaryHashes[engine], 'input mutated');
    const prefix = join(output, `${index + 1}-${engine}`);
    // exec preserves the host PID so the shipped perf collector's SIGTERM reaches the host.
    // tee retains the exact raw stream without adding measurement instrumentation.
    const stdout = command(process.execPath, [
      join(root, 'packages/playtest/dist/runner/cli.js'), 'perf', '--require-windows', '2', '--timeout', '180',
      '--executable', '/bin/bash', '--host-arg', '-c', '--host-arg',
      'exec "$1" run "$2" --ui "$4" --width 1280 --height 720 > >(tee "$3") 2>&1',
      '--host-arg', 'starter-perf', '--host-arg', binaries[engine], '--host-arg', bundle, '--host-arg', `${prefix}.log`, '--host-arg', join(dirname(bundle), 'ui'),
    ], { cwd, env });
    writeFileSync(`${prefix}.perf.json`, stdout);
    requireEvidence(hash(bundle) === bundleSha256 && hash(binaries[engine]) === binaryHashes[engine], 'input mutated during run');
    runs.push({ engine, bundleSha256, binarySha256: binaryHashes[engine], log: readFileSync(`${prefix}.log`, 'utf8'), report: JSON.parse(stdout) });
  }
  const comparison = compareRuns(runs);
  writeFileSync(join(output, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
  console.log(JSON.stringify(comparison, null, 2));
  requireEvidence(comparison.pass, 'V8 median JS frame duration must be strictly lower than QuickJS');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
