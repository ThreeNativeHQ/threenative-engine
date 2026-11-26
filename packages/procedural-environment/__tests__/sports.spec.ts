import { readFile } from "node:fs/promises";
import { Box3, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { proceduralEnvironmentSource } from "../src/asset-library.js";
import { bakeSports, environmentElements } from "../src/index.js";
import { buildSports, sportsModules } from "../src/sports.js";

const attachments = {
  goal: ["goal-center", "goal-left-post", "goal-right-post", "goal-crossbar"],
  hoop: ["rim-center", "backboard-target"],
  net: ["net-left", "net-center", "net-right"],
  "soccer-ball": ["ball-center"],
  basketball: ["ball-center"],
  "tennis-ball": ["ball-center"],
} as const;

describe("Sports Kit", () => {
  it("bakes a grounded GLB with documented nodes for every Asset Library entry", async () => {
    const out = await makeTempDir("tn-sports-");
    const rows = environmentElements({ kind: "sports" });
    expect(rows.map(({ id }) => id)).toEqual(Object.keys(attachments).map((id) => `sports-${id}`));
    const catalog = (await proceduralEnvironmentSource({ root: out }).catalog()) as {
      elements: { id: string; kind: string; styleTags: string[] }[];
    };
    expect(catalog.elements.filter(({ kind }) => kind === "sports")).toMatchObject(
      rows.map(({ id }) => ({ id, styleTags: ["stylized"] })),
    );
    for (const [id, nodes] of Object.entries(attachments)) {
      const [entry] = await bakeSports({ module: `sports-${id}`, out });
      if (!entry) throw new Error(`Missing sports bake for ${id}`);
      const bytes = await readFile(entry.path);
      expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
      const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()) as {
        nodes: { name: string }[];
      };
      expect(json.nodes.map(({ name }) => name)).toEqual(expect.arrayContaining([...nodes]));
      expect(entry.bounds.min[1]).toBeCloseTo(0, 5);
      expect(entry.triangles).toBeLessThan(6500);
    }
  });

  it("changes the goal opening and court net span without requiring uniform scale", () => {
    const goal = buildSports("goal", {
      seed: 1,
      accent: "#e9eef0",
      scale: 1,
      span: 4,
      height: 1.8,
    });
    expect(goal.getObjectByName("goal-left-post")?.position.x).toBe(-2);
    expect(goal.getObjectByName("goal-right-post")?.position.x).toBe(2);
    expect(goal.getObjectByName("goal-crossbar")?.position.y).toBe(1.8);
    goal.updateMatrixWorld(true);
    const shot = new Raycaster(new Vector3(0, 0.9, 1), new Vector3(0, 0, -1));
    expect(shot.intersectObject(goal).every((hit) => hit.point.z < 0)).toBe(true);

    const net = buildSports("net", {
      seed: 1,
      accent: "#248377",
      scale: 1.25,
      span: 5,
      height: 1.8,
    });
    net.updateMatrixWorld(true);
    expect(net.getObjectByName("net-left")?.getWorldPosition(new Vector3()).x).toBe(-3.125);
    expect(net.getObjectByName("net-right")?.getWorldPosition(new Vector3()).x).toBe(3.125);
    expect(net.getObjectByName("net-center")?.getWorldPosition(new Vector3()).y).toBe(2.25);
  });

  it("keeps an open rim centered at the requested height", () => {
    const hoop = buildSports("hoop", { seed: 1, accent: "#257288", scale: 1, height: 2.1 });
    const rim = hoop.getObjectByName("rim-center");
    expect(rim?.position.y).toBe(2.1);
    if (!rim) throw new Error("Missing rim center");
    hoop.updateMatrixWorld(true);
    const shot = new Raycaster(
      rim.position.clone().add(new Vector3(0, 0.5, 0)),
      new Vector3(0, -1, 0),
      0,
      1,
    );
    expect(shot.intersectObject(hoop)).toEqual([]);
  });

  it("centers balls over a grounded contact point", () => {
    for (const id of ["soccer-ball", "basketball", "tennis-ball"] as const) {
      const module = sportsModules.find((row) => row.id === id);
      if (!module) throw new Error(`Missing ${id}`);
      const ball = buildSports(id, { seed: 1, accent: module.accent, scale: 1.5 });
      ball.updateMatrixWorld(true);
      const center = ball.getObjectByName("ball-center")?.getWorldPosition(new Vector3());
      expect(center?.x).toBe(0);
      expect(center?.z).toBe(0);
      expect(center?.y).toBeGreaterThan(0.03);
    }
  });

  it("keeps the tennis seam inside a nearly spherical outline", () => {
    const ball = buildSports("tennis-ball", { seed: 1, accent: "#c5db45", scale: 1 });
    const diameter = new Box3().setFromObject(ball, true).getSize(new Vector3());
    expect(Math.max(diameter.x, diameter.y, diameter.z)).toBeLessThan(0.0695);
  });

  it("keeps distinct dimension variants and rejects inapplicable overrides", async () => {
    const out = await makeTempDir("tn-sports-sizing-");
    const [stock] = await bakeSports({ module: "sports-net", out });
    const [variant] = await bakeSports({ module: "sports-net", out, span: 5, height: 1.8 });
    expect(variant?.path).not.toBe(stock?.path);
    await expect(bakeSports({ module: "sports-basketball", out, span: 5 })).rejects.toThrow(/span/);
    await expect(
      bakeSports({ module: "sports-goal", out, height: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/height/);
  });
});
