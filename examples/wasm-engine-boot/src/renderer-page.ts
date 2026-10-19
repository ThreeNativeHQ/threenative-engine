/**
 * PRD-540 phase 2: three alone on the Wasm engine. Under `engine: "threenative"` these imports are the
 * engine's classes and `WebGPURenderer` is its facade; the scenario reads what the engine drew.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  AnimationClip,
  AnimationMixer,
  BoxGeometry,
  Data3DTexture,
  DataTexture,
  DirectionalLight,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LoopOnce,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  OrthographicCamera,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PropertyBinding,
  RenderTarget,
  Scene,
  SphereGeometry,
  UnsignedByteType,
  setConsoleFunction,
} from "three";
import {
  Fn,
  If,
  attribute,
  cameraFar,
  cameraNear,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  positionLocal,
  screenUV,
  texture,
  texture3D,
  uniform,
  uv,
  vec3,
  vec4,
  viewportLinearDepth,
  viewportSharedTexture,
} from "three/tsl";
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from "three/webgpu";

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/iu;
const probe = {
  adapter: "",
  software: true,
  frames: 0,
  draws: 0,
  triangles: 0,
  error: "",
  /** The engine's refusal of a tone mapping it does not implement (three's CustomToneMapping, 5). */
  refusal: "",
  /** Runs of the tint uniform's onRenderUpdate: once per render, as Midway's ripple texture sync. */
  renderUpdates: 0,
  /** core's clip audit on the Wasm engine: track paths bound and refused through PropertyBinding. */
  trackAudit: "",
  /** AnimationMixer "finished" events on the Wasm engine, as core's AnimationPlayer listens. */
  finished: 0,
  ticks: 0,
  /**
   * Setup work added since frame 10 (the scenario's warm-up): pipeline compiles, pipeline text-key
   * lookups, bind groups, graph-key serializations and programs. A steady frame adds none; -1 until
   * frame 10 has drawn.
   */
  steadyCompiles: -1,
  steadyTextKeys: -1,
  steadyBindGroups: -1,
  steadyGraphKeys: -1,
  steadyPrograms: -1,
  /** PRD-551: a QuadMesh's flat colour read back from a HalfFloat target (half bits) and a byte target. */
  targetHalf: "",
  targetBytes: "",
  /** PRD-545: an InstancedBufferGeometry's 4x1 strip, RGBA bytes per column. */
  instancedStrip: "",
  /** PRD-545: an InstancedMesh strip before and after instanceColor is assigned. */
  instanceColorSet: "",
  /** PRD-546: texture3D reads slice 1 of a 4x1x2 Data3DTexture across a 4x1 strip. */
  volumeStrip: "",
};
const started = performance.now();

Object.assign(globalThis, {
  __THREENATIVE_PLAYTEST_BRIDGE__: {
    describe: () => ({
      name: "wasm-engine-renderer",
      protocolVersion: 1,
      capabilities: ["runtime.components", "runtime.fixedStep"],
      limits: {
        maxEntitiesPerSample: 100,
        maxEventsPerDrain: 1000,
        maxPayloadBytes: 1000000,
        operationTimeoutMs: 5000,
      },
    }),
    ready: async () => {
      while (probe.frames < 1 && probe.error === "")
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { ready: true };
    },
    advance: async (count: number) => {
      const target = probe.ticks + count;
      while (probe.ticks < target && probe.error === "")
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { clock: { mode: "fixed-step", tick: probe.ticks }, ticks: count };
    },
    sample: () => ({
      clock: { mode: "fixed-step", tick: probe.ticks, timeMs: performance.now() - started },
      components: { "wasm-renderer": { probe: { ...probe } } },
    }),
  },
});

try {
  const canvas = document.querySelector<HTMLCanvasElement>("#c");
  if (canvas === null) throw new Error("Missing #c canvas.");
  const renderer = new WebGPURenderer({ canvas });
  renderer.setSize(640, 360, false);
  await renderer.init();
  const info = (
    renderer as unknown as { backend: { gpu: { requestAdapter(): Promise<{ info: object }> } } }
  ).backend.gpu;
  const facts = Object.values((await info.requestAdapter()).info).join(" ");
  probe.adapter = facts;
  probe.software = SOFTWARE.test(facts) || facts.trim() === "";

  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 640 / 360, 0.1, 100);
  camera.position.set(0, 1.5, 4);
  camera.lookAt(0, 0, 0);
  const box = new Mesh(
    new BoxGeometry(1.6, 1.6, 1.6),
    new MeshStandardMaterial({ color: 0xff8030 }),
  );
  box.position.x = -1;
  // A TSL graph through the engine's shared name table: Midway's first TSL call is `uniform(0)`.
  const tint = uniform(0.5);
  (tint as unknown as { onRenderUpdate(callback: () => void): void }).onRenderUpdate(() => {
    probe.renderUpdates += 1;
  });
  const tinted = new MeshBasicNodeMaterial();
  // The same colour through Fn and r185's compound assigns, as Midway's water effects accumulate.
  tinted.colorNode = Fn(() => {
    const green = tint.mul(0.5).toVar();
    green.addAssign(tint.mul(0.5));
    // Midway's ocean takes screen-space derivatives; zero-weighted so the colour is unchanged.
    green.addAssign(uv().dFdx().x.add(uv().dFdy().lengthSq()).mul(0));
    // Midway's fog reads the camera planes; zero-weighted too.
    green.addAssign(cameraFar.sub(cameraNear).mul(0));
    // r185's clamp() with its default bounds, as WaterSurface3D clamps; green stays inside 0..1.
    green.assign(green.clamp());
    const blue = tint.toVar();
    blue.mulAssign(1.6);
    return vec4(tint.mul(0.2), green, blue, 1);
  })();
  const tile = new Mesh(new BoxGeometry(1, 1, 1), tinted);
  tile.position.x = 1.2;
  // A smooth sphere: its shading gradient keeps every capture far from a flat, near-blank frame.
  // Its checker map is a texture upload (queue.writeTexture) out of the engine's Wasm memory.
  const checker = new DataTexture(
    new Uint8Array(
      Array.from({ length: 16 }, (_, i) =>
        (i + (i >> 2)) % 2 ? [255, 255, 255, 255] : [40, 40, 40, 255],
      ).flat(),
    ),
    4,
    4,
  );
  checker.needsUpdate = true;
  const ball = new Mesh(
    new SphereGeometry(0.45, 32, 16),
    new MeshStandardMaterial({ color: 0xf0e0c0, map: checker }),
  );
  // three's copy reads x, y and z: a plain object places it, as Midway's audio cues do.
  ball.position.copy({ x: 0.15, y: -0.9, z: 0.6 } as never);
  // texture(textureObject, uv) on an unnamed DataTexture, as Midway's ocean: a level-0 vertex read
  // at the local xz (Midway's positionWorld.xz swizzle) displaces the slab and a fragment read
  // colours it.
  const pixels = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; ++i) pixels.set([(i % 4) * 80, Math.floor(i / 4) * 80, 160, 255], i * 4);
  const grid = new DataTexture(pixels, 4, 4);
  grid.needsUpdate = true;
  const textured = new MeshBasicNodeMaterial();
  textured.positionNode = positionLocal.add(
    vec3(0, texture(grid, positionLocal.xz.add(0.5)).level(float(0)).r.mul(0.2), 0),
  );
  // A texture sampled inside an If, as WaterSurface3D's refraction is: legal in three's shaders,
  // which turn the derivative-uniformity check off. The branch never runs, so the colour is unchanged.
  textured.colorNode = Fn(() => {
    const colour = texture(grid, uv()).rgb.toVar();
    If(uv().x.greaterThan(2), () => {
      colour.assign(texture(grid, uv().mul(2)).rgb);
    });
    return vec4(colour, 1);
  })();
  const slab = new Mesh(new BoxGeometry(0.8, 0.3, 0.8, 4, 1, 4), textured);
  slab.position.set(-1.2, -0.9, 0.4);
  // WaterSurface3D's reads on the Wasm engine: a transparent pane over the ball shows the frame
  // behind it (viewportSharedTexture) tinted by its linear depth (viewportLinearDepth).
  const glass = new MeshBasicNodeMaterial({ transparent: true });
  glass.colorNode = vec4(
    viewportSharedTexture(screenUV)
      .rgb.mul(vec3(0.6, 0.9, 1))
      .add(vec3(0, 0, viewportLinearDepth.mul(0.3))),
    1,
  );
  const pane = new Mesh(new BoxGeometry(0.9, 0.6, 0.02), glass);
  pane.position.set(0.15, -0.75, 1.3);
  // Midway's particle batches: an InstancedBufferGeometry quad, its per-instance offsets read by a
  // TSL attribute() in a material.vertexNode (clip space). Three of four instances draw.
  const quad = new PlaneGeometry(1, 1);
  const sparks = new InstancedBufferGeometry();
  const quadIndex = quad.getIndex();
  if (quadIndex === null) throw new Error("PlaneGeometry has an index");
  sparks.setIndex(quadIndex.clone());
  sparks.setAttribute("position", quad.getAttribute("position").clone());
  sparks.setAttribute(
    "aOffset",
    new InstancedBufferAttribute(
      new Float32Array([1.6, 1.1, 0, 2, 1.1, 0, 2.4, 1.1, 0, 0, 0, 0]),
      3,
    ),
  );
  sparks.instanceCount = 3;
  const sparkMaterial = new MeshBasicNodeMaterial();
  sparkMaterial.vertexNode = cameraProjectionMatrix.mul(
    cameraViewMatrix.mul(vec4(positionLocal.mul(0.25).add(attribute("aOffset", "vec3")), 1)),
  );
  sparkMaterial.colorNode = vec4(1, 0.8, 0.2, 1);
  const sparkMesh = new Mesh(sparks, sparkMaterial);
  scene.add(box, tile, ball, slab, pane, sparkMesh);
  box.name = "box";
  // What core's clip audit asks before a model's clips play: a track on a named node binds, one on a
  // missing node is reported through three's console function.
  const refused: string[] = [];
  setConsoleFunction((type: string, message: string) => refused.push(`${type}:${message}`));
  const parsed = PropertyBinding.parseTrackName("box.position");
  new PropertyBinding(scene, "box.position").bind();
  new PropertyBinding(scene, "nobody.quaternion").bind();
  setConsoleFunction(null as never);
  probe.trackAudit = `${parsed.nodeName}/${parsed.propertyName} ${String(refused.length)} refused`;
  // A one-shot clip: the engine's mixer reports "finished" to a JS listener.
  const mixer = new AnimationMixer(scene);
  // Half a second: it finishes inside the scenario, after the warm-up frames.
  const nudge = new AnimationClip("nudge", 0.5, [
    new NumberKeyframeTrack("box.position[y]", [0, 0.5], [0, 0]),
  ]);
  // MathUtils as Midway calls it, on the namespace: clamp keeps the weight inside 0..1.
  mixer
    .clipAction(nudge)
    .setLoop(LoopOnce, 1)
    .setEffectiveWeight(MathUtils.clamp(2, 0, 1))
    .play();
  mixer.addEventListener("finished", () => {
    probe.finished += 1;
  });
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(3, 5, 4);
  scene.add(sun, new AmbientLight(0xffffff, 0.4));
  renderer.setClearColor(0x102030, 1);
  // PRD-551: a QuadMesh draws (0.25, 0.5, 0.75) into two render targets, read back typed as three types them.
  const flat = new MeshBasicNodeMaterial();
  flat.colorNode = vec4(0.25, 0.5, 0.75, 1);
  const screenQuad = new QuadMesh(flat);
  const halfTarget = new RenderTarget(4, 4, { type: HalfFloatType });
  const byteTarget = new RenderTarget(4, 4, { type: UnsignedByteType });
  for (const target of [halfTarget, byteTarget]) {
    renderer.setRenderTarget(target);
    screenQuad.render(renderer);
  }
  renderer.setRenderTarget(null);
  const [halfPixels, bytePixels] = await Promise.all([
    renderer.readRenderTargetPixelsAsync(halfTarget, 1, 1, 1, 1),
    renderer.readRenderTargetPixelsAsync(byteTarget, 0, 0, 1, 1),
  ]);
  probe.targetHalf = `${halfPixels.constructor.name}:${Array.from(halfPixels).join(",")}`;
  probe.targetBytes = `${bytePixels.constructor.name}:${Array.from(bytePixels).join(",")}`;
  // PRD-545: one unit-wide quad per pixel column of a 4x1 target, through an orthographic camera.
  const columns = new OrthographicCamera(0, 4, 1, 0, -1, 1);
  const unit = new PlaneGeometry(1, 1);
  const drawStrip = async (root: Scene): Promise<string> => {
    const strip = new RenderTarget(4, 1, { type: UnsignedByteType });
    renderer.setRenderTarget(strip);
    renderer.render(root, columns);
    renderer.setRenderTarget(null);
    return Array.from(await renderer.readRenderTargetPixelsAsync(strip, 0, 0, 4, 1)).join(",");
  };
  // InstancedBufferGeometry draws instanceCount (3) of its 4 instances; TSL attribute() reads each
  // instance's offset and tint. The fourth (white) instance must not draw.
  const strip = new InstancedBufferGeometry();
  const unitIndex = unit.getIndex();
  if (unitIndex === null) throw new Error("PlaneGeometry has an index");
  strip.setIndex(unitIndex.clone());
  strip.setAttribute("position", unit.getAttribute("position").clone());
  strip.setAttribute(
    "aOffset",
    new InstancedBufferAttribute(
      new Float32Array([0.5, 0.5, 0, 1.5, 0.5, 0, 2.5, 0.5, 0, 3.5, 0.5, 0]),
      3,
    ),
  );
  strip.setAttribute(
    "aTint",
    new InstancedBufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]), 3),
  );
  strip.instanceCount = 3;
  const stripMaterial = new MeshBasicNodeMaterial();
  stripMaterial.vertexNode = cameraProjectionMatrix.mul(
    cameraViewMatrix.mul(vec4(positionLocal.add(attribute("aOffset", "vec3")), 1)),
  );
  stripMaterial.colorNode = vec4(attribute<"vec3">("aTint", "vec3"), 1);
  const stripScene = new Scene();
  stripScene.add(new Mesh(strip, stripMaterial));
  probe.instancedStrip = await drawStrip(stripScene);
  // InstancedMesh.instanceColor assigned as a new InstancedBufferAttribute after a drawn frame
  // (Midway's tracers): the next frame shows the colours.
  const colored = new InstancedMesh(unit, new MeshBasicNodeMaterial(), 4);
  for (let i = 0; i < 4; i++) {
    colored.setMatrixAt(i, new Matrix4().makeTranslation(i + 0.5, 0.5, 0));
  }
  const coloredScene = new Scene();
  coloredScene.add(colored);
  const uncolored = await drawStrip(coloredScene);
  colored.instanceColor = new InstancedBufferAttribute(
    new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    3,
  );
  probe.instanceColorSet = `${uncolored}|${await drawStrip(coloredScene)}`;
  // A Data3DTexture (nearest): texel (x, 0, z) is (80x, 255z, 0). One quad spans the strip, so column
  // x samples texel x, and w 0.75 is slice 1.
  const volumeTexels = new Uint8Array(4 * 1 * 2 * 4);
  for (let z = 0; z < 2; z++)
    for (let x = 0; x < 4; x++) volumeTexels.set([x * 80, z * 255, 0, 255], (z * 4 + x) * 4);
  const volume = new Data3DTexture(volumeTexels, 4, 1, 2);
  volume.needsUpdate = true;
  const volumeMaterial = new MeshBasicNodeMaterial();
  volumeMaterial.colorNode = vec4(texture3D(volume, vec3(uv().x, 0.5, 0.75)).rgb, 1);
  const volumeQuad = new Mesh(new PlaneGeometry(4, 1), volumeMaterial);
  volumeQuad.position.set(2, 0.5, 0);
  const volumeScene = new Scene();
  volumeScene.add(volumeQuad);
  probe.volumeStrip = await drawStrip(volumeScene);
  // Midway's renderer settings: they reach the engine before each frame, as on the V8 player.
  renderer.toneMapping = 5;
  try {
    renderer.render(scene, camera);
  } catch (error) {
    probe.refusal = error instanceof Error ? error.message : String(error);
  }
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  // The engine's setup-work counters (three-native's renderer.info.engine; not in three's Info type).
  type EngineCounters = Record<
    "compiles" | "textLookups" | "bindGroups" | "graphKeys" | "programs",
    number
  >;
  let baseline: EngineCounters | undefined;
  const frame = () => {
    probe.ticks += 1;
    box.rotation.y += 0.02;
    mixer.update(1 / 60);
    // Written every frame, as Midway writes its clock: the engine updates the uniform, no recompile.
    tint.value = 0.5 + 0.3 * Math.sin(probe.ticks * 0.05);
    try {
      renderer.render(scene, camera);
      probe.frames += 1;
      probe.draws = renderer.info.render.drawCalls;
      probe.triangles = renderer.info.render.triangles;
      const engine = (renderer.info as unknown as { engine: EngineCounters }).engine;
      if (probe.frames === 10) baseline = { ...engine };
      if (baseline !== undefined) {
        probe.steadyCompiles = engine.compiles - baseline.compiles;
        probe.steadyTextKeys = engine.textLookups - baseline.textLookups;
        probe.steadyBindGroups = engine.bindGroups - baseline.bindGroups;
        probe.steadyGraphKeys = engine.graphKeys - baseline.graphKeys;
        probe.steadyPrograms = engine.programs - baseline.programs;
      }
      requestAnimationFrame(frame);
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
    }
  };
  requestAnimationFrame(frame);
} catch (error) {
  probe.error = error instanceof Error ? error.message : String(error);
}
