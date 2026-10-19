import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import { expect, test } from 'vitest';
import {
	ANDROID_16KB_PAGE_SIZE,
	ANDROID_4KB_PAGE_SIZE,
	assertObservedPageSize,
} from '../scripts/check-android-page-size.mjs';

const workflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/native-platforms.yml', import.meta.url)),
  'utf8',
);
const runtimeCmake = readFileSync(
  fileURLToPath(new URL('../CMakeLists.txt', import.meta.url)),
  'utf8',
);
const runtimePresets = readFileSync(
  fileURLToPath(new URL('../CMakePresets.json', import.meta.url)),
  'utf8',
);
const ciWorkflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
);
const releaseWorkflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/native-release.yml', import.meta.url)),
  'utf8',
);
const androidV8Action = readFileSync(
  fileURLToPath(new URL('../../../.github/actions/android-v8-source/action.yml', import.meta.url)),
  'utf8',
);
const candidateWorkflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/release-candidate.yml', import.meta.url)),
  'utf8',
);

const smokeScenario = (name) => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../../examples/native-smoke/playtests/${name}`, import.meta.url)),
  'utf8',
));

test('static SDL is position independent for native PIE consumers', () => {
  const sdl = runtimeCmake.slice(
    runtimeCmake.indexOf('# SDL3 - Build from source as static library'),
    runtimeCmake.indexOf('if(NOT SDL3_FOUND)'),
  );
  expect(sdl).toMatch(
    /add_subdirectory\(\$\{SDL3_SOURCE_DIR\}[\s\S]*?set_target_properties\(SDL3-static PROPERTIES\s+POSITION_INDEPENDENT_CODE ON\)/u,
  );
  expect(sdl).toMatch(
    /if\(TARGET SDL_uclibc\)[\s\S]*?set_target_properties\(SDL_uclibc PROPERTIES\s+POSITION_INDEPENDENT_CODE ON\)/u,
  );
  const linuxPreset = runtimePresets.slice(
    runtimePresets.indexOf('"name": "tn-linux"'),
    runtimePresets.indexOf('"name": "tn-windows"'),
  );
  expect(linuxPreset).toContain('"CMAKE_POSITION_INDEPENDENT_CODE": "ON"');
});

test('native compiler caches restore only the current CMake inputs', () => {
  for (const source of [workflow, ciWorkflow]) {
    const restoreKeys = [...source.matchAll(/^\s+restore-keys:\s*(native-ccache[^\n]+)$/gmu)].map(
      (match) => match[1] ?? '',
    );
    expect(restoreKeys.length).toBeGreaterThan(0);
    for (const restoreKey of restoreKeys) {
      expect(restoreKey).toContain('hashFiles(');
    }
  }
});

test('green native platform lane is required by primary CI', () => {
  const nativeJob = ciWorkflow.match(
    /\n\x20{2}native-platforms:\n[\s\S]*?(?=\n\x20{2}[a-z0-9-]+:|\s*$)/u,
  )?.[0] ?? '';
  expect(nativeJob).toContain('needs: scope');
  expect(nativeJob).toContain('uses: ./.github/workflows/native-platforms.yml');
  expect(nativeJob).not.toMatch(/^\s+continue-on-error:/mu);
  expect(workflow).toContain('workflow_call:');
  expect(workflow).not.toMatch(/\n\x20{2}(?:push|pull_request|schedule):/u);
  expect(ciWorkflow).toContain(
    "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
  );
  expect(workflow).toContain(
    "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
  );
});

test('the protected build context requires scope and workspace evidence, not the native matrix', () => {
  const buildJob = ciWorkflow.match(
    /\n\x20{2}build:\n[\s\S]*?(?=\n\x20{2}[a-z0-9-]+:|\s*$)/u,
  )?.[0] ?? '';
  // PR #206 made native-platform evidence a release-lane concern rather than a merge verdict, so
  // a 120-minute native matrix cannot hold every merge; PRD-373 owns the policy and this test
  // tracks it. What is protected here is unchanged in spirit: the protected `build` context still
  // fails closed on every one of its remaining inputs.
  expect(buildJob).toContain('needs: [scope, build-artifacts]');
  expect(buildJob).not.toContain('native-platforms');
  expect(buildJob).toContain(
    "if: ${{ !cancelled() && needs.scope.outputs.selection == 'full' }}",
  );
  expect(buildJob).toContain('CI_SCOPE_RESULT: ${{ needs.scope.result }}');
  expect(buildJob).toContain(
    'WORKSPACE_BUILD_RESULT: ${{ needs.build-artifacts.result }}',
  );
  const gate = buildJob.match(
    /\n\x20{6}- name: Require workspace evidence\n\x20{8}env:\n(?:\x20{10}[A-Z_]+: [^\n]*\n)+\x20{8}run: \|\n([\s\S]*?)(?=\n\x20{6}- |\n\x20{2}[a-z0-9-]+:|$)/u,
  )?.[1];
  expect(gate).toBeDefined();
  const script = gate
    ?.split('\n')
    .map((line) => line.replace(/^\x20{10}/u, ''))
    .join('\n');
  expect(script).toBeDefined();
  const run = (results) =>
    // NB: never pass -euo as separate argv entries; bash reads the first as $0
    // with `set -u` active and aborts on `$1`.
    spawnSync('bash', ['-c', `set -euo pipefail\n${script}`], {
      env: {
        ...process.env,
        CI_SCOPE_RESULT: 'success',
        WORKSPACE_BUILD_RESULT: 'success',
        ...results,
      },
      encoding: 'utf8',
    });
  expect(run({}).status).toBe(0);
  // Each input fails closed on its own, and on every non-success verdict rather than only on
  // `failure` - a cancelled or skipped producer must never read as a passed merge gate.
  for (const result of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', '']) {
    expect(run({ WORKSPACE_BUILD_RESULT: result }).status, `artifacts ${result}`).not.toBe(0);
    expect(run({ CI_SCOPE_RESULT: result }).status, `scope ${result}`).not.toBe(0);
  }
  // The native matrix is a required member of ci-required again: the scope plan requires it for a
  // full selection that touches native code, targets main, or cannot prove a clean native-free
  // pull request. When the plan exempts it, the job is skipped and ci-required.mjs counts an
  // exempt skip as a pass; a required run that is not success fails the verdict. run-summary still
  // reports the lane either way.
  const jobBlock = (name) =>
    ciWorkflow.match(
      new RegExp(`\\n\\x20{2}${name}:\\n[\\s\\S]*?(?=\\n\\x20{2}[a-z0-9-]+:|\\s*$)`, 'u'),
    )?.[0] ?? '';
  expect(jobBlock('ci-required')).toContain('needs: [scope,');
  expect(jobBlock('ci-required')).toContain('native-platforms');
  expect(jobBlock('run-summary')).toContain('native-platforms');
});

test('the desktop parity job keeps the name the release gate requires', () => {
  // The release gate matches CI job names exactly. When this job lost its `name:` the run
  // reported `native-platforms / desktop-parity`, so PRD-078's main route could never resolve
  // its `native-platforms / Desktop web/native parity` row.
  const job = workflow.match(
    /\n\x20{2}desktop-parity:\n[\s\S]*?(?=\n\x20{2}[a-z0-9-]+:|\s*$)/u,
  )?.[0] ?? '';
  expect(job).toContain('name: Desktop web/native parity');
});

test('Android V8 source is produced once and consumed as a verified artifact', () => {
  expect(androidV8Action).toContain('actions/cache/restore@v4');
  expect(androidV8Action).toContain('actions/cache/save@v4');
  expect(androidV8Action).toContain('third_party/.v8-source');
  expect(androidV8Action).toContain('github.run_id');
  expect(androidV8Action).toContain('github.run_attempt');
  expect(androidV8Action).toContain('restore-keys:');
  expect(androidV8Action).toContain('node scripts/download-deps.mjs --only v8-android');
  expect(androidV8Action).toContain('node scripts/build-android-v8.mjs --verify');
  const producer = workflow.match(
    /\n\x20{2}android-v8-source:\n[\s\S]*?(?=\n\x20{2}[a-z0-9-]+:|\s*$)/u,
  )?.[0] ?? '';
  expect(producer).toContain('needs: scope');
  expect(producer).toContain("if: needs.scope.outputs.selection == 'full' && inputs.ios_only != true");
  expect(producer).toContain('ref: ${{ needs.scope.outputs.candidate_sha }}');
  expect(producer).toContain('TN_CI_SHA: ${{ needs.scope.outputs.candidate_sha }}');
  expect(producer).toContain('uses: ./.github/actions/android-v8-source');
  expect(producer).toContain('actions/upload-artifact@v7');
  expect(producer).toContain('name: android-v8-${{ needs.scope.outputs.candidate_sha }}');
  const android = workflow.match(
    /\n\x20{2}android-emulator-parity:\n[\s\S]*?(?=\n\x20{2}[a-z0-9-]+:|\s*$)/u,
  )?.[0] ?? '';
  expect(android).toContain('needs: [scope, web-reference, android-v8-source]');
  expect(android).toContain('needs.android-v8-source.result == \'success\'');
  expect(android).toContain('actions/download-artifact@v7');
  expect(android).toContain('name: android-v8-${{ needs.scope.outputs.candidate_sha }}');
  expect(android).toContain('native-android-third-party-');
});

test('Android V8 interruption leaves time to cache and resume Ninja state', () => {
  const buildStep = androidV8Action.match(
    /- name: Build the pinned Android V8 payload[\s\S]*?(?=\n {4}- name: Verify the complete Android V8 payload)/u,
  )?.[0] ?? '';
  const script = buildStep.match(/\n {6}run: \|\n([\s\S]*)$/u)?.[1]
    ?.split('\n')
    .map((line) => line.replace(/^ {8}/u, ''))
    .join('\n');
  expect(script).toContain('timeout --signal=TERM --kill-after=30s 180m');
  expect(androidV8Action.indexOf('Save resumable V8 source state')).toBeGreaterThan(
    androidV8Action.indexOf('Build the pinned Android V8 payload'),
  );
  // Assert the guard, not its quoting: the condition is a folded scalar now, and pinning the exact
  // `if: always()` spelling measured the YAML style rather than the resumable-save behaviour.
  const saveStep = androidV8Action.slice(
    androidV8Action.indexOf('Save resumable V8 source state'),
  );
  expect(saveStep).toContain('always()');
  expect(saveStep).toContain("steps.build.outcome == 'failure'");
  // A superseded pull request is not an interrupted build; its cancel must not save 3 GB.
  expect(saveStep).toContain("github.event_name != 'pull_request'");
  expect(saveStep).toContain('third_party/.v8-source');

  const root = makeTempDirSync('tn-v8-resume-action-');
  const runtime = join(root, 'runtime');
  const bin = join(root, 'bin');
  const state = join(
    runtime,
    'third_party/.v8-source/buildscripts/v8/out.v8.arm64/build.ninja',
  );
  mkdirSync(join(runtime, 'scripts'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const fakeNode = join(bin, 'node');
  writeFileSync(
    fakeNode,
    `#!/bin/sh
set -eu
state="$PWD/third_party/.v8-source/buildscripts/v8/out.v8.arm64/build.ninja"
mkdir -p "$(dirname "$state")"
if [ "\${TN_V8_RESUME:-0}" = "1" ]; then
  test -s "$state"
  printf resumed > "$state"
  exit 0
fi
printf advanced > "$state"
child=0
trap 'test "$child" -eq 0 || kill "$child" 2>/dev/null || true; exit 143' TERM INT
sleep 60 &
child=$!
wait "$child"
`,
  );
  chmodSync(fakeNode, 0o755);
  const env = {
    ...process.env,
    ANDROID_NDK_HOME: root,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  try {
    // Shorten only this fixture's clock; the extracted command is otherwise the action's exact
    // build shell. The timeout must fail after the fake Ninja state has been written.
    const interrupted = spawnSync(
      'bash',
      ['-euo', 'pipefail', '-c', script.replace('180m', '1s')],
      { cwd: runtime, env, encoding: 'utf8' },
    );
    expect(interrupted.status).toBe(124);
    expect(readFileSync(state, 'utf8')).toBe('advanced');

    const resumed = spawnSync(
      'bash',
      ['-euo', 'pipefail', '-c', script.replace('180m', '5s')],
      { cwd: runtime, env: { ...env, TN_V8_RESUME: '1' }, encoding: 'utf8' },
    );
    expect(resumed.status).toBe(0);
    expect(readFileSync(state, 'utf8')).toBe('resumed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('desktop platform lanes build and retain executable evidence', () => {
  for (const token of [
    'runner: macos-15',
    'runner: windows-2025',
    'native:build',
    'native:verify:desktop',
    'curl:x64-windows-static',
    'packages/runtime-native/artifacts/',
    'if-no-files-found: error',
  ]) {
    expect(workflow).toContain(token);
  }
  expect(workflow).toContain('scripts/workspace-packages.ts --archives');
  expect(workflow.indexOf('scripts/workspace-packages.ts --archives')).toBeLessThan(
    workflow.indexOf('pnpm --filter threenative-native-smoke build'),
  );
  expect(workflow).toContain('pnpm --filter "$package_name" --if-present run build');
  for (const source of [workflow, releaseWorkflow]) {
    expect(source).toContain('libcurl4-openssl-dev');
    expect(source).toContain('libfontconfig1-dev');
    expect(source).toContain('mesa-vulkan-drivers');
    expect(source).toContain('zlib1g-dev');
    expect(source).toContain('libx11-dev');
    expect(source).toContain('vswhere.exe');
    expect(source).toContain('set "CC=cl"');
    expect(source).toContain('set "CXX=cl"');
    expect(source).toContain('set "VCPKG_ROOT=%VCPKG_INSTALLATION_ROOT%"');
    expect(source).toContain('where cl');
    expect(source).toContain('shell: cmd');
    expect(source).toContain("if: runner.os != 'Windows'");
  }
});

test('macOS runs the installed playtest against the relocated release and propagates failure', () => {
  const step = workflow.match(
    /- name: Play the relocated macOS release with React controls\n([\s\S]*?)(?=\n {6}- name:)/u,
  )?.[1];
  assert.ok(step, 'The final macOS app needs interactive gameplay verification');
  assert.match(step, /if: matrix.platform == 'macOS'/u);
  const script = step.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/u)?.[1];
  assert.ok(script);
  const root = makeTempDirSync('tn-macos-release-playtest-');
  const project = join(root, 'threenative-starter-native');
  const container = join(root, 'Relocated Game.app');
  const distribution = join(project, 'node_modules/@threenative/runtime-native/scripts');
  const runner = join(project, 'node_modules/@threenative/playtest/dist/runner');
  const recorded = join(root, 'argv.json');
  mkdirSync(distribution, { recursive: true });
  mkdirSync(runner, { recursive: true });
  writeFileSync(join(distribution, 'desktop-distribution.mjs'), `
    import assert from 'node:assert/strict';
    export function resolveContainer(root) {
      assert.equal(root, process.env.TN_RELEASE_CONTAINER_ROOT);
      return { executable: 'Contents/MacOS/Game With Spaces' };
    }
  `);
  writeFileSync(join(runner, 'cli.js'), `
    require('node:fs').writeFileSync(process.env.TN_TEST_ARGV, JSON.stringify(process.argv.slice(2)));
    process.exit(Number(process.env.TN_TEST_EXIT));
  `);
  try {
    for (const code of [0, 7]) {
      const result = spawnSync(process.execPath, ['--input-type=module'], {
        input: script, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, RUNNER_TEMP: root, TN_RELEASE_CONTAINER_ROOT: container,
          TN_TEST_ARGV: recorded, TN_TEST_EXIT: String(code) },
      });
      assert.equal(result.status, code, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(recorded, 'utf8')), [
        resolve('packages/runtime-native/scenarios/starter-ui-overlay-desktop.playtest.json'),
        '--target', 'desktop', '--executable', join(container, 'Contents/MacOS/Game With Spaces'),
        '--project', project, '--artifacts',
        resolve('packages/runtime-native/artifacts/release-container-macOS/gameplay'),
        '--host-arg', '--windowed',
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('iOS lane executes simulator proof and negative-control tests on an Apple runner', () => {
  expect(workflow).toMatch(/ios-simulator:[\s\S]*runs-on: macos-15/);
  expect(workflow).toContain('rustup target add aarch64-apple-ios-sim');
  expect(workflow).toContain('verify-ios-simulator.mjs');
  expect(workflow).toContain('ios-driver.spec.ts');
  expect(workflow).toContain('ios-device-playtest.spec.ts');
  expect(workflow).toContain('native-ios-simulator');
  for (const source of [workflow, releaseWorkflow]) {
    expect(source).toContain('physics-parity.scenario.json');
    expect(source).toContain('examples/native-smoke/src/physics.ts');
    expect(source).toContain('src/game.ts');
    expect(source).not.toMatch(/native-smoke\/src\/physics\.ts[^\n]*src\/main\.ts/u);
  }
  expect(releaseWorkflow).toMatch(/native-smoke\/src\/game\.ts[^\n]*src\/game\.ts/u);
  expect(releaseWorkflow).not.toMatch(/native-smoke\/src\/game\.ts[^\n]*src\/main\.ts/u);
  for (const token of [
    'threenative-ios-simulator-arm64.zip',
    'pnpm --dir "$IOS_CONSUMER_TARGET" build --target ios',
    'ios-toolchain-invocations.log',
    '--target ios --app "$app"',
    '--timeout 30000',
    'physics-wrong-height.playtest.json',
    'physics-mask.playtest.json',
    'THREENATIVE_PHYSICS_CONTROL=masked',
    'THREENATIVE_PHYSICS_CONTROL=wrong-gravity',
  ]) {
    expect(workflow).toContain(token);
  }
});

test('iOS consumer launches the bundle identifier produced by its packager', () => {
  expect(workflow).toContain('bundle_id=$(node -e');
  expect(workflow).toContain('report="$app.json"');
  expect(workflow).toContain('--bundle-id "$bundle_id"');
  expect(workflow).not.toContain('--bundle-id dev.threenative.runtime');
});

test('iOS builds selected React UI from installed packages and checks full-screen pixels', () => {
  const step = workflow.match(
    /- name: Scaffold the iOS React UI consumer from local tarballs\n([\s\S]*?)\n {6}- run: >-/u,
  )?.[1];
  assert.ok(step);
  assert.match(step, /template: starter/u);
  assert.match(step, /pnpm --dir "\$target" build:ios/u);
  assert.match(step, /node "\$target\/node_modules\/@threenative\/playtest\/dist\/runner\/cli\.js"/u);
  assert.match(step, /ui-state-ios\.playtest\.json/u);
  assert.match(step, /--target ios --app "\$app" --bundle-id "\$bundle_id"/u);
  assert.match(step, /decodeUiScreenshot\(image, 96, 96\)/u);
  assert.match(step, /published\.includes\(visible\.sequence\)/u);
  assert.match(step, /tests\/ui-layer-host-contract\.test\.mjs/u);
  // Not yet passing (PRD-399 P4-d): runs in the dedicated iOS dispatch, not on every pull request.
  expect(step.match(/if: \$\{\{ inputs\.ios_only == true \}\}/gu)).toHaveLength(2);
});

test('iOS workflow dispatch gates named desktop/Android jobs without weakening full receipts', () => {
  const job = (source, id) => source.match(
    new RegExp(`\\n {2}${id}:\\n[\\s\\S]*?(?=\\n {2}[a-z0-9-]+:|$)`, 'u'),
  )?.[0] ?? '';
  const condition = (body) => body.match(/^ {4}if: [^\n]*(?:\n {6}[^\n]*)*/mu)?.[0] ?? '';
  const guarded = ['android-v8-source', 'android-emulator-parity', 'desktop-parity', 'desktop', 'starter-linux'];
  const assertIsolation = (source) => {
    for (const id of guarded) {
      expect(condition(job(source, id)), `${id} skips an isolated iOS dispatch`).toContain('inputs.ios_only != true');
      expect(condition(job(source, id)), `${id} retains selected full coverage`).toContain("needs.scope.outputs.selection == 'full'");
    }
    expect(condition(job(source, 'completion'))).toBe('    if: ${{ always() && inputs.ios_only != true }}');
    expect(job(source, 'performance-coverage')).toContain(
      "TN_PERF_REQUIRED_DESKTOP: ${{ needs.scope.outputs.native_tier == 'full' && inputs.ios_only != true && 'Windows,macOS' || '' }}",
    );
    expect(job(source, 'ios-simulator')).toContain('continue-on-error: true');
    expect(condition(job(source, 'ios-simulator'))).not.toContain('inputs.ios_only != true');
    expect(source).toContain('group: native-platforms-${{ github.event_name }}-${{ github.ref }}-${{ github.run_id }}');
    expect(source).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  };
  expect(workflow).toContain('ios_only:');
  assertIsolation(workflow);
  for (const id of [...guarded, 'completion', 'performance-coverage']) {
    const body = job(workflow, id);
    const inverted = body.replace('inputs.ios_only != true', 'inputs.ios_only == true');
    expect(inverted).not.toBe(body);
    expect(() => assertIsolation(workflow.replace(body, inverted))).toThrow();
  }
});

test('iOS consumer proof runs but cannot hold the merge verdict', () => {
  // iOS is not a supported target (owner decision, 2026-09-23), so the simulator lane runs and
  // reports its own red but is deliberately non-blocking — otherwise a red iOS leg holds the
  // develop->main `ci-required` verdict. `native-release.yml` still validates the iOS rows for a
  // release, so only the merge verdict is dropped. Mirrors
  // scripts/__tests__/ci-structure.spec.ts's android-not-blocking / ios-blocking contract.
  const iosJob = workflow.slice(workflow.indexOf('  ios-simulator:'));
  expect(iosJob).toContain('continue-on-error: true');
  expect(iosJob).toContain('verify-ios-simulator.mjs');
  expect(workflow).not.toContain('worker proof is unresolved');
});

test('Android release lane installs both Rust cross-compilation targets before Gradle', () => {
  const rustTargets = 'rustup target add aarch64-linux-android x86_64-linux-android';
  expect(releaseWorkflow).toContain(rustTargets);
  expect(releaseWorkflow.indexOf(rustTargets)).toBeLessThan(
    releaseWorkflow.indexOf('sh ./gradlew assembleRelease'),
  );
});

test('clean Android consumer exposes late-installed emulator SDK directories', () => {
  expect(releaseWorkflow).toContain(
    'ln -s "$source_sdk/$directory" "$clean_sdk/$directory"',
  );
  expect(releaseWorkflow).toContain('test -L "$clean_sdk/emulator"');
  expect(releaseWorkflow).toContain('test -L "$clean_sdk/system-images"');
  expect(releaseWorkflow).not.toContain(
    'if test -e "$source_sdk/$directory"; then ln -s',
  );
});

test('packed desktop smoke copies the Vite defines required by its authored entry', () => {
  const copy = 'examples/native-smoke/vite.config.ts';
  const build = 'pnpm --dir "$CONSUMER_TARGET" build --target desktop';
  expect(releaseWorkflow).toContain(copy);
  expect(releaseWorkflow.indexOf(copy)).toBeLessThan(releaseWorkflow.indexOf(build));
});

test('clean Android emulator script is compatible with line-by-line action execution', () => {
  const script = releaseWorkflow.match(
    /- name: Run packed Android physics and negative controls on an emulator[\s\S]*?script: \|\n([\s\S]*?)\n {6}- name:/u,
  )?.[1];
  expect(script).toBeDefined();
  expect(script).not.toContain('expect_android_failure');
  expect(script).not.toMatch(/\\\s*$/mu);
  expect(script).not.toMatch(/\n\s+(?:cli|scenario_root)=/u);
  expect(
    script.match(
      /set \+e; node .*status=\$\?; set -e; cat .*; test "\$status" -eq 1; grep -F/gu,
    ),
  ).toHaveLength(4);
});

test('clean consumers retain failure logs and use the measured device timeout', () => {
  expect(releaseWorkflow.match(/--timeout 30000/gu)).toHaveLength(9);
  const consumers = releaseWorkflow.slice(releaseWorkflow.indexOf('  clean-consumer:'));
  expect(consumers.match(/if: always\(\)/gu)).toHaveLength(2);
  expect(releaseWorkflow.match(/if-no-files-found: warn/gu)).toHaveLength(2);
  expect(releaseWorkflow).toContain('cat "$RUNNER_TEMP/ios-wrong-value.log"');
});

test('clean Android consumer provisions the debug keystore the aligner re-signs with', () => {
  // `package-android.mjs` re-signs the APK after `zipalign` rewrites it, and fails closed when
  // `$HOME/.android/debug.keystore` is absent. The packed-consumer lane builds through the
  // packager, not a Gradle debug install, so the store Gradle auto-creates is not guaranteed;
  // the workflow must create the standard Android debug key before that build.
  const provision = releaseWorkflow.indexOf('keytool -genkeypair');
  const androidBuild = releaseWorkflow.indexOf(
    'pnpm --dir "$CONSUMER_TARGET" build --target android',
  );
  expect(provision).toBeGreaterThan(-1);
  expect(androidBuild).toBeGreaterThan(-1);
  expect(provision).toBeLessThan(androidBuild);
  expect(releaseWorkflow).toContain('$HOME/.android/debug.keystore');
});

test('clean desktop consumer provisions software Vulkan and prints its log on failure', () => {
  const cleanConsumer = releaseWorkflow.match(
    / {2}clean-consumer:\n([\s\S]*?)\n {2}clean-consumer-ios:/u,
  )?.[1];
  expect(cleanConsumer).toBeDefined();
  expect(cleanConsumer).toContain('sudo apt-get install -y mesa-vulkan-drivers');

  const launch = cleanConsumer.match(
    /- name: Launch the packed desktop game for 300 frames\n {8}run: \|\n([\s\S]*?)\n {6}- name:/u,
  )?.[1];
  expect(launch).toBeDefined();
  expect(launch).toContain(`trap 'status=$?; trap - ERR; cat "$log"; exit "$status"' ERR`);
  expect(launch.indexOf('cat "$log"')).toBeLessThan(launch.indexOf('scripts/xvfb.sh'));
  expect(launch).toContain('trap - ERR');
});

// PRD-078: execute the live workflow shell; only the external GitHub API is stubbed.
const releaseGateScript = releaseWorkflow.match(
  /- name: Require a green CI run for this commit[\s\S]*?\n {8}run: \|\n([\s\S]*?)(?=\n {6}- |\n\n {2}build:)/u,
)?.[1]?.split('\n').map((line) => line.replace(/^ {10}/u, '')).join('\n');
const requiredCiJobs = [
  'typecheck', 'lint', 'test', 'budgets', 'build', 'test-native',
  'native-platforms / Windows desktop core',
  'native-platforms / macOS desktop core',
  'native-platforms / Scaffolded starter desktop artifact (linux-x64)',
  'native-platforms / Desktop web/native parity',
  'native-platforms / Android emulator visual parity',
];
const candidateSha = 'a'.repeat(40);
const candidateRun = {
  databaseId: 123, attempt: 1, status: 'completed', conclusion: 'success',
  event: 'push', headBranch: 'main', headSha: candidateSha,
};
const candidateJobs = requiredCiJobs.map((name, index) => ({
  id: index + 1, run_id: 123, head_sha: candidateSha, name,
  status: 'completed', conclusion: 'success',
}));

function runReleaseGate({ runs = [candidateRun], detail = candidateRun, jobs = candidateJobs,
  pages = [{ total_count: jobs.length, jobs }], failure = '' } = {}) {
  assert.ok(releaseGateScript, 'the existing release entry point must be present');
  const directory = makeTempDirSync('threenative-prd-078-gate-');
  writeFileSync(join(directory, 'gh'), `#!/bin/sh
case "$1 $2" in
  'run list') test "$MOCK_GH_FAILURE" != list || exit 42; printf '%s' "$MOCK_GH_RUNS" ;;
  'run view') test "$2" = view || exit 64; test "$MOCK_GH_FAILURE" != view || exit 42; printf '%s' "$MOCK_GH_DETAIL" ;;
  'api --paginate') test "$2" = --paginate || exit 64; test "$3" = --slurp || exit 64; test "$4" = 'repos/ThreeNativeHQ/threenative/actions/runs/123/jobs?filter=latest&per_page=100' || exit 64; test "$MOCK_GH_FAILURE" != jobs || exit 42; printf '%s' "$MOCK_GH_PAGES" ;;
  *) exit 64 ;;
esac
`);
  chmodSync(join(directory, 'gh'), 0o755);
  // NB: never pass -euo as separate argv entries; bash reads the first as $0
  // with `set -u` active and aborts on `$1`. Set options inside the script.
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${releaseGateScript}`], {
    env: { ...process.env, GITHUB_REPOSITORY: 'ThreeNativeHQ/threenative',
      GITHUB_SHA: candidateSha, RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      MOCK_GH_RUNS: JSON.stringify(runs), MOCK_GH_DETAIL: JSON.stringify(detail),
      MOCK_GH_PAGES: JSON.stringify(pages), MOCK_GH_FAILURE: failure,
      PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  return { ...result, directory };
}

test('release gate accepts complete exact-candidate evidence across job pages', () => {
  const result = runReleaseGate({ pages: [
    { total_count: candidateJobs.length, jobs: candidateJobs.slice(0, 5) },
    { total_count: candidateJobs.length, jobs: candidateJobs.slice(5) },
  ] });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(join(result.directory, 'native-release-prerequisites/validation.json'), 'utf8'));
  assert.equal(report.candidateSha, candidateSha);
  assert.equal(report.run.databaseId, 123);
  assert.equal(report.run.attempt, 1);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.requiredJobs.map((job) => job.name), requiredCiJobs);
  assert.ok(report.requiredJobs.every((job) => job.status === 'completed' && job.conclusion === 'success'));
  assert.match(readFileSync(join(result.directory, 'summary'), 'utf8'), /Android emulator visual parity/u);
});

test('should reject release prerequisites when the successful run belongs to a different source SHA', () => {
  // Observed successful main CI 34437894675 is not proof for this candidate.
  const result = runReleaseGate({ runs: [{ ...candidateRun,
    databaseId: 34437894675, headSha: '6972d87c1881a021afb041f44d4fcddcb469e971' }] });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(candidateSha));
});

test('release gate refuses an absent run or invalid run identity', () => {
  for (const runs of [[], ...[null, '123', 0, -1, 1.5, undefined].map(
    (databaseId) => [{ ...candidateRun, databaseId }],
  )]) {
    const result = runReleaseGate({ runs });
    assert.equal(result.status, 1, JSON.stringify(runs));
    assert.ok(result.stderr.includes(candidateSha));
  }
});

test('release gate rejects every missing required job even when the run is green', () => {
  for (const name of requiredCiJobs) {
    const result = runReleaseGate({ jobs: candidateJobs.filter((job) => job.name !== name) });
    assert.equal(result.status, 1, `aggregate success must not hide missing ${name}`);
    assert.ok(result.stderr.includes(name), result.stderr);
  }
});

test('release gate rejects skipped cancelled failed and unfinished required jobs', () => {
  for (const [status, conclusion] of [
    ['completed', 'skipped'], ['completed', 'cancelled'], ['completed', 'failure'],
    ['completed', 'neutral'], ['in_progress', null], ['queued', null],
  ]) {
    const jobs = candidateJobs.map((job, index) => index === 0 ? { ...job, status, conclusion } : job);
    const result = runReleaseGate({ jobs });
    assert.equal(result.status, 1, `${status}/${conclusion}`);
    assert.ok(result.stderr.includes('typecheck'));
  }
});

test('release gate revalidates the selected run instead of trusting the list response', () => {
  for (const change of [
    { headSha: 'b'.repeat(40) }, { databaseId: 124 }, { attempt: 0 },
    { status: 'in_progress' }, { conclusion: 'failure' },
    { event: 'pull_request' }, { headBranch: 'topic' },
  ]) {
    const result = runReleaseGate({ detail: { ...candidateRun, ...change } });
    assert.equal(result.status, 1, JSON.stringify(change));
    assert.ok(result.stderr.includes(candidateSha));
  }
});

test('release gate fails closed on incomplete pages and malformed or crossed job evidence', () => {
  for (const pages of [[], {}, [{ total_count: candidateJobs.length, jobs: candidateJobs.slice(1) }],
    [{ total_count: candidateJobs.length, jobs: null }],
    ...[null, { ...candidateJobs[0], id: 0 }, { ...candidateJobs[0], run_id: 124 },
      { ...candidateJobs[0], head_sha: 'b'.repeat(40) }].map((job) => [
      { total_count: candidateJobs.length, jobs: [job, ...candidateJobs.slice(1)] },
    ]),
    [{ total_count: candidateJobs.length + 1, jobs: [...candidateJobs, candidateJobs[0]] }],
  ]) {
    const result = runReleaseGate({ pages });
    assert.equal(result.status, 1, JSON.stringify(pages));
  }
});

test('release gate preserves non-success diagnostics when GitHub queries fail', () => {
  for (const failure of ['list', 'view', 'jobs']) {
    const result = runReleaseGate({ failure });
    assert.equal(result.status, 42);
    assert.equal(readFileSync(join(result.directory, 'native-release-prerequisites/status.txt'), 'utf8'), 'exit_code=42\n');
  }
});

test('release prerequisite and desktop diagnostic artifacts survive failed gates', () => {
  for (const name of ['release-prerequisites-${{ github.sha }}-${{ github.run_attempt }}', 'evidence-desktop-${{ matrix.key }}']) {
    const upload = releaseWorkflow.split('      - ').find((step) => step.includes(`name: ${name}`));
    assert.ok(upload, `missing diagnostic upload ${name}`);
    assert.match(upload, /if: always\(\)/u);
    assert.match(upload, /if-no-files-found: error/u);
  }
});

test('packed Android retains four specific negative controls and both positive controls', () => {
  const script = releaseWorkflow.match(
    /- name: Run packed Android physics and negative controls on an emulator[\s\S]*?script: \|\n([\s\S]*?)(?=\n {6}- )/u,
  )?.[1];
  assert.ok(script);
  const lines = script.split('\n').map((line) => line.trim());
  const controls = lines.filter((line) => line.startsWith('set +e; node '));
  assert.equal(controls.length, 4);
  assert.equal(lines.filter((line) => line.startsWith('node ')).length, 2);
  const masked = lines.findIndex((line) => line.startsWith('THREENATIVE_PHYSICS_CONTROL=masked '));
  const maskedNegative = lines.findIndex((line) => line.includes('android-masked-physics-control.log'));
  const gravity = lines.findIndex((line) => line.startsWith('THREENATIVE_PHYSICS_CONTROL=wrong-gravity '));
  assert.ok(masked < maskedNegative && maskedNegative < gravity);
  for (const [log, scenario, marker] of [
    ['wrong-height', 'physics-wrong-height', 'TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED'],
    ['mask-control', 'physics-mask', 'TN_PLAYTEST_MOVEMENT_ASSERTION_FAILED'],
    ['masked-physics-control', 'physics', 'TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED'],
    ['wrong-gravity', 'physics', 'TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED'],
  ]) {
    const command = controls.find((line) => line.includes(`android-${log}.log`));
    assert.ok(command?.includes(`/playtests/${scenario}.playtest.json`), log);
    assert.ok(command.includes(`grep -F ${marker} `), log);
    const directory = makeTempDirSync('threenative-prd-078-android-');
    writeFileSync(join(directory, 'node'), '#!/bin/sh\nprintf "%s\\n" "$MOCK_MARKER"\nexit "$MOCK_STATUS"\n');
    chmodSync(join(directory, 'node'), 0o755);
    // This executes the shell guard, not a native frame or a physics simulation.
    // NB: never pass -euo as separate argv entries; bash reads the first as $0
    // with `set -u` active and aborts on `$1`.
    for (const [status, output, expected] of [[1, marker, 0], [0, marker, 1], [2, marker, 1], [1, 'TN_UNRELATED_FAILURE', 1]]) {
      const result = spawnSync('bash', ['-c', `set -euo pipefail\n${command}`], {
        env: { ...process.env, RUNNER_TEMP: directory, CONSUMER_TARGET: directory,
          GITHUB_WORKSPACE: directory, MOCK_STATUS: String(status), MOCK_MARKER: output,
          // The control commands pass `--package "$CONSUMER_APP_ID"`. The guard runs under
          // `set -u`, so leaving it unset aborts the shell before the assertion it is meant to
          // exercise and every case fails on the harness rather than on the guard.
          CONSUMER_APP_ID: 'com.threenative.proof',
          PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8',
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expected, `${log}: ${status}/${output}`);
    }
  }
});
// End PRD-078 executable contracts.

test('release side effects require the exact releaseCandidateV1 preflight', () => {
  const preflight = 'pnpm tsx scripts/release-candidate-gate.ts validate --candidate release/release-candidate.json';
  expect(releaseWorkflow).toContain(preflight);
  expect(releaseWorkflow).toMatch(
    /validate-tag:\n {4}outputs:\n {6}candidate_sha: \$\{\{ steps\.release-candidate\.outputs\.candidate_sha \}\}/u,
  );
  expect(releaseWorkflow).toContain('id: release-candidate');
  expect(releaseWorkflow).toContain('echo "candidate_sha=$GITHUB_SHA" >> "$GITHUB_OUTPUT"');

  const job = (name) => {
    const start = releaseWorkflow.indexOf(`  ${name}:`);
    const tail = releaseWorkflow.slice(start + name.length + 3);
    const next = tail.search(/\n {2}[a-z][a-z0-9-]*:/u);
    return releaseWorkflow.slice(start, next < 0 ? undefined : start + name.length + 3 + next);
  };
  for (const name of [
    'gates',
    'build',
    'build-android',
    'build-ios-simulator',
    'publish',
    'clean-consumer',
    'clean-consumer-ios',
    'finalize',
    'cleanup-failed-release',
  ]) {
    expect(job(name), `${name} must depend directly on validate-tag`).toMatch(/needs:[^\n]*validate-tag/u);
  }
  expect(releaseWorkflow.indexOf(preflight)).toBeLessThan(
    releaseWorkflow.indexOf('pnpm --filter @threenative/runtime-native native:build'),
  );
  expect(releaseWorkflow.indexOf(preflight)).toBeLessThan(
    releaseWorkflow.indexOf('gh release create'),
  );
});

test('release consumes one successful exact-SHA candidate artifact and verifies registry bytes', () => {
  expect(candidateWorkflow).toContain('workflow_dispatch:');
  expect(candidateWorkflow).toContain('candidate_request:');
  expect(candidateWorkflow).toContain('scripts/release-candidate-gate.ts resolve');
  expect(candidateWorkflow).toContain('actions/upload-artifact@v7');
  for (const token of [
    'secrets.NPM_TOKEN != \'\'',
    'secrets.WINDOWS_SIGNING_CERTIFICATE != \'\'',
    'inputs.windows_runner',
    'inputs.timestamp_service',
  ]) {
    expect(candidateWorkflow).toContain(token);
  }
  expect(releaseWorkflow).toContain('--workflow release-candidate.yml');
  expect(releaseWorkflow).toContain('gh run download "$candidate_run"');
  expect(releaseWorkflow).toContain('release-candidate-$GITHUB_SHA');
  expect(releaseWorkflow).toContain('--producer-run-id "$PRODUCER_RUN_ID"');
  expect(releaseWorkflow).toContain('--verify-registry');
});

test('worker idle wake gate ships in the native package suite without requiring CMake', () => {
  // PRD P2-1: the worker wake regression is a source-level gate so the default
  // repository lane executes it; native compilation stays opt-in.
  const vitestConfig = readFileSync(
    fileURLToPath(new URL('../vitest.config.ts', import.meta.url)),
    'utf8',
  );
  expect(vitestConfig).toContain('tests/**/*.test.{ts,mjs}');
  const workerGate = readFileSync(
    fileURLToPath(new URL('./worker-idle.test.mjs', import.meta.url)),
    'utf8',
  );
  expect(workerGate).toContain('RED observed: idle wake bound exceeded');
  expect(workerGate).toContain('RED observed: worker join timeout');
  expect(workerGate).toContain('TN_WORKER_WAKE_BIN');
  // The desktop lane that would carry the runtime measurement still builds the host.
  expect(workflow).toContain('pnpm --filter @threenative/runtime-native native:build');
});

test('the production worker contract is registered in the native lane', () => {
  // PRD-250 Phase 2: the clone, error and teardown semantics are proven against real worker
  // threads, not against the source. CMake must build and register that executable, and the
  // harness must require every contract by name so a silently dropped one cannot read as a pass.
  const cmake = readFileSync(
    fileURLToPath(new URL('../CMakeLists.txt', import.meta.url)),
    'utf8',
  );
  expect(cmake).toContain('tests/worker_production_test.cpp');
  expect(cmake).toContain('tn_register_contract_test(threenative-worker-production-test)');

  const gate = readFileSync(
    fileURLToPath(new URL('./native-worker-production.test.mjs', import.meta.url)),
    'utf8',
  );
  expect(gate).toContain('TN_NATIVE_WORKER_BIN');
  // Absent binary reports UNVERIFIED; it must never be spelled as a pass.
  expect(gate).toContain('TN_NATIVE_WORKER_CONTRACT:UNVERIFIED');
  for (const contract of [
    'fifoAcrossHandlerRegistration',
    'cloneMatrixRoundTrip',
    'cloneRefusalNamed',
    'workerSideCloneRefusalReachesError',
    'topLevelThrowReachesError',
    'handlerThrowReachesError',
    'finalMessageSurvivesSelfClose',
    'terminateStopsCallbacks',
    'shutdownJoinsEveryWorker',
    'registryReopensForASecondRuntime',
  ]) {
    expect(gate, `the native lane stopped requiring ${contract}`).toContain(contract);
  }
});

test('native physics controls assert the parity scene surface', () => {
  const normal = smokeScenario('physics.playtest.json');
  const desktop = smokeScenario('physics-desktop.playtest.json');
  const wrongHeight = smokeScenario('physics-wrong-height.playtest.json');
  const masked = smokeScenario('physics-mask.playtest.json');
  expect(normal.target).toBe('web');
  expect(desktop.target).toBe('desktop');
  expect(desktop.assert).toEqual(normal.assert);
  expect(normal.assert.resources.map(({ path }) => path)).toEqual([
    'parity.steps',
    'parity.grounded',
    'parity.spatialQuery.rayDistance',
    'parity.spatialQuery.rayNormal',
    'parity.spatialQuery.rayPosition',
    'parity.spatialQuery.shapeCount',
    'parity.spatialQuery.pointCount',
    'parity.spatialQuery.pointMissCount',
    'parity.spatialQuery.pointMaskedHitCount',
    'parity.spatialQuery.shapeMissCount',
    'parity.spatialQuery.shapeMaskedHitCount',
    'parity.spatialQuery.clearHitCount',
    'parity.spatialQuery.maskedHitCount',
  ]);
  expect(normal.assert.movement.entity).toBe('dynamicBox');
  expect(normal.assert.movement.minDistance).toBe(0.5);
  expect(
    normal.assert.resources.find(({ path }) => path === 'parity.grounded').allowTrivial,
  ).toBeTypeOf('string');
  expect(wrongHeight.assert.movement.entity).toBe('dynamicBox');
  expect(masked.assert.resources.map(({ path }) => path)).toEqual([
    'parity.collisionEventSet',
    'parity.control',
  ]);
});

test('PRD-221 uses the existing native producer rather than a duplicate investigation workflow', () => {
  const workflows = readdirSync(new URL('../../../.github/workflows/', import.meta.url));
  expect(workflows.filter((name) => /^prd-221-.*\.yml$/u.test(name))).toEqual([]);
});

test('release provenance is generated and validated before publishing release assets', () => {
  // PRD-059 Phase 3 release-provenance + release-wiring gates. Publication is
  // ordered after receipt/SBOM/license/provenance validation: the provenance
  // generator runs before `gh release create`, and removing it fails this test.
  const provenanceStep = releaseWorkflow.indexOf('generate-native-release-provenance.mjs');
  expect(provenanceStep).toBeGreaterThan(-1);
  const publishStep = releaseWorkflow.indexOf('gh release create');
  expect(provenanceStep).toBeLessThan(publishStep);
  expect(releaseWorkflow).toContain('generate-native-sbom.mjs');
  expect(releaseWorkflow).toContain('native-release-provenance.json');
  // Negative control: a workflow copy without the generator must not satisfy
  // this gate — asserted by construction, since the tokens above are absent.
  const stripped = releaseWorkflow.replaceAll('generate-native-release-provenance.mjs', 'REMOVED-GENERATOR');
  expect(stripped).not.toContain('generate-native-release-provenance.mjs');
});

test('release publication uploads regular files only, never the compliance directory', () => {
  // `release/*` expanded to `release/compliance`, the directory the SBOM step writes, and
  // `gh release create` refused it — `read release/compliance: is a directory` — after every
  // build had already passed (run 36149533979). The step must enumerate regular files, and a
  // directory sitting under `release/` must never reach the upload argument list.
  const step = releaseWorkflow.match(
    /- name: Publish runtimes and checksum lock\n[\s\S]*?run: \|\n([\s\S]*?)(?=\n {6}- |\n {2}[a-z0-9-]+:)/u,
  )?.[1];
  assert.ok(step, 'the publication step must remain reachable');
  // The command, not the comment above it that also names `gh release create`.
  const publish = step.search(/^\s*gh release create/mu);
  assert.ok(publish > -1, 'the step must still publish through gh release create');
  // The upload argument is the files-only array, never the bare directory-including glob.
  assert.match(step.slice(publish), /gh release create[^\n]*"\$\{assets\[@\]\}"/u);
  assert.doesNotMatch(step.slice(publish), /release\/\*/u);

  // Reproduce the failure on a real fixture: a genuine asset beside the compliance directory.
  const directory = makeTempDirSync('threenative-release-assets-');
  mkdirSync(join(directory, 'release', 'compliance'), { recursive: true });
  writeFileSync(join(directory, 'release', 'prebuilt-lock.json'), '{}');
  writeFileSync(join(directory, 'release', 'compliance', 'native-dependencies.cdx.json'), '{}');
  // Negative control: the old glob really did carry the directory into the upload.
  const glob = spawnSync('bash', ['-c', 'printf "%s\\n" release/*'], { cwd: directory, encoding: 'utf8' });
  assert.match(glob.stdout, /^release\/compliance$/mu);
  // The shipped expansion drops it, so `gh release create` receives only regular files.
  const expansion = step
    .slice(0, publish)
    .split('\n')
    .map((line) => line.replace(/^\x20{10}/u, ''))
    .join('\n')
    .trim();
  const listed = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\n${expansion}\nprintf '%s\\n' "\${assets[@]}"`],
    { cwd: directory, encoding: 'utf8' },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim(), 'release/prebuilt-lock.json');
  assert.doesNotMatch(listed.stdout, /compliance/u);
});

test('a dedicated job publishes gate-schema candidate evidence reports', () => {
  // The release-candidate gate resolves parity/provenance reports by artifact
  // reference. These were emitted from android-emulator-parity on the premise
  // that it holds all three conformance reports; it does not - desktop is
  // produced by desktop-parity, a sibling job - so the generator exited
  // non-zero on every run, the step swallowed it, and both uploads warned
  // instead of failing. Run 34618061045 was green and carried neither
  // artifact. The reports now come from a job downstream of both legs.
  const job = workflow.match(
    /\n {2}release-reports:\n[\s\S]*?(?=\n {2}[a-z0-9-]+:|\s*$)/u,
  )?.[0] ?? '';
  expect(job).toContain('needs: [scope, android-emulator-parity, desktop-parity]');
  expect(job).toContain('generate-release-reports.mjs');
  expect(job).toContain('name: native-release-parity');
  expect(job).toContain('reports/parity.json');
  expect(job).toContain('name: native-release-provenance');
  expect(job).toContain('reports/provenance.json');
  // Each subject is read from the artifact that actually produced it.
  expect(job).toContain('--android evidence/android/conformance/android/report.json');
  expect(job).toContain('--desktop evidence/desktop/conformance/desktop/report.json');
  expect(job).toContain('--web evidence/desktop/conformance/web/report.json');
  // `warn` is what let a green run ship with no reports; both uploads fail closed now.
  expect(job).not.toContain('if-no-files-found: warn');
  // The artifact must carry `reports/parity.json`, the exact path the candidate gate resolves.
  // upload-artifact strips everything before the first wildcard, so a bare `reports/parity.json`
  // flattened to `parity.json` and the gate refused it ("missing the exact report path"). The
  // leading wildcard keeps the `reports/` directory inside the artifact.
  expect(job).toContain('path: "*/parity.json"');
  expect(job).toContain('path: "*/provenance.json"');
  expect(job).not.toMatch(/path: reports\/parity\.json/u);
  expect(job).not.toMatch(/path: reports\/provenance\.json/u);
});

// --- PRD-221 phase 3: an observed page size, or no 16 KB qualification -------------------------

test('rejects a 16 KB qualification whose page size was never observed', () => {
	// The whole point of the gate: a lane that never asked the device must not report a pass.
	expect(() => assertObservedPageSize(undefined)).toThrow(/TN_ANDROID_PAGE_SIZE_MISSING/u);
	expect(() => assertObservedPageSize('')).toThrow(/TN_ANDROID_PAGE_SIZE_EMPTY/u);
	expect(() => assertObservedPageSize('   \r\n')).toThrow(/TN_ANDROID_PAGE_SIZE_EMPTY/u);
});

test('rejects a 16 KB qualification observed on an ordinary 4 KB image', () => {
	expect(() => assertObservedPageSize('4096')).toThrow(/TN_ANDROID_PAGE_SIZE_MISMATCH/u);
	// And it says which image would actually qualify, rather than only that the number is wrong.
	expect(() => assertObservedPageSize('4096')).toThrow(/google_apis_ps16k/u);
});

test('accepts the 16 KB observation adb actually prints', () => {
	// adb hands back CRLF from the device shell; an unstripped \r makes Number() NaN.
	assert.equal(assertObservedPageSize('16384\r\n'), ANDROID_16KB_PAGE_SIZE);
	assert.equal(assertObservedPageSize('16384'), ANDROID_16KB_PAGE_SIZE);
});

test('refuses anything that is not a page size, rather than coercing it', () => {
	for (const junk of ['error: device offline', '16384 bytes', '0', '-1', '1.5e4']) {
		expect(() => assertObservedPageSize(junk)).toThrow(/TN_ANDROID_PAGE_SIZE_MALFORMED|TN_ANDROID_PAGE_SIZE_MISMATCH/u);
	}
	expect(() => assertObservedPageSize(16384)).toThrow(/TN_ANDROID_PAGE_SIZE_MALFORMED/u);
});

test('the 4 KB lane asserts its own page size with the same function', () => {
	assert.equal(assertObservedPageSize('4096', ANDROID_4KB_PAGE_SIZE), ANDROID_4KB_PAGE_SIZE);
	expect(() => assertObservedPageSize('16384', ANDROID_4KB_PAGE_SIZE)).toThrow(
		/TN_ANDROID_PAGE_SIZE_MISMATCH/u,
	);
	// A page size this repository does not qualify is a caller bug, not a device result.
	expect(() => assertObservedPageSize('8192', 8192)).toThrow(/TN_ANDROID_PAGE_SIZE_EXPECTATION/u);
});

test('the emulator lane records the page size it ran on', () => {
	// Without this the workflow can run a 16 KB image and never write down that it did, which is
	// the same evidentiary hole as running a 4 KB one.
	assert.match(workflow, /getconf PAGE_SIZE/u);
	assert.match(workflow, /check-android-page-size\.mjs/u);
	// The expected size is data on the job, not a literal buried in a script step, so pointing the
	// lane at a 16 KB image is a value change rather than a code change.
	assert.match(workflow, /TN_ANDROID_EXPECTED_PAGE_SIZE/u);
});
