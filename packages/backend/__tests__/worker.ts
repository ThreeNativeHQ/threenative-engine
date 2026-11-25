/**
 * The test Worker, as Miniflare runs it: the package's own TypeScript, transpiled file by file.
 *
 * A build would leave these specs proving whatever `dist` last held, and the room class only
 * exists inside a Worker runtime — so the module graph is built here from `src/`, and `workerd`
 * (through Miniflare) is what actually evaluates it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

/** The host a share Worker plays: it resolves `gameId` itself and hands the handler the namespace. */
const ENTRY = `
import { handleBackend } from "./src/cloudflare.js";
import { BackendRoom } from "./src/room-do.js";
export { BackendRoom };
export default {
  fetch: (request, env) =>
    handleBackend(request, {
      db: env.BACKEND_DB,
      gameId: "project-1",
      playerId: "player-1",
      rooms: env.ROOMS,
      maxPlayers: 4,
    }),
};
`;

const ENTRY_NAME = "worker.js";
/** `from "./x.js"` in transpiled output: the only imports these sources have. */
const RELATIVE_IMPORT = /\bfrom\s+"(\.[^"]+)"/gu;

function moduleName(importer: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
}

/** One module's JavaScript, with the type-only imports transpiled away exactly as a build does. */
async function transpile(name: string): Promise<string> {
  const file = new URL(`../${name.replace(/\.js$/u, ".ts")}`, import.meta.url);
  return ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    // `.ts`, not `.js`: a `.js` name makes the parser read `new Map<K, V>()` as a JSX element.
    fileName: name.replace(/\.js$/u, ".ts"),
  }).outputText;
}

/**
 * The package's own modules under `entries`, transpiled and keyed by path from the package root.
 * The browser spec serves exactly this, so a page runs the client a game gets.
 */
export async function transpiledModules(
  entries: readonly string[],
): Promise<Record<string, string>> {
  const modules: Record<string, string> = {};
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const contents = await transpile(name);
    modules[name] = contents;
    for (const match of contents.matchAll(RELATIVE_IMPORT)) {
      pending.push(moduleName(name, match[1] ?? ""));
    }
  }
  return modules;
}

/** Every module the test Worker loads, keyed the way workerd's ESM resolver expects them. */
export async function workerModules(
  entry: string = ENTRY,
): Promise<Record<string, { type: "esm"; contents: string }>> {
  const modules: Record<string, { type: "esm"; contents: string }> = {
    [ENTRY_NAME]: { type: "esm", contents: entry },
  };
  const seen = new Set([ENTRY_NAME]);
  const pending = [ENTRY_NAME];
  while (pending.length > 0) {
    const name = pending.pop() as string;
    // The entry itself is the literal the caller passed; only package modules are read from disk.
    const contents = name === ENTRY_NAME ? entry : await transpile(name);
    modules[name] = { type: "esm", contents };
    for (const match of contents.matchAll(RELATIVE_IMPORT)) {
      const dependency = moduleName(name, match[1] ?? "");
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      pending.push(dependency);
    }
  }
  return modules;
}
