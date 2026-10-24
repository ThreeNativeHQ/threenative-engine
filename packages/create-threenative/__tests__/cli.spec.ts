import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  cliHelp,
  discoverKitManifests,
  kitManifest,
  parseArgs,
  templateForGenre,
} from "../src/index.js";

const run = promisify(execFile);
const threenativeCli = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/threenative.js",
);

describe("create-threenative CLI", () => {
  it("prints usable help for the scaffold command and every template", () => {
    const manifests = discoverKitManifests();
    const help = cliHelp();
    const width = Math.max(...manifests.map(({ name }) => name.length));

    expect(help).toContain("Usage: npx create-threenative <directory> [options]");
    expect(help).toContain("--template <name>");
    expect(help).toContain("--genre <name>");
    expect(help).toContain("--no-install");
    expect(help).toContain("--help");
    for (const manifest of manifests) {
      expect(help).toContain(
        `${manifest.name.padEnd(width)}  ${manifest.title}: ${manifest.blurb}`,
      );
      if (manifest.aliases.length > 0)
        expect(help).toContain(`(also: ${manifest.aliases.join(", ")})`);
    }
  });

  it("resolves a word a kit lists in kit.json aliases, and rejects a word two kits claim", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tn-kits-"));
    const kit = (name: string, aliases: string[]) => {
      mkdirSync(path.join(root, name));
      const manifest = { aliases, blurb: "b", genre: name, kit: true, name, title: "T" };
      writeFileSync(path.join(root, name, "kit.json"), JSON.stringify(manifest));
    };
    kit("collectathon", ["Mario", "sm64"]);
    kit("adventure", ["zelda", "sm64"]);
    expect(templateForGenre("MARIO", root)).toBe("collectathon");
    expect(templateForGenre("zelda", root)).toBe("adventure");
    expect(templateForGenre("pirate", root)).toBe("minimal");
    expect(() => templateForGenre("sm64", root)).toThrow("TN_KIT_GENRE_AMBIGUOUS");
  });

  it("uses an exact genre kit and falls back to minimal for an unknown genre", () => {
    expect(templateForGenre("racing")).toBe("racing");
    expect(templateForGenre("pirate")).toBe("minimal");
    expect(parseArgs(["game", "--genre", "pirate", "--no-install"])).toMatchObject({
      install: false,
      target: "game",
      template: "minimal",
    });
    expect(() => parseArgs(["game", "--genre", "pirate", "--template", "starter"])).toThrow(
      /cannot be combined/u,
    );
  });

  it("makes every template's genre reachable through the template flag", () => {
    for (const manifest of discoverKitManifests()) {
      const options = parseArgs(["game", "--template", manifest.name, "--no-install"]);
      expect(options).toMatchObject({ install: false, target: "game", template: manifest.name });
      expect(kitManifest(manifest.name)).toMatchObject({
        genre: manifest.genre,
        name: manifest.name,
      });
    }
  });

  it("rejects a doctor target or mode the build cannot run", async () => {
    const cases: readonly [readonly string[], RegExp][] = [
      [["doctor", "--target"], /'--target' requires a value/u],
      [["doctor", "--target", "--text"], /'--target' requires a value/u],
      [["doctor", "--target", "switch"], /'--target' must be one of web, desktop, android, ios/u],
      [["doctor", "--target", "android", "--mode"], /'--mode' requires a value/u],
      [
        ["doctor", "--target", "android", "--mode", "ship"],
        /'--mode' must be one of debug, release/u,
      ],
      [["doctor", "--mode", "release"], /'--mode' requires '--target'/u],
    ];
    for (const [argv, message] of cases) {
      const failure = await run(process.execPath, [threenativeCli, ...argv]).then(
        () => undefined,
        (error: unknown) => error as { code?: number; stderr?: string },
      );
      expect(failure, argv.join(" ")).toBeDefined();
      expect(failure?.code, argv.join(" ")).toBe(1);
      expect(failure?.stderr ?? "", argv.join(" ")).toMatch(message);
    }

    const help = await run(process.execPath, [threenativeCli, "doctor", "--help"]);
    expect(help.stdout).toContain("--target web|desktop|android|ios");
    expect(help.stdout).toContain("--mode debug|release");
  }, 30_000);

  it("prints successful help from the real threenative executable", async () => {
    const root = await run(process.execPath, [threenativeCli, "--help"]);
    expect(root.stderr).toBe("");
    expect(root.stdout).toContain("Usage: threenative <command> [options]");
    const advertised = [...root.stdout.matchAll(/^ {2}([a-z]+)\s+/gmu)]
      .map(([, command]) => command)
      .filter((command): command is string => command !== undefined);

    for (const command of advertised) {
      const commandHelp = await run(process.execPath, [threenativeCli, command, "--help"]);
      expect(commandHelp.stderr, command).toBe("");
      expect(commandHelp.stdout, command).toContain(`Usage: threenative ${command}`);
    }
    expect(advertised).toEqual(["build", "doctor"]);

    for (const command of ["dev", "test", "ship"]) {
      await expect(
        run(process.execPath, [threenativeCli, command, "--help"]),
      ).rejects.toMatchObject({ code: 1 });
    }

    // The package's own AGENTS.md must describe exactly the surface this executable advertises,
    // derived here from what the binary printed rather than restated by hand. The v1 vocabulary
    // (`dev`, `test`, `ship`) never returns as a command claim.
    const agentsDoc = await readFile(path.join(__dirname, "../AGENTS.md"), "utf8");
    const cliSurface = agentsDoc.slice(agentsDoc.indexOf("## CLI surface"));
    for (const command of advertised) {
      expect(cliSurface, command).toContain(`\`${command}\``);
    }
    for (const command of ["dev", "test", "ship"]) {
      expect(cliSurface, command).not.toContain(`\`${command}\``);
    }
  }, 30_000);
});
