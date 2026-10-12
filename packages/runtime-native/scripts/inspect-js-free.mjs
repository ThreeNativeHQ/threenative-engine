#!/usr/bin/env node
// Gate E/T inspector (PRD-499): proves a binary is JS-free from its symbols, its dynamic
// dependencies, its embedded strings and its packaged resources together. A `.js` filename scan
// proves nothing, since a binary can embed a VM. Fails closed: a tool that cannot run is a failure.
//
//   node scripts/inspect-js-free.mjs --binary <file> [--resources <dir>] [--manifest <out.json>]
//                                    [--target <name>] [--capability <name> ...]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Root C++ namespace matters: a Rust crate may carry its own `crate::v8` module (a Node API shim),
 * which contains no VM. Symbols of V8 itself still include root v8::, even inside a template. */
/** Symbol families of every JS engine and web view the native engine must not carry. */
export const VM_SYMBOL_FAMILIES = [
  { family: "v8", pattern: /(?<![\w:])v8::|(?<![\w:])v8_inspector::|@v8@@|@v8_inspector@@|\b_?V8_Fatal\b/ },
  { family: "quickjs", pattern: /\b_?JS_(NewRuntime|NewContext|Eval|FreeRuntime)\b|\bquickjs\b/i },
  { family: "javascriptcore", pattern: /\b_?JSGlobalContext\w*|\b_?JSEvaluateScript\b|\bJSC::|@JSC@@/ },
  { family: "hermes", pattern: /\bhermes::|\bfacebook::hermes\b|@hermes(?:@facebook)?@@/ },
  { family: "webview", pattern: /\b_?webkit_web_view\w*|\bWKWebView\b|\bICoreWebView2\w*/ },
  { family: "embedded-runtime-scripts", pattern: /\bmystral::runtime_scripts::|@runtime_scripts@mystral@@/ },
];

/** Shared libraries that load a VM or a web view. */
export const VM_LIBRARY = /(^|[/\\])(lib)?(v8|v8_libplatform|quickjs|JavaScriptCore|javascriptcoregtk[\w.-]*|hermes|webkit2gtk[\w.-]*|WebView2Loader)(\.|$)/i;

/** Bundler output that only an embedded script blob would put in a native binary. */
export const SCRIPT_MARKERS = ["//# sourceMappingURL=", "Object.defineProperty(exports, \"__esModule\"", "__webpack_require__", "\"use strict\";\n"];

/** Packaged files that are scripts, VM snapshots or bytecode. */
export const SCRIPT_RESOURCE = /\.(m?js|cjs|jsbundle|hbc)$|(^|[/\\])(snapshot_blob|natives_blob)\.bin$/;

/** Module IDs survive bundling as paths/comments and AOT as source/symbol strings. Accept
 * emitted JS extensions too; inspecting only .ts would miss a bundled world implementation. */
export const TS_WORLD_MODULE = /world-(?:cells|tiles|gpu-scene|package)(?:\.(?:tsx?|[cm]?js)\b|(?=[/\\"'\s]|$))/g;
const TS_WORLD_SOURCE = /\bclass\s+(?:WorldCells|TerrainTiles|WorldGpuScene)\b|\b(?:WorldCells|TerrainTiles|WorldGpuScene)\s*=\s*class\b|\bfunction\s+(?:validateWorldPackage|cellPlacements|cullAndSelect(?:Shadow)?)\s*\(/g;
export function findWorldModuleFindings(bytes, origin) {
  const text = bytes.toString("latin1");
  return [...new Set([...(text.match(TS_WORLD_MODULE) ?? []), ...(text.match(TS_WORLD_SOURCE) ?? [])])].map((module) => ({
    kind: "ts-world-module",
    evidence: `${origin}: ${module}`,
  }));
}

/** Upstream shader/runtime module IDs and unbundled engine source; facade class symbols are legal. */
export function findThreeModuleFindings(bytes, origin) {
  const text = bytes.toString("latin1");
  const pattern = /three\.(?:module|webgpu|tsl)(?:\.min)?\.js\b|three\/(?:build|src)\/[\w./-]+|\bclass\s+NodeBuilder\b/g;
  return [...new Set(text.match(pattern) ?? [])].map((module) => ({
    kind: "upstream-three", evidence: `${origin}: ${module}`,
  }));
}

export function findSymbolFindings(symbols) {
  const findings = [];
  for (const { family, pattern } of VM_SYMBOL_FAMILIES) {
    const hit = symbols.find((symbol) => pattern.test(symbol));
    if (hit) findings.push({ kind: "symbol", family, evidence: hit });
  }
  return findings;
}

export function findLibraryFindings(libraries) {
  return libraries.filter((lib) => VM_LIBRARY.test(lib)).map((lib) => ({ kind: "library", evidence: lib }));
}

export function findScriptMarkers(bytes) {
  const text = bytes.toString("latin1");
  return SCRIPT_MARKERS.filter((marker) => text.includes(marker)).map((marker) => ({
    kind: "embedded-script",
    evidence: JSON.stringify(marker),
  }));
}

export function findResourceFindings(files) {
  return files.filter((file) => SCRIPT_RESOURCE.test(file)).map((file) => ({ kind: "resource", evidence: file }));
}

function run(tool, args) {
  try {
    return execFileSync(tool, args, { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`TN_JS_FREE_TOOL_FAILED: ${tool} ${args.join(" ")}: ${error.message}`);
  }
}

function readMetadata(binary, platform, execute) {
  if (platform === "win32") {
    // MSVC executables have no COFF symbol table. The link's /MAP sidecar retains public and
    // static symbols (including statically linked VMs); /imports alone cannot prove JS freedom.
    const map = readFileSync(`${binary.replace(/\.exe$/i, "")}.map`, "utf8");
    const symbols = [...map.matchAll(/^\s*[\da-f]{4}:[\da-f]+\s+(\S+)\s+[\da-f]+\s/gim)].map((match) => match[1]);
    if (symbols.length === 0) throw new Error(`TN_JS_FREE_NO_SYMBOLS: ${binary} has no linker map symbols to inspect`);
    const imports = execute("dumpbin", ["/imports", binary]);
    return {
      symbols: [...symbols, ...imports.split("\n").filter(Boolean)],
      libraries: [...imports.matchAll(/^\s+(\S+\.dll)\s*$/gim)].map((match) => match[1]),
    };
  }
  // Defined and undefined symbols both count: an import of v8:: is as much a VM as a definition.
  const out = execute("nm", platform === "darwin" ? ["-C", binary] : ["-C", "--no-sort", binary]);
  const symbols = out.split("\n").filter(Boolean);
  const libraries = platform === "darwin"
    ? execute("otool", ["-L", binary]).split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean)
    : [...execute("readelf", ["-d", binary]).matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map((match) => match[1]);
  return { symbols, libraries };
}

function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(root, path));
    }
  };
  walk(root);
  return files;
}

export function inspect({ binary, resources, nativeWorld = false }, { platform = process.platform, run: execute = run } = {}) {
  const bytes = readFileSync(binary);
  const { symbols, libraries } = readMetadata(binary, platform, execute);
  if (symbols.length === 0) throw new Error(`TN_JS_FREE_NO_SYMBOLS: ${binary} has no symbol table to inspect`);
  const findings = [
    ...findSymbolFindings(symbols),
    ...findLibraryFindings(libraries),
    ...findScriptMarkers(bytes),
    ...findThreeModuleFindings(bytes, binary),
    ...findThreeModuleFindings(Buffer.from(symbols.join("\n")), "symbols"),
    ...(resources ? findResourceFindings(listFiles(resources)) : []),
  ];
  if (resources) for (const file of listFiles(resources)) {
    findings.push(...findThreeModuleFindings(Buffer.from(file), "resource path"));
    findings.push(...findThreeModuleFindings(readFileSync(join(resources, file)), file));
  }
  if (nativeWorld) {
    findings.push(...findWorldModuleFindings(bytes, binary));
    findings.push(...findWorldModuleFindings(Buffer.from(symbols.join("\n")), "symbols"));
    if (resources) for (const file of listFiles(resources)) {
      findings.push(...findWorldModuleFindings(Buffer.from(file), "resource path"));
      findings.push(...findWorldModuleFindings(readFileSync(join(resources, file)), file));
    }
    // Fail closed on a wrong/trivial artifact. This is the CPU WorldCells fixture, not PRD-522's
    // future desktop walk: it must actually link all three native world implementations it uses.
    for (const name of ["WorldCells", "TerrainTiles", "validateWorldPackage"]) {
      if (!symbols.some((symbol) => symbol.includes(`tn::engine::world::${name}`) ||
          symbol.includes(`${name}@world@engine@tn@@`)))
        findings.push({ kind: "missing-native-world", evidence: name });
    }
  }
  return {
    binary,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    symbolCount: symbols.length,
    libraries,
    resourcesInspected: Boolean(resources),
    backend: symbols.some((s) => /\bdawn::native::|\bdawn::wire::|@(native|wire)@dawn@@/.test(s))
      ? "dawn"
      : symbols.some((s) => /\bwgpu_|wgpuGetVersion/.test(s))
        ? "wgpu-native"
        : "unknown",
    findings,
    jsFree: findings.length === 0,
  };
}

function parseArgs(argv) {
  const options = { capabilities: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--native-world") { options.nativeWorld = true; continue; }
    const value = argv[i + 1];
    if (flag === "--binary") options.binary = value;
    else if (flag === "--resources") options.resources = value;
    else if (flag === "--manifest") options.manifest = value;
    else if (flag === "--target") options.target = value;
    else if (flag === "--capability") options.capabilities.push(value);
    else throw new Error(`TN_JS_FREE_BAD_ARGUMENT: ${flag}`);
    i += 1;
  }
  if (!options.binary) throw new Error("TN_JS_FREE_BAD_ARGUMENT: --binary <file> is required");
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = {
      ...inspect(options),
      target: options.target ?? null,
      capabilities: options.capabilities,
      inspectedAt: new Date().toISOString(),
    };
    if (options.manifest) {
      mkdirSync(dirname(options.manifest), { recursive: true });
      writeFileSync(options.manifest, `${JSON.stringify(report, null, 2)}\n`);
    }
    for (const finding of report.findings) {
      console.error(`TN_JS_FREE_FINDING ${finding.kind}${finding.family ? `/${finding.family}` : ""}: ${finding.evidence}`);
    }
    console.log(`${report.jsFree ? "JS_FREE_OK" : "JS_FREE_FAIL"} ${report.binary} sha256=${report.sha256} backend=${report.backend}`);
    process.exitCode = report.jsFree ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
