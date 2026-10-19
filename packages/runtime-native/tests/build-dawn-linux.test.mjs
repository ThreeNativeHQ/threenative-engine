import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, test as vitestTest } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const test = vitestTest.skipIf(process.platform === "win32");

const commit = "d14ae3d97ad74100e9f382efef5e9c0872ddbeb2";
const archive = `Dawn-${commit}-ubuntu-latest-Release.tar.gz`;
const bytes = gzipSync(Buffer.alloc(1024));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = makeTempDirSync("tn-dawn-producer-");
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  const script = join(root, "scripts/build-dawn-linux.mjs");
  cpSync(new URL("../scripts/build-dawn-linux.mjs", import.meta.url), script);
  const marker = join(root, "docker-called");
  writeFileSync(join(root, "bin/docker"), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, 'called');
if (process.env.TN_TEST_DOCKER_FAIL) process.exit(23);
const args = process.argv.slice(2);
const volume = args[args.indexOf('--volume') + 1];
if (!volume.endsWith(':/work')) process.exit(24);
if (!process.env.TN_TEST_DOCKER_NO_ARCHIVE)
  fs.writeFileSync(require('node:path').join(volume.slice(0, -6), ${JSON.stringify(archive)}), Buffer.from(${JSON.stringify(bytes.toString("base64"))}, 'base64'));
`, { mode: 0o755 });
  const output = join(root, "artifacts/dawn-linux-x64");
  const manifest = join(output, "manifest-linux-x64.json");
  const run = (args = [], env = {}) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: join(root, "bin"), ...env },
  });
  return { run, output, manifest, marker };
}

test("rejects arguments before invoking Docker or creating artifacts", () => {
  const f = fixture();
  const result = f.run(["--unexpected"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Usage:/u);
  assert.equal(existsSync(f.output), false);
  assert.equal(existsSync(f.marker), false);
});

test("propagates Docker failure without publishing a success manifest", () => {
  const f = fixture();
  const result = f.run([], { TN_TEST_DOCKER_FAIL: "1" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Dawn container failed: 23/u);
  assert.equal(existsSync(f.marker), true);
  assert.equal(existsSync(f.manifest), false);
});

test("refuses success when Docker returns without an archive", () => {
  const f = fixture();
  const result = f.run([], { TN_TEST_DOCKER_NO_ARCHIVE: "1" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ENOENT/u);
  assert.equal(existsSync(f.marker), true);
  assert.equal(existsSync(f.manifest), false);
});

test("hashes the actual synthetic archive and records pinned source and target identity", () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const actualBytes = readFileSync(join(f.output, archive));
  assert.deepEqual(actualBytes, bytes);
  assert.deepEqual(JSON.parse(readFileSync(f.manifest, "utf8")), {
    artifact_revision: 1,
    upstream_commit: commit,
    source_commit: commit,
    target: "linux-x64",
    expected_tag: "dawn-linux-x64-v1",
    toolchain: {
      container: "dockcross/manylinux_2_28-x64@sha256:5c844b0636fc4837dfa06f7ea1790c7b6cf22790b1082c3b3410320fce145c6e",
      flags: ["-C", ".github/workflows/dawn-ci.cmake", "-DCMAKE_CXX_COMPILER=g++", "-DCMAKE_C_COMPILER=gcc", "-DCMAKE_BUILD_TYPE=Release", "-DDAWN_USE_WAYLAND=ON", "-DDAWN_USE_X11=ON"],
      DAWN_FETCH_DEPENDENCIES: "ON",
      DAWN_ENABLE_INSTALL: "ON",
    },
    archive,
    archive_sha256: createHash("sha256").update(actualBytes).digest("hex"),
  });
});

test("refuses an existing output directory without overwriting prior artifacts", () => {
  const f = fixture();
  mkdirSync(f.output, { recursive: true });
  writeFileSync(f.manifest, "previous artifact");
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EEXIST/u);
  assert.equal(readFileSync(f.manifest, "utf8"), "previous artifact");
  assert.equal(existsSync(f.marker), false);
});
