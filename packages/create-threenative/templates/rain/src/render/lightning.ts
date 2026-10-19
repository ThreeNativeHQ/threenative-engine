// Generated for you. Ordinary Three.js, and one lightning bolt lives in this file.
//
// The reference study drew a strike as CPU geometry: a seeded generator walks a 30 segment channel
// from a random point in the sky down to a ground point, throwing off short side branches as it
// goes, and each segment becomes a quad carrying its own two endpoints. The vertex stage projects
// those two endpoints by hand and widens the quad across the segment in screen space, so the ribbon
// is always camera facing and always the same number of pixels wide however far away it is; the
// fragment stage is one gaussian core inside one wide halo. Nothing is simulated — a strike is
// geometry that already exists, and it is only visible while the caller's flash envelope is above
// zero.
//
// The engine owns the frame loop, the scene and the renderer, so this file owns the bolt geometry,
// its uniforms and its own lifetime — and draws nothing itself. No render loop, no raw GL, no
// engine package import, so the same file runs wherever the game runs.
// Conventions: one world unit is one metre, so a strike lands at a real point on the coast.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  type PerspectiveCamera,
  type Scene,
  Vector3,
} from "three";
import {
  Fn,
  abs,
  attribute,
  cameraFar,
  cameraNear,
  clamp,
  dot,
  exp,
  float,
  frameGroup,
  max,
  mix,
  normalize,
  positionGeometry,
  screenSize,
  select,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial, type Node } from "three/webgpu";

/**
 * Room for one bolt's worst case: the study's 30 channel segments, plus every branch it can throw.
 * A branch starts at one of the interior channel points and is at most 9 segments long, so this is
 * the true ceiling rather than a guess. The buffers are allocated once and reused, so a strike never
 * reallocates a geometry and never orphans a GPU buffer.
 */
const MAX_SEGMENTS = 30 + 24 * 9;
const VERTICES_PER_SEGMENT = 6;

/** The two-triangle corner pattern the study's `boltGeometry` wrote, as three-component positions. */
const SEGMENT_CORNERS = new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, -1, 1, 0, 1, 0, 0, 1, 1, 0]);
const CORNERS = new Float32Array(MAX_SEGMENTS * SEGMENT_CORNERS.length);
for (let at = 0; at < CORNERS.length; at += SEGMENT_CORNERS.length) {
  CORNERS.set(SEGMENT_CORNERS, at);
}

/** One segment of ribbon: its own two world endpoints and how bright it burns. */
export interface IBoltSegment {
  readonly a: Vector3;
  readonly b: Vector3;
  /** 1 down the main channel, decaying towards nothing at the tip of a branch. */
  readonly strength: number;
}

/** One bolt, as the study's `makeBolt` returned it. */
export interface IBolt {
  readonly segments: IBoltSegment[];
  /** Where the bolt entered the sky, in metres — the caller's point for scene glow and thunder. */
  readonly origin: Vector3;
  readonly end: Vector3;
}

/** The study's `mix`: `a + (b - a) * t`. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The study's own `makeBolt`, constant for constant. `end` is the point on the ground the bolt
 * strikes; `random` is the caller's, so the same source replayed gives the same bolt.
 *
 * The channel starts in the sky between 145 and 245 metres up, jittered around `end`, and walks down
 * in 30 steps whose lateral jitter shrinks as it falls (`1 - f`), so a bolt reads as a strike
 * tightening on its target rather than a random walk. Branches come off the middle of the channel
 * only (`i > 3 && i < n - 3`), run to one side, and stop at the ground.
 */
export function makeBolt(end: Vector3, random: () => number): IBolt {
  const segments: IBoltSegment[] = [];
  const y = 145 + random() * 100;
  let a = new Vector3(end.x + random() * 42 - 21, y, end.z + random() * 18 - 9);
  const origin = a.clone();
  const n = 30;

  for (let i = 1; i <= n; i++) {
    const f = i / n;
    const b = new Vector3(
      lerp(origin.x, end.x, f) + (random() - 0.5) * 13 * (1 - f),
      lerp(y, end.y, f),
      lerp(origin.z, end.z, f) + (random() - 0.5) * 8 * (1 - f),
    );
    segments.push({ a: a.clone(), b: b.clone(), strength: 1 });

    if (i > 3 && i < n - 3 && random() < 0.39) {
      const c = a.clone();
      const dir = random() < 0.5 ? -1 : 1;
      const length = 4 + Math.floor(random() * 6);
      for (let j = 0; j < length && segments.length < MAX_SEGMENTS; j++) {
        const d = new Vector3(
          c.x + dir * (3 + random() * 10),
          c.y - 3 - random() * 9,
          c.z + (random() - 0.5) * 8,
        );
        if (d.y < 2) break;
        segments.push({ a: c.clone(), b: d.clone(), strength: 0.45 * (1 - j / 12) });
        c.copy(d);
      }
    }
    a = b;
  }
  return { segments, origin, end: end.clone() };
}

export interface IStormLightning {
  /** The real mesh, for the engine's culling pass and for a scene walk that counts what is drawn. */
  readonly mesh: Mesh;
  /**
   * Builds one bolt down to `position` and hands back where it entered the sky, in metres, for the
   * scene glow and the thunder delay. `random` is the caller's, so a strike is reproducible.
   */
  strike(position: Vector3, random: () => number): Vector3;
  /** Current flash envelope. The caller has already gated it on the photosensitivity switch. */
  update(flash: number): void;
  dispose(): void;
}

/**
 * The bolt pass: one draw of six-vertex quads, added to `scene`.
 *
 * The engine's `GPUParticles3D` cannot carry this: the bolt is not a particle system,
 * it is CPU geometry with per-segment endpoints handed straight to the vertex stage. This is the
 * smallest thing that holds the study's maths — one non-indexed `BufferGeometry` whose attribute
 * buffers are allocated once, and a draw range that stays empty until a strike asks for it.
 */
export function createStormLightning(scene: Scene, camera: PerspectiveCamera): IStormLightning {
  // The camera block the study passed to the bolt pass, and to the coast, from the same basis.
  const uFlash = uniform(0, "float").setGroup(frameGroup);
  const uCam = uniform(new Vector3(), "vec3").setGroup(frameGroup);
  const uForward = uniform(new Vector3(), "vec3").setGroup(frameGroup);
  const uRight = uniform(new Vector3(), "vec3").setGroup(frameGroup);
  const uUp = uniform(new Vector3(), "vec3").setGroup(frameGroup);
  const uAspect = uniform(0, "float").setGroup(frameGroup);
  const uTan = uniform(0, "float").setGroup(frameGroup);

  /**
   * The study's `proj`. Its x and y are the ordinary perspective divide for this camera's field of
   * view, and its z becomes the depth the coast already wrote from the same near and far planes — so
   * a bolt behind the headland is hidden by it, which is the one comparison that pass existed for.
   */
  function proj(p: Node<"vec3">) {
    const v = p.sub(uCam);
    const d = dot(v, uForward);
    const depth = clamp(
      cameraNear
        .add(cameraFar)
        .sub(cameraNear.mul(cameraFar).mul(2).div(d))
        .div(cameraFar.sub(cameraNear))
        .add(1)
        .mul(0.5),
      0,
      1,
    );
    return vec4(dot(v, uRight).div(uAspect.mul(uTan)), dot(v, uUp).div(uTan), depth.mul(d), d);
  }

  // --- the vertex stage, transcribed from the study's BOLT_VERTEX --------------------------

  const startNode = attribute<"vec3">("aStart", "vec3");
  const endNode = attribute<"vec3">("aEnd", "vec3");
  const strengthNode = attribute<"float">("aStrength", "float");

  // `Fn` because the stage assigns into its own clip-space vector twice; outside a function body
  // TSL has no stack to emit those assignments into, and drops the ribbon's width.
  const ribbon = Fn(() => {
    const a = proj(startNode).toVar();
    const b = proj(endNode).toVar();
    // The screen direction from one endpoint to the other, so the quad's width follows the bolt
    // instead of the world axes. The epsilon is the study's own, for when the two endpoints land on
    // top of each other and there is no direction at all.
    const dir = normalize(
      b.xy
        .div(max(b.w, float(0.1)))
        .sub(a.xy.div(max(a.w, float(0.1))))
        .mul(screenSize)
        .add(0.00001),
    ).toVar();
    const side = vec2(dir.y.negate(), dir.x);
    const clip = mix(a, b, positionGeometry.y).toVar();
    // Width in pixels, a little wider for a strong segment: the study's `(7. + 5. * aStrength)`. The
    // offset carries the vertex's own `w`, because the quad is authored in clip space.
    const across = side
      .mul(positionGeometry.x)
      .mul(float(7).add(strengthNode.mul(5)))
      .div(screenSize)
      .mul(clip.w)
      .mul(2);
    clip.addAssign(vec4(across.x, across.y, float(0), float(0)));
    // An endpoint behind the camera has no direction to stretch along; the study threw the quad off
    // screen rather than letting it collapse to a dot on the near plane.
    clip.assign(select(a.w.lessThan(0.2).or(b.w.lessThan(0.2)), vec4(2, 2, 2, 1), clip));
    return clip;
  })();

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", dynamic(new BufferAttribute(CORNERS, 3)));
  geometry.setAttribute(
    "aStart",
    dynamic(new BufferAttribute(new Float32Array(CORNERS.length), 3)),
  );
  geometry.setAttribute("aEnd", dynamic(new BufferAttribute(new Float32Array(CORNERS.length), 3)));
  geometry.setAttribute(
    "aStrength",
    dynamic(new BufferAttribute(new Float32Array(CORNERS.length / 3), 1)),
  );
  // No bolt has been struck yet, so there is nothing to draw.
  geometry.setDrawRange(0, 0);

  const material = new MeshBasicNodeMaterial();
  // The ribbons are wound by the projection, not by the vertex order, so either face can end up
  // front facing; the study's pass drew both.
  material.side = DoubleSide;
  material.transparent = true;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  material.vertexNode = ribbon;

  const vAcross = varying(positionGeometry.x, "vAcross");
  const vStrength = varying(strengthNode, "vStrength") as Node<"float">;
  // One gaussian core inside one wide halo, the study's `core * 15. + halo * 2.`, added on top of
  // whatever the coast already drew — which is what makes a bolt read as light, not as paint.
  const core = exp(vAcross.mul(vAcross).negate().mul(750)).toVar();
  const halo = exp(abs(vAcross).negate().mul(7)).mul(0.42).toVar();
  material.fragmentNode = vec4(
    vec3(0.55, 0.78, 1.35)
      .mul(core.mul(15).add(halo.mul(2)))
      .mul(vStrength.mul(uFlash)),
    1,
  );

  const mesh = new Mesh(geometry, material);
  // The buffers hold every possible bolt's worth of quads parked at the origin, so the geometry's
  // own bounds say nothing about where a strike actually is.
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  scene.add(mesh);

  const forward = new Vector3();
  const right = new Vector3();
  const up = new Vector3();

  return {
    mesh,
    strike(position, random): Vector3 {
      if (!isFiniteVector(position)) {
        throw new Error(
          `strike position must be a finite point in metres, got ${describe(position)}.`,
        );
      }
      if (typeof random !== "function") {
        throw new Error(`strike needs the caller's random source, got ${typeof random}.`);
      }
      // The study's `rng` always returns 0..1; a source that does not is a bug in the caller, and it
      // would otherwise turn into a bolt of NaN geometry that renders as nothing.
      const bolt = makeBolt(position, () => {
        const value = random();
        if (!Number.isFinite(value)) {
          throw new Error("strike random source returned a non-finite number.");
        }
        return value;
      });
      write(bolt);
      return bolt.origin;
    },
    update(flash: number): void {
      if (!Number.isFinite(flash)) {
        throw new Error(`flash must be a finite envelope value, got ${flash}.`);
      }
      // The same basis and field of view the coast is drawn with, so a bolt and the headland behind
      // it agree on where the horizon is.
      camera.getWorldDirection(forward);
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      uCam.value.copy(camera.position);
      uForward.value.copy(forward);
      uRight.value.copy(right);
      uUp.value.copy(up);
      uAspect.value = camera.aspect;
      uTan.value = Math.tan((camera.fov * Math.PI) / 360);
      uFlash.value = flash;
      // Below a hair of flash there is nothing to see, and the study did not issue the draw.
      mesh.visible = flash > 0.003 && geometry.drawRange.count > 0;
    },
    dispose(): void {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };

  /** Copies a bolt into the attribute buffers and opens the draw range to it. */
  function write(bolt: IBolt): void {
    const starts = geometry.getAttribute("aStart") as BufferAttribute;
    const ends = geometry.getAttribute("aEnd") as BufferAttribute;
    const strengths = geometry.getAttribute("aStrength") as BufferAttribute;
    for (let s = 0; s < bolt.segments.length; s++) {
      const segment = bolt.segments[s];
      if (segment === undefined) continue;
      for (let v = 0; v < VERTICES_PER_SEGMENT; v++) {
        const at = (s * VERTICES_PER_SEGMENT + v) * 3;
        starts.array[at] = segment.a.x;
        starts.array[at + 1] = segment.a.y;
        starts.array[at + 2] = segment.a.z;
        ends.array[at] = segment.b.x;
        ends.array[at + 1] = segment.b.y;
        ends.array[at + 2] = segment.b.z;
        strengths.array[s * VERTICES_PER_SEGMENT + v] = segment.strength;
      }
    }
    starts.needsUpdate = true;
    ends.needsUpdate = true;
    strengths.needsUpdate = true;
    geometry.setDrawRange(0, bolt.segments.length * VERTICES_PER_SEGMENT);
  }
}

/** The attribute buffers are rewritten on every strike, so they are uploaded, not orphaned. */
function dynamic(attributeBuffer: BufferAttribute): BufferAttribute {
  attributeBuffer.setUsage(DynamicDrawUsage);
  return attributeBuffer;
}

function isFiniteVector(v: Vector3): boolean {
  return (
    v instanceof Vector3 && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
  );
}

function describe(v: Vector3): string {
  return isFiniteVector(v) ? `${v.x}, ${v.y}, ${v.z}` : String(v);
}
