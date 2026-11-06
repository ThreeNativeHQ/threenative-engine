// Serves an installed consumer directory to a plain browser and runs the vanilla full-world export
// there. No Vite, no workspace: an import map points bare specifiers at the packed installs, so
// what loads is exactly what `npm install` of the tarballs put on disk.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve } from "node:path";
import { cookTerrainWorld } from "@threenative/assets";

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };
const MAP = {
  imports: {
    three: "/node_modules/three/build/three.module.js",
    "three/addons/": "/node_modules/three/examples/jsm/",
    "@threenative/terrain": "/node_modules/@threenative/terrain/dist/index.js",
    "@threenative/terrain/three": "/node_modules/@threenative/terrain/dist/three.js",
    "@threenative/terrain/export": "/node_modules/@threenative/terrain/dist/export.js",
  },
};

export async function openConsumerPage({ consumer, repo, port = 0 }) {
  const root = resolve(consumer);
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname));
    const file = path === "/" ? null : join(root, path);
    if (path === "/") {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><script type="importmap">${JSON.stringify(MAP)}</script><body>`);
    } else if (!file?.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      response.statusCode = 404;
      response.end();
    } else {
      response.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
      createReadStream(file).pipe(response);
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Consumer server has no port");
  const origin = `http://127.0.0.1:${address.port}/`;
  const { chromium } = createRequire(join(repo, "packages/playtest/package.json"))("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.exposeFunction("cookPreparedWorld", async (preparedWorld) => {
    const { worldGlb } = await cookTerrainWorld({ preparedWorld });
    return Buffer.from(worldGlb).toString("base64");
  });
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    problems.push(`external request ${route.request().url()}`);
    return route.abort();
  });
  await page.goto(origin);
  return {
    problems,
    /** Export one saved document in the page and read the file back with a plain GLTFLoader. */
    exportAndLoad: (document, revision, sampleIndices, withBytes = false) =>
      page.evaluate(
        async ([doc, rev, indices, bytes]) =>
          (await import("/world-fixture.mjs")).exportAndLoad(doc, rev, indices, bytes),
        [document, revision, sampleIndices, withBytes],
      ),
    close: async () => {
      await browser.close();
      await new Promise((done) => server.close(done));
    },
  };
}
