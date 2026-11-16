import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

/**
 * A read the frame pass cannot serve fails one call, never the host. A scene the engine refuses is the
 * same: `refuse()` names the call in tnw_web_error, prints it once, and leaves `tnw_web_poll` answering
 * Ready so the renderer keeps drawing and the page's next start reports its own result. `fail()` sets
 * `state = Failed`, which stops every later tnw_web_* call of the page — wrong for a call the game makes
 * with a slot name the frame pass may not write, and wrong for content the engine cannot draw (PRD-894).
 *
 * This loads the real Wasm host in Chromium (WebGPU, under a private Xvfb), asks it to read a colour
 * attachment no frame pass wrote, then asks it to prepare a scene whose background it refuses and to
 * prepare the same scene once fixed. It checks the answers: no read id, each refusal named in the error,
 * and the host still Ready after every one of them. It needs the built engine (`pnpm wasm:build`),
 * Chromium and Xvfb, so a tree without them skips it; `TN_WEB_HOST_REQUIRE=1` makes that a failure.
 */
const web = (file) => fileURLToPath(new URL(`../build/web/${file}`, import.meta.url));
const xvfb = fileURLToPath(new URL('../../../scripts/xvfb.sh', import.meta.url));
const probe = fileURLToPath(new URL('./fixtures/web-host-refusal-probe.mjs', import.meta.url));
const built = existsSync(web('tn-native-engine-web.mjs')) && existsSync(web('tn-native-engine-web.wasm'));
if (process.env.TN_WEB_HOST_REQUIRE === '1') {
  assert.ok(built, 'TN_WEB_HOST_REQUIRE=1 needs build/web/tn-native-engine-web.{mjs,wasm}: run pnpm wasm:build');
}
const hostTest = built && process.platform === 'linux' ? test : test.skip;

hostTest('a frame pass that writes no MRT slot refuses its read and the host keeps running', () => {
  const run = spawnSync('sh', [xvfb, process.execPath, probe], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  const line = run.stdout.split('\n').find((entry) => entry.startsWith('TN_WEB_HOST_PROBE:'));
  assert.ok(line, `the probe printed no result\n${run.stdout.slice(-800)}\n${run.stderr.slice(-800)}`);
  const host = JSON.parse(line.slice('TN_WEB_HOST_PROBE:'.length));
  const ready = 1;
  assert.equal(host.state, ready, `the host never became ready: ${host.error}`);
  assert.equal(host.readId, 0, 'a slot nothing wrote returns no read id');
  assert.match(host.error, /TN_WASM_READ_TARGET: the frame pass writes no 'no-such-slot' colour attachment/u);
  assert.equal(host.stateAfterRead, ready, 'one refused read must not fail the host');
  assert.equal(host.stateAfterSecondRead, ready);

  // PRD-894: a scene the engine refuses is refused for that call and for no other. The refusal names
  // the property and the value, the host stays Ready, and once the game fixes the scene the same host
  // prepares it — a start after a refusal answers for itself instead of replaying a dead message.
  assert.equal(host.created, 0, 'the probe could not create a context');
  assert.equal(host.background, 0, 'the probe could not set the scene background');
  assert.equal(host.prepared, -1, 'a UVMapping background must be refused');
  assert.match(
    host.prepareError,
    /^TN_WASM_PREPARE: TN_NATIVE_BACKGROUND_UNSUPPORTED: scene\.background\.mapping is 300;/u,
    `the refusal must name the property and its value: ${host.prepareError}`,
  );
  assert.equal(host.stateAfterPrepare, ready, 'a refused scene must not fail the host');
  assert.equal(host.rendered, 1, 'a UVMapping background must be refused by an ordinary frame too');
  assert.match(
    host.renderError,
    /^TN_NATIVE_BACKGROUND_UNSUPPORTED: scene\.background\.mapping is 300;/u,
    `the frame's refusal must name the property and its value: ${host.renderError}`,
  );
  assert.equal(host.stateAfterRender, ready, 'a refused frame must not fail the host');
  assert.equal(host.mapping, 0, 'the probe could not set the texture mapping');
  assert.equal(host.replaced, 0, 'the probe could not replace the background');
  assert.equal(host.recovered, 1, `the fixed scene must prepare: ${host.prepareError}`);
  assert.equal(host.cleared, 0, 'the probe could not clear the sky');
  assert.equal(host.drawn, 0, `the frame after the refusal must draw: ${host.drawnError}`);
  assert.deepEqual(host.meshBuilt, [0, 0, 0, 0], 'the probe could not build the refused mesh');
  // PRD-895: the frame drew everything but the refused mesh, so it counts. Answering 1 made the page throw
  // from every frame the mesh stayed in, and a warm-up waiting on the bake waited out its timeout.
  assert.deepEqual(host.refusedMesh, [0, 0], 'a frame that skipped a refused mesh must still answer drawn');
  assert.match(host.refusedMeshError, /TN_NATIVE_MATERIAL_UNSUPPORTED MeshPhysicalMaterial: TN_MATERIAL_UNSUPPORTED sheen/u);
  assert.equal(host.stateAfterRefusedMesh, ready, 'a refused mesh must not fail the host');
});
