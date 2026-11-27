/** `threenative deploy --target desktop`: publish the game's source to the ThreeNative store with
 * `tn-store`, the same client Studio runs. The store builds the native game itself, so this file
 * only fetches a checked copy of that client, creates the listing once and pushes. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CliExit, request, serverMessage, siteOrigin } from "./account.js";

/** Studio's listing defaults (`publish.ts`): a person edits genre and text on the shelf later.
 * The store wants a play address before the game has an id, so its own entry point stands in. */
const STORE_GENRE = "Game";
const STORE_PLAY_URL = "https://store.threenative.com/";
const STORE_FILE = path.join(".threenative", "store.json");
/** No `version` in package.json (Midway has none): the release still needs one label. */
export const DEFAULT_VERSION = "0.0.0";

export interface IStoreDeployOptions {
  cwd: string;
  out: (line: string) => void;
  shot?: string;
  site?: string;
  token: string;
}

interface ICliManifest {
  files?: { name?: unknown; os?: unknown; sha256?: unknown }[];
  version?: unknown;
}

function cacheHome(env: NodeJS.ProcessEnv): string {
  if (env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== "") return env.XDG_CACHE_HOME;
  if (process.platform === "win32") return env.LOCALAPPDATA ?? path.join(homedir(), ".cache");
  return path.join(homedir(), ".cache");
}

/** The store ships Linux and Windows clients only (`DECISIONS.md` row 9: no macOS store build). */
function storeOs(): "linux" | "windows" {
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  throw new CliExit(
    2,
    "The store has no macOS build, so a native game cannot be published from this machine.",
  );
}

/** Downloads the `tn-store` for this OS once, refuses a wrong sha256 (exit 4) and caches it. */
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
  const manifest = manifestReply.body as ICliManifest;
  const file = manifest.files?.find((entry) => entry.os === os);
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (
    typeof file?.name !== "string" ||
    typeof file.sha256 !== "string" ||
    !/^[A-Za-z0-9._-]+$/u.test(version)
  )
    throw new CliExit(4, `cli.json lists no usable tn-store for ${os}.`);
  const target = path.join(
    cacheHome(env),
    "threenative",
    "bin",
    `tn-store-${version}${os === "windows" ? ".exe" : ""}`,
  );
  if (
    await stat(target).then(
      () => true,
      () => false,
    )
  )
    return target;

  let bytes: Buffer;
  try {
    const response = await fetch(`${site}/launcher/cli/${encodeURIComponent(file.name)}`);
    if (!response.ok) throw new CliExit(4, `Downloading ${file.name} answered ${response.status}.`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof CliExit) throw error;
    throw new CliExit(
      5,
      `Could not reach ${site}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== file.sha256)
    throw new CliExit(
      4,
      `tn-store failed its checksum (expected ${file.sha256}, got ${actual}). Nothing was run.`,
    );
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, bytes, { mode: 0o755 });
    await chmod(tmp, 0o755);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
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
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", (error) =>
      reject(new CliExit(4, `Could not run tn-store: ${error.message}`)),
    );
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
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
    if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Falls through to the error below.
  }
  throw new CliExit(4, `tn-store ${what} printed no JSON object.`);
}

async function storedGameId(cwd: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(cwd, STORE_FILE), "utf8")) as {
      gameId?: unknown;
    };
    return typeof parsed.gameId === "string" && parsed.gameId !== "" ? parsed.gameId : undefined;
  } catch {
    // No file, or one that does not parse: not a listing, the next deploy creates one.
    return undefined;
  }
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
  await mkdir(path.join(options.cwd, ".threenative"), { recursive: true });
  await writeFile(
    path.join(options.cwd, STORE_FILE),
    `${JSON.stringify({ gameId: created.gameId }, null, 2)}\n`,
  );
  return created.gameId;
}

export async function deployDesktop(
  manifest: { name: string; version?: unknown },
  options: IStoreDeployOptions,
): Promise<{ gameId: string; url: string }> {
  const env = process.env;
  const site = siteOrigin(options.site);
  const version =
    typeof manifest.version === "string" && manifest.version !== ""
      ? manifest.version
      : DEFAULT_VERSION;
  if (!/^[\x20-\x7e]{1,40}$/u.test(version))
    throw new CliExit(2, "package.json version must be 1 to 40 printable ASCII characters.");

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

  // The page is /games/<slug>/; the owner's own listing carries the slug even before it is live.
  let slug: unknown;
  try {
    slug = parseObject(
      await runStore(bin, ["games", "show", gameId, "--json"], options, site),
      "games show",
    ).slug;
  } catch {
    // The deploy worked; only the link falls back to the id form the site redirects.
  }
  const url =
    typeof slug === "string" && slug !== ""
      ? `${site}/games/${slug}/`
      : `${site}/games/game/?id=${encodeURIComponent(gameId)}`;
  // The link alone, last: an agent parses this line, not the prose above it.
  options.out(url);
  return { gameId, url };
}
