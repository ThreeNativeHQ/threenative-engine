import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const liveUrl = process.env.THREENATIVE_REFERENCES_URL;
const fixture = path.resolve("packages/engine-mcp/__tests__/fixtures/refs");
const manifest = path.resolve("packages/create-threenative/capabilities.json");
const game = JSON.parse(readFileSync(path.join(fixture, "game-sm64.json"), "utf8"));
const index = JSON.parse(readFileSync(path.join(fixture, "index.json"), "utf8"));
let server: Server;
let cache: string;
let project: string;
let malformed = false;
const requests: { url: string; etag: string | undefined }[] = [];
async function refs() {
  return import("../src/references.js");
}
async function call(name: string, args: unknown, manifestFile = manifest) {
  const { handleLine } = await import("../src/index.js");
  const response = JSON.parse(
    (await handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      manifestFile,
    )) ?? "",
  );
  if (response.error) throw new Error(response.error.message);
  return JSON.parse(response.result.content[0].text);
}
beforeEach(async () => {
  vi.resetModules();
  malformed = false;
  requests.length = 0;
  cache = makeTempDirSync("reference-cache-");
  project = makeTempDirSync("reference-project-");
  vi.stubEnv("THREENATIVE_REFERENCES_CACHE", cache);
  vi.stubEnv("THREENATIVE_ENGINE_MCP_LOG", "off");
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", etag: req.headers["if-none-match"] });
    if (req.headers["if-none-match"] === '"v1"' && !malformed) {
      res.writeHead(304).end();
      return;
    }
    res.setHeader("etag", '"v1"');
    if (req.url === "/index.json.gz")
      res.end(gzipSync(JSON.stringify(malformed ? { ...index, code: "bad" } : index)));
    else if (req.url === "/game-sm64.json") res.end(JSON.stringify(game));
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP address");
  vi.stubEnv("THREENATIVE_REFERENCES_URL", `http://127.0.0.1:${address.port}/`);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

describe("reference release cache", () => {
  it("refreshes with ETag on a second start, reads offline and preserves the cache on malformed releases", async () => {
    expect((await (await refs()).loadReferenceIndex()).games).toHaveLength(2);
    expect(requests).toHaveLength(1);
    vi.resetModules();
    await (await refs()).loadReferenceIndex();
    expect(requests[1]?.etag).toBe('"v1"');
    const cached = path.join((await refs()).referencesCacheDir(), "index.json.gz");
    const before = readFileSync(cached);
    malformed = true;
    vi.resetModules();
    await expect((await refs()).loadReferenceIndex()).rejects.toThrow("unknown field");
    expect(readFileSync(cached)).toEqual(before);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.resetModules();
    expect((await (await refs()).loadReferenceIndex()).games).toHaveLength(2);
  });
  it("validates nested unknown fields, fenced code, duplicate ids and missing links", async () => {
    const { validateReferenceGame, validateReferenceIndex } = await refs();
    expect(() =>
      validateReferenceGame({ ...game, cards: [{ ...game.cards[0], code: "bad" }] }),
    ).toThrow("unknown field");
    expect(() =>
      validateReferenceGame({ ...game, cards: [{ ...game.cards[0], name: "```bad```" }] }),
    ).toThrow(/code block/);
    expect(() => validateReferenceGame({ ...game, nodes: [...game.nodes, game.nodes[0]] })).toThrow(
      /duplicate/,
    );
    expect(() =>
      validateReferenceGame({ ...game, nodes: [{ ...game.nodes[0], dependsOn: ["missing"] }] }),
    ).toThrow(/missing/);
    expect(() =>
      validateReferenceIndex({ ...index, stubs: [{ ...index.stubs[0], game: "missing" }] }),
    ).toThrow(/missing/);
  });
  it("merges a card that references an already saved node", async () => {
    const { saveReferenceGame, loadReferenceGame } = await refs();
    saveReferenceGame(game, project);
    saveReferenceGame(
      { ...game, nodes: [], cards: [{ ...game.cards[0], id: "long-jump" }] },
      project,
    );
    expect((await loadReferenceGame("sm64", project)).cards).toHaveLength(2);
  });
  it("isolates caches for different release sources", async () => {
    const { loadReferenceIndex } = await refs();
    await loadReferenceIndex();
    vi.stubEnv("THREENATIVE_REFERENCES_URL", "http://127.0.0.1:1/");
    vi.resetModules();
    await expect((await refs()).loadReferenceIndex()).rejects.toThrow("UNAVAILABLE");
  });
  it("saves and merges by id, prioritizes local cards and returns a shell-safe contribution command", async () => {
    const { saveReferenceGame, loadReferenceGame } = await refs();
    const saved = saveReferenceGame(game, project);
    expect(existsSync(path.join(project, saved.saved))).toBe(true);
    expect(saved.contribution.command).toContain(
      "gh issue create --repo jonit-dev/threenative-game-refs",
    );
    saveReferenceGame(
      {
        ...game,
        title: "A $(touch nope) `bad` title",
        cards: [{ ...game.cards[0], id: "long-jump" }],
      },
      project,
    );
    const merged = await loadReferenceGame("sm64", project);
    expect(merged.cards.map((c) => c.id)).toEqual(["triple-jump", "long-jump"]);
    expect(requests).toHaveLength(0);
    expect(() =>
      saveReferenceGame({ ...game, cards: [{ ...game.cards[0], code: "bad" }] }, project),
    ).toThrow();
    expect((await loadReferenceGame("sm64", project)).cards).toHaveLength(2);
  });
});

describe("reference MCP tools", () => {
  it("searches cards and map nodes, lazily loads detail with constants, files, functions and children", async () => {
    const result = await call("engine_search_references", { situation: "triple jump" });
    expect(result.results[0]).toMatchObject({ game: "sm64", id: "triple-jump", kind: "card" });
    expect(requests.every((r) => r.url === "/index.json.gz")).toBe(true);
    const camera = await call("engine_search_references", { situation: "camera system" });
    expect(camera.results[0]).toMatchObject({ id: "camera", kind: "node" });
    const card = await call("engine_reference_detail", {
      game: "sm64",
      id: "triple-jump",
      kind: "card",
    });
    expect(card.sha).toBe(game.sha);
    expect(card.card.constants).toEqual(game.cards[0].constants);
    const node = await call("engine_reference_detail", {
      game: "sm64",
      id: "player",
      kind: "node",
    });
    expect(node.node.paths).toEqual(game.nodes[0].paths);
    expect(node.children[0].functions[0].name).toBe("act_triple_jump");
    const tier2 = await call("engine_search_references", { situation: "Ocarina of Time" });
    expect(tier2.results[0]).toMatchObject({
      id: "oot",
      tier: 2,
      repo: "https://github.com/zeldaret/oot",
    });
    expect(tier2.results[0].guidance).toContain("engine_save_reference");
  });
  it("adds at most three stubs on none and no references on matched", async () => {
    const emptyManifest = path.join(project, "capabilities.json");
    writeFileSync(emptyManifest, JSON.stringify({ version: 2, entries: [], notOwned: [] }));
    const none = await call(
      "engine_search_capabilities",
      { situation: "triple jump" },
      emptyManifest,
    );
    expect(none.verdict).toBe("none");
    expect(none.references.results[0].id).toBe("triple-jump");
    expect(none.references.results.length).toBeLessThanOrEqual(3);
    const matched = await call("engine_search_capabilities", {
      situation: "put a weapon in a character's hand",
    });
    expect(matched.verdict).toBe("matched");
    expect(matched.references).toBeUndefined();
  });
  it("saves through MCP and searches local references when the release is unavailable", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      const saved = await call("engine_save_reference", { game });
      expect(existsSync(path.join(project, saved.saved))).toBe(true);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const result = await call("engine_search_references", { situation: "triple jump" });
      expect(result.results[0].id).toBe("triple-jump");
      const detail = await call("engine_reference_detail", {
        game: "sm64",
        id: "triple-jump",
        kind: "card",
      });
      expect(detail.card.sources).toEqual(game.cards[0].sources);
      await expect(
        call("engine_save_reference", {
          game: { ...game, cards: [{ ...game.cards[0], code: "bad" }] },
        }),
      ).rejects.toThrow("unknown field");
    } finally {
      cwd.mockRestore();
    }
  });
  it("reports unavailable without a cache while capability search keeps working", async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const response = await call("engine_search_references", { situation: "triple jump" });
    expect(response.guidance).toContain("references unavailable");
    expect(response.results).toEqual([]);
    expect(
      (
        await call("engine_search_capabilities", {
          situation: "put a weapon in a character's hand",
        })
      ).verdict,
    ).toBe("matched");
  });
});

// Opt in with THREENATIVE_REFERENCES_URL=<published-release>/ and -t live.
it.skipIf(!liveUrl)(
  "live SM64 release downloads, searches and contains at least ten pinned cards",
  async () => {
    vi.stubEnv("THREENATIVE_REFERENCES_URL", liveUrl ?? "");
    const result = await call("engine_search_references", { situation: "triple jump" });
    expect(result.results[0]).toMatchObject({ game: "sm64", id: "triple-jump", kind: "card" });
    const loaded = await (await refs()).loadReferenceGame("sm64");
    expect(loaded.cards.length).toBeGreaterThanOrEqual(10);
    expect(loaded.sha).toMatch(/^[0-9a-f]{40}$/u);
    const detail = await call("engine_reference_detail", {
      game: "sm64",
      id: "triple-jump",
      kind: "card",
    });
    expect(detail.sha).toBe(loaded.sha);
    expect(detail.card.constants.length).toBeGreaterThan(0);
  },
);
