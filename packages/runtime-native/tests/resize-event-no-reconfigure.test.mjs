// The resize callback must not reconfigure the swapchain.
//
// `9d97912d6` removed a `resizeSurface` call from `dispatchResizeEvent`: a launch rotates the
// display twice before the first frame, and the reconfigure tore the surface down under the frame
// in flight. A Pixel 8 died with signal 6 right after the first frame, every run. A correct version
// defers the reconfigure to a frame boundary; until one lands, this keeps the obvious version out.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const runtime = readFileSync(fileURLToPath(new URL("../src/runtime.cpp", import.meta.url)), "utf8");

function methodBody(source, name) {
  const start = source.indexOf(`void ${name}(`);
  assert.notEqual(start, -1, `${name} is missing from runtime.cpp`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

const code = (body) => body.replace(/\/\/.*$/gmu, "");

test("dispatchResizeEvent keeps the platform window in step with the canvas", () => {
  assert.match(methodBody(runtime, "dispatchResizeEvent"), /platform::syncWindowSize\(e\.width, e\.height\)/u);
});

test("dispatchResizeEvent never reconfigures the surface", () => {
  const body = code(methodBody(runtime, "dispatchResizeEvent"));
  for (const call of [/resizeSurface\s*\(/u, /configureSurface\s*\(/u, /(?<![\w:.>])resize\s*\(/u]) {
    assert.doesNotMatch(body, call, "reconfiguring inside the resize callback aborts the process on device");
  }
});
