// Same corpus TS, pinned upstream modules, and the existing reference capture's GPU recipe.
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(repo, "packages/runtime-native/package.json"));
const { transformSync, buildSync } = require("esbuild");

export async function renderReference(file, png, { shared = false } = {}) {
  const { tsImport } = await import("tsx/esm/api");
  const { launchReferenceBrowser, SOFTWARE_ADAPTER, CAPTURE_TIMEOUT_MS, threeBuildDir } =
    await tsImport(
      path.join(repo, "packages/three-native/tests/compatibility/render-reference.ts"),
      import.meta.url,
    );
  const build = threeBuildDir();
  let source = readFileSync(file, "utf8").replace(
    /from "file:[^"]*\/(three\.(?:module|webgpu|tsl)\.js)"/g,
    'from "/build/$1"',
  );
  if (shared) source = source.replace(/\bfrom\s*["']three(?:\/[\w-]+)?["']/g, `from "/facade.js"`);
  const code = transformSync(source, {
    loader: "ts",
    format: "esm",
    define: {
      "process.env": JSON.stringify(
        Object.fromEntries([
          ["TN_TSL_LAYERS", process.env.TN_TSL_LAYERS ?? "3"],
          ["TN_TSL_FRAME", ""],
        ]),
      ),
    },
  }).code;
  const files = new Map([["/fixture.js", code]]);
  for (const name of ["three.module.js", "three.webgpu.js", "three.tsl.js", "three.core.js"])
    files.set(`/build/${name}`, readFileSync(path.join(build, name), "utf8"));
  if (shared) {
    const { sharedReferenceCode } = await import("./shared-reference.mjs");
    const { names, exports } = sharedReferenceCode();
    const facadeCode = `import { bindWebEngine } from ${JSON.stringify(path.join(repo, "packages/three-native/src/browser-entry.ts"))};
import createModule from "/engine.mjs";
const bound = await bindWebEngine(() => createModule({locateFile: () => "/engine.wasm"}), ${JSON.stringify(names)});
${exports}`;
    const bundled = buildSync({
      stdin: { contents: facadeCode, resolveDir: repo, sourcefile: "facade.ts", loader: "ts" },
      bundle: true,
      format: "esm",
      target: "esnext",
      write: false,
      external: ["/engine.mjs"],
    });
    files.set("/facade.js", bundled.outputFiles[0].text);
    files.set(
      "/engine.mjs",
      readFileSync(path.join(repo, "packages/runtime-native/build/web/tn-native-engine-web.mjs")),
    );
    files.set(
      "/engine.wasm",
      readFileSync(path.join(repo, "packages/runtime-native/build/web/tn-native-engine-web.wasm")),
    );
  }
  const html = `<!doctype html><style>body{margin:0}canvas{display:block}</style>
  <script type="importmap">{"imports":{"three":"/build/three.module.js","three/webgpu":"/build/three.webgpu.js","three/tsl":"/build/three.tsl.js"}}</script>
  <script type="module">
    try {
      const { render } = await import('/fixture.js');
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
        if (kind === 'webgpu') { this.id = 'frame'; document.body.append(this); }
        return original.call(this, kind, ...args);
      };
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw Error('TN_REFERENCE_NO_ADAPTER');
      window.adapterInfo = adapter.info;
      await render();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      window.frameDone = true;
    } catch (error) { window.frameError = error?.stack ?? String(error); console.error(window.frameError); }
  </script>`;
  const server = createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const text = request.url === "/" ? html : files.get(request.url);
    response.writeHead(text === undefined ? 404 : 200, {
      "content-type":
        request.url === "/"
          ? "text/html"
          : request.url === "/engine.wasm"
            ? "application/wasm"
            : "text/javascript",
    });
    response.end(text ?? "not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let browser;
  try {
    browser = await launchReferenceBrowser();
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    const errors = [];
    let rejectFailure;
    const failure = new Promise((_, reject) => {
      rejectFailure = reject;
    });
    const fail = (message) => {
      errors.push(message);
      console.error(message);
      rejectFailure(Error(message));
    };
    page.on("console", (message) => {
      const text = `TN_REFERENCE_CONSOLE ${message.type()}: ${message.text()}`;
      if (message.type() === "error") fail(text);
      else console.error(text);
    });
    page.on("pageerror", (error) =>
      fail(`TN_REFERENCE_PAGE_ERROR ${error.stack ?? error.message}`),
    );
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/favicon.ico" || response.status() < 400) return;
      fail(
        `TN_REFERENCE_RESPONSE_FAILED ${response.url()} status=${response.status()} ${response.statusText()}`,
      );
    });
    page.on("requestfailed", async (request) => {
      if (new URL(request.url()).pathname === "/favicon.ico") return;
      const response = await request.response().catch(() => null);
      fail(
        `TN_REFERENCE_REQUEST_FAILED ${request.url()} status=${response?.status() ?? "no-response"}: ${request.failure()?.errorText}`,
      );
    });
    await Promise.race([
      (async () => {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.frameDone || window.frameError, null, {
          timeout: CAPTURE_TIMEOUT_MS,
        });
      })(),
      failure,
    ]);
    const result = await page.evaluate(() => ({
      error: window.frameError,
      info: window.adapterInfo,
    }));
    if (result.error || errors.length)
      throw Error(`TN_REFERENCE_RENDER_FAILED ${result.error ?? errors.join("; ")}`);
    if (!result.info || SOFTWARE_ADAPTER.test(Object.values(result.info).join(" ")))
      throw Error(`TN_REFERENCE_SOFTWARE_OR_MISSING_ADAPTER ${JSON.stringify(result.info)}`);
    mkdirSync(path.dirname(png), { recursive: true });
    await page.locator("#frame").screenshot({ path: png, omitBackground: true });
    console.log(`reference frame: ${png}; adapter=${JSON.stringify(result.info)}`);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
