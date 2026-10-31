// Generated for you. Ordinary Three.js and TSL: the sky your sun lights; edit or delete it freely.
// Independent model port, no Unreal code: Engine/Shaders/Private/SkyAtmosphere.usf,
// VolumetricCloud.usf, and Source/Runtime/Renderer/Private/{SkyAtmosphere,VolumetricCloud}Rendering.cpp
// under ~/UnrealEngine-5.8.3/Engine. Physical constants remain in atmosphere.ts and clouds.ts.
import {
  ClampToEdgeWrapping,
  Color,
  Data3DTexture,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  RenderTarget,
  RepeatWrapping,
  type Scene,
  UnsignedByteType,
  Vector3,
} from "three";
import {
  Fn,
  If,
  Loop,
  cameraPosition,
  clamp,
  float,
  mix,
  nodeObject,
  positionWorldDirection,
  texture,
  texture3D,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  Node,
  type NodeBuilder,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RendererUtils,
} from "three/webgpu";
import {
  BOTTOM_KM,
  CAMERA_KM,
  GROUND_ALBEDO,
  MIE_ABSORB,
  MIE_G,
  MIE_SCATTER,
  OZONE,
  RAYLEIGH,
  SKY_TO_SUN,
  SUN_ILLUMINANCE,
  SUN_KELVIN,
  TOP_KM,
  bakeSkyRadiance,
  sunLight,
  sunLightTransmittance,
  sunTransmittance,
  temperatureColour,
  viewDistanceSkyLight,
} from "./atmosphere.js";
import {
  CLOUD_BOTTOM_KM,
  CLOUD_MATERIAL,
  CLOUD_MODEL,
  CLOUD_TOP_KM,
  PATTERN_SIZE,
  VOLUME_SIZE,
  bakeCloudRadiance,
  cloudOctaves,
  cloudProfileTexture,
  cloudTextures,
} from "./clouds.js";

/** Exponential height fog, in metres: density at `fogHeight` (base 2) and falloff per metre. */
export interface ISkyFog {
  readonly density: number;
  readonly heightFalloff: number;
  readonly fogHeight: number;
}
const HEIGHT_FOG_DEFAULT: ISkyFog = { density: 0.0021, heightFalloff: 0.08, fogHeight: 0 };

const GPU_SKY_SIZES = {
  transmittance: [256, 64],
  multi: [32, 32],
  sky: [192, 108],
  clouds: [4096, 2048],
} as const;
const GPU_CLOUD_STEPS = {
  view: CLOUD_MODEL.maxViewSteps,
  light: CLOUD_MODEL.lightSteps,
} as const;
const R0 = BOTTOM_KM + CAMERA_KM;
const HORIZON = Math.acos(-Math.sqrt(R0 * R0 - BOTTOM_KM * BOTTOM_KM) / R0);
const SUN_RADIUS = (0.7357000112533569 * Math.PI) / 360;
const PI = Math.PI;
type Scalar = Node<"float">;
type Direction = Node<"vec3">;

function skyDirection(at: Node<"vec2">): Direction {
  const z = at.y.lessThan(0.5).select(
    float(1)
      .sub(float(1).sub(at.y.mul(2)).pow(2))
      .mul(HORIZON),
    at.y
      .mul(2)
      .sub(1)
      .pow(2)
      .mul(PI - HORIZON)
      .add(HORIZON),
  );
  const a = at.x.mul(2 * PI);
  return vec3(z.sin().mul(a.cos()), z.cos(), z.sin().mul(a.sin()));
}
function skyUv(d: Direction) {
  const z = clamp(d.y, -1, 1).acos();
  const v = z.lessThan(HORIZON).select(
    float(1)
      .sub(float(1).sub(z.div(HORIZON)).max(0).sqrt())
      .mul(0.5),
    z
      .sub(HORIZON)
      .max(0)
      .div(PI - HORIZON)
      .sqrt()
      .add(1)
      .mul(0.5),
  );
  return vec2(
    d.z
      .atan(d.x)
      .div(2 * PI)
      .add(1)
      .fract(),
    v,
  );
}
function exit(r: Scalar, mu: Scalar, radius: number) {
  return r
    .mul(mu)
    .negate()
    .add(
      r
        .mul(mu)
        .pow(2)
        .add(radius * radius)
        .sub(r.mul(r))
        .max(0)
        .sqrt(),
    );
}
function ground(r: Scalar, mu: Scalar) {
  const disc = r
    .mul(mu)
    .pow(2)
    .sub(r.mul(r))
    .add(BOTTOM_KM * BOTTOM_KM);
  return mu.lessThan(0).and(disc.greaterThanEqual(0));
}
/** Same local medium as atmosphere.medium, in inverse kilometres. */
function gpuMedium(h: Scalar) {
  const ray = vec3(...RAYLEIGH).mul(h.div(-8).exp());
  const mie = h.div(-1.2).exp().mul(MIE_SCATTER);
  const ozone = clamp(h.lessThan(25).select(h.div(15).sub(2 / 3), h.div(-15).add(8 / 3)), 0, 1);
  return {
    ray,
    mie,
    ext: ray.add(mie.mul((MIE_SCATTER + MIE_ABSORB) / MIE_SCATTER)).add(vec3(...OZONE).mul(ozone)),
  };
}
function gpuHg(c: Scalar, g: number): Scalar {
  return float((1 - g * g) / (4 * PI)).div(
    float(1 + g * g)
      .sub(c.mul(2 * g))
      .pow(1.5),
  );
}
function target(size: readonly [number, number]) {
  return new RenderTarget(...size, {
    type: HalfFloatType,
    depthBuffer: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
  });
}
function material(colour: Node) {
  const m = new NodeMaterial();
  m.fragmentNode = colour;
  m.toneMapped = false;
  m.depthTest = false;
  m.depthWrite = false;
  return m;
}

/** The cloud material's density on the GPU: the same generated textures as cloudDensityField. */
function cloudNoise() {
  const { pattern, volume } = cloudTextures();
  const rgba = new Float32Array(VOLUME_SIZE ** 3 * 4);
  for (let i = 0; i < VOLUME_SIZE ** 3; i++) {
    rgba[i * 4] = volume[i * 2] ?? 0;
    rgba[i * 4 + 1] = volume[i * 2 + 1] ?? 0;
  }
  const map = new Data3DTexture(rgba, VOLUME_SIZE, VOLUME_SIZE, VOLUME_SIZE);
  const patternMap = new DataTexture(pattern, PATTERN_SIZE, PATTERN_SIZE, RGBAFormat, FloatType);
  const profileMap = new DataTexture(cloudProfileTexture(), 64, 64, RGBAFormat, FloatType);
  for (const t of [map, patternMap, profileMap]) {
    t.minFilter = t.magFilter = LinearFilter;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.needsUpdate = true;
  }
  map.type = FloatType;
  map.format = RGBAFormat;
  map.wrapR = RepeatWrapping;
  profileMap.wrapS = profileMap.wrapT = ClampToEdgeWrapping;
  const volumeSample = texture3D(map);
  const patternSample = texture(patternMap);
  const profileSample = texture(profileMap);
  const m = CLOUD_MATERIAL;
  const volumeAt = (p: Direction) => volumeSample.sample(p).level(float(0));
  return {
    map,
    patternMap,
    profileMap,
    /** Extinction per metre at planet-centred p in km. */
    density: (p: Direction) => {
      const altitude = p.length().sub(BOTTOM_KM);
      const h = altitude.sub(CLOUD_BOTTOM_KM).div(CLOUD_TOP_KM - CLOUD_BOTTOM_KM);
      const uv = vec2(p.x, p.z).div(m.layoutKm);
      const pat = patternSample.sample(uv).level(float(0)).rgb;
      const coverage = pat.x.max(pat.y).max(pat.z);
      const profileAt = (channel: "x" | "y" | "z") =>
        profileSample.sample(vec2(h, pat[channel])).level(float(0))[channel];
      const profile = profileAt("x").max(profileAt("y")).max(profileAt("z")).sub(0.5);
      const sky = vec3(uv.x.add(0.5), uv.y.add(0.5), p.y.sub(BOTTOM_KM).div(m.layoutKm));
      const a = h.mul(0.95).add(0.05);
      const c = a.sub(0.5).abs().mul(2).pow(2);
      const warp = volumeAt(sky.mul(vec3(...m.noise2Scale)))
        .r.sub(m.noiseBias[1])
        .mul(m.noiseStrength[1]);
      const shape = volumeAt(sky.mul(vec3(...m.noise1Scale)).add(vec3(a, a, c).mul(warp))).g;
      const noise = shape.sub(m.noiseBias[0]).add(m.coverage).mul(m.noiseStrength[0]);
      const inside = h.greaterThanEqual(m.insideLayer[0]).and(h.lessThanEqual(m.insideLayer[1]));
      return inside.select(clamp(coverage.mul(profile.add(noise)).mul(m.density), 0, 1), float(0));
    },
  };
}

/**
 * 1 draws the analytic sun disc, 0 hides it. Unreal draws no disc into a reflection capture, so the
 * chrome sphere shows the sky and its clouds but no hard flare (SkyAtmosphereRendering.cpp, the
 * SourceDiskEnabled pass parameter); `captureReflections` switches it off for its faces.
 */
const skyDisc = uniform(1);

/** Cached passes: only texture reads and the analytic disc run at screen resolution. */
class GpuSkyNode extends Node<"vec3"> {
  static get type(): string {
    return "GpuSkyNode";
  }
  readonly targets = {
    transmittance: target(GPU_SKY_SIZES.transmittance),
    multi: target(GPU_SKY_SIZES.multi),
    sky: target(GPU_SKY_SIZES.sky),
    clouds: target(GPU_SKY_SIZES.clouds),
  };
  readonly materials: NodeMaterial[] = [];
  readonly sun = uniform(new Vector3());
  readonly #quad = new QuadMesh(new NodeMaterial());
  readonly #noise = cloudNoise();
  readonly #fog = uniform(new Color());
  readonly #scale = vec3(...temperatureColour(SUN_KELVIN)).mul(SUN_ILLUMINANCE * SKY_TO_SUN);
  readonly #light = uniform(new Vector3());
  readonly #ambient = uniform(new Vector3());
  #last = new Vector3(Number.NaN, 0, 0);
  #ready = false;
  #disposed = false;
  /** CPU submission time; GPU execution is asynchronous and must be measured by the coordinator. */
  lastSubmissionMs = 0;
  constructor(
    readonly direction: Vector3,
    readonly scene: Scene,
    readonly fogged: boolean,
    readonly clouds: boolean,
    readonly refreshEnvironment?: () => void,
    readonly fog?: ISkyFog,
  ) {
    super("vec3");
    this.updateBeforeType = NodeUpdateType.FRAME;
    const trans = texture(this.targets.transmittance.texture);
    // Distance-to-top parametrisation resolves the grazing optical depth without a discontinuity.
    const maxRho = Math.sqrt(TOP_KM * TOP_KM - BOTTOM_KM * BOTTOM_KM);
    const transmission = (r: Scalar, mu: Scalar) => {
      const rho = r
        .mul(r)
        .sub(BOTTOM_KM * BOTTOM_KM)
        .max(0)
        .sqrt();
      const distance = exit(r, mu, TOP_KM);
      const min = float(TOP_KM).sub(r);
      const max = rho.add(maxRho);
      const at = vec2(distance.sub(min).div(max.sub(min)), rho.div(maxRho));
      return ground(r, mu).select(vec3(0), trans.sample(at).level(float(0)).rgb);
    };
    this.materials.push(
      material(
        Fn(() => {
          const rho = uv().y.mul(maxRho);
          const r = rho
            .mul(rho)
            .add(BOTTOM_KM * BOTTOM_KM)
            .sqrt();
          const min = float(TOP_KM).sub(r);
          const distance = mix(min, rho.add(maxRho), uv().x).max(1e-6);
          const mu = float(TOP_KM * TOP_KM)
            .sub(r.mul(r))
            .sub(distance.mul(distance))
            .div(r.mul(distance).mul(2));
          // Unreal's transmittance pass: ten equal segments, each read 0.3 of the way in
          // (r.SkyAtmosphere.TransmittanceLUT.SampleCount, DEFAULT_SAMPLE_OFFSET in SkyAtmosphere.usf).
          const depth = vec3(0).toVar();
          Loop(10, ({ i }) => {
            const t = float(i).add(0.3).div(10).mul(distance);
            const h = r
              .mul(r)
              .add(r.mul(mu).mul(t).mul(2))
              .add(t.mul(t))
              .sqrt()
              .sub(BOTTOM_KM)
              .max(0);
            depth.addAssign(gpuMedium(h).ext.mul(distance.div(10)));
          });
          return vec4(depth.negate().exp(), 1);
        })(),
      ),
    );
    const multi = texture(this.targets.multi.texture);
    const march = (r: Scalar, d: Direction, sun: Direction, iso: boolean) => {
      const isGround = ground(r, d.y);
      const length = isGround.select(
        r
          .mul(d.y)
          .negate()
          .sub(
            r
              .mul(d.y)
              .pow(2)
              .sub(r.mul(r))
              .add(BOTTOM_KM * BOTTOM_KM)
              .max(0)
              .sqrt(),
          ),
        exit(r, d.y, TOP_KM),
      );
      const cosine = d.dot(sun);
      const phaseR = iso
        ? float(1 / (4 * PI))
        : cosine
            .pow(2)
            .add(1)
            .mul(3 / (16 * PI));
      const phaseM = iso ? float(1 / (4 * PI)) : gpuHg(cosine, MIE_G);
      const radiance = vec3(0).toVar();
      const transfer = vec3(0).toVar();
      const through = vec3(1).toVar();
      // Unreal's counts: the multiple-scattering pass takes 15 equal segments read 0.3 of the way in; the
      // sky pass takes 4 to 32 (by the ray's length over 150 km) with segments that grow with the square of
      // the distance, the last one running on to the end of the ray (SamplingSetup in SkyAtmosphere.usf).
      const count = iso ? float(15) : mix(float(4), float(32), clamp(length.div(150), 0, 1));
      const whole = count.floor();
      const lengthWhole = length.mul(whole).div(count);
      const body = (i: Scalar) => {
        const u0 = i.div(whole).pow(2);
        const u1 = i.add(1).div(whole).pow(2);
        const a = iso ? i.div(15).mul(length) : lengthWhole.mul(u0);
        const b = iso
          ? i.add(1).div(15).mul(length)
          : u1.greaterThan(1).select(length, lengthWhole.mul(u1));
        const t = iso ? i.add(0.3).div(15).mul(length) : a.add(b.sub(a).mul(0.3));
        const p = vec3(0, r, 0).add(d.mul(t));
        const rr = p.length();
        const h = rr.sub(BOTTOM_KM).max(0);
        const mu = p.dot(sun).div(rr);
        const m = gpuMedium(h);
        const scatter = m.ray.add(m.mie);
        const stepT = m.ext.mul(b.sub(a)).negate().exp();
        const integral = vec3(1).sub(stepT).div(m.ext.max(1e-12));
        const source = transmission(rr, mu)
          .mul(m.ray.mul(phaseR).add(m.mie.mul(phaseM)))
          .toVar();
        if (!iso)
          source.addAssign(
            multi
              .sample(vec2(mu.add(1).mul(0.5), h.div(TOP_KM - BOTTOM_KM).sqrt()))
              .level(float(0))
              .rgb.mul(scatter),
          );
        radiance.addAssign(through.mul(source).mul(integral));
        transfer.addAssign(through.mul(scatter).mul(integral));
        through.mulAssign(stepT);
      };
      if (iso) Loop(15, ({ i }) => body(float(i)));
      else
        Loop(32, ({ i }) => {
          If(float(i).lessThan(count.ceil()), () => body(float(i)));
        });
      if (iso) {
        const p = vec3(0, r, 0).add(d.mul(length));
        const rr = p.length();
        const mu = p.dot(sun).div(rr);
        radiance.addAssign(
          isGround.select(
            through
              .mul(transmission(rr, mu))
              .mul(mu.max(0))
              .mul(GROUND_ALBEDO / PI),
            vec3(0),
          ),
        );
      }
      return { radiance, transfer };
    };
    this.materials.push(
      material(
        Fn(() => {
          const r = uv()
            .y.pow(2)
            .mul(TOP_KM - BOTTOM_KM)
            .add(BOTTOM_KM);
          const mu = uv().x.mul(2).sub(1);
          const sun = vec3(float(1).sub(mu.pow(2)).max(0).sqrt(), mu, 0);
          const up = march(r, vec3(0, 1, 0), sun, true);
          const down = march(r, vec3(0, -1, 0), sun, true);
          return vec4(
            up.radiance
              .add(down.radiance)
              .mul(0.5)
              .div(vec3(1).sub(up.transfer.add(down.transfer).mul(0.5).min(0.99))),
            1,
          );
        })(),
      ),
    );
    this.materials.push(
      material(Fn(() => vec4(march(float(R0), skyDirection(uv()), this.sun, false).radiance, 1))()),
    );
    this.targets.sky.texture.wrapS = RepeatWrapping;
    this.targets.clouds.texture.wrapS = RepeatWrapping;
    const sky = texture(this.targets.sky.texture);
    this.materials.push(
      material(
        Fn(() => {
          // Equirectangular cloud target; sky-view keeps its own horizon-focused parametrisation.
          const theta = uv().y.mul(PI);
          const phi = uv()
            .x.sub(0.5)
            .mul(2 * PI);
          const d = vec3(theta.sin().mul(phi.cos()), theta.cos(), theta.sin().mul(phi.sin()));
          const clear = sky.sample(skyUv(d)).level(float(0)).rgb.toVar();
          const result = clear.toVar();
          const cloudThrough = float(1).toVar();
          const entry = exit(float(R0), d.y, BOTTOM_KM + CLOUD_BOTTOM_KM);
          If(d.y.greaterThan(0).and(entry.lessThanEqual(350)), () => {
            const length = exit(float(R0), d.y, BOTTOM_KM + CLOUD_TOP_KM)
              .sub(entry)
              .min(CLOUD_MODEL.tracingKm);
            const steps = clamp(
              length.mul(1000 / CLOUD_MODEL.viewStepMetres).ceil(),
              CLOUD_MODEL.minViewSteps,
              GPU_CLOUD_STEPS.view,
            );
            const dt = length.div(steps);
            const fadeT = clamp(
              entry
                .sub(CLOUD_MODEL.horizonFadeStartKm)
                .div(CLOUD_MODEL.horizonFadeEndKm - CLOUD_MODEL.horizonFadeStartKm),
              0,
              1,
            );
            const fade = float(1).sub(fadeT.mul(fadeT).mul(float(3).sub(fadeT.mul(2))));
            const through = float(1).toVar();
            const light = vec3(0).toVar();
            const forward = gpuHg(d.dot(this.sun), CLOUD_MATERIAL.phase.g);
            const phase = forward.add(
              gpuHg(d.dot(this.sun), CLOUD_MATERIAL.phase.g2)
                .sub(forward)
                .mul(CLOUD_MATERIAL.phase.blend),
            );
            const airDepth = vec3(0).toVar();
            Loop(8, ({ i }) => {
              const p = vec3(0, R0, 0).add(d.mul(entry.mul(float(i).add(0.5).div(8))));
              const h = p.length().sub(BOTTOM_KM);
              airDepth.addAssign(
                vec3(...RAYLEIGH)
                  .mul(h.div(-8).exp())
                  .add(
                    h
                      .div(-1.2)
                      .exp()
                      .mul(MIE_SCATTER + MIE_ABSORB),
                  )
                  .mul(entry.div(8)),
              );
            });
            Loop(GPU_CLOUD_STEPS.view, ({ i }) => {
              If(float(i).lessThan(steps).and(through.greaterThan(0.005)), () => {
                const p = vec3(0, R0, 0).add(d.mul(entry.add(float(i).add(0.5).mul(dt))));
                const extinction = this.#noise.density(p).mul(1000).mul(fade);
                If(extinction.greaterThan(0), () => {
                  const rr = p.length();
                  const shadowLength = exit(
                    rr,
                    p.dot(this.sun).div(rr),
                    BOTTOM_KM + CLOUD_TOP_KM,
                  ).min(15);
                  const shadow = float(0).toVar();
                  Loop(GPU_CLOUD_STEPS.light, ({ i: j }) => {
                    const s = float(j).add(0.5).div(GPU_CLOUD_STEPS.light).pow(2).mul(shadowLength);
                    const ds = float(j)
                      .mul(2)
                      .add(1)
                      .mul(shadowLength)
                      .div(GPU_CLOUD_STEPS.light ** 2);
                    shadow.addAssign(
                      this.#noise
                        .density(p.add(this.sun.mul(s)))
                        .mul(1000)
                        .mul(ds),
                    );
                  });
                  const direct = float(0).toVar();
                  for (const o of cloudOctaves())
                    direct.addAssign(
                      shadow
                        .mul(-o.extinction)
                        .exp()
                        .mul(o.scatter)
                        .mul(float(1 / (4 * PI)).add(phase.sub(1 / (4 * PI)).mul(o.anisotropy))),
                    );
                  const source = this.#light
                    .mul(direct)
                    .add(this.#ambient.mul(CLOUD_MATERIAL.skyOcclusion));
                  const stepT = extinction.mul(dt).negate().exp();
                  light.addAssign(
                    through.mul(float(1).sub(stepT)).mul(CLOUD_MATERIAL.albedo).mul(source),
                  );
                  through.mulAssign(stepT);
                });
              });
            });
            cloudThrough.assign(through);
            result.addAssign(
              airDepth
                .negate()
                .exp()
                .mul(light.sub(clear.mul(float(1).sub(through)))),
            );
          });
          // Alpha carries cloud transmission for the separately drawn analytic sun disc.
          return vec4(result, cloudThrough);
        })(),
      ),
    );
  }
  override setup(_builder: NodeBuilder): Direction {
    const d = positionWorldDirection.normalize();
    const cloud = texture(this.targets.clouds.texture)
      .sample(
        vec2(
          d.z
            .atan(d.x)
            .div(2 * PI)
            .add(0.5),
          clamp(d.y, -1, 1).acos().div(PI),
        ),
      )
      .level(float(0));
    const sky = this.clouds
      ? cloud.rgb
      : texture(this.targets.sky.texture).sample(skyUv(d)).level(float(0)).rgb;
    const disc = d
      .dot(this.sun)
      .greaterThanEqual(Math.cos(SUN_RADIUS))
      .and(skyDisc.greaterThan(0.5))
      .select(
        this.#light
          .mul(this.clouds ? cloud.a : float(1))
          .div(PI * Math.sin(SUN_RADIUS) ** 2 * SKY_TO_SUN),
        vec3(0),
      );
    const colour = sky.add(disc).mul(this.#scale);
    if (!this.fogged) return colour;
    // Unreal fogs the sky like any far pixel: the exponential height fog's optical depth along a ray
    // that rises at sin(e) and never ends is density_at_camera / (falloff ln2 sin e), base 2 as in
    // HeightFogCommon.ush. A ray at or below the horizon sees the full depth, so the void is opaque.
    const fog = this.fog ?? HEIGHT_FOG_DEFAULT;
    const density = float(fog.density).mul(
      float(-fog.heightFalloff).mul(cameraPosition.y.sub(fog.fogHeight)).exp2(),
    );
    const depth = density.div(fog.heightFalloff * Math.LN2).div(d.y.max(1e-4));
    return mix(colour, this.#fog, float(1).sub(depth.negate().exp2()));
  }
  get backgroundNode(): Direction {
    return nodeObject(this);
  }
  override updateBefore(frame: NodeFrame): undefined {
    if (this.#disposed) throw new Error("GPU sky is disposed");
    const renderer = frame.renderer;
    if (renderer === null) throw new Error("GPU sky requires a renderer");
    if (this.scene.fog) this.#fog.value.copy(this.scene.fog.color);
    if (this.#last.equals(this.direction)) return;
    const length = this.direction.length();
    if (!Number.isFinite(length) || Math.abs(length - 1) > 0.001)
      throw new Error("GPU sky requires a finite unit sun");
    if (this.#ready) this.refreshEnvironment?.();
    if (this.scene.fog) this.#fog.value.copy(this.scene.fog.color);
    this.sun.value.copy(this.direction);
    const through = sunTransmittance(Math.asin(this.direction.y));
    this.#light.value.set(...through);
    const tint = temperatureColour(SUN_KELVIN);
    // The directional light takes Unreal's coarser CPU estimate; the disc and the clouds read the LUT's.
    const lit = sunLightTransmittance(Math.asin(this.direction.y));
    sunLight.current?.color.setRGB(tint[0] * lit[0], tint[1] * lit[1], tint[2] * lit[2]);
    const start = performance.now();
    const state = RendererUtils.resetRendererState(
      renderer,
      RendererUtils.saveRendererState(renderer),
    );
    try {
      const targets = Object.values(this.targets);
      for (let i = this.#ready ? 2 : 0; i < (this.clouds ? 4 : 3); i++) {
        this.#quad.material = this.materials[i] as NodeMaterial;
        renderer.setRenderTarget(targets[i] as RenderTarget);
        this.#quad.render(renderer);
      }
      this.#ready = true;
      this.#last.copy(this.direction);
      this.lastSubmissionMs = performance.now() - start;
      console.info(
        `GPU sky LUT submission: ${this.lastSubmissionMs.toFixed(1)} ms (GPU completion unmeasured)`,
      );
    } finally {
      RendererUtils.restoreRendererState(renderer, state);
    }
  }
  setAmbient(rgb: readonly number[]): void {
    this.#ambient.value.set(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0);
  }
  override dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const t of Object.values(this.targets)) t.dispose();
    for (const m of this.materials) m.dispose();
    this.#noise.map.dispose();
    super.dispose();
  }
}

/** Height fog and void colour: Unreal's distant sky light, scaled to scene radiance like the sky. */
function distantFogColour(sun: Vector3): Color {
  const tint = temperatureColour(SUN_KELVIN);
  const light = viewDistanceSkyLight(sun);
  return new Color(
    ...([0, 1, 2].map((c) => (light[c] ?? 0) * (tint[c] ?? 1) * SUN_ILLUMINANCE * SKY_TO_SUN) as [
      number,
      number,
      number,
    ]),
  );
}

/** CPU pixels are still needed by the owned PMREM.
 * Renderer::beginEnvironment rejects GPU-only textures (renderer.cpp: decoded RGBA pixels).
 * At 64x32 this avoids the full 256x128 bake; both paths use the same radiometric scale.
 * Plain bytes, no canvas: the bake runs wherever the game's JavaScript runs.
 */
export function createGpuSky(
  scene: Scene,
  sun: Vector3,
  fogged: boolean,
  clouds: boolean,
  fog: ISkyFog | undefined,
  ground: boolean,
): { node: GpuSkyNode; environment: DataTexture } {
  const w = 64;
  const h = 32;
  const pixels = new Uint8Array(w * h * 4);
  const environment = new DataTexture(pixels, w, h, RGBAFormat, UnsignedByteType);
  environment.minFilter = environment.magFilter = LinearFilter;
  const refresh = () => {
    const start = performance.now();
    const data = bakeSkyRadiance(sun, w, h, ground);
    if (clouds) bakeCloudRadiance(data, sun, w, h);
    const scale = temperatureColour(SUN_KELVIN).map((v) => v * SUN_ILLUMINANCE * SKY_TO_SUN) as [
      number,
      number,
      number,
    ];
    for (let y = 0; y < h; y++) {
      // The bake's row 0 is the zenith; a data texture's row 0 is v = 0, the nadir.
      const row = h - 1 - y;
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          const value = data[(y * w + x) * 3 + c] ?? 0;
          const v = Math.min(1, (value * (scale[c] ?? 1)) / 4);
          pixels[(row * w + x) * 4 + c] = Math.round(
            255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
          );
        }
        pixels[(row * w + x) * 4 + 3] = 255;
      }
    }
    environment.needsUpdate = true;
    node.setAmbient(viewDistanceSkyLight(sun));
    // The height fog takes its colour from the same sky light (Unreal's fog has none of its own).
    scene.fog?.color.copy(distantFogColour(sun));
    console.info(`CPU environment sky 64x32: ${(performance.now() - start).toFixed(1)} ms`);
  };
  const node = new GpuSkyNode(sun, scene, fogged, clouds, refresh, fog);
  refresh();
  return { node, environment };
}
