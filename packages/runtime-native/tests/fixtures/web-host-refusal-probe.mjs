// Loads the built Wasm web host in Chromium (WebGPU), starts its device, asks it to read a frame-pass
// colour attachment that nothing wrote, then asks it to prepare a scene whose background it refuses,
// and prints what the host answered as one JSON line:
//   { readId, error, stateAfterRead, stateAfterSecondRead, prepared, prepareError, stateAfterPrepare,
//     rendered, renderError, stateAfterRender, recovered, drawn }
// Run under a display: `sh scripts/xvfb.sh node tests/fixtures/web-host-refusal-probe.mjs`.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = process.env.TN_WEB_DIR ?? fileURLToPath(new URL("../../build/web/", import.meta.url));
const require = createRequire(new URL("../../../playtest/package.json", import.meta.url));
const { chromium } = require("playwright");

const types = { ".html": "text/html", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = createServer((request, response) => {
  const name = request.url === "/" ? "page.html" : request.url.slice(1);
  try {
    const body =
      name === "page.html"
        ? '<canvas id="c" width="64" height="64"></canvas>'
        : readFileSync(join(webDirectory, name));
    response.writeHead(200, { "content-type": types[extname(name)] ?? "text/plain" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const browser = await chromium.launch({
  args: [
    "--ozone-platform=x11",
    "--enable-unsafe-webgpu",
    "--disable-gpu-sandbox",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
  ],
  headless: false,
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const result = await page.evaluate(
    async ({ origin }) => {
      const { default: create } = await import(`${origin}/tn-native-engine-web.mjs`);
      const module = await create({ locateFile: (file) => `${origin}/${file}` });
      const text = (value) => module.UTF8ToString(value);
      const withString = (value, call) => {
        const bytes = new TextEncoder().encode(`${value}\0`);
        const pointer = module._malloc(bytes.length);
        module.HEAPU8.set(bytes, pointer);
        try {
          return call(pointer);
        } finally {
          module._free(pointer);
        }
      };
      // Every read of the heap is fresh: a `_malloc` may have grown it.
      const view = () => new DataView(module.HEAPU8.buffer);
      const initialised = withString("#c", (selector) => module._tnw_web_init(selector, 64, 64, module._tnw_web_host_abi()));
      let state = module._tnw_web_poll();
      for (let i = 0; i < 600 && state === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = module._tnw_web_poll();
      }
      const read = () => withString("no-such-slot", (name) => module._tnw_web_read_mrt(name, 0, 0, 1, 1));
      const readId = read();
      const error = text(module._tnw_web_error());
      const stateAfterRead = module._tnw_web_poll();
      read();

      // The scene the engine refuses: a background texture with three's default UVMapping (300), which
      // this engine cannot draw. `tn_value_t` is a flat struct (kind, boolean, number, then the handle),
      // so a value is its kind plus a copied tn_handle_t; anything else is zero.
      const version = module._malloc(32);
      module._tn_engine_version(version);
      const contextOut = module._malloc(4);
      const diagnostic = module._malloc(8);
      const created = module._tn_context_create(contextOut, version, diagnostic);
      const context = view().getUint32(contextOut, true);
      const construct = (className) =>
        withString(className, (name) => {
          const out = module._malloc(12);
          const status = module._tn_construct(context, name, 0, 0, out, diagnostic);
          return { out, status };
        });
      const handleValue = (out) => {
        const value = module._malloc(56);
        module.HEAPU8.fill(0, value, value + 56);
        view().setUint32(value, 4, true);  // TN_VALUE_HANDLE
        module.HEAPU8.copyWithin(value + 16, out, out + 12);
        return value;
      };
      const numberValue = (number) => {
        const value = module._malloc(56);
        module.HEAPU8.fill(0, value, value + 56);
        view().setUint32(value, 1, true);  // TN_VALUE_NUMBER
        view().setFloat64(value + 8, number, true);
        return value;
      };
      const set = (handle, path, value) => withString(path, (name) => module._tn_set(handle, name, value, diagnostic));
      const scene = construct("Scene");
      const camera = construct("PerspectiveCamera");
      const unsharp = construct("Texture");
      const background = set(scene.out, "background", handleValue(unsharp.out));
      const prepared = module._tnw_web_prepare_environment(scene.out, camera.out);
      const prepareError = text(module._tnw_web_error());
      const stateAfterPrepare = module._tnw_web_poll();
      // The same scene is refused by an ordinary frame too, and the frame after a fixed one draws.
      const rendered = module._tnw_web_render(scene.out, camera.out, 0, 0, 0, 1, 0, 0);
      const renderError = text(module._tnw_web_error());
      const stateAfterRender = module._tnw_web_poll();
      // The game fixes it: the same scene with an equirectangular background is prepared by the same host.
      const sharp = construct("Texture");
      const numberAt = numberValue(303);
      const numberKind = view().getUint32(numberAt, true);
      const numberSeen = view().getFloat64(numberAt + 8, true);
      const mapping = set(sharp.out, "mapping", numberAt);
      const mappingError = text(view().getUint32(diagnostic, true));
      const replaced = set(scene.out, "background", handleValue(sharp.out));
      const recovered = module._tnw_web_prepare_environment(scene.out, camera.out);
      // A drawable background (a colour) in place of the sky this engine refuses: the next frame draws.
      const plain = construct("Color");
      const cleared = set(scene.out, "background", handleValue(plain.out));
      const drawn = module._tnw_web_render(scene.out, camera.out, 0, 0, 0, 1, 0, 0);
      const drawnError = text(module._tnw_web_error());
      // PRD-895: a mesh whose material the engine refuses by name is skipped, and the rest of the frame draws.
      const box = construct("BoxGeometry");
      const sheen = construct("MeshPhysicalMaterial");
      const mesh = construct("Mesh");
      const meshBuilt = [
        set(sheen.out, "sheen", numberValue(1)),
        set(mesh.out, "geometry", handleValue(box.out)),
        set(mesh.out, "material", handleValue(sheen.out)),
        withString("add", (name) => module._tn_invoke(scene.out, name, handleValue(mesh.out), 1, module._malloc(56), diagnostic)),
      ];
      const refusedMesh = [
        module._tnw_web_render(scene.out, camera.out, 0, 0, 0, 1, 0, 1),
        module._tnw_web_render(scene.out, camera.out, 0, 0, 0, 1, 0, 2),
      ];
      const refusedMeshError = text(module._tnw_web_error());
      const stateAfterRefusedMesh = module._tnw_web_poll();
      return {
        meshBuilt,
        refusedMesh,
        refusedMeshError,
        stateAfterRefusedMesh,
        created,
        error,
        initialised,
        mapping,
        numberKind,
        numberSeen,
        mappingError,
        background,
        prepared,
        prepareError,
        readId,
        recovered,
        replaced,
        state,
        stateAfterPrepare,
        stateAfterRead,
        stateAfterRender,
        renderError,
        rendered,
        cleared,
        drawn,
        drawnError,
        stateAfterSecondRead: module._tnw_web_poll(),
      };
    },
    { origin: `http://127.0.0.1:${port}` },
  );
  console.log(`TN_WEB_HOST_PROBE:${JSON.stringify(result)}`);
} finally {
  await browser.close();
  server.close();
}
