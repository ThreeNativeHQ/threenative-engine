import {
  AmbientLight,
  BackSide,
  BatchedMesh,
  BoxGeometry,
  Color,
  Data3DTexture,
  DataTexture,
  DataUtils,
  DirectionalLight,
  EquirectangularReflectionMapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshLambertNodeMaterial,
  MeshStandardMaterial,
  NearestFilter,
  PointLight,
  RenderPipeline,
  RenderTarget,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  StorageBufferAttribute,
  Vector3,
} from "three";
import {
  Fn,
  attribute,
  cameraFar,
  cameraNear,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  convertToTexture,
  depth,
  float,
  instanceIndex,
  instancedArray,
  length,
  linearDepth,
  max,
  metalness,
  mrt,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalGeometry,
  normalView,
  normalViewGeometry,
  normalWorld,
  normalWorldGeometry,
  normalize,
  output,
  pass,
  pmremTexture,
  positionGeometry,
  positionLocal,
  positionViewDirection,
  positionWorld,
  reflector,
  roughness,
  screenUV,
  sin,
  smoothstep,
  storage,
  texture,
  texture3D,
  transformNormalToView,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
  viewportLinearDepth,
  viewportSharedTexture,
} from "three/tsl";
import { clone as cloneSkinned } from "/addons/SkeletonUtils.js";
import { FluidParticles3D } from "/core/fluid-particles.js";
/**
 * The TSL programs a render fixture's `tsl` op applies, authored in upstream TSL. Each has a C++
 * twin of the same name in runtime-native/tests/native-engine/fixture/tsl_programs.h, authored with
 * the native TSL builder; the fixture's golden is what this one draws.
 */
import { GPUParticles3D } from "/core/particles.js";

/**
 * PRD-513: a post pass over the scene texture: a 2-texel chromatic split (texel centres, so the
 * sampler's filter cannot matter) and a radial vignette, before the output transform.
 */
function chromatic(renderer, scene, camera) {
  const pipeline = new RenderPipeline(renderer);
  const color = pass(scene, camera).getTextureNode();
  const offset = vec2(2 / 320, 0);
  const r = color.sample(screenUV.add(offset)).x;
  const g = color.sample(screenUV).y;
  const b = color.sample(screenUV.sub(offset)).z;
  const vignette = float(1).sub(length(screenUV.sub(0.5)).mul(0.6));
  pipeline.outputNode = vec4(vec3(r, g, b).mul(vignette), 1);
  return pipeline;
}

/** mulberry32: the seeded Math.random the native port draws DenoiseNode's noise permutation from. */
function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * PRD-531 slice 4: three r185's post addons over one scene pass, composed as the minimal template's
 * WorldEnvironment composes them; the native twin builds the same graph live.
 */
async function postAddons(program, renderer, scene, camera) {
  const [{ ao }, { denoise }, { bloom }, { smaa }] = await Promise.all([
    import("/addons/tsl/display/GTAONode.js"),
    import("/addons/tsl/display/DenoiseNode.js"),
    import("/addons/tsl/display/BloomNode.js"),
    import("/addons/tsl/display/SMAANode.js"),
  ]);
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: normalView, metalness, roughness }));
  const depth = scenePass.getTextureNode("depth");
  const normal = scenePass.getTextureNode("normal");
  const colour = scenePass.getTextureNode("output");
  const peak = (c) => max(c.r, max(c.g, c.b));
  const occlusion = (input) => {
    const contact = ao(depth, normal, camera);
    contact.radius.value = 0.35;
    const random = Math.random;
    Math.random = mulberry32(1);
    try {
      return input.mul(denoise(contact.getTextureNode(), depth, normal, camera).r);
    } finally {
      Math.random = random;
    }
  };
  const tables = [];
  const antialias = (input) => {
    const squeezed = input.div(peak(input).add(1));
    const filtered = smaa(squeezed);
    tables.push(filtered._areaTexture, filtered._searchTexture);
    return filtered.div(float(1).sub(peak(filtered)).max(1e-4));
  };
  let node;
  // Written after the first frame, as a game's settings menu or a per-frame driver writes them; the
  // captured second frame must show the new values.
  let afterFirstFrame;
  if (program === "post-live-parameters") {
    const contact = ao(depth, normal, camera);
    contact.radius.value = 0.35;
    const glow = bloom(colour, 0.7, 0.5, 0.2);
    node = colour.mul(contact.getTextureNode().r).add(glow);
    afterFirstFrame = () => {
      contact.resolutionScale = 0.5;
      glow.strength.value = 0.3;
      glow.radius.value = 0.9;
      glow.threshold.value = 0.8;
    };
  } else if (program === "post-uniform-write") {
    const gain = uniform(0.25);
    const lift = uniform(0.4);
    node = convertToTexture(colour.mul(lift)).mul(gain);
    afterFirstFrame = () => {
      gain.value = 1;
      lift.value = 1.5;
    };
  } else if (program === "post-ao") node = occlusion(colour);
  else if (program === "post-ao-raw") {
    const contact = ao(depth, normal, camera);
    contact.radius.value = 0.35;
    node = colour.mul(contact.getTextureNode().r);
  } else if (program === "post-bloom") node = colour.add(bloom(colour, 0.7, 0.5, 0.2));
  else if (program === "post-smaa") node = antialias(colour);
  else {
    let input = occlusion(colour.mul(0.62));
    input = input.add(bloom(convertToTexture(input), 0.22, 0.6, 1));
    const radius = screenUV.sub(vec2(0.5, 0.5)).mul(vec2(1.78, 1)).length().mul(1.04);
    const fall = smoothstep(float(0.55), float(1.02), radius).mul(0.22);
    node = antialias(input.mul(fall.oneMinus()));
  }
  // SMAANode decodes its two lookup tables asynchronously; the captured frame must have them.
  for (const table of tables) {
    await table.image.decode();
    table.needsUpdate = true;
  }
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = node;
  if (afterFirstFrame) {
    pipeline.render();
    await renderer.backend.device.queue.onSubmittedWorkDone();
    afterFirstFrame();
  }
  return { render: () => pipeline.render() };
}

export const GRID_COUNT = 10_000;

const PARTICLE_COUNT = 12;
const PARTICLE_STEPS = 10;

// Game-owned appearance deliberately varies over UVs; the native twin consumes this same graph.
function particleMaterial(material) {
  material.colorNode = vec4(uv(), 0.35, 1);
  material.opacityNode = float(0.8);
}
function replaceSprite(target, sprite, scene) {
  sprite.position.copy(target.position);
  sprite.quaternion.copy(target.quaternion);
  sprite.scale.copy(target.scale);
  sprite.center.copy(target.center);
  sprite.frustumCulled = false;
  scene.remove(target);
  scene.add(sprite);
}

/** Drive the shipped game API, never an ordinary directional shadow disguised as VSM. */
async function virtualShadow({ target, renderer, scene, camera }, cut = false) {
  const { VirtualShadowNode } = await import("/core/virtual-shadow.js");
  target.shadow.shadowNode = new VirtualShadowNode(target, {
    clipExtents: [8, 24],
    mapSize: 256,
    lightDistance: 20,
    depthRange: 40,
    selectionGuard: 0.9,
    refreshStep: 0,
    invalidationDelay: 0,
    adaptiveRefresh: false,
    adaptiveCasterGate: false,
    minCasterTexels: 0,
    followViewFocus: false,
    receiverPlaneBias: true,
    shadowLodBias: false,
    marker: false,
  });
  // Warm both levels at the capture's eye position: a rotation cut must reuse these page keys.
  for (let i = 0; i < 2; ++i) {
    renderer.render(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
  }
  if (cut) {
    // Index-only edits leave caster bounds/position versions intact. Cached maps still hold
    // the wide box; a fresh map sees only degenerate triangles, leaving the floor unshadowed.
    const geometry = scene.getObjectByName("cutCaster").geometry;
    geometry.setIndex(new Array(geometry.index.count).fill(0));
    camera.lookAt(0, 0.4, 0);
    camera.updateMatrixWorld(true);
    target.shadow.shadowNode.invalidateAll();
  }
}

/** Real static captures and material sampling through the game's shipped ProbeVolume API. */
async function probeLighting({ renderer, scene, camera, width, height }, mode) {
  const { ProbeVolume } = await import("/core/probe-volume.js");
  const captureCounts = new WeakMap();
  const raw = new Proxy(renderer, {
    get(target, key) {
      if (key === "render")
        return (capture, view) => {
          captureCounts.set(capture, (captureCounts.get(capture) ?? 0) + 1);
          return target.render(capture, view);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set: (target, key, value) => Reflect.set(target, key, value, target),
  });
  const attached = {
    kind: "webgpu",
    raw,
    compileAsync: (capture, view) => renderer.compileAsync(capture, view),
  };
  const volume = () =>
    new ProbeVolume({
      bounds: { min: new Vector3(-0.5, -0.5, -0.5), max: new Vector3(0.5, 0.5, 0.5) },
      density: 1,
      cubemapSize: 8,
      near: 0.1,
      far: 20,
      bounces: 1,
      bakeBudgetMs: 1000,
      maxWorkItemsPerFrame: 1,
      report: () => {},
    });
  const capture = (probes) => {
    const captureScene = new Scene();
    const material = new MeshLambertNodeMaterial({ color: 0xffffff, side: BackSide });
    material.emissiveNode = probes.sample().div(Math.PI);
    captureScene.add(new Mesh(new BoxGeometry(6, 6, 6), material));
    const light = new PointLight(0xffffff, 32, 0, 2);
    light.color.setRGB(0.2, 0.8, 1);
    light.position.set(-1, 0, 1);
    captureScene.add(light);
    captureScene.updateMatrixWorld(true);
    return { scene: captureScene, light };
  };
  const bind = (probes, name, center) => {
    scene.getObjectByName(name).material.emissiveNode = probes
      .sampleNode(positionWorld.sub(vec3(center, 0, 0)), normalWorld)
      .div(Math.PI);
  };
  const converge = async (probes, pending) => {
    for (let frame = 0; frame < 1000 && probes.observation.status !== "ready"; ++frame) {
      probes.process(attached);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (probes.observation.status !== "ready") throw new Error("probe fixture did not converge");
    await pending;
  };
  const snapshot = async () => {
    const snapshotTarget = new RenderTarget(width, height);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(snapshotTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
    const pixels = await renderer.readRenderTargetPixelsAsync(snapshotTarget, 0, 0, width, height);
    snapshotTarget.dispose();
    return pixels;
  };
  const requireSignal = (pixels) => {
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 8) lit += 1;
    if (lit <= width * height * 0.02)
      throw new Error("probe fixture has no discriminating irradiance");
  };
  const affected = volume();
  const unaffected = volume();
  bind(affected, "probeReceiver", -1.1);
  bind(unaffected, "unaffectedReceiver", 1.1);
  if (mode === "baked") {
    for (const probes of [affected, unaffected]) {
      for (let iz = 0; iz < 2; ++iz)
        for (let iy = 0; iy < 2; ++iy)
          for (let ix = 0; ix < 2; ++ix) {
            const coefficients = [{ r: 0.4 + 0.2 * ix, g: 1.2 + 0.2 * iy, b: 2 + 0.2 * iz }];
            for (let i = 1; i < 9; ++i)
              coefficients.push({
                r: 0.03 * i * (ix ? 1 : -1),
                g: 0.02 * i * (iy ? 1 : -1),
                b: 0.01 * i * (iz ? 1 : -1),
              });
            probes.setProbeCoefficients(ix, iy, iz, coefficients);
          }
    }
    // No attachRenderer/requestBake: the cooked CPU atlas is sampled without scene recapture.
    requireSignal(await snapshot());
    return;
  }
  const affectedCapture = capture(affected);
  const unaffectedCapture = capture(unaffected);
  for (const [probes, captured] of [
    [affected, affectedCapture],
    [unaffected, unaffectedCapture],
  ]) {
    probes.attachRenderer(attached);
    await converge(probes, probes.requestBake(captured.scene));
  }
  for (const captured of [affectedCapture, unaffectedCapture])
    if (captureCounts.get(captured.scene) !== 96)
      throw new Error("probe fixture did not capture two complete passes");
  const before = await snapshot();
  requireSignal(before);
  if (mode !== "relight") return;
  const unaffectedBefore = captureCounts.get(unaffectedCapture.scene);
  affectedCapture.light.position.set(1, 0, 1);
  affectedCapture.light.color.setRGB(1, 0.25, 0.05);
  affectedCapture.scene.updateMatrixWorld(true);
  const pending = affected.requestBake(affectedCapture.scene);
  if (!affected.observation.samplingIsolated || affected.observation.bakeProgress.completed !== 0)
    throw new Error("rebake did not isolate the previous atlas immediately");
  const isolated = await snapshot();
  for (let y = 42; y < height - 42; ++y)
    for (let x = 43; x < 277; ++x) {
      if (x >= 151 && x < 169) continue;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; ++channel) {
        if (x < 151 && isolated[offset + channel] !== 0)
          throw new Error("first frame after rebake contains stale probe light");
        if (x >= 169 && isolated[offset + channel] !== before[offset + channel])
          throw new Error("rebake modified the unrelated receiver");
      }
    }
  await converge(affected, pending);
  if (captureCounts.get(unaffectedCapture.scene) !== unaffectedBefore)
    throw new Error("rebake scheduled work for the unrelated volume");
  const after = await snapshot();
  let changed = 0;
  for (let pixel = 0; pixel < width * height; ++pixel)
    if (
      [0, 1, 2].some(
        (channel) => Math.abs(after[pixel * 4 + channel] - before[pixel * 4 + channel]) > 8,
      )
    )
      changed += 1;
  if (changed <= width * height * 0.02) throw new Error("light move did not change probe lighting");
}

// Dense pattern keeps old colours inside the 3x3 variance box after the cut; flat colours
// would be clamped away and let a broken reset pass. Small rigid motion exercises reprojection.
async function temporalFixture({ renderer, scene, camera, traaDump }, firstCutFrame) {
  const { traa } = await import("/addons/tsl/display/TRAANode.js");
  const { mrt, output, velocity } = await import("three/tsl");
  const mesh = scene.getObjectByName("temporalPattern");
  const phase = uniform(0);
  const pattern = sin(uv().x.mul(900).add(phase)).mul(sin(uv().y.mul(700)));
  mesh.material.colorNode = vec4(vec3(pattern.mul(0.45).add(0.5)), 1);
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, velocity }));
  const effect = traa(
    scenePass.getTextureNode("output"),
    scenePass.getTextureNode("depth"),
    scenePass.getTextureNode("velocity"),
    camera,
  );
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = effect;
  // Compile with upstream's own initialization: depth is allocated by the resolve before
  // TRAANode copies it. Build first so the first beauty frame receives jitter index 0, too.
  pipeline._update();
  await renderer.compileAsync(pipeline._quadMesh, pipeline._quadMesh.camera);
  // TRAANode exposes resize restart, but no cut API. Restart its own colour history and
  // sample current depth on the reset frame, matching the native graph's seeded depth.
  let reset = true;
  let resolves = 0;
  const updateBefore = effect.updateBefore;
  effect.updateBefore = function (frame) {
    if (reset) {
      this.setSize(1, 1);
      this._previousDepthNode.value = this.depthNode.value;
      this._cameraWorldMatrix.value.copy(camera.matrixWorld);
      this._cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
      reset = false;
    }
    updateBefore.call(this, frame);
    resolves += 1;
  };
  // Debug only: enqueue copies at the resolve boundary, after restart seeding and before the
  // upstream history copy. Readback submits immediately; awaiting it happens outside render().
  let dump;
  if (traaDump && !firstCutFrame) {
    let pending = [];
    let jitter;
    let lastFrame;
    const setViewOffset = effect.setViewOffset;
    effect.setViewOffset = function (width, height) {
      setViewOffset.call(this, width, height);
      jitter = {
        jitterIndex: this._jitterIndex,
        jitterPixels: [camera.view.offsetX, camera.view.offsetY],
        projectionMatrix: [...camera.projectionMatrix.elements],
      };
    };
    const read = async (name, target, textureIndex = 0) => {
      const { width, height } = target;
      const texture = target.textures[textureIndex];
      const data = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        width,
        height,
        textureIndex,
      );
      const channels = 4;
      const rowElements =
        Math.ceil((width * channels * data.BYTES_PER_ELEMENT) / 256) *
        (256 / data.BYTES_PER_ELEMENT);
      const values = [];
      for (let y = 0; y < height; ++y)
        for (let x = 0; x < width * channels; ++x) {
          const value = data[y * rowElements + x];
          values.push(data instanceof Uint16Array ? DataUtils.fromHalfFloat(value) : value);
        }
      await globalThis.__tnTraaDump(
        name,
        {
          width,
          height,
          channels,
          dtype: "float32",
          byteOrder: "little",
          origin: "top-left",
          sourceType: texture.type,
        },
        values,
      );
    };
    const setRenderTarget = renderer.setRenderTarget;
    renderer.setRenderTarget = function (target, ...args) {
      if (target === effect._resolveRenderTarget) {
        lastFrame = {
          frame: resolves,
          frameCount: resolves + 1,
          indexBase: 0,
          ...jitter,
        };
        if (resolves >= 18 && resolves <= 23) {
          const prefix = `frame-${resolves}`;
          pending.push(globalThis.__tnTraaDump(prefix, lastFrame));
          pending.push(read(`${prefix}-beauty`, scenePass.renderTarget));
          pending.push(
            read(
              `${prefix}-velocity`,
              scenePass.renderTarget,
              scenePass.renderTarget.textures.indexOf(effect.velocityNode.value),
            ),
          );
          pending.push(read(`${prefix}-history`, effect._historyRenderTarget));
        }
      }
      return setRenderTarget.call(this, target, ...args);
    };
    dump = async () => {
      if (lastFrame.frame >= 18 && lastFrame.frame <= 23)
        pending.push(read(`frame-${lastFrame.frame}-resolved`, effect._resolveRenderTarget));
      await Promise.all(pending);
      pending = [];
      await globalThis.__tnTraaDump("capture", lastFrame);
    };
  }
  const draw = async () => {
    // FRAME nodes advance on the renderer's animation tick, not queue completion.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const before = resolves;
    pipeline.render();
    if (resolves !== before + 1) throw new Error("TRAA frame did not advance before capture");
    await renderer.backend.device.queue.onSubmittedWorkDone();
    if (dump) await dump();
  };
  for (let i = 0; i < 20; ++i) {
    mesh.position.x = i * 0.002;
    await draw();
  }
  camera.position.z = 5.01;
  camera.updateMatrixWorld(true);
  phase.value = Math.PI; // complementary pre/post views at the same pixels
  reset = true;
  const steps = firstCutFrame ? 0 : 3;
  for (let i = 0; i < steps; ++i) {
    mesh.position.x = (20 + i) * 0.002;
    await draw();
  }
  mesh.position.x = (20 + steps) * 0.002;
  return { render: draw };
}

/** An RGBA8 DataTexture with linear filtering, its texels from `texel(x, y)` -> [r, g, b]. */
function dataTexture(width, height, texel) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; ++y)
    for (let x = 0; x < width; ++x) pixels.set([...texel(x, y), 255], (y * width + x) * 4);
  const map = new DataTexture(pixels, width, height);
  map.magFilter = LinearFilter;
  map.minFilter = LinearFilter;
  map.needsUpdate = true;
  return map;
}

/**
 * A 4 x 4 x 4 RGBA8 Data3DTexture, linear, repeating along W as the rain template's noise volume does:
 * texel (x, y, z) is (80x, 80y, 80z).
 */
function volumeTexture() {
  const pixels = new Uint8Array(4 * 4 * 4 * 4);
  for (let z = 0; z < 4; ++z)
    for (let y = 0; y < 4; ++y)
      for (let x = 0; x < 4; ++x)
        pixels.set([x * 80, y * 80, z * 80, 255], ((z * 4 + y) * 4 + x) * 4);
  const volume = new Data3DTexture(pixels, 4, 4, 4);
  volume.magFilter = volume.minFilter = LinearFilter;
  volume.wrapR = RepeatWrapping;
  volume.needsUpdate = true;
  return volume;
}

/** An 8 x 8 checker, nearest-filtered: texels 255 and 64 alternate in r, g and b. */
function checker() {
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; ++i) {
    pixels.fill(((i % 8) + Math.floor(i / 8)) % 2 ? 255 : 64, i * 4, i * 4 + 3);
    pixels[i * 4 + 3] = 255;
  }
  const map = new DataTexture(pixels, 8, 8);
  map.magFilter = map.minFilter = NearestFilter;
  map.needsUpdate = true;
  return map;
}

/** Asymmetric bands reveal handedness, horizon, rotation, sRGB decode and intensity. */
function equirectSky() {
  const width = 128;
  const height = 64;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; ++y)
    for (let x = 0; x < width; ++x) {
      const at = (y * width + x) * 4;
      pixels[at] = 20 + ((x * 160) % 220);
      pixels[at + 1] = 30 + Math.floor((y * 180) / height);
      pixels[at + 2] = 220 - Math.floor((x * 150) / width);
      pixels[at + 3] = 255;
    }
  const sky = new DataTexture(pixels, width, height);
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  sky.magFilter = LinearFilter;
  sky.minFilter = LinearMipmapLinearFilter;
  sky.needsUpdate = true;
  return sky;
}

export const programs = {
  "sky-equirect"({ target }) {
    const sky = equirectSky();
    target.background = target.environment = sky;
    target.backgroundIntensity = target.environmentIntensity = 2.5;
    target.backgroundRotation.set(0.1, 0.4, 0);
    target.environmentRotation.set(0.1, 0.4, 0);
  },
  async "traa-history"(context) {
    return temporalFixture(context, false);
  },
  async "history-cut"(context) {
    return temporalFixture(context, true);
  },
  async probes(context) {
    await probeLighting(context, "live");
  },
  async "probes-baked"(context) {
    await probeLighting(context, "baked");
  },
  async "probes-relight"(context) {
    await probeLighting(context, "relight");
  },
  async "vsm-basic"(context) {
    await virtualShadow(context);
  },
  async "vsm-cut"(context) {
    await virtualShadow(context, true);
  },
  async "vsm-deformation"({ target }) {
    target.positionNode = positionLocal.add(vec3(0, 0, sin(positionLocal.x.mul(2)).mul(0.4)));
  },
  async "particles-sprite"({ target, scene, renderer }) {
    const material = target.material;
    particleMaterial(material);
    const particles = new GPUParticles3D({
      amount: PARTICLE_COUNT,
      material,
      start: (buffers) =>
        Fn(() => {
          const row = instanceIndex.div(uint(4));
          const col = instanceIndex.sub(row.mul(uint(4)));
          buffers.positions.element(instanceIndex).assign(
            vec3(
              float(col).sub(1.5).mul(1.1),
              float(row).sub(1).mul(0.85),
              float(instanceIndex.mod(uint(3)))
                .sub(1)
                .mul(0.2),
            ),
          );
          buffers.velocities.element(instanceIndex).assign(vec3(0.1, 0.25, -0.08));
        })().compute(PARTICLE_COUNT),
      process: (buffers) =>
        Fn(() => {
          const velocity = buffers.velocities.element(instanceIndex);
          buffers.positions
            .element(instanceIndex)
            .assign(buffers.positions.element(instanceIndex).add(velocity.mul(1 / 60)));
          velocity.assign(velocity.add(vec3(0, -1.2 / 60, 0)));
        })().compute(PARTICLE_COUNT),
    });
    replaceSprite(target, particles, scene);
    particles.attachRenderer(renderer);
    for (let i = 0; i < PARTICLE_STEPS; ++i) particles.process(renderer);
    await renderer.backend.device.queue.onSubmittedWorkDone();
  },
  async "fluid-particles"({ target, scene, renderer }) {
    if (renderer.backend.isWebGPUBackend !== true) throw new Error("fluid fixture needs WebGPU");
    // IRendererLike uses kind/compute/readback; Three's raw renderer does not implement kind.
    const attached = {
      kind: "webgpu",
      compute: (node) => renderer.compute(node),
      readback: (attribute) => renderer.getArrayBufferAsync(attribute),
    };
    const fluid = new FluidParticles3D({
      capacity: PARTICLE_COUNT,
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      voxelSize: 0.25,
    });
    particleMaterial(target.material);
    target.material.positionNode = fluid.positions.toAttribute().xyz;
    target.count = PARTICLE_COUNT;
    target.frustumCulled = false;
    scene.add(fluid);
    fluid.attachRenderer(attached);
    for (let i = 0; i < PARTICLE_COUNT; ++i) {
      if (
        !fluid.emit(
          [
            ((i % 3) - 1) * 0.1,
            ((Math.floor(i / 3) % 2) - 0.5) * 0.1,
            (Math.floor(i / 6) - 0.5) * 0.1,
          ],
          [0.1 + (i % 3) * 0.07, 0.25, -0.08 + Math.floor(i / 6) * 0.1],
        )
      )
        throw new Error("fluid fixture emission refused");
    }
    for (let i = 0; i < PARTICLE_STEPS; ++i) fluid.process();
    await renderer.backend.device.queue.onSubmittedWorkDone();
  },
  async "nodemat-color-uv"({ target }) {
    target.colorNode = vec4(uv(), uniform(0.35).setName("nodeTint"), 1);
  },
  /** MaterialX noise: 3D and 2D Perlin through mx_noise_float, 2D and 3D Worley cells. */
  async "materialx-noise"({ target }) {
    const perlin3 = mx_noise_float(positionWorld.mul(1.8)).mul(0.5).add(0.5);
    const perlin2 = mx_noise_float(uv().mul(6), 0.8, 0.1);
    const cells = mx_worley_noise_vec2(uv().mul(5), 0.9);
    const cells3 = mx_worley_noise_vec2(positionWorld.mul(2));
    target.colorNode = vec4(
      perlin3,
      perlin2.add(cells.x.mul(0.3)),
      cells.y.add(cells3.x).mul(0.4),
      1,
    );
  },
  async "reflector-plane"({ target }) {
    const floor = target.getObjectByName("mirror");
    const mirror = reflector();
    mirror.target.rotateX(-Math.PI / 2);
    target.add(mirror.target);
    floor.material.colorNode = vec4(mirror.rgb.mul(vec3(0.75, 0.85, 1)), 1);
  },
  async "screen-uv"({ target }) {
    target.colorNode = vec4(screenUV.flipX(), screenUV.x.mul(screenUV.y), 1);
  },
  /** texture(textureObject, uv) on unnamed textures, as Midway's ocean: a vertex displacement read
   *  at level 0 and a fragment colour. */
  async "tsl-texture-object"({ target }) {
    const ramp = dataTexture(8, 4, (x, y) => [x * 36, y * 80, 200 - x * 20]);
    const bumps = dataTexture(8, 8, (x, y) => [((x + y) % 4) * 80, 0, 0]);
    target.positionNode = positionLocal.add(
      vec3(0, 0, texture(bumps, uv()).level(float(0)).r.mul(0.4)),
    );
    target.colorNode = vec4(texture(ramp, uv()).rgb, 1);
  },
  /** A positionNode reads one texture with no level (the vertex stage samples its level 0, as r185's
   *  TextureNode does there) and another through .level(0). */
  /** normalWorld reads the material's normal: flipped on a DoubleSide back face, a normalNode, a normal map. */
  async "tsl-normal-world-doubleside"({ target }) {
    const shade = normalWorld.mul(0.5).add(0.5);
    for (const name of ["front", "back"])
      target.getObjectByName(name).material.colorNode = vec4(shade, 1);
    const tilted = target.getObjectByName("tilted").material;
    tilted.normalNode = normalize(vec3(0.6, 0, 0.8));
    tilted.emissiveNode = shade;
    const mapped = target.getObjectByName("mapped").material;
    mapped.normalMap = dataTexture(4, 4, () => [200, 128, 230]);
    mapped.emissiveNode = shade;
  },
  /** The fragment varyings r185 builds for positionViewDirection, normalWorldGeometry (which a normal
   *  map does not reach) and depth. */
  async "tsl-view-geometry-varyings"({ target }) {
    target.getObjectByName("sphere").material.colorNode = vec4(
      positionViewDirection.mul(0.5).add(0.5),
      1,
    );
    const geometryShade = normalWorldGeometry.mul(0.5).add(0.5);
    for (const name of ["box", "stretched"])
      target.getObjectByName(name).material.colorNode = vec4(geometryShade, 1);
    const mapped = target.getObjectByName("mapped").material;
    mapped.normalMap = dataTexture(4, 4, () => [200, 128, 230]);
    mapped.emissiveNode = geometryShade;
    target.getObjectByName("depth").material.colorNode = vec4(vec3(depth.oneMinus().mul(25)), 1);
  },
  /** transformNormalToView: modelNormalMatrix then the view matrix, on a rotated and a stretched box. */
  async "tsl-transform-normal-to-view"({ target }) {
    const shade = vec4(transformNormalToView(normalGeometry).mul(0.5).add(0.5), 1);
    for (const name of ["box", "stretched"])
      target.getObjectByName(name).material.colorNode = shade;
  },
  async "tsl-stage-vertex-texture-level"({ target }) {
    const ramp = dataTexture(8, 4, (x, y) => [x * 36, y * 80, 200 - x * 20]);
    const bumps = dataTexture(8, 8, (x, y) => [((x + y) % 4) * 80, 0, 0]);
    const waves = dataTexture(8, 1, (x) => [0, (x % 2) * 255, 0]);
    target.positionNode = positionLocal.add(
      vec3(0, texture(waves, uv()).level(float(0)).g.mul(0.3), texture(bumps, uv()).r.mul(0.4)),
    );
    target.colorNode = vec4(texture(ramp, uv()).rgb, 1);
  },
  /** WaterSurface3D's reads: the frame behind a transparent surface (viewportSharedTexture, offset)
   *  and the depth between it and the surface (viewportLinearDepth - linearDepth()), on a water
   *  plane over a lit floor. */
  /** The depth reads r185 gives a water surface: the scene depth behind it, its own, and the camera range. */
  /** SkeletonUtils.clone on a SkinnedMesh: the copy's own bones bend its skin, the original keeps its pose. */
  /** A BatchedMesh: two geometries, five coloured instances (one rotated, one hidden), as core's projection builds one. */
  async "batched-mesh"({ target }) {
    const batch = new BatchedMesh(8, 2000, 4000, new MeshStandardMaterial({ roughness: 0.5 }));
    const box = batch.addGeometry(new BoxGeometry(0.8, 0.8, 0.8).toNonIndexed());
    const ball = batch.addGeometry(new SphereGeometry(0.5, 16, 8).toNonIndexed());
    const matrix = new Matrix4();
    const place = (geometry, x, y, r, g, b) => {
      const id = batch.addInstance(geometry);
      batch.setMatrixAt(id, matrix.makeRotationZ(x * 0.3).setPosition(x, y, 0));
      batch.setColorAt(id, new Color().setRGB(r, g, b));
      return id;
    };
    place(box, -1.5, 0.6, 1, 0.25, 0.25);
    place(box, 0, 0.6, 0.25, 1, 0.25);
    place(box, 1.5, 0.6, 0.25, 0.25, 1);
    place(ball, -0.75, -0.7, 1, 1, 0.25);
    place(ball, 0.75, -0.7, 1, 0.25, 1);
    batch.setVisibleAt(place(ball, 2.2, -0.7, 0.25, 1, 1), false);
    const sun = new DirectionalLight(0xffffff, 2.5);
    sun.position.set(3, 4, 5);
    target.add(batch, sun, new AmbientLight(0xffffff, 0.4));
  },
  /** A camera-facing card: its positionNode spans cameraWorldMatrix's right and up axes. */
  async "shadow-billboard"({ target }) {
    const right = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
    const up = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
    target.getObjectByName("card").material.positionNode = right
      .mul(positionLocal.x)
      .add(up.mul(positionLocal.y));
  },
  async "skinned-clone"({ target }) {
    const copy = cloneSkinned(target.getObjectByName("skin"));
    copy.position.x = 1.2;
    copy.skeleton.bones[2].rotation.z = 0.5;
    copy.skeleton.bones[3].rotation.z = 0.5;
    target.add(copy);
  },
  async "tsl-viewport-linear-depth"({ target }) {
    const water = target.getObjectByName("water");
    water.material.colorNode = vec4(
      viewportLinearDepth.mul(4),
      linearDepth().mul(4),
      cameraNear.mul(5).add(cameraFar.mul(0.005)),
      1,
    );
  },
  async "viewport-textures"({ target }) {
    const water = target.getObjectByName("water");
    const behind = viewportSharedTexture(screenUV.add(vec2(0.02, 0))).rgb;
    water.material.colorNode = vec4(
      behind
        .mul(vec3(0.5, 0.8, 1))
        .add(vec3(0, 0, viewportLinearDepth.sub(linearDepth()).mul(8)))
        // A second depth read at an offset, as WaterSurface3D.thicknessAt(offset) takes one.
        .add(vec3(linearDepth(viewportDepthTexture(screenUV.add(vec2(0.02, 0)))).mul(0.2), 0, 0)),
      1,
    );
  },
  /** Midway's particles: an InstancedBufferGeometry quad whose per-instance InstancedBufferAttributes
   *  (aOffset, aTint) a TSL attribute() reads, placed by a material.vertexNode in clip space. */
  async "instanced-geometry"({ target }) {
    const quads = target.getObjectByName("quads");
    const offset = attribute("aOffset", "vec3");
    quads.material.vertexNode = cameraProjectionMatrix.mul(
      cameraViewMatrix.mul(vec4(positionLocal.mul(0.4).add(offset), 1)),
    );
    quads.material.colorNode = vec4(attribute("aTint", "vec3"), 1);
  },
  /** texture3D(volume, uvw) and texture3D(volume).sample(q), as the rain template's clouds read their noise. */
  async "texture-data-3d"({ target }) {
    const volume = volumeTexture();
    const slice = texture3D(volume, vec3(uv().x, uv().y, 0.25));
    const drift = texture3D(volume).sample(vec3(uv().y, uv().x, uv().x.mul(2).add(0.6)));
    target.colorNode = vec4(slice.r, slice.g, drift.b, 1);
  },
  async "storage-attribute"({ target }) {
    const base = new PlaneGeometry(0.5, 0.5);
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(base.index);
    geometry.setAttribute("position", base.getAttribute("position"));
    geometry.instanceCount = 5;
    const offsets = [-1, 0.5, 0, 0, 0, 0.5, 0, 0, 1, 0.5, 0, 0, -1, -0.5, 0, 0, 0, -0.5, 0, 0];
    const palette = storage(new StorageBufferAttribute(new Float32Array(offsets), 4), "vec4", 5);
    target.geometry = geometry;
    target.material.positionNode = positionLocal.add(
      palette.toReadOnly().element(instanceIndex).xyz,
    );
    target.material.colorNode = vec4(1, 0.6, 0.2, 1);
  },
  async "texture-object"({ target }) {
    const bands = equirectSky();
    target.colorNode = vec4(
      texture(bands, uv()).rgb.mul(texture(checker(), uv()).r.mul(0.6).add(0.4)),
      1,
    );
  },
  async "pmrem-texture"({ target }) {
    target.colorNode = vec4(
      pmremTexture(equirectSky(), normalize(positionWorld), uv().x.mul(0.9)),
      1,
    );
  },
  /** NodeMaterial.vertexNode: a screen-space quad, and a world-space wave through the camera matrices. */
  async "vertex-node-screen"({ target }) {
    target.vertexNode = vec4(positionGeometry.xy.mul(0.4).add(vec2(-0.5, 0.45)), 0, 1);
  },
  async "vertex-node-world"({ target }) {
    const bent = positionGeometry.add(vec3(0, sin(positionGeometry.x.mul(3)).mul(0.3), 0));
    target.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(bent, 1)));
  },
  async "nodemat-standard-nodes"({ target }) {
    target.roughnessNode = uv().x.mul(0.7).add(0.2);
    target.metalnessNode = uv().y.mul(0.8);
    target.emissiveNode = vec3(sin(uv().x.mul(8)).mul(0.15).add(0.15), 0, 0);
  },
  async "nodemat-normal-opacity"({ target }) {
    target.normalNode = normalize(
      normalViewGeometry.add(vec3(sin(uv().x.mul(10)).mul(0.35), 0, 0)),
    );
    target.opacityNode = uv().y.mul(0.6).add(0.2);
  },
  /**
   * PRD-513: a compute pass writes 10,000 instance positions on a 100 x 100 grid with a wave, and
   * the material's positionNode places each instance at its own entry.
   */
  async "storage-instances"({ target, renderer }) {
    const positions = instancedArray(GRID_COUNT, "vec4").setName("positions");
    const time = uniform(0.75);
    const kernel = Fn(() => {
      const row = instanceIndex.div(uint(100));
      const column = float(instanceIndex.sub(row.mul(uint(100))));
      positions
        .element(instanceIndex)
        .assign(vec4(column.mul(0.5), sin(column.mul(0.25).add(time)), float(row).mul(0.5), 1));
    })().compute(GRID_COUNT);
    await renderer.computeAsync(kernel);
    target.positionNode = positionLocal.add(positions.element(instanceIndex).xyz);
  },

  async "post-ao"({ renderer, scene, camera }) {
    return postAddons("post-ao", renderer, scene, camera);
  },
  async "post-ao-raw"({ renderer, scene, camera }) {
    return postAddons("post-ao-raw", renderer, scene, camera);
  },
  async "post-bloom"({ renderer, scene, camera }) {
    return postAddons("post-bloom", renderer, scene, camera);
  },
  async "post-smaa"({ renderer, scene, camera }) {
    return postAddons("post-smaa", renderer, scene, camera);
  },
  async "post-template-high"({ renderer, scene, camera }) {
    return postAddons("post-template-high", renderer, scene, camera);
  },
  async "post-live-parameters"({ renderer, scene, camera }) {
    return postAddons("post-live-parameters", renderer, scene, camera);
  },
  async "post-uniform-write"({ renderer, scene, camera }) {
    return postAddons("post-uniform-write", renderer, scene, camera);
  },

  async "post-chromatic"({ renderer, scene, camera }) {
    const pipeline = chromatic(renderer, scene, camera);
    return { render: () => pipeline.render() };
  },

  /** The same pass, drawn once at 200 x 150 first: the captured frame is the one after a resize. */
  async "post-chromatic-resized"({ renderer, scene, camera, width, height }) {
    const pipeline = chromatic(renderer, scene, camera);
    renderer.setSize(200, 150, false);
    pipeline.render();
    await renderer.backend.device.queue.onSubmittedWorkDone();
    renderer.setSize(width, height, false);
    return { render: () => pipeline.render() };
  },

  /** PRD-512: a plane bent by a sine wave along its own z, which its shadow must follow. */
  async "wave-plane"({ target }) {
    target.positionNode = positionLocal.add(vec3(0, 0, sin(positionLocal.x.mul(2)).mul(0.4)));
  },
};
