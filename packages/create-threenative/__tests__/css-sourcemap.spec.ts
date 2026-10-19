import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { buildUi, extractUiStylesheets } from "../src/build.js";

const roots: string[] = [];
const run = promisify(execFile);
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing actual compiler fixture artifact.");
  return value;
}
const native = { ui: { renderer: "native-css" } } as Parameters<typeof buildUi>[1];
const web = { ui: { renderer: "web" } } as Parameters<typeof buildUi>[1];
const remote = "https://cdn.example.com/missing.png";
const hud = `.hud {\n  color: red;\n  background-image: url(${remote});\n}\n`;

async function fixture(tailwind = false, options: Record<string, unknown> = {}) {
  const root = await makeTempDir("threenative-css-compiler-");
  roots.push(root);
  await mkdir(path.join(root, "src/ui"), { recursive: true });
  await mkdir(path.join(root, "node_modules/@tailwindcss"), { recursive: true });
  const require = createRequire(path.resolve("examples/native-css-hud/package.json"));
  for (const name of ["vite", "@tailwindcss/vite", "tailwindcss"]) {
    const entry = require.resolve(name);
    let directory = path.dirname(entry);
    while (!(await readdir(directory)).includes("package.json"))
      directory = path.dirname(directory);
    await symlink(directory, path.join(root, "node_modules", name), "dir");
  }
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "css-compiler", type: "module" }),
  );
  await writeFile(
    path.join(root, "index.html"),
    '<script type="module" src="/src/ui/main.tsx"></script>',
  );
  await writeFile(
    path.join(root, "src/ui/main.tsx"),
    'import "./hud.css"; console.log("text-red-500");\n',
  );
  const authored = `${tailwind ? '@import "tailwindcss";\n' : ""}${hud}`;
  await writeFile(path.join(root, "src/ui/hud.css"), authored);
  await writeFile(
    path.join(root, "vite.config.js"),
    [
      'import tailwindcss from "@tailwindcss/vite";',
      `export default {css:{preprocessorMaxWorkers:0},build:${JSON.stringify(options)},plugins:${tailwind ? "[tailwindcss()]" : "[]"}};`,
    ].join("\n"),
  );
  return { root, authored };
}

async function cssFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await cssFiles(file)));
    else if (file.endsWith(".css")) files.push(file);
  }
  return files.sort();
}

async function mappedRule(
  file: string,
  selector: string,
  source: string,
  line: number,
  content: string,
  column = 0,
) {
  const css = await readFile(file, "utf8");
  const map = JSON.parse(await readFile(`${file}.map`, "utf8"));
  expect(map.file).toBe(path.basename(file));
  expect(css.match(/sourceMappingURL=/gu)).toHaveLength(1);
  expect(css).toContain(`sourceMappingURL=${path.basename(file)}.map`);
  const offset = css.indexOf(selector);
  expect(offset).toBeGreaterThanOrEqual(0);
  const prefix = css.slice(0, offset);
  const trace = new TraceMap(map, `${file}.map`);
  const position = originalPositionFor(trace, {
    line: prefix.split("\n").length,
    column: prefix.length - (prefix.lastIndexOf("\n") + 1),
  });
  expect(position).toMatchObject({ line, column });
  const authoredUrl = new URL(required(position.source ?? undefined), pathToFileURL(`${file}.map`));
  expect(fileURLToPath(authoredUrl)).toBe(source);
  expect(
    map.sourcesContent[trace.resolvedSources.indexOf(required(position.source ?? undefined))],
  ).toBe(content);
  return css.replace(/\n\/\*# sourceMappingURL=[^*]+\*\/\n$/u, "");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("actual production CSS provenance", () => {
  it.each([
    { name: "plain", tailwind: false, options: {} },
    { name: "Tailwind", tailwind: true, options: {} },
    { name: "one CSS bundle", tailwind: false, options: { cssCodeSplit: false } },
    { name: "Tailwind one CSS bundle", tailwind: true, options: { cssCodeSplit: false } },
    { name: "esbuild minifier", tailwind: false, options: { cssMinify: "esbuild" } },
    { name: "no minifier", tailwind: false, options: { cssMinify: false } },
  ])(
    "retains authored $name rules and styling through the default compiler",
    async ({ tailwind, options }) => {
      const { root, authored } = await fixture(tailwind, options);
      const baseline = await cssFiles(await buildUi(root, web));
      const original = await Promise.all(baseline.map((file) => readFile(file, "utf8")));
      const built = await buildUi(root, native);
      const files = await cssFiles(built);
      expect(files.map((file) => path.basename(file))).toEqual(
        baseline.map((file) => path.basename(file)),
      );
      const index = (await Promise.all(files.map((file) => readFile(file, "utf8")))).findIndex(
        (css) => css.includes(".hud"),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const body = await mappedRule(
        required(files[index]),
        ".hud",
        path.join(root, "src/ui/hud.css"),
        tailwind ? 2 : 1,
        authored,
      );
      expect(body).toBe(original[index]);
      await expect(extractUiStylesheets(built, path.join(root, "ui-css"), root)).rejects.toThrow(
        "TN_CSS_UI_ASSET_UNSUPPORTED:",
      );
      try {
        await extractUiStylesheets(built, path.join(root, "ui-css"), root);
      } catch (error) {
        expect(String(error)).not.toContain("\n  authored:");
      }
    },
    60_000,
  );

  it("preserves valid hoisted comments, module order, and unchanged CSS provenance", async () => {
    const { root, authored } = await fixture();
    const first = ".prefix { color: blue; }\n";
    const second =
      '@import /* import explanation */ "https://example.com/one.css";\n.middle { color: green; }\n';
    const last = `@import "https://example.com/two.css";\n${authored}`;
    await writeFile(path.join(root, "src/ui/first.css"), first);
    await writeFile(path.join(root, "src/ui/second.css"), second);
    await writeFile(path.join(root, "src/ui/hud.css"), last);
    await writeFile(
      path.join(root, "src/ui/main.tsx"),
      'import "./first.css"; import "./second.css"; import "./hud.css";',
    );
    const baseline = await cssFiles(await buildUi(root, web));
    const original = await readFile(required(baseline[0]), "utf8");
    const files = await cssFiles(await buildUi(root, native));
    const file = required(files[0]);
    for (const [selector, name, line, content] of [
      [".prefix", "first.css", 1, first],
      [".middle", "second.css", 2, second],
      [".hud", "hud.css", 2, last],
    ] as const) {
      expect(await mappedRule(file, selector, path.join(root, "src/ui", name), line, content)).toBe(
        original,
      );
    }
    expect(original.indexOf("one.css")).toBeLessThan(original.indexOf("two.css"));
    expect(original.indexOf("two.css")).toBeLessThan(original.indexOf(".prefix"));
  }, 60_000);

  it("rebuilds without stale maps or duplicate annotations", async () => {
    const { root } = await fixture();
    await buildUi(root, native);
    const updated = `\n\n${hud.replace("red", "blue")}`;
    await writeFile(path.join(root, "src/ui/hud.css"), updated);
    const built = await buildUi(root, native);
    const files = await cssFiles(built);
    const css = await mappedRule(
      required(files[0]),
      ".hud",
      path.join(root, "src/ui/hud.css"),
      3,
      updated,
    );
    expect(css).toContain("#00f");
    expect(
      (await readdir(path.dirname(required(files[0])))).filter((file) => file.endsWith(".css.map")),
    ).toHaveLength(files.length);
  }, 60_000);

  it("resets provenance between multiple ES and CJS outputs", async () => {
    const { root, authored } = await fixture(false, {
      rollupOptions: {
        output: [
          {
            format: "es",
            entryFileNames: "es/[name].js",
            assetFileNames: "es/[name]-[hash][extname]",
          },
          {
            format: "cjs",
            entryFileNames: "cjs/[name].js",
            assetFileNames: "cjs/[name]-[hash][extname]",
          },
        ],
      },
    });
    const files = await cssFiles(await buildUi(root, native));
    expect(files).toHaveLength(2);
    for (const file of files)
      await mappedRule(file, ".hud", path.join(root, "src/ui/hud.css"), 1, authored);
  }, 60_000);

  it("rejects deduplicated CSS with different authored identities", async () => {
    const { root } = await fixture(false, {
      rollupOptions: { output: { assetFileNames: "assets/[hash][extname]" } },
    });
    for (const name of ["one", "two"]) {
      await writeFile(path.join(root, "src/ui", `${name}.css`), ".same { color: red; }\n");
      await writeFile(
        path.join(root, "src/ui", `${name}.js`),
        `import "./${name}.css"; export default true;`,
      );
    }
    await writeFile(path.join(root, "src/ui/main.tsx"), 'import("./one.js"); import("./two.js");');
    await expect(buildUi(root, native)).rejects.toThrow("node exited with code 1.");
    await expect(
      run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {build} from "vite";await build({root:${JSON.stringify(root)},css:{devSourcemap:true,emitSourcemap:true,preprocessorMaxWorkers:0},build:{sourcemap:true}});`,
        ],
        { cwd: root },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("TN_CSS_SOURCEMAP_AMBIGUOUS:") });
  }, 60_000);

  it.each(["hidden", "inline"] as const)(
    "preserves explicit %s map mode in the patched Vite API",
    async (mode) => {
      const { root, authored } = await fixture();
      await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          [
            'import {build} from "vite";',
            `await build({root:${JSON.stringify(root)},css:{devSourcemap:true,emitSourcemap:true,preprocessorMaxWorkers:0},build:{sourcemap:${JSON.stringify(mode)}}});`,
          ].join("\n"),
        ],
        { cwd: root },
      );
      const file = required((await cssFiles(path.join(root, "dist")))[0]);
      const css = await readFile(file, "utf8");
      if (mode === "hidden") {
        expect(css).not.toContain("sourceMappingURL");
        expect(JSON.parse(await readFile(`${file}.map`, "utf8")).sourcesContent).toContain(
          authored,
        );
      } else {
        expect(css.match(/sourceMappingURL=/gu)).toHaveLength(1);
        const encoded = /sourceMappingURL=data:application\/json;base64,(?<map>[^ ]+)/u.exec(css)
          ?.groups?.map;
        expect(encoded).toBeDefined();
        expect(
          JSON.parse(Buffer.from(required(encoded), "base64").toString()).sourcesContent,
        ).toContain(authored);
        await expect(readFile(`${file}.map`)).rejects.toThrow();
      }
    },
    60_000,
  );
  it("composes leading BOM removal at the actual unchanged CSS stage", async () => {
    const { root } = await fixture();
    const authored = "\uFEFF.hud { color: red; }\n";
    await writeFile(path.join(root, "src/ui/hud.css"), authored);
    const files = await cssFiles(await buildUi(root, native));
    await mappedRule(required(files[0]), ".hud", path.join(root, "src/ui/hud.css"), 1, authored, 1);
  }, 60_000);

  it("rejects later CSS asset edits without a composed map", async () => {
    const { root } = await fixture();
    await writeFile(
      path.join(root, "vite.config.js"),
      `export default {css:{preprocessorMaxWorkers:0},plugins:[{name:"later-css",enforce:"post",generateBundle(_opts,bundle){for(const asset of Object.values(bundle))if(asset.type==="asset"&&asset.fileName.endsWith(".css"))asset.source=".later{color:blue}"+asset.source;}}]};`,
    );
    const baseline = await cssFiles(await buildUi(root, web));
    expect(await readFile(required(baseline[0]), "utf8")).toContain(".later{color:blue}");
    await expect(
      run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {build} from "vite";await build({root:${JSON.stringify(root)},css:{devSourcemap:true,emitSourcemap:true,preprocessorMaxWorkers:0},build:{sourcemap:true}});`,
        ],
        { cwd: root },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("TN_CSS_SOURCEMAP_UNSUPPORTED:") });
  }, 60_000);

  it("names the authored position of a compatibility finding, or keeps the generated one", async () => {
    const { root } = await fixture();
    await writeFile(
      path.join(root, "src/ui/hud.css"),
      ".a { color: red; }\n.b { filter: blur(2px); }\n",
    );
    const built = await buildUi(root, native);
    const out = path.join(root, "ui-css");
    await expect(extractUiStylesheets(built, out, root)).rejects.toThrow(
      /TN_CSS_UI_UNSUPPORTED_CSS[\s\S]*authored src\/ui\/hud\.css:2:1[\s\S]*filter/u,
    );
    const report = JSON.parse(await readFile(path.join(root, "native-css-compat.json"), "utf8"));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ authored: "src/ui/hud.css:2:1", what: "filter" });
    expect(report.findings[0]).toMatchObject({ file: expect.stringContaining(".css") });
    // Without the project root the build cannot name an authored path, so the finding stays generated.
    await expect(extractUiStylesheets(built, out)).rejects.toThrow(/assets\/index-\w+\.css:1:\d+/u);
    // A map the build cannot verify is no provenance: the same finding, generated only.
    const sheet = required((await cssFiles(built))[0]);
    await writeFile(`${sheet}.map`, JSON.stringify({ version: 3, file: path.basename(sheet) }));
    await expect(extractUiStylesheets(built, out, root)).rejects.toThrow(
      /TN_CSS_UI_UNSUPPORTED_CSS/u,
    );
    expect(
      String(await extractUiStylesheets(built, out, root).catch((error: Error) => error)),
    ).not.toContain("authored");
  }, 60_000);

  it("maps a stylesheet emitted through the actual CSS URL path", async () => {
    const { root, authored } = await fixture();
    await writeFile(
      path.join(root, "src/ui/main.tsx"),
      'import href from "./hud.css?url"; console.log(href);',
    );
    const baseline = await cssFiles(await buildUi(root, web));
    const original = await Promise.all(baseline.map((file) => readFile(file, "utf8")));
    const files = await cssFiles(await buildUi(root, native));
    const bodies = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const index = bodies.findIndex((css) => css.includes(".hud"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(
      await mappedRule(
        required(files[index]),
        ".hud",
        path.join(root, "src/ui/hud.css"),
        1,
        authored,
      ),
    ).toBe(original[index]);
  }, 60_000);
});
