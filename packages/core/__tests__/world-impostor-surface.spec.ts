import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Texture,
  Vector3,
} from "three";
import { uniform } from "three/tsl";
import { MeshStandardNodeMaterial, NodeUpdateType } from "three/webgpu";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  IMPOSTOR_BISECTION_STEPS,
  IMPOSTOR_MARCH_STEPS,
  IMPOSTOR_SURFACE_PARALLAX,
  WorldImpostorSurface,
  impostorFrameBasis,
  impostorFrameUv,
  instanceSyncEvent,
  syncInstanceRanges,
  worldLodMaterial,
} from "../src/render/world-impostor-surface.js";
import {
  IMPOSTOR_VIEWS,
  VIEW_DIRECTIONS,
  WorldImpostorAtlas,
  impostorViewCamera,
} from "../src/render/world-impostor.js";

function makeSurface(
  source:
    | MeshStandardMaterial
    | MeshPhysicalMaterial
    | MeshStandardNodeMaterial = new MeshStandardMaterial(),
): {
  readonly surface: WorldImpostorSurface;
  readonly atlas: WorldImpostorAtlas;
} {
  const atlas = new WorldImpostorAtlas(8);
  const surface = new WorldImpostorSurface({
    atlas,
    center: new Vector3(1, 2, 3),
    radius: 2.5,
    source,
  });
  return { surface, atlas };
}

/**
 * The `Fn` body the surface's position node compiles from, read through the same
 * `shaderNode.jsFunc` seam `wave-field.spec.ts` uses. Structural, not a compiled shader: the node
 * unit harness has no WebGPU device, so this proves the gate is *authored* from the world-XZ
 * contract; a real frame proves it renders. Normalised so the vite SSR transform's
 * `(0,__vite_ssr_import_n__.fn)(...)` wrappers read back as `fn(...)`.
 */
function positionGraphSource(surface: WorldImpostorSurface): string {
  const node = surface.material.positionNode as unknown as {
    // r187 TSL returns the call node itself; the r185 proxy wrapper (`.node`) is gone.
    readonly shaderNode?: { readonly jsFunc?: unknown };
  };
  const jsFunc = node.shaderNode?.jsFunc;
  if (typeof jsFunc !== "function") throw new Error("position graph builder missing");
  return String(jsFunc)
    .replace(/__vite_ssr_import_\d+__\./gu, "")
    .replace(/\(0,\s*([A-Za-z_$][\w$]*)\)\(/gu, "$1(");
}

describe("WorldImpostorSurface geometry", () => {
  it("is exactly one two-triangle quad with authored bounds at the baked sphere", () => {
    const { surface, atlas } = makeSurface();
    const position = surface.geometry.getAttribute("position");
    expect(position.count).toBe(4);
    expect(surface.geometry.index?.count).toBe(6);
    expect(surface.quads).toBe(1);
    const box = surface.geometry.boundingBox;
    expect(box?.min.x).toBeCloseTo(1 - 2.5, 6);
    expect(box?.max.y).toBeCloseTo(2 + 2.5, 6);
    expect(surface.geometry.boundingSphere?.center.x).toBeCloseTo(1, 6);
    expect(surface.geometry.boundingSphere?.radius).toBeCloseTo(2.5, 6);
    surface.dispose();
    atlas.dispose();
  });
});

describe("WorldImpostorSurface material", () => {
  it("drops the source's shadow position so the quad casts through its own billboard", () => {
    // A wind-swept source casts its rest pose (`castShadowPositionNode = positionLocal`). Cloned onto the
    // quad, the shadow draw skipped the billboard vertex code, so the fragment's `Rel`/`Dir` varyings were
    // never written: the owned engine lost its renderer (TN_NATIVE_ATTRIBUTE_MISSING) and three cast a unit quad.
    const source = new MeshStandardNodeMaterial({ alphaTest: 0.42 });
    source.castShadowPositionNode = uniform(0) as never;
    const { surface, atlas } = makeSurface(source);
    expect((surface.material as MeshStandardNodeMaterial).castShadowPositionNode).toBeNull();
    surface.dispose();
    atlas.dispose();
  });

  it("drops the source's surface nodes, which read a UV layout the quad does not have", () => {
    // A crown's aoNode and emissiveNode sample its own texture through attribute("uv"): on the quad the
    // owned engine lost its renderer (TN_NATIVE_ATTRIBUTE_MISSING: uv) and three sampled texel (0, 0).
    const source = new MeshStandardNodeMaterial({ alphaTest: 0.42, roughness: 0.6 });
    for (const key of [
      "aoNode",
      "emissiveNode",
      "roughnessNode",
      "metalnessNode",
      "maskNode",
    ] as const)
      Reflect.set(source, key, uniform(0));
    const { surface, atlas } = makeSurface(source);
    const material = surface.material as MeshStandardNodeMaterial;
    for (const key of [
      "aoNode",
      "emissiveNode",
      "roughnessNode",
      "metalnessNode",
      "maskNode",
    ] as const)
      expect(Reflect.get(material, key), key).toBeNull();
    expect(material.roughness).toBeCloseTo(0.6, 6);
    surface.dispose();
    atlas.dispose();
  });

  it("clones the source class, clears its UV maps and wires the atlas nodes", () => {
    const sourceMap = new Texture();
    const source = new MeshStandardMaterial({
      alphaTest: 0.42,
      map: sourceMap,
      metalness: 0.07,
      opacity: 0.5,
      roughness: 0.31,
      vertexColors: true,
    });
    const { surface, atlas } = makeSurface(source);
    const material = surface.material as MeshStandardNodeMaterial;
    expect(material).toBeInstanceOf(MeshStandardNodeMaterial);
    expect(material).not.toBe(source);
    expect((material as unknown as { map?: unknown }).map).toBeNull();
    expect(material.roughness).toBeCloseTo(0.31, 6);
    expect(material.metalness).toBeCloseTo(0.07, 6);
    // The atlas already carries the source colour and coverage; the twin must not apply the
    // source's vertex colours, opacity or opacity node on top of it.
    expect(material.vertexColors).toBe(false);
    expect(material.opacity).toBe(1);
    expect(material.opacityNode).toBeNull();
    expect(material.colorNode).not.toBeNull();
    expect(material.normalNode).not.toBeNull();
    expect(material.positionNode).not.toBeNull();
    expect(material.alphaTestNode).not.toBeNull();
    // The shadow pass copies the number as its own cutoff and ignores `alphaTestNode`: it must stay
    // a tiny positive floor, and the mip-aware discard rides on `maskShadowNode` instead. A 0.42
    // number here discarded every blended fragment in a metres-wide shadow texel.
    expect(material.alphaTest).toBeGreaterThan(0);
    expect(material.alphaTest).toBeLessThan(0.01);
    expect(material.maskShadowNode).not.toBeNull();
    expect(material.userData.tnWholeAssetImpostor).toBe(true);
    expect(source.userData.tnWholeAssetImpostor).toBeUndefined();
    expect(material.transparent).toBe(false);
    expect(material.side).toBe(DoubleSide);
    expect(source.map).toBe(sourceMap);
    expect(source.alphaTest).toBeCloseTo(0.42, 6);
    expect(IMPOSTOR_SURFACE_PARALLAX).toBe(true);
    surface.dispose();
    atlas.dispose();
  });

  it("clears the physical source's UV maps too, because the quad has no uv to sample them with", () => {
    // A transmissive or specular source carries maps three samples through `attribute("uv")`, and the
    // impostor quad is position-only: each one left behind is a build-time
    // `Vertex attribute "uv" not found on geometry` warning per material per render context, for a
    // sample the sampler was already returning as zero.
    const maps = {
      iridescenceThicknessMap: new Texture(),
      specularColorMap: new Texture(),
      specularIntensityMap: new Texture(),
      thicknessMap: new Texture(),
      transmissionMap: new Texture(),
    };
    const source = new MeshPhysicalMaterial({ transmission: 0.5, ...maps });
    const { surface, atlas } = makeSurface(source);
    const material = surface.material as unknown as Record<string, unknown>;
    for (const [name, map] of Object.entries(maps)) {
      expect(material[name]).toBeNull();
      expect((source as unknown as Record<string, unknown>)[name]).toBe(map);
    }
    // The scalar the maps modulate survives: a transmissive source is still transmissive, which is
    // what keeps a bundle from recording this draw.
    expect((surface.material as unknown as MeshPhysicalMaterial).transmission).toBe(0.5);
    surface.dispose();
    atlas.dispose();
  });

  it("disposes only its own geometry and twin, never the borrowed atlas or the source", () => {
    const source = new MeshStandardMaterial();
    const sourceDispose = vi.spyOn(source, "dispose");
    const atlas = new WorldImpostorAtlas(8);
    const atlasDispose = vi.spyOn(atlas, "dispose");
    const targetDispose = vi.spyOn(atlas.target, "dispose");
    const surface = new WorldImpostorSurface({
      atlas,
      center: new Vector3(),
      radius: 1,
      source,
    });
    const geometryDispose = vi.spyOn(surface.geometry, "dispose");
    const materialDispose = vi.spyOn(surface.material, "dispose");
    surface.dispose();
    surface.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(atlasDispose).not.toHaveBeenCalled();
    expect(targetDispose).not.toHaveBeenCalled();
    expect(sourceDispose).not.toHaveBeenCalled();
    atlas.dispose();
  });
});

describe("impostorFrameBasis", () => {
  it("is the exact rotation the baker's orthographic camera built for every view", () => {
    for (const direction of VIEW_DIRECTIONS) {
      const camera = impostorViewCamera(new Vector3(), 1, direction.clone());
      const e = camera.matrixWorld.elements;
      const cameraRight = new Vector3(e[0] as number, e[1] as number, e[2] as number);
      const cameraUp = new Vector3(e[4] as number, e[5] as number, e[6] as number);
      const cameraBack = new Vector3(e[8] as number, e[9] as number, e[10] as number);
      const basis = impostorFrameBasis(direction);
      expect(basis.right.distanceTo(cameraRight)).toBeLessThan(1e-6);
      expect(basis.up.distanceTo(cameraUp)).toBeLessThan(1e-6);
      expect(cameraBack.distanceTo(direction.clone().normalize())).toBeLessThan(1e-6);
    }
  });

  it("stays finite and orthogonal on every view, including the poles", () => {
    for (const direction of VIEW_DIRECTIONS) {
      const { right, up } = impostorFrameBasis(direction);
      expect(Number.isFinite(right.length())).toBe(true);
      expect(right.length()).toBeCloseTo(1, 6);
      expect(up.length()).toBeCloseTo(1, 6);
      expect(right.dot(up)).toBeCloseTo(0, 6);
    }
  });
});

describe("impostorFrameUv", () => {
  // A three render target's texture row 0 is the top of the frame the camera drew (WebGPU writes
  // top-down and three samples it unflipped; WebGL's flip lands the same place), so the texel the
  // bake wrote for NDC y sits at v = 0.5 - y/2. The GL-style 0.5 + y/2 drew every impostor upside down.
  it("projects an offset to the texel the baker's camera wrote it into", () => {
    const center = new Vector3(0.5, -1, 2);
    const radius = 3;
    for (const direction of VIEW_DIRECTIONS) {
      const camera = impostorViewCamera(center.clone(), radius, direction.clone());
      const basis = impostorFrameBasis(direction);
      for (const [cornerX, cornerY] of [
        [0.3, -0.4],
        [-0.7, 0.2],
        [0, 0],
      ] as const) {
        const point = center
          .clone()
          .addScaledVector(basis.right, cornerX * radius)
          .addScaledVector(basis.up, cornerY * radius);
        const ndc = point.clone().project(camera);
        const uv = impostorFrameUv(point.clone().sub(center), basis, radius);
        expect(uv.u).toBeCloseTo(ndc.x * 0.5 + 0.5, 5);
        expect(uv.v).toBeCloseTo(0.5 - ndc.y * 0.5, 5);
      }
    }
  });

  it("maps the centre offset to the middle of the frame", () => {
    const uv = impostorFrameUv(new Vector3(), impostorFrameBasis(VIEW_DIRECTIONS[0] as Vector3), 5);
    expect(uv.u).toBeCloseTo(0.5, 6);
    expect(uv.v).toBeCloseTo(0.5, 6);
  });
});

describe("syncInstanceRanges", () => {
  it("follows the source version and update ranges onto the derived interleaved buffer", () => {
    const source = new InstancedBufferAttribute(new Float32Array(16 * 2), 16);
    const derived = new InstancedInterleavedBuffer(source.array as Float32Array, 16, 1);
    derived.addUpdateRange(0, 16);
    source.addUpdateRange(4, 8);
    source.needsUpdate = true;
    syncInstanceRanges(source, derived);
    expect(derived.array).toBe(source.array);
    expect(derived.version).toBe(source.version);
    expect(derived.updateRanges).toEqual(source.updateRanges);
    // A subsequent clear on the source must clear the derived ranges too, not accumulate them.
    source.clearUpdateRanges();
    source.needsUpdate = true;
    syncInstanceRanges(source, derived);
    expect(derived.updateRanges).toEqual([]);
    expect(derived.version).toBe(source.version);
  });
});

describe("instanceSyncEvent", () => {
  it("typechecks the frame event against the installed Three declarations", () => {
    const file = fileURLToPath(new URL("../src/render/world-impostor-surface.ts", import.meta.url));
    const program = ts.createProgram([file], {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter(({ file: source }) => source?.fileName === file);
    expect(
      diagnostics.map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, "\n")),
    ).toEqual([]);
  }, 20_000);

  // World batches are `static`, and the patched three skips OBJECT node updates of a settled static
  // object: an OBJECT-typed sync never ran, the derived buffer kept its first (zeroed) upload, and
  // every near impostor drew nothing. FRAME is the type three's own `Instance.js` sync uses.
  it("syncs once per frame, the update a settled static object still runs", () => {
    const source = new InstancedBufferAttribute(new Float32Array(16 * 2), 16);
    const derived = new InstancedInterleavedBuffer(source.array as Float32Array, 16, 1);
    const event = instanceSyncEvent(source, derived);
    expect(event.updateType).toBe(NodeUpdateType.FRAME);
    source.needsUpdate = true;
    event.update({} as never);
    expect(derived.version).toBe(source.version);
  });
});

describe("WorldImpostorSurface atlas count", () => {
  it("uses every octahedral layer the baker wrote", () => {
    const atlas = new WorldImpostorAtlas(8);
    const image = atlas.target.textures[0]?.image as { depth?: number } | undefined;
    expect(image?.depth).toBe(IMPOSTOR_VIEWS);
    const surface = new WorldImpostorSurface({
      atlas,
      center: new Vector3(),
      radius: 1,
      source: new MeshStandardMaterial(),
    });
    expect(surface.material.colorNode).not.toBeNull();
    surface.dispose();
    atlas.dispose();
  });
});

describe("WorldImpostorSurface far cull contract", () => {
  it("gates the far surface on the world-XZ distance cullAndSelect uses, never view distance", () => {
    const atlas = new WorldImpostorAtlas(8);
    const far = new WorldImpostorSurface({
      atlas,
      center: new Vector3(1, 2, 3),
      cull: true,
      radius: 2.5,
      source: new MeshStandardMaterial(),
    });
    const source = positionGraphSource(far);
    // The same horizontal world-XZ distance `cullAndSelect` runs — `hypot(at.x - camera.x,
    // at.z - camera.z)` over `placement.centre` — built here from `modelWorldMatrix * instance *
    // center`. An elevated camera must keep a tree still in horizontal range.
    expect(source).toMatch(
      /length\(vec2\([\w$]+\.x\.sub\(cameraPosition\.x\), [\w$]+\.z\.sub\(cameraPosition\.z\)\)\)/u,
    );
    // And that distance is the operand of the gate, not merely declared beside it.
    expect(source).toMatch(/farDistance\.lessThanEqual\(/u);
    // The regression this guards: Euclidean camera-space distance would falsely cull it.
    expect(source).not.toMatch(/length\(centerView\)/u);
    expect(far.cull).toBe(true);
    far.dispose();
    atlas.dispose();
  });
});

// Independent geometric oracle for the covered-continuous crossing contract. Hardware captures
// exercise the actual TSL graph; these controls distinguish intersections from alpha/depth jumps.
function coveredCrossing(
  sample: (t: number) => { alpha: number; gap: number },
  steps = IMPOSTOR_MARCH_STEPS,
  bisections = IMPOSTOR_BISECTION_STEPS,
): number | null {
  let previous = { t: 1.3, ...sample(1.3) };
  for (let i = 1; i <= steps; i++) {
    const current = { t: 1.3 * (1 - (2 * i) / steps), ...sample(1.3 * (1 - (2 * i) / steps)) };
    const before = previous;
    previous = current;
    if (before.alpha <= 0.5 || current.alpha <= 0.5 || before.gap <= 0 || current.gap > 0) continue;
    {
      let front = before.t;
      let back = current.t;
      let valid = true;
      for (let j = 0; j < bisections; j++) {
        const mid = (front + back) / 2;
        const value = sample(mid);
        if (value.alpha <= 0.5) valid = false;
        if (value.gap > 0) front = mid;
        else back = mid;
      }
      const hit = (front + back) / 2;
      const value = sample(hit);
      if (valid && value.alpha > 0.5 && Math.abs(value.gap) <= (2 * 1.3) / 255 / value.alpha)
        return hit;
    }
  }
  return null;
}

describe("covered continuous depth geometry controls", () => {
  it("recovers an oblique plane UV where orthogonal projection is wrong", () => {
    const hit = coveredCrossing((t) => ({ alpha: 1, gap: (t - 0.75) / Math.sqrt(3) }));
    expect(hit).not.toBeNull();
    expect(hit as number).toBeCloseTo(0.75, 4);
    const expected = (0.6 - 0.75) / Math.sqrt(2);
    expect((0.6 - (hit as number)) / Math.sqrt(2)).toBeCloseTo(expected, 4);
    expect(Math.abs(0.6 / Math.sqrt(2) - expected)).toBeGreaterThan(0.5);
  });
  it("places a crossing as tightly at the shipped coarse march as at one step per baked texel", () => {
    // A quarter of the 128-texel steps, so the march costs a quarter of the atlas reads; two more
    // bisection steps keep the crossing as precise as the old 128 x 8.
    expect(IMPOSTOR_MARCH_STEPS).toBeLessThanOrEqual(32);
    const plane = (t: number) => ({ alpha: 1, gap: (t - 0.3141) / Math.sqrt(3) });
    expect(coveredCrossing(plane) as number).toBeCloseTo(
      coveredCrossing(plane, 128, 8) as number,
      4,
    );
    expect(coveredCrossing(plane) as number).toBeCloseTo(0.3141, 4);
  });
  it("rejects late coverage behind an alpha hole", () => {
    expect(coveredCrossing((t) => ({ alpha: t < -0.4 ? 1 : 0, gap: t }))).toBeNull();
  });
  it("rejects a depth discontinuity with no surface crossing", () => {
    expect(coveredCrossing((t) => ({ alpha: 1, gap: t > 0 ? 1 : -1 }))).toBeNull();
  });
});

it.each([MeshStandardMaterial, MeshStandardNodeMaterial])(
  "partitions every dither pixel with opposite comparisons in both render passes",
  (MaterialClass) => {
    const eye = uniform(new Vector3());
    const source = new MaterialClass({ alphaTest: 0.42 });
    const near = worldLodMaterial(source, new Matrix4(), [0, 60], 0, 0.2, eye, uniform(1), false);
    const far = worldLodMaterial(source, new Matrix4(), [0, 60], 1, 0.2, eye, uniform(1), false);
    expect(near.alphaTest).toBe(source.alphaTest);
    expect(far.alphaTest).toBe(source.alphaTest);
    const comparisons = (material: typeof near) => {
      const fades: Array<{ op: string; noise: unknown; mix: unknown }> = [];
      material.maskNode?.traverse((node) => {
        const op = Reflect.get(node, "op");
        if (op === "<" || op === ">=")
          fades.push({
            op,
            noise: Reflect.get(node, "aNode"),
            mix: Reflect.get(node, "bNode"),
          });
      });
      return fades;
    };
    const operators = (material: typeof near) =>
      comparisons(material)
        .map((fade) => fade.op)
        .sort();
    // One structure for every level: the level is a uniform, so both build one shader program.
    expect(operators(near)).toEqual(["<", ">="]);
    expect(operators(far)).toEqual(operators(near));
    const levels = (material: typeof near) => {
      const values: unknown[] = [];
      material.maskNode?.traverse((node) => {
        if (
          Reflect.get(node, "isUniformNode") === true &&
          typeof Reflect.get(node, "value") === "number"
        )
          values.push(Reflect.get(node, "value"));
      });
      return values;
    };
    expect(levels(near)).toContain(0);
    expect(levels(far)).toContain(1);
    expect(levels(near)).toContain(60);
    expect(near.userData.tnPublishedLodRange).toBeUndefined();
    expect(far.userData.tnPublishedLodRange).toBeUndefined();
    expect(near.maskShadowNode).toBe(near.maskNode);
    expect(far.maskShadowNode).toBe(far.maskNode);
    // A dither pixel holds exactly one side of a fade because both sides read this one noise and
    // one mix, exact equality included: a second mix would draw a band in both levels, a second
    // noise would drop one, and either keeps the operator check above green.
    for (const material of [near, far]) {
      const fades = comparisons(material);
      const fadeIn = fades.find((fade) => fade.op === "<");
      const fadeOut = fades.find((fade) => fade.op === ">=");
      expect(fadeIn).toBeDefined();
      expect(fadeOut).toBeDefined();
      expect(fadeIn?.noise).toBe(fadeOut?.noise);
      expect(fadeIn?.mix).toBe(fadeOut?.mix);
    }
    near.dispose();
    far.dispose();
    source.dispose();
  },
);

it("opts CPU LOD masks into published per-instance ranges", () => {
  const source = new MeshStandardMaterial();
  const material = worldLodMaterial(
    source,
    new Matrix4(),
    [0, 60],
    0,
    0.2,
    uniform(new Vector3()),
    uniform(1),
    false,
    true,
  );
  expect(material.userData.tnPublishedLodRange).toBe(true);
  expect(material.maskNode).toBeDefined();
  // One varying node, which the mask reads more than once (`.x`, `.y`).
  const publishedRangeInterpolations = new Map<unknown, unknown>();
  material.maskNode?.traverse((node) => {
    if (Reflect.get(node, "isVaryingNode") !== true) return;
    const varyingSource = Reflect.get(node, "node");
    if (varyingSource === null || typeof varyingSource !== "object") return;
    const attributeSource = Reflect.get(varyingSource, "node");
    if (attributeSource === null || typeof attributeSource !== "object") return;
    const getAttributeName = Reflect.get(attributeSource, "getAttributeName");
    if (
      typeof getAttributeName === "function" &&
      getAttributeName.call(attributeSource) === "tnPublishedLodRange"
    ) {
      publishedRangeInterpolations.set(node, Reflect.get(node, "interpolationType"));
    }
  });
  expect([...publishedRangeInterpolations.values()]).toEqual(["flat"]);
  expect(material.maskShadowNode).toBe(material.maskNode);
  material.dispose();
  source.dispose();
});

it("fades a published level change in the colour pass only", () => {
  const source = new MeshStandardMaterial();
  const clock = uniform(0);
  const material = worldLodMaterial(
    source,
    new Matrix4(),
    [0, 60],
    0,
    0.2,
    uniform(new Vector3()),
    uniform(1),
    false,
    true,
    clock,
  );
  const reaches = (root: unknown): boolean => {
    let found = false;
    (root as { traverse(visit: (node: unknown) => void): void }).traverse((node) => {
      if (node === clock) found = true;
    });
    return found;
  };
  expect(reaches(material.maskNode), "the colour mask reads the fade clock").toBe(true);
  expect(reaches(material.maskShadowNode), "shadows take the new answer at once").toBe(false);
  material.dispose();
  source.dispose();
});

it("Strata shadow cutout uses the view sampled alpha and mip-adjusted threshold", async () => {
  const { loadPack } = await import("../../../examples/strata-terrain-preview/src/render/pack.js");
  const { createAssetLoader } = await import("../src/assets.js");
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  vi.spyOn(assets, "texture").mockRejectedValue(new Error("optional texture absent"));
  const source = new MeshStandardMaterial({ map: new Texture(), alphaTest: 0.42 });
  vi.spyOn(assets, "model").mockImplementation(async (path) => {
    if (path !== "temperate/spruce/0.glb") throw new Error("optional model absent");
    return { scene: new Group().add(new Mesh(new BoxGeometry(), source)) } as never;
  });
  const pack = await loadPack(assets);
  try {
    const material = pack.parts.get("spruce:0")?.[0]?.material as MeshStandardNodeMaterial;
    expect(material).toBeTruthy();
    const wrapped = material.maskShadowNode as unknown as {
      op: string;
      aNode: { components: string; node: unknown };
      bNode: unknown;
    };
    // The cutout compares the alpha this pass sampled (the atlas alpha, not its colour) with the
    // mip-adjusted threshold, so a far card's shadow rejects the blurred background its own alpha
    // mip carries. Since 99757e4ec the mask IS that comparison, so it is read directly; the colour
    // pass multiplies the same sample into `opacityNode` (wrapped in the sight halo since 919c1a866).
    expect(wrapped.op).toBe(">");
    expect(wrapped.aNode.components).toBe("w");
    expect(wrapped.aNode.node).toBe(
      (material.opacityNode as unknown as { aNode: { node: unknown } }).aNode.node,
    );
    expect(wrapped.bNode).toBe(material.alphaTestNode);
    expect(material.alphaTest).toBe(0.42);
    expect(material.userData.tnImpostorAlphaTest).toBe(0.42);
  } finally {
    pack.dispose();
    source.dispose();
  }
});
