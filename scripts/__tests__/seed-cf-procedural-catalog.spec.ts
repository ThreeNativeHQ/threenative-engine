import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import {
  assertValidSelfContainedGlb,
  assetLibraryCatalog,
  bakeDescriptorBytes,
} from "../seed-cf-asset-library.js";

import {
  OPS_PATH,
  bakeWolfData,
  seeds,
  upload,
  validGlb,
  wolfGlb,
} from "../seed-cf-procedural-catalog.js";

/** PRD-120 (Studio) AC-4 & Asset Library extension. Bakes the wolf, keeps the floor props, validates
 * every Asset Library descriptor (242 bakeable + 208 runtime kits), and proves representative GLBs
 * export self-contained under 25 MB. */
describe("seed-cf-procedural-catalog", () => {
  it("bakes the wolf into a skinned GLB with one joint per bone", async () => {
    const data = await bakeWolfData("crowd");
    const bytes = wolfGlb(data);
    expect(validGlb(bytes)).toBe(true);
    const document = await new NodeIO().readBinary(bytes);
    const root = document.getRoot();
    const [skin] = root.listSkins();
    expect(skin?.listJoints().map((joint) => joint.getName())).toEqual(
      data.bones.map((bone) => bone.name),
    );
    const primitive = root.listMeshes()[0]?.listPrimitives()[0];
    expect(primitive?.getAttribute("POSITION")?.getCount()).toBe(data.nV);
    expect(primitive?.getAttribute("JOINTS_0")?.getCount()).toBe(data.nV);
    expect(primitive?.getAttribute("WEIGHTS_0")?.getCount()).toBe(data.nV);
    expect(primitive?.getIndices()?.getCount()).toBe(data.index.length);
    const colors = primitive?.getAttribute("COLOR_0")?.getArray() ?? [];
    expect(Math.max(...colors)).toBeLessThanOrEqual(1);
  });

  it("validates every seed and uploads one with the operator token", async () => {
    const all = await seeds();
    expect(all.map((seed) => seed.slug)).toEqual(
      expect.arrayContaining(["wolf-grey", "floor-fern-0", "floor-log-1"]),
    );
    expect(all.every((seed) => validGlb(seed.bytes))).toBe(true);
    const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      sent.push({
        auth: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        url: String(url),
      });
      return Response.json({ id: "id-1", updated: false });
    }) as unknown as typeof fetch;
    const fern = all.find((seed) => seed.slug === "floor-fern-0");
    if (fern === undefined) throw new Error("no fern seed");
    expect(await upload(fern, "http://127.0.0.1:8787", "ops", fake)).toEqual({
      id: "id-1",
      updated: false,
    });
    expect(sent[0]).toMatchObject({
      auth: "Bearer ops",
      body: { license: "CC0-1.0", origin: "procedural", slug: "floor-fern-0", type: "model" },
      url: `http://127.0.0.1:8787${OPS_PATH}`,
    });
    expect(Buffer.from(String(sent[0]?.body.glbBase64), "base64")).toEqual(Buffer.from(fern.bytes));
  });

  it("produces unique valid slugs, prompts, and tags across wolf, floor, and all 450 Asset Library items", async () => {
    const core = await seeds();
    const lib = await assetLibraryCatalog();
    expect(lib.length).toBe(450);

    const combined = [
      ...core.map((s) => ({
        license: s.license ?? "CC0-1.0",
        prompt: s.prompt,
        slug: s.slug,
        tags: s.tags,
      })),
      ...lib.map((item) => ({
        license: item.license,
        prompt: item.prompt,
        slug: item.slug,
        tags: item.tags,
      })),
    ];
    const slugRe = /^[a-z0-9][a-z0-9-]{0,63}$/u;
    const seen = new Set<string>();
    for (const row of combined) {
      expect(row.slug).toMatch(slugRe);
      expect(seen.has(row.slug)).toBe(false);
      seen.add(row.slug);
      expect(row.prompt.length).toBeGreaterThanOrEqual(1);
      expect(row.prompt.length).toBeLessThanOrEqual(600);
      expect(row.tags.length).toBeLessThanOrEqual(200);
      expect(row.license.length).toBeGreaterThan(0);
    }
  });

  it(
    "bakes representative Asset Library items across bakeable kits into self-contained GLBs",
    { timeout: 60_000 },
    async () => {
      const lib = await assetLibraryCatalog();
      const samples = [
        "tree-oak",
        "rock-boulder",
        "city-cross",
        "station-floor",
        "workshop-workbench",
        "tavern-table",
      ];
      for (const slug of samples) {
        const item = lib.find((entry) => entry.slug === slug);
        expect(item).toBeDefined();
        if (!item) continue;
        const bytes = await bakeDescriptorBytes(item);
        expect(validGlb(bytes)).toBe(true);
        expect(() => assertValidSelfContainedGlb(slug, bytes)).not.toThrow();
      }
    },
  );

  it(
    "exports and compresses representative runtime kits (stylized water/sky, dungeon, village, toybox) under 25 MB",
    { timeout: 60_000 },
    async () => {
      const lib = await assetLibraryCatalog();
      const sampleSlugs = [
        "stylized-water",
        "stylized-sky-dome",
        "dungeon-courtyard",
        lib.find((entry) => entry.kind === "village")?.slug ?? "",
        lib.find((entry) => entry.kind === "toybox")?.slug ?? "",
      ];
      for (const slug of sampleSlugs) {
        const item = lib.find((entry) => entry.slug === slug);
        expect(item).toBeDefined();
        if (!item) continue;
        const bytes = await bakeDescriptorBytes(item);
        expect(validGlb(bytes)).toBe(true);
        expect(() => assertValidSelfContainedGlb(slug, bytes)).not.toThrow();
      }
    },
  );
});
