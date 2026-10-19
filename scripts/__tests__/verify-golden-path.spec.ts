import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_SERVERS } from "../../packages/core/mcp/servers.mjs";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  GOLDEN_PATH_STEPS,
  MCP_SURFACES,
  type TemplateStep,
  adoptPackedWorkspace,
  assertEngineCapabilityDiscovery,
  assertGoldenPathSteps,
  assertMcpToolSurface,
  assertTemplateDependencies,
  discoverGoldenPathTemplates,
  formatCorrectiveCommand,
  goldenPathCorrectiveCommands,
  packWorkspace,
  packedArchivePrefix,
  probeMcpServer,
  runCommand,
  runGoldenPathTemplate,
  scaffold,
  scenarioCap,
  verifyPackedMutationControl,
  workspacePackages,
  writeScaffoldScript,
} from "../verify-golden-path.js";

describe("golden path matrix", () => {
  it("rejects a packed engine manifest without the networking capability", async () => {
    const request = async (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<unknown> => {
      if (method !== "tools/call") return {};
      const name = params.name;
      const argumentsValue = params.arguments as Record<string, unknown> | undefined;
      if (
        name === "engine_search_capabilities" &&
        argumentsValue?.situation ===
          "exchange authenticated multiplayer messages over WebTransport"
      ) {
        return {
          content: [
            {
              text: JSON.stringify({
                guidance: "write networking in the game",
                results: [],
                verdict: "none",
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            text: JSON.stringify({
              guidance: "",
              results: [
                "AudioBus",
                "FluidField2D",
                "GPUParticles3D",
                "GPUReadback",
                "Heightfield",
                "NavigationAgent3D",
                "RigidBody3D",
                "SoftBody3D",
                "SpectralOcean",
                "attachToBone",
              ].map((symbol) => ({ matchedSituation: "requested mechanic", symbol })),
              verdict: "matched",
            }),
          },
        ],
      };
    };

    await expect(assertEngineCapabilityDiscovery(request)).rejects.toThrow(
      "missing portable networking transport",
    );
  });

  // PRD-346's revert check for the golden-path entry assumed a server-count assertion existed. It
  // did not: deleting the blender row from `MCP_SURFACES` left every test green, so the matrix
  // could quietly stop probing a server nobody would notice was unprobed. Derived from core's
  // table, so a fifth server is covered the day it lands.
  it("probes every server the scaffold actually wires", () => {
    const probed = new Set<string>(MCP_SURFACES.map((surface) => surface.name));
    const wired = Object.keys(MCP_SERVERS);
    expect(wired.length).toBeGreaterThan(3);
    expect(wired.filter((name) => !probed.has(name))).toEqual([]);
    for (const surface of MCP_SURFACES) {
      expect(
        existsSync(path.resolve("packages/create-threenative", surface.file)),
        surface.file,
      ).toBe(true);
    }
  });

  it("builds corrective commands before the project exists, without reading it", () => {
    // The map is built before `scaffold` runs, so on the first pass the project directory is not
    // there yet. Listing scenarios then threw ENOENT and failed the whole lane while printing an
    // error about a directory the lane was about to create (CI run 33352399789):
    //   Error: ENOENT: no such file or directory, scandir '/tmp/.../action-rpg/playtests'
    // A corrective command is a message; it must never be the thing that fails.
    const previous = process.env.TN_PLAYTEST_ALLOW_SOFTWARE;
    process.env.TN_PLAYTEST_ALLOW_SOFTWARE = "1";
    try {
      const missing = path.join(os.tmpdir(), "tn-golden-path-absent", "action-rpg");
      expect(existsSync(missing)).toBe(false);
      const commands = goldenPathCorrectiveCommands(missing);
      expect(commands.test).toEqual({ args: ["test"], command: "pnpm", cwd: missing });
    } finally {
      process.env.TN_PLAYTEST_ALLOW_SOFTWARE = previous ?? "";
    }
  });

  it("asserts the actual ordered steps and fails when one is omitted", () => {
    expect(() => assertGoldenPathSteps(GOLDEN_PATH_STEPS.slice(0, -1))).toThrow(
      /missing assert artifact/u,
    );
  });

  it("records every template step that really ran", async () => {
    const calls: string[] = [];
    const action = (name: string) => async (): Promise<void> => {
      calls.push(name);
    };
    const steps = await runGoldenPathTemplate("fixture", {
      scaffold: action("scaffold"),
      install: action("install"),
      mcp: action("mcp"),
      dev: action("dev"),
      test: action("test"),
      buildWeb: action("build web"),
      assertArtifact: action("assert artifact"),
    });
    expect(steps).toEqual(GOLDEN_PATH_STEPS.slice(1));
    expect(calls).toEqual(GOLDEN_PATH_STEPS.slice(1));
  });

  it("runs the generated adopter scaffold script from the packed command path", async () => {
    const root = await makeTempDir("threenative-golden-path-script-");
    try {
      const cli = path.join(root, "create-threenative-0.1.0.tgz");
      const core = path.join(root, "threenative-core-0.1.0.tgz");
      const script = await writeScaffoldScript(root, "starter", cli, ["--core-package", core]);
      expect(script).toBe(path.join(root, "scaffold.sh"));
      expect((await stat(script)).mode & 0o111).not.toBe(0);
      const source = await readFile(script, "utf8");
      expect(source).toContain("pnpm dlx");
      expect(source).toContain('"${1:-game}"');
      expect(source).toContain(cli);
      expect(source).toContain(core);
      expect(source).not.toContain("--no-install");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports the failing layer, project, search location, and corrective command", async () => {
    const root = await makeTempDir("threenative-golden-path-command-");
    try {
      await expect(
        runCommand("test", process.execPath, ["-e", "process.exit(7)"], root),
      ).rejects.toThrow(
        new RegExp(
          `layer 'test'.*project '${root}'.*Searched:.*${root}.*Corrective command:.*exited 7`,
          "s",
        ),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("executes project corrective commands from their recorded cwd", async () => {
    const root = await makeTempDir("threenative-golden-path-corrective-");
    try {
      const project = path.join(root, "game");
      await mkdir(project, { recursive: true });
      await writeFile(path.join(project, "ok.mjs"), "process.exit(0);\n");
      await writeFile(
        path.join(project, "package.json"),
        JSON.stringify({
          name: "corrective-game",
          private: true,
          scripts: {
            dev: "node ok.mjs",
            test: "node ok.mjs",
          },
        }),
      );
      const commands = goldenPathCorrectiveCommands(project, 43123);
      for (const [step, command] of Object.entries(commands)) {
        if (step === "scaffold") continue;
        const rendered = formatCorrectiveCommand(command);
        expect(rendered).not.toMatch(/<[^>]+>/u);
        expect(rendered).not.toMatch(/\b(?:inspect|rerun)\b/u);
        if (step === "build web" || step === "assert artifact") {
          const binaryDirectory = path.join(project, "node_modules/.bin");
          await mkdir(binaryDirectory, { recursive: true });
          const binary = path.join(binaryDirectory, "threenative");
          await writeFile(binary, "#!/bin/sh\nexit 0\n");
          await chmod(binary, 0o755);
        }
        await runCommand(step as TemplateStep, command.command, command.args, command.cwd);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("creates and executes the scaffold recovery command before reporting a missing dependency", async () => {
    const root = await makeTempDir("threenative-golden-path-scaffold-recovery-");
    const originalPath = process.env.PATH;
    try {
      const templatesRoot = path.join(root, "templates");
      const template = path.join(templatesRoot, "broken-vite");
      const project = path.join(root, "game");
      const cli = path.join(root, "create-threenative-0.1.0.tgz");
      const bin = path.join(root, "bin");
      await mkdir(template, { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(
        path.join(template, "package.json"),
        JSON.stringify({
          name: "broken-vite",
          dependencies: { "create-threenative": "0.1.0" },
        }),
      );
      const fakePnpm = path.join(bin, "pnpm");
      await writeFile(fakePnpm, '#!/bin/sh\ntest "$1" = dlx\n');
      await chmod(fakePnpm, 0o755);

      const actions = {
        assertArtifact: async () => {},
        buildWeb: async () => {},
        dev: async () => {},
        install: async () => {},
        mcp: async () => {},
        scaffold: () =>
          scaffold("broken-vite", project, { "create-threenative": cli }, templatesRoot),
        test: async () => {},
      };
      await expect(runGoldenPathTemplate("broken-vite", actions, project)).rejects.toThrow(
        /Corrective command: \(cd .* && \.\/scaffold\.sh game\)/u,
      );

      const script = path.join(root, "scaffold.sh");
      expect((await stat(script)).mode & 0o111).not.toBe(0);
      const command = goldenPathCorrectiveCommands(project).scaffold;
      process.env.PATH = [bin, originalPath]
        .filter((value): value is string => value !== undefined)
        .join(path.delimiter);
      await runCommand("scaffold", command.command, command.args, command.cwd);
    } finally {
      if (originalPath === undefined) process.env.PATH = undefined;
      else process.env.PATH = originalPath;
      await rm(root, { force: true, recursive: true });
    }
  });

  // CI's `build` job packs the workspace once and publishes the tarballs; the golden-path job
  // downloads them before this script runs. Adopting that set instead of packing a second time is
  // the whole saving, so what matters is that it cannot adopt an incomplete or drifted one.
  describe("adopting tarballs another job packed", () => {
    async function stageArchives(names: readonly string[]): Promise<string> {
      const directory = await makeTempDir("golden-path-archives-");
      for (const name of names) await writeFile(path.join(directory, name), name);
      return directory;
    }

    it("resolves every workspace package to the tarball packed for it", async () => {
      const packages = await workspacePackages();
      expect(packages.length).toBeGreaterThan(0);
      const directory = await stageArchives(
        packages.map((entry) => `${packedArchivePrefix(entry.manifest.name)}9.9.9.tgz`),
      );

      const sources = await adoptPackedWorkspace(directory);

      expect(Object.keys(sources).sort()).toEqual(
        packages.map((entry) => entry.manifest.name).sort(),
      );
      for (const [name, tarball] of Object.entries(sources)) {
        expect(path.dirname(tarball), name).toBe(directory);
        expect(path.basename(tarball), name).toMatch(/\.tgz$/u);
      }
    });

    // The failure this guards against is the quiet one: a package added to the workspace, a
    // publisher that did not pack it, and a golden path that scaffolds without it and passes.
    it("fails closed when a workspace package has no tarball", async () => {
      const packages = await workspacePackages();
      const omitted = packages.at(-1);
      expect(omitted).toBeDefined();
      const directory = await stageArchives(
        packages
          .slice(0, -1)
          .map((entry) => `${packedArchivePrefix(entry.manifest.name)}9.9.9.tgz`),
      );

      await expect(adoptPackedWorkspace(directory)).rejects.toThrow(
        /TN_GOLDEN_PATH_ARCHIVE_MISSING: .*for /u,
      );
    });

    // And the other direction: a tarball nobody claims means the publisher and the workspace
    // disagree about what exists, which is drift, not a spare file.
    it("fails closed on a tarball no workspace package claims", async () => {
      const packages = await workspacePackages();
      const directory = await stageArchives([
        ...packages.map((entry) => `${packedArchivePrefix(entry.manifest.name)}9.9.9.tgz`),
        "threenative-retired-1.0.0.tgz",
      ]);

      await expect(adoptPackedWorkspace(directory)).rejects.toThrow(
        /TN_GOLDEN_PATH_ARCHIVE_UNKNOWN: .*threenative-retired-1\.0\.0\.tgz/u,
      );
    });

    it("fails closed when the directory does not exist", async () => {
      await expect(
        adoptPackedWorkspace(path.join(os.tmpdir(), "golden-path-archives-absent")),
      ).rejects.toThrow(/TN_GOLDEN_PATH_ARCHIVES_UNREADABLE/u);
    });

    it("names the tarball pnpm pack writes for scoped and unscoped packages", () => {
      expect(packedArchivePrefix("@threenative/core")).toBe("threenative-core-");
      expect(packedArchivePrefix("create-threenative")).toBe("create-threenative-");
    });
  });

  // The golden path proves the journey; `template-nonvisual` proves the scenarios. Capping how
  // many this layer drives is the difference between 353s and one scenario on the critical path —
  // but a cap that silently became zero, or that swallowed a typo, would turn the layer into
  // decoration, which is the failure this repository fails closed against everywhere.
  describe("how many scenarios the golden path drives itself", () => {
    it("runs every scenario when nothing asks otherwise", () => {
      expect(scenarioCap(13, undefined)).toBe(13);
      expect(scenarioCap(13, "")).toBe(13);
      expect(scenarioCap(13, "   ")).toBe(13);
    });

    it("never drives more than the template actually has", () => {
      expect(scenarioCap(2, "9")).toBe(2);
      expect(scenarioCap(13, "1")).toBe(1);
    });

    it("refuses a cap that is not a positive integer instead of narrowing to one", () => {
      for (const raw of ["0", "-1", "1.5", "all", "one", "٣"]) {
        expect(() => scenarioCap(13, raw), raw).toThrow(/TN_GOLDEN_PATH_SCENARIOS_INVALID/u);
      }
    });
  });

  it("fails closed when a template omits vite", () => {
    expect(() => assertTemplateDependencies("broken-vite", {}, {})).toThrow(
      "TN_GOLDEN_PATH_DEPENDENCY_MISSING: template 'broken-vite' is missing dependency 'vite'",
    );
  });

  it("discovers every template directory instead of carrying a list", async () => {
    const root = await makeTempDir("threenative-golden-path-templates-");
    try {
      for (const [name, genre] of [
        ["alpha", "arcade"],
        ["beta-kit", "strategy"],
      ] as const) {
        const directory = path.join(root, name);
        await mkdir(directory);
        await writeFile(
          path.join(directory, "kit.json"),
          JSON.stringify({
            blurb: `${name} blurb`,
            genre,
            kit: true,
            name,
            title: `${name} title`,
          }),
        );
      }
      expect(discoverGoldenPathTemplates(root)).toEqual(["alpha", "beta-kit"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails closed when the template directory is empty", async () => {
    const root = await makeTempDir("threenative-golden-path-empty-");
    try {
      expect(() => discoverGoldenPathTemplates(root)).toThrow(/TN_GOLDEN_PATH_TEMPLATES_EMPTY/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("launches an MCP server and checks tools plus sculpt resources over stdio", async () => {
    const root = await makeTempDir("threenative-golden-path-mcp-");
    try {
      const server = path.join(root, "server.mjs");
      await writeFile(
        server,
        `import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "tools/list"
    ? { tools: [{ name: "sculpt_plan" }] }
    : request.method === "resources/list"
      ? { resources: [{ uri: "grimoire://safe" }] }
      : request.method === "resources/read"
        ? { contents: [{ text: "Use broad shapes and a restrained palette." }] }
        : { protocolVersion: "2025-06-18", capabilities: {} };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`,
      );
      await expect(
        probeMcpServer(
          "threenative-sculpt",
          { args: [server], command: process.execPath },
          { tools: ["sculpt_plan"], version: "test" },
          root,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects MCP tool-surface drift before the packed path can pass", () => {
    expect(() =>
      assertMcpToolSurface("threenative-assets", ["asset_search_sources"], {
        tools: [{ name: "different_tool" }],
      }),
    ).toThrow(/surface drifted/u);
  });

  it("packs a cold-layout CLI and scaffolds its deliberately broken dependency", async () => {
    const root = await makeTempDir("threenative-golden-path-packed-control-");
    try {
      const staging = path.join(root, "packages");
      await mkdir(staging, { recursive: true });
      const outputs = [
        "packages/core/dist/index.js",
        "packages/create-threenative/dist/index.js",
        "packages/physics/dist/index.js",
        "packages/playtest/dist/index.js",
        "packages/ui/dist/index.js",
      ];
      const built = await Promise.all(
        outputs.map(async (output) =>
          (await stat(path.resolve(output)).catch(() => undefined))?.isFile(),
        ),
      );
      const sources = await packWorkspace(staging, !built.every((present) => present === true));
      const evidence = await verifyPackedMutationControl(sources);
      expect(evidence.mutatedSha256).not.toBe(evidence.repositorySha256);
      expect(evidence.mutatedTarball).not.toBe(evidence.repositoryTarball);
      expect(evidence.generatedManifest).toContain("mutated-project/package.json");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 120_000);
});
