import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";

const repo = path.resolve(import.meta.dirname, "../..");
const localRunner = path.join(repo, "scripts", "ci-local.sh");
const suiteRunner = path.join(repo, "scripts", "run-test-suite.sh");

async function recorderRoot(): Promise<{
  readonly bin: string;
  readonly root: string;
  readonly trace: string;
}> {
  const root = await makeTempDir("ci-local-recorder-");
  const bin = path.join(root, "bin");
  const trace = path.join(root, "trace.log");
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, "pnpm"),
    [
      "#!/bin/sh",
      'printf \'%s\\t%s\\t%s\\n\' "$*" "${TN_SUITE_PREBUILT:-0}" "${TN_SUITE_PHASES:-}" >> "$TN_CI_LOCAL_TRACE"',
      'if [ "${TN_CI_LOCAL_FAIL:-}" = "$1" ]; then exit 19; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(path.join(bin, "pnpm"), 0o755);
  return { bin, root, trace };
}

async function missingPrebuiltFixture(): Promise<{
  readonly bin: string;
  readonly root: string;
  readonly trace: string;
}> {
  const fixture = await recorderRoot();
  await mkdir(path.join(fixture.root, "packages/fake"), { recursive: true });
  await writeFile(path.join(fixture.root, "packages/fake/tsup.config.ts"), "export default {};\n");
  await mkdir(path.join(fixture.root, "packages/playtest/__tests__"), { recursive: true });
  const orphanCleanup = path.join(fixture.root, "packages/playtest/__tests__/orphan-cleanup.sh");
  await writeFile(orphanCleanup, "#!/bin/sh\nexit 0\n");
  await chmod(orphanCleanup, 0o755);
  await mkdir(path.join(fixture.root, "scripts"), { recursive: true });
  await writeFile(path.join(fixture.root, "scripts/gate-records.mjs"), "process.exit(0);\n");
  const runner = path.join(fixture.root, "scripts/run-test-suite.sh");
  await copyFile(suiteRunner, runner);
  await chmod(runner, 0o755);
  return fixture;
}

async function runLocal(
  only = "",
  failCommand = "",
): Promise<{
  readonly output: string;
  readonly status: number | null;
  readonly trace: readonly string[];
  readonly root: string;
}> {
  const fixture = await recorderRoot();
  const logRoot = path.join(fixture.root, "logs");
  const result = spawnSync(localRunner, only.length === 0 ? [] : [only], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TN_CI_LOCAL_FAIL: failCommand,
      TN_CI_LOCAL_LOGS: logRoot,
      TN_CI_LOCAL_TRACE: fixture.trace,
    },
  });
  const trace = (await readFile(fixture.trace, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.length > 0);
  return {
    output: `${result.stdout}\n${result.stderr}`,
    root: fixture.root,
    status: result.status,
    trace,
  };
}

describe("ci-local build contract", () => {
  it("should build once before the prebuilt suite in the full local board", async () => {
    const source = await readFile(localRunner, "utf8");
    const result = await runLocal();
    try {
      expect(result.status, result.output).toBe(0);
      expect(result.trace[0]).toMatch(/^build\t/u);
      expect(result.trace.find((line) => line.startsWith("test\t"))).toContain(
        "\t1\tdocs,package-test,unit",
      );
      expect(source).toContain("pnpm build");
      expect(source).toContain(
        "TN_SUITE_PREBUILT=1 TN_SUITE_PHASES=docs,package-test,unit pnpm test",
      );
    } finally {
      await rm(result.root, { force: true, recursive: true });
    }
  });

  it("should build prerequisites when only test is selected", async () => {
    const result = await runLocal("test");
    try {
      expect(result.status, result.output).toBe(0);
      expect(result.trace.map((line) => line.split("\t", 1)[0])).toEqual([
        "build",
        "exec tsx scripts/check-core-boundary.ts",
        "test",
      ]);
    } finally {
      await rm(result.root, { force: true, recursive: true });
    }
  });

  it("should fail when the prerequisite build fails", async () => {
    const result = await runLocal("test", "build");
    try {
      expect(result.status, result.output).not.toBe(0);
      expect(result.trace.map((line) => line.split("\t", 1)[0])).toEqual(["build"]);
      expect(result.output).toContain("test             skipped (build failed)");
    } finally {
      await rm(result.root, { force: true, recursive: true });
    }
  });

  it("should reject an unknown local job rather than reporting an empty pass", async () => {
    const result = await runLocal("not-a-job");
    try {
      expect(result.status).toBe(2);
      expect(result.output).toContain("TN_CI_LOCAL_UNKNOWN_JOB");
      expect(result.trace).toEqual([]);
    } finally {
      await rm(result.root, { force: true, recursive: true });
    }
  });

  it("should reject prebuilt execution when required outputs are missing", async () => {
    const fixture = await missingPrebuiltFixture();
    const statusPath = path.join(fixture.root, "status.json");
    try {
      const result = spawnSync(
        "bash",
        [
          path.join(fixture.root, "scripts/run-test-suite.sh"),
          "--status-path",
          statusPath,
          "--run-id",
          "ci-local-test",
        ],
        {
          cwd: fixture.root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${fixture.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            TN_CI_LOCAL_TRACE: fixture.trace,
            TN_SUITE_PHASES: "package-test",
            TN_SUITE_PREBUILT: "1",
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("TN_SUITE_PREBUILT_MISSING");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("PRD-373 local selection", () => {
  async function selected(file: string, extra: string[] = []) {
    const fixture = await recorderRoot();
    await mkdir(path.join(fixture.root, "scripts"), { recursive: true });
    for (const name of ["ci-local.sh", "ci-change-scope.mjs"]) {
      await copyFile(path.join(repo, "scripts", name), path.join(fixture.root, "scripts", name));
    }
    await mkdir(path.join(fixture.root, "packages/create-threenative/templates/starter"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture.root, "packages/create-threenative/templates/starter/kit.json"),
      '{"name":"starter"}',
    );
    await writeFile(path.join(fixture.root, "scripts/xvfb.sh"), '#!/bin/sh\nexec "$@"\n');
    await writeFile(path.join(fixture.root, ".gitignore"), "bin/\ntrace.log\nlogs/\n");
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: fixture.root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("config", "user.email", "ci@example.invalid");
    git("config", "user.name", "CI fixture");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    await mkdir(path.dirname(path.join(fixture.root, file)), { recursive: true });
    await writeFile(path.join(fixture.root, file), "fixture\n");
    git("add", ".");
    git("commit", "-qm", "feature");
    const result = spawnSync(
      "bash",
      [
        "scripts/ci-local.sh",
        "--affected",
        "--target",
        "develop",
        "--base",
        base,
        "--head",
        "HEAD",
        ...extra,
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixture.bin}:${process.env.PATH}`,
          TN_CI_LOCAL_LOGS: path.join(fixture.root, "logs"),
          TN_CI_LOCAL_TRACE: fixture.trace,
        },
      },
    );
    const trace = await readFile(fixture.trace, "utf8").catch(() => "");
    await rm(fixture.root, { recursive: true, force: true });
    return { ...result, trace };
  }

  it("runs only documentation checks for a committed develop prose diff", async () => {
    const result = await selected("docs/PRDs/fixture.md");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("CI change scope: prose");
    expect(result.trace).toContain("check:docs");
    expect(result.trace).not.toMatch(/^build\t|^typecheck\t|native:build/mu);
    expect(result.stdout).toContain("native-platforms is not covered");
  });

  it("escalates a former site path to the full board, because the site is no longer here", async () => {
    const result = await selected("site/src/fixture.ts");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("CI change scope: full");
    expect(result.trace).not.toContain("--filter threenative-site");
    expect(result.trace).toMatch(/^typecheck\t/mu);
  });

  it("builds instruction dependencies before contracts without starting native checks", async () => {
    const result = await selected("AGENTS.md");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("CI change scope: instructions");
    const build = result.trace.indexOf("build\t");
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(result.trace.indexOf("primary-docs.spec.ts"));
    expect(result.trace).not.toMatch(/native:build|test:browser|verify:golden-path/u);
  });

  it("keeps broad dependency checks for shared runtime inputs", async () => {
    const result = await selected("packages/core/src/fixture.ts");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.trace).toMatch(/^build\t/mu);
    expect(result.trace).toContain("typecheck");
  });

  it("makes --full explicit and rejects misspelled selection arguments", async () => {
    const full = await runLocal("--full");
    expect(full.status, full.output).toBe(0);
    expect(full.trace[0]).toMatch(/^build\t/u);
    await rm(full.root, { recursive: true, force: true });
    const invalid = await selected("docs/PRDs/fixture.md", ["--ful"]);
    expect(invalid.status).toBe(2);
    expect(invalid.trace).toBe("");
  });
});
