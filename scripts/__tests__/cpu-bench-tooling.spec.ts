import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  CPU_CAPTURE_BUDGET_MS,
  LABS_NODE_FLOOR,
  LABS_PACKAGE,
  LABS_TOOL_DIR,
  assertInstalledLabs,
  assertLabsNode,
  captureTimeoutMs,
  cpuCommand,
  labsNodeExecutable,
  parseCatalogPin,
  parseCpuCaptureArgs,
  parseCpuSetupArgs,
  readToolManifestPin,
} from "../performance-regression/cpu.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function tempDirectory(): Promise<string> {
  return makeTempDir("tn-cpu-tooling-");
}

describe("isolated Labs pin", () => {
  it("takes the exact version from the workspace catalog", async () => {
    const catalog = parseCatalogPin(
      await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
    );
    const pin = await readToolManifestPin();
    expect(catalog).toBe(pin);
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps the generated manifest private, pinned and outside the workspace globs", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(LABS_TOOL_DIR, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      engines?: Record<string, string>;
      private?: boolean;
    };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies?.[LABS_PACKAGE]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.engines?.node).toBe(`>=${LABS_NODE_FLOOR}`);

    const workspace = await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toMatch(/packages:\s*\[['"]packages\/\*['"],\s*['"]examples\/\*['"]\]/);

    const root = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(root.dependencies?.[LABS_PACKAGE]).toBeUndefined();
    expect(root.devDependencies?.[LABS_PACKAGE]).toBeUndefined();
  });

  it("locks the exact artifact in the scoped lockfile", async () => {
    const lock = await readFile(path.join(LABS_TOOL_DIR, "pnpm-lock.yaml"), "utf8");
    expect(lock).toContain("'@pmndrs/labs':");
    expect(lock).toMatch(/specifier:\s*0\.9\.0/);
    expect(lock).toMatch(/version:\s*0\.9\.0/);
  });

  it("requires an explicit isolated installation instead of installing on import", async () => {
    const directory = await tempDirectory();
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({ dependencies: { [LABS_PACKAGE]: "0.9.0" }, private: true }, null, 2)}\n`,
    );
    await expect(assertInstalledLabs(directory)).rejects.toThrow("TN_CPU_BENCH_NOT_INSTALLED");
  });
});

describe("Node floor", () => {
  it("rejects Node versions below the Labs requirement", () => {
    expect(() => assertLabsNode("20.19.6")).toThrow("TN_CPU_BENCH_NODE_UNSUPPORTED");
    expect(() => assertLabsNode("22.11.0")).toThrow("TN_CPU_BENCH_NODE_UNSUPPORTED");
  });

  it("accepts the floor and newer versions", () => {
    for (const version of [LABS_NODE_FLOOR, "22.22.0", "23.0.0"]) {
      expect(() => assertLabsNode(version)).not.toThrow();
    }
  });

  it("defaults to the current process and honours TN_CPU_BENCH_NODE", () => {
    expect(labsNodeExecutable({})).toBe(process.execPath);
    expect(labsNodeExecutable({ TN_CPU_BENCH_NODE: "/opt/node22/bin/node" })).toBe(
      "/opt/node22/bin/node",
    );
  });
});

describe("CPU dispatch", () => {
  it("leaves every hardware command on its existing path", () => {
    expect(cpuCommand([])).toBeUndefined();
    expect(cpuCommand(["--arm", "tn-web", "--production"])).toBeUndefined();
    expect(cpuCommand(["--compare", "--left", "tn-web"])).toBeUndefined();
    expect(cpuCommand(["--regression", "--input", "report.json"])).toBeUndefined();
  });

  it("selects setup and capture and rejects the two together", () => {
    expect(cpuCommand(["--cpu-setup"])).toBe("setup");
    expect(cpuCommand(["--cpu", "--source", repoRoot, "--name", "candidate"])).toBe("capture");
    expect(() => cpuCommand(["--cpu", "--cpu-setup"])).toThrow("TN_CPU_BENCH_CONFLICT");
  });

  it("rejects a repeated CPU mode flag", () => {
    expect(() => cpuCommand(["--cpu", "--cpu", "--source", repoRoot])).toThrow(
      "TN_CPU_BENCH_DUPLICATE_MODE",
    );
    expect(() => cpuCommand(["--cpu-setup", "--cpu-setup"])).toThrow("TN_CPU_BENCH_DUPLICATE_MODE");
  });
});

describe("setup argument validation", () => {
  it("accepts only the bare setup flag", () => {
    expect(() => parseCpuSetupArgs(["--cpu-setup"])).not.toThrow();
  });

  it("rejects extra flags and positional arguments before an install runs", () => {
    expect(() => parseCpuSetupArgs(["--cpu-setup", "--source", repoRoot])).toThrow(
      "TN_CPU_BENCH_UNKNOWN_FLAG",
    );
    expect(() => parseCpuSetupArgs(["--cpu-setup", "--arm", "tn-web"])).toThrow(
      "TN_CPU_BENCH_UNKNOWN_FLAG",
    );
    expect(() => parseCpuSetupArgs(["--cpu-setup", "stray"])).toThrow(
      "TN_CPU_BENCH_UNEXPECTED_ARG",
    );
  });
});

describe("capture timeout override", () => {
  it("defaults to the 300 s budget and only narrows it", () => {
    expect(captureTimeoutMs({})).toBe(CPU_CAPTURE_BUDGET_MS);
    expect(captureTimeoutMs({ TN_CPU_BENCH_TIMEOUT_MS: "2500" })).toBe(2500);
  });

  it("fails closed on a non-positive, non-integer or over-budget override", () => {
    for (const value of ["0", "-1", "1.5", "abc", String(CPU_CAPTURE_BUDGET_MS + 1)]) {
      expect(() => captureTimeoutMs({ TN_CPU_BENCH_TIMEOUT_MS: value })).toThrow(
        "TN_CPU_BENCH_BAD_TIMEOUT",
      );
    }
  });
});

describe("capture argument validation", () => {
  const source = repoRoot;

  it("requires both values", () => {
    expect(() => parseCpuCaptureArgs(["--cpu"])).toThrow("TN_CPU_BENCH_SOURCE_REQUIRED");
    expect(() => parseCpuCaptureArgs(["--cpu", "--source", source])).toThrow(
      "TN_CPU_BENCH_NAME_REQUIRED",
    );
    expect(() => parseCpuCaptureArgs(["--cpu", "--source", source, "--name"])).toThrow(
      "TN_CPU_BENCH_MISSING_VALUE",
    );
  });

  it("rejects a relative or missing source checkout", () => {
    expect(() => parseCpuCaptureArgs(["--cpu", "--source", "relative", "--name", "x"])).toThrow(
      "TN_CPU_BENCH_BAD_SOURCE",
    );
    expect(() =>
      parseCpuCaptureArgs([
        "--cpu",
        "--source",
        path.join(repoRoot, "does-not-exist"),
        "--name",
        "x",
      ]),
    ).toThrow("TN_CPU_BENCH_BAD_SOURCE");
  });

  it("rejects an unsafe result name", () => {
    expect(() => parseCpuCaptureArgs(["--cpu", "--source", source, "--name", "../escape"])).toThrow(
      "TN_CPU_BENCH_BAD_NAME",
    );
  });

  it("rejects unknown and conflicting flags before a workload runs", () => {
    expect(() =>
      parseCpuCaptureArgs(["--cpu", "--source", source, "--name", "x", "--arm", "tn-web"]),
    ).toThrow("TN_CPU_BENCH_UNKNOWN_FLAG");
    expect(() =>
      parseCpuCaptureArgs(["--cpu", "stray", "--source", source, "--name", "x"]),
    ).toThrow("TN_CPU_BENCH_UNEXPECTED_ARG");
  });

  it("rejects a duplicated source, name or mode instead of taking the last value", () => {
    expect(() =>
      parseCpuCaptureArgs(["--cpu", "--source", source, "--source", source, "--name", "x"]),
    ).toThrow("TN_CPU_BENCH_DUPLICATE_FLAG");
    expect(() =>
      parseCpuCaptureArgs(["--cpu", "--source", source, "--name", "x", "--name", "y"]),
    ).toThrow("TN_CPU_BENCH_DUPLICATE_FLAG");
    expect(() =>
      parseCpuCaptureArgs(["--cpu", "--cpu", "--source", source, "--name", "x"]),
    ).toThrow("TN_CPU_BENCH_DUPLICATE_FLAG");
  });

  it("accepts a valid capture request", () => {
    expect(parseCpuCaptureArgs(["--cpu", "--source", source, "--name", "candidate-1"])).toEqual({
      name: "candidate-1",
      source,
    });
  });
});

describe("Labs isolation", () => {
  it("does not import or install Labs from the wrapper source", async () => {
    const source = await readFile(
      path.join(repoRoot, "scripts/performance-regression/cpu.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']@pmndrs\/labs["']/);
    expect(source).not.toMatch(/import\(\s*["']@pmndrs\/labs["']\s*\)/);
  });

  it("keeps the ordinary compatibility path intact under Node 20", () => {
    expect(cpuCommand(["--arm", "tn-web"])).toBeUndefined();
    expect(parseCpuCaptureArgs(["--cpu", "--source", repoRoot, "--name", "ok"]).name).toBe("ok");
  });
});
