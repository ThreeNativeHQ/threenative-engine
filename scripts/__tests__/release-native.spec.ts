import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { scopedPrebuiltLockFindings } from "../check-publish-state.js";
import { type NativeExec, uploadNativeRelease } from "../release-native-local.js";

const REPOSITORY = "ThreeNativeHQ/threenative";
const TAG = "runtime-native-v0.3.1";

function scopedLock(keys: readonly string[]): Record<string, unknown> {
  const names: Record<string, string> = {
    "linux-x64": "threenative-runtime-linux-x64",
    "linux-x64-tools": "threenative-tools-linux-x64",
    "win32-x64": "threenative-runtime-win32-x64.exe",
  };
  return {
    schemaVersion: 1,
    version: "0.3.1",
    sourceSha: "a".repeat(40),
    requiredKeys: keys,
    artifacts: Object.fromEntries(
      keys.map((key) => [
        key,
        {
          sha256: "b".repeat(64),
          size: 4,
          url: `https://github.com/${REPOSITORY}/releases/download/${TAG}/${names[key]}`,
        },
      ]),
    ),
  };
}

function stageDirectory(root: string, keys: readonly string[], files: readonly string[]): string {
  const directory = path.join(root, "release-native");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "prebuilt-lock.json"), JSON.stringify(scopedLock(keys)));
  for (const name of files) writeFileSync(path.join(directory, name), "bytes");
  return directory;
}

function recorder(releaseExists: boolean): {
  calls: { args: readonly string[]; file: string }[];
  exec: NativeExec;
} {
  const calls: { args: readonly string[]; file: string }[] = [];
  const exec = ((file: string, args: readonly string[]) => {
    calls.push({ args: [...args], file });
    if (args[0] === "release" && args[1] === "view" && !releaseExists)
      throw new Error("release not found");
    return "";
  }) as NativeExec;
  return { calls, exec };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("pnpm release:native publishing", () => {
  it("refuses when a declared key has no staged asset and touches GitHub not at all", () => {
    const root = makeTempDirSync("release-native-refuse-");
    roots.push(root);
    const directory = stageDirectory(
      root,
      ["linux-x64", "linux-x64-tools"],
      ["threenative-runtime-linux-x64"],
    );
    const { calls, exec } = recorder(true);
    expect(() =>
      uploadNativeRelease({ directory, exec, repository: REPOSITORY, tag: TAG }),
    ).toThrow(/TN_RELEASE_NATIVE_ASSET_MISSING.*linux-x64-tools/u);
    expect(calls).toEqual([]);
  });

  it("creates when absent, uploads every asset, and uploads the lock last", () => {
    const root = makeTempDirSync("release-native-upload-");
    roots.push(root);
    const directory = stageDirectory(
      root,
      ["linux-x64", "linux-x64-tools"],
      ["threenative-runtime-linux-x64", "threenative-tools-linux-x64"],
    );
    const { calls, exec } = recorder(false);
    const result = uploadNativeRelease({ directory, exec, repository: REPOSITORY, tag: TAG });
    expect(result).toEqual({
      created: true,
      tag: TAG,
      uploaded: [
        "threenative-runtime-linux-x64",
        "threenative-tools-linux-x64",
        "prebuilt-lock.json",
      ],
    });
    expect(calls[0]?.args.slice(0, 2)).toEqual(["release", "view"]);
    expect(calls[1]?.args.slice(0, 2)).toEqual(["release", "create"]);
    const uploads = calls.filter((call) => call.args[1] === "upload");
    expect(uploads.map((call) => path.basename(call.args[3] ?? ""))).toEqual([
      "threenative-runtime-linux-x64",
      "threenative-tools-linux-x64",
      "prebuilt-lock.json",
    ]);
    for (const call of uploads) expect(call.args).toContain("--clobber");
  });

  it("is idempotent: an existing release is updated, never recreated", () => {
    const root = makeTempDirSync("release-native-idempotent-");
    roots.push(root);
    const directory = stageDirectory(
      root,
      ["linux-x64", "linux-x64-tools"],
      ["threenative-runtime-linux-x64", "threenative-tools-linux-x64"],
    );
    const { calls, exec } = recorder(true);
    const result = uploadNativeRelease({ directory, exec, repository: REPOSITORY, tag: TAG });
    expect(result.created).toBe(false);
    expect(calls.some((call) => call.args[1] === "create")).toBe(false);
    expect(calls.filter((call) => call.args[1] === "upload")).toHaveLength(3);
  });

  it("accepts a scoped lock that carries this host's key and refuses one that omits it", () => {
    const url = `https://github.com/${REPOSITORY}/releases/download/${TAG}/prebuilt-lock.json`;
    const hostKey = `${process.platform}-${process.arch}`;
    if (!["darwin-arm64", "linux-x64", "win32-x64"].includes(hostKey)) return;
    expect(scopedPrebuiltLockFindings(scopedLock([hostKey]), url)).toEqual([]);
    // A present-but-unreadable lock is not a pass: the question was not answered.
    expect(scopedPrebuiltLockFindings(undefined, url)[0]?.severity).toBe("blocked");
    const omitted = scopedPrebuiltLockFindings(
      scopedLock([hostKey === "linux-x64" ? "win32-x64" : "linux-x64"]),
      url,
    );
    expect(omitted).toHaveLength(1);
    expect(omitted[0]?.severity).toBe("fail");
    expect(omitted[0]?.detail).toContain(hostKey);
  });

  it("skips staging when the release already exists, so a scoped lock cannot clobber the official one", async () => {
    const { stageNativeRelease } = await import("../release-native-local.js");
    const calls: string[] = [];
    const exec = ((_file: string, args: readonly string[]) => {
      calls.push(args.join(" "));
      return "";
    }) as NativeExec;
    const result = await stageNativeRelease({ exec, repo: process.cwd(), skipIfReleased: true });
    expect(result).toBeUndefined();
    expect(calls[0]).toContain("release view");
  });

  it("runs the native step after the npm publish, and staging before it", () => {
    const source = readFileSync(new URL("../release.ts", import.meta.url), "utf8");
    const publishLoop = source.indexOf("publish ${name}@${versionOf(name)}");
    const stage = source.indexOf("await stageNativeRelease(");
    const upload = source.indexOf("uploadNativeRelease({");
    expect(publishLoop).toBeGreaterThan(0);
    expect(stage).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(0);
    expect(stage).toBeLessThan(publishLoop);
    expect(upload).toBeGreaterThan(publishLoop);
    // CI must never stage, and no flag ships the npm cohort without its binaries (owner, 2026-11-01).
    expect(source).toMatch(/const local = process\.env\.GITHUB_ACTIONS !== "true"/u);
    expect(source).toMatch(/willCreateNativeRelease = publish && local/u);
    expect(source).not.toContain("allow-missing-prebuilt");
    expect(
      readFileSync(new URL("../check-publish-state.ts", import.meta.url), "utf8"),
    ).not.toContain("allow-missing-prebuilt");
    expect(source).toContain("skipIfReleased: true");
  });

  it("fails closed on an unanswerable release check and only treats a clean miss as absent", async () => {
    const { nativeReleaseExists } = await import("../release-native-local.js");
    const succeed = (() => "") as NativeExec;
    expect(nativeReleaseExists(REPOSITORY, TAG, succeed)).toBe(true);
    const missing = (() => {
      throw new Error("release not found");
    }) as unknown as NativeExec;
    expect(nativeReleaseExists(REPOSITORY, TAG, missing)).toBe(false);
    const unauthenticated = (() => {
      throw new Error("To get started with GitHub CLI, please run: gh auth login");
    }) as unknown as NativeExec;
    expect(() => nativeReleaseExists(REPOSITORY, TAG, unauthenticated)).toThrow(
      /TN_RELEASE_NATIVE_VIEW_FAILED/u,
    );
  });
});
