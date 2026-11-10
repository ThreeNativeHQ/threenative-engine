// The native host finds its settings in the embedded `.threenative/config.json` with a string
// scanner, so a key it reads that the packager stopped writing is not an error: the host just keeps
// its default. These checks hold the manifest of scanned keys to what the real config loader and the
// desktop packager write, and the generated C++ constants to the manifest.
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { resolvePackagingConfig } from "../src/build.js";
import { loadConfig } from "../src/config.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const MANIFEST = path.join(ROOT, "packages/three-native/api/native-config-keys.json");
const HEADER = path.join(ROOT, "packages/runtime-native/include/mystral/config_keys.h");

interface IKey {
  readonly at: string;
  readonly flattenedBy?: string;
  readonly name: string;
}

const keys = (): readonly IKey[] =>
  (JSON.parse(readFileSync(MANIFEST, "utf8")) as { keys: readonly IKey[] }).keys;

// A real 16x16 PNG: the config loader reads an icon's header before it accepts the path.
const ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXUlEQVR4AaXBQRHEAAgEwclWHGDivIBckIWG3Hf/dD/frz9MdOK2BhedOHEkjsTRG524rcFFJ25rcOJIHImjd2tw0YnbGlx04sSROBJHb3TitgYXnbitwYkjcSSO/o/fGRJxtqYFAAAAAElFTkSuQmCC",
  "base64",
);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function at(value: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>((node, step) => (node as Record<string, unknown> | undefined)?.[step], value);
}

describe("the native host's config keys", () => {
  it("should generate the C++ constants from the manifest", () => {
    const rows = [...readFileSync(HEADER, "utf8").matchAll(/kConfigKey(\w+) = "(\w+)";/gu)].map(
      ([, pascal, key]) => [pascal, key] as const,
    );
    expect(rows).toEqual(
      keys().map((key) => [`${key.name[0]?.toUpperCase()}${key.name.slice(1)}`, key.name] as const),
    );
  });

  it("should find every unflattened key at its path in the config the packager writes", async () => {
    const root = await makeTempDir("threenative-config-keys-");
    roots.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "icon.png"), ICON_PNG);
    await writeFile(path.join(root, "src/game.ts"), "export default {};\n");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "keys", type: "module" }),
    );
    await writeFile(
      path.join(root, "threenative.config.ts"),
      `export default {
        app: { icon: "icon.png" },
        bootSplash: { backgroundColor: "#0d1b2a" },
        display: { fullscreen: true, maxFps: 90 },
        window: { title: "Keys", width: 800, height: 600, maximized: true, resizable: false },
      };\n`,
    );
    const artifact = resolvePackagingConfig(root, await loadConfig(root));
    const missing = keys()
      .filter((key) => key.flattenedBy === undefined)
      .filter((key) => at(artifact, key.at) === undefined)
      .map((key) => `${key.name} is not at ${key.at}`);
    expect(missing, "the packager no longer writes a key the host scans for").toEqual([]);
  });

  it("should flatten every key the manifest says a script copies up", () => {
    const flattened = keys().filter((key) => key.flattenedBy !== undefined);
    expect(flattened.length).toBeGreaterThan(0);
    for (const key of flattened) {
      const script = readFileSync(path.join(ROOT, key.flattenedBy as string), "utf8");
      expect(script, `${key.flattenedBy} sets packaged.${key.name}`).toContain(
        `packaged.${key.name} =`,
      );
    }
  });
});
