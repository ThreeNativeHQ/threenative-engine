import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { type IPublishPackage, type RegistryLookup, publishSet } from "../check-publish-state.js";
import {
  UPGRADE_PROOF_TEMPLATES,
  assertCleanPackageTree,
  packedTarballName,
  prepareReleaseCohort,
  proveUpgradeFromLatest,
  provisionReleaseArtifacts,
  releaseOrder,
  unpublishedReleasePackages,
  validateReleaseCohort,
  validateTemplatePins,
} from "../release.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function manifests(
  entries: readonly { deps?: readonly string[]; name: string }[],
): Promise<{ manifest: string; name: string }[]> {
  const root = await makeTempDir("threenative-release-order-");
  roots.push(root);
  return entries.map((entry) => {
    const manifest = path.join(root, `${entry.name.replace("/", "-")}.json`);
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        dependencies: Object.fromEntries((entry.deps ?? []).map((dep) => [dep, "0.2.0"])),
        name: entry.name,
      }),
    );
    return { manifest, name: entry.name };
  });
}

function candidate(name: string, version: string): IPublishPackage {
  const directory = `/packages/${name.replaceAll("/", "-")}`;
  return { directory, manifest: path.join(directory, "package.json"), name, version };
}

describe("pnpm release ordering", () => {
  it("publishes the scaffolder before the package that depends on it", async () => {
    // The instinct was "scaffolder last, its templates pin everything". It cannot be last whenever
    // something depends on it — Studio did, until it moved to its own repository. Dependency order
    // is the only rule that is always satisfiable, and this asserts the case that disproved the
    // simpler one, with a synthetic dependent now that the real one has left the workspace.
    const order = releaseOrder(
      await manifests([
        { deps: ["create-threenative"], name: "@threenative/scaffolder-consumer" },
        { name: "create-threenative" },
        { deps: ["@threenative/core"], name: "@threenative/physics" },
        { name: "@threenative/core" },
      ]),
    );

    expect(order.indexOf("create-threenative")).toBeLessThan(
      order.indexOf("@threenative/scaffolder-consumer"),
    );
  });

  it("publishes a package after the workspace packages it depends on", async () => {
    const order = releaseOrder(
      await manifests([
        { deps: ["@threenative/core"], name: "@threenative/ui" },
        { deps: ["@threenative/core"], name: "@threenative/physics" },
        { name: "@threenative/core" },
        { name: "create-threenative" },
      ]),
    );

    expect(order.indexOf("@threenative/core")).toBeLessThan(order.indexOf("@threenative/ui"));
    expect(order.indexOf("@threenative/core")).toBeLessThan(order.indexOf("@threenative/physics"));
    expect(order).toHaveLength(4);
  });

  it("refuses a dependency cycle rather than picking an arbitrary order", async () => {
    // Publishing in an order that cannot be right is worse than refusing: the failure would
    // surface as an unreproducible install days later.
    await expect(
      manifests([
        { deps: ["@threenative/b"], name: "@threenative/a" },
        { deps: ["@threenative/a"], name: "@threenative/b" },
      ]).then(releaseOrder),
    ).rejects.toThrow(/TN_RELEASE_DEPENDENCY_CYCLE/u);
  });

  it("orders every real workspace package in dependency order", async () => {
    const { publishSet } = await import("../check-publish-state.js");
    const repo = path.resolve(import.meta.dirname, "../..");
    const order = releaseOrder(publishSet(repo));

    expect(order.indexOf("@threenative/core")).toBeLessThan(order.indexOf("@threenative/physics"));
    expect(new Set(order).size).toBe(order.length);
    expect(order).toHaveLength(publishSet(repo).length);
  });

  it("keeps the guarded release path aligned with its current-set pin exception", async () => {
    const source = await fs.promises.readFile(
      path.resolve(import.meta.dirname, "../release.ts"),
      "utf8",
    );
    expect(source).toContain("allowCurrentPublishSetPins: true");
  });

  it("validates the real candidate's template pins and bundled MCP servers", () => {
    const repo = path.resolve(import.meta.dirname, "../..");
    const cohort = validateReleaseCohort(repo, publishSet(repo));

    expect(cohort.bundledMcpServers).toEqual([
      "threenative-assets",
      "threenative-sculpt",
      "threenative-engine",
      "threenative-animation",
      "threenative-devtools",
    ]);
    expect(cohort.templatePins).toEqual([]);
    expect(cohort.order).toContain("create-threenative");
  });

  it("rejects a template pin outside the candidate cohort", async () => {
    const root = await makeTempDir("threenative-release-pins-");
    roots.push(root);
    const templates = path.join(root, "templates", "starter");
    await fs.promises.mkdir(templates, { recursive: true });
    await fs.promises.writeFile(
      path.join(templates, "package.json"),
      JSON.stringify({ dependencies: { "@threenative/core": "0.2.0" } }),
    );
    const findings = validateTemplatePins(
      path.join(root, "templates"),
      new Map([["@threenative/core", "0.3.0"]]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/@threenative\/core.*0\.3\.0/u);
  });

  it("refuses preparation when a published package changed without a version bump", async () => {
    const repo = path.resolve(import.meta.dirname, "../..");
    const packages = publishSet(repo);
    const versions = new Map(packages.map((item) => [item.name, item.version]));
    await expect(
      prepareReleaseCohort({
        allowCurrentPublishSetPins: true,
        lookup: (name) => ({
          published: "2026-08-09T07:32:33.145Z",
          state: "present",
          version: versions.get(name) ?? "0.0.0",
        }),
        prebuiltProbe: () => "present",
        repo,
        sourceCommits: () => 1,
        tarballs: (item) => ({
          entries: ["package.json"],
          text: new Map([
            ["package.json", JSON.stringify({ name: item.name, version: item.version })],
          ]),
        }),
      }),
    ).rejects.toThrow(/TN_RELEASE_COHORT_RED.*@threenative\/core/u);
  });

  it("refuses a mixed candidate cohort before publishing any package", () => {
    const packages = [
      candidate("@threenative/core", "0.3.0"),
      candidate("@threenative/ui", "0.3.0"),
    ];
    const lookup: RegistryLookup = (name) =>
      name === "@threenative/core" ? { state: "absent" } : { state: "present", version: "0.3.0" };

    expect(() => unpublishedReleasePackages(packages, lookup)).toThrow(
      /TN_RELEASE_COHORT_PARTIAL.*@threenative\/ui@0\.3\.0/u,
    );
  });

  it("returns a cohort only when every candidate version is absent", () => {
    const packages = [
      candidate("@threenative/core", "0.3.0"),
      candidate("@threenative/ui", "0.3.0"),
    ];

    expect(unpublishedReleasePackages(packages, () => ({ state: "absent" }))).toEqual(packages);
  });

  it("refuses a complete cohort whose candidate versions are already published", () => {
    const packages = [
      candidate("@threenative/core", "0.3.0"),
      candidate("@threenative/ui", "0.3.0"),
    ];

    expect(() =>
      unpublishedReleasePackages(packages, () => ({ state: "present", version: "0.3.0" })),
    ).toThrow(/TN_RELEASE_COHORT_ALREADY_PUBLISHED/u);
  });

  it("fails closed when an exact candidate registry lookup is unreachable", () => {
    const packages = [candidate("@threenative/core", "0.3.0")];

    expect(() => unpublishedReleasePackages(packages, () => ({ state: "unreachable" }))).toThrow(
      /TN_RELEASE_REGISTRY_UNREACHABLE/u,
    );
  });

  it("keeps the post-build cleanliness and preflight gates before publication", async () => {
    const source = await fs.promises.readFile(
      path.resolve(import.meta.dirname, "../release.ts"),
      "utf8",
    );
    const build = source.indexOf('run("pnpm", ["build"], "pnpm build")');
    const clean = source.indexOf("assertCleanPackageTree(REPO);", build);
    const preflight = source.indexOf("const postBuildReport", build);
    const cohort = source.indexOf("const publishPackages = unpublishedReleasePackages", preflight);
    const upgrade = source.indexOf("proveUpgradeFromLatest(packages, tarballs)", cohort);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(clean).toBeGreaterThan(build);
    expect(preflight).toBeGreaterThan(clean);
    // The upgrade proof reads the previous `latest`, so it has to run before the first publish —
    // afterwards there is no N-1 left on the registry to upgrade from. And it has to run after the
    // unpublished check: a cohort whose versions npm already serves can resolve from the registry,
    // and the proof would credit those bytes to the candidate.
    expect(cohort).toBeGreaterThan(preflight);
    expect(upgrade).toBeGreaterThan(cohort);
  });

  it("upgrades the previous latest onto the packed candidate, on both named templates", async () => {
    const packages = [candidate("@threenative/core", "0.3.3")];
    const tarballs = { "@threenative/core": "/cohort/threenative-core-0.3.3.tgz" };
    const seen: {
      candidate?: { tarballs: typeof tarballs; versions: Map<string, string> };
      template?: string;
    }[] = [];
    const reports = await proveUpgradeFromLatest(packages, tarballs, (options) => {
      seen.push(options as never);
      return Promise.resolve({ consumerTargets: [], exitCode: 0, managers: [], steps: [] });
    });
    expect(reports).toHaveLength(UPGRADE_PROOF_TEMPLATES.length);
    expect(seen.map((call) => call.template)).toEqual([...UPGRADE_PROOF_TEMPLATES]);
    for (const call of seen) {
      expect(call.candidate?.tarballs).toBe(tarballs);
      expect(call.candidate?.versions.get("@threenative/core")).toBe("0.3.3");
    }
  });

  it("names the tarball `pnpm pack` will write, so the upgrade installs the candidate it packed", () => {
    expect(packedTarballName("@threenative/core", "0.3.4")).toBe("threenative-core-0.3.4.tgz");
    expect(packedTarballName("create-threenative", "0.2.7")).toBe("create-threenative-0.2.7.tgz");
  });

  it("rejects tracked package output before publication", async () => {
    const root = await makeTempDir("threenative-release-dirty-build-");
    roots.push(root);
    fs.mkdirSync(path.join(root, "packages/core"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/core/package.json"), '{"name":"core"}\n');
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
    fs.writeFileSync(
      path.join(root, "packages/core/package.json"),
      '{"name":"core","version":"0.3.0"}\n',
    );

    expect(() => assertCleanPackageTree(root)).toThrow(
      /TN_RELEASE_DIRTY_TREE[\s\S]*package\.json/u,
    );
  });
});

describe("pnpm release --dry-run --lock (PRD-629)", () => {
  it("answers the prebuilt question from the lock instead of the public release URL", async () => {
    const { prebuiltFromLock } = await import("../release.js");
    const root = await makeTempDir("threenative-release-lock-");
    roots.push(root);
    const lockPath = path.join(root, "prebuilt-lock.json");
    fs.writeFileSync(lockPath, JSON.stringify({ artifacts: {}, schemaVersion: 1 }));
    const options = prebuiltFromLock(lockPath);
    expect(options.prebuiltProbe?.("https://example.invalid/prebuilt-lock.json")).toBe("present");
    expect(options.prebuiltLock?.("https://example.invalid/prebuilt-lock.json")).toEqual({
      artifacts: {},
      schemaVersion: 1,
    });
  });

  it.each([
    [["--dry-run", "--yes"], /TN_RELEASE_FLAGS_CONFLICT/u],
    [["--lock"], /TN_RELEASE_LOCK_USAGE/u],
    [["--dry-run", "--nope"], /TN_RELEASE_UNKNOWN_FLAG/u],
  ])("refuses %j before touching the network", (args, message) => {
    let stderr = "";
    try {
      execFileSync("pnpm", ["exec", "tsx", "scripts/release.ts", ...args], {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      stderr = String((error as { stderr?: unknown }).stderr);
    }
    expect(stderr).toMatch(message);
  });
});

describe("provisionReleaseArtifacts", () => {
  function steps(current: boolean) {
    const calls = { built: 0, wrapper: [] as string[] };
    return {
      calls,
      steps: {
        webEngineCurrent: () => current,
        buildWebEngine: () => {
          calls.built += 1;
        },
        ensureGradleWrapper: async (output: string) => {
          calls.wrapper.push(output);
        },
      },
    };
  }

  it("builds a missing or stale web engine and provisions the Gradle wrapper from a fresh tree", async () => {
    const { calls, steps: fresh } = steps(false);
    await provisionReleaseArtifacts("/repo", fresh);
    expect(calls.built).toBe(1);
    expect(calls.wrapper).toEqual([
      path.join("/repo", "packages/runtime-native/android/gradle/wrapper/gradle-wrapper.jar"),
    ]);
  });

  it("keeps a current web engine and still verifies the Gradle wrapper", async () => {
    const { calls, steps: built } = steps(true);
    await provisionReleaseArtifacts("/repo", built);
    expect(calls.built).toBe(0);
    expect(calls.wrapper).toHaveLength(1);
  });
});
