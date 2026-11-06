import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

/**
 * A read the frame pass cannot serve fails one call, never the host.
 *
 * `refuse()` (web_host.cpp, next to `fail()`) exists for exactly this: it names the call in
 * tnw_web_error, prints it once, and leaves `tnw_web_poll` answering Ready so the renderer keeps
 * drawing. `fail()` sets `state = Failed`, which stops every later tnw_web_* call of the page — one
 * grep-worthy bug when it guards a call the game makes with a slot name the frame pass may not write.
 *
 * The host is Wasm (emscripten + WebGPU), so the refusal convention is pinned in its source: the
 * readiness guard is the one escalation `tnw_web_read_mrt` keeps, and a slot the frame never wrote
 * is refused. Behaviour is proven by the web playtest, not here.
 */
const host = readFileSync(new URL('../src/engine/wasm/web_host.cpp', import.meta.url), 'utf8');

/** The body of a C function, braces matched from its first one. */
function body(signature) {
  const open = host.indexOf('{', host.indexOf(signature));
  assert.ok(host.indexOf(signature) >= 0 && open >= 0, `${signature} is not in the web host`);
  let depth = 0;
  for (let i = open; i < host.length; i++) {
    if (host[i] === '{') depth++;
    else if (host[i] === '}' && --depth === 0) return host.slice(open, i + 1);
  }
  return assert.fail(`${signature} has no closing brace`);
}

/** A body's code, without its comments: a comment naming a call is not a call. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');

test('a frame pass that writes no MRT slot refuses its read and the host keeps running', () => {
  const readMrt = code(body('uint32_t tnw_web_read_mrt('));
  // The one escalation the call keeps: a host that is not ready has no attachment to read from.
  assert.match(readMrt, /if \(state != Ready \|\| !renderer\) return fail\(/u);
  assert.equal(
    (readMrt.match(/\bfail\(/gu) ?? []).length,
    1,
    'a slot the frame pass never wrote is a refusal, not a dead host: use refuse()',
  );
  const started = readMrt.slice(readMrt.indexOf('if (started != GpuStatus::Ok)'));
  assert.ok(started.length > 0, 'the read no longer branches on the status it started with');
  assert.match(started, /refuse\(/u);
  assert.doesNotMatch(started, /\bfail\(/u);
});
