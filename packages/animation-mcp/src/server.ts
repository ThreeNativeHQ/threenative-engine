import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { poseLabPage } from "./page.js";

const CLIENT = new URL("./client/app.js", import.meta.url);
const MAX_RECIPE_BYTES = 256_000;

export interface PoseLabOptions {
  readonly port?: number;
  readonly project?: string;
}

export function parseArgs(argv: readonly string[]): PoseLabOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--port" && flag !== "--project") throw new Error(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value.`);
    values.set(flag, value);
    index += 1;
  }
  const portText = values.get("--port");
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535))
    throw new Error("--port must be an integer from 1 to 65535.");
  return {
    ...(port === undefined ? {} : { port }),
    ...(values.get("--project") === undefined ? {} : { project: values.get("--project") }),
  };
}

function projectFile(root: string, relative: string): string | undefined {
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/u).some((part) => part.length === 0 || part.startsWith("."))
  )
    return undefined;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  return resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : undefined;
}

async function modelsIn(project: string): Promise<readonly string[]> {
  const models: string[] = [];
  const ignored = new Set([".git", "build", "dist", "node_modules"]);
  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > 6 || models.length >= 2_000) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), child, depth + 1);
      else if (entry.name.toLowerCase().endsWith(".glb")) models.push(child);
    }
  };
  await visit(project, "", 0);
  return models.sort((left, right) => left.localeCompare(right));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array);
    size += value.length;
    if (size > MAX_RECIPE_BYTES) throw new Error("Request exceeds 256 KB.");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, value: string | Uint8Array, type: string) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": type,
    "x-content-type-options": "nosniff",
  });
  response.end(value);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

export async function startPoseLab(options: PoseLabOptions = {}): Promise<{
  close(): Promise<void>;
  readonly port: number;
}> {
  const project = path.resolve(options.project ?? process.cwd());
  const port = options.port ?? 4192;
  await readdir(project).catch(() => {
    throw new Error(`Project directory does not exist: ${project}`);
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://pose-lab");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/pose"))
        return send(response, 200, poseLabPage(path.basename(project)), "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app.js")
        return send(response, 200, await readFile(CLIENT), "text/javascript; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204);
        return response.end();
      }
      if (request.method === "GET" && url.pathname === "/api/models")
        return json(response, 200, { models: await modelsIn(project) });
      if (request.method === "GET" && url.pathname === "/api/model") {
        const relative = url.searchParams.get("path") ?? "";
        const file = relative.endsWith(".glb") ? projectFile(project, relative) : undefined;
        if (file === undefined) return json(response, 404, { error: "GLB not found." });
        const model = await readFile(file).catch(() => undefined);
        return model === undefined
          ? json(response, 404, { error: "GLB not found." })
          : send(response, 200, model, "model/gltf-binary");
      }
      if (url.pathname === "/api/recipe") {
        const relative = url.searchParams.get("path") ?? "";
        const file = relative.endsWith(".json") ? projectFile(project, relative) : undefined;
        if (file === undefined) return json(response, 404, { error: "Recipe not found." });
        if (request.method === "GET") {
          const content = await readFile(file, "utf8").catch(() => undefined);
          if (content === undefined) return json(response, 404, { error: "Recipe not found." });
          return json(response, 200, { recipe: JSON.parse(content), path: relative });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          if (typeof body.recipe !== "object" || body.recipe === null)
            return json(response, 400, { error: "Body must contain a recipe object." });
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, `${JSON.stringify(body.recipe, null, 2)}\n`, "utf8");
          return json(response, 200, { path: relative, saved: true });
        }
      }
      return json(response, 404, { error: "Not found." });
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  // The bound port, not the requested one: the animation MCP asks for 0 so two projects, or a
  // second call in the same process, never collide on a guessed number.
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  );
}

if (invokedAsCli()) {
  startPoseLab(parseArgs(process.argv.slice(2)))
    .then(({ port }) => process.stdout.write(`Pose Lab: http://127.0.0.1:${port}/pose\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
