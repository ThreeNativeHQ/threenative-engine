import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { publicWorkspacePackages } from "../../../scripts/workspace-packages.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";

const roots = publicWorkspacePackages(path.resolve("packages", "..")).map(({ directory }) =>
  path.basename(directory),
);

interface IManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  exports?: Record<string, string | Record<string, string>>;
  name: string;
  optionalDependencies?: Record<string, string>;
  private?: boolean;
  publishConfig?: { access?: string };
  version: string;
}

async function manifest(root: string): Promise<IManifest> {
  return JSON.parse(
    await readFile(path.resolve("packages", root, "package.json"), "utf8"),
  ) as IManifest;
}

function shippedTargets(value: string | Record<string, string>): string[] {
  return typeof value === "string" ? [value] : Object.values(value);
}

const run = promisify(execFile);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface IProcessResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

async function runNodeScript(
  script: string,
  cwd: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<IProcessResult> {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const [code] = (await once(child, "close")) as [number | null];
  return {
    code,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

interface IReferenceFixture {
  capabilities: string;
  close: () => Promise<void>;
  endpoint: string;
  posts: Record<string, unknown>[];
}

async function referenceFixture(): Promise<IReferenceFixture> {
  const posts: Record<string, unknown>[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(
        JSON.stringify({
          data: [
            {
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["image"],
              },
            },
          ],
        }),
      );
      return;
    }
    const body = Buffer.concat(chunks).toString("utf8");
    posts.push(JSON.parse(body) as Record<string, unknown>);
    response.end(
      JSON.stringify({
        choices: [
          { message: { images: [{ b64_json: PNG.toString("base64"), mime_type: "image/png" }] } },
        ],
        usage: { total_tokens: 1 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("image fixture did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    capabilities: `${base}/v1/models/meta%2Fmuse-image/endpoints`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
    endpoint: `${base}/v1/chat/completions`,
    posts,
  };
}

async function packedPackageRoot(parent: string): Promise<string> {
  const archiveDirectory = path.join(parent, "archive");
  await mkdir(archiveDirectory, { recursive: true });
  await run("pnpm", ["pack", "--pack-destination", archiveDirectory], {
    cwd: path.resolve("packages/create-threenative"),
  });
  const archive = (await readdir(archiveDirectory)).find((entry) => entry.endsWith(".tgz"));
  if (archive === undefined) throw new Error("create-threenative pack produced no tarball");
  await run("tar", ["-xzf", path.join(archiveDirectory, archive), "-C", archiveDirectory]);
  const packageRoot = path.join(archiveDirectory, "package");
  await symlink(
    path.resolve("packages/create-threenative/node_modules"),
    path.join(packageRoot, "node_modules"),
    "dir",
  );
  return packageRoot;
}

async function packedCreateProject(packageRoot: string, cwd: string, target: string) {
  const module = (await import(
    pathToFileURL(path.join(packageRoot, "dist/index.js")).href
  )) as typeof import("../src/index.js");
  return module.createProject({ install: false, target, template: "starter" }, cwd);
}

describe("registry publication", () => {
  it("keeps every template package publishable as public npm content", async () => {
    for (const root of roots) {
      const packageJson = await manifest(root);
      expect(packageJson.private, packageJson.name).not.toBe(true);
      expect(packageJson.publishConfig?.access, packageJson.name).toBe("public");
    }
  });

  it("reserves a UI version newer than the immutable legacy registry package", async () => {
    const packageJson = await manifest("ui");
    // `@threenative/ui` 0.1.12 is on the public registry and npm cannot replace a publish, so
    // the package can only ever move above it. Asserted as an ordering against that floor
    // rather than as an equality: pinning the exact version made every release bump fail a
    // test that then says nothing about the constraint it exists to enforce.
    const [major, minor, patch] = packageJson.version.split("-")[0]?.split(".").map(Number) ?? [];
    if (major === undefined || minor === undefined || patch === undefined)
      throw new Error(`Not a three-part version: '${packageJson.version}'.`);
    expect(
      major > 0 || minor > 1 || (minor === 1 && patch > 12),
      `@threenative/ui ${packageJson.version} must be newer than the published 0.1.12`,
    ).toBe(true);
    for (const template of ["starter", "platformer"]) {
      const templateManifest = JSON.parse(
        await readFile(
          path.resolve("packages", "create-threenative", "templates", template, "package.json"),
          "utf8",
        ),
      ) as { dependencies: Record<string, string> };
      // And a template must pin whatever that version is, exactly — a scaffold pinning a
      // version the workspace no longer publishes cannot install.
      expect(templateManifest.dependencies["@threenative/ui"], template).toBe(packageJson.version);
    }
  });

  it("keeps every template pin equal to the workspace package it ships", async () => {
    const versions = new Map(
      publicWorkspacePackages(path.resolve("packages", "..")).map(({ name, version }) => [
        name,
        version,
      ]),
    );
    const templatesRoot = path.resolve("packages/create-threenative/templates");
    for (const entry of await readdir(templatesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const template = JSON.parse(
        await readFile(path.join(templatesRoot, entry.name, "package.json"), "utf8"),
      ) as IManifest;
      for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
        for (const [name, version] of Object.entries(template[field] ?? {})) {
          const workspaceVersion = versions.get(name);
          if (workspaceVersion === undefined) continue;
          expect(version, `${entry.name} ${field}.${name}`).toBe(workspaceVersion);
        }
      }
    }
  });

  it("points every explicit export and binary at a built file", async () => {
    for (const root of roots) {
      const packageJson = await manifest(root);
      for (const [entry, value] of Object.entries(packageJson.exports ?? {})) {
        expect(entry, packageJson.name).not.toContain("*");
        for (const target of shippedTargets(value))
          await expect(
            access(path.resolve("packages", root, target)),
            `${packageJson.name} ${entry} -> ${target}`,
          ).resolves.toBeUndefined();
      }
      // npm's string form names the one binary after the package.
      const bins =
        typeof packageJson.bin === "string"
          ? { [packageJson.name]: packageJson.bin }
          : (packageJson.bin ?? {});
      for (const [name, target] of Object.entries(bins))
        await expect(
          access(path.resolve("packages", root, target)),
          `${packageJson.name} bin ${name} -> ${target}`,
        ).resolves.toBeUndefined();
    }
  });

  it("runs target acquisition and record validation from a packed tarball", async () => {
    const root = await makeTempDir("threenative-packed-authoring-");
    const fixture = await referenceFixture();
    try {
      const packageRoot = await packedPackageRoot(root);
      const project = await packedCreateProject(packageRoot, root, "packed-game");
      const runDirectory = path.join(project.target, ".dream-loop", "packed-run");
      await mkdir(runDirectory, { recursive: true });
      await writeFile(path.join(runDirectory, "prompt.txt"), "A sealed landmark target.");
      const recordFile = path.join(runDirectory, "run.json");
      await writeFile(
        recordFile,
        `${JSON.stringify({
          schemaVersion: 1,
          runId: "packed-run",
          projectRoot: project.target,
          artifactRoot: ".dream-loop/packed-run",
          builderIdentity: "packed-builder",
          currentSourceSha256: "a".repeat(64),
          limits: {
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            maxImageRequests: 2,
            maxRounds: 2,
          },
          requests: { pending: [], completed: [], unknown: [], failed: [] },
          rounds: [],
          decisionHistory: [],
        })}\n`,
      );

      const reference = await runNodeScript(
        path.join(project.target, "scripts/reference.mjs"),
        project.target,
        [
          "--record",
          ".dream-loop/packed-run/run.json",
          "--request-id",
          "packed-target-001",
          "--prompt-file",
          ".dream-loop/packed-run/prompt.txt",
          "--out",
          ".dream-loop/packed-run/target.png",
        ],
        {
          NODE_ENV: "test",
          OPENROUTER_API_KEY: "synthetic-key",
          TN_REFERENCE_CAPABILITIES_ENDPOINT: fixture.capabilities,
          TN_REFERENCE_ENDPOINT: fixture.endpoint,
        },
      );
      expect(reference.code, `${reference.stdout}\n${reference.stderr}`).toBe(0);
      expect(JSON.parse(reference.stdout)).toMatchObject({
        action: "generated",
        mime: "image/png",
      });
      expect(fixture.posts).toHaveLength(1);

      const targetHash = sha256(PNG);
      const record = JSON.parse(await readFile(recordFile, "utf8")) as Record<string, unknown>;
      record.target = {
        path: ".dream-loop/packed-run/target.png",
        sha256: targetHash,
        revision: 1,
      };
      await writeFile(path.join(runDirectory, "capture.png"), PNG);
      record.rounds = [
        {
          round: 1,
          platform: "browser",
          adapter: "webgpu",
          capture: {
            path: ".dream-loop/packed-run/capture.png",
            sha256: targetHash,
            targetSha256: targetHash,
            sourceSha256: "a".repeat(64),
          },
          functional: { assertions: [{ name: "landmark-visible", passed: true }] },
          performance: { targetFps: 30, displayMaxFps: 60, windows: [{ fps: 60 }] },
          review: {
            status: "PASS",
            criticIdentity: "packed-critic",
            targetSha256: targetHash,
            captureSha256: targetHash,
            framing: 3,
            lighting: 2,
            material: 2,
            finish: 1,
            blockers: [],
            gaps: [],
          },
        },
      ];
      await writeFile(recordFile, `${JSON.stringify(record)}\n`);
      const decision = await runNodeScript(
        path.join(project.target, "scripts/visual-loop.mjs"),
        project.target,
        ["--record", ".dream-loop/packed-run/run.json"],
      );
      expect(decision.code, `${decision.stdout}\n${decision.stderr}`).toBe(0);
      expect(JSON.parse(decision.stdout)).toMatchObject({ decision: "accepted", score: 8 });
      // PRD-449: the project reads the recipe from the installed package, so what the tarball must
      // ship is the page itself — the `files` list is the whole installation mechanism.
      await expect(
        readFile(path.join(packageRoot, "agent-docs/references/dream-loop.md"), "utf8"),
      ).resolves.toContain("node scripts/visual-loop.mjs");
      await expect(readFile(path.join(project.target, "AGENTS.md"), "utf8")).resolves.toContain(
        "node_modules/create-threenative/agent-docs/references/dream-loop.md",
      );
    } finally {
      await fixture.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("keeps authoring secrets and scratch records out of staged files and runtime output", async () => {
    const root = await makeTempDir("threenative-packed-hygiene-");
    const fixture = await referenceFixture();
    const secret = "synthetic-openrouter-sentinel";
    try {
      const packageRoot = await packedPackageRoot(root);
      const project = await packedCreateProject(packageRoot, root, "packed-hygiene");
      await writeFile(path.join(project.target, ".env"), `OPENROUTER_API_KEY=${secret}\n`);
      await writeFile(
        path.join(project.target, ".env.authoring"),
        `OPENROUTER_API_KEY=${secret}\n`,
      );
      await mkdir(path.join(project.target, ".dream-loop", "scratch"), { recursive: true });
      await writeFile(path.join(project.target, ".dream-loop", "scratch", "secret.txt"), secret);
      await mkdir(path.join(project.target, "node_modules", "ignored"), { recursive: true });
      await writeFile(path.join(project.target, "node_modules", "ignored", "module.js"), secret);
      await run("git", ["init", "--quiet"], { cwd: project.target });
      const staged = await run("git", ["add", "--dry-run", "--all"], { cwd: project.target });
      expect(`${staged.stdout}\n${staged.stderr}`).not.toMatch(/\.env|\.dream-loop|node_modules/u);

      const runDirectory = path.join(project.target, ".dream-loop", "runtime");
      await mkdir(runDirectory, { recursive: true });
      await writeFile(path.join(runDirectory, "prompt.txt"), "A prompt with no secret.");
      await writeFile(
        path.join(runDirectory, "run.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          runId: "runtime",
          projectRoot: project.target,
          artifactRoot: ".dream-loop/runtime",
          limits: {
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            maxImageRequests: 1,
          },
          requests: { pending: [], completed: [], unknown: [], failed: [] },
          rounds: [],
          decisionHistory: [],
        })}\n`,
      );
      const output = await runNodeScript(
        path.join(project.target, "scripts/reference.mjs"),
        project.target,
        [
          "--record",
          ".dream-loop/runtime/run.json",
          "--request-id",
          "runtime-target-001",
          "--prompt-file",
          ".dream-loop/runtime/prompt.txt",
          "--out",
          ".dream-loop/runtime/target.png",
        ],
        {
          NODE_ENV: "test",
          OPENROUTER_API_KEY: secret,
          TN_REFERENCE_CAPABILITIES_ENDPOINT: fixture.capabilities,
          TN_REFERENCE_ENDPOINT: fixture.endpoint,
        },
      );
      expect(`${output.stdout}\n${output.stderr}`).not.toContain(secret);
      expect(await readFile(path.join(runDirectory, "run.json"), "utf8")).not.toContain(secret);
      expect(fixture.posts).toHaveLength(1);
    } finally {
      await fixture.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);
});
