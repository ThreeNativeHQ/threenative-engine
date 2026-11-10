import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

/**
 * PRD-861: the browser Wasm engine decodes a meshopt model, so the web bake can emit meshopt for it.
 *
 * Loads the built web engine in Chromium and hands `tnw_web_load_gltf` the 912-byte meshopt fixture
 * whose compressed buffer views carry no fallback bytes (see meshopt_decode_test.cpp): an engine
 * without the decoder refuses it by name, one with it returns the scene handle. A load needs no GPU,
 * so the page runs headless. It needs the built engine (`pnpm wasm:build`) and Chromium, so a tree
 * without them skips it; `TN_WEB_HOST_REQUIRE=1` makes that a failure. `TN_WEB_DIR` points it at
 * another build.
 */
const webDirectory =
  process.env.TN_WEB_DIR ?? fileURLToPath(new URL("../build/web/", import.meta.url));
const fixture = fileURLToPath(
  new URL("./native-engine/assets/meshopt-compressed.glb", import.meta.url),
);
const built = ["tn-native-engine-web.mjs", "tn-native-engine-web.wasm"].every((file) =>
  existsSync(join(webDirectory, file)),
);
if (process.env.TN_WEB_HOST_REQUIRE === "1") {
  assert.ok(
    built,
    `TN_WEB_HOST_REQUIRE=1 needs ${webDirectory}tn-native-engine-web.{mjs,wasm}: run pnpm wasm:build`,
  );
}
const hostTest = built && process.platform === "linux" ? test : test.skip;

hostTest(
  "the web engine loads a meshopt-compressed GLB through its own glTF loader",
  { timeout: 120_000 },
  async () => {
    const require = createRequire(new URL("../../playtest/package.json", import.meta.url));
    const { chromium } = require("playwright");
    const types = { ".mjs": "text/javascript", ".wasm": "application/wasm" };
    const server = createServer((request, response) => {
      const name = request.url === "/" ? "" : request.url.slice(1);
      try {
        const body =
          name === ""
            ? "<!doctype html><script>globalThis.tnImport = (url) => import(url);</script>"
            : readFileSync(join(webDirectory, name));
        response.writeHead(200, { "content-type": types[extname(name)] ?? "text/html" });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/`);
      const result = await page.evaluate(
        async ({ origin, glb }) => {
          // The page's own import(): vitest rewrites import() inside this function it transforms.
          const { default: create } = await globalThis.tnImport(
            `${origin}/tn-native-engine-web.mjs`,
          );
          const module = await create({ locateFile: (file) => `${origin}/${file}` });
          const heap = () => new DataView(module.HEAPU8.buffer);
          const version = module._malloc(32);
          module._tn_engine_version(version);
          const contextOut = module._malloc(4);
          const diagnostic = module._malloc(8);
          const created = module._tn_context_create(contextOut, version, diagnostic);
          const context = heap().getUint32(contextOut, true);
          const bytes = module._malloc(glb.length);
          module.HEAPU8.set(glb, bytes);
          const out = module._malloc(4 * 8);
          const count = module._malloc(4);
          const status = module._tnw_web_load_gltf(context, bytes, glb.length, out, 8, count);
          return {
            created,
            status,
            error: module.UTF8ToString(module._tnw_web_load_error()),
            count: heap().getUint32(count, true),
            scene: heap().getUint32(out, true),
          };
        },
        { origin, glb: [...readFileSync(fixture)] },
      );
      assert.equal(result.created, 0, "tn_context_create failed");
      assert.equal(result.error, "", "the engine refused the meshopt model");
      assert.equal(result.status, 0);
      assert.equal(result.count, 1, "one scene, no clips");
      assert.notEqual(result.scene, 0, "a scene handle");
    } finally {
      await browser.close();
      server.close();
    }
  },
);
