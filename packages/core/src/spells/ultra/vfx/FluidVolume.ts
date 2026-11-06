import { mrt, texture, uniform } from "three/tsl";
// Ported from Ultra Elements src/vfx/FluidVolume.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
//
// Engine (ThreeNative's C++ engine over WebGPU) differences, each forced:
//  - the shader revisions upstream patches over FluidVolume.glsl.js at load (REACT's turbulence, soot
//    cooling and erosion; RENDER_BODY) are written in place in FluidVolume.tsl.ts, marked "patch:".
//  - no render-target viewport: every pass draws the whole atlas. Texels past the used tiles get a
//    value no lookup reads (gridTexel and gridSample stay inside the used tiles), so the result is
//    upstream's; the cost is the unused corner of the atlas.
//  - upstream's rawPass/FullscreenQuad is a QuadMesh + NodeMaterial; renderer.compile is the warm step
//    the constructor already runs (the engine builds each pipeline at its first draw).
//  - the render material is a MeshBasicNodeMaterial; its uniforms live on the domain (`d.uniforms`).
import {
  BackSide,
  BoxGeometry,
  type Camera,
  Color,
  type Group,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NoBlending,
  NodeMaterial,
  OrthographicCamera,
  type PerspectiveCamera,
  QuadMesh,
  RGBAFormat,
  RenderTarget,
  Scene,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
  type WebGPURenderer,
} from "three/webgpu";
import type { Node } from "three/webgpu";
import { Q } from "../engine/quality.js";
import * as gl from "./FluidVolume.tsl.js";
import { FX_BLENDING, U } from "./common.js";

// GPU 3D combustion fluid (shared system; Fire is the first user).
//
// Each domain is an axis-aligned box of cubic voxels simulated on the GPU and raymarched in the
// half-res FX pass. 3D grids live in 2D atlases (slices tiled), so every sim pass is one
// fullscreen draw into a viewport covering the used tiles; trilinear lookups are two hardware
// bilinear taps in neighbouring slices. HalfFloat targets, ping-ponged.
//
// Fields: velocity (m/s), scalars (temperature th, fuel, soot, expansion), vorticity, pressure +
// divergence, and a half-res light volume. One step per frame (dt <= 1/30):
//   1 advect      semi-Lagrangian, RK2 backtrace, compensated for the domain's own motion
//   2 correct     MacCormack, clamped to the departure cell's extrema (no overshoot)
//   3 curl        vorticity
//   4 react       sources -> combustion (fuel + heat -> heat, soot, gas expansion) -> cooling ->
//                 buoyancy (heat up, soot down) -> vorticity confinement -> forceAccel() from
//                 the shared force field (wind, vortex, shock... spells push fire) -> damping
//   5 diverge     b = h^2 (div u - expansion), warm-started pressure
//   6 jacobi      Q-dependent iterations (12 / 14 / 16 / 20; Low profile 6), warm-started
//   7 project     u -= grad p; the floor (world y < 0) is solid, the other faces are open air
//   8 light       half-res: sun optical depth (march to the box exit), sky optical depth (march
//                 up), |vorticity|, occupancy, and the fire's own light (blurred blackbody
//                 emission, the "low mip" that lights the smoke orange from inside)
// Render: march the box from the camera to min(exit, scene depth), trapezoid slabs, skipping
// empty space through the light volume's occupancy. Emission is blackbody(T) x T^4 with an
// optical-thickness shoulder; soot scatters sun (HG + multiple-scattering octaves), sky and
// fire light. Sub-grid detail: the lookup is displaced by band-limited curl noise drifting with the
// gas, scaled by the resolved vorticity (wavelet-turbulence-like upres). The samples sit on a
// lattice from the ray's entry at one spacing per domain, refined in place at surfaces (see RENDER_BODY).
//
// API
//   const fluid = FluidVolume.get(fx)        create once (adds itself to fx.systems; meshes go in
//                                            fx.scenes.fx so the warm-up compiles them)
//   const d = fluid.acquire({ size: [x, y, z], res, position })   null when the pool is full
//     size   metres (rounded to whole voxels); res = voxels along the longest axis (default
//            Q.fluidRes: 32 / 48 / 64 / 96 by tier; elongated boxes may ask for more if they
//            fit the atlas). Fields start empty.
//   d.position          world centre (Vector3); move it to follow a source, advection compensates
//   d.emit(src)         this frame only (call every frame for a continuous source; max 8/frame):
//                         { pos, radius, fuel, temp, soot, vel, radial, noise, noiseScale, seed,
//                           coupling, burst }
//                       burst: values are 'at least' this (one-shot fill); else per second.
//                       temp is th (1 = the flame temperature). coupling: 1/s pull of the
//                       velocity towards vel + radial * outward (large = set).
//   d.heat              CPU estimate of the domain's heat (th m^3), for driving lights
//   d.clear()           empty the fields;  d.release()  back to the pool
//   sim fields          ignition, burnRate, heat release (heatPerFuel), sootYield, expansion,
//                       cooling, radiative, sootDecay, fuelDecay, buoyancy, sootWeight,
//                       vorticity, forceCoupling, damping; opt-in, 0 = off: turbulence (m/s2 on hot
//                       gas), turbulenceFreq (tiles/m), sootCool (soot radiates heat: dark lanes),
//                       sootErode (units/s, soot thins from its edges, keeping its billows)
//   look fields         emission, temperature (K at th = 1), tint (Color), sootColor (albedo),
//                       sootDensity, flameDensity, fuelDensity, absorb (0..1 black flame: hot gas
//                       absorbs instead of glowing), g (HG), sun, sky, fireLight, upres
//                       (voxels), upresScale (feature size, voxels), edgeFade (voxels), visible;
//                       opt-in cell detail: detailFreq (tiles/m, 0 = off; band-limited to the march
//                       step), detailErode (soot units), detailHeat (0..1), detailCenter (Vector3);
//                       nearFade (m: density ramps in over this distance from the camera);
//                       chroma (0 = grey; > 0 the gas's colour deepens with depth, thin gas paler)
//   d.obstacle          Vector4: a solid sphere in the sim (world centre xyz, radius m; w = 0 none):
//                       gas flows round it and none is left inside (a fireball on an Aegis dome)
//   cost fields         emptyBelow (extinction 1/m below which gas is skipped as empty),
//                       stepScale (march spacing x; wide thin layers can afford coarser)
// No allocation after construction; nothing recompiles (tier settings are uniforms or pass counts).

const TIER_RES: Record<string, number> = { low: 32, medium: 48, high: 64, ultra: 96 };
const TIER_SLOTS: Record<string, number> = { low: 1, medium: 2, high: 2, ultra: 2 };
const TIER_ITERS: Record<string, number> = { low: 12, medium: 14, high: 16, ultra: 20 };
const TIER_STEP: Record<string, number> = { low: 1.3, medium: 1.15, high: 1.0, ultra: 0.8 }; // render step, voxels
const TIER_MAXSTEPS: Record<string, number> = { low: 56, medium: 80, high: 112, ultra: 160 };

const DEFAULTS = {
  ignition: 0.3,
  burnRate: 3,
  heatPerFuel: 0.8,
  sootYield: 0.5,
  expansion: 1,
  cooling: 0.5,
  radiative: 0.25,
  sootDecay: 0.12,
  fuelDecay: 0.3,
  buoyancy: 5,
  sootWeight: 0.4,
  vorticity: 6,
  forceCoupling: 1,
  damping: 0.15,
  emission: 4,
  temperature: 1900,
  sootDensity: 3,
  flameDensity: 0.35,
  fuelDensity: 0,
  absorb: 0,
  g: 0.45,
  sun: 1,
  sky: 1,
  fireLight: 0.5,
  upres: 1.4,
  upresScale: 4,
  edgeFade: 5,
  visible: true,
  turbulence: 0,
  turbulenceFreq: 0.5,
  sootCool: 0,
  sootErode: 0,
  detailFreq: 0,
  detailErode: 0,
  detailHeat: 0,
  nearFade: 0.4,
  emptyBelow: 0,
  stepScale: 1,
  chroma: 0,
};

// the tiles a grid of n voxels takes in a W x H atlas, or null if it does not fit
function tileLayout(nx: number, ny: number, nz: number, W: number, H: number): number[] | null {
  const tx = Math.floor(W / nx);
  const ty = Math.floor(H / ny);
  if (tx < 1 || ty < 1) return null;
  const tilesX = Math.min(tx, nz);
  const tilesY = Math.ceil(nz / tilesX);
  return tilesY <= ty ? [tilesX, tilesY] : null;
}
const atlasSize = (N: number) => {
  const t = Math.ceil(Math.sqrt(N));
  return [t * N, Math.ceil(N / t) * N] as const;
};

function target(w: number, h: number, count = 1): RenderTarget {
  // ENGINE-GAP: a RenderTarget is RGBAFormat only (upstream: RGFormat pressure) and has no generateMipmaps
  // option (a target has no mip chain)
  const rt = new RenderTarget(w, h, {
    count,
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  // MRT: an mrtNode output writes the texture of its name (upstream: layout(location = 0/1) out oV, oS)
  const [oV, oS] = rt.textures;
  if (count === 2 && oV && oS) [oV.name, oS.name] = ["oV", "oS"];
  return rt;
}

// one emitter record (fire.ts's SRC)
export interface IFluidSource {
  pos: Vector3;
  radius?: number;
  fuel?: number;
  temp?: number;
  soot?: number;
  vel?: Vector3;
  radial?: number;
  noise?: number;
  noiseScale?: number;
  seed?: number;
  coupling?: number;
  burst?: boolean;
}

type U4 = Node<"vec4"> & { value: Vector4 };
type U3 = Node<"vec3"> & { value: Vector3 };
type U2 = Node<"vec2"> & { value: Vector2 };
type U1 = Node<"float"> & { value: number };
type Tex = gl.TexNode;

interface IRenderUniforms {
  uS: Tex;
  uL0: Tex;
  uDim: U3;
  uTiles: U2;
  uInv: U2;
  uCDim: U3;
  uCTiles: U2;
  uCInv: U2;
  uOrigin: U3;
  uH: U1;
  uMarch: U4;
  uMarch2: U4;
  uLit: U4;
  uSootColor: U3;
  uDetail: U4;
  uDetailC: U3;
  uLook0: U4;
  uLook1: U4;
  uTint: U3;
}

class FluidDomain {
  // the fields fire.ts sets by name (Object.assign(f, {...}))
  [field: string]: unknown;
  sys: FluidVolume;
  W: number;
  H: number;
  cW: number;
  cH: number;
  state: RenderTarget[];
  tmp: RenderTarget;
  curl: RenderTarget;
  press: RenderTarget[];
  light: RenderTarget;
  all: RenderTarget[];
  dim = new Vector3(8, 8, 8);
  tiles = new Vector2(1, 1);
  cdim = new Vector3(4, 4, 4);
  ctiles = new Vector2(1, 1);
  h = 0.1;
  size = new Vector3();
  position = new Vector3();
  origin = new Vector3();
  lastOrigin = new Vector3();
  tint = new Color(1, 1, 1);
  sootColor = new Color(0.13, 0.12, 0.11);
  detailCenter = new Vector3();
  obstacle = new Vector4();
  srcP = Array.from({ length: gl.MAX_SRC }, () => new Vector4());
  srcA = Array.from({ length: gl.MAX_SRC }, () => new Vector4());
  srcV = Array.from({ length: gl.MAX_SRC }, () => new Vector4());
  srcB = Array.from({ length: gl.MAX_SRC }, () => new Vector4());
  nSrc = 0;
  active = false;
  cur = 0;
  pc = 0;
  fresh = true;
  heat = 0;
  fuelPool = 0;
  mesh!: Mesh;
  material!: MeshBasicNodeMaterial;
  uniforms!: IRenderUniforms;
  declare ignition: number;
  declare burnRate: number;
  declare heatPerFuel: number;
  declare sootYield: number;
  declare expansion: number;
  declare cooling: number;
  declare radiative: number;
  declare sootDecay: number;
  declare fuelDecay: number;
  declare buoyancy: number;
  declare sootWeight: number;
  declare vorticity: number;
  declare forceCoupling: number;
  declare damping: number;
  declare emission: number;
  declare temperature: number;
  declare sootDensity: number;
  declare flameDensity: number;
  declare fuelDensity: number;
  declare absorb: number;
  declare g: number;
  declare sun: number;
  declare sky: number;
  declare fireLight: number;
  declare upres: number;
  declare upresScale: number;
  declare edgeFade: number;
  declare visible: boolean;
  declare turbulence: number;
  declare turbulenceFreq: number;
  declare sootCool: number;
  declare sootErode: number;
  declare detailFreq: number;
  declare detailErode: number;
  declare detailHeat: number;
  declare nearFade: number;
  declare emptyBelow: number;
  declare stepScale: number;
  declare chroma: number;

  constructor(sys: FluidVolume, W: number, H: number, cW: number, cH: number) {
    this.sys = sys;
    this.W = W;
    this.H = H;
    this.cW = cW;
    this.cH = cH;
    this.state = [target(W, H, 2), target(W, H, 2)]; // (velocity, scalars)
    this.tmp = target(W, H, 2);
    this.curl = target(W, H);
    this.press = [target(W, H), target(W, H)];
    this.light = target(cW, cH);
    this.all = [...this.state, this.tmp, this.curl, ...this.press];
    Object.assign(this, DEFAULTS);
  }

  setGrid(
    nx: number,
    ny: number,
    nz: number,
    tiles: number[],
    cn: number[],
    ctiles: number[],
    h: number,
  ): void {
    this.dim.set(nx, ny, nz);
    this.tiles.set(tiles[0] as number, tiles[1] as number);
    this.cdim.set(cn[0] as number, cn[1] as number, cn[2] as number);
    this.ctiles.set(ctiles[0] as number, ctiles[1] as number);
    this.h = h;
    this.size.set(nx * h, ny * h, nz * h);
    // (engine: no render-target viewport, see the header; upstream set t.viewport to the used tiles)
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
  emit(s: IFluidSource): void {
    if (!this.active || this.nSrc >= gl.MAX_SRC) return;
    const i = this.nSrc++;
    const v = s.vel;
    const burst = s.burst ? 1 : 0;
    (this.srcP[i] as Vector4).set(s.pos.x, s.pos.y, s.pos.z, s.radius ?? 0.5);
    (this.srcA[i] as Vector4).set(s.fuel ?? 0, s.temp ?? 0, s.soot ?? 0, s.noise ?? 0);
    (this.srcV[i] as Vector4).set(v ? v.x : 0, v ? v.y : 0, v ? v.z : 0, s.radial ?? 0);
    (this.srcB[i] as Vector4).set(burst, s.noiseScale ?? 1, s.seed ?? 0, s.coupling ?? 0);
    // CPU mirror of the heat budget (drives lights): effective volume of the soft sphere
    const r = s.radius ?? 0.5;
    const vol = 1.6 * r * r * r * (1 - 0.5 * (s.noise ?? 0));
    const k = burst ? 1 : this.sys.dt;
    this.fuelPool += (s.fuel ?? 0) * vol * k;
    this.heat += (s.temp ?? 0) * vol * k * 0.5;
  }

  clear(): void {
    this.fresh = true;
  }

  release(): void {
    this.active = false;
    this.mesh.visible = false;
    this.nSrc = 0;
  }
}

const _c = new Color();
const quadCam = new OrthographicCamera();
const EMPTY = new Scene();
const _v = new Vector3();

// one fullscreen pass (upstream FullscreenQuad over rawPass). A two-output pass writes (oV, oS)
// through the material's mrtNode into a two-texture target.
class FullscreenPass<O extends object> {
  readonly quad: QuadMesh;
  constructor(
    readonly uniforms: O,
    outputs: Node<"vec4">[],
  ) {
    const m = new NodeMaterial();
    const [oV, oS] = outputs as [Node<"vec4">, Node<"vec4"> | undefined];
    m.fragmentNode = oV;
    if (oS) {
      m.mrtNode = mrt({ oV, oS });
      // ENGINE-GAP: the engine finds a material's textures from its node slots, not its mrtNode
      // (MaterialNodes::pointers() in position_node.h), so a texture only oS reads has no binding
      // ("TN_NATIVE_BINDING_UNSUPPORTED: t_nodeMapN has no texture this draw"). The fragmentNode names
      // both outputs; each attachment still draws its own mrtNode output. Back to `oV` once fixed.
      m.fragmentNode = oV.add(oS.mul(0.0));
    }
    m.depthTest = false;
    m.blending = NoBlending; // every channel is data (alpha too)
    m.depthWrite = false;
    this.quad = new QuadMesh(m);
  }
  render(renderer: WebGPURenderer, out: RenderTarget): void {
    renderer.setRenderTarget(out);
    this.quad.render(renderer);
  }
}

export interface IFluidFx {
  renderer?: WebGPURenderer;
  scenes: { fx: Group };
  systems: { update(dt: number, camera: Camera): void }[];
  fluidVolume?: FluidVolume;
}

export class FluidVolume {
  // engine: fx.fluid is main.ts's service seam (a getter), so the instance lives in fx.fluidVolume
  static get(fx: IFluidFx): FluidVolume {
    if (!fx.fluidVolume) {
      fx.fluidVolume = new FluidVolume(fx);
      fx.systems.push(fx.fluidVolume);
    }
    return fx.fluidVolume;
  }

  fx: IFluidFx;
  renderer: WebGPURenderer;
  res: number;
  iterations: number;
  stepVox: number;
  maxSteps: number;
  dt: number;
  pending = 0;
  lastFrame: number | undefined = -1;
  su;
  look;
  passes;
  domains: FluidDomain[];

  constructor(fx: IFluidFx) {
    this.fx = fx;
    if (!fx.renderer)
      throw new Error("FluidVolume: createFx needs the renderer (options.renderer)");
    this.renderer = fx.renderer;
    const tier = Q.tier;
    const q = Q as typeof Q & {
      fluidRes?: number;
      fluidIterations?: number;
      fluidDomains?: number;
    };
    this.res = q.fluidRes ?? TIER_RES[tier] ?? 64;
    this.iterations = q.fluidIterations ?? TIER_ITERS[tier] ?? 20;
    this.stepVox = TIER_STEP[tier] ?? 0.85;
    this.maxSteps = TIER_MAXSTEPS[tier] ?? 112;
    this.dt = 1 / 60;
    const [W, H] = atlasSize(this.res);
    const [cW, cH] = atlasSize(Math.ceil(this.res / 2));

    // sim uniforms shared by reference across every pass; set per domain before its passes
    // biome-ignore lint/suspicious/noAssignInExpressions: upstream Ultra Elements code, copied verbatim
    const su = (this.su = {
      uDim: uniform(new Vector3()),
      uTiles: uniform(new Vector2()),
      uInv: uniform(new Vector2(1 / W, 1 / H)),
      uOrigin: uniform(new Vector3()),
      uH: uniform(0.1),
      uSimDt: uniform(1 / 60),
      uShift: uniform(new Vector3()),
      uObst: uniform(new Vector4()),
    });
    // a texture uniform: a texture() node whose .value the passes swap (a placeholder of the same type)
    const blank = target(1, 1).texture;
    const tex = () => texture(blank);
    const v4s = () => Array.from({ length: gl.MAX_SRC }, () => uniform(new Vector4()));
    this.look = {
      uLook0: uniform(new Vector4()),
      uLook1: uniform(new Vector4()),
      uTint: uniform(new Vector3(1, 1, 1)),
    };
    const sim = su as unknown as gl.ISim;
    const own = <O extends object>(o: O, build: (u: O) => Node<"vec4">[]) =>
      new FullscreenPass(o, build(o));
    const both = (f: (out: "V" | "S") => Node<"vec4">) => [f("V"), f("S")];
    const advect = { uV: tex(), uS: tex() };
    const correct = { uV: tex(), uS: tex(), uVf: tex(), uSf: tex(), uMacCormack: uniform(1) };
    const react = {
      uV: tex(),
      uS: tex(),
      uC: tex(),
      uSrcP: v4s(),
      uSrcA: v4s(),
      uSrcV: v4s(),
      uSrcB: v4s(),
      uSrcN: uniform(0, "int"),
      uBurn: uniform(new Vector4()),
      uDecay: uniform(new Vector4()),
      uForce: uniform(new Vector4()),
      uFlow: uniform(new Vector4()),
      uTurb: uniform(new Vector4()),
    };
    const light = {
      ...this.look,
      uS: tex(),
      uC: tex(),
      uCDim: uniform(new Vector3()),
      uCTiles: uniform(new Vector2()),
      uCInv: uniform(new Vector2(1 / cW, 1 / cH)),
      uLightP: uniform(new Vector4(2.5, 3, 1, 0)),
    };
    this.passes = {
      advect: own(advect, (u) => both((o) => gl.ADVECT(sim, u, o))),
      correct: own(correct, (u) =>
        both((o) => gl.CORRECT(sim, u as unknown as Parameters<typeof gl.CORRECT>[1], o)),
      ),
      curl: own({ uV: tex() }, (u) => [gl.CURL(sim, u)]),
      react: own(react, (u) => both((o) => gl.REACT(sim, u as unknown as gl.IReactOwn, o))),
      diverge: own({ uV: tex(), uS: tex(), uP: tex(), uWarm: uniform(0.9) }, (u) => [
        gl.DIVERGE(sim, u as unknown as Parameters<typeof gl.DIVERGE>[1]),
      ]),
      jacobi: own({ uP: tex() }, (u) => [gl.JACOBI(sim, u)]),
      project: own({ uV: tex(), uS: tex(), uP: tex() }, (u) => both((o) => gl.PROJECT(sim, u, o))),
      light: own(light, (u) => [gl.LIGHT(sim, u as unknown as gl.ILightOwn)]),
    };

    // domains: each owns its targets and a box proxy in the fx scene
    const box = new BoxGeometry(1, 1, 1);
    const slots = q.fluidDomains ?? TIER_SLOTS[tier] ?? 2;
    this.domains = [];
    for (let i = 0; i < slots; i++) {
      const d = new FluidDomain(this, W, H, cW, cH);
      const m: IRenderUniforms = {
        uS: texture((d.state[0] as RenderTarget).textures[1] as Texture),
        uL0: texture(d.light.texture),
        uDim: uniform(d.dim),
        uTiles: uniform(d.tiles),
        uInv: uniform(new Vector2(1 / W, 1 / H)),
        uCDim: uniform(d.cdim),
        uCTiles: uniform(d.ctiles),
        uCInv: uniform(new Vector2(1 / cW, 1 / cH)),
        uOrigin: uniform(d.origin),
        uH: uniform(0.1),
        uMarch: uniform(new Vector4()),
        uMarch2: uniform(new Vector4()),
        uLit: uniform(new Vector4()),
        uSootColor: uniform(new Vector3()),
        uDetail: uniform(new Vector4()),
        uDetailC: uniform(d.detailCenter),
        uLook0: uniform(new Vector4()),
        uLook1: uniform(new Vector4()),
        uTint: uniform(new Vector3(1, 1, 1)),
      };
      d.uniforms = m;
      d.material = new MeshBasicNodeMaterial({ ...FX_BLENDING, depthTest: false, side: BackSide });
      d.material.fog = false;
      d.material.fragmentNode = gl.RENDER(m as unknown as gl.IRenderOwn);
      d.mesh = new Mesh(box, d.material);
      d.mesh.visible = false;
      d.mesh.frustumCulled = false;
      fx.scenes.fx.add(d.mesh);
      this.domains.push(d);
    }

    // run every pass once now (ANGLE finishes some programs at first draw), then forget it
    const d0 = this.domains[0] as FluidDomain;
    this.layout(d0, [1, 1, 1], 8);
    d0.active = true;
    this.clearDomain(d0);
    this.step(d0, 1 / 60);
    d0.active = false;
    d0.fresh = true;
  }

  // pick voxel counts for a box of `size` metres with `res` voxels on its longest axis
  layout(d: FluidDomain, size: number[], res: number): boolean {
    const [sx, sy, sz] = size as [number, number, number];
    const big = Math.max(sx, sy, sz);
    for (let r = Math.max(8, Math.round(res)); r >= 8; r -= 2) {
      const h = big / r;
      const nx = Math.max(4, Math.round(sx / h));
      const ny = Math.max(4, Math.round(sy / h));
      const nz = Math.max(4, Math.round(sz / h));
      const cx = Math.ceil(nx / 2);
      const cy = Math.ceil(ny / 2);
      const cz = Math.ceil(nz / 2);
      const t = tileLayout(nx, ny, nz, d.W, d.H);
      const ct = tileLayout(cx, cy, cz, d.cW, d.cH);
      if (!t || !ct) continue;
      d.setGrid(nx, ny, nz, t, [cx, cy, cz], ct, h);
      return true;
    }
    return false;
  }

  acquire({
    size = [4, 4, 4],
    res = this.res,
    position = null,
  }: { size?: number[]; res?: number; position?: Vector3 | null } = {}): FluidDomain | null {
    const d = this.domains.find((x) => !x.active);
    if (!d || !this.layout(d, size, res)) return null;
    Object.assign(d, DEFAULTS);
    d.tint.setRGB(1, 1, 1);
    d.sootColor.setRGB(0.13, 0.12, 0.11);
    d.detailCenter.set(0, 0, 0);
    d.obstacle.set(0, 0, 0, 0);
    if (position) d.position.copy(position);
    d.active = true;
    d.fresh = true;
    d.nSrc = 0;
    d.heat = 0;
    d.fuelPool = 0;
    return d;
  }

  get active(): boolean {
    return this.domains.some((d) => d.active);
  }

  clearDomain(d: FluidDomain): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const alpha = r.getClearAlpha();
    r.getClearColor(_c);
    r.setClearColor(0x000000, 0);
    // engine: no renderer.clear(); a target draw clears to the clear colour first, so an empty draw clears
    for (const t of d.all) {
      r.setRenderTarget(t);
      r.render(EMPTY, quadCam);
    }
    r.setRenderTarget(d.light);
    r.render(EMPTY, quadCam);
    r.setClearColor(_c, alpha);
    r.setRenderTarget(prev);
    d.cur = 0;
    d.pc = 0;
    d.fresh = false;
  }

  draw(name: keyof FluidVolume["passes"], out: RenderTarget) {
    const p = this.passes[name];
    p.render(this.renderer, out);
    return p.uniforms;
  }

  // one sim step for domain d
  step(d: FluidDomain, dt: number): void {
    const su = this.su;
    const P = this.passes;
    d.origin.copy(d.position).addScaledVector(d.size, -0.5);
    su.uDim.value.copy(d.dim);
    su.uTiles.value.copy(d.tiles);
    su.uOrigin.value.copy(d.origin);
    su.uH.value = d.h;
    su.uSimDt.value = dt;
    su.uShift.value.subVectors(d.origin, d.lastOrigin).divideScalar(d.h);
    d.lastOrigin.copy(d.origin);
    const ob = d.obstacle;
    su.uObst.value.set(
      (ob.x - d.origin.x) / d.h - 0.5,
      (ob.y - d.origin.y) / d.h - 0.5,
      (ob.z - d.origin.z) / d.h - 0.5,
      ob.w / d.h,
    );
    const A = d.state[d.cur] as RenderTarget;
    const B = d.state[1 - d.cur] as RenderTarget;
    const [Av, As] = A.textures as [Texture, Texture];
    const [Bv, Bs] = B.textures as [Texture, Texture];

    const ua = P.advect.uniforms;
    ua.uV.value = Av;
    ua.uS.value = As;
    this.draw("advect", d.tmp);
    const uc = P.correct.uniforms;
    uc.uV.value = Av;
    uc.uS.value = As;
    uc.uVf.value = d.tmp.textures[0] as Texture;
    uc.uSf.value = d.tmp.textures[1] as Texture;
    this.draw("correct", B);
    su.uShift.value.set(0, 0, 0);
    P.curl.uniforms.uV.value = Bv;
    this.draw("curl", d.curl);

    const u = P.react.uniforms;
    u.uV.value = Bv;
    u.uS.value = Bs;
    u.uC.value = d.curl.texture;
    u.uSrcN.value = d.nSrc;
    for (let i = 0; i < d.nSrc; i++) {
      (u.uSrcP[i] as U4).value.copy(d.srcP[i] as Vector4);
      (u.uSrcA[i] as U4).value.copy(d.srcA[i] as Vector4);
      (u.uSrcV[i] as U4).value.copy(d.srcV[i] as Vector4);
      (u.uSrcB[i] as U4).value.copy(d.srcB[i] as Vector4);
    }
    u.uBurn.value.set(d.ignition, d.burnRate, d.heatPerFuel, d.sootYield);
    u.uDecay.value.set(d.cooling, d.radiative, d.sootDecay, d.fuelDecay);
    u.uForce.value.set(d.buoyancy, d.sootWeight, d.vorticity, d.expansion);
    u.uFlow.value.set(d.forceCoupling, d.damping, 0, 0);
    u.uTurb.value.set(d.turbulence, d.turbulenceFreq, d.sootErode, d.sootCool);
    this.draw("react", A);

    const ud = P.diverge.uniforms;
    ud.uV.value = Av;
    ud.uS.value = As;
    ud.uP.value = (d.press[d.pc] as RenderTarget).texture;
    this.draw("diverge", d.press[1 - d.pc] as RenderTarget);
    d.pc = 1 - d.pc;
    const J = P.jacobi.uniforms;
    for (let i = 0; i < this.iterations; i++) {
      J.uP.value = (d.press[d.pc] as RenderTarget).texture;
      this.draw("jacobi", d.press[1 - d.pc] as RenderTarget);
      d.pc = 1 - d.pc;
    }
    const up = P.project.uniforms;
    up.uV.value = Av;
    up.uS.value = As;
    up.uP.value = (d.press[d.pc] as RenderTarget).texture;
    this.draw("project", B);
    d.cur = 1 - d.cur;

    // CPU heat mirror: pending fuel burns at the sim's rate, heat cools at its rate
    const burned = d.fuelPool * (1 - Math.exp(-d.burnRate * dt));
    d.fuelPool -= burned;
    d.heat = (d.heat + burned * d.heatPerFuel) * Math.exp(-(d.cooling + 0.6 * d.radiative) * dt);
  }

  setLook(d: FluidDomain, u: { uLook0: U4; uLook1: U4; uTint: U3 }): void {
    u.uLook0.value.set(d.emission, d.sootDensity, d.flameDensity, d.absorb);
    u.uLook1.value.set(d.temperature, 300, d.fuelDensity, d.chroma);
    u.uTint.value.set(d.tint.r, d.tint.g, d.tint.b);
  }

  // main calls this every frame inside the timed 'sim' section
  update(dt0: number, camera: Camera): void {
    // engine: createFx's renderFrame runs per fixed update, which can be several per drawn frame; the
    // fluid steps once per drawn frame (upstream: once per renderFrame) over the time since its last step
    const frame = (this.renderer.info as { frame?: number }).frame;
    this.pending += dt0;
    if (frame !== undefined && frame === this.lastFrame) return;
    this.lastFrame = frame;
    const dt = this.pending;
    this.pending = 0;
    this.dt = Math.min(dt, 1 / 30);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    camera.getWorldDirection(gl.uCamFwd.value);
    const fxH = U.uFxResolution.value.y;
    // biome-ignore lint/style/noNonNullAssertion: upstream Ultra Elements code, copied verbatim
    const mPerPx = 1 / (0.5 * fxH * (camera as PerspectiveCamera).projectionMatrix.elements[5]!);
    for (const d of this.domains) {
      d.mesh.visible = d.active && d.visible;
      if (!d.active) continue;
      if (d.fresh) {
        this.clearDomain(d);
        d.origin.copy(d.position).addScaledVector(d.size, -0.5);
        d.lastOrigin.copy(d.origin);
      }
      if (dt > 0) this.step(d, this.dt);
      d.nSrc = 0;
      d.origin.copy(d.position).addScaledVector(d.size, -0.5);
      // light volume (also while paused: the sun may move)
      const su = this.su;
      const L = this.passes.light.uniforms;
      su.uDim.value.copy(d.dim);
      su.uTiles.value.copy(d.tiles);
      su.uOrigin.value.copy(d.origin);
      su.uH.value = d.h;
      L.uS.value = (d.state[d.cur] as RenderTarget).textures[1] as Texture;
      L.uC.value = d.curl.texture;
      L.uCDim.value.copy(d.cdim);
      L.uCTiles.value.copy(d.ctiles);
      L.uLightP.value.set(2.5, 2, d.fireLight, d.emptyBelow);
      this.setLook(d, this.look);
      this.draw("light", d.light);
      // render uniforms
      const m = d.uniforms;
      m.uS.value = (d.state[d.cur] as RenderTarget).textures[1] as Texture;
      m.uH.value = d.h;
      this.setLook(d, m);
      // sample spacing: a fraction of a voxel, never finer than the pixel footprint at the domain's
      // distance, and coarse enough that the box's diagonal fits the step budget
      const auto = Math.min(1, Q.auto?.steps ?? 1);
      const steps = Math.max(8, Math.floor(this.maxSteps * auto));
      const dist = _v.subVectors(camera.position, d.position).length();
      const dtm = Math.max(
        (this.stepVox * d.stepScale * d.h) / auto,
        dist * mPerPx,
        d.size.length() / steps,
      );
      // displacement: one curl octave, its finest band (1/16 tile) no finer than the march step
      m.uMarch.value.set(
        dtm,
        steps,
        d.upres,
        Math.min(1 / (4 * d.upresScale * d.h), 1 / (16 * dtm)),
      );
      m.uMarch2.value.set(
        d.edgeFade,
        mPerPx,
        d.origin.y > -0.5 * d.h ? 1 : 0,
        1 / Math.max(d.nearFade, 0.01),
      );
      // the empty-space stride stays inside the occupancy's ~3 voxel dilation; the cell pattern's
      // main octaves (a quarter and an eighth of a tile) stay above the sample spacing
      m.uDetail.value.set(
        d.detailErode,
        Math.min(d.detailFreq, 1 / (12 * dtm)),
        d.detailHeat,
        Math.max(1, Math.floor((3 * d.h) / dtm)),
      );
      m.uLit.value.set(d.g, d.sun, d.sky, 1);
      m.uSootColor.value.set(d.sootColor.r, d.sootColor.g, d.sootColor.b);
      d.mesh.position.copy(d.position);
      d.mesh.scale.copy(d.size);
      d.mesh.updateMatrixWorld();
    }
    r.setRenderTarget(prev);
  }
}
