// Loads the built Wasm web host in Chromium (WebGPU), starts its device, asks it to read a frame-pass
// colour attachment that nothing wrote, and prints what the host answered as one JSON line:
//   { readId, error, stateAfterRead, stateAfterSecondRead }
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
      return { error, initialised, readId, state, stateAfterRead, stateAfterSecondRead: module._tnw_web_poll() };
    },
    { origin: `http://127.0.0.1:${port}` },
  );
  console.log(`TN_WEB_HOST_PROBE:${JSON.stringify(result)}`);
} finally {
  await browser.close();
  server.close();
}
