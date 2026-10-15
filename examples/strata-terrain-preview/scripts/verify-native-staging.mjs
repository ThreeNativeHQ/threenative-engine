import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetLoader } from "@threenative/core";
import { createServer } from "vite";

const example = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "strata-stage-"));
const game = join(temp, "examples/game");
const originalFetch = globalThis.fetch;
let server;
try {
  for (const dir of ["scripts", "terrain", "local-assets/temperate", "local-assets/prepared"])
    mkdirSync(join(game, dir), { recursive: true });
  writeFileSync(join(game, "package.json"), JSON.stringify({ type: "module" }));
  copyFileSync(join(example, "terrain/world.json"), join(game, "terrain/world.json"));
  const starter = join(temp, "packages/terrain/starter-assets");
  mkdirSync(starter, { recursive: true });
  writeFileSync(join(starter, "starter.bin"), "starter");
  for (const mount of ["temperate", "prepared"])
    writeFileSync(join(game, `local-assets/${mount}/licensed.bin`), mount);
  copyFileSync(
    join(example, "scripts/stage-native-assets.mjs"),
    join(game, "scripts/stage-native-assets.mjs"),
  );
  symlinkSync(join(example, "node_modules"), join(game, "node_modules"), "dir");
  copyFileSync(join(example, "vite.config.ts"), join(game, "vite.config.ts"));
  // Exercise migration of the exact manifest published by the old staging command.
  writeFileSync(
    join(game, "assets.manifest.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "starter.bin": { output: "assets/starter.bin", bytes: 7 },
      },
    }),
  );
  execFileSync(process.execPath, [join(game, "scripts/stage-native-assets.mjs")]);
  assert.equal(existsSync(join(game, "assets.manifest.json")), false);
  execFileSync(process.execPath, [join(game, "scripts/stage-native-assets.mjs")]);
  assert.equal(existsSync(join(game, "assets.manifest.json")), false);
  server = await createServer({
    configFile: join(game, "vite.config.ts"),
    root: game,
    server: { port: 0 },
    optimizeDeps: { noDiscovery: true },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  globalThis.fetch = (url, options) => originalFetch(new URL(url, origin), options);
  const web = createAssetLoader();
  for (const mount of ["temperate", "prepared"]) {
    const [url] = await web.resolve(`${mount}/licensed.bin`);
    assert.equal(await (await fetch(url)).text(), mount);
  }
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return new Response(readFileSync(join(game, "assets", url)), {
      headers: { "content-type": "application/json" },
    });
  };
  const native = createAssetLoader();
  for (const mount of ["temperate", "prepared"]) {
    const [url] = await native.resolve(`${mount}/licensed.bin`);
    assert.equal(await (await fetch(url)).text(), mount);
  }
  const before = requests.length;
  await assert.rejects(native.resolve("temperate/absent.glb"), /not listed/);
  assert.equal(requests.length, before, "missing optional art must fail before IO");
  assert.equal(requests.filter((url) => url === "assets.manifest.json").length, 1);
  rmSync(join(game, "local-assets"), { recursive: true });
  execFileSync(process.execPath, [join(game, "scripts/stage-native-assets.mjs")]);
  await assert.rejects(createAssetLoader().resolve("temperate/licensed.bin"), /not listed/);
  console.log(
    "PASS: stage then web/native preserve licensed bytes; absent optional art rejects without IO",
  );
} finally {
  globalThis.fetch = originalFetch;
  await server?.close();
  rmSync(temp, { recursive: true, force: true });
}
