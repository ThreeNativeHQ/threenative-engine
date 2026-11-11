import { Group, Texture } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSET_LATE_MARKER, createAssetLoader } from "../src/assets.js";

/**
 * One cooked manifest, so a load's weight is knowable: `TN_ASSET_LATE` is worth reading only when
 * it says how many bytes the player waited for after play had started.
 */
const manifest = {
  entries: {
    "akagi.glb": { bytes: 26_300_000, kind: "model", output: "akagi.aaaa.glb" },
    "deck.glb": { bytes: 13_000_000, kind: "model", output: "deck.bbbb.glb" },
  },
  version: 1,
};

/** Every late-file report in a captured console log, parsed. */
function lateLines(log: readonly string[]): unknown[] {
  const prefix = `${ASSET_LATE_MARKER}:`;
  return log
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as unknown);
}

function captureLog(): string[] {
  const log: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    log.push(line);
  });
  return log;
}

describe("TN_ASSET_LATE", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("should report a file a scene requests after the reveal, with its bytes", async () => {
    // The reveal is when the player starts playing, so this request starts a download over a world
    // already on screen: exactly the pop-in the line exists to make countable.
    vi.stubGlobal("fetch", async () => Response.json(manifest));
    const log = captureLog();
    const assets = createAssetLoader({
      manifest: "m.json",
      model: async () => ({ scene: new Group() }),
    });

    await assets.startBackgroundFill();
    await assets.model("akagi.glb");
    await vi.waitUntil(() => lateLines(log).length > 0);

    expect(lateLines(log)).toEqual([
      { bytes: 26_300_000, kind: "model", ms: expect.any(Number), path: "akagi.glb" },
    ]);
  });

  it("should stay quiet for a file awaited before the reveal", async () => {
    vi.stubGlobal("fetch", async () => Response.json(manifest));
    const log = captureLog();
    const assets = createAssetLoader({
      manifest: "m.json",
      texture: async () => new Texture(),
    });

    await assets.texture("akagi.glb");
    await assets.startBackgroundFill();
    await assets.texture("akagi.glb");

    expect(lateLines(log)).toEqual([]);
  });

  it("should stay quiet for a file the game prefetched and then asked for", async () => {
    // A prefetch is the game saying it knows the file is coming: the load that follows is a
    // deliberate stream of bytes already on their way, not a surprise download.
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).endsWith("m.json") ? Response.json(manifest) : new Response(new Uint8Array([1])),
    );
    const log = captureLog();
    const assets = createAssetLoader({
      manifest: "m.json",
      texture: async () => new Texture(),
    });

    await assets.prefetch(["deck.glb"]);
    await assets.startBackgroundFill();
    await assets.texture("deck.glb");

    expect(lateLines(log)).toEqual([]);
  });
});
