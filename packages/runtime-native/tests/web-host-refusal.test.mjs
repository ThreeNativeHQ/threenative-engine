import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

/**
 * A read the frame pass cannot serve fails one call, never the host.
 *
 * `refuse()` (web_host.cpp, next to `fail()`) names the call in tnw_web_error, prints it once, and
 * leaves `tnw_web_poll` answering Ready so the renderer keeps drawing. `fail()` sets `state = Failed`,
 * which stops every later tnw_web_* call of the page: wrong for a call the game makes with a slot
 * name the frame pass may not write.
 *
 * This loads the real Wasm host in Chromium (WebGPU, under a private Xvfb), asks it to read a colour
 * attachment no frame pass wrote, and checks the answer: no read id, the call named in the error,
 * and the host still Ready after that read and after a second one. It needs the built engine
 * (`pnpm wasm:build`), Chromium and Xvfb, so a tree without them skips it; `TN_WEB_HOST_REQUIRE=1`
 * makes that a failure.
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
});
