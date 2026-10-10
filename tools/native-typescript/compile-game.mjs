#!/usr/bin/env node
// Survey of a real game under the pinned Perry (decision 11), through the strict packaging path.
//
//   compile-game.mjs <gameDir> [--entry src/game.ts] [--out <dir>]
//       Stages the game's whole source tree (package-strict.mjs, `sourceRoot`), compiles and links it
//       with the strict flags, and prints one JSON object: how many modules Perry compiled, the
//       imports it could not resolve, the symbols the link lacked and Perry's own errors. Exit 0
//       only when the game links. Missing engine API (unresolved imports, undefined symbols) and
//       Perry errors are separate fields, because only the second is a compiler problem.
//
//   compile-game.mjs <gameDir> --checks <scriptsDir> [--package <name>=<file>] [--only a,b] [--timeout-s N]
//       The game's own assertion scripts (`check-*.mjs`, esbuild bundle plus node:assert) become plain
//       TypeScript drivers with static imports, run once under tsx and once as a Perry binary, and
//       their stdout and exit code are compared. `--package` stages a package the game's pure
//       modules import (`@threenative/core=packages/core/src/flight.ts`) as a one-file stand-in.
//       Prints one JSON line per script. A script that fails under tsx too is `invalid-reference`.
//
// The game is read, never copied into this repository: everything is staged under --out, which
// must lie outside both the game and this checkout.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STRICT_FLAGS,
  buildStrict,
} from "../../packages/runtime-native/scripts/package-strict.mjs";
import { provision } from "./provision.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

/** What a Perry run printed, sorted into the three kinds of failure. */
export function classifyPerryOutput(text) {
  const unresolvedImports = [
    ...new Set([...text.matchAll(/Could not resolve import '([^']+)' from /gu)].map((m) => m[1])),
  ];
  const undefinedSymbols = [
    ...new Set([...text.matchAll(/undefined reference to `([^']+)'/gu)].map((m) => m[1])),
  ];
  const facadePrefix = /^__perry_wrap_perry_fn_node_modules_three_three_ts__/u;
  const found = text.match(/Found (\d+) module\(s\): (\d+) native, (\d+) JavaScript/u);
  const perryErrors = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^Error:/u.test(line) && !/^Error: Linking failed/u.test(line));
  return {
    modules: found
      ? { total: Number(found[1]), native: Number(found[2]), javascript: Number(found[3]) }
      : undefined,
    unresolvedImports,
    undefinedSymbols: undefinedSymbols.filter((symbol) => !facadePrefix.test(symbol)),
    missingFacadeMembers: undefinedSymbols
      .filter((symbol) => facadePrefix.test(symbol))
      .map((symbol) => symbol.replace(facadePrefix, "")),
    unknownGlobals: [
      ...new Set([...text.matchAll(/unknown identifier '(\w+)'/gu)].map((m) => m[1])),
    ],
    perryErrors,
    linkFailed: /Error: Linking failed/u.test(text),
  };
}

/** The end of the bracket opened at `from`, skipping string contents. */
function findBalanced(source, from, open = "(", close = ")") {
  let depth = 0;
  let quote;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw convertError(`unbalanced ${open}`);
}

function convertError(reason) {
  const error = new Error(`TN_COMPILE_GAME_UNCONVERTED: ${reason}`);
  error.code = "TN_COMPILE_GAME_UNCONVERTED";
  return error;
}

const ESCAPES = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "`": "`" };
const unescapeLiteral = (text) => text.replace(/\\(.)/gu, (_, char) => ESCAPES[char] ?? char);
const asModule = (specifier) => `./${specifier.replace(/\.ts$/u, "")}.js`;

/**
 * A check script that bundles pure modules with esbuild and imports the result becomes a plain
 * driver with static imports. Two shapes are understood: a local `bundle(entry)` helper, and an
 * inline `build({ entryPoints | stdin: { contents } })` followed by `await import(data:...)`.
 * Returns `{ driver, bundles }`, where `bundles` are synthetic modules for `stdin` contents.
 * Anything else throws TN_COMPILE_GAME_UNCONVERTED rather than guessing.
 */
export function convertCheckScript(source, name) {
  let out = source;
  const imports = [];
  const bundles = [];
  const helper = out.match(/async function bundle\(entry\)\s*\{/u);
  if (helper) {
    const end = findBalanced(out, helper.index + helper[0].length - 1, "{", "}");
    out = out.slice(0, helper.index) + out.slice(end + 1);
    out = out.replace(
      /const\s+(\w+)\s*=\s*await\s+bundle\("([^"]+)"\);?/gu,
      (_, binding, entry) => {
        imports.push(`import * as ${binding} from "${asModule(entry)}";`);
        return "";
      },
    );
  }
  const build = /const\s+(\{[^}]*\}|\w+)\s*=\s*await\s+build\(/u;
  for (let match = build.exec(out); match; match = build.exec(out)) {
    const open = match.index + match[0].length - 1;
    const close = findBalanced(out, open);
    const call = out.slice(open, close + 1);
    let end = close + 1;
    if (out[end] === ";") end += 1;
    const entry = call.match(/entryPoints:\s*\[\s*["']([^"']+)["']/u);
    const contents = call.match(/contents:\s*('[^']*'|"[^"]*"|`[^`]*`)/u);
    let module;
    if (entry) module = asModule(entry[1]);
    else if (contents) {
      const file = `__bundle_${name}_${bundles.length + 1}`;
      bundles.push({
        file: `${file}.ts`,
        text: `${unescapeLiteral(contents[1].slice(1, -1)).replace(/\.ts(["'])/gu, ".js$1")}\n`,
      });
      module = `./${file}.js`;
    } else
      throw convertError(`${name}: a build() call with neither entryPoints nor stdin contents`);
    out = out.slice(0, match.index) + out.slice(end);
    const consumer = /const\s+(\{[^}]*\}|\w+)\s*=\s*await\s+import\(/u.exec(out.slice(match.index));
    if (!consumer) throw convertError(`${name}: the bundle is never imported`);
    const start = match.index + consumer.index;
    const importClose = findBalanced(out, match.index + consumer.index + consumer[0].length - 1);
    let importEnd = importClose + 1;
    if (out[importEnd] === ";") importEnd += 1;
    const binding = consumer[1];
    imports.push(
      binding.startsWith("{")
        ? `import ${binding} from "${module}";`
        : `import * as ${binding} from "${module}";`,
    );
    out = out.slice(0, start) + out.slice(importEnd);
  }
  out = out.replace(/import \{ build \} from "esbuild";\n/u, "");
  out = out.replace(
    /const root = resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\."\);\n/u,
    'const root = ".";\n',
  );
  const residue = ['from "esbuild"', "import.meta", "data:text", "await build("].filter((token) =>
    out.includes(token),
  );
  if (residue.length > 0) throw convertError(`${name}: ${residue.join(", ")} remains`);
  const lines = out.split("\n");
  const lastImport = lines.reduce(
    (last, line, index) => (line.startsWith("import ") ? index : last),
    -1,
  );
  lines.splice(lastImport + 1, 0, ...imports);
  return { driver: lines.join("\n"), bundles };
}

/** Whether a native run reproduces the reference run; a failing reference proves nothing. */
export function compareRuns(reference, native) {
  if (reference.status !== 0) return "invalid-reference";
  if (native.status === reference.status && native.stdout.trim() === reference.stdout.trim())
    return "same";
  return "different";
}

/** The compile directory must not lie inside the game (read-only) or this checkout. */
export function assertOutsideGameAndRepo(outDir, gameDir, repo = REPO) {
  const inside = (child, parent) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const out = path.resolve(outDir);
  if (inside(out, path.resolve(gameDir)) || inside(out, repo))
    throw new Error(
      `TN_COMPILE_GAME_OUT_INSIDE: ${out} lies inside ${inside(out, repo) ? "this checkout" : "the game"}; stage elsewhere`,
    );
}

/** The environment of a Perry run, with its object cache beside the staged project. */
function perryEnv(outDir) {
  const env = { ...process.env };
  env.PERRY_CACHE_DIR = path.join(outDir, ".perry");
  return env;
}

async function perry() {
  const compiler = await provision({ log: () => {} });
  return {
    binaryPath: compiler.binaryPath,
    identity: `perry ${compiler.lock.tag} ${compiler.artifact.sha256}`,
  };
}

export async function compileGame({
  gameDir,
  entry = "src/game.ts",
  outDir,
  stageOnly = false,
  engineBuild,
}) {
  assertOutsideGameAndRepo(outDir, gameDir);
  fs.mkdirSync(outDir, { recursive: true });
  const compiler = await perry();
  const build = buildStrict({
    name: "game",
    entry: path.join(gameDir, entry),
    sourceRoot: gameDir,
    sharedFacade: true,
    outDir,
    engineBuild,
    compiler,
    manifest: false,
    stageOnly: true,
  });
  if (stageOnly) return { staged: outDir, errors: build.errors };
  const run = spawnSync(
    compiler.binaryPath,
    [
      "compile",
      path.join(outDir, entry),
      "-o",
      path.join(outDir, "game"),
      ...STRICT_FLAGS,
      "--debug-symbols",
    ],
    {
      cwd: outDir,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: perryEnv(outDir),
    },
  );
  const text = `${run.stdout}${run.stderr}`;
  fs.writeFileSync(path.join(outDir, "perry.log"), text);
  return { exit: run.status, ...classifyPerryOutput(text) };
}

export async function differential({
  gameDir,
  checksDir,
  outDir,
  packages = [],
  only,
  timeoutS = 900,
  tsx = path.join(REPO, "node_modules", ".bin", "tsx"),
}) {
  assertOutsideGameAndRepo(outDir, gameDir);
  const staged = await compileGame({ gameDir, outDir, stageOnly: true });
  if (staged.errors.length > 0) throw new Error(staged.errors[0]);
  for (const spec of packages) {
    const [name, file] = spec.split("=");
    const dir = path.join(outDir, "node_modules", ...name.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version: "0.0.0", main: "index.ts", types: "index.ts" }),
    );
    fs.copyFileSync(file, path.join(dir, path.basename(file)));
    fs.writeFileSync(
      path.join(dir, "index.ts"),
      `export * from "./${path.basename(file).replace(/\.ts$/u, "")}.js";\n`,
    );
  }
  const compiler = await perry();
  fs.mkdirSync(path.join(outDir, "bin"), { recursive: true });
  const results = [];
  for (const script of fs
    .readdirSync(checksDir)
    .filter((file) => /^check-.*\.mjs$/u.test(file))
    .sort()) {
    const name = script.replace(/\.mjs$/u, "");
    if (only && !only.includes(name)) continue;
    let converted;
    try {
      converted = convertCheckScript(fs.readFileSync(path.join(checksDir, script), "utf8"), name);
    } catch (error) {
      results.push({ name, verdict: "unconverted", reason: error.message });
      continue;
    }
    fs.writeFileSync(path.join(outDir, `${name}.ts`), converted.driver);
    for (const bundle of converted.bundles)
      fs.writeFileSync(path.join(outDir, bundle.file), bundle.text);
    const started = Date.now();
    const ref = spawnSync(tsx, [`${name}.ts`], {
      cwd: outDir,
      encoding: "utf8",
      timeout: timeoutS * 1000,
    });
    const referenceMs = Date.now() - started;
    const exe = path.join(outDir, "bin", name);
    fs.rmSync(exe, { force: true });
    const compile = spawnSync(
      compiler.binaryPath,
      ["compile", `${name}.ts`, "-o", exe, ...STRICT_FLAGS],
      {
        cwd: outDir,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        env: perryEnv(outDir),
      },
    );
    const compileText = `${compile.stdout}${compile.stderr}`;
    if (compile.status !== 0) {
      results.push({
        name,
        verdict: "compile-failed",
        referenceExit: ref.status,
        ...classifyPerryOutput(compileText),
      });
      continue;
    }
    const nativeStarted = Date.now();
    const native = spawnSync(exe, [], { cwd: outDir, encoding: "utf8", timeout: timeoutS * 1000 });
    results.push({
      name,
      verdict: compareRuns(
        { status: ref.status, stdout: ref.stdout ?? "" },
        { status: native.status, stdout: native.stdout ?? "" },
      ),
      referenceMs,
      nativeMs: Date.now() - nativeStarted,
      slowdown: Number(((Date.now() - nativeStarted) / Math.max(1, referenceMs)).toFixed(1)),
    });
  }
  return results;
}

function parseArguments(argv) {
  const options = { packages: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--entry") options.entry = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--checks") options.checks = argv[++i];
    else if (arg === "--package") options.packages.push(argv[++i]);
    else if (arg === "--only") options.only = argv[++i].split(",");
    else if (arg === "--timeout-s") options.timeoutS = Number(argv[++i]);
    else if (arg.startsWith("--")) throw new Error(`TN_COMPILE_GAME_USAGE: unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1)
    throw new Error(
      "TN_COMPILE_GAME_USAGE: compile-game.mjs <gameDir> [--entry f] [--out dir] [--checks dir [--package n=file] [--only a,b] [--timeout-s N]]",
    );
  options.gameDir = path.resolve(positional[0]);
  options.out = path.resolve(
    options.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "tn-compile-game-")),
  );
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.checks) {
      const results = await differential({
        gameDir: options.gameDir,
        checksDir: path.resolve(options.checks),
        outDir: options.out,
        packages: options.packages,
        only: options.only,
        timeoutS: options.timeoutS,
      });
      for (const result of results) console.log(JSON.stringify(result));
      process.exit(results.every((result) => result.verdict === "same") ? 0 : 1);
    }
    const result = await compileGame({
      gameDir: options.gameDir,
      entry: options.entry,
      outDir: options.out,
    });
    console.log(JSON.stringify(result, undefined, 2));
    process.exit(result.exit === 0 ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
