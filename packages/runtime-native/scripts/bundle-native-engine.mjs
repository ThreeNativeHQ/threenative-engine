#!/usr/bin/env node
// PRD-531's VM artifact: the game bundle for the engine player on V8, explicitly selected.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(native, "../..");
const player = resolve(native, "src/engine/player");
const require = createRequire(resolve(native, "package.json"));
const { build } = require("esbuild");
const ts = require("typescript");
const core = dirname(require.resolve("@threenative/core/package.json"));
const threeNative = dirname(require.resolve("@threenative/three-native/package.json"));
const assetsEntry = resolve(dirname(require.resolve("@threenative/assets/package.json")), "dist/index.js");

// Player facades share source with sibling packages; installed packages need their resolved roots.
const packageImports = { name: "native-player-packages", setup(builder) {
  builder.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/\.\.\/(?:three-native|core)\/src\// }, (args) => {
    if (!args.importer.startsWith(`${player}/`)) return;
    const [, name, source] = /^\.\.\/\.\.\/\.\.\/\.\.\/(three-native|core)\/(.+)$/.exec(args.path);
    return { path: resolve(name === "core" ? core : threeNative, source) };
  });
} };

function rejectUpstream(metafile) {
  const upstream = Object.keys(metafile.inputs).filter((file) => /(?:^|\/)node_modules\/three\//.test(file));
  if (upstream.length) throw new Error(`TN_NATIVE_ENGINE_UPSTREAM: ${upstream.join(", ")}`);
}

function imports(source, specifier) {
  const ast = ts.createSourceFile("game.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set();
  const namespaces = new Set();
  const matches = (node) => ts.isStringLiteral(node) && node.text === specifier;
  const bindings = (elements) => {
    for (const item of elements) {
      if (!item.isTypeOnly) names.add((item.propertyName ?? item.name).text);
    }
  };
  function importDeclaration(node) {
    if (!ts.isImportDeclaration(node)) return;
    if (!matches(node.moduleSpecifier) || node.importClause?.isTypeOnly) return;
    const clause = node.importClause;
    if (clause?.name) names.add("default");
    const named = clause?.namedBindings;
    if (named && ts.isNamedImports(named)) bindings(named.elements);
    else if (named) namespaces.add(named.name.text);
  }
  function exportDeclaration(node) {
    if (!ts.isExportDeclaration(node)) return;
    if (node.isTypeOnly || !node.moduleSpecifier || !matches(node.moduleSpecifier)) return;
    if (node.exportClause && ts.isNamedExports(node.exportClause)) bindings(node.exportClause.elements);
  }
  function dynamicImport(node) {
    if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
    if (!matches(node.arguments[0])) return;
    const expression = ts.isAwaitExpression(node.parent) ? node.parent : node;
    const parent = expression.parent;
    if (!ts.isVariableDeclaration(parent)) return;
    if (ts.isObjectBindingPattern(parent.name)) bindings(parent.name.elements);
    else if (ts.isIdentifier(parent.name)) namespaces.add(parent.name.text);
  }
  function visit(node) {
    importDeclaration(node);
    exportDeclaration(node);
    dynamicImport(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  function references(node) {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text))
      names.add(node.name.text);
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) {
      if (ts.isStringLiteral(node.argumentExpression)) names.add(node.argumentExpression.text);
      else names.add("*");
    }
    ts.forEachChild(node, references);
  }
  references(ast);
  return [...names];
}

function unboundDiagnostic(specifier, name) {
  let reason = "the native engine profile has no binding for this import";
  if (specifier.startsWith("three/addons/tsl/display/"))
    reason = "live addon-node construction and update scheduling are unbound; the native renderer currently consumes cooked post graphs";
  else if (specifier.includes("GLTFLoader"))
    reason = "the native cgltf loader has no V8 loader binding and does not decode glTF images or external buffers";
  else if (/KTX2Loader|DRACOLoader|MeshoptDecoder|meshopt_decoder/.test(specifier))
    reason = "the selected native engine asset path has no bound decoder/transcoder for this loader";
  else if (specifier === "three-mesh-bvh")
    reason = "the native MeshBVH answers raycastObject3D only; serialization, build strategies and GPU BVH are not bound";
  else if (name === "DepthTexture")
    reason = "native render targets do not expose a game-owned, sampleable depth attachment";
  else if (specifier === "three/webgpu" || name === "RenderTarget")
    reason = "native render targets, fullscreen draws and game-authored node lifecycle lack the required V8 renderer bindings";
  else if (specifier === "three/tsl")
    reason = ({
      atomicAdd: "native IR supports atomics, but live storage nodes do not carry atomic element types or statement scheduling",
      atomicStore: "native IR supports atomics, but live storage nodes do not carry atomic element types or statement scheduling",
      lightShadowMatrix: "the live graph cannot bind an authored light's shadow matrix to its render light index",
      rtt: "live RTT targets do not expose the requested filtering, renderTarget extent or update lifecycle",
      wgslFn: "the live graph cannot compile and link an authored WGSL function with its typed arguments",
    })[name] ?? "the native graph lacks this material/pass/history/storage context binding";
  else if (name === "PropertyBinding" || name.endsWith("ConsoleFunction"))
    reason = "native PropertyBinding exists, but its V8 object/static reflection and diagnostic console hook are unbound";
  return `TN_NATIVE_ENGINE_UNBOUND: ${specifier}:${name} [${reason}]`;
}

/** Bundle the portable entry against native imports; publish nothing when a binding is absent. */
export async function bundleNativeEngine({ entry, outfile, boot = true, define = {}, host = boot }) {
  let engineCommit;
  try {
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // Installed packages can sit inside somebody else's repository, or have no git at all.
    if (realpathSync(git(["rev-parse", "--show-toplevel"])) === realpathSync(repo)
      && JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8")).name === "threenative"
      && !git(["status", "--porcelain", "--untracked-files=normal", "--", "packages", "scripts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ":(exclude,glob)packages/**/__tests__/**", ":(exclude,glob)packages/runtime-native/tests/**", ":(exclude,glob)scripts/__tests__/**"]))
      engineCommit = git(["rev-parse", "HEAD"]);
  } catch { /* Ordinary bundling does not require source provenance. */ }
  entry = resolve(entry);
  outfile = resolve(outfile);
  if (entry === outfile) throw new Error("TN_NATIVE_ENGINE_OUTPUT: entry and output must differ");
  // Tree-shake the game and packages first. Unused package exports must not enlarge the game's
  // compatibility denominator merely because the package's index reexports them.
  const game = await build({
    entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "neutral",
    target: "es2022", conditions: ["threenative-native"], define: { "import.meta.env": "{}", ...define },
    external: ["three", "three/*", "three-mesh-bvh", "three-mesh-bvh/*",
      "@threenative/core", "@threenative/core/*"],
    logLevel: "silent", metafile: true, sourcemap: "inline", sourcesContent: true,
    // A script entry that imports core's loader by relative path (the load test's Fox) would inline the
    // browser loader and its GLTFLoader; it reads the cooked package like core's own imports do.
    plugins: [packageImports, { name: "native-assets", setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)assets\.js$/ }, (args) => {
        if (resolve(args.resolveDir, args.path) === resolve(core, "src/assets.js"))
          return { path: resolve(player, "core-assets.mjs"), external: true };
      });
    } }],
  });
  rejectUpstream(game.metafile);
  const code = game.outputFiles[0].text;
  const coreIndex = ts.createSourceFile("index.ts",
    await readFile(resolve(core, "src/index.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const coreExports = imports(code, "@threenative/core").map((name) => {
    const declaration = coreIndex.statements.find((node) => ts.isExportDeclaration(node) &&
      !node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.some((item) => !item.isTypeOnly && item.name.text === name));
    if (!declaration?.moduleSpecifier)
      throw new Error(`TN_NATIVE_ENGINE_UNBOUND: @threenative/core:${name}`);
    const source = JSON.stringify(resolve(core, "src", declaration.moduleSpecifier.text));
    if (name === "defineGame") return `import { defineGame as coreDefineGame } from ${source};
      import { platform } from ${JSON.stringify(resolve(player, "core-host.mjs"))};
      export function defineGame(options) { return coreDefineGame({ ...options, platform: options.platform ?? platform }); }`;
    return `export { ${name} } from ${source};`;
  }).join("\n");
  const modules = {
    three: resolve(player, "core-three.mjs"),
    "three/webgpu": resolve(player, "core-webgpu.mjs"),
    "three/tsl": resolve(player, "core-tsl.mjs"),
    "three/addons/utils/SkeletonUtils.js": resolve(player, "core-three.mjs"),
    "three/addons/geometries/RoundedBoxGeometry.js": resolve(player, "core-three.mjs"),
    "three/addons/tsl/display/GTAONode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/DenoiseNode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/SMAANode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/FilmNode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/Lut3DNode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/TRAANode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/BloomNode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/FXAANode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/GodraysNode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/SSGINode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/SSRNode.js": resolve(player, "core-addons.mjs"),
    "three/addons/tsl/display/SharpenNode.js": resolve(player, "core-addons.mjs"),
    "three/addons/loaders/LUTCubeLoader.js": resolve(player, "core-lut.mjs"),
    "three/addons/loaders/HDRLoader.js": resolve(player, "core-hdr.mjs"),
    "three-mesh-bvh": resolve(threeNative, "src/addons/mesh-bvh.ts"),
    "three/addons/utils/BufferGeometryUtils.js": resolve(threeNative, "src/addons/buffer-geometry-utils.ts"),
    "three/addons/geometries/DecalGeometry.js": resolve(threeNative, "src/addons/decal-geometry.ts"),
  };
  const exports = new Map(await Promise.all(Object.values(modules).map(async (facade) => {
    // A facade's own exports; `three` inside one (an addon over the engine) is the facade above.
    const result = await build({ entryPoints: [facade], bundle: true, write: false, format: "esm",
      metafile: true, logLevel: "silent", external: ["three"], plugins: [packageImports] });
    return [facade, Object.values(result.metafile.outputs)[0].exports];
  })));
  const unresolved = new Map();
  const bundled = await build({
    stdin: { contents: boot
      ? `import ${JSON.stringify(resolve(player, "core-host.mjs"))}; import game from "tn:game"; globalThis.tn.__booting = true; void game.start().then(() => { globalThis.tn.__booting = false; game.ctx.renderer.render(game.ctx.scene, game.ctx.camera); }).catch(error => { globalThis.tn.__startupError = String(error.stack ?? error); });`
      : `${host ? `import ${JSON.stringify(resolve(player, "core-host.mjs"))}; ` : ""}import "tn:game";`, resolveDir: repo },
    bundle: true, write: false, format: "iife", platform: "neutral", target: "es2022",
    conditions: ["threenative-native"], define: { "import.meta.env": "{}", ...define }, metafile: true,
    logLevel: "silent", outfile, sourcemap: "external", sourcesContent: true,
    plugins: [packageImports, { name: "native-engine", setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)assets\.js$/ }, (args) => {
        if (args.importer.startsWith(`${resolve(core, "src")}/`))
          return { path: resolve(player, "core-assets.mjs") };
      });
      // The browser WebGPU upload lane; the engine uploads compressed textures itself.
      builder.onResolve({ filter: /(?:^|\/)compressed-texture-preparation\.js$/ }, (args) => {
        if (args.importer.startsWith(`${resolve(core, "src")}/`))
          return { path: resolve(player, "core-compressed-texture-preparation.mjs") };
      });
      builder.onResolve({ filter: /^tn:game$/ }, () => ({ path: "game", namespace: "native-game" }));
      builder.onLoad({ filter: /.*/, namespace: "native-game" }, () => ({ contents: code, resolveDir: repo }));
      builder.onResolve({ filter: /^@threenative\/core$/ }, () => ({ path: "core", namespace: "native-core" }));
      builder.onLoad({ filter: /.*/, namespace: "native-core" }, () => ({ contents: coreExports, resolveDir: repo }));
      builder.onResolve({ filter: /^@threenative\/core\// }, (args) => ({
        path: resolve(core, "src", `${args.path.split("/").at(-1)}.ts`),
      }));
      builder.onResolve({ filter: /^(three(?:\/|$)|three-mesh-bvh(?:\/|$))/ }, async (args) => {
        const source = args.namespace === "native-game" ? code : await readFile(args.importer, "utf8");
        const names = imports(source, args.path);
        const path = JSON.stringify([args.path, names]);
        unresolved.set(path, { specifier: args.path, names });
        return { path, namespace: "native-import" };
      });
      builder.onLoad({ filter: /.*/, namespace: "native-import" }, async (args) => {
        const { specifier, names } = unresolved.get(args.path);
        // three ships each addon under `addons/` and under its older `examples/jsm/` path.
        const facade = modules[specifier.replace(/^three\/examples\/jsm\//, "three/addons/")];
        // Missing symbols are temporary compiler inputs only. Their unique diagnostics survive
        // precisely when a live import uses them; the artifact is refused below, never emitted.
        const known = exports.get(facade) ?? [];
        return { contents: [
          ...(facade ? [`export * from ${JSON.stringify(facade)};`] : []),
          ...names.filter((name) => !known.includes(name)).map((name) => {
            const error = JSON.stringify(unboundDiagnostic(specifier, name));
            if (name === "*") return `throw new Error(${error});`;
            if (name === "default") return `export default function() { throw new Error(${error}); }`;
            return `export function ${name}() { throw new Error(${error}); }`;
          }),
          ...(!facade && names.length === 0 ? [`throw new Error(${JSON.stringify(unboundDiagnostic(specifier, "*"))});`] : []),
        ].join("\n"), resolveDir: repo };
      });
    } }],
  });
  const output = bundled.outputFiles.find((file) => file.path === outfile).text;
  const sourceMap = bundled.outputFiles.find((file) => file.path === `${outfile}.map`).text;
  const missing = [...new Set(output.match(/TN_NATIVE_ENGINE_UNBOUND: [^"\n]+/g) ?? [])].sort();
  if (missing.length) throw new Error(missing.join("\n"));
  rejectUpstream(bundled.metafile);
  await mkdir(dirname(outfile), { recursive: true });
  const temporary = `${outfile}.${randomUUID()}.tmp`;
  const temporaryMap = `${temporary}.map`;
  try {
    await writeFile(temporaryMap, sourceMap, { flag: "wx" });
    await writeFile(temporary, output, { flag: "wx" });
    await rename(temporaryMap, `${outfile}.map`);
    await rename(temporary, outfile);
  } finally {
    await unlink(temporaryMap).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  return { outfile, engineCommit, bytes: Buffer.byteLength(output), profile: { engine: "native", gameRuntime: "v8" } };
}

/**
 * Cooks a project's assets for the native engine beside the game bundle: its own `assets` config,
 * decoder-free (the engine's loaders decode no meshopt or KTX2), with the native package on, which
 * the player reads from `<bundle dir>/native/assets.tnpk`. `source` overrides the config's source dir.
 */
export async function cookNativeEngineAssets({ project, outfile, source }) {
  project = resolve(project);
  const config = resolve(project, "threenative.config.ts");
  let assets = {};
  if (existsSync(config)) {
    const built = await build({ entryPoints: [config], bundle: true, write: false, format: "esm",
      platform: "node", logLevel: "silent", packages: "external" });
    const module = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
    assets = module.default?.assets ?? {};
  }
  const { compileAssets } = await import(assetsEntry);
  await compileAssets({ cwd: project, config: { ...assets, ...(source && { source: resolve(source) }), nativePackage: true }, platform: "desktop",
    runtimeDecoders: { ktx2: false, meshopt: false } });
  const output = resolve(project, assets.output ?? "public", "native/assets.tnpk");
  const target = resolve(dirname(resolve(outfile)), "native/assets.tnpk");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(output));
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--entry", "--out", "--engine", "--game-runtime", "--assets", "--asset-source"].includes(args[i]) || !args[i + 1] || flags.has(args[i]))
      throw new Error(`TN_NATIVE_ENGINE_ARGS: invalid or repeated option ${args[i]}`);
    flags.set(args[i], args[i + 1]);
  }
  if (flags.get("--engine") !== "native" || flags.get("--game-runtime") !== "v8" || !flags.get("--entry") || !flags.get("--out"))
    throw new Error("Usage: bundle-native-engine.mjs --engine native --game-runtime v8 --entry <src/game.ts> --out <game.js> [--assets <project dir> [--asset-source <dir>]]");
  try {
    console.log(JSON.stringify(await bundleNativeEngine({ entry: flags.get("--entry"), outfile: flags.get("--out") })));
    if (flags.has("--assets"))
      console.log(JSON.stringify({ assets: await cookNativeEngineAssets({ project: flags.get("--assets"), outfile: flags.get("--out"),
        source: flags.get("--asset-source") }) }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
