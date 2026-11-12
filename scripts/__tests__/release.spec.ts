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
  installableOnRegistry,
  packReleaseSet,
  packedTarballName,
  prepareReleaseCohort,
  proveUpgradeFromLatest,
  provisionReleaseArtifacts,
  publishCohort,
  releaseLevels,
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

  it("names the repository that publishes it, so npm accepts its CI provenance", async () => {
    // npm rejects a `--provenance` publish whose `repository.url` is not the repository the
    // workflow ran in; the repository was renamed from `threenative` to `threenative-engine`.
    const { publishSet } = await import("../check-publish-state.js");
    const repo = path.resolve(import.meta.dirname, "../..");
    const urls = publishSet(repo).map((item) => {
      const manifest = JSON.parse(fs.readFileSync(item.manifest, "utf8")) as {
        repository?: { url?: string };
      };
      return [item.name, manifest.repository?.url];
    });
    expect(urls).toEqual(
      urls.map(([name]) => [name, "git+https://github.com/ThreeNativeHQ/threenative-engine.git"]),
    );
  });

  it("groups packages into levels that depend only on earlier levels", async () => {
    const levels = releaseLevels(
      await manifests([
        { deps: ["@threenative/ui"], name: "create-threenative" },
        { deps: ["@threenative/core"], name: "@threenative/ui" },
        { deps: ["@threenative/core"], name: "@threenative/physics" },
        { name: "@threenative/core" },
      ]),
    );

    expect(levels.map((level) => [...level].sort())).toEqual([
      ["@threenative/core"],
      ["@threenative/physics", "@threenative/ui"],
      ["create-threenative"],
    ]);
  });

  it("puts every real workspace package in exactly one level, after its dependencies", () => {
    const repo = path.resolve(import.meta.dirname, "../..");
    const packages = publishSet(repo);
    const levels = releaseLevels(packages);
    const levelOf = new Map(
      levels.flatMap((level, index) => level.map((n) => [n, index] as const)),
    );

    expect([...levelOf.keys()].sort()).toEqual(packages.map((item) => item.name).sort());
    expect(levels.flat()).toHaveLength(packages.length);
    const declared = (item: IPublishPackage): readonly string[] => {
      const manifest = JSON.parse(fs.readFileSync(item.manifest, "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      return ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
        Object.keys(manifest[field] ?? {}),
      );
    };
    for (const item of packages)
      for (const dependency of declared(item).filter((name) => levelOf.has(name)))
        if (dependency !== item.name)
          expect(levelOf.get(dependency)).toBeLessThan(levelOf.get(item.name) ?? -1);
  });

  it("puts the scaffolder after every package its templates may pin", async () => {
    // No manifest declares those pins. With manifest dependencies alone the scaffolder went out with
    // core, before `@threenative/ui`, and a new project could pin a version npm did not serve yet.
    const repo = path.resolve(import.meta.dirname, "../..");
    expect(releaseLevels(publishSet(repo)).at(-1)).toEqual(["create-threenative"]);
  });

  it("still publishes a package that depends on the scaffolder after it", async () => {
    const levels = releaseLevels(
      await manifests([
        { deps: ["create-threenative"], name: "@threenative/scaffolder-consumer" },
        { name: "create-threenative" },
        { name: "@threenative/core" },
      ]),
    );

    expect(levels).toEqual([
      ["@threenative/core"],
      ["create-threenative"],
      ["@threenative/scaffolder-consumer"],
    ]);
  });

  it("refuses a dependency cycle when it builds levels", async () => {
    await expect(
      manifests([
        { deps: ["@threenative/b"], name: "@threenative/a" },
        { deps: ["@threenative/a"], name: "@threenative/b" },
      ]).then(releaseLevels),
    ).rejects.toThrow(/TN_RELEASE_DEPENDENCY_CYCLE/u);
  });
});

describe("pnpm release publishing", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

  it("starts a level only after the level before it is readable on the registry", async () => {
    const trace: string[] = [];
    await publishCohort([["a", "b"], ["c"]], {
      publish: async (name) => {
        trace.push(`publish ${name}`);
        await tick();
      },
      visible: async (name) => {
        await tick();
        trace.push(`visible ${name}`);
      },
    });

    expect(trace.indexOf("publish c")).toBeGreaterThan(trace.indexOf("visible a"));
    expect(trace.indexOf("publish c")).toBeGreaterThan(trace.indexOf("visible b"));
    expect(trace.at(-1)).toBe("visible c");
  });

  it("publishes a level concurrently, up to the limit", async () => {
    let active = 0;
    let peak = 0;
    await publishCohort(
      [["a", "b", "c", "d", "e", "f"]],
      {
        publish: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
        },
        visible: async () => undefined,
      },
      3,
    );

    expect(peak).toBe(3);
  });

  it("waits for a whole level to be readable at once, not one package at a time", async () => {
    // The registry wait is the cost this exists to cut: 0.3.6 spent 43 minutes on 16 packages, and
    // a 31 KB package took 7 of them. Every wait of a level has to run at the same time.
    let waiting = 0;
    let peak = 0;
    await publishCohort(
      [["a", "b", "c", "d", "e", "f"]],
      {
        publish: async () => undefined,
        visible: async () => {
          waiting += 1;
          peak = Math.max(peak, waiting);
          await tick();
          waiting -= 1;
        },
      },
      2,
    );

    expect(peak).toBe(6);
  });

  it("names the failed package, publishes nothing after it and no later level", async () => {
    const published: string[] = [];
    await expect(
      publishCohort(
        [["a", "b", "c"], ["d"]],
        {
          publish: async (name) => {
            published.push(name);
            if (name === "a") throw new Error("registry said no");
          },
          visible: async () => undefined,
        },
        1,
      ),
    ).rejects.toThrow(/TN_RELEASE_STEP_FAILED: a: registry said no/u);

    expect(published).toEqual(["a"]);
  });

  it("does not start the next level when a published package never becomes readable", async () => {
    const published: string[] = [];
    await expect(
      publishCohort([["a"], ["b"]], {
        publish: async (name) => {
          published.push(name);
        },
        visible: async () => {
          throw new Error("TN_RELEASE_NOT_VISIBLE: a");
        },
      }),
    ).rejects.toThrow(/TN_RELEASE_NOT_VISIBLE: a/u);

    expect(published).toEqual(["a"]);
  });

  it("waits for the install packument, not the per-version endpoint", async () => {
    // 0.3.10 and 0.3.11: the version endpoint answered first, and `npm create` in the clean room
    // read a packument that did not list the new version yet (ETARGET).
    const requests: { url: string; accept: string }[] = [];
    const registry = (versions: Record<string, unknown>, latest: string) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), accept: new Headers(init?.headers).get("accept") ?? "" });
        return new Response(JSON.stringify({ "dist-tags": { latest }, versions }), { status: 200 });
      }) as typeof fetch;
    const missing = registry({ "0.2.14": {} }, "0.2.14");
    const untagged = registry({ "0.2.14": {}, "0.2.15": {} }, "0.2.14");
    const ready = registry({ "0.3.11": {} }, "0.3.11");

    expect(await installableOnRegistry("create-threenative", "0.2.15", missing)).toBe(false);
    expect(await installableOnRegistry("create-threenative", "0.2.15", untagged)).toBe(false);
    expect(await installableOnRegistry("@threenative/core", "0.3.11", ready)).toBe(true);
    expect(requests.at(-1)).toEqual({
      url: "https://registry.npmjs.org/@threenative%2fcore",
      accept: "application/vnd.npm.install-v1+json",
    });
  });
});

describe("pnpm release cohort guards", () => {
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
      "threenative-terrain",
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

  it("reads a template floor, so a later candidate still satisfies the kit's pin", async () => {
    const root = await makeTempDir("threenative-release-floors-");
    roots.push(root);
    const templates = path.join(root, "templates", "starter");
    await fs.promises.mkdir(templates, { recursive: true });
    const manifest = (specifier: string): Promise<void> =>
      fs.promises.writeFile(
        path.join(templates, "package.json"),
        JSON.stringify({ dependencies: { "@threenative/core": specifier } }),
      );
    await manifest(">=0.3.0");
    expect(
      validateTemplatePins(path.join(root, "templates"), new Map([["@threenative/core", "0.3.4"]])),
    ).toEqual([]);
    // A floor above the candidate names an engine the registry cannot serve yet.
    await manifest(">=0.4.0");
    const findings = validateTemplatePins(
      path.join(root, "templates"),
      new Map([["@threenative/core", "0.3.4"]]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/@threenative\/core.*0\.3\.4/u);
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

  it("finishes a cohort a crash left partial, and only that", () => {
    const packages = [
      candidate("@threenative/core", "0.3.0"),
      candidate("@threenative/ui", "0.3.0"),
    ];
    const uiAt =
      (published: string): RegistryLookup =>
      (name) =>
        name === "@threenative/core"
          ? { state: "absent" }
          : { published, state: "present", version: "0.3.0" };
    const commit = "2026-11-02T00:00:00Z";

    expect(
      unpublishedReleasePackages(packages, uiAt("2026-11-02T01:00:00Z"), commit).map(
        (item) => item.name,
      ),
    ).toEqual(["@threenative/core"]);
    // Published before this commit: a package that missed its bump.
    expect(() =>
      unpublishedReleasePackages(packages, uiAt("2026-10-01T00:00:00Z"), commit),
    ).toThrow(/TN_RELEASE_COHORT_PARTIAL/u);
    const all: RegistryLookup = () => ({
      published: "2026-11-02T01:00:00Z",
      state: "present",
      version: "0.3.0",
    });
    expect(() => unpublishedReleasePackages(packages, all, commit)).toThrow(
      /TN_RELEASE_COHORT_ALREADY_PUBLISHED/u,
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

  it("packs every cohort tarball in the repository, never in a label", () => {
    const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
    const tarballs = packReleaseSet(
      [
        { name: "@threenative/core", version: "0.3.12" },
        { name: "@threenative/ui", version: "0.3.12" },
      ] as never,
      "/tmp/packed",
      ((command: string, args: readonly string[], options: unknown) => {
        calls.push({ args, command, options });
      }) as never,
    );
    expect(Object.keys(tarballs)).toEqual(["@threenative/core", "@threenative/ui"]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // A bare third argument would be read as a working directory: the release once tried to run
      // pnpm in a folder named "pack @threenative/core" and failed every pack.
      expect(typeof call.options).toBe("object");
      expect(call.options).toMatchObject({ code: "TN_RELEASE_STEP_FAILED" });
      expect((call.options as { cwd: string }).cwd).toBe(
        path.resolve(import.meta.dirname, "../.."),
      );
    }
  });

  it("keeps the post-build cleanliness and preflight gates before publication", async () => {
    const source = await fs.promises.readFile(
      path.resolve(import.meta.dirname, "../release.ts"),
      "utf8",
    );
    // The build step is multi-line now that it carries the release code and its sentence.
    const build = source.indexOf('run("pnpm", ["build"], {');
    const buildLabel = source.indexOf('label: "pnpm build",', build);
    const clean = source.indexOf("assertCleanPackageTree(REPO);", build);
    const preflight = source.indexOf("const postBuildReport", build);
    const cohort = source.indexOf("const publishPackages = unpublishedReleasePackages", preflight);
    const upgrade = source.indexOf("proveUpgradeFromLatest(packages, tarballs)", cohort);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(buildLabel).toBeGreaterThan(build);
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
