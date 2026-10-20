// Independent model port, no Unreal code: Engine/Shaders/Private/SkyAtmosphere.usf,
// VolumetricCloud.usf, and Source/Runtime/Renderer/Private/{SkyAtmosphere,VolumetricCloud}Rendering.cpp
// under ~/UnrealEngine-5.8.3/Engine. Physical constants remain in atmosphere.ts and clouds.ts.
import {
  CanvasTexture,
  Color,
  Data3DTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  RenderTarget,
  RepeatWrapping,
  type Scene,
  type Texture,
  Vector3,
} from "three";
import {
  Fn,
  If,
  Loop,
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
  type Node,
  type NodeBuilder,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RendererUtils,
  TempNode,
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
  sunTransmittance,
  temperatureColour,
} from "./atmosphere.js";
import {
  CLOUD_BOTTOM_KM,
  CLOUD_TOP_KM,
  EXTINCTION,
  bakeCloudRadiance,
  cloudNoiseLattice,
} from "./clouds.js";
import { skyRadiance } from "./giCache.js";

export const GPU_SKY_SIZES = {
  transmittance: [256, 64],
  multi: [32, 32],
  sky: [192, 108],
  clouds: [1024, 512],
} as const;
export const GPU_CLOUD_STEPS = { view: 16, light: 4 } as const;
const R0 = BOTTOM_KM + CAMERA_KM;
const HORIZON = Math.acos(-Math.sqrt(R0 * R0 - BOTTOM_KM * BOTTOM_KM) / R0);
const SUN_RADIUS = (0.7357000112533569 * Math.PI) / 360;
const PI = Math.PI;
type Scalar = Node<"float">;
type Direction = Node<"vec3">;

/** Horizon-focused latitude, full longitude; y up, angles in radians. */
export function skyAnglesToUv(zenith: number, longitude: number): [number, number] {
  return [
    longitude / (2 * PI),
    zenith < HORIZON
      ? (1 - Math.sqrt(Math.max(0, 1 - zenith / HORIZON))) / 2
      : (1 + Math.sqrt((zenith - HORIZON) / (PI - HORIZON))) / 2,
  ];
}
export function skyUvToAngles(u: number, v: number): [number, number] {
  return [
    v < 0.5 ? HORIZON * (1 - (1 - 2 * v) ** 2) : HORIZON + (PI - HORIZON) * (2 * v - 1) ** 2,
    u * 2 * PI,
  ];
}
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
export function gpuMedium(h: Scalar) {
  const ray = vec3(...RAYLEIGH).mul(h.div(-8).exp());
  const mie = h.div(-1.2).exp().mul(MIE_SCATTER);
  const ozone = clamp(h.lessThan(25).select(h.div(15).sub(2 / 3), h.div(-15).add(8 / 3)), 0, 1);
  return {
    ray,
    mie,
    ext: ray.add(mie.mul((MIE_SCATTER + MIE_ABSORB) / MIE_SCATTER)).add(vec3(...OZONE).mul(ozone)),
  };
}
export function gpuHg(c: Scalar, g: number): Scalar {
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

/** The same lattice and smooth interpolation as cloudDensityField, without a CPU cloud bake. */
function cloudNoise() {
  const lattice = cloudNoiseLattice();
  const rgba = new Float32Array(lattice.length * 4);
  for (let i = 0; i < lattice.length; i++) rgba[i * 4] = lattice[i] ?? 0;
  const map = new Data3DTexture(rgba, 32, 32, 32);
  map.type = FloatType;
  map.format = RGBAFormat;
  map.minFilter = map.magFilter = LinearFilter;
  map.wrapS = map.wrapT = map.wrapR = RepeatWrapping;
  map.needsUpdate = true;
  const sample = texture3D(map);
  const noise = (p: Direction) => {
    const f = p.fract();
    return sample
      .sample(
        p
          .floor()
          .add(f.mul(f).mul(vec3(3).sub(f.mul(2))))
          .add(0.5)
          .div(32),
      )
      .level(float(0)).r;
  };
  const smooth = (t: Scalar) => {
    const f = clamp(t, 0, 1);
    return f.mul(f).mul(float(3).sub(f.mul(2)));
  };
  return {
    map,
    density: (p: Direction) => {
      const altitude = p.length().sub(BOTTOM_KM);
      const h = altitude.sub(CLOUD_BOTTOM_KM).div(CLOUD_TOP_KM - CLOUD_BOTTOM_KM);
      const profile = smooth(h.div(0.08)).mul(float(1).sub(smooth(h.sub(0.2).div(0.55))));
      const broad = noise(vec3(p.x.div(2), altitude.div(3), p.z.div(2)));
      const detail = noise(vec3(p.x.div(0.35), altitude.div(0.7), p.z.div(0.35)));
      return clamp(broad.sub(0.47).sub(float(1).sub(detail).mul(0.18)).mul(5), 0, 1).mul(profile);
    },
  };
}

/** Cached passes: only texture reads and the analytic disc run at screen resolution. */
export class GpuSkyNode extends TempNode<"vec3"> {
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
  readonly #quad = new QuadMesh();
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
          const depth = vec3(0).toVar();
          Loop(16, ({ i }) => {
            const a = float(i).div(16).pow(2).mul(distance);
            const b = float(i).add(1).div(16).pow(2).mul(distance);
            const t = a.add(b).mul(0.5);
            const h = r
              .mul(r)
              .add(r.mul(mu).mul(t).mul(2))
              .add(t.mul(t))
              .sqrt()
              .sub(BOTTOM_KM)
              .max(0);
            depth.addAssign(gpuMedium(h).ext.mul(b.sub(a)));
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
      Loop(48, ({ i }) => {
        const a = float(i).div(48).pow(2).mul(length);
        const b = float(i).add(1).div(48).pow(2).mul(length);
        const p = vec3(0, r, 0).add(d.mul(a.add(b).mul(0.5)));
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
            const dt = exit(float(R0), d.y, BOTTOM_KM + CLOUD_TOP_KM)
              .sub(entry)
              .min(50)
              .div(GPU_CLOUD_STEPS.view);
            const through = float(1).toVar();
            const light = vec3(0).toVar();
            const phase = gpuHg(d.dot(this.sun), 0.65)
              .mul(0.8)
              .add(gpuHg(d.dot(this.sun), -0.2).mul(0.2));
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
              If(through.greaterThan(0.005), () => {
                const p = vec3(0, R0, 0).add(d.mul(entry.add(float(i).add(0.5).mul(dt))));
                const extinction = this.#noise.density(p).mul(EXTINCTION);
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
                        .mul(EXTINCTION)
                        .mul(ds),
                    );
                  });
                  const direct = float(0).toVar();
                  let scatter = 1;
                  for (let octave = 0; octave < 3; octave++) {
                    direct.addAssign(
                      shadow
                        .mul(-scatter)
                        .exp()
                        .mul(scatter)
                        .mul(float(1 / (4 * PI)).add(phase.sub(1 / (4 * PI)).mul(scatter))),
                    );
                    scatter *= 0.5 ** (2 ** octave);
                  }
                  const h = clamp(
                    rr.sub(BOTTOM_KM + CLOUD_BOTTOM_KM).div(CLOUD_TOP_KM - CLOUD_BOTTOM_KM),
                    0,
                    1,
                  );
                  const source = this.#light
                    .mul(direct)
                    .add(this.#ambient.mul(h.mul(0.5).add(0.5)));
                  const stepT = extinction.mul(dt).negate().exp();
                  light.addAssign(through.mul(float(1).sub(stepT)).mul(0.98).mul(source));
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
      .select(
        this.#light
          .mul(this.clouds ? cloud.a : float(1))
          .div(PI * Math.sin(SUN_RADIUS) ** 2 * SKY_TO_SUN),
        vec3(0),
      );
    const colour = sky.add(disc).mul(this.#scale);
    return this.fogged
      ? mix(colour, this.#fog, clamp(float(1).sub(d.y.div(Math.sin((1.5 * PI) / 180))), 0, 1))
      : colour;
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
    sunLight.current?.color.setRGB(
      tint[0] * through[0],
      tint[1] * through[1],
      tint[2] * through[2],
    );
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

/** CPU pixels are still needed by the owned PMREM and the world-space GI ray cache.
 * Renderer::beginEnvironment rejects GPU-only textures (renderer.cpp: decoded RGBA pixels).
 * At 64x32 this avoids the full 256x128 bake; both paths use the same radiometric scale.
 */
export function createGpuSky(
  scene: Scene,
  sun: Vector3,
  fogged: boolean,
  clouds: boolean,
): { node: GpuSkyNode; environment: Texture } | undefined {
  if (typeof OffscreenCanvas === "undefined") return undefined;
  const w = 64;
  const h = 32;
  const canvas = new OffscreenCanvas(w, h);
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  const environment = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
  const refresh = () => {
    const start = performance.now();
    const data = bakeSkyRadiance(sun, w, h);
    const clear = data.slice();
    if (clouds) bakeCloudRadiance(data, sun, w, h);
    const scale = temperatureColour(SUN_KELVIN).map((v) => v * SUN_ILLUMINANCE * SKY_TO_SUN) as [
      number,
      number,
      number,
    ];
    skyRadiance.current = { data, width: w, height: h, scale };
    const image = context.createImageData(w, h);
    const ambient = [0, 0, 0];
    let weights = 0;
    for (let y = 0; y < h; y++) {
      const theta = ((y + 0.5) / h) * PI;
      const weight = Math.sin(theta) * Math.max(0, Math.cos(theta));
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          const value = data[(y * w + x) * 3 + c] ?? 0;
          ambient[c] = (ambient[c] ?? 0) + (clear[(y * w + x) * 3 + c] ?? 0) * weight;
          const v = Math.min(1, (value * (scale[c] ?? 1)) / 4);
          image.data[(y * w + x) * 4 + c] = Math.round(
            255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
          );
        }
        weights += weight;
        image.data[(y * w + x) * 4 + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    environment.needsUpdate = true;
    node.setAmbient(ambient.map((v) => v / weights));
    console.info(`CPU environment sky 64x32: ${(performance.now() - start).toFixed(1)} ms`);
  };
  const node = new GpuSkyNode(sun, scene, fogged, clouds, refresh);
  refresh();
  return { node, environment };
}
