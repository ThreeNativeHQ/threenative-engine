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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetLoader } from "@threenative/core";
import { starterAssetsDir } from "@threenative/terrain/kit";
import { createServer } from "vite";

const example = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "strata-stage-"));
const game = join(temp, "examples/game");
const originalFetch = globalThis.fetch;
let server;
try {
  for (const dir of [
    "scripts",
    "src/world",
    "terrain",
    "local-assets/temperate/basis",
    "local-assets/landscape-pro/basis",
    "local-assets/prepared",
  ])
    mkdirSync(join(game, dir), { recursive: true });
  writeFileSync(join(game, "package.json"), JSON.stringify({ type: "module" }));
  copyFileSync(join(example, "terrain/world.json"), join(game, "terrain/world.json"));
  writeFileSync(join(game, "src/world/forest.world.json"), "world");
  const starter = join(temp, "packages/terrain/starter-assets");
  mkdirSync(starter, { recursive: true });
  writeFileSync(join(starter, "starter.bin"), "starter");
  for (const mount of ["temperate", "prepared"])
    writeFileSync(join(game, `local-assets/${mount}/licensed.bin`), mount);
  writeFileSync(join(game, "local-assets/temperate/basis/basis_transcoder.js"), "first-js");
  writeFileSync(join(game, "local-assets/temperate/basis/basis_transcoder.wasm"), "first-wasm");
  writeFileSync(join(game, "local-assets/landscape-pro/basis/basis_transcoder.js"), "later-js");
  writeFileSync(join(game, "local-assets/landscape-pro/basis/basis_transcoder.wasm"), "later-wasm");
  copyFileSync(
    join(example, "scripts/stage-native-assets.mjs"),
    join(game, "scripts/stage-native-assets.mjs"),
  );
  symlinkSync(join(example, "node_modules"), join(game, "node_modules"), "dir");
  copyFileSync(join(example, "vite.config.ts"), join(game, "vite.config.ts"));
  execFileSync(process.execPath, [join(game, "scripts/stage-native-assets.mjs")]);
  assert.equal(readFileSync(join(game, "assets/world/forest.world.json"), "utf8"), "world");
  for (const [name, content] of [
    ["basis_transcoder.js", "first-js"],
    ["basis_transcoder.wasm", "first-wasm"],
  ]) {
    const staged = readFileSync(join(game, "assets/basis", name), "utf8");
    assert.equal(staged, content, `${name} keeps the first-root /basis precedence`);
    assert.equal(readFileSync(join(game, "basis", name), "utf8"), staged);
  }
  const starterDir = await starterAssetsDir();
  const staged = JSON.parse(readFileSync(join(game, "assets/assets.manifest.json"), "utf8"));
  const starterEntries = Object.fromEntries(
    Object.entries(staged.entries)
      .filter(([key]) => existsSync(join(starterDir, key)))
      .map(([key, entry]) => [key, { ...entry, output: `assets/${key}` }]),
  );
  // Legacy byte counts belong to a previous asset revision.
  writeFileSync(
    join(game, "assets.manifest.json"),
    JSON.stringify({
      version: 1,
      entries: starterEntries,
    }),
  );
  execFileSync(process.execPath, [join(game, "scripts/stage-native-assets.mjs")]);
  assert.equal(existsSync(join(game, "assets.manifest.json")), false);
  execFileSync(process.execPath, [join(game, "scripts/stage-native-assets.mjs")]);
  assert.equal(existsSync(join(game, "assets.manifest.json")), false);
  const authored = JSON.stringify({
    version: 1,
    entries: { "starter.bin": { output: "custom/starter.bin", bytes: 13 } },
  });
  writeFileSync(join(game, "assets.manifest.json"), authored);
  execFileSync(process.execPath, [join(game, "scripts/stage-native-assets.mjs")]);
  assert.equal(readFileSync(join(game, "assets.manifest.json"), "utf8"), authored);
  rmSync(join(game, "assets.manifest.json"));
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
  const authoredDecoder = join(game, "basis/basis_transcoder.js");
  unlinkSync(authoredDecoder);
  writeFileSync(authoredDecoder, "user-authored");
  let collision;
  try {
    execFileSync(process.execPath, [join(game, "scripts/stage-native-assets.mjs")], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    collision = error;
  }
  assert.match(
    String(collision?.stderr),
    /refusing to overwrite existing game-root basis\/basis_transcoder\.js/u,
  );
  assert.equal(readFileSync(authoredDecoder, "utf8"), "user-authored");
  unlinkSync(authoredDecoder);
  copyFileSync(join(game, "assets/basis/basis_transcoder.js"), authoredDecoder);

  const removedSourceWasm = join(game, "local-assets/temperate/basis/basis_transcoder.wasm");
  unlinkSync(removedSourceWasm);
  rmSync(join(game, "local-assets/landscape-pro/basis"), { recursive: true, force: true });
  let incompletePair;
  try {
    execFileSync(process.execPath, [join(game, "scripts/stage-native-assets.mjs")], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    incompletePair = error;
  }
  assert.match(String(incompletePair?.stderr), /incomplete Basis transcoder pair/u);
  assert.equal(
    readFileSync(join(game, "assets/basis/basis_transcoder.wasm"), "utf8"),
    "first-wasm",
    "a stale staged pair cannot hide a missing current source member",
  );

  rmSync(join(game, "local-assets"), { recursive: true });
  execFileSync(process.execPath, [join(game, "scripts/stage-native-assets.mjs")]);
  await assert.rejects(createAssetLoader().resolve("temperate/licensed.bin"), /not listed/);
  console.log(
    "PASS: stage then web/native preserve licensed bytes; root Basis pair keeps first-mount precedence, detects incomplete current inputs, and refuses authored-file overwrite",
  );
} finally {
  globalThis.fetch = originalFetch;
  await server?.close();
  rmSync(temp, { recursive: true, force: true });
}
