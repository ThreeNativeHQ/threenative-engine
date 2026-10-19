/**
 * Records the TSL compute reference: programs.js runs in headed Chromium's WebGPU (the pinned
 * three, the real core GPUParticles3D), and every storage buffer it reads back is written to
 * compute_reference.json as base64 f32 bytes. The native test (tsl_compute_test.cpp) runs the same
 * programs authored with the native builder and compares against this file.
 *
 * A GPU reference is recorded, not regenerated in CI: run
 *   sh scripts/xvfb.sh pnpm exec tsx packages/runtime-native/tests/native-engine/tsl-compute/compute-reference.ts
 * A software adapter is refused, as for the render goldens.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { transformSync } from "esbuild";
import {
  CAPTURE_TIMEOUT_MS,
  SOFTWARE_ADAPTER,
  WEBGPU_BROWSER_ARGS,
  threeBuildDir,
} from "../../../../three-native/tests/compatibility/render-reference.js";

const HERE = import.meta.dirname;
const OUT = path.join(HERE, "compute_reference.json");
const CORE_SRC = path.join(HERE, "../../../../core/src");

interface IOutcome {
  error?: string;
  adapter?: Record<string, string>;
  results?: Record<string, Record<string, number[]>>;
}

function served(): Map<string, [string, string]> {
  const build = threeBuildDir();
  const files = new Map<string, [string, string]>();
  for (const name of ["three.webgpu.js", "three.core.js", "three.tsl.js"])
    files.set(`/build/${name}`, ["text/javascript", readFileSync(path.join(build, name), "utf8")]);
  files.set("/programs.js", [
    "text/javascript",
    readFileSync(path.join(HERE, "programs.js"), "utf8"),
  ]);
  // Real core classes, transpiled as served; type-only imports disappear.
  for (const name of ["particles", "fluid-field", "fluid-particles", "gpu-readback"]) {
    const source = transformSync(readFileSync(path.join(CORE_SRC, `${name}.ts`), "utf8"), {
      loader: "ts",
    });
    files.set(`/core/${name}.js`, ["text/javascript", source.code]);
  }
  files.set("/", [
    "text/html",
    [
      '<!doctype html><meta charset="utf-8">',
      '<script type="importmap">{"imports":{"three":"/build/three.webgpu.js","three/webgpu":"/build/three.webgpu.js","three/tsl":"/build/three.tsl.js"}}</script>',
      '<script type="module">',
      'import { runPrograms } from "/programs.js";',
      "runPrograms().then((r) => globalThis.__tnComputeDone(r), (e) => globalThis.__tnComputeDone({ error: String(e?.stack ?? e) }));",
      "</script>",
    ].join(""),
  ]);
  return files;
}

async function record(): Promise<IOutcome> {
  if (process.platform === "linux" && process.env.DISPLAY === undefined)
    throw new Error("TN_COMPUTE_REFERENCE_NO_DISPLAY: run it under sh scripts/xvfb.sh");
  const { chromium } = await import("@playwright/test");
  const files = served();
  const server = createServer((request, response) => {
    const file = files.get(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    if (file === undefined) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": file[0] });
    response.end(file[1]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("TN_COMPUTE_REFERENCE_NO_PORT");
  const browser = await chromium.launch({
    headless: false,
    timeout: 30_000,
    args: [...WEBGPU_BROWSER_ARGS],
  });
  try {
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on("pageerror", (error) => errors.push(error.message));
    let settle: (outcome: IOutcome) => void = () => undefined;
    const done = new Promise<IOutcome>((resolve) => {
      settle = resolve;
    });
    await tab.exposeFunction("__tnComputeDone", (outcome: IOutcome) => settle(outcome));
    await tab.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
    const outcome = await Promise.race([
      done,
      new Promise<IOutcome>((_, reject) =>
        setTimeout(
          () => reject(new Error("TN_COMPUTE_REFERENCE_TIMEOUT")),
          CAPTURE_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
    if (errors.length > 0) throw new Error(`TN_COMPUTE_REFERENCE_FAILED: ${errors.join("; ")}`);
    if (outcome.error !== undefined)
      throw new Error(`TN_COMPUTE_REFERENCE_FAILED: ${outcome.error}`);
    if (SOFTWARE_ADAPTER.test(JSON.stringify(outcome.adapter)))
      throw new Error(`TN_COMPUTE_REFERENCE_SOFTWARE_ADAPTER: ${JSON.stringify(outcome.adapter)}`);
    return outcome;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A buffer as base64 of its little-endian f32 bytes: exact, and a quarter the size of hex text. */
const encoded = (values: number[]) =>
  Buffer.from(new Float32Array(values).buffer).toString("base64");

const outcome = await record();
const programs: Record<string, Record<string, string>> = {};
for (const [name, buffers] of Object.entries(outcome.results ?? {})) {
  programs[name] = {};
  for (const [buffer, values] of Object.entries(buffers))
    (programs[name] as Record<string, string>)[buffer] = encoded(values);
}
writeFileSync(OUT, `${JSON.stringify({ adapter: outcome.adapter, programs }, null, 1)}\n`);
console.log(
  `compute reference: ${Object.keys(programs).length} programs on ${JSON.stringify(outcome.adapter)} -> ${path.relative(process.cwd(), OUT)}`,
);
