import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { patchScaffold } from "../unreal-look/capture-threenative.js";

const TEMPLATE = path.resolve(
  import.meta.dirname,
  "../../packages/create-threenative/templates/starter",
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A scaffolded starter as createProject leaves it, patched for the capture. */
async function patched(baseline: boolean): Promise<string> {
  const target = makeTempDirSync("tn-baseline-");
  roots.push(target);
  cpSync(path.join(TEMPLATE, "src"), path.join(target, "src"), { recursive: true });
  writeFileSync(path.join(target, "threenative.config.ts"), "  alphaAntialiasing: true,\n");
  await patchScaffold(target, false, baseline);
  return target;
}

const NAMES = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g;
const REEXPORT = /export\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;
const names = (list: string) =>
  list
    .split(",")
    .map(
      (item) =>
        item
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0] as string,
    )
    .filter(Boolean);

/** Whether `file` exports `name`, following `export { name } from "./x.js"` into the file it names. */
function exportsName(file: string, name: string): boolean {
  if (!existsSync(file)) return false;
  const source = readFileSync(file, "utf8");
  if (
    new RegExp(
      `export\\s+(?:declare\\s+)?(?:async\\s+)?(?:const|let|function|class|type|interface|enum)\\s+${name}\\b`,
    ).test(source)
  )
    return true;
  for (const [, list, from] of source.matchAll(REEXPORT))
    if (names(list as string).includes(name))
      return (
        !(from as string).startsWith(".") ||
        exportsName(
          path.resolve(path.dirname(file), (from as string).replace(/\.js$/, ".ts")),
          name,
        )
      );
  return false;
}

/**
 * The relative named imports of every source file in the scaffold that no file of it exports, as
 * `<file>: <name> from <path>`. Every file, not only Reference.ts: the overlay replaces template modules
 * that the game's own files import, and #563 deleted five modules the overlay's worldEnvironment.ts read,
 * which broke the tuned arm with nothing failing until a capture.
 */
function unresolved(target: string): string[] {
  const src = path.join(target, "src");
  return readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .flatMap((file) => {
      const at = path.join(src, file);
      return [...readFileSync(at, "utf8").matchAll(NAMES)].flatMap(([, list, from]) =>
        names(list as string)
          .filter(
            (name) =>
              !exportsName(
                path.resolve(path.dirname(at), (from as string).replace(/\.js$/, ".ts")),
                name,
              ) &&
              !exportsName(
                path.resolve(path.dirname(at), (from as string).replace(/\.js$/, ".tsx")),
                name,
              ),
          )
          .map((name) => `${file}: ${name} from ${from}`),
      );
    });
}

describe("the capture scaffold of an arm", () => {
  it("resolves every relative import of every source file in a --baseline scaffold (the template's own src/render)", async () => {
    expect(unresolved(await patched(true))).toEqual([]);
  });

  it("resolves every relative import of every source file in the tuned scaffold too", async () => {
    expect(unresolved(await patched(false))).toEqual([]);
  });

  it("gives the baseline scaffold inert stand-ins and the tuned one the overlay's own modules", async () => {
    const baseline = readFileSync(path.join(await patched(true), "src/scenes/tuning.ts"), "utf8");
    expect(baseline).not.toMatch(/from "\.\.\/render/);
    const tuned = readFileSync(path.join(await patched(false), "src/scenes/tuning.ts"), "utf8");
    expect(tuned).toMatch(/from "\.\.\/render\/giCache\.js"/);
  });
});
