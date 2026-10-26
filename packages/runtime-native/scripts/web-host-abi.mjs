import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The built web engine speaks the facade's web host ABI and refuses any other.
 *
 * Nothing tied the facade (create-threenative's web-engine-runtime.js) to the Wasm it runs: a facade
 * from before 39295d1f3 passed tnw_web_render no overlay argument, the new module read the frame
 * number as one, and every world frame after the first drew without post (bisect of 2026-10-24).
 * The web target runs this after each build, in Node, before any WebGPU: it fails when the module's
 * `tnw_web_host_abi()` differs from browser-renderer.ts `WEB_HOST_ABI`, or when an init that passes
 * another ABI (an older facade passes none) is not refused with TN_WASM_ABI_MISMATCH.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function facadeAbi(root = ROOT) {
  const source = readFileSync(resolve(root, "../three-native/src/browser-renderer.ts"), "utf8");
  const match = /export const WEB_HOST_ABI = (\d+);/u.exec(source);
  if (match === null) throw new Error("TN_WASM_ABI_CHECK: browser-renderer.ts declares no WEB_HOST_ABI");
  return Number(match[1]);
}

/** Loads the module from bytes, with the two browser globals its glue reads at start-up. */
async function load(directory) {
  const bytes = readFileSync(resolve(directory, "tn-native-engine-web.wasm"));
  globalThis.document ??= { querySelector: () => null };
  globalThis.window ??= globalThis;
  const fetched = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes, { headers: { "content-type": "application/wasm" } });
  try {
    const { default: create } = await import(pathToFileURL(resolve(directory, "tn-native-engine-web.mjs")).href);
    return await create({ printErr: () => undefined });
  } finally {
    globalThis.fetch = fetched;
  }
}

export async function assertWebHostAbi(directory = resolve(ROOT, "build/web"), expected = facadeAbi()) {
  const module = await load(directory);
  if (typeof module._tnw_web_host_abi !== "function")
    throw new Error(`TN_WASM_ABI_CHECK: ${directory} exports no tnw_web_host_abi; the facade expects ABI ${expected}`);
  const own = module._tnw_web_host_abi();
  if (own !== expected)
    throw new Error(`TN_WASM_ABI_CHECK: the module speaks web host ABI ${own}, the facade ${expected}`);
  const selector = module._malloc(8);
  module.stringToUTF8("!c", selector, 8);
  for (const passed of [0, expected + 1]) {
    const status = module._tnw_web_init(selector, 300, 150, passed);
    const error = module.UTF8ToString(module._tnw_web_error());
    if (status === 0 || !error.startsWith("TN_WASM_ABI_MISMATCH"))
      throw new Error(`TN_WASM_ABI_CHECK: an init with ABI ${passed} was not refused (status ${status}, "${error}")`);
  }
  return own;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const abi = await assertWebHostAbi(process.argv[2]);
  process.stdout.write(`web host ABI ${abi}: matches the facade, and another ABI is refused\n`);
}
