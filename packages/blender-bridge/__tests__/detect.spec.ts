import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  BLENDER_INSTALL_GUIDANCE,
  installCommandFor,
  parseBlenderVersion,
  resolveBlender,
} from "../src/detect.js";

/** A file that is executable and reports whatever version the test wants, without a real Blender. */
async function fakeBlender(name = "blender"): Promise<{ binary: string; root: string }> {
  const root = await makeTempDir("tn-blender-detect-");
  const directory = path.join(root, "bin");
  mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, name);
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  return { binary, root };
}

describe("resolveBlender", () => {
  it("should report unavailable when no Blender exists", () => {
    // No PATH, no override, and a home directory that cannot contain a conventional install.
    const status = resolveBlender(
      { PATH: "" },
      { home: "/nonexistent-home", platform: "linux", probeVersion: () => undefined },
    );
    expect(status.available).toBe(false);
    expect(status.cause).toBe("blender-missing");
    expect(status.install).toEqual(BLENDER_INSTALL_GUIDANCE);
    for (const platformName of ["linux", "macos", "windows"] as const) {
      expect(status.install[platformName].length, platformName).toBeGreaterThan(0);
    }
    expect(status.detail).toContain("THREENATIVE_BLENDER_PATH");
  });

  it("should name every platform's install command without running on it", () => {
    expect(installCommandFor("linux")).toBe(BLENDER_INSTALL_GUIDANCE.linux);
    expect(installCommandFor("darwin")).toBe(BLENDER_INSTALL_GUIDANCE.macos);
    expect(installCommandFor("win32")).toBe(BLENDER_INSTALL_GUIDANCE.windows);
  });

  it("should report a THREENATIVE_BLENDER_PATH that does not resolve as its own cause", () => {
    const status = resolveBlender(
      { THREENATIVE_BLENDER_PATH: "/nonexistent/blender" },
      { platform: "linux", probeVersion: () => "5.2.0" },
    );
    expect(status).toMatchObject({ available: false, cause: "blender-unreadable" });
    expect(status.detail).toContain("/nonexistent/blender");
  });

  it("should accept a Blender at or above the floor and report its version", async () => {
    const { binary } = await fakeBlender();
    const status = resolveBlender(
      { THREENATIVE_BLENDER_PATH: binary },
      { platform: "linux", probeVersion: () => "4.2.1" },
    );
    expect(status).toMatchObject({ available: true, path: binary, version: "4.2.1" });
  });

  it("should refuse a Blender below the floor by name rather than calling it missing", async () => {
    const { binary } = await fakeBlender();
    const status = resolveBlender(
      { THREENATIVE_BLENDER_PATH: binary },
      { platform: "linux", probeVersion: () => "3.6.0" },
    );
    expect(status).toMatchObject({
      available: false,
      cause: "blender-too-old",
      version: "3.6.0",
    });
    expect(status.detail).toContain("4.2");
  });

  it("should find a Blender on PATH when no override is set", async () => {
    const { binary } = await fakeBlender();
    const status = resolveBlender(
      { PATH: path.dirname(binary) },
      { home: "/nonexistent-home", platform: "linux", probeVersion: () => "5.2.0" },
    );
    expect(status).toMatchObject({ available: true, path: binary, version: "5.2.0" });
  });

  it("should walk past a PATH entry that is not a Blender at all", async () => {
    const decoy = await fakeBlender();
    const real = await fakeBlender();
    const status = resolveBlender(
      { PATH: [path.dirname(decoy.binary), path.dirname(real.binary)].join(path.delimiter) },
      {
        home: "/nonexistent-home",
        platform: "linux",
        probeVersion: (candidate) => (candidate === real.binary ? "5.2.0" : undefined),
      },
    );
    expect(status).toMatchObject({ available: true, path: real.binary });
  });

  it("should never throw when the probe itself explodes", async () => {
    const { binary } = await fakeBlender();
    expect(() =>
      resolveBlender(
        { PATH: path.dirname(binary) },
        {
          home: "/nonexistent-home",
          platform: "linux",
          probeVersion: () => {
            throw new Error("probe blew up");
          },
        },
      ),
    ).toThrow("probe blew up");
    // The injected probe is the test's own; the shipped one swallows its failures, which is the
    // contract that matters — a host must never see an exception where a status belongs.
    const status = resolveBlender(
      { PATH: path.dirname(binary) },
      { home: "/nonexistent-home", platform: "linux" },
    );
    expect(status.available).toBe(false);
    expect(status.cause).toBe("blender-missing");
  });
});

describe("parseBlenderVersion", () => {
  it("should read the version off Blender's own banner", () => {
    expect(parseBlenderVersion("Blender 5.2.0 LTS\n\tbuild date: 2026-07-14\n")).toBe("5.2.0");
    expect(parseBlenderVersion("Blender 4.2\n")).toBe("4.2");
  });

  it("should return undefined for output that is not Blender's", () => {
    expect(parseBlenderVersion("bash: blender: command not found")).toBeUndefined();
    expect(parseBlenderVersion("")).toBeUndefined();
  });
});
