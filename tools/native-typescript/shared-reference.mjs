// Same corpus source through the real Wasm facade, without a browser for non-render assertions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "node:util";
import { upstreamExportNames } from "./perry-facade.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export function sharedReferenceCode() {
  const names = upstreamExportNames();
  return {
    names,
    exports: names.map((name) => `export const ${name} = bound.${name};`).join("\n"),
  };
}

export async function runWasmReference(file, expected) {
  const { tsImport } = await import("tsx/esm/api");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tn-ref-wasm-"));
  const facade = path.join(tmp, "facade.mts");
  const source = path.join(tmp, "case.mts");
  const { names, exports } = sharedReferenceCode();
  fs.writeFileSync(
    facade,
    `import fs from "node:fs";
import create from ${JSON.stringify(pathToFileURL(path.join(repo, "packages/runtime-native/build/web/tn-native-engine-web.mjs")).href)};
import { bindWebEngine } from ${JSON.stringify(pathToFileURL(path.join(repo, "packages/three-native/src/browser-entry.ts")).href)};
const bytes = fs.readFileSync(${JSON.stringify(path.join(repo, "packages/runtime-native/build/web/tn-native-engine-web.wasm"))});
const bound = await bindWebEngine(() => create({instantiateWasm(imports, receive) {
  const module = new WebAssembly.Module(bytes); const instance = new WebAssembly.Instance(module, imports);
  receive(instance, module); return instance.exports;
}}), ${JSON.stringify(names)});
${exports}\n`,
  );
  fs.writeFileSync(
    source,
    fs
      .readFileSync(file, "utf8")
      .replace(
        /\bfrom\s*["']three(?:\/[\w-]+)?["']/g,
        `from ${JSON.stringify(pathToFileURL(facade).href)}`,
      ),
  );
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const frame = process.env.TN_TSL_FRAME;
  const log = console.log;
  let output = "";
  let error;
  try {
    if (!savedDocument) globalThis.document = { currentScript: null };
    if (!savedWindow) globalThis.window = globalThis;
    Reflect.deleteProperty(process.env, "TN_TSL_FRAME");
    console.log = (...args) => {
      output += `${format(...args)}\n`;
    };
    await tsImport(source, import.meta.url);
  } catch (thrown) {
    error = thrown;
  } finally {
    console.log = log;
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (frame === undefined) Reflect.deleteProperty(process.env, "TN_TSL_FRAME");
    else process.env.TN_TSL_FRAME = frame;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return {
    ok: error === undefined && Buffer.from(output).equals(expected.stdout),
    note: error
      ? String(error)
      : Buffer.from(output).equals(expected.stdout)
        ? "Wasm stdout matches"
        : `Wasm stdout mismatch: ${output}`,
  };
}
