/** `threenative deploy`: build the web bundle, pack it and PUT it to Studio's share endpoint,
 * which is what turns a game into a link a friend can open. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliExit, request, requireToken, serverMessage } from "./account.js";

const SHARE_BUILD_MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 2_000;

async function walk(root: string, dir = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walk(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** ponytail: copy of Studio's `src/server/release/shareArchive.ts` packDirectory. The PRD-904
 * AC-6 e2e uploads this archive to Studio's real parser, so any drift fails there; move it to a
 * shared package if a third writer appears. Layout: u32BE name length, name, u32BE size, data,
 * depth-first in readdir order, with a `.br`/`.gz` sibling dropped when the original is present. */
export async function packDirectory(root: string): Promise<Buffer> {
  const all = await walk(root);
  const present = new Set(all);
  const files = all.filter(
    (file) => !(/\.(br|gz)$/u.test(file) && present.has(file.replace(/\.(br|gz)$/u, ""))),
  );
  if (files.length > MAX_FILES)
    throw new CliExit(4, `The build has ${files.length} files; the limit is ${MAX_FILES}.`);
  const parts: Buffer[] = [];
  let bytes = 0;
  for (const file of files) {
    const data = await readFile(path.join(root, file));
    bytes += data.length;
    if (bytes > SHARE_BUILD_MAX_BYTES)
      throw new CliExit(4, "The build is bigger than 50 MB, the most a share link holds.");
    const name = Buffer.from(file, "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(name.length);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    parts.push(head, name, size, data);
  }
  return Buffer.concat(parts);
}

const DEFAULT_STUDIO = "https://studio.threenative.com";
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

export function studioOrigin(studio = process.env.THREENATIVE_STUDIO): string {
  return (studio ?? DEFAULT_STUDIO).replace(/\/+$/u, "");
}

/** The agent pnpm/yarn/npm/bun started this CLI, so `build:web` runs with the game's own lockfile. */
function packageManager(): string {
  const name = (process.env.npm_config_user_agent ?? "").split("/")[0] ?? "";
  return PACKAGE_MANAGERS.includes(name as (typeof PACKAGE_MANAGERS)[number]) ? name : "npm";
}

async function runBuildScript(cwd: string): Promise<void> {
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(packageManager(), ["run", "build:web"], {
      cwd,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new CliExit(4, "build:web failed.");
}

interface IProjectManifest {
  name?: string;
  scripts?: Record<string, string>;
}

interface IShareFile {
  /** 36-char UUID sent as `key` on the first deploy, so a lost reply retries onto one game. */
  deployKey?: string;
  projectId?: string;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeShareFile(file: string, share: IShareFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(share, null, 2)}\n`);
}

export interface IDeployOptions {
  cwd?: string;
  out?: (line: string) => void;
  runBuild?: (cwd: string) => Promise<void>;
  studio?: string;
  token?: string;
}

export interface IDeployResult {
  projectId: string;
  shareUrl: string;
}

export async function deploy(options: IDeployOptions = {}): Promise<IDeployResult> {
  const cwd = options.cwd ?? process.cwd();
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const studio = studioOrigin(options.studio);
  const token = options.token ?? (await requireToken());

  const manifest = await readJson<IProjectManifest>(path.join(cwd, "package.json"));
  if (manifest === undefined)
    throw new CliExit(2, "No package.json here. Run threenative deploy inside a game.");
  if (manifest.scripts?.["build:web"] === undefined)
    throw new CliExit(2, "package.json has no build:web script.");
  if (manifest.name === undefined || manifest.name === "")
    throw new CliExit(2, "package.json has no name.");

  await (options.runBuild ?? runBuildScript)(cwd);
  const archive = await packDirectory(path.join(cwd, "dist")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
      throw new CliExit(4, "The build wrote no dist/ folder.");
    throw error;
  });

  const sharePath = path.join(cwd, ".threenative", "share.json");
  const previous = await readJson<IShareFile>(sharePath);
  const previousProject = typeof previous?.projectId === "string" ? previous.projectId : "";
  const previousKey =
    typeof previous?.deployKey === "string" && previous.deployKey !== ""
      ? previous.deployKey
      : undefined;
  const query = new URLSearchParams({ name: manifest.name });
  // Later deploys name the game they already own. A first deploy has no id yet, so it sends a key
  // Studio can recognize the game by instead — written to share.json before the upload, so a reply
  // lost on the way back still lands on that same game when this command runs again.
  let deployKey = previousKey;
  if (previousProject !== "") {
    query.set("projectId", previousProject);
  } else {
    if (deployKey === undefined) {
      deployKey = randomUUID();
      await writeShareFile(sharePath, { deployKey });
    }
    query.set("key", deployKey);
  }

  const reply = await request(studio, `/api/cli/share?${query.toString()}`, {
    // fetch's BodyInit wants a plain view, not Node's Buffer subclass.
    body: new Uint8Array(archive),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
    },
    method: "PUT",
  });
  if (reply.status === 401)
    throw new CliExit(
      3,
      `${serverMessage(reply.body, "This machine's token was refused.")} Run threenative login.`,
    );
  if (reply.status < 200 || reply.status >= 300)
    throw new CliExit(
      4,
      serverMessage(
        reply.body,
        reply.statusText === ""
          ? `The server refused the upload (${reply.status}).`
          : reply.statusText,
      ),
    );

  const result = reply.body as { projectId?: unknown; shareUrl?: unknown };
  const savedProject = typeof result?.projectId === "string" ? result.projectId : "";
  const shareUrl = typeof result?.shareUrl === "string" ? result.shareUrl : "";
  if (shareUrl === "") throw new CliExit(4, "The server returned no share link.");
  const saved: IShareFile = {};
  if (savedProject !== "") saved.projectId = savedProject;
  if (deployKey !== undefined) saved.deployKey = deployKey;
  if (previous?.projectId !== saved.projectId || previous?.deployKey !== saved.deployKey)
    await writeShareFile(sharePath, saved);
  // The link alone, last: an agent parses this line, not the prose above it.
  out(shareUrl);
  return { projectId: savedProject, shareUrl };
}
