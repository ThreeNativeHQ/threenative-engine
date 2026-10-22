#!/usr/bin/env node

/**
 * Bundle Script
 *
 * Bundles JavaScript code and assets into a format that can be embedded
 * in the native binary (similar to Deno compile / pkg).
 *
 * Options:
 * 1. Generate C header with embedded data (like xxd)
 * 2. Create a virtual filesystem archive
 * 3. Use CMake's file(EMBED) feature
 *
 * Usage:
 *   node scripts/bundle.mjs --entry game.js --output dist/bundle
 */

import { readFileSync, writeFileSync, writeSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Convert a buffer to a C array string
 */
function bufferToCArray(buffer, varName) {
  const bytes = Array.from(buffer);
  const lines = [];

  lines.push("// Auto-generated - do not edit");
  lines.push(`// Size: ${buffer.length} bytes`);
  lines.push("");
  lines.push(`static const unsigned char ${varName}[] = {`);

  // Output 16 bytes per line
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.slice(i, Math.min(i + 16, bytes.length));
    const hex = slice.map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ');
    lines.push(`    ${hex}${i + 16 < bytes.length ? ',' : ''}`);
  }

  lines.push("};");
  lines.push("");
  lines.push(`static const unsigned int ${varName}_len = ${buffer.length};`);

  return lines.join('\n');
}

/**
 * Bundle a single file
 */
function bundleFile(inputPath, varName) {
  console.log(`Bundling: ${inputPath}`);
  const buffer = readFileSync(inputPath);
  return bufferToCArray(buffer, varName);
}

/**
 * Bundle a directory recursively
 */
function bundleDirectory(dirPath, prefix = '') {
  const files = [];

  for (const entry of readdirSync(dirPath)) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...bundleDirectory(fullPath, `${prefix + entry}_`));
    } else {
      const varName = prefix + entry.replace(/[^a-zA-Z0-9]/g, '_');
      files.push({
        path: fullPath,
        varName,
        relativePath: (prefix + entry).replace(/_/g, '/'),
      });
    }
  }

  return files;
}

/**
 * Generate virtual filesystem header
 */
function generateVFSHeader(files, outputPath) {
  const lines = [];

  lines.push("// Auto-generated virtual filesystem");
  lines.push("// Do not edit");
  lines.push("");
  lines.push("#pragma once");
  lines.push("");
  lines.push("#include <cstddef>");
  lines.push("#include <cstring>");
  lines.push("");
  lines.push("namespace mystral {");
  lines.push("namespace vfs {");
  lines.push("");

  // Embed each file
  for (const file of files) {
    const buffer = readFileSync(file.path);
    lines.push(bufferToCArray(buffer, file.varName));
    lines.push("");
  }

  // File table
  lines.push("struct EmbeddedFile {");
  lines.push("    const char* path;");
  lines.push("    const unsigned char* data;");
  lines.push("    unsigned int size;");
  lines.push("};");
  lines.push("");
  lines.push("static const EmbeddedFile files[] = {");

  for (const file of files) {
    lines.push(`    { "${file.relativePath}", ${file.varName}, ${file.varName}_len },`);
  }

  lines.push("    { nullptr, nullptr, 0 }  // Sentinel");
  lines.push("};");
  lines.push("");

  // Lookup function
  lines.push("inline const EmbeddedFile* findFile(const char* path) {");
  lines.push("    for (const EmbeddedFile* f = files; f->path != nullptr; ++f) {");
  lines.push("        if (strcmp(f->path, path) == 0) {");
  lines.push("            return f;");
  lines.push("        }");
  lines.push("    }");
  lines.push("    return nullptr;");
  lines.push("}");
  lines.push("");

  lines.push("}  // namespace vfs");
  lines.push("}  // namespace mystral");

  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(outputPath, lines.join('\n'));
  console.log(`Generated: ${outputPath}`);
}

/**
 * Decoder-free targets retain Three's raw KTX2 loader but refuse Basis and ZSTD decoding.
 * A mobile bundle keeps full decoding only for a codec `--decoders` admits; raw KTX2 stays.
 * `threenative build` resolves the list per engine (Android V8: ktx2,meshopt). Desktop QuickJS and an
 * unknown desktop artifact use the same refusing stubs.
 */
const MOBILE_KTX2_MESSAGE =
  // Never spell the WASM host global: the bundle guard must not mistake diagnostics for code.
  "TN_NATIVE_KTX2_UNSUPPORTED: this decoder-free native bundle carries no qualified Basis or ZSTD decoder. Use GPU-ready KTX2 textures without supercompression, or keep transcoded textures on the web target.";
const MOBILE_MESH_MESSAGE =
  "TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED: this decoder-free native bundle carries no qualified Meshopt or Draco decoder. Compressed model geometry cannot be decoded here; native compilation keeps shared images and decoder-free model geometry, or keep compressed models on the web target.";

const MOBILE_DECODER_STUBS = [
  {
    codec: 'ktx2',
    endsWith: '/examples/jsm/loaders/KTX2Loader.js',
    // The private query bypasses this exact-path replacement once; upstream owns raw parsing.
    source: (id) => `import { KTX2Loader as RawKTX2Loader } from ${JSON.stringify(`${id}?threenative-raw-ktx2`)};
export class KTX2Loader extends RawKTX2Loader {
  init() { return Promise.reject(new Error(${JSON.stringify(MOBILE_KTX2_MESSAGE)})); }
}
`,
  },
  {
    codec: 'ktx2',
    endsWith: '/examples/jsm/libs/zstddec.module.js',
    source: `export class ZSTDDecoder {
  // Upstream awaits init inside an async Promise executor; reject at decode to avoid hanging.
  init() { return Promise.resolve(); }
  decode() { throw new Error(${JSON.stringify(MOBILE_KTX2_MESSAGE)}); }
}
`,
  },
  {
    codec: 'meshopt',
    endsWith: '/examples/jsm/libs/meshopt_decoder.module.js',
    source: `const message = "${MOBILE_MESH_MESSAGE}";
function refuse() { throw new Error(message); }
export const MeshoptDecoder = {
  supported: false,
  get ready() { return refuse(); },
  decodeVertexBuffer: refuse,
  decodeIndexBuffer: refuse,
  decodeIndexSequence: refuse,
  decodeGltfBuffer: refuse,
  decodeGltfBufferAsync: refuse,
  useWorkers: refuse,
};
`,
  },
  {
    codec: 'draco',
    endsWith: '/examples/jsm/loaders/DRACOLoader.js',
    source: `const message = "${MOBILE_MESH_MESSAGE}";
export class DRACOLoader {
  setDecoderPath() { return this; }
  setDecoderConfig() { return this; }
  setWorkerLimit() { return this; }
  preload() { return this; }
  load(url, onLoad, onProgress, onError) {
    const error = new Error(\`\${message} (requested '\${url}')\`);
    if (typeof onError === "function") onError(error);
    else throw error;
  }
  parse() { throw new Error(message); }
  decodeDracoFile() { throw new Error(message); }
  dispose() { return this; }
}
`,
  },
];

/**
 * Matched on the resolved module path rather than the import specifier so every spelling of
 * the same file — `three/addons/...`, `three/examples/jsm/...`, or a relative import from
 * inside three — lands on the same replacement.
 */
function mobileDecoderStub(id, admitted) {
  const normalized = id.split('\\').join('/');
  const stub = MOBILE_DECODER_STUBS.find(
    (stub) => normalized.endsWith(stub.endsWith) && !admitted.includes(stub.codec),
  );
  return typeof stub?.source === 'function' ? stub.source(id) : stub?.source;
}

/**
 * Main
 */
async function bundleProject(project, entryPoint, outputPath, target, nativeBackend, decoders = []) {
  const absoluteProject = resolve(project);
  const absoluteEntry = resolve(absoluteProject, entryPoint);
  const absoluteOutput = resolve(outputPath);
  // Vite's CLI supplies this default; its JavaScript API does not. Native bundling uses the API,
  // so without an explicit default CommonJS packages such as React select their development
  // builds and every game has to repeat this platform seam in vite.config.ts. Preserve an
  // explicitly selected development mode for diagnostics while making shipping builds honest.
  process.env.NODE_ENV ??= 'production';
  const require = createRequire(join(absoluteProject, 'package.json'));
  let viteEntry;
  try {
    viteEntry = require.resolve('vite');
  } catch {
    throw new Error(`Cannot bundle '${absoluteProject}': its pinned Vite dependency is missing.`);
  }
  const { build } = await import(pathToFileURL(viteEntry).href);
  const nativePrelude = `
const nativeElements = new Map();
const nativeGetElementById = document.getElementById.bind(document);
const nativeQuerySelector = document.querySelector.bind(document);
document.getElementById = (id) => nativeElements.get(id) ?? nativeGetElementById(id);
document.querySelector = (selector) =>
  selector.startsWith("#") ? nativeElements.get(selector.slice(1)) ?? null : nativeQuerySelector(selector);
for (const id of ["app", "root"]) {
  if (nativeGetElementById(id) == null) {
    const element = document.createElement("div");
    element.id = id;
    element.nodeType = 1;
    element.ownerDocument = document;
    element.append = (child) => element.appendChild(child);
    nativeElements.set(id, element);
    document.body?.append?.(element);
  }
}
if (typeof globalThis.requestAnimationFrame === "function") {
  const nativeRequestFrame = globalThis.requestAnimationFrame.bind(globalThis);
  let nativeFrames = 0;
  globalThis.requestAnimationFrame = (callback) => nativeRequestFrame((time) => {
    const result = callback(time);
    nativeFrames += 1;
    if (nativeFrames === 1) {
      console.info("TN_NATIVE_SMOKE_READY:webgpu");
      console.info("TN_NATIVE_SMOKE_FIRST_FRAME");
    }
    if (nativeFrames === 300) console.info("TN_NATIVE_SMOKE_300_FRAMES:300");
    return result;
  });
}`;
  const virtualEntry = 'virtual:threenative-native-entry';
  const resolvedVirtualEntry = `\0${virtualEntry}`;
  // The bundle is wrapped in a classic-script IIFE, where `import.meta` is a parse-time
  // SyntaxError. Dependencies like three's KTX2Loader build default asset URLs from
  // import.meta.url at module scope; on native those defaults are never the real loader
  // path (the compile step copies the transcoder into public/ and core points at it), so
  // any constructible URL is correct. Rewritten textually before Rollup parses.
  const importMetaPlugin = {
    name: 'threenative-import-meta-url',
    enforce: 'pre',
    transform(code) {
      if (!code.includes('import.meta.url')) return null;
      return code.replaceAll('import.meta.url', '"file:///threenative-bundle/"');
    },
  };
  const mobileDecodersPlugin = {
    name: 'threenative-mobile-decoders',
    enforce: 'pre',
    load(id) {
      const stub = mobileDecoderStub(id, decoders);
      return stub === undefined ? null : stub;
    },
  };
  const nativeEntryPlugin = {
    name: 'threenative-native-entry',
    enforce: 'pre',
    resolveId(id) {
      return id === virtualEntry ? resolvedVirtualEntry : null;
    },
    load(id) {
      if (id !== resolvedVirtualEntry) return null;
      return `import * as gameModule from ${JSON.stringify(absoluteEntry)};
const game = gameModule.default;
void game.start().catch((error) => console.error(
  \`TN_NATIVE_START_FAILED:\${error instanceof Error ? error.message : String(error)}\`,
));`;
    },
    moduleParsed(info) {
      if (resolve(info.id) === absoluteEntry && !info.exports.includes('default')) {
        this.error(`TN_NATIVE_ENTRY_NO_DEFAULT: ${entryPoint} must default-export the game.`);
      }
    },
  };
  mkdirSync(dirname(absoluteOutput), { recursive: true });
  // Read by the project's own `createWebBrandPlugin`: this bundle is not a browser's.
  process.env.THREENATIVE_NATIVE_BUNDLE = target;
  await build({
    root: absoluteProject,
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV) },
    plugins:
      target === 'desktop' && !nativeBackend
        ? [importMetaPlugin, nativeEntryPlugin]
        : [importMetaPlugin, mobileDecodersPlugin, nativeEntryPlugin],
    // One three, whatever the import graph looks like. The game resolves `three` beside itself
    // while a linked engine package — `@threenative/core`, or anything else installed outside the
    // project — resolves the same bare specifier beside *itself*, so a second physical copy enters
    // the bundle. Three keeps the TSL node stack in module scope, so the copy that builds a
    // material is not the copy the renderer pushed onto, and the first material build on the phone
    // dies with "No stack defined for assign operation". `mergeConfig` concatenates arrays, so a
    // project that dedupes its own packages keeps every one of them.
    // The native physics backend is selected where the runtime has no WebAssembly to run Rapier
    // as WASM: every mobile target, and any desktop host whose engine is not V8. `threenative
    // build` reads that capability from the runtime binary it will package and passes
    // `--native-backend`; a direct call without it keeps the historical desktop backend. The
    // choice is one export map here rather than a platform branch in game code.
    resolve:
      target === 'desktop' && !nativeBackend
        ? { dedupe: ['three'] }
        : { conditions: ['threenative-native'], dedupe: ['three'] },
    configFile: existsSync(join(absoluteProject, 'vite.config.ts'))
      ? join(absoluteProject, 'vite.config.ts')
      : undefined,
    build: {
      emptyOutDir: false,
      lib: {
        entry: absoluteEntry,
        fileName: () => basename(absoluteOutput),
        formats: ['es'],
      },
      // Minified for the shipped asset (roughly half the raw bytes). `keepNames` is not optional:
      // core reads `backend.constructor.name` for the renderer's backend stamp (`renderer.ts`,
      // `geometry-capture.ts`), and the runtime's structured-clone description reads
      // `value.constructor.name` (`url-worker-polyfill.js`). Without it those class names mangle
      // and the reports lie. `comments.legal` keeps the bundled dependencies' `@license`/SPDX
      // banners minification would otherwise strip; sourcemaps stay off, as today.
      minify: true,
      outDir: dirname(absoluteOutput),
      rollupOptions: {
        input: virtualEntry,
        output: {
          // `/*!` makes the scope marker a legal comment, the one class the minifier keeps.
          banner: `/*! TN_NATIVE_BUNDLE_SCOPE */\n(() => {\n${nativePrelude}`,
          codeSplitting: false,
          footer: '})();',
          // Vite's lib path defaults the minifier to `{ codegen: false }` for an ES lib, which
          // mangles identifiers but keeps every newline and indent. Force the full pass.
          minify: true,
          keepNames: true,
          comments: { legal: true },
        },
      },
      target: 'es2022',
    },
  });
  const source = readFileSync(absoluteOutput, 'utf8');
  if (/^\s*import\s+/m.test(source) || /\bimport\s*\(/.test(source)) {
    throw new Error(`Native bundle '${absoluteOutput}' contains a runtime import.`);
  }
  console.log(`ThreeNative native bundle: ${absoluteOutput}`);
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let entryPoint = null;
  let assetsDir = null;
  let outputDir = 'dist';
  let project = null;
  let target = null;
  let nativeBackend = false;
  let decoders = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--entry' && args[i + 1]) {
      entryPoint = args[++i];
    } else if (args[i] === '--assets' && args[i + 1]) {
      assetsDir = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[++i];
    } else if (args[i] === '--project' && args[i + 1]) {
      project = args[++i];
    } else if (args[i] === '--target' && args[i + 1]) {
      target = args[++i];
    } else if (args[i] === '--native-backend') {
      nativeBackend = true;
    } else if (args[i] === '--decoders' && args[i + 1] !== undefined) {
      decoders = args[++i].split(',').filter((codec) => codec.length > 0);
      const unknown = decoders.filter((codec) => !MOBILE_DECODER_STUBS.some((stub) => stub.codec === codec));
      if (unknown.length > 0) throw new Error(`--decoders names unknown codec(s): ${unknown.join(', ')}`);
    }
  }

  if (project) {
    if (!entryPoint) throw new Error('--project requires --entry.');
    if (!['android', 'desktop', 'ios'].includes(target)) {
      throw new Error('--project requires --target android|desktop|ios.');
    }
    await bundleProject(project, entryPoint, outputDir, target, nativeBackend, decoders);
    return;
  }

  if (!entryPoint && !assetsDir) {
    console.log('Mystral Bundle Tool');
    console.log('');
    console.log('Usage:');
    console.log('  node scripts/bundle.mjs --entry game.js [--assets assets/] [--output dist/]');
    console.log('');
    console.log('Options:');
    console.log('  --entry    Entry point JavaScript file');
    console.log('  --assets   Directory containing assets to bundle');
    console.log('  --output   Output directory (default: dist/)');
    console.log('');
    console.log('Generates a C header file with embedded data for use in native builds.');
    return;
  }

  const files = [];

  // Bundle entry point
  if (entryPoint) {
    files.push({
      path: entryPoint,
      varName: 'entry_js',
      relativePath: 'entry.js',
    });
  }

  // Bundle assets directory
  if (assetsDir) {
    files.push(...bundleDirectory(assetsDir, 'asset_'));
  }

  // Generate header
  const headerPath = join(outputDir, 'embedded_assets.h');
  generateVFSHeader(files, headerPath);

  console.log('');
  console.log('Bundle complete!');
  console.log(`Files bundled: ${files.length}`);
  console.log(`Output: ${headerPath}`);
  console.log('');
  console.log('Include in your build:');
  console.log(`  #include "${headerPath}"`);
  console.log('');
  console.log('Access files:');
  console.log('  const auto* file = mystral::vfs::findFile("entry.js");');
  console.log('  if (file) {');
  console.log('      // file->data, file->size');
  console.log('  }');
}

main().catch((error) => {
  writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
