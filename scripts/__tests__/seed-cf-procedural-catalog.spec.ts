import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";

import {
  OPS_PATH,
  bakeWolfData,
  seeds,
  upload,
  validGlb,
  wolfGlb,
} from "../seed-cf-procedural-catalog.js";

/** PRD-120 (Studio) AC-4. The seeder bakes the wolf into a standard skinned GLB a glTF reader accepts,
 * keeps the floor props as they are, and posts each one to the operator route by slug. */
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
});
