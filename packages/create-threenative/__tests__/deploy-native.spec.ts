import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { CliExit } from "../src/account.js";
import { deploy, parseDeployArgs } from "../src/deploy.js";

/** A `tn-store` stand-in: logs argv and the token env var, then answers like the real `--json` calls. */
const FAKE_STORE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, token: process.env.TN_STORE_TOKEN, site: process.env.TN_SITE_ORIGIN }) + "\\n");
if (process.env.FAKE_FAIL === args[0]) { console.error("refused"); process.exit(Number(process.env.FAKE_CODE)); }
if (args[0] === "games" && args[1] === "create") console.log(JSON.stringify({ gameId: "g1", name: "game" }));
else if (args[0] === "push") console.log(JSON.stringify({ files: 3, chunks: 2, uploaded: 1, snapshotId: "s", release: "building", reason: null }));
else if (args[0] === "games" && args[1] === "show") console.log(JSON.stringify({ id: "g1", slug: "my-game" }));
`;

const posix = process.platform === "linux" || process.platform === "darwin";

async function fakeStoreFile(): Promise<{ bin: string; log: string; dir: string }> {
  const dir = await makeTempDir("tn-fake-store-");
  const bin = path.join(dir, "tn-store");
  await writeFile(bin, FAKE_STORE);
  await chmod(bin, 0o755);
  return { bin, dir, log: path.join(dir, "log.jsonl") };
}

async function game(extra: Record<string, unknown> = {}): Promise<string> {
  const cwd = await makeTempDir("tn-native-");
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "game", ...extra }));
  await writeFile(path.join(cwd, "cover.png"), "png");
  return cwd;
}

async function calls(log: string): Promise<{ args: string[]; token: string; site: string }[]> {
  return (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function failureOf(run: Promise<unknown>): Promise<CliExit> {
  const failure = await run.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(CliExit);
  return failure as CliExit;
}

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!posix)("threenative deploy --target desktop", () => {
  it("creates the listing once, then pushes onto the same game", async () => {
    const store = await fakeStoreFile();
    vi.stubEnv("THREENATIVE_STORE_CLI", store.bin);
    vi.stubEnv("FAKE_LOG", store.log);
    const cwd = await game({ version: "1.2.3" });
    const lines: string[] = [];
    const options = {
      cwd,
      out: (l: string) => lines.push(l),
      site: "http://site.test",
      target: "desktop" as const,
      token: "secret-token",
    };

    const first = await deploy({ ...options, shot: "cover.png" });
    expect(first).toEqual({ projectId: "g1", shareUrl: "http://site.test/games/my-game/" });
    expect(lines.at(-1)).toBe("http://site.test/games/my-game/");
    expect(
      JSON.parse(await readFile(path.join(cwd, ".threenative", "store.json"), "utf8")),
    ).toEqual({ gameId: "g1" });

    await deploy(options); // second run needs no --shot
    const all = await calls(store.log);
    expect(all.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "games create",
      "push g1",
      "games show",
      "push g1",
      "games show",
    ]);
    expect(all[1]?.args).toEqual(["push", "g1", "--version", "1.2.3", "--json"]);
    // The token reaches the child through its environment only.
    expect(all.every((c) => c.token === "secret-token" && !c.args.includes("secret-token"))).toBe(
      true,
    );
    expect(all[0]?.site).toBe("http://site.test");
  });

  it("exits 2 naming --shot on a first deploy, and takes a missing version from app.version", async () => {
    const store = await fakeStoreFile();
    vi.stubEnv("THREENATIVE_STORE_CLI", store.bin);
    vi.stubEnv("FAKE_LOG", store.log);
    const cwd = await game();
    await writeFile(
      path.join(cwd, "threenative.config.ts"),
      'export default { app: { version: "4.5.6" } };\n',
    );
    const base = {
      cwd,
      out: () => {},
      site: "http://site.test",
      target: "desktop" as const,
      token: "t",
    };
    const missing = await failureOf(deploy(base));
    expect(missing.code).toBe(2);
    expect(missing.message).toContain("--shot");
    await deploy({ ...base, shot: "cover.png" });
    expect((await calls(store.log))[1]?.args).toContain("4.5.6");
  });

  it("passes the store's own exit codes through", async () => {
    const store = await fakeStoreFile();
    vi.stubEnv("THREENATIVE_STORE_CLI", store.bin);
    vi.stubEnv("FAKE_LOG", store.log);
    vi.stubEnv("FAKE_FAIL", "push");
    vi.stubEnv("FAKE_CODE", "3");
    const cwd = await game();
    const failure = await failureOf(
      deploy({ cwd, out: () => {}, shot: "cover.png", target: "desktop", token: "t" }),
    );
    expect(failure.code).toBe(3);
  });

  it("stops on a store.json that holds no game id instead of listing the game again", async () => {
    const store = await fakeStoreFile();
    vi.stubEnv("THREENATIVE_STORE_CLI", store.bin);
    vi.stubEnv("FAKE_LOG", store.log);
    const cwd = await game();
    await mkdir(path.join(cwd, ".threenative"));
    await writeFile(path.join(cwd, ".threenative", "store.json"), "<<<<<<< HEAD\n");
    const failure = await failureOf(
      deploy({ cwd, out: () => {}, shot: "cover.png", target: "desktop", token: "t" }),
    );
    expect(failure.code).toBe(2);
    await expect(readFile(store.log, "utf8")).rejects.toThrow();
  });
});

describe.skipIf(process.platform !== "linux")("tn-store download", () => {
  async function fakeSite(bytes: Buffer, sha256: string, cliJson?: string) {
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url ?? "");
      if (request.url === "/launcher/cli/cli.json") {
        response.setHeader("content-type", "application/json");
        response.end(
          cliJson ??
            JSON.stringify({
              version: "0.1.0",
              files: [{ os: "linux", name: "tn-store-linux", size: bytes.length, sha256 }],
            }),
        );
      } else if (
        request.url === "/launcher/cli/tn-store-linux" ||
        request.url === "/launcher/cli/tn-store-win.exe"
      )
        response.end(bytes);
      else {
        response.statusCode = 404;
        response.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    return {
      hits,
      origin,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  }

  it("downloads once, caches mode 0755, and refuses a wrong sha256 with exit 4", async () => {
    const store = await fakeStoreFile();
    const bytes = Buffer.from(FAKE_STORE);
    const cache = await makeTempDir("tn-cache-");
    vi.stubEnv("XDG_CACHE_HOME", cache);
    vi.stubEnv("FAKE_LOG", store.log);
    const cwd = await game();
    const good = await fakeSite(bytes, createHash("sha256").update(bytes).digest("hex"));
    try {
      const options = {
        cwd,
        out: () => {},
        shot: "cover.png",
        site: good.origin,
        target: "desktop" as const,
        token: "t",
      };
      await deploy(options);
      await deploy(options);
      const cached = path.join(cache, "threenative", "bin", "tn-store-0.1.0");
      expect((await stat(cached)).mode & 0o777).toBe(0o755);
      expect(good.hits.filter((url) => url.endsWith("tn-store-linux"))).toHaveLength(1);
    } finally {
      good.close();
    }

    const badCache = await makeTempDir("tn-cache-");
    vi.stubEnv("XDG_CACHE_HOME", badCache);
    const bad = await fakeSite(bytes, "0".repeat(64));
    try {
      const failure = await failureOf(
        deploy({
          cwd: await game(),
          out: () => {},
          shot: "cover.png",
          site: bad.origin,
          target: "desktop",
          token: "t",
        }),
      );
      expect(failure.code).toBe(4);
      expect(failure.message).toContain("checksum");
      await expect(readdir(path.join(badCache, "threenative", "bin"))).rejects.toThrow();
    } finally {
      bad.close();
    }
  });

  it("never runs a cached tn-store whose hash is not the one cli.json names", async () => {
    const store = await fakeStoreFile();
    const bytes = Buffer.from(FAKE_STORE);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const cache = await makeTempDir("tn-cache-");
    const marker = path.join(cache, "tampered-ran");
    const cached = path.join(cache, "threenative", "bin", "tn-store-0.1.0");
    await mkdir(path.dirname(cached), { recursive: true });
    await writeFile(
      cached,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("XDG_CACHE_HOME", cache);
    vi.stubEnv("FAKE_LOG", store.log);
    const site = await fakeSite(bytes, sha);
    try {
      await deploy({
        cwd: await game(),
        out: () => {},
        shot: "cover.png",
        site: site.origin,
        target: "desktop",
        token: "t",
      });
      await expect(stat(marker)).rejects.toThrow();
      expect(
        createHash("sha256")
          .update(await readFile(cached))
          .digest("hex"),
      ).toBe(sha);
      expect((await calls(store.log)).length).toBeGreaterThan(0);
    } finally {
      site.close();
    }
  });

  it("exits 4, not a TypeError, when cli.json is not the release job's shape", async () => {
    const bytes = Buffer.from(FAKE_STORE);
    const good = createHash("sha256").update(bytes).digest("hex");
    const bodies = [
      "",
      "null",
      "<html>sign in to the wifi</html>",
      '{"version":"0.1.0","files":{}}',
      '{"version":"0.1.0","files":[null]}',
      `{"version":"0.1.0","files":[{"os":"linux","name":"tn-store-linux","sha256":"${good.toUpperCase()}"}]}`,
    ];
    for (const body of bodies) {
      vi.stubEnv("XDG_CACHE_HOME", await makeTempDir("tn-cache-"));
      const site = await fakeSite(bytes, good, body);
      try {
        const failure = await failureOf(
          deploy({
            cwd: await game(),
            out: () => {},
            shot: "cover.png",
            site: site.origin,
            target: "desktop",
            token: "t",
          }),
        );
        expect(failure.code, body).toBe(4);
      } finally {
        site.close();
      }
    }
  });

  /** The platform and arch the CLI sees, faked the way engine-desktop.spec.ts fakes win32. */
  async function asPlatform(platform: string, arch: string, run: () => Promise<void>) {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    Object.defineProperty(process, "arch", { configurable: true, value: arch });
    try {
      await run();
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
      if (originalArch) Object.defineProperty(process, "arch", originalArch);
    }
  }

  it("on win32 x64 picks the windows file, caches it as .exe under LOCALAPPDATA, token in env", async () => {
    const store = await fakeStoreFile();
    const bytes = Buffer.from(FAKE_STORE);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const localAppData = await makeTempDir("tn-localappdata-");
    vi.stubEnv("XDG_CACHE_HOME", "");
    vi.stubEnv("LOCALAPPDATA", localAppData);
    vi.stubEnv("FAKE_LOG", store.log);
    // The linux entry carries a wrong hash: choosing it would exit 4.
    const site = await fakeSite(
      bytes,
      sha,
      JSON.stringify({
        version: "0.2.0",
        files: [
          { os: "linux", name: "tn-store-linux", sha256: "0".repeat(64) },
          { os: "windows", name: "tn-store-win.exe", sha256: sha },
        ],
      }),
    );
    try {
      await asPlatform("win32", "x64", async () => {
        await deploy({
          cwd: await game(),
          out: () => {},
          shot: "cover.png",
          site: site.origin,
          target: "desktop",
          token: "win-token",
        });
      });
      expect(site.hits).toContain("/launcher/cli/tn-store-win.exe");
      expect(site.hits).not.toContain("/launcher/cli/tn-store-linux");
      const cached = path.join(localAppData, "threenative", "bin", "tn-store-0.2.0.exe");
      expect((await stat(cached)).isFile()).toBe(true);
      const all = await calls(store.log);
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((c) => c.token === "win-token" && !c.args.includes("win-token"))).toBe(true);
    } finally {
      site.close();
    }
  });

  it("on arm64 exits 2 and downloads nothing", async () => {
    const site = await fakeSite(Buffer.from(FAKE_STORE), "0".repeat(64));
    try {
      await asPlatform("linux", "arm64", async () => {
        const failure = await failureOf(
          deploy({
            cwd: await game(),
            out: () => {},
            shot: "cover.png",
            site: site.origin,
            target: "desktop",
            token: "t",
          }),
        );
        expect(failure.code).toBe(2);
        expect(failure.message).toContain("arm64");
      });
      expect(site.hits).toEqual([]);
    } finally {
      site.close();
    }
  });
});

describe("deploy arguments", () => {
  it("parses --target and --shot, and refuses the rest with exit 2", () => {
    expect(parseDeployArgs(["--target", "desktop", "--shot", "a.png"])).toEqual({
      shot: "a.png",
      target: "desktop",
    });
    expect(parseDeployArgs([])).toEqual({});
    for (const bad of [["--shot", "a.png"], ["--target", "mac"], ["--wat"], ["--shot"]]) {
      expect(() => parseDeployArgs(bad)).toThrowError(CliExit);
    }
  });
});
