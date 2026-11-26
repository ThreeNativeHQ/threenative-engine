// The Dev Dashboard's server half (PRD-918, PRD-923): live config edits, the machine-local sharing
// consent, the trace scrubber and both upload gates, procedural GLB checks, health and playtests.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardApi } from "../src/dashboard/api.js";
import {
  ConfigEditError,
  applyConfigChanges,
  patchConfig,
} from "../src/dashboard/config-editor.js";
import { assetCook } from "../src/dashboard/health.js";
import { PlaytestRunner, listScenarios, scenarioPath } from "../src/dashboard/playtest-runner.js";
import {
  procedurallyExcluded,
  shareProcedural,
  validateGlb,
} from "../src/dashboard/procedural-share.js";
import {
  modelFamily,
  residualFinding,
  scrubText,
  scrubTrace,
} from "../src/dashboard/scrub-trace.js";
import { readPrefs, writePrefs } from "../src/dashboard/telemetry-prefs.js";
import { discoverTraces, shareTraces } from "../src/dashboard/trace-collector.js";

let dir: string;
let root: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tn-dashboard-"));
  root = path.join(dir, "game");
  home = path.join(dir, "home");
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fox", version: "0.1.0" }),
  );
  vi.stubEnv("XDG_CONFIG_HOME", path.join(dir, "xdg"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const CONFIG = `import type { IThreeNativeConfig } from "@threenative/core";

// The studio's own note stays.
const config: IThreeNativeConfig = {
  app: { name: "Fox" }, // keep this comment
  renderer: { preferWebGPU: true },
};

export default config;
`;

describe("config editor", () => {
  it("edits values in place, inserts nested keys and removes a key, keeping comments", async () => {
    const next = await applyConfigChanges(CONFIG, {
      "app.name": "Fox Two",
      "display.maxFps": 120,
      "renderer.preferWebGPU": null,
    });
    expect(next).toContain("// The studio's own note stays.");
    expect(next).toContain('name: "Fox Two"');
    expect(next).toContain("// keep this comment");
    expect(next).toMatch(/display:\s*\{\s*maxFps:\s*120/u);
    expect(next).not.toContain("preferWebGPU");
  });

  it("rejects an unknown path or a bad value and writes nothing", async () => {
    const file = path.join(root, "threenative.config.ts");
    await writeFile(file, CONFIG);
    await expect(patchConfig(root, { "app.secret": 1 })).rejects.toBeInstanceOf(ConfigEditError);
    await expect(patchConfig(root, { "renderer.resolutionScale": 7 })).rejects.toBeInstanceOf(
      ConfigEditError,
    );
    expect(await readFile(file, "utf8")).toBe(CONFIG);
    const { engineChanged } = await patchConfig(root, { engine: "threejs" });
    expect(engineChanged).toBe(true);
    expect(await readFile(file, "utf8")).toContain('engine: "threejs"');
  });
});

describe("config editor edge cases", () => {
  it("removes a key on a last line without a newline and inserts after a commented last key", async () => {
    const oneLine = 'export default { app: { name: "Fox" }, engine: "threejs" }';
    const removed = await applyConfigChanges(oneLine, { engine: null });
    expect(removed).toMatch(/^export default \{ app: \{ name: "Fox" \},\s*\}$/u);
    const commented =
      'const config = {\n  app: { name: "Fox" } // note\n};\nexport default config;\n';
    const next = await applyConfigChanges(commented, { engine: "threejs" });
    expect(next).toContain("}, // note");
    expect(next).not.toContain("// note,");
  });

  it("keeps both of two overlapping saves", async () => {
    const file = path.join(root, "threenative.config.ts");
    await writeFile(file, CONFIG);
    await Promise.all([
      patchConfig(root, { "app.name": "Fox Two" }),
      patchConfig(root, { "display.maxFps": 90 }),
    ]);
    const text = await readFile(file, "utf8");
    expect(text).toContain('name: "Fox Two"');
    expect(text).toMatch(/maxFps:\s*90/u);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses to write when the config cannot be read for a reason other than absence",
    async () => {
      const file = path.join(root, "threenative.config.ts");
      await writeFile(file, CONFIG);
      await chmod(file, 0o000);
      await expect(patchConfig(root, { "app.name": "X" })).rejects.toThrow(/EACCES/u);
      await chmod(file, 0o644);
      expect(await readFile(file, "utf8")).toBe(CONFIG);
    },
  );
});

describe("sharing consent", () => {
  it("defaults both switches off and keeps the file on this machine, never in the project", async () => {
    expect(await readPrefs()).toEqual({ shareProcedurals: false, shareSessionTraces: false });
    await writePrefs({ shareProcedurals: true });
    const file = path.join(dir, "xdg/threenative/telemetry.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      shareProcedurals: true,
      shareSessionTraces: false,
    });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(writePrefs({ crashReports: true })).rejects.toThrow();
    await expect(writePrefs({ shareSessionTraces: "yes" })).rejects.toThrow();
  });
});

// Built from parts, so no secret scanner reads this file as a leaked key.
const GITHUB = `gh${"p_"}${"A1b2C3d4".repeat(5)}`;
const AWS = `AK${"IA"}${"QWERTYUIOPASDFGH"}`;
const ANTHROPIC = `sk-${"ant-api03-"}${"x".repeat(40)}`;
const identity = { home: "/home/alice", username: "alice", hostname: "alice-desktop" };

describe("trace scrubber", () => {
  it("strips secrets and personal data from every string and key", () => {
    const record = {
      cwd: "/home/alice/games/fox",
      message: {
        content: `token ${GITHUB} aws ${AWS} key ${ANTHROPIC} mail alice@example.com at 192.168.1.40 on alice-desktop`,
      },
      "/home/alice/.ssh": "Authorization: Bearer abcdefghijklmnop1234",
    };
    const { jsonl, records } = scrubTrace(`${JSON.stringify(record)}\n`, identity);
    expect(records).toBe(1);
    for (const leaked of [
      GITHUB,
      AWS,
      ANTHROPIC,
      "alice@example.com",
      "192.168.1.40",
      "alice-desktop",
      "/home/alice",
      "abcdefghijklmnop1234",
    ])
      expect(jsonl).not.toContain(leaked);
    expect(jsonl).toContain("~/games/fox");
    expect(residualFinding(`leak ${GITHUB}`, identity)).toBeDefined();
    expect(residualFinding(scrubText(`leak ${GITHUB}`, identity), identity)).toBeUndefined();
  });

  it("drops the body of a tool result that read a private file", () => {
    const lines = [
      {
        type: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/home/alice/games/fox/.env" },
          },
        ],
      },
      {
        type: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "DATABASE_URL=postgres://u:p@db/x" },
        ],
      },
    ];
    const { jsonl } = scrubTrace(lines.map((line) => JSON.stringify(line)).join("\n"), identity);
    expect(jsonl).toContain("[redacted: private file]");
    expect(jsonl).not.toContain("postgres://");
  });

  it("drops private-file output in Codex, pi and Claude Code record shapes", () => {
    const secret = "DB_PASSWORD_VALUE_9f8e7d";
    const lines = [
      // Codex: arguments is a JSON string, and the call has both id and call_id.
      {
        type: "function_call",
        id: "fc_1",
        call_id: "c1",
        name: "shell",
        arguments: '{"cmd":"cat .env"}',
      },
      { type: "function_call_output", call_id: "c1", output: secret },
      // pi: camelCase toolCallId.
      { type: "toolCall", id: "p1", name: "read", arguments: { path: "config/.ENV.local" } },
      { type: "toolResult", toolCallId: "p1", content: [{ type: "text", text: secret }] },
      // Claude Code: stdout copied into a sibling toolUseResult with no id.
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t9", name: "Bash", input: { command: "cat ~/.npmrc" } },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t9", content: secret }] },
        toolUseResult: { stdout: secret, stderr: "" },
      },
    ];
    const { jsonl } = scrubTrace(lines.map((line) => JSON.stringify(line)).join("\n"), identity);
    expect(jsonl).not.toContain(secret);
  });

  it("catches lowercase secret assignments and bearer tokens", () => {
    const text = 'api_key: "abcdef123456" password=hunter2hunter bearer abcdefghijklmnop1234';
    const out = scrubText(text, identity);
    for (const leaked of ["abcdef123456", "hunter2hunter", "abcdefghijklmnop1234"])
      expect(out).not.toContain(leaked);
    expect(residualFinding("ping 10.1.2.3", identity)).toBeDefined();
  });

  it("allows only the opus, astra, neon and fable families", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("opus");
    expect(modelFamily("claude-fable-5-2")).toBe("fable");
    for (const other of [
      "claude-haiku-5-5",
      "deepseek-v4-flash",
      "gpt-mini",
      "inkling-mini-2",
      undefined,
    ])
      expect(modelFamily(other)).toBeUndefined();
  });
});

async function session(model: string, name: string, extra = "") {
  const folder = path.join(
    home,
    ".claude/projects",
    path.resolve(root).replace(/[^A-Za-z0-9]/gu, "-"),
  );
  await mkdir(folder, { recursive: true });
  const lines = [
    { cwd: root, type: "user", message: { content: `make the fox jump ${extra}` } },
    { type: "assistant", message: { model, content: "done" } },
  ];
  await writeFile(
    path.join(folder, `${name}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n"),
  );
}

describe("session trace sharing", () => {
  it("finds Codex sessions by the cwd at their start and ignores other projects", async () => {
    const day = path.join(home, ".codex/sessions/2026/11/26");
    await mkdir(day, { recursive: true });
    const codex = (cwd: string, model: string) =>
      [
        { type: "session_meta", payload: { cwd, model } },
        { type: "response_item", payload: { text: "x".repeat(70_000) } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n");
    await writeFile(path.join(day, "rollout-mine.jsonl"), codex(root, "gpt-neon-5"));
    await writeFile(
      path.join(day, "rollout-other.jsonl"),
      codex(path.join(dir, "elsewhere"), "gpt-neon-5"),
    );
    const found = await discoverTraces(root, { home });
    expect(found.map((trace) => trace.id)).toEqual(["codex:rollout-mine"]);
  });

  it("sends nothing while the switch is off", async () => {
    await session("claude-opus-5-5", "a");
    const fetch = vi.fn();
    const report = await shareTraces(root, { fetch, where: { home }, identity });
    expect(fetch).not.toHaveBeenCalled();
    expect(report.sent).toEqual([]);
  });

  it("sends an allowlisted session once, scrubbed and gzipped, and skips other models", async () => {
    await session("claude-opus-5-5", "good", "as alice on alice-desktop");
    await session("deepseek-v4-flash", "cheap");
    const found = await discoverTraces(root, { home });
    expect(found.find((t) => t.id === "claude:cheap")?.skip).toMatch(/outside opus/u);
    await writePrefs({ shareSessionTraces: true });
    const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
    const report = await shareTraces(root, { fetch, where: { home }, identity });
    expect(report.sent).toEqual(["claude:good"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-tn-model-family"]).toBe("opus");
    const sent = gunzipSync(init.body as Uint8Array).toString("utf8");
    expect(sent).toContain("make the fox jump");
    expect(sent).not.toContain("alice-desktop");
    await shareTraces(root, { fetch, where: { home }, identity });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

/** A minimal binary glTF 2.0 with a JSON chunk only. */
function glb(json: Record<string, unknown>): Uint8Array {
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const bytes = new Uint8Array(20 + text.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(new TextEncoder().encode(text), 20);
  return bytes;
}

describe("procedural sharing", () => {
  it("accepts only self-contained GLBs saved under assets/procedural/", () => {
    expect(validateGlb(glb({ asset: { version: "2.0" } })).json).toBeDefined();
    expect(() => validateGlb(glb({ buffers: [{ uri: "data.bin", byteLength: 4 }] }))).toThrow(
      /self-contained/u,
    );
    expect(() => validateGlb(new Uint8Array(24))).toThrow(/magic/u);
    expect(procedurallyExcluded("assets/procedural/rock.glb")).toBeUndefined();
    expect(procedurallyExcluded("assets/downloads/rock.glb")).toBeDefined();
    expect(procedurallyExcluded("assets/procedural/levels/a.glb")).toBeDefined();
    expect(procedurallyExcluded("assets/procedural/rock-lod1.glb")).toBeDefined();
    expect(procedurallyExcluded("../other/assets/procedural/rock.glb")).toBeDefined();
  });

  it("refuses to upload while the switch is off, and an agent share needs an allowlisted model", async () => {
    await mkdir(path.join(root, "assets/procedural"), { recursive: true });
    await writeFile(
      path.join(root, "assets/procedural/rock.glb"),
      glb({ asset: { version: "2.0" } }),
    );
    const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
    await expect(
      shareProcedural(root, { path: "assets/procedural/rock.glb", source: "manual" }, { fetch }),
    ).rejects.toThrow(/off/u);
    await writePrefs({ shareProcedurals: true });
    await expect(
      shareProcedural(
        root,
        { path: "assets/procedural/rock.glb", source: "agent", model: "claude-haiku-5-5" },
        { fetch },
      ),
    ).rejects.toThrow(/opus/u);
    expect(fetch).not.toHaveBeenCalled();
    await shareProcedural(
      root,
      { path: "assets/procedural/rock.glb", source: "manual" },
      { fetch },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("health and playtests", () => {
  it("summarizes the asset cook manifest", async () => {
    expect(await assetCook(root)).toBeUndefined();
    await mkdir(path.join(root, "public"), { recursive: true });
    await writeFile(
      path.join(root, "public/assets.manifest.json"),
      JSON.stringify({
        version: 1,
        entries: {
          a: { kind: "texture", bytesBefore: 400, bytesAfter: 100, quality: { status: "pass" } },
        },
      }),
    );
    expect(await assetCook(root)).toMatchObject({
      before: 400,
      after: 100,
      rows: [{ name: "a", quality: "pass" }],
    });
  });

  it("lists scenarios with their assertion count and refuses paths outside playtests/", async () => {
    await mkdir(path.join(root, "playtests/live"), { recursive: true });
    await writeFile(
      path.join(root, "playtests/live/jump.playtest.json"),
      JSON.stringify({ name: "jump", assert: { diagnostics: {}, components: [{}, {}] } }),
    );
    expect(await listScenarios(root)).toEqual([
      { path: "playtests/live/jump.playtest.json", name: "jump", assertions: 3 },
    ]);
    expect(() => scenarioPath(root, "../secret.playtest.json")).toThrow();
    expect(() => scenarioPath(root, "package.json")).toThrow();
  });

  it("runs one playtest at a time, reads its report, and serves artifacts from its own folder only", async () => {
    await mkdir(path.join(root, "playtests"), { recursive: true });
    await writeFile(path.join(root, "playtests/a.playtest.json"), "{}");
    const cli = path.join(dir, "fake-cli.mjs");
    await writeFile(
      cli,
      `import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--artifacts") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(out + "/after.png", "png");
console.error("step 1");
setTimeout(() => console.log(JSON.stringify({ pass: true, assertionResults: [{ id: "a", pass: true }] })), 200);`,
    );
    const runner = new PlaytestRunner(root, { cli: () => cli });
    const done = new Promise<void>((resolve) =>
      runner.subscribe((event) => event.type === "done" && resolve()),
    );
    const run = runner.start("playtests/a.playtest.json", "http://127.0.0.1:5173/");
    expect(() => runner.start("playtests/a.playtest.json", "http://127.0.0.1:5173/")).toThrow(
      /already running/u,
    );
    await done;
    expect(run.status).toBe("passed");
    expect(run.result).toMatchObject({
      assertions: [{ id: "a", pass: true }],
      images: ["after.png"],
    });
    expect(run.lines).toContain("step 1");
    expect(runner.artifact(run.id, "after.png")).toBeDefined();
    expect(runner.artifact(run.id, "../../../../package.json")).toBeUndefined();
    expect(() => runner.start("playtests/a.playtest.json", "https://example.com/")).toThrow(
      /loopback/u,
    );
  });

  it("cancels a running playtest", async () => {
    await mkdir(path.join(root, "playtests"), { recursive: true });
    await writeFile(path.join(root, "playtests/a.playtest.json"), "{}");
    const cli = path.join(dir, "slow-cli.mjs");
    await writeFile(cli, "setTimeout(() => {}, 30000);");
    const runner = new PlaytestRunner(root, { cli: () => cli });
    const done = new Promise<void>((resolve) =>
      runner.subscribe((event) => event.type === "done" && resolve()),
    );
    const run = runner.start("playtests/a.playtest.json", "http://127.0.0.1:5173/");
    expect(runner.cancel()).toBe(true);
    await done;
    expect(run.status).toBe("cancelled");
  });
});

describe("dashboard API", () => {
  it("refuses a cross-site or non-JSON write and answers a same-origin one", async () => {
    await writeFile(path.join(root, "threenative.config.ts"), CONFIG);
    const api = createDashboardApi({ root, url: () => undefined });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void api
        .handle(url.pathname.slice(1), url, req, res)
        .then((hit) => hit || res.writeHead(404).end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const patch = (headers: Record<string, string>, body: unknown) =>
        fetch(`${base}/config`, { method: "PATCH", headers, body: JSON.stringify(body) });
      expect(
        (await patch({ "content-type": "text/plain" }, { changes: { "app.name": "X" } })).status,
      ).toBe(403);
      expect(
        (
          await patch(
            { "content-type": "application/json", origin: "http://evil.test" },
            { changes: { "app.name": "X" } },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await patch(
            { "content-type": "application/json" },
            { changes: { "renderer.resolutionScale": 9 } },
          )
        ).status,
      ).toBe(400);
      const ok = await patch(
        { "content-type": "application/json", origin: base },
        { changes: { "app.name": "Vixen" } },
      );
      expect(ok.status).toBe(200);
      expect(await readFile(path.join(root, "threenative.config.ts"), "utf8")).toContain(
        'name: "Vixen"',
      );
      const telemetry = await (await fetch(`${base}/telemetry`)).json();
      expect(telemetry).toMatchObject({
        crashReports: true,
        shareProcedurals: false,
        shareSessionTraces: false,
      });
      expect(
        (
          await fetch(`${base}/playtests/run`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(503);
    } finally {
      api.close();
      server.close();
    }
  });
});
