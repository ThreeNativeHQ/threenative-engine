import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { encodeToKTX2 } from "ktx2-encoder";
import { afterEach, test } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { build, parseBuildArgs } from "../src/build.js";

const run = promisify(execFile);
const runtimeRoot = fileURLToPath(new URL("../../runtime-native/", import.meta.url));
const originalEnv = { ...process.env };
const envKeys = ["THREENATIVE_RUNTIME_BINARY", "THREENATIVE_RUNTIME_SOURCE"];

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = originalEnv[key];
  }
});

async function callerFixture(): Promise<{ root: string; log: string }> {
  for (const key of envKeys) Reflect.deleteProperty(process.env, key);
  const root = await makeTempDir("threenative-consumer-caller-");
  const runtime = path.join(root, "node_modules/@threenative/runtime-native");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(runtime, "scripts"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"consumer-test","type":"module"}');
  await writeFile(
    path.join(root, "threenative.config.ts"),
    'export default { engine: "legacy", ui: { renderer: "native" } };\n',
  );
  await writeFile(path.join(root, "src/game.ts"), "export default {};\n");
  await writeFile(path.join(runtime, "package.json"), '{"name":"@threenative/runtime-native"}');
  await writeFile(
    path.join(runtime, "scripts/bundle.mjs"),
    `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    const output = process.argv[process.argv.indexOf('--output') + 1];
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, 'export default {};');
  `,
  );
  const log = path.join(root, "packager-args.json");
  await writeFile(path.join(root, "selected-runtime"), "fixture runtime: unknown engine");
  for (const target of ["desktop", "android", "ios"]) {
    await writeFile(
      path.join(runtime, `scripts/package-${target}.mjs`),
      `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { dirname } from 'node:path';
      import { pathToFileURL } from 'node:url';
      export async function resolveDesktopRuntime(explicit) {
        return explicit ?? ${JSON.stringify(path.join(root, "selected-runtime"))};
      }
      if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
      const output = process.argv[process.argv.indexOf('--output') + 1];
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, 'packaged');
      writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
      }
    `,
    );
  }
  return { root, log };
}

test("desktop consumer caller resolves the exact package runtime before cooking", async () => {
  const { root, log } = await callerFixture();
  await build({ cwd: root, target: "desktop" });
  const args: string[] = JSON.parse(await readFile(log, "utf8"));
  assert.equal(args[args.indexOf("--runtime") + 1], path.join(root, "selected-runtime"));
});

test("desktop caller preserves an explicit maintainer binary including spaces", async () => {
  const { root, log } = await callerFixture();
  process.env.THREENATIVE_RUNTIME_BINARY = path.join(root, "custom runtime");
  await build({ cwd: root, target: "desktop" });
  const args: string[] = JSON.parse(await readFile(log, "utf8"));
  assert.equal(args[args.indexOf("--runtime") + 1], process.env.THREENATIVE_RUNTIME_BINARY);
});

test("a codec refusal in the live desktop build preserves the previous packaged artifact", async () => {
  const { root, log } = await callerFixture();
  await mkdir(path.join(root, "assets"));
  await mkdir(path.join(root, "dist-native"));
  const final = path.join(root, "dist-native/consumer-test");
  await writeFile(final, "previous working package");
  const ktx2 = await encodeToKTX2(new Uint8Array([0]), {
    generateMipmap: false,
    imageDecoder: async () => ({ data: new Uint8Array(4 * 4 * 4).fill(255), height: 4, width: 4 }),
    isUASTC: true,
  });
  await writeFile(path.join(root, "assets/rock.ktx2"), ktx2);
  await assert.rejects(
    build({ cwd: root, target: "desktop" }),
    /TN_NATIVE_KTX2_UNSUPPORTED.*rock.ktx2.*selected-runtime.*unknown.*Basis\/KTX2/u,
  );
  assert.equal(await readFile(final, "utf8"), "previous working package");
  await assert.rejects(readFile(log), { code: "ENOENT" });
});

test("Android source opt-in survives parsing and subprocess dispatch", async () => {
  const { root, log } = await callerFixture();
  const options = parseBuildArgs(["build", "--target", "android", "--allow-source-build"]);
  assert.deepEqual(options.viteArgs, []);
  await build({ ...options, cwd: root });
  const args: string[] = JSON.parse(await readFile(log, "utf8"));
  assert.equal(args.filter((arg) => arg === "--allow-source-build").length, 1);
});

test("Android source environment overrides never imply compilation permission", async () => {
  const { root, log } = await callerFixture();
  process.env.THREENATIVE_RUNTIME_SOURCE = root;
  await build({ cwd: root, target: "android" });
  assert.ok(!JSON.parse(await readFile(log, "utf8")).includes("--allow-source-build"));
});

for (const target of ["web", "desktop", "ios"] as const) {
  test(`rejects the Android-only source-build flag for ${target}`, () => {
    assert.throws(
      () => parseBuildArgs(["build", "--target", target, "--allow-source-build"]),
      /--allow-source-build.*android/u,
    );
  });
}

test("programmatic builds reject an Android opt-in on other targets", async () => {
  for (const target of ["web", "desktop", "ios"] as const) {
    await assert.rejects(
      build({ cwd: "/unused", target, allowSourceBuild: true }),
      /--allow-source-build.*android/u,
    );
  }
});

test("default parsing remains backwards compatible", () => {
  assert.deepEqual(parseBuildArgs(["build"]), { target: "web", viteArgs: [] });
  assert.deepEqual(parseBuildArgs(["build", "--target", "desktop"]), {
    target: "desktop",
    viteArgs: [],
  });
});

test("preserves web argument forwarding and rejects unrelated native flags", async () => {
  assert.deepEqual(parseBuildArgs(["build", "--outDir", "custom"]), {
    target: "web",
    viteArgs: ["--outDir", "custom"],
  });
  await assert.rejects(build({ target: "desktop", viteArgs: ["--typo"] }), /does not accept/u);
});

async function probe(
  script: string,
  body: string,
  packageDirectory = runtimeRoot,
): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import * as runtime from ${JSON.stringify(pathToFileURL(path.join(packageDirectory, "scripts", script)).href)};
    import { execFileSync } from 'node:child_process';
    import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import { join, dirname } from 'node:path';
    ${body}
  `,
    ],
    {
      env: {
        ...process.env,
        THREENATIVE_RUNTIME_SOURCE: "",
        THREENATIVE_ALLOW_INSECURE_PREBUILT: "1",
        THREENATIVE_PREBUILT_MANIFEST: path.join(packageDirectory, "missing-test-manifest.json"),
      },
      timeout: 15_000,
    },
  );
  return stdout;
}

/** One install downloads the runtime and the build tool helper that sits beside it. */
const ARTIFACTS_PER_INSTALL = 2;

async function releaseFixture() {
  const root = await makeTempDir("threenative-consumer-release-");
  const payload = Buffer.from(
    "#!/usr/bin/env node\nconst fs=require('node:fs'); fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1], 'packed');\n",
  );
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const manifestPath = path.join(root, "lock.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      artifacts: {
        "linux-x64": {
          url: `http://127.0.0.1:${address.port}/runtime`,
          sha256: createHash("sha256").update(payload).digest("hex"),
        },
        // `src/cli/tool_dispatch.cpp:52` dispatches desktop packaging to a `mystral-tools` helper
        // beside the runtime, so an install fetches it too. This server answers any path.
        "linux-x64-tools": {
          url: `http://127.0.0.1:${address.port}/tools`,
          sha256: createHash("sha256").update(payload).digest("hex"),
        },
      },
    }),
  );
  const install = {
    manifestPath,
    output: path.join(root, "runtime"),
    platform: "linux",
    arch: "x64",
  };
  return {
    root,
    install,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("desktop resolver reuses the checksum-verified install without network access", async () => {
  const fixture = await releaseFixture();
  try {
    await probe(
      "package-desktop.mjs",
      `await runtime.resolveDesktopRuntime(undefined, { install: ${JSON.stringify(fixture.install)} });`,
    );
    assert.equal(fixture.requests(), ARTIFACTS_PER_INSTALL);
  } finally {
    await fixture.close();
  }
  await probe(
    "package-desktop.mjs",
    `await runtime.resolveDesktopRuntime(undefined, { install: ${JSON.stringify(fixture.install)} });`,
  );
  assert.equal(
    await readFile(fixture.install.output, "utf8").then((text) => text.startsWith("#!")),
    true,
  );
});

for (const corruption of [
  "binary",
  "empty-binary",
  "missing-status",
  "malformed-status",
  "failed-status",
  "version",
  "key",
  "url",
  "checksum",
]) {
  test(`desktop resolver never trusts a cached install with ${corruption}`, async () => {
    const fixture = await releaseFixture();
    try {
      const call = `await runtime.resolveDesktopRuntime(undefined, { install: ${JSON.stringify(fixture.install)} });`;
      await probe("package-desktop.mjs", call);
      const statusPath = path.join(fixture.root, "install-status.json");
      if (corruption === "binary") await writeFile(fixture.install.output, "corrupt");
      else if (corruption === "empty-binary") await writeFile(fixture.install.output, "");
      else if (corruption === "malformed-status") await writeFile(statusPath, "not JSON");
      else if (corruption === "missing-status") await rm(statusPath);
      else {
        const status = JSON.parse(await readFile(statusPath, "utf8"));
        if (corruption === "failed-status") status.ok = false;
        else status[corruption === "checksum" ? "sha256" : corruption] = "stale";
        await writeFile(statusPath, JSON.stringify(status));
      }
      await probe("package-desktop.mjs", call);
      assert.equal(fixture.requests(), ARTIFACTS_PER_INSTALL * 2);
      assert.equal(JSON.parse(await readFile(statusPath, "utf8")).ok, true);
    } finally {
      await fixture.close();
    }
  });
}

test("explicit install retries invalidate old success on failure", async () => {
  const fixture = await releaseFixture();
  try {
    await probe(
      "install-prebuilt.mjs",
      `await runtime.installPrebuilt(${JSON.stringify(fixture.install)});`,
    );
  } finally {
    await fixture.close();
  }
  await assert.rejects(
    probe(
      "install-prebuilt.mjs",
      `await runtime.installPrebuilt(${JSON.stringify(fixture.install)});`,
    ),
    /fetch failed/u,
  );
  await assert.rejects(readFile(fixture.install.output));
  assert.equal(
    JSON.parse(await readFile(path.join(fixture.root, "install-status.json"), "utf8")).ok,
    false,
  );
});

test("desktop source override rejects before starting installation", async () => {
  await assert.rejects(
    probe(
      "package-desktop.mjs",
      `
    await runtime.resolveDesktopRuntime(undefined, { runtimeSource: '/maintainer/checkout' });
  `,
    ),
    /THREENATIVE_RUNTIME_SOURCE=.*no --runtime/u,
  );
});

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("desktop packaging forwards install options and emits an artifact", async () => {
  const fixture = await releaseFixture();
  const bundle = path.join(fixture.root, "game.js");
  const output = path.join(fixture.root, "game");
  await writeFile(bundle, "export default {};");
  // Copy the real scripts so a regression dropping install options cannot mutate the workspace
  // runtime or its prebuilt status. Even the negative control is entirely inside this fixture.
  const consumer = path.join(fixture.root, "consumer");
  await mkdir(path.join(consumer, "scripts"), { recursive: true });
  await copyFile(path.join(runtimeRoot, "package.json"), path.join(consumer, "package.json"));
  for (const script of [
    "package-desktop.mjs",
    "install-prebuilt.mjs",
    "asset-preflight.mjs",
    "asset-manifest.mjs",
  ]) {
    await copyFile(
      path.join(runtimeRoot, "scripts", script),
      path.join(consumer, "scripts", script),
    );
  }
  try {
    await probe(
      "package-desktop.mjs",
      `await runtime.packageDesktop(${JSON.stringify({ bundle, output, install: fixture.install })});`,
      consumer,
    );
    assert.equal(await readFile(output, "utf8"), "packed");
    assert.equal(fixture.requests(), ARTIFACTS_PER_INSTALL);
  } finally {
    await fixture.close();
  }
});

async function androidFixture(source: boolean, sdl: boolean) {
  const root = await makeTempDir("threenative-consumer-android-");
  for (const file of [
    "android/app/build.gradle.kts",
    "android/app/src/main/AndroidManifest.xml",
    "android/app/src/main/res/values/strings.xml",
    "android/app/src/main/res/values/themes.xml",
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(path.join(runtimeRoot, file), path.join(root, file));
  }
  await writeFile(
    path.join(root, "android", process.platform === "win32" ? "gradlew.bat" : "gradlew"),
    "fixture",
  );
  await writeFile(path.join(root, "bundle.js"), "export default {};");
  if (source) await writeFile(path.join(root, "CMakeLists.txt"), "# source checkout\n");
  if (sdl) {
    // Read the version from the production module instead of hardcoding a second pin.
    await probe(
      "package-android.mjs",
      `
      const directory = ${JSON.stringify(path.join(root, "third_party/sdl3-android"))};
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'SDL3-' + runtime.SDL3_ANDROID_VERSION + '.aar'), 'fixture');
    `,
    );
  }
  return root;
}

async function androidProbe(root: string, allowSourceBuild: boolean | string) {
  return probe(
    "package-android.mjs",
    `
    const root = ${JSON.stringify(root)};
    let downloads = 0;
    await runtime.packageAndroid(join(root, 'bundle.js'), undefined, undefined, undefined, undefined, {
      runtimeRoot: root, allowSourceBuild: ${JSON.stringify(allowSourceBuild)},
      ensureGradleWrapper: async () => {},
      prepareAndroidPrebuilts: async () => { downloads += 1; },
      // PRD-221: the packager censuses the finished APK, so the fixture has to be a real archive
      // carrying a library per ABI. Only the ELF reader is stubbed; these bytes are not objects.
      artifact16Kb: { runObjdump: () => 'LOAD off 0x0 vaddr 0x0 paddr 0x0 align 2**14', zipalign: false },
      // The fixture builds a stand-in archive; real zipalign/apksigner have nothing to do here.
      alignArchive: false,
      spawnSync: () => {
        const apk = join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
        mkdirSync(dirname(apk), { recursive: true });
        const staged = join(root, 'android/app/build/fixture-libs');
        for (const abi of ['arm64-v8a', 'x86_64']) {
          mkdirSync(join(staged, 'lib', abi), { recursive: true });
          writeFileSync(join(staged, 'lib', abi, 'libmystral-runtime.so'), 'fixture');
        }
        execFileSync('jar', ['--create', '--file', apk,
          '-C', staged, 'lib/arm64-v8a/libmystral-runtime.so',
          '-C', staged, 'lib/x86_64/libmystral-runtime.so']);
        return { status: 0 };
      },
    });
    console.log('downloads=' + downloads);
  `,
  );
}

for (const sdl of [false, true]) {
  test(`Android requires opt-in before dependencies (SDL present: ${sdl})`, async () => {
    const root = await androidFixture(true, sdl);
    await assert.rejects(androidProbe(root, false), /source checkout.*no explicit opt-in/u);
  });
}

test("opted-in Android checkout without SDL fails with dependency remediation", async () => {
  const root = await androidFixture(true, false);
  await assert.rejects(androidProbe(root, true), /download-deps\.mjs --android/u);
});

test("opted-in Android source builds do not download prebuilts", async () => {
  assert.match(await androidProbe(await androidFixture(true, true), true), /downloads=0/u);
});

test("published Android installs use prebuilts without source opt-in", async () => {
  assert.match(await androidProbe(await androidFixture(false, false), false), /downloads=1/u);
});

test("a string-valued Android opt-in is not accepted as permission to compile", async () => {
  await assert.rejects(
    androidProbe(await androidFixture(true, true), "true"),
    /no explicit opt-in/u,
  );
});

test("explicit desktop runtime errors remain synchronous", async () => {
  const root = await makeTempDir("threenative-consumer-explicit-");
  const bundle = path.join(root, "bundle.js");
  await writeFile(bundle, "export default {};");
  await probe(
    "package-desktop.mjs",
    `
    import assert from 'node:assert/strict';
    assert.throws(() => runtime.packageDesktop(${JSON.stringify({ bundle, runtime: path.join(root, "missing"), output: path.join(root, "game") })}), /Missing prebuilt runtime/);
  `,
  );
});

for (const change of ["missing", "different-checksum", "different-size"]) {
  test(`desktop cache cannot bypass a ${change} explicit manifest pin`, async () => {
    const fixture = await releaseFixture();
    const call = `await runtime.resolveDesktopRuntime(undefined, { install: ${JSON.stringify(fixture.install)} });`;
    try {
      await probe("package-desktop.mjs", call);
      if (change === "missing") await rm(fixture.install.manifestPath);
      else {
        const manifest = JSON.parse(await readFile(fixture.install.manifestPath, "utf8"));
        if (change === "different-checksum") {
          manifest.artifacts["linux-x64"].sha256 = "0".repeat(64);
        } else {
          manifest.artifacts["linux-x64"].size = 1;
        }
        await writeFile(fixture.install.manifestPath, JSON.stringify(manifest));
      }
      await assert.rejects(
        probe("package-desktop.mjs", call),
        /No prebuilt release manifest|Checksum verification failed|size verification failed/u,
      );
      await assert.rejects(readFile(fixture.install.output));
      assert.equal(
        JSON.parse(await readFile(path.join(fixture.root, "install-status.json"), "utf8")).ok,
        false,
      );
    } finally {
      await fixture.close();
    }
  });
}
