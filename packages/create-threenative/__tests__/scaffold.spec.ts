import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { compileAssets } from "@threenative/assets";
import { read as readKTX2 } from "ktx-parse";
import { describe, expect, it } from "vitest";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { loadConfig } from "../src/config.js";
import {
  canonicalRenderSourcePath,
  cliHelp,
  createProject,
  discoverKitManifests,
  discoverTemplateNames,
  parseArgs,
  projectMcpServers,
  referenceDigest,
  scaffoldCompletionMessage,
  scaffoldNextSteps,
} from "../src/index.js";
import {
  type IScaffoldTreeBuckets,
  type IScaffoldTreePin,
  scaffoldTreeBuckets,
} from "./scaffold-tree.js";

const run = promisify(execFile);

const TEMPLATE_ROOT = path.resolve("packages/create-threenative/templates");
const KIT_FIXTURE_ROOT = path.resolve("packages/create-threenative/__tests__/fixtures/kits");
/** Where a generated project reads a reference page: the installed `create-threenative` copy
 * (PRD-449), the same path `assertReferenceBundle` checks against the package's bundle. */
const REFERENCE_PREFIX = "node_modules/create-threenative/agent-docs/references/";
const ASSET_MCP = "threenative-asset-mcp";
const SCULPT_MCP = "threenative-sculpt-mcp";
const ENGINE_MCP = "threenative-engine-mcp";
// Every server launches through a shim in `@threenative/core`, the one package a ThreeNative
// project always depends on directly, so the path resolves whatever the package manager did with
// the server packages themselves.
const CORE_SHIM = "./node_modules/@threenative/core/mcp";
const ALL_TEMPLATES = discoverTemplateNames(TEMPLATE_ROOT);
const AGENT_ROLE_PATHS = [
  ".threenative/agents/builder.md",
  ".threenative/agents/verifier.md",
  ".claude/agents/threenative-builder.md",
  ".claude/agents/threenative-verifier.md",
  ".agents/skills/threenative-builder/SKILL.md",
  ".agents/skills/threenative-verifier/SKILL.md",
] as const;

// The engine-bug report skill ships through `agent-files` to every scaffold, in the two skill
// directories hosts discover: Claude Code reads `.claude/skills`, Codex reads `.agents/skills`.
const BUG_REPORT_SKILL_PATHS = [
  ".claude/skills/file-engine-bug/SKILL.md",
  ".agents/skills/file-engine-bug/SKILL.md",
] as const;

/** Stages a broken template in a throwaway copy of the template tree and hands the body its
 * root, so a negative control never edits the shipped templates. It used to edit them in place
 * and put them back: `createProject` resolved its own root, so there was nowhere else to stage
 * one. Vitest runs spec files in parallel, so any file scaffolding `starter` during that window
 * read a template that was broken on purpose for this one — `build.spec.ts` failed intermittently
 * on `must launch from './node_modules/', not '-y'`, a red with nothing wrong behind it.
 * `createProject` now takes a template root; the copy is this test's alone. */
async function withBrokenTemplateFile<T>(
  relativePath: string,
  content: string | undefined,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await makeTempDir("threenative-broken-template-");
  try {
    // The package layout the scaffolder reads: templates/ plus the package-level siblings it
    // reaches up to (template-assets, agent-docs, agent-files). The copied tree
    // is the templates dir; the siblings ride along so a test breaks exactly the file it names.
    const packageDirectory = path.dirname(TEMPLATE_ROOT);
    // package.json: the authoring stamp records the package version (PRD-829).
    for (const sibling of ["template-assets", "agent-docs", "agent-files", "package.json"]) {
      await cp(path.join(packageDirectory, sibling), path.join(root, sibling), {
        recursive: true,
      });
    }
    await cp(TEMPLATE_ROOT, path.join(root, "templates"), { recursive: true });
    const file = relativePath.startsWith("agent-files/")
      ? path.join(root, relativePath)
      : path.join(root, "templates", relativePath);
    if (content === undefined) await rm(file);
    else await writeFile(file, content);
    return await body(path.join(root, "templates"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

// Two hashes per kit: everything the scaffolder built from a shared input, and the kit's own files.
// A shared edit (agent-docs, agent-files, template-assets, core's tables, the shared render sources)
// moves only `shared`; a kit edit moves only `kit`. `pnpm scaffold:pin` rewrites the block below and
// says which one moved, so a re-pin no longer needs a paragraph of history to be readable.
// Pages `prepack` writes into the package; a source checkout has no copy until `pnpm build`.
const PACK_GENERATED_PAGES: readonly string[] = ["capability-reference.md"];

const SCAFFOLD_TREE_HASHES: Readonly<Record<string, IScaffoldTreePin>> = {
  // scaffold-pin:begin
  "action-rpg": {
    shared: "3dfee3757561db8b2824b23d6131e9b7308bf13998e7a4bf7b6b6e3adf6a7f53",
    kit: "a8d70b273cef24257fcffa5ff29033005501615a23a20ad6e542afee61013efa",
  },
  adventure: {
    shared: "c05c558a93c9297b490fd7d40b9340fb2fa639cbf631026df3ef86c2d14fb81b",
    kit: "d2fa700c0186ed7eb9199700ed5b027078420801d0d09de76954364f94937d7a",
  },
  collectathon: {
    shared: "b2f3bc054c911405e898063214a2e18c5916b08e7bce35cabfbaa6ef6f7777a7",
    kit: "d442044c496f13384c098fa60573220cf41f5c0c07ac13ada43c1a5f0f64de72",
  },
  kart: {
    shared: "8a4de1bce71339bd7249b9a41e921f8e111106149ae5680f461d202d265508a8",
    kit: "edd8ff2a1a9bb9465eaa6c82ff830b57d75f3b594018c45cc7cf3a6c737bd9c2",
  },
  minimal: {
    shared: "4e5d168518d4993439fd9ead4bf304248d29e1ed16539444d7d77c8482ae4fb8",
    kit: "c211a38224fc1b10e6f8a2e3a626bb56ee4f16ef36114e331936a3649d81925f",
  },
  platformer: {
    shared: "5d295a3d2bee8ed41207d3630d07f1f325d80ce763be0c119378249b9c87ed0c",
    kit: "abddd25226bc58d65bf32d8dc38f7f10ef4af80e3ba1905290ff63bb7d25032e",
  },
  puzzle: {
    shared: "9900dba834fb339115c9aa9e7afd0581d9935f3004b228dd654f991b11493847",
    kit: "81db308b4a7c9dbb711555f4b4355d4c0fa3baa6d5d2f3a80327333fe5b39401",
  },
  racing: {
    shared: "c8b7db38ef9b68fbdf55dead10560df29569f5c183cd0f8f4c1dbf6469071f64",
    kit: "502ce8d65e38e69bfcec7c4c9981284048809676c6267f2a945534ed6a3f14c9",
  },
  rain: {
    shared: "0856ecca144a6d2419c0bf4d1b26da6448d358f9fa8ebaa9b6604780442054b3",
    kit: "f0adf851fb6d0e14acdf903b47a00e3fa41ff88ca5f7086e43ea3a09d4609b96",
  },
  rts: {
    shared: "94c096399f971506d873735610fc2759b108d672e200472279a8d0d4fcd92e09",
    kit: "15ae383f30b33a6ca2c3185f51d3365f5fbe71b49f1432a3d6b30c3dc576d669",
  },
  runner: {
    shared: "e522646cf7dc0567c1496c1abda755fb13d9bdba62d98e18cc3e1c68264db3af",
    kit: "b90f44f06df584db1557264c0fb07167adeb0b136c547839884ff1bcddca1158",
  },
  sailing: {
    shared: "e230d0ea5ae2e458c32f0ed0aa31e5c7a0bce6771adf41293623489611acd41c",
    kit: "db196dbad5d5b1e1c6b20bac8369c28426f7e2d7dac5e2ee948ec18a79e70cf0",
  },
  shooter: {
    shared: "ddcf11d581b12631f2f49319a022abddf66d59f9ce83265bb2935acb8414953e",
    kit: "0e89ad8f17773794527b8bb153f265b6a7344792498f2a173447a666ecd60cf5",
  },
  snow: {
    shared: "1b360f0661b462c2872dff12b403cf072690e19434094966a84db41ef34718bb",
    kit: "4da758c138d7f80b9a4e88903e2c86172c0029bd160da1ebe5f37b72bcfea823",
  },
  starter: {
    shared: "45287923ee472856d7fee5781bf527f953789cb893b951151eaa3d64c1ac539b",
    kit: "66bbbe13a8ba71930f412b2f240bf342af2e7fdb6c8aaa51735898bc1b087bd0",
  },
  "tower-defense": {
    shared: "9d9bbb42f8a7f0845bf827030f6978aa4feae5ac455e3739ee612e1d18c5bf9b",
    kit: "7fa359a8a390a9bcbb2c832ba4fe66f45129170f387333173625cab93e0c7ba0",
  },
  // scaffold-pin:end
};

describe("create-threenative", () => {
  it("discovers manifests and generates its template help from them", () => {
    const manifests = discoverKitManifests(TEMPLATE_ROOT);
    expect(manifests.map(({ name }) => name)).toEqual(
      [...manifests].map(({ name }) => name).sort(),
    );
    for (const name of ["minimal", "platformer", "starter"]) {
      expect(manifests.some((manifest) => manifest.name === name)).toBe(true);
    }
    expect(manifests.find(({ name }) => name === "platformer")).toMatchObject({
      blurb: expect.any(String),
      genre: "platformer",
      kit: true,
      title: "Fox Dash",
    });
    const help = cliHelp();
    expect(help).toContain("Templates:");
    const width = Math.max(...manifests.map(({ name }) => name.length));
    for (const manifest of manifests) {
      expect(help).toContain(
        `${manifest.name.padEnd(width)}  ${manifest.title}: ${manifest.blurb}`,
      );
    }
  });

  it("derives the scaffold completion message from every discovered kit", async () => {
    const root = await makeTempDir("threenative-message-manifests-");
    try {
      const templates = path.join(root, "templates");
      await cp(TEMPLATE_ROOT, templates, { recursive: true });
      await cp(path.join(KIT_FIXTURE_ROOT, "scratch"), path.join(templates, "scratch"), {
        recursive: true,
      });
      const manifests = discoverKitManifests(templates);

      expect(scaffoldCompletionMessage(manifests)).toBe(
        `Templates: ${manifests
          .map(({ name }) => (name === "starter" ? `${name} (default)` : name))
          .join(", ")}. Choose with --template <name>.\n`,
      );
      expect(scaffoldCompletionMessage(manifests)).toContain("scratch");
      const source = await readFile(
        path.resolve("packages/create-threenative/src/index.ts"),
        "utf8",
      );
      expect(source).toContain("scaffoldCompletionMessage(discoverKitManifests())");
      expect(source).not.toContain("Templates: minimal (smallest)");
      // Kit-loop rows 1-6 (PRD-750): a cold agent scaffolds from its session folder, so the host
      // never loads the game's .mcp.json (a probe that wrote it mid-session got NO_TOOL) and five
      // builds made zero engine calls. The last line hands it every server through mcp/call.mjs.
      const servers = ["threenative-assets", "threenative-sculpt", "threenative-engine"];
      const next = scaffoldNextSteps("/w/mario64", true, servers);
      expect(next).toMatch(/\/w\/mario64[\s\S]*\.mcp\.json[\s\S]*pnpm test/u);
      expect(next).toContain(`.mcp.json (${servers.join(", ")})`);
      expect(next).toContain(
        "`node /w/mario64/node_modules/@threenative/core/mcp/call.mjs <server>` lists its tools",
      );
      expect(next).toContain(
        "node /w/mario64/node_modules/@threenative/core/mcp/call.mjs threenative-engine engine_search_capabilities",
      );
      expect(next).toMatch(
        /Read AGENTS\.md once; CLAUDE\.md is its copy, and the skills it names are \.claude\/skills/u,
      );
      expect(scaffoldNextSteps("/w/mario64", false)).toMatch(/pnpm install[\s\S]*\.mcp\.json/u);
      expect(projectMcpServers(root)).toEqual([]);
      // Sandboxes 4-6 (2026-10-27): no reference call even with a ready command, and a printed title
      // list was read and none opened. The scaffold runs the search and prints the pinned sources.
      const calls: string[][] = [];
      const hit = (id: string, kind: string) => ({
        game: "sm64",
        id,
        kind,
        name: id,
        summary: `${id} summary`,
        title: "Super Mario 64",
      });
      const detail = (id: string) =>
        id === "a"
          ? {
              repo: "https://github.com/n64decomp/sm64",
              sha: "9921382a68",
              node: {
                purpose: "Mario actions",
                functions: [
                  { name: "set_mario_action", path: "src/game/mario.c", lines: [979, 1013] },
                ],
              },
              children: [{ id: "wall-kick" }],
            }
          : {
              repo: "https://github.com/n64decomp/sm64",
              sha: "9921382a68",
              card: {
                behavior: `${id} behavior`,
                constants: [
                  {
                    name: "kick speed",
                    value: 24,
                    unit: "units/frame",
                    source: "src/game/mario_actions_airborne.c:12",
                  },
                ],
                sources: [{ path: "src/game/mario_actions_airborne.c", line: 40 }],
              },
            };
      const digest = referenceDigest("/w/mario64", "mario", (args) => {
        calls.push(args);
        if (args[1] === "engine_reference_detail")
          return JSON.stringify(detail(JSON.parse(args[2] ?? "{}").id));
        return JSON.stringify({
          results: [hit("a", "node"), ...["b", "c", "d", "e", "f"].map((id) => hit(id, "card"))],
        });
      });
      const engine = "/w/mario64/node_modules/@threenative/core/mcp/engine.mjs";
      expect(calls).toEqual([
        [engine, "engine_search_references", '{"situation":"mario"}'],
        [engine, "engine_reference_detail", '{"game":"sm64","id":"a","kind":"node"}'],
        [engine, "engine_reference_detail", '{"game":"sm64","id":"b","kind":"card"}'],
        [engine, "engine_reference_detail", '{"game":"sm64","id":"c","kind":"card"}'],
      ]);
      expect(digest).toContain('Mechanics references for "mario"');
      expect(digest).toContain(
        "- Super Mario 64 / a: a summary\n  https://github.com/n64decomp/sm64@9921382: Mario actions\n  set_mario_action src/game/mario.c:979\n  children: wall-kick\n",
      );
      expect(digest).toContain(
        "- Super Mario 64 / b: b summary\n  https://github.com/n64decomp/sm64@9921382: b behavior\n  kick speed = 24 units/frame (src/game/mario_actions_airborne.c:12)\n  sources: src/game/mario_actions_airborne.c:40\n",
      );
      expect(digest).toContain("- Super Mario 64 / d: d summary\n- Super Mario 64 / e:");
      expect(digest).not.toContain("- Super Mario 64 / f:");
      expect(digest).toContain(
        `node /w/mario64/node_modules/@threenative/core/mcp/call.mjs threenative-engine engine_search_references '{"situation":"<mechanic>"}'`,
      );
      expect(
        referenceDigest("/w/mario64", "mario", () => {
          throw new Error("TN_REFERENCES_OFFLINE: fetch failed\nstack");
        }),
      ).toBe("References unavailable: TN_REFERENCES_OFFLINE: fetch failed\n");
      expect(referenceDigest("/w/x", "zzz", () => '{"results":[]}')).toBe(
        'No mechanics references match "zzz".\n',
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps package flags and template substitution single-sourced", async () => {
    const source = await readFile(path.resolve("packages/create-threenative/src/index.ts"), "utf8");
    expect(source.match(/const PACKAGE_SOURCE_FLAGS =/gu)).toHaveLength(1);
    expect(
      source.match(/type PackageSourceName = keyof typeof PACKAGE_SOURCE_FLAGS;/gu),
    ).toHaveLength(1);
    expect(source).not.toMatch(/type PackageSourceName = ["']/u);
    expect(
      source.match(/for \(const \[name, flag\] of Object\.entries\(PACKAGE_SOURCE_FLAGS\)\)/gu),
    ).toHaveLength(1);
    expect(source).not.toContain("for (const [name, flag] of [");
    expect(source.match(/function substituteTemplateVariables\(/gu)).toHaveLength(1);
    // Declaration plus its one call: `renderTemplate`. The reference bundle no longer renders
    // through it (PRD-449), so a second call site means a new substitution nobody gated.
    expect(source.match(/substituteTemplateVariables\(/gu)).toHaveLength(2);
    expect(source.match(/replaceAll\(placeholder, value\)/gu)).toHaveLength(1);
  });

  it.each([undefined, {}])(
    "pins the supported packageManager in generated projects (%j)",
    async (packageSources) => {
      const root = await makeTempDir("threenative-scaffold-pm-");
      try {
        const created = await createProject(
          { install: false, packageSources, target: "pm-game", template: "starter" },
          root,
        );
        const manifest = JSON.parse(
          await readFile(path.join(created.target, "package.json"), "utf8"),
        ) as { packageManager?: string };
        expect(manifest.packageManager).toBe("pnpm@10.25.0");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("stamps the authoring layer it wrote, and doctor reports it ok (PRD-829)", async () => {
    const root = await makeTempDir("threenative-scaffold-stamp-");
    try {
      const { target } = await createProject(
        { install: false, target: "stamped", template: "shooter" },
        root,
      );
      const stamp = JSON.parse(
        await readFile(path.join(target, ".threenative/agent-files.json"), "utf8"),
      ) as { createThreenative: string; kit: string; files: Record<string, string> };
      const own = JSON.parse(
        await readFile(path.resolve("packages/create-threenative/package.json"), "utf8"),
      ) as { version: string };
      expect({ version: stamp.createThreenative, kit: stamp.kit }).toEqual({
        version: own.version,
        kit: "shooter",
      });
      for (const file of [
        "AGENTS.md",
        "CLAUDE.md",
        ".claude/settings.json",
        ".claude/hooks/discovery-gate.mjs",
        ".agents/skills/threenative-capabilities/SKILL.md",
      ])
        expect(Object.keys(stamp.files)).toContain(file);
      for (const [file, hash] of Object.entries(stamp.files))
        expect(
          createHash("sha256")
            .update(await readFile(path.join(target, file)))
            .digest("hex"),
          file,
        ).toBe(hash);
      const { diagnoseProject, readProject } = await import("../src/doctor.js");
      const report = diagnoseProject(await readProject(target));
      expect(report.checks.find(({ name }) => name === "authoring layer")).toMatchObject({
        status: "ok",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);

  it("keeps every no-install scaffold tree byte-stable, in a shared and a kit hash", async () => {
    const root = await makeTempDir("threenative-scaffold-stability-");
    try {
      const actual: Record<string, IScaffoldTreePin> = {};
      for (const template of ALL_TEMPLATES) {
        const { target } = await createProject(
          { install: false, target: template, template },
          root,
        );
        expect(SCAFFOLD_TREE_HASHES[template]).toBeDefined();
        const buckets = await scaffoldTreeBuckets(target, template);
        actual[template] = { kit: buckets.kit, shared: buckets.shared };
        if (template === "platformer") {
          await expect(stat(path.join(target, "assets/sky.jpg"))).rejects.toThrow(/ENOENT/u);
        }
        if (template === "collectathon" || template === "adventure") {
          // Hop Garden's and Lantern Vale's geometry is procedural; their tiling surfaces are images (owner,
          // 2026-10-24: "make sure it doesnt bloat the games with many mb"): at most 1.5 MB, each
          // traced in PROVENANCE.md.
          const files = await readdir(path.join(target, "assets"), { recursive: true });
          const sizes = await Promise.all(
            files.map(async (file) => {
              const info = await stat(path.join(target, "assets", file));
              return info.isFile() ? info.size : 0;
            }),
          );
          expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1_500_000);
          // The textures ship once in `template-assets/assets/tex-*`; the licence record follows.
          const provenance = await readFile(
            path.join(target, "assets", "tex-PROVENANCE.md"),
            "utf8",
          );
          const textures = files.filter((name) => name.endsWith(".webp"));
          expect(textures).toHaveLength(template === "collectathon" ? 12 : 5);
          for (const file of textures) expect(provenance).toContain(path.basename(file).slice(4));
        }
        if (template === "kart") {
          // Clover Cup is all procedural (owner, 2026-10-24): no assets folder and
          // no image or model file but the shared icon, so every texture is painted in code.
          await expect(stat(path.join(target, "assets"))).rejects.toThrow(/ENOENT/u);
          const media = (await readdir(target, { recursive: true })).filter(
            (file) =>
              /\.(png|jpe?g|webp|ktx2|hdr|exr|glb|gltf|fbx|obj)$/u.test(file) &&
              file !== path.join("public", "icon.png"),
          );
          expect(media).toEqual([]);
        }
      }
      // Two hashes per kit, so a stale pin says which side of the scaffold moved.
      for (const [template, buckets] of Object.entries(actual)) {
        expect(SCAFFOLD_TREE_HASHES[template], template).toEqual({
          kit: buckets.kit,
          shared: buckets.shared,
        });
      }
      expect(Object.keys(actual).sort()).toEqual([...ALL_TEMPLATES].sort());
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("ships the quality gate as two thin root configs and three scripts in every template", async () => {
    const root = await makeTempDir("threenative-quality-config-");
    try {
      for (const template of ALL_TEMPLATES) {
        const { target } = await createProject(
          { install: false, target: template, template },
          root,
        );
        const nonblank = (
          await Promise.all(
            ["eslint.config.js", "biome.json"].map((name) =>
              readFile(path.join(target, name), "utf8"),
            ),
          )
        )
          .join("\n")
          .split("\n")
          .filter((line) => line.trim() !== "").length;
        expect(nonblank, `${template} config lines`).toBeLessThanOrEqual(80);
        const manifest = JSON.parse(await readFile(path.join(target, "package.json"), "utf8")) as {
          devDependencies: Record<string, string>;
          scripts: Record<string, string>;
        };
        expect(manifest.scripts.check, template).toBe(
          "pnpm typecheck && pnpm lint && pnpm format:check",
        );
        expect(manifest.scripts.lint, template).toBe("eslint src");
        expect(manifest.scripts["format:check"], template).toBe("biome format src");
        expect(manifest.scripts.test, template).toMatch(/^pnpm check && /u);
        expect(manifest.devDependencies.eslint, template).toMatch(/^\d/u);
        expect(manifest.devDependencies["@biomejs/biome"], template).toMatch(/^\d/u);
        expect(Object.values(manifest.scripts).join(" "), template).not.toContain("npx");
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("copies the canonical native icon to every fixed generated output", async () => {
    const canonical = await readFile(
      path.resolve("packages/create-threenative/template-assets/icon.png"),
    );
    const root = await makeTempDir("threenative-scaffold-icon-");
    try {
      for (const template of ALL_TEMPLATES) {
        const { target } = await createProject(
          { install: false, target: `${template}-game`, template },
          root,
        );
        expect(await readFile(path.join(target, "public/icon.png")), template).toEqual(canonical);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // PRD-449: the pages ship inside the installed `create-threenative`, so the scaffold writes no
  // `agent-docs/` at all. The links the generated instructions carry must still resolve, or a
  // cold agent follows one into a dead path — checked here against the package's bundle, which is
  // exactly what the package's `files` list installs.
  //
  // One page is not in a source checkout: PRD-836 made the capability reference prepack output, so
  // a clone that never ran `pnpm build` has no file to look at. `publication.spec.ts` asserts the
  // packed tarball carries it, which is where the link actually has to resolve.
  it("should ship no reference bundle and leave every link resolving in the package", async () => {
    const root = await makeTempDir("threenative-reference-bundle-");
    const bundleDirectory = path.resolve("packages/create-threenative/agent-docs/references");
    try {
      const result = await createProject(
        { install: false, target: "my-game", template: "starter" },
        root,
      );
      await expect(lstat(path.join(result.target, "agent-docs"))).rejects.toThrow();
      const instructionFiles = [
        "AGENTS.md",
        "CLAUDE.md",
        ...(await readdir(path.join(result.target, ".agents/skills"))).map(
          (skill) => `.agents/skills/${skill}/SKILL.md`,
        ),
      ];
      for (const file of instructionFiles) {
        const content = await readFile(path.join(result.target, file), "utf8");
        const pages = [
          ...content.matchAll(
            /create-threenative\/agent-docs\/references\/([a-z0-9][a-z0-9-]*\.md)/gu,
          ),
        ]
          .map((match) => match[1] ?? "")
          .filter((page) => !PACK_GENERATED_PAGES.includes(page));
        for (const page of pages) {
          expect(
            existsSync(path.join(bundleDirectory, page)),
            `${file} links a page the package does not ship: ${page}`,
          ).toBe(true);
        }
        // Not a vacuous pass: the kit router names the conventions page, its kit notes and the recipes.
        if (file === "AGENTS.md") expect(pages.length).toBeGreaterThanOrEqual(4);
      }
      // Nothing substitutes into the pages any more, so a token would ship literally.
      for (const page of await readdir(bundleDirectory)) {
        const content = await readFile(path.join(bundleDirectory, page), "utf8");
        expect(content, page).not.toContain("__PROJECT_NAME__");
        expect(content, page).not.toContain("__PROJECT_ID__");
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("should expose the shared visual workflow and authoring scripts in a fresh scaffold", async () => {
    const root = await makeTempDir("threenative-dream-loop-scaffold-");
    try {
      const result = await createProject(
        { install: false, target: "dream-game", template: "starter" },
        root,
      );
      // The page lives in the installed package, not the project (PRD-449); the generated skill
      // still points at the file it ships.
      const workflow = await readFile(
        path.resolve("packages/create-threenative/agent-docs/references/dream-loop.md"),
        "utf8",
      );
      expect(workflow).toContain("node scripts/reference.mjs");
      expect(workflow).toContain("node scripts/visual-loop.mjs");
      expect(workflow).toContain("Anshu Chimala");
      for (const host of [".agents/skills", ".claude/skills"]) {
        const visual = await readFile(
          path.join(result.target, host, "threenative-visuals/SKILL.md"),
          "utf8",
        );
        const assets = await readFile(
          path.join(result.target, host, "threenative-assets/SKILL.md"),
          "utf8",
        );
        expect(visual).toContain(REFERENCE_PREFIX);
        expect(assets).toContain(REFERENCE_PREFIX);
      }
      await expect(stat(path.join(result.target, "scripts/reference.mjs"))).resolves.toBeTruthy();
      await expect(stat(path.join(result.target, "scripts/visual-loop.mjs"))).resolves.toBeTruthy();
      const gitignore = await readFile(path.join(result.target, ".gitignore"), "utf8");
      for (const rule of [
        ".dream-loop/",
        ".threenative/discovery-gate.json",
        "node_modules/",
        ".env",
        ".env.*",
        "!.env.example",
      ])
        expect(gitignore).toContain(rule);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // One stored copy, two host directories. A duplicated skill drifts the day one adapter is
  // edited, and a copied `capabilities.json` drifts the day the engine dependency moves — the
  // installed `@threenative/core` copy is what the MCP actually reads.
  it("should store each skill once and link it into the Claude host directory", async () => {
    const root = await makeTempDir("threenative-single-skill-copy-");
    try {
      const { target } = await createProject(
        { install: false, target: "linked-skill-game", template: "starter" },
        root,
      );
      const claudeSkills = path.join(target, ".claude", "skills");
      const stored = (
        await readdir(path.join(target, ".agents", "skills"), { withFileTypes: true })
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(stored.length).toBeGreaterThan(0);
      // Claude Code gets builder and verifier as subagents, not skills, so it has no skill to link.
      const linked = (await readdir(claudeSkills, { withFileTypes: true })).map(
        (entry) => entry.name,
      );
      for (const subagentOnly of ["threenative-builder", "threenative-verifier"]) {
        expect(stored).toContain(subagentOnly);
        expect(linked, subagentOnly).not.toContain(subagentOnly);
        await expect(lstat(path.join(claudeSkills, subagentOnly))).rejects.toThrow();
        await expect(
          lstat(path.join(target, ".claude", "agents", `${subagentOnly}.md`)),
        ).resolves.toBeTruthy();
      }
      expect(linked.sort()).toEqual(
        stored.filter((name) => !["threenative-builder", "threenative-verifier"].includes(name)),
      );
      for (const name of linked) {
        const link = path.join(claudeSkills, name);
        expect((await lstat(link)).isSymbolicLink(), `${name} is a second stored copy`).toBe(true);
        expect(await realpath(link)).toBe(
          await realpath(path.join(target, ".agents", "skills", name)),
        );
      }
      for (const dropped of ["capabilities.json", "AGENT-ROLES.md"]) {
        await expect(lstat(path.join(target, dropped)), dropped).rejects.toThrow();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // One stored copy per skill: `.claude/skills` is a symlink into `.agents/skills`, so breaking the
  // stored file breaks both host reads the scaffolder asserts on.
  it.each([
    "agent-files/.agents/skills/threenative-visuals/SKILL.md",
    "agent-files/.agents/skills/threenative-assets/SKILL.md",
  ])("should fail when %s names an absent dream-loop recipe", async (relativePath) => {
    const source = await readFile(
      path.resolve("packages/create-threenative", relativePath),
      "utf8",
    );
    await withBrokenTemplateFile(
      relativePath,
      source.replaceAll(
        `${REFERENCE_PREFIX}dream-loop.md`,
        `${REFERENCE_PREFIX}missing-dream-loop.md`,
      ),
      async (root) => {
        await expect(
          createProject(
            { install: false, target: "broken-dream-game", template: "starter" },
            path.dirname(root),
            root,
          ),
        ).rejects.toThrow(/RED observed: referenced recipe missing/u);
      },
    );
  });

  it("should preserve asset licensing and sculpt gates when target acquisition is used", async () => {
    const recipe = await readFile(
      path.resolve("packages/create-threenative/agent-docs/references/sculpt-from-a-reference.md"),
      "utf8",
    );
    expect(recipe).toContain(`${REFERENCE_PREFIX}dream-loop.md`);
    expect(recipe).toContain("CREDITS.md");
    const assets = await readFile(
      path.resolve(
        "packages/create-threenative/agent-files",
        ".agents/skills",
        "threenative-assets/SKILL.md",
      ),
      "utf8",
    );
    expect(assets).toContain("sculpt_plan");
    expect(assets).toContain("sculpt_spec_gate");
    expect(assets).toContain("sculpt_compare");
    expect(assets).toContain("sculpt_pass_gate");
    expect(assets).toContain(`${REFERENCE_PREFIX}dream-loop.md`);
    expect(assets).toContain("CREDITS.md");
  });

  it.each(ALL_TEMPLATES)(
    "should overlay the canonical builder and verifier roles on the %s scaffold",
    async (template) => {
      const root = await makeTempDir(`threenative-agent-roles-${template}-`);
      try {
        const result = await createProject(
          { install: false, target: `${template}-game`, template },
          root,
        );
        const contents = await Promise.all(
          AGENT_ROLE_PATHS.map(async (relativePath) => {
            const content = await readFile(path.join(result.target, relativePath), "utf8");
            expect(content, relativePath).not.toContain("__PROJECT_NAME__");
            expect(content, relativePath).not.toContain("__PROJECT_ID__");
            return [relativePath, content] as const;
          }),
        );
        const files = new Map(contents);
        const builder = files.get(".threenative/agents/builder.md") ?? "";
        const verifier = files.get(".threenative/agents/verifier.md") ?? "";
        expect(builder).toContain("one bounded player-visible outcome");
        expect(builder).toContain("engine-owned or game-owned");
        expect(builder).toContain("production readiness");
        expect(verifier.toLowerCase()).toContain("read-only");
        expect(verifier).toContain("must not edit");
        expect(new Set(verifier.match(/`(?:PASS|REQUEST_CHANGES|NOT_OBSERVED)`/gu))).toEqual(
          new Set(["`PASS`", "`REQUEST_CHANGES`", "`NOT_OBSERVED`"]),
        );

        const adapterPaths = [
          [".claude/agents/threenative-builder.md", ".claude/agents/threenative-verifier.md"],
          [
            ".agents/skills/threenative-builder/SKILL.md",
            ".agents/skills/threenative-verifier/SKILL.md",
          ],
        ] as const;
        for (const [builderPath, verifierPath] of adapterPaths) {
          const builderAdapter = files.get(builderPath) ?? "";
          const verifierAdapter = files.get(verifierPath) ?? "";
          expect(builderAdapter).toContain(".threenative/agents/builder.md");
          expect(builderAdapter).toContain("AGENTS.md");
          expect(verifierAdapter).toContain(".threenative/agents/verifier.md");
          expect(verifierAdapter).toContain("AGENTS.md");
          expect(builderAdapter.length).toBeLessThan(500);
          expect(verifierAdapter.length).toBeLessThan(500);
        }

        const bugSkillBodies = await Promise.all(
          BUG_REPORT_SKILL_PATHS.map(async (relativePath) => {
            const content = await readFile(path.join(result.target, relativePath), "utf8");
            expect(content, relativePath).not.toContain("__PROJECT_NAME__");
            expect(content, relativePath).not.toContain("__PROJECT_ID__");
            return content;
          }),
        );
        for (const skill of bugSkillBodies) {
          expect(skill).toContain("gh auth status");
          expect(skill).toContain("gh issue create");
          expect(skill).toContain("ThreeNativeHQ/threenative");
        }
        // Both host adapters ship one recipe; a drift between them ships two contracts.
        expect(new Set(bugSkillBodies).size).toBe(1);
        const packageJson = JSON.parse(
          await readFile(path.join(result.target, "package.json"), "utf8"),
        ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const dependencyNames = [
          ...Object.keys(packageJson.dependencies ?? {}),
          ...Object.keys(packageJson.devDependencies ?? {}),
        ];
        expect(dependencyNames).not.toContain("claude");
        expect(dependencyNames).not.toContain("codex");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps the starter's shipped assets mobile-shippable", async () => {
    // Decoder-free mobile cooking may emit raw ASTC, while Basis and Meshopt still need decoders.
    // Check the produced KTX2 headers rather than treating every KTX2 as Basis.
    const root = await makeTempDir("threenative-scaffold-mobile-");
    try {
      await mkdir(path.join(root, "assets"), { recursive: true });
      await cp(path.join(TEMPLATE_ROOT, "starter", "assets"), path.join(root, "assets"), {
        recursive: true,
      });
      // Gradients with ±3 levels of noise resist PNG compression without violating PRD-351's quality floor like pure noise.
      const noise = (x: number, y: number, shift: number): number => {
        let value = Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 1, 0x27d4eb2d);
        value ^= value >>> 16;
        return ((value >>> shift) % 7) - 3;
      };
      await writeFile(
        path.join(root, "assets", "web-codec-proof.png"),
        rgbaPng({
          blue: (x, y) => 48 + Math.floor((x + y) / 2) + noise(x, y, 16),
          green: (x, y) => 48 + y + noise(x, y, 8),
          height: 128,
          red: (x, y) => 48 + x + noise(x, y, 0),
          width: 128,
        }),
      );

      await compileAssets({
        cwd: root,
        platform: "android",
        runtimeDecoders: { ktx2: false, meshopt: false },
      });
      const android = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      ) as { entries: Record<string, { extensions?: string[]; output: string; format?: string }> };
      const mobileOutputs = Object.values(android.entries);
      expect(mobileOutputs.length).toBeGreaterThan(0);
      expect(
        mobileOutputs.some((entry) => /\.ktx2$/u.test(entry.output) && entry.format === "astc4x4"),
      ).toBe(true);
      for (const entry of mobileOutputs) {
        if (/\.ktx2$/u.test(entry.output)) {
          const raw = readKTX2(await readFile(path.join(root, "public", entry.output)));
          expect([157, 158]).toContain(raw.vkFormat);
          expect(raw.supercompressionScheme).toBe(0);
          expect(raw.globalData).toBeNull();
          const levels = Math.floor(Math.log2(Math.max(raw.pixelWidth, raw.pixelHeight))) + 1;
          expect(raw.levelCount).toBe(levels);
          expect(raw.levels).toHaveLength(levels);
          for (const [mip, level] of raw.levels.entries()) {
            const bytes =
              Math.ceil(Math.max(1, raw.pixelWidth >> mip) / 4) *
              Math.ceil(Math.max(1, raw.pixelHeight >> mip) / 4) *
              16;
            expect(level.levelData.byteLength).toBe(bytes);
            expect(level.uncompressedByteLength).toBe(bytes);
          }
          expect(entry.format).toBe("astc4x4");
        }
        expect(entry.extensions ?? []).not.toContain("EXT_meshopt_compression");
      }

      await rm(path.join(root, "public"), { force: true, recursive: true });
      await compileAssets({ cwd: root, platform: "web" });
      const web = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      ) as { entries: Record<string, { output: string }> };
      expect(web.entries["native-proof.png"]?.output).toMatch(/\.png$/u);
      expect(web.entries["web-codec-proof.png"]?.output).toMatch(/\.ktx2$/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should generate the starter tree without catalog protocols", async () => {
    const root = await makeTempDir("threenative-scaffold-");
    try {
      const result = await createProject(
        { install: false, target: "my-game", template: "starter" },
        root,
      );
      expect(result.template).toBe("starter");
      const packageJson = await readFile(path.join(result.target, "package.json"), "utf8");
      expect(packageJson).not.toContain("catalog:");
      const packageManifest = JSON.parse(packageJson) as {
        pnpm?: { patchedDependencies?: Record<string, string> };
      };
      expect(packageManifest.pnpm?.patchedDependencies).toEqual({
        "three@0.187.0": "patches/three@0.187.0.patch",
        "vite@8.2.0": "patches/vite@8.2.0.patch",
        "@tailwindcss/node@4.3.3": "patches/@tailwindcss__node@4.3.3.patch",
      });
      // The tree hash reads a framework patch by name only, so the bytes are held here: each copy
      // is exactly the patch its package installs.
      const repoRoot = path.resolve(import.meta.dirname, "../../..");
      for (const [copy, source] of [
        ["three@0.187.0.patch", "packages/core/patches/three@0.187.0.patch"],
        ["vite@8.2.0.patch", "patches/vite@8.2.0.patch"],
        ["@tailwindcss__node@4.3.3.patch", "patches/@tailwindcss__node@4.3.3.patch"],
      ] as const) {
        expect(await readFile(path.join(result.target, "patches", copy))).toEqual(
          await readFile(path.join(repoRoot, source)),
        );
      }
      // The whole point of the cut (PRD-449): a new game proves itself with four scenarios, and
      // the engine's own guards live outside the template. The directories are the contract here;
      // the tree pin owns which files must exist.
      expect(
        (await readdir(path.join(result.target, "playtests"))).filter((name) =>
          name.endsWith(".playtest.json"),
        ),
      ).toEqual([
        "movement.playtest.json",
        "play.playtest.json",
        "production-readiness.playtest.json",
        "survives.playtest.json",
      ]);
      // A scaffolded project must land with audio every target can decode, WAV included, or its
      // first `--target android` build installs and shows nothing.
      const pickupAudio = await readFile(path.join(result.target, "assets/pickup.wav"));
      expect(pickupAudio.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(pickupAudio.subarray(8, 12).toString("ascii")).toBe("WAVE");
      const agents = await readFile(path.join(result.target, "AGENTS.md"), "utf8");
      expect(agents).toContain("my-game");
      expect(agents).not.toContain("__PROJECT_NAME__");
      await expect(readFile(path.join(result.target, "CLAUDE.md"), "utf8")).resolves.toContain(
        "Generated mirror of AGENTS.md",
      );
      await expect(
        readFile(path.join(result.target, "src/entities/Player.ts"), "utf8"),
      ).resolves.toContain("debug()");
      await expect(
        readFile(path.join(result.target, "src/scenes/Play.ts"), "utf8"),
      ).resolves.toMatch(/ctx\.entities\.add\(\s*"player"/u);
      const renderFiles = await Promise.all(
        ["lighting.ts", "postprocessing.ts", "materials.ts"].map((file) =>
          readFile(path.join(result.target, "src/render", file), "utf8"),
        ),
      );
      expect(
        renderFiles.join("\n").replaceAll('from "@threenative/core"', 'from "shared-core"'),
      ).not.toContain("@threenative/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The compile step owns public/'s generated outputs; the sources ship in assets/. With no
  // raw copy left in public/, any dev server or build must compile first — which is what
  // playtests/assets.playtest.json proves against a served game.
  it("should ship source assets and never scaffold an empty assets directory", async () => {
    const root = await makeTempDir("threenative-scaffold-assets-");
    try {
      const result = await createProject(
        { install: false, target: "my-game", template: "starter" },
        root,
      );
      await expect(
        readFile(path.join(result.target, "assets/native-proof.glb")),
      ).resolves.toBeTruthy();
      const gitignore = await readFile(path.join(result.target, ".gitignore"), "utf8");
      expect(gitignore).toContain("public/assets.manifest.json");
      for (const absent of ["assets/.gitkeep", "public/assets.manifest.json"]) {
        await expect(stat(path.join(result.target, absent))).rejects.toThrow();
      }
      // The packed CLI itself depends on @threenative/assets, so a local-pack install needs a
      // pnpm override per provided source, not just a rewritten direct pin.
      const sourced = await createProject(
        {
          install: false,
          packageSources: {
            "@threenative/assets": "/tmp/assets.tgz",
            "create-threenative": "/tmp/cli.tgz",
          },
          target: "sourced-game",
          template: "starter",
        },
        root,
      );
      const sourcedManifest = JSON.parse(
        await readFile(path.join(sourced.target, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        pnpm?: { overrides?: Record<string, string> };
      };
      expect(sourcedManifest.devDependencies?.["@threenative/assets"]).toBe("file:/tmp/assets.tgz");
      expect(sourcedManifest.dependencies?.["@threenative/assets"]).toBeUndefined();
      expect(sourcedManifest.pnpm?.overrides).toMatchObject({
        "@threenative/assets": "file:/tmp/assets.tgz",
        "create-threenative": "file:/tmp/cli.tgz",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should generate loader-valid identifiers at the leading-digit boundary", async () => {
    const root = await makeTempDir("threenative-scaffold-identifiers-");
    try {
      for (const [target, expectedId] of [
        ["123-game", "com.threenative.game123game"],
        ["fox-game", "com.threenative.foxgame"],
      ] as const) {
        const result = await createProject({ install: false, target, template: "minimal" }, root);
        await expect(loadConfig(result.target)).resolves.toMatchObject({
          app: { id: expectedId },
          ui: { renderer: "native" },
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should scaffold the minimal kit with a render layer and a game entry", async () => {
    const root = await makeTempDir("threenative-minimal-render-");
    try {
      const result = await createProject(
        { install: false, target: "minimal-look", template: "minimal" },
        root,
      );
      // Not a list of names and not a frozen count: the allowlist owns which kinds of file may
      // ship and the tree pin owns every byte, so this only holds the kit to having a look at all.
      expect(await readdir(path.join(result.target, "src/render"))).not.toHaveLength(0);
      await expect(readFile(path.join(result.target, "src/game.ts"), "utf8")).resolves.toContain(
        "export default game",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(ALL_TEMPLATES)(
    "should bind the game used by UI intents in the %s template",
    async (template) => {
      const source = await readFile(path.join(TEMPLATE_ROOT, template, "src/game.ts"), "utf8");
      if (!source.includes("game.ui.onIntent")) return;
      expect(source).toContain("const game = defineGame");
      expect(source).toContain("export default game");
    },
  );

  it("should not ship recast in a build that never imports the navigation entry", async () => {
    const root = await makeTempDir("threenative-minimal-bundle-");
    try {
      const result = await createProject(
        { install: false, target: "minimal-bundle", template: "minimal" },
        root,
      );
      // This build checks core's bundle, not an engine: it names the legacy engine so it needs no Wasm module.
      const configPath = path.join(result.target, "threenative.config.ts");
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8")).replace(
          "const config: IThreeNativeConfig = {",
          'const config: IThreeNativeConfig = {\n  engine: "threejs",',
        ),
      );
      const scope = path.join(result.target, "node_modules", "@threenative");
      await mkdir(scope, { recursive: true });
      await symlink(path.resolve("packages/core"), path.join(scope, "core"), "dir");
      await symlink(path.resolve("packages/physics"), path.join(scope, "physics"), "dir");
      // The template vite.config.ts imports watchAssets from @threenative/assets in serve
      // mode; a build that resolves the config needs the package present to reject it.
      await symlink(path.resolve("packages/assets"), path.join(scope, "assets"), "dir");
      await symlink(
        path.resolve("packages/create-threenative"),
        path.join(result.target, "node_modules", "create-threenative"),
        "dir",
      );
      const pnpmPackages = await readdir(path.resolve("node_modules/.pnpm"));
      const vitePackage = pnpmPackages.find((entry) => entry.startsWith("vite@"));
      const threePackage = pnpmPackages.find((entry) => entry.startsWith("three@"));
      if (vitePackage === undefined || threePackage === undefined) {
        throw new Error("Bundle isolation requires the workspace Vite and Three.js packages.");
      }
      await symlink(
        path.resolve("node_modules/.pnpm", vitePackage, "node_modules/vite"),
        path.join(result.target, "node_modules", "vite"),
        "dir",
      );
      await symlink(
        path.resolve("node_modules/.pnpm", threePackage, "node_modules/three"),
        path.join(result.target, "node_modules", "three"),
        "dir",
      );
      try {
        const viteCli = path.resolve(
          "node_modules/.pnpm",
          vitePackage,
          "node_modules/vite/bin/vite.js",
        );
        await run(process.execPath, [viteCli, "build", result.target], { cwd: process.cwd() });
      } catch (error) {
        const output = error as { code?: string | number; stderr?: string; stdout?: string };
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} code=${output.code ?? "unknown"}\n${output.stdout ?? ""}\n${output.stderr ?? ""}`,
        );
      }
      const distRoot = path.join(result.target, "dist");
      const entries = await readdir(distRoot, { recursive: true });
      const files = (
        await Promise.all(
          entries.map(async (entry) => {
            const relativePath = String(entry);
            return (await stat(path.join(distRoot, relativePath))).isFile()
              ? relativePath
              : undefined;
          }),
        )
      ).filter((entry): entry is string => entry !== undefined);
      const artifactNames = files.filter((file) => file.toLowerCase().includes("recast"));
      const contents = await Promise.all(
        files.map(async (file) => {
          const value = await readFile(path.join(result.target, "dist", file));
          return value.toString("utf8");
        }),
      );

      expect(artifactNames).toEqual([]);
      expect(contents.join("\n")).not.toMatch(/recast-navigation|@recast-navigation/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should parse the no-install and template flags", () => {
    expect(parseArgs(["my-game", "--template", "minimal", "--no-install"])).toEqual({
      install: false,
      target: "my-game",
      template: "minimal",
    });
  });

  it("should reject an occupied or file target and create nested parents", async () => {
    const root = await makeTempDir("threenative-target-collisions-");
    try {
      await mkdir(path.join(root, "occupied"), { recursive: true });
      await writeFile(path.join(root, "occupied", "keep.txt"), "x");
      await expect(createProject({ install: false, target: "occupied" }, root)).rejects.toThrow(
        /already exists and is not empty/u,
      );

      await writeFile(path.join(root, "a-file"), "x");
      await expect(createProject({ install: false, target: "a-file" }, root)).rejects.toThrow(
        /already exists and is not empty/u,
      );

      const result = await createProject({ install: false, target: "nested/deep/game" }, root);
      expect(result.target.endsWith("nested/deep/game")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("should fail closed on a malformed kit manifest with the exact named codes", async () => {
    const templates = path.join(await makeTempDir("threenative-kit-manifest-"), "templates");
    const valid = {
      blurb: "collect pickups",
      genre: "arcade",
      kit: true,
      name: "pickup",
      title: "Pickup Run",
    };
    const cases: ReadonlyArray<[string, string, RegExp]> = [
      ["noparse", "not json", /TN_KIT_MANIFEST_INVALID.*JSON could not be parsed/u],
      ["array", "[]", /root must be an object/u],
      [
        "name-mismatch",
        JSON.stringify({ ...valid, name: "other" }),
        /name 'other' must match directory 'name-mismatch'/u,
      ],
      [
        "not-kit",
        JSON.stringify({ ...valid, name: "not-kit", kit: "yes" }),
        /kit must be a boolean/u,
      ],
      [
        "no-blurb",
        JSON.stringify({ ...valid, name: "no-blurb", blurb: "" }),
        /blurb must be a non-empty string/u,
      ],
      [
        "no-genre",
        JSON.stringify({ ...valid, name: "no-genre", genre: 7 }),
        /genre must be a non-empty string/u,
      ],
      [
        "no-title",
        JSON.stringify({ ...valid, name: "no-title", title: "" }),
        /title must be a non-empty string/u,
      ],
    ];
    try {
      for (const [name, content, expected] of cases) {
        const directory = path.join(templates, name);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "kit.json"), content);
        try {
          expect(() => discoverKitManifests(templates)).toThrow(expected);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      expect(discoverKitManifests(templates)).toEqual([]);
    } finally {
      await rm(templates, { recursive: true, force: true });
    }
  });

  it("should parse flags that precede the target directory", () => {
    expect(parseArgs(["--no-install", "my-game"])).toEqual({
      install: false,
      target: "my-game",
    });
    expect(parseArgs(["--template", "minimal", "--no-install", "my-game"])).toEqual({
      install: false,
      target: "my-game",
      template: "minimal",
    });
  });

  it("should parse equals-form flags", () => {
    expect(parseArgs(["--template=minimal", "my-game"])).toEqual({
      install: true,
      target: "my-game",
      template: "minimal",
    });
    expect(parseArgs(["--no-install", "--cli-package=/tmp/cli.tgz", "my-game"])).toEqual({
      install: false,
      packageSources: { "create-threenative": "/tmp/cli.tgz" },
      target: "my-game",
    });
  });

  it("should fail closed on unknown and dangling flags instead of ignoring them", () => {
    expect(() => parseArgs(["my-game", "--tempalte", "minimal"])).toThrow(
      "Unknown option '--tempalte'. Usage: pnpm create threenative my-game",
    );
    expect(() => parseArgs(["my-game", "--template"])).toThrow(
      "Option '--template' requires a value. Usage: pnpm create threenative my-game",
    );
    expect(() => parseArgs(["my-game", "other-game"])).toThrow(
      "Unexpected extra argument 'other-game'. Usage: pnpm create threenative my-game",
    );
  });

  it("should scaffold the platformer template with no catalog protocols", async () => {
    const root = await makeTempDir("threenative-platformer-");
    try {
      const result = await createProject(
        { install: false, target: "fox-run", template: "platformer" },
        root,
      );
      expect(result.template).toBe("platformer");
      const packageJson = await readFile(path.join(result.target, "package.json"), "utf8");
      expect(packageJson).not.toContain("catalog:");
      await expect(
        readFile(path.join(result.target, "src/entities/Fox.ts"), "utf8"),
      ).resolves.toContain("FOX_FEEL");
      await expect(
        readFile(path.join(result.target, "src/scenes/Play.ts"), "utf8"),
      ).resolves.toContain('ctx.entities.add("player"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should launch all three MCP servers through the core shims", async () => {
    const root = await makeTempDir("threenative-mcp-");
    try {
      const result = await createProject(
        { install: false, target: "my-game", template: "starter" },
        root,
      );
      const raw = await readFile(path.join(result.target, ".mcp.json"), "utf8");
      expect(raw).not.toContain("npx");
      const config = JSON.parse(raw) as {
        mcpServers: Record<string, { args: string[]; command: string }>;
      };
      const assetServer = config.mcpServers["threenative-assets"];
      expect(assetServer?.command).toBe("node");
      expect(assetServer?.args[0]).toBe(`${CORE_SHIM}/assets.mjs`);
      const sculptServer = config.mcpServers["threenative-sculpt"];
      expect(sculptServer?.command).toBe("node");
      expect(sculptServer?.args[0]).toBe(`${CORE_SHIM}/sculpt.mjs`);
      const engineServer = config.mcpServers["threenative-engine"];
      expect(engineServer?.command).toBe("node");
      expect(engineServer?.args[0]).toBe(`${CORE_SHIM}/engine.mjs`);
      const codex = await readFile(path.join(result.target, ".codex", "config.toml"), "utf8");
      expect(codex).toContain("[mcp_servers.threenative-engine]");
      expect(codex).toContain(`args = ["${CORE_SHIM}/engine.mjs"]`);
      const manifest = JSON.parse(
        await readFile(path.join(result.target, "package.json"), "utf8"),
      ) as { devDependencies?: Record<string, string> };
      expect(manifest.devDependencies?.[ASSET_MCP]).toBeUndefined();
      expect(manifest.devDependencies?.[SCULPT_MCP]).toBeUndefined();
      expect(manifest.devDependencies?.[ENGINE_MCP]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should pin no MCP server package in any template", async () => {
    const pins = await Promise.all(
      ALL_TEMPLATES.map(async (template) => {
        const manifest = JSON.parse(
          await readFile(path.join(TEMPLATE_ROOT, template, "package.json"), "utf8"),
        ) as { devDependencies?: Record<string, string> };
        return {
          asset: manifest.devDependencies?.[ASSET_MCP],
          engine: manifest.devDependencies?.[ENGINE_MCP],
          sculpt: manifest.devDependencies?.[SCULPT_MCP],
        };
      }),
    );
    expect(pins.every(({ asset, engine, sculpt }) => !asset && !engine && !sculpt)).toBe(true);
  });

  it("forces the broken sharp 0.34 line off every template's dependency tree", async () => {
    // `@gltf-transform/cli@4.4.2` drags `sharp ~0.34.5`, whose prebuilt does not load on modern
    // glibc: a plain `npm install` of a scaffold then dies trying to build it from source. The
    // same line is covered by GHSA-rgj7-g3m4-5g8c (`sharp <0.35.4`). PRD-445's root override
    // does not reach a consumer's own project, so every template carries the pin for npm and pnpm.
    for (const template of ALL_TEMPLATES) {
      const manifest = JSON.parse(
        await readFile(path.join(TEMPLATE_ROOT, template, "package.json"), "utf8"),
      ) as { overrides?: Record<string, string>; pnpm?: { overrides?: Record<string, string> } };
      expect(manifest.overrides?.sharp, `${template} npm override`).toBe(">=0.35.4");
      expect(manifest.pnpm?.overrides?.sharp, `${template} pnpm override`).toBe(">=0.35.4");
    }
  });

  it("keeps Vite's optional devtools peer off the npm 10 crash (PRD-637)", async () => {
    // `vite@8.2.0+` lists `@vitejs/devtools@^0.4.0` as an optional peer, and 0.4.2+ peers back on
    // the devtools packages. npm 10 (the npm in Node 20 LTS) dies on that peer set with
    // `Cannot read properties of null (reading 'edgesOut')`, so a fresh scaffold could not install.
    // The pin names the last devtools release whose only peer is vite.
    for (const template of ALL_TEMPLATES) {
      const manifest = JSON.parse(
        await readFile(path.join(TEMPLATE_ROOT, template, "package.json"), "utf8"),
      ) as { devDependencies?: Record<string, string>; overrides?: Record<string, string> };
      if (manifest.devDependencies?.vite === undefined) continue;
      expect(manifest.overrides?.["@vitejs/devtools"], `${template} npm override`).toBe("0.4.1");
    }
  });

  it("should document only tools the pinned asset MCP actually serves", async () => {
    const surface = JSON.parse(
      await readFile(path.resolve("packages/create-threenative/asset-mcp-tools.json"), "utf8"),
    ) as { recommended: string[]; tools: string[]; version: string };
    const served = new Set(surface.tools);
    const coreManifest = JSON.parse(
      await readFile(path.resolve("packages/core/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(coreManifest.dependencies?.[ASSET_MCP]).toBe(surface.version);
    const namespaces = new Set(surface.tools.map((tool) => tool.split("_")[0]));
    for (const template of ALL_TEMPLATES) {
      const agents = await readFile(path.join(TEMPLATE_ROOT, template, "AGENTS.md"), "utf8");
      const assetSkill = await readFile(
        path.join(
          TEMPLATE_ROOT,
          "..",
          "agent-files",
          ".agents",
          "skills",
          "threenative-assets",
          "SKILL.md",
        ),
        "utf8",
      );
      const authoringText = `${agents}\n${assetSkill}`;
      const mentioned = [...authoringText.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/gu)]
        .map((match) => match[1] as string)
        .filter((name) => namespaces.has(name.split("_")[0] as string));
      expect(
        mentioned.filter((name) => !served.has(name)),
        template,
      ).toEqual([]);
      for (const name of surface.recommended)
        expect(authoringText, `${template}/${name}`).toContain(name);
    }
  });

  it("should write every host MCP config because no template ships one", async () => {
    const root = await makeTempDir("threenative-mcp-generated-");
    try {
      const result = await createProject(
        { install: false, target: "my-game", template: "starter" },
        root,
      );
      for (const file of [
        ".mcp.json",
        ".codex/config.toml",
        ".cursor/mcp.json",
        ".vscode/mcp.json",
        ".gemini/settings.json",
        ".zed/settings.json",
        "opencode.json",
      ]) {
        await expect(stat(path.join(result.target, file)), file).resolves.toBeDefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("should complete a template .mcp.json that lists only some servers", async () => {
    const root = await makeTempDir("threenative-mcp-partial-");
    try {
      const partial = JSON.stringify({
        mcpServers: {
          "threenative-assets": { command: "node", args: [`${CORE_SHIM}/assets.mjs`] },
        },
      });
      await withBrokenTemplateFile("starter/.mcp.json", partial, async (templates) => {
        const result = await createProject(
          { install: false, target: "my-game", template: "starter" },
          root,
          templates,
        );
        const config = JSON.parse(
          await readFile(path.join(result.target, ".mcp.json"), "utf8"),
        ) as {
          mcpServers: Record<string, unknown>;
        };
        expect(Object.keys(config.mcpServers)).toEqual(
          expect.arrayContaining([
            "threenative-assets",
            "threenative-sculpt",
            "threenative-engine",
          ]),
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("should throw when .mcp.json names a package the project does not depend on", async () => {
    const root = await makeTempDir("threenative-mcp-undeclared-");
    try {
      const broken = JSON.stringify({
        mcpServers: {
          "threenative-assets": {
            command: "node",
            args: [`${CORE_SHIM}/assets.mjs`],
          },
          "threenative-sculpt": {
            command: "node",
            args: ["./node_modules/not-a-dependency/dist/index.js"],
          },
          "threenative-engine": {
            command: "node",
            args: [`${CORE_SHIM}/engine.mjs`],
          },
          "threenative-animation": {
            command: "node",
            args: [`${CORE_SHIM}/animation.mjs`],
          },
          "threenative-terrain": {
            command: "node",
            args: [`${CORE_SHIM}/terrain.mjs`],
          },
          "threenative-devtools": {
            command: "node",
            args: [`${CORE_SHIM}/devtools.mjs`],
          },
        },
      });
      await withBrokenTemplateFile("starter/.mcp.json", broken, async (templates) => {
        await expect(
          createProject(
            { install: false, target: "my-game", template: "starter" },
            root,
            templates,
          ),
        ).rejects.toThrow(/not-a-dependency.*does not depend on/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Copies every template tree into a temp dir, which is thousands of files; the 5 s default
    // trips on a loaded machine and reports a timeout where there is no defect.
  }, 30_000);

  it("should throw when .mcp.json launches an unpinned remote package", async () => {
    const root = await makeTempDir("threenative-mcp-npx-");
    try {
      const broken = JSON.stringify({
        mcpServers: {
          "threenative-assets": {
            command: "node",
            args: [`${CORE_SHIM}/assets.mjs`],
          },
          "threenative-sculpt": { command: "npx", args: ["-y", SCULPT_MCP] },
          "threenative-engine": {
            command: "node",
            args: [`${CORE_SHIM}/engine.mjs`],
          },
          "threenative-animation": {
            command: "node",
            args: [`${CORE_SHIM}/animation.mjs`],
          },
          "threenative-terrain": {
            command: "node",
            args: [`${CORE_SHIM}/terrain.mjs`],
          },
          "threenative-devtools": {
            command: "node",
            args: [`${CORE_SHIM}/devtools.mjs`],
          },
        },
      });
      await withBrokenTemplateFile("starter/.mcp.json", broken, async (templates) => {
        await expect(
          createProject(
            { install: false, target: "my-game", template: "starter" },
            root,
            templates,
          ),
        ).rejects.toThrow(/must launch from '\.\/node_modules\/'/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Copies every template tree into a temp dir, which is thousands of files; the 5 s default
    // trips on a loaded machine and reports a timeout where there is no defect.
  }, 30_000);

  it("should accept a local playtest package for scaffold smoke tests", () => {
    expect(
      parseArgs(["my-game", "--no-install", "--playtest-package", "/tmp/playtest.tgz"]),
    ).toEqual({
      install: false,
      packageSources: { "@threenative/playtest": "/tmp/playtest.tgz" },
      target: "my-game",
    });
  });

  it("should accept a local package added to the workspace without a CLI map edit", () => {
    expect(
      parseArgs(["my-game", "--no-install", "--new-package-package", "/tmp/new-package.tgz"]),
    ).toEqual({
      install: false,
      packageSources: { "@threenative/new-package": "/tmp/new-package.tgz" },
      target: "my-game",
    });
  });

  it("should accept a local engine MCP package for offline scaffold tests", () => {
    expect(
      parseArgs(["my-game", "--no-install", "--engine-mcp-package", "/tmp/engine-mcp.tgz"]),
    ).toEqual({
      install: false,
      packageSources: { "threenative-engine-mcp": "/tmp/engine-mcp.tgz" },
      target: "my-game",
    });
  });

  it("should accept the short local runtime package override", () => {
    expect(parseArgs(["my-game", "--no-install", "--runtime-package", "/tmp/runtime.tgz"])).toEqual(
      {
        install: false,
        packageSources: { "@threenative/runtime-native": "/tmp/runtime.tgz" },
        target: "my-game",
      },
    );
  });
  it("maps scoped workspace packages with colliding names to distinct source flags", () => {
    expect(
      parseArgs([
        "my-game",
        "--no-install",
        "--threenative-cli-package",
        "/tmp/scoped-cli.tgz",
        "--threenative-engine-mcp-package",
        "/tmp/scoped-engine-mcp.tgz",
      ]),
    ).toEqual({
      install: false,
      packageSources: {
        "@threenative/cli": "/tmp/scoped-cli.tgz",
        "@threenative/engine-mcp": "/tmp/scoped-engine-mcp.tgz",
      },
      target: "my-game",
    });
  });

  it("should keep a local native runtime optional", async () => {
    const root = await makeTempDir("threenative-local-runtime-");
    try {
      const result = await createProject(
        {
          install: false,
          packageSources: { "@threenative/runtime-native": "/tmp/runtime.tgz" },
          target: "my-game",
        },
        root,
      );
      const manifest = JSON.parse(await readFile(path.join(result.target, "package.json"), "utf8"));
      expect(manifest.optionalDependencies["@threenative/runtime-native"]).toBe(
        "file:/tmp/runtime.tgz",
      );
      expect(manifest.dependencies["@threenative/runtime-native"]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("authored temporal detail distribution", () => {
  it("retains global shared assets for a custom template root", () => {
    expect(canonicalRenderSourcePath("src/render/loading.ts", "/tmp/tn-absent-templates")).toBe(
      path.resolve("packages/create-threenative/template-assets/loading.ts"),
    );
  });
  it.each(["collectathon", "adventure", "kart"])(
    "copies the canonical detail stage with a closed local import graph into %s",
    async (template) => {
      const parent = await makeTempDir("tn-temporal-detail-");
      const target = path.join(parent, "game");
      try {
        await createProject({ target, template, install: false }, parent, TEMPLATE_ROOT);
        const relative = "src/render/temporalDetailStage.ts";
        const generated = await readFile(path.join(target, relative), "utf8");
        expect(generated).toBe(
          await readFile(path.join(TEMPLATE_ROOT, "starter", relative), "utf8"),
        );
        const post = await readFile(path.join(target, "src/render/postprocessing.ts"), "utf8");
        expect(post).toContain('from "./temporalDetailStage.js"');
        // The generated helper depends only on public Three/TSL plus an erased core type.
        for (const match of generated.matchAll(/from ["'](\.[^"']+)["']/g)) {
          const specifier = match[1];
          if (specifier === undefined) throw new Error("Missing local import specifier capture");
          expect(
            existsSync(path.resolve(target, "src/render", specifier.replace(/\.js$/, ".ts"))),
          ).toBe(true);
        }
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});
