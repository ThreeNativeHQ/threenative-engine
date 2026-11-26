import { readFile } from "node:fs/promises";
import { Box3, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { proceduralEnvironmentSource } from "../src/asset-library.js";
import { bakeRail, environmentElements } from "../src/index.js";
import { buildRail, railAccent } from "../src/rail.js";

const attachments = {
  straight: ["track-in", "track-out"],
  curve: ["track-in", "track-out"],
  ramp: ["track-in", "track-out"],
  bridge: ["track-in", "track-out"],
  stop: ["track-in"],
  cart: ["cart-front-axle", "cart-rear-axle", "cart-load"],
} as const;

const options = { seed: 1, accent: railAccent, scale: 1 };

describe("Rail Kit", () => {
  it("bakes grounded Asset Library entries with the advertised nodes", async () => {
    const out = await makeTempDir("tn-rail-");
    const rows = environmentElements({ kind: "rail" });
    expect(rows.map(({ id }) => id)).toEqual(Object.keys(attachments).map((id) => `rail-${id}`));
    const catalog = (await proceduralEnvironmentSource({ root: out }).catalog()) as {
      elements: { id: string; kind: string; styleTags: string[] }[];
    };
    expect(catalog.elements.filter(({ kind }) => kind === "rail")).toMatchObject(
      rows.map(({ id }) => ({ id, styleTags: ["stylized"] })),
    );
    for (const [id, nodes] of Object.entries(attachments)) {
      const [bake] = await bakeRail({ module: `rail-${id}`, out });
      if (!bake) throw new Error(`Missing rail bake for ${id}`);
      const bytes = await readFile(bake.path);
      expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
      const glb = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()) as {
        nodes: { name: string }[];
      };
      expect(glb.nodes.map(({ name }) => name)).toEqual(expect.arrayContaining([...nodes]));
      expect(bake.bounds.min[1]).toBeCloseTo(0, 5);
      expect(bake.triangles).toBeLessThan(5000);
    }
  });

  const trackIds = ["straight", "curve", "ramp", "bridge", "stop"] as const;
  it.each(trackIds.flatMap((id) => [0.5, 1, 2].map((scale) => ({ id, scale }))))(
    "matches both running rails at every $id socket at $scale scale",
    ({ id, scale }) => {
      const track = buildRail(id, { ...options, scale });
      const down = new Vector3(0, -1, 0);
      track.updateMatrixWorld(true);
      for (const name of attachments[id]) {
        const socket = track.getObjectByName(name);
        if (!socket) throw new Error(`Missing ${id} ${name}`);
        const expected = socket.getWorldPosition(new Vector3());
        const inset = name === "track-in" ? 0.0025 : -0.0025;
        for (const x of [-0.49, 0.49]) {
          const origin = socket.localToWorld(new Vector3(x, 0.05, inset));
          const rail = new Raycaster(origin, down).intersectObject(track)[0];
          expect(rail?.object.name).toBe("Rail running surface");
          expect(rail?.point.y).toBeCloseTo(expected.y, 3);
        }
      }
    },
  );

  it("matches ramp height to the bridge and aims the quarter turn along +X", () => {
    const ramp = buildRail("ramp", options);
    const bridge = buildRail("bridge", options);
    expect(ramp.getObjectByName("track-out")?.position.y).toBe(
      bridge.getObjectByName("track-in")?.position.y,
    );
    expect(buildRail("curve", options).getObjectByName("track-out")?.rotation.y).toBeCloseTo(
      Math.PI / 2,
    );
  });

  it("carries the ramp stringers under the first raised sleepers", () => {
    const ramp = buildRail("ramp", options);
    ramp.updateMatrixWorld(true);
    const down = new Vector3(0, -1, 0);
    for (const x of [-0.65, 0.65]) {
      const ray = new Raycaster(new Vector3(x, 0.2, -1.5), down);
      expect(ray.intersectObject(ramp)[0]?.object.name).toBe("Rail dark timber");
    }
  });

  it("sets both axle wheel treads on the rail gauge at matching scale", () => {
    const scale = 1.5;
    const track = buildRail("straight", { ...options, scale });
    const cart = buildRail("cart", { ...options, scale });
    const entry = track.getObjectByName("track-in");
    if (!entry) throw new Error("Missing track-in");
    track.updateMatrixWorld(true);
    cart.position.y = entry.getWorldPosition(new Vector3()).y;
    cart.updateMatrixWorld(true);
    for (const name of ["cart-front-axle", "cart-rear-axle"]) {
      const axle = cart.getObjectByName(name);
      if (!axle) throw new Error(`Missing ${name}`);
      expect(new Box3().setFromObject(axle).min.y).toBeCloseTo(cart.position.y);
      for (const x of [-0.49, 0.49]) {
        const origin = axle.localToWorld(new Vector3(x, 0.3, 0));
        const ray = new Raycaster(origin, new Vector3(0, -1, 0));
        expect(ray.intersectObject(axle)[0]?.object.name).toBe("Rail wheel tread");
        expect(ray.intersectObject(track)[0]?.point.y).toBeCloseTo(cart.position.y);
      }
    }
  });
});
