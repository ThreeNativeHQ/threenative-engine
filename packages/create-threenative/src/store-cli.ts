/** `threenative deploy --target desktop`: publish the game's source to the ThreeNative store with
 * `tn-store`, the same client Studio runs. The store builds the native game itself, so this file
 * only fetches a checked copy of that client, creates the listing once and pushes. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CliExit, request, serverMessage, siteOrigin } from "./account.js";
import { loadConfig } from "./config.js";

/** Studio's listing defaults (`publish.ts`): a person edits genre and text on the shelf later.
 * The store wants a play address before the game has an id, so its own entry point stands in. */
const STORE_GENRE = "Game";
const STORE_PLAY_URL = "https://store.threenative.com/";
const STORE_FILE = path.join(".threenative", "store.json");

export interface IStoreDeployOptions {
  cwd: string;
  out: (line: string) => void;
  shot?: string;
  site?: string;
  token: string;
}

interface ICliManifest {
  files?: ({ name?: unknown; os?: unknown; sha256?: unknown } | null)[];
  version?: unknown;
}

function cacheHome(env: NodeJS.ProcessEnv): string {
  if (env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== "") return env.XDG_CACHE_HOME;
  if (process.platform === "win32" && env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA !== "")
    return env.LOCALAPPDATA;
  return path.join(homedir(), ".cache");
}

/** The store ships x64 Linux and Windows clients only (`DECISIONS.md` row 9: no macOS store build). */
function storeOs(): "linux" | "windows" {
  if (process.platform === "darwin")
    throw new CliExit(
      2,
      "The store has no macOS build, so a native game cannot be published from this machine.",
    );
  if ((process.platform !== "linux" && process.platform !== "win32") || process.arch !== "x64")
    throw new CliExit(
      2,
      `The store ships tn-store for x64 Linux and Windows only, not ${process.platform} ${process.arch}. Set THREENATIVE_STORE_CLI to a tn-store built for this machine.`,
    );
  return process.platform === "linux" ? "linux" : "windows";
}

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The client entry for this OS, or exit 4 when `cli.json` is not the shape the release job writes
 * (a captive-portal page and an empty body both reach here with status 200). */
function clientEntry(body: unknown, os: string): { name: string; sha256: string; version: string } {
  const manifest = body as ICliManifest | null | undefined;
  const files = typeof manifest === "object" && manifest !== null ? manifest.files : undefined;
  const file = Array.isArray(files)
    ? files.find((entry) => typeof entry === "object" && entry !== null && entry.os === os)
    : undefined;
  const version = typeof manifest?.version === "string" ? manifest.version : "";
  if (
    typeof file?.name !== "string" ||
    file.name === "" ||
    typeof file.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(file.sha256) ||
    !/^[A-Za-z0-9._-]+$/u.test(version)
  )
    throw new CliExit(4, `cli.json lists no usable tn-store for ${os}.`);
  return { name: file.name, sha256: file.sha256, version };
}

/** Is this path already a regular file holding exactly the bytes `cli.json` promises? A cached file
 * runs with the push token in its environment, so it earns the same check as a fresh download. */
async function cacheIsGood(target: string, sha256: string): Promise<boolean> {
  try {
    if (!(await lstat(target)).isFile()) return false;
    return sha256Of(await readFile(target)) === sha256;
  } catch {
    return false;
  }
}

async function download(site: string, name: string, sha256: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    const response = await fetch(`${site}/launcher/cli/${encodeURIComponent(name)}`);
    if (!response.ok) throw new CliExit(4, `Downloading ${name} answered ${response.status}.`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof CliExit) throw error;
    throw new CliExit(
      5,
      `Could not reach ${site}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const actual = sha256Of(bytes);
  if (actual !== sha256)
    throw new CliExit(
      4,
      `tn-store failed its checksum (expected ${sha256}, got ${actual}). Nothing was run.`,
    );
  return bytes;
}

/** Writes beside and renames over, so a crash never leaves a half-written file at `file`. */
async function writeAtomic(file: string, data: string | Buffer, mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** The `tn-store` for this OS: a cached copy whose sha256 matches `cli.json`, else a fresh download
 * that is checked (exit 4 on a mismatch) and cached. */
async function fetchStoreCli(site: string, env: NodeJS.ProcessEnv): Promise<string> {
  const os = storeOs();
  const manifestReply = await request(site, "/launcher/cli/cli.json");
  if (manifestReply.status !== 200)
    throw new CliExit(
      4,
      serverMessage(
        manifestReply.body,
        `${site} publishes no store client (cli.json answered ${manifestReply.status}).`,
      ),
    );
  const { name, sha256, version } = clientEntry(manifestReply.body, os);
  const target = path.join(
    cacheHome(env),
    "threenative",
    "bin",
    `tn-store-${version}${os === "windows" ? ".exe" : ""}`,
  );
  if (await cacheIsGood(target, sha256)) return target;
  const bytes = await download(site, name, sha256);
  // A directory or a bad file in the way is replaced; rename only overwrites a file.
  await rm(target, { force: true, recursive: true });
  await writeAtomic(target, bytes, 0o755);
  return target;
}

/** One `tn-store` call. The push token goes in the child's environment, never in argv, where `ps`
 * and crash dumps would show it. Its exit codes (2 arguments, 3 sign in, 4 refused, 5 network)
 * are the ones this CLI uses, so they pass through. */
function runStore(
  bin: string,
  args: readonly string[],
  options: IStoreDeployOptions,
  site: string,
): Promise<string> {
  // The token and the site travel in the child's environment, never in argv.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.TN_SITE_ORIGIN = site;
  env.TN_STORE_TOKEN = options.token;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error) =>
      reject(new CliExit(4, `Could not run tn-store: ${error.message}`)),
    );
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else
        reject(
          new CliExit(
            code !== null && code >= 2 && code <= 5 ? code : 4,
            `tn-store ${args[0] ?? ""} failed.`,
          ),
        );
    });
  });
}

function parseObject(stdout: string, what: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Falls through to the error below.
  }
  throw new CliExit(4, `tn-store ${what} printed no JSON object.`);
}

async function storedGameId(cwd: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(cwd, STORE_FILE), "utf8");
  } catch (error) {
    // Only a missing file means "not listed yet"; a permission or I/O error must not start a second listing.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliExit(
      2,
      `Could not read ${STORE_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A file that is there but not a listing must stop the deploy: creating a second listing over a
  // truncated or conflicted store.json would orphan the first one.
  try {
    const parsed = JSON.parse(text) as { gameId?: unknown };
    if (typeof parsed.gameId === "string" && parsed.gameId !== "") return parsed.gameId;
  } catch {
    // Reported below with the rest.
  }
  throw new CliExit(2, `${STORE_FILE} holds no game id; fix or delete it.`);
}

/** First deploy: lists the game, then remembers its id in the file Studio reads too. */
async function createListing(
  bin: string,
  name: string,
  shot: string,
  options: IStoreDeployOptions,
  site: string,
): Promise<string> {
  options.out(`Listing ${name} on the store.`);
  const args = [
    "games",
    "create",
    "--name",
    name,
    "--genre",
    STORE_GENRE,
    "--description",
    `${name}, made with ThreeNative.`,
    "--platform",
    "Desktop",
    "--play-url",
    STORE_PLAY_URL,
    "--shot",
    shot,
    "--json",
  ];
  const created = parseObject(await runStore(bin, args, options, site), "games create");
  if (typeof created.gameId !== "string" || created.gameId === "")
    throw new CliExit(4, "The store did not return a game id. Nothing was published.");
  await writeAtomic(
    path.join(options.cwd, STORE_FILE),
    `${JSON.stringify({ gameId: created.gameId }, null, 2)}\n`,
  );
  return created.gameId;
}

/** The page is /games/<slug>/; the owner's own listing carries the slug even before it is live. */
async function storePageUrl(
  bin: string,
  gameId: string,
  options: IStoreDeployOptions,
  site: string,
): Promise<string> {
  let slug: unknown;
  try {
    slug = parseObject(
      await runStore(bin, ["games", "show", gameId, "--json"], options, site),
      "games show",
    ).slug;
  } catch {
    // The deploy worked; only the link falls back to the id form the site redirects.
  }
  return typeof slug === "string" && slug !== ""
    ? `${site}/games/${encodeURIComponent(slug)}/`
    : `${site}/games/game/?id=${encodeURIComponent(gameId)}`;
}

/** package.json first; a game with none (Midway) uses `app.version`, the version the native app is
 * built with, so the release label matches what the player reports. Without either, the config
 * loader supplies its own default. */
async function releaseVersion(fromPackage: unknown, cwd: string): Promise<string> {
  let version = typeof fromPackage === "string" ? fromPackage : "";
  if (version === "")
    version = await loadConfig(cwd).then(
      (config) => config.app.version,
      (error: unknown) => {
        throw new CliExit(
          2,
          `No package.json version, and threenative.config.ts did not load: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  if (!/^[\x20-\x7e]{1,40}$/u.test(version))
    throw new CliExit(2, "The release version must be 1 to 40 printable ASCII characters.");
  return version;
}

export async function deployDesktop(
  manifest: { name: string; version?: unknown },
  options: IStoreDeployOptions,
): Promise<{ gameId: string; url: string }> {
  const env = process.env;
  const site = siteOrigin(options.site);
  const version = await releaseVersion(manifest.version, options.cwd);

  let gameId = await storedGameId(options.cwd);
  // The store refuses a listing with no picture, so ask before downloading anything.
  if (gameId === undefined && (options.shot === undefined || options.shot === ""))
    throw new CliExit(2, "The first native deploy needs a cover picture: add --shot <png>.");
  const shot = options.shot === undefined ? undefined : path.resolve(options.cwd, options.shot);
  if (
    shot !== undefined &&
    gameId === undefined &&
    !(await stat(shot).then(
      (s) => s.isFile(),
      () => false,
    ))
  )
    throw new CliExit(2, `--shot ${options.shot} is not a file.`);

  const override = env.THREENATIVE_STORE_CLI;
  const bin = override !== undefined && override !== "" ? override : await fetchStoreCli(site, env);

  if (gameId === undefined && shot !== undefined)
    gameId = await createListing(bin, manifest.name, shot, options, site);
  if (gameId === undefined) throw new CliExit(4, "No game id.");

  const pushed = parseObject(
    await runStore(bin, ["push", gameId, "--version", version, "--json"], options, site),
    "push",
  );
  const reason =
    typeof pushed.reason === "string" && pushed.reason !== "" ? ` (${pushed.reason})` : "";
  options.out(
    `Pushed ${String(pushed.files)} files, ${String(pushed.uploaded)} of ${String(pushed.chunks)} chunks uploaded.`,
  );
  options.out(`Release ${String(pushed.release)}${reason}.`);

  const url = await storePageUrl(bin, gameId, options, site);
  // The link alone, last: an agent parses this line, not the prose above it.
  options.out(url);
  return { gameId, url };
}
