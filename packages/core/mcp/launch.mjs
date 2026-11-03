import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where a package is installed, or undefined when it is not. Node's own resolver is the wrong tool
 * here: `threenative-engine-mcp` publishes an `exports` map with only an `import` condition, which
 * `createRequire().resolve` refuses, and the answer we want is the directory rather than a
 * specifier's entry point. Walking `node_modules` upward from both the project and this package
 * covers a direct dependency, a hoisted one, and pnpm's nested store alike. */
function packageDirectory(name) {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let directory = path.resolve(start);
    while (true) {
      const candidate = path.join(directory, "node_modules", name);
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return undefined;
}

/** The module that starts the server. The published main entry is not always it —
 * `threenative-sculpt-mcp` exports a library from `dist/index.js` and starts its server from the
 * `bin` file — so `bin` wins wherever a package declares one. */
function serverEntry(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[manifest.name];
  const exported =
    typeof manifest.exports === "string"
      ? manifest.exports
      : (manifest.exports?.["."]?.import ?? manifest.exports?.["."]);
  const relative =
    bin ??
    (typeof exported === "string" ? exported : undefined) ??
    manifest.main ??
    manifest.module;
  return relative === undefined ? undefined : path.resolve(directory, relative);
}

/** Runs an MCP server the project may or may not have installed. Nothing here may write to stdout:
 * that stream is the JSON-RPC transport, and one stray line makes the server unusable. */
export async function launchMcpServer({ name, version, env = {}, args = [] }) {
  for (const [key, value] of Object.entries(env)) process.env[key] ??= value;
  const directory = packageDirectory(name);
  const entry = directory === undefined ? undefined : serverEntry(directory);
  if (entry !== undefined && existsSync(entry)) {
    // A server entry that is also a `bin` starts itself only when it is the process's main module,
    // which it decides by comparing `process.argv[1]` against its own path. Importing it without
    // this line loads the module and starts nothing, and the host reports a server that connected
    // and then went silent.
    process.argv[1] = entry;
    process.argv.push(...args);
    await import(pathToFileURL(entry).href);
    return;
  }
  // Not installed. `npx` keeps the server available in a project that never listed it, which is the
  // whole point of wiring these in from the library rather than from a scaffold.
  const child = spawn("npx", ["--yes", `${name}@${version}`, ...args], {
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    process.stderr.write(`TN_MCP_LAUNCH: ${name} is not installed and npx failed: ${error}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(signal === null ? (code ?? 0) : 1);
  });
}
