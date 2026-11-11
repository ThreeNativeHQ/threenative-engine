import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

// PRD-827 AC-4: engine_watch_reference fetches the released watcher, runs it, and returns the
// contact sheet, the frames and watch.json. The stub watcher writes what the real one writes
// (`watch.json`, `sheet.jpg`, `frames/*.jpg`) into its `--out` folder and echoes its arguments.
const STUB_WATCHER = `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
mkdirSync(path.join(out, "frames"), { recursive: true });
writeFileSync(path.join(out, "frames", "f00-0012.00.jpg"), "jpg");
writeFileSync(path.join(out, "sheet.jpg"), "jpg");
writeFileSync(path.join(out, "watch.json"), JSON.stringify({
  version: 1, query: args[0], args,
  frames: [{ index: 0, at: 12, path: "frames/f00-0012.00.jpg" }], sheet: "sheet.jpg",
}));
console.log("look: " + path.join(out, "sheet.jpg"));
`;

let server: Server;
let baseUrl: string;
let bin: string;
let serveWatcher = true;
let watcherSource = STUB_WATCHER;
let tmp: string;

async function call(args: unknown) {
  const { handleLine } = await import("../src/index.js");
  const response = JSON.parse(
    (await handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "engine_watch_reference", arguments: args },
      }),
      path.resolve("packages/core/capabilities.json"),
    )) ?? "",
  );
  if (response.error) throw new Error(response.error.message);
  return JSON.parse(response.result.content[0].text);
}

function fakeTool(name: string): void {
  const file = path.join(bin, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}

beforeEach(async () => {
  vi.resetModules();
  serveWatcher = true;
  watcherSource = STUB_WATCHER;
  bin = makeTempDirSync("watch-bin-");
  // The watch folder is returned to the caller, so it lands in a registered test folder.
  tmp = makeTempDirSync("watch-tmp-");
  vi.stubEnv("TMPDIR", tmp);
  // HOME is replaced so the `~/.local/bin` lookup cannot find this host's own yt-dlp.
  vi.stubEnv("HOME", makeTempDirSync("watch-home-"));
  vi.stubEnv("PATH", bin);
  vi.stubEnv("THREENATIVE_REFERENCES_CACHE", makeTempDirSync("watch-cache-"));
  vi.stubEnv("THREENATIVE_ENGINE_MCP_LOG", "off");
  server = createServer((req, res) => {
    if (req.url === "/watch.mjs" && serveWatcher) res.end(watcherSource);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP address");
  baseUrl = `http://127.0.0.1:${address.port}/`;
  vi.stubEnv("THREENATIVE_REFERENCES_URL", baseUrl);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

describe("engine_watch_reference", () => {
  it("is a served engine tool", async () => {
    const { ENGINE_MCP_TOOL_NAMES, toolDefinitions } = await import("../src/index.js");
    expect(ENGINE_MCP_TOOL_NAMES).toContain("engine_watch_reference");
    expect(toolDefinitions().map((tool) => tool.name)).toContain("engine_watch_reference");
  });

  it("runs the released watcher and returns the sheet, the frames and watch.json", async () => {
    fakeTool("yt-dlp");
    fakeTool("ffmpeg");
    const result = await call({
      query: "super mario 64 triple jump",
      duration: 25,
      frames: 6,
      from: "20%",
      pick: 1,
    });
    expect(path.basename(result.sheet)).toBe("sheet.jpg");
    expect(existsSync(result.sheet)).toBe(true);
    expect(result.frames).toHaveLength(1);
    expect(existsSync(result.frames[0])).toBe(true);
    expect(result.watch.query).toBe("super mario 64 triple jump");
    expect(result.watch.args).toEqual(
      expect.arrayContaining(["--duration", "25", "--frames", "6", "--from", "20%", "--pick", "1"]),
    );
    // Frames are someone else's footage: they stay in tmp, never in the game folder.
    expect(result.sheet.startsWith(process.cwd())).toBe(false);
  });

  it("fails closed with the install command when yt-dlp or ffmpeg is missing", async () => {
    fakeTool("ffmpeg");
    await expect(call({ query: "sm64 long jump" })).rejects.toThrow(/yt-dlp.*pipx install yt-dlp/u);
    bin = makeTempDirSync("watch-ytdlp-only-");
    fakeTool("yt-dlp");
    vi.stubEnv("PATH", bin);
    await expect(call({ query: "sm64 long jump" })).rejects.toThrow(/ffmpeg.*install/u);
  });

  it("fails closed with the URL when the watcher cannot be fetched", async () => {
    fakeTool("yt-dlp");
    fakeTool("ffmpeg");
    serveWatcher = false;
    await expect(call({ query: "sm64 long jump" })).rejects.toThrow(
      new RegExp(`TN_WATCH_UNAVAILABLE.*${baseUrl.replaceAll(".", "\\.")}watch\\.mjs`, "u"),
    );
  });

  it("removes its frame folder when the watcher fails", async () => {
    fakeTool("yt-dlp");
    fakeTool("ffmpeg");
    watcherSource = `console.error("no video found"); process.exit(1);`;
    await expect(call({ query: "sm64 long jump" })).rejects.toThrow(
      /TN_WATCH_FAILED.*no video found/u,
    );
    expect(readdirSync(tmp).filter((name) => name.startsWith("threenative-watch-"))).toEqual([]);
  });

  it("rejects a call with no query", async () => {
    await expect(call({})).rejects.toThrow(/query/u);
  });
});
