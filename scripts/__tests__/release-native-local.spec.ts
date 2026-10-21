import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

// The canonical names `PREBUILT_ASSET_NAMES` owns; asserted here so the assembler cannot re-spell one.
const LINUX_RUNTIME = "threenative-runtime-linux-x64";
const LINUX_TOOLS = "threenative-tools-linux-x64";

type StagedPayload = {
  readonly directory: string;
  readonly keys: readonly string[];
  readonly manifest: {
    readonly artifacts: Readonly<Record<string, unknown>>;
    readonly requiredKeys?: readonly string[];
  };
  readonly manifestPath: string;
  readonly repository: string;
  readonly tag: string;
};

async function loadAssembler(): Promise<{
  readonly stageLocalPayload: (options: Readonly<Record<string, unknown>>) => StagedPayload;
}> {
  return (await import(
    new URL("../release-native-local.mjs", import.meta.url).href
  )) as unknown as {
    stageLocalPayload: (options: Readonly<Record<string, unknown>>) => StagedPayload;
  };
}

function fixtureBuild(root: string): void {
  const build = path.join(root, "packages", "runtime-native", "build", "tn-linux");
  mkdirSync(build, { recursive: true });
  writeFileSync(path.join(build, "mystral"), "runtime bytes");
  writeFileSync(path.join(build, "mystral-tools"), "tools bytes");
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("local native payload assembler", () => {
  it("stages current Android AGP outputs even when stale old-layout files exist", async () => {
    const root = makeTempDirSync("release-native-local-android-");
    roots.push(root);
    const stripped = path.join(
      root,
      "packages/runtime-native/android/app/build/intermediates/stripped_native_libs/release",
    );
    for (const abi of ["arm64-v8a", "x86_64"]) {
      for (const [layout, content] of [
        ["stripReleaseDebugSymbols/out", "current"],
        ["out", "stale"],
      ] as const) {
        const output = path.join(stripped, layout, "lib", abi);
        mkdirSync(output, { recursive: true });
        writeFileSync(path.join(output, "libmystral-runtime.so"), `${content} ${abi}`);
      }
    }
    const { stageLocalPayload } = await loadAssembler();
    const staged = stageLocalPayload({
      repo: root,
      platform: "linux",
      arch: "x64",
      sourceSha: "a".repeat(40),
      keys: ["android-arm64-v8a-runtime-v8", "android-x86_64-runtime-v8"],
    });
    for (const abi of ["arm64-v8a", "x86_64"])
      expect(
        readFileSync(
          path.join(staged.directory, `threenative-runtime-android-${abi}-v8.so`),
          "utf8",
        ),
      ).toBe(`current ${abi}`);
  });

  it("stages exactly the declared host keys and writes a scoped lock", async () => {
    const root = makeTempDirSync("release-native-local-");
    roots.push(root);
    fixtureBuild(root);
    const { stageLocalPayload } = await loadAssembler();
    const directory = path.join(root, "release-native");
    const staged = stageLocalPayload({
      arch: "x64",
      directory,
      platform: "linux",
      repo: root,
      sourceSha: "a".repeat(40),
    });

    expect(staged.keys).toEqual(["linux-x64", "linux-x64-tools"]);
    expect(staged.tag).toBe(
      `runtime-native-v${
        JSON.parse(
          readFileSync(
            new URL("../../packages/runtime-native/package.json", import.meta.url),
            "utf8",
          ),
        ).version
      }`,
    );
    expect(staged.repository).toBe("ThreeNativeHQ/threenative-engine");
    expect(staged.manifest.requiredKeys).toEqual(["linux-x64", "linux-x64-tools"]);
    expect(Object.keys(staged.manifest.artifacts).sort()).toEqual(["linux-x64", "linux-x64-tools"]);
    for (const name of [LINUX_RUNTIME, LINUX_TOOLS]) {
      expect(statSync(path.join(directory, name)).size).toBeGreaterThan(0);
    }
    expect(readFileSync(path.join(directory, LINUX_RUNTIME), "utf8")).toBe("runtime bytes");
    expect(JSON.parse(readFileSync(staged.manifestPath, "utf8")).requiredKeys).toEqual([
      "linux-x64",
      "linux-x64-tools",
    ]);
  });

  it("refuses a missing build input, names its path, and writes no lock", async () => {
    const root = makeTempDirSync("release-native-local-missing-");
    roots.push(root);
    fixtureBuild(root);
    rmSync(path.join(root, "packages", "runtime-native", "build", "tn-linux", "mystral-tools"));
    const { stageLocalPayload } = await loadAssembler();
    const directory = path.join(root, "release-native");
    expect(() =>
      stageLocalPayload({
        arch: "x64",
        directory,
        platform: "linux",
        repo: root,
        sourceSha: "a".repeat(40),
      }),
    ).toThrow(/linux-x64-tools.*mystral-tools|mystral-tools.*TN_RELEASE_NATIVE_SOURCE_MISSING/u);
    expect(() => statSync(path.join(directory, "prebuilt-lock.json"))).toThrow();
  });
});
