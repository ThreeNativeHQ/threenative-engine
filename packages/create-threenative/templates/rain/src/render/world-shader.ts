// GENERATED FILE — do not edit it. Every line below is the output of Three.js's own GLSL to
// TSL transpiler, run over tools/tempest-world.frag. That .frag file
// is the source of truth; change it and the generator, never this file.
//
//   node tools/generate-shaders.mjs
//
// The shader is the coast: terrain, road, sea, the rail and cabin on it, wet reflections and the
// fog that closes the distance. It is raymarched, so it is one full-screen quad and one function
// call — see src/render/world.ts for the uniforms and the camera basis it expects.
import { DataTexture, Vector2, Vector3, Vector4 } from "three";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  add,
  atan,
  clamp,
  cos,
  div,
  dot,
  exp,
  float,
  floor,
  fract,
  frameGroup,
  int,
  length,
  mat2,
  max,
  min,
  mix,
  mul,
  normalize,
  oneMinus,
  pow,
  property,
  reflect,
  select,
  sin,
  smoothstep,
  sub,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";

// Uniforms the shader reads. Values are assigned by src/render/world.ts and src/render/clouds.ts,
// which own the camera basis and the weather; the generated module only holds the nodes.
export const uTime = uniform(0, "float").setGroup(frameGroup);
export const uRain = uniform(0, "float").setGroup(frameGroup);
export const uFog = uniform(0, "float").setGroup(frameGroup);
export const uWet = uniform(0, "float").setGroup(frameGroup);
export const uFlash = uniform(0, "float").setGroup(frameGroup);
export const uAspect = uniform(0, "float").setGroup(frameGroup);
export const uTan = uniform(0, "float").setGroup(frameGroup);
export const uCam = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uForward = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uRight = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uUp = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uStrike = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uHazeLow = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uHazeHigh = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uSunDir = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uSunColor = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uFill = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uFlashLight = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uLampLight = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uLampGlow = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uWater = uniform(new Vector3(), "vec3").setGroup(frameGroup);
const uSkyPlaceholder = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
uSkyPlaceholder.needsUpdate = true;
export let uSky: TextureNode = texture(uSkyPlaceholder).setGroup(frameGroup);
export function setSky(value: TextureNode): void {
  uSky = value;
}
export const uReflect = uniform(0, "int").setGroup(frameGroup);

// Three.js Transpiler r185

// The look, owned by src/render/{sky,lighting,materials}.ts and set from there every run.

export const hash12 = /*@__PURE__*/ Fn(([p]: [Node<"vec2">]) => {
  const p3 = fract(vec3(p.xyx).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));

  return fract(p3.x.add(p3.y).mul(p3.z));
});

export const hash13 = /*@__PURE__*/ Fn(([p_immutable]: [Node<"vec3">]) => {
  const p = p_immutable.toVar();
  p.assign(fract(p.mul(0.1031)));
  p.addAssign(dot(p, p.zyx.add(31.32)));

  return fract(p.x.add(p.y).mul(p.z));
});

export const noise2 = /*@__PURE__*/ Fn(([p]: [Node<"vec2">]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  f.assign(f.mul(f).mul(sub(3, mul(2, f))));

  return mix(
    mix(hash12(i), hash12(i.add(vec2(1, 0))), f.x),
    mix(hash12(i.add(vec2(0, 1))), hash12(i.add(1)), f.x),
    f.y,
  );
});

export const fbm2 = /*@__PURE__*/ Fn(([p_immutable]: [Node<"vec2">]) => {
  const p = p_immutable.toVar();
  const v = mul(0.5, noise2(p)).toVar();
  p.assign(mat2(0.8, 0.6, -0.6, 0.8).mul(p).mul(2.03).add(19.1));
  v.addAssign(mul(0.25, noise2(p)));
  p.assign(p.mul(2.02).add(9.3));
  v.addAssign(mul(0.125, noise2(p)));

  return v.add(mul(0.0625, noise2(p.mul(2.01).add(17))));
});

export const ray = /*@__PURE__*/ Fn(([uv]: [Node<"vec2">]) => {
  const q = uv.mul(2).sub(1).toVar();

  return normalize(
    uForward.add(uRight.mul(q.x).mul(uAspect).mul(uTan)).add(uUp.mul(q.y).mul(uTan)),
  );
});

export const project = /*@__PURE__*/ Fn(([p]: [Node<"vec3">]) => {
  const v = p.sub(uCam).toVar();
  const d = dot(v, uForward).toVar();

  return vec4(
    dot(v, uRight).div(uAspect.mul(uTan)),
    dot(v, uUp).div(uTan),
    mul(1.00012, d).sub(0.300018),
    d,
  );
});

export const hazeColor = /*@__PURE__*/ Fn(([rd]: [Node<"vec3">]) => {
  return mix(uHazeLow, uHazeHigh, smoothstep(0, 0.7, abs(rd.y))).add(
    uFlash.mul(vec3(0.11, 0.16, 0.24)),
  );
});

export const roadCenter = /*@__PURE__*/ Fn(([z]: [Node<"float">]) => {
  return float(-1.6)
    .add(mul(2.1, sin(z.mul(0.012))))
    .add(mul(15, sub(1, smoothstep(-420, -150, z))));
});

export const coast = /*@__PURE__*/ Fn(([z]: [Node<"float">]) => {
  return roadCenter(z)
    .add(9.2)
    .add(sin(z.mul(0.023)).mul(1.8));
});

export const terrain = /*@__PURE__*/ Fn(([p]: [Node<"vec2">]) => {
  const n = fbm2(p.mul(0.009).add(vec2(4, 9))).toVar();
  const r = sub(1, abs(noise2(p.mul(0.018)).mul(2).sub(1))).toVar();
  const left = smoothstep(13, 155, p.x.negate())
    .mul(add(28, n.mul(135)).add(r.mul(20)))
    .toVar();
  const back = smoothstep(280, 670, p.y.negate())
    .mul(add(46, n.mul(155)).add(r.mul(22)))
    .toVar();
  const farRight = smoothstep(190, 430, p.x)
    .mul(add(30, n.mul(95)))
    .toVar();
  const h = max(max(left, back), farRight).toVar();
  const island = exp(
    dot(p.sub(vec2(94, -205)).div(vec2(39, 48)), p.sub(vec2(94, -205)).div(vec2(39, 48))).negate(),
  )
    .mul(add(18, n.mul(10)))
    .toVar();
  h.assign(max(h, island));

  If(h.lessThan(1.5), () => {
    h.assign(select(p.x.greaterThan(coast(p.y)), -1.2, add(0.1, n.mul(0.2))));
  });

  If(p.y.greaterThan(-175).and(abs(p.x.sub(roadCenter(p.y))).lessThan(7.3)), () => {
    h.assign(0);
  });

  return h;
});

export const sdBox = /*@__PURE__*/ Fn(([p, b]: [Node<"vec3">, Node<"vec3">]) => {
  const q = abs(p).sub(b).toVar();

  return length(max(q, 0)).add(min(max(q.x, max(q.y, q.z)), 0));
});

export const capsule = /*@__PURE__*/ Fn(
  ([p, a, b, r]: [Node<"vec3">, Node<"vec3">, Node<"vec3">, Node<"float">]) => {
    const pa = p.sub(a).toVar();
    const ba = b.sub(a).toVar();

    return length(pa.sub(ba.mul(clamp(dot(pa, ba).div(dot(ba, ba)), 0, 1)))).sub(r);
  },
);

export const choose = /*@__PURE__*/ Fn(([a, b]: [Node<"vec2">, Node<"vec2">]) => {
  return select(a.x.lessThan(b.x), a, b);
});

export const sceneMap = /*@__PURE__*/ Fn(([p]: [Node<"vec3">]) => {
  const h = terrain(p.xz).toVar();
  const res = vec2(p.y.sub(select(h.greaterThan(1), h, -3.5)).mul(0.58), 1).toVar();

  // One bounded procedural tree per spatial cell; crowns fit inside their cells.

  const cell = floor(p.xz.add(vec2(2, 1)).div(10.5)).toVar();
  const seed = hash12(cell.add(17)).toVar();
  const tc = cell
    .add(0.5)
    .mul(10.5)
    .sub(vec2(2, 1))
    .add(vec2(hash12(cell.add(3)), hash12(cell.add(7))).mul(0.9))
    .sub(0.45)
    .toVar();
  const th = terrain(tc).toVar();
  const rel = tc.x.sub(roadCenter(tc.y)).toVar();
  const forest = rel
    .lessThan(-9)
    .or(tc.y.lessThan(-175))
    .and(th.greaterThan(-0.2))
    .and(th.lessThan(115))
    .and(seed.greaterThan(0.15))
    .and(tc.y.lessThan(-12).or(tc.x.lessThan(-45)))
    .toVar();

  If(forest, () => {
    const q = p.sub(vec3(tc.x, th, tc.y)).toVar();
    const ht = add(6, seed.mul(13)).toVar();
    const cy = clamp(q.y.div(ht), 0, 1).toVar();
    const angle = atan(q.z, q.x).toVar();
    const tier = add(0.77, mul(0.23, sin(q.y.mul(3.5).add(seed.mul(13))))).toVar();
    const r = sub(1, cy)
      .mul(add(2, seed.mul(1.45)))
      .mul(tier)
      .toVar();
    r.mulAssign(
      add(0.88, mul(0.12, sin(angle.mul(9).add(q.y.mul(2.7))))).add(
        mul(0.07, sin(angle.mul(19).sub(q.y.mul(6)))),
      ),
    );
    const needle = noise2(q.xz.mul(6).add(q.y.mul(2)))
      .sub(0.5)
      .mul(0.18)
      .mul(sub(1, cy))
      .toVar();
    const d = max(length(q.xz).sub(r).add(needle), max(sub(0.8, q.y), q.y.sub(ht)))
      .mul(0.67)
      .toVar();
    res.assign(choose(res, vec2(d, 2)));
    res.assign(
      choose(
        res,
        vec2(
          max(length(q.xz).sub(mul(0.13, sub(1, cy.mul(0.65)))), max(q.y.negate(), q.y.sub(ht))),
          3,
        ),
      ),
    );
  });

  // Repeating steel luminaires, including their angled neck and illuminated undersides.

  const k = clamp(floor(p.z.negate().sub(10).div(38).add(0.5)), 0, 5).toVar();
  const z = float(-10).sub(k.mul(38)).toVar();
  const x = roadCenter(z).sub(6.35).toVar();
  const q = p.sub(vec3(x, 0, z)).toVar();
  const pole = capsule(q, vec3(0, 0, 0), vec3(0, 7.65, 0), 0.075).toVar();
  pole.assign(min(pole, capsule(q, vec3(0, 7.6, 0), vec3(1.6, 8.05, 0), 0.065)));
  pole.assign(min(pole, capsule(q, vec3(1.6, 8.05, 0), vec3(2.5, 8.05, 0), 0.055)));
  pole.assign(min(pole, sdBox(q.sub(vec3(2.43, 8, 0)), vec3(0.4, 0.1, 0.23))));
  res.assign(choose(res, vec2(pole, 4)));
  res.assign(choose(res, vec2(sdBox(q.sub(vec3(2.45, 7.885, 0)), vec3(0.32, 0.021, 0.175)), 6)));

  // Guardrail on the water side, stopping before the distant curve.

  If(p.z.lessThan(28).and(p.z.greaterThan(-176)), () => {
    const rx = roadCenter(p.z).add(6.3).toVar();
    const rail = sdBox(vec3(p.x.sub(rx), p.y.sub(0.84), 0), vec3(0.065, 0.13, 1000)).toVar();
    const postZ = floor(p.z.div(5).add(0.5)).mul(5).toVar();
    rail.assign(
      min(
        rail,
        sdBox(p.sub(vec3(roadCenter(postZ).add(6.3), 0.45, postZ)), vec3(0.055, 0.45, 0.055)),
      ),
    );
    res.assign(choose(res, vec2(rail, 4)));
  });

  // Small roadside field station, with a lit window and antenna.

  const b = p.sub(vec3(-17, 1.85, -73)).toVar();
  const cabin = sdBox(b, vec3(3.3, 1.85, 2.65)).toVar();
  res.assign(choose(res, vec2(cabin, 9)));
  res.assign(choose(res, vec2(sdBox(p.sub(vec3(-17, 3.85, -73)), vec3(3.6, 0.14, 2.9)), 4)));
  res.assign(
    choose(res, vec2(sdBox(p.sub(vec3(-17.8, 2.1, -70.325)), vec3(0.84, 0.48, 0.028)), 6)),
  );
  res.assign(choose(res, vec2(capsule(p, vec3(-19, 3.9, -74), vec3(-19, 13, -74), 0.045), 4)));

  return res;
});

export const trace = /*@__PURE__*/ Fn(
  ([ro, rd, limit]: [Node<"vec3">, Node<"vec3">, Node<"float">]) => {
    const t = float(0.25).toVar();
    const mat = float(-1).toVar();

    Loop({ start: int(0), end: 148 }, ({ i }) => {
      If(t.greaterThan(limit).or(t.greaterThan(1850)), () => {
        Break();
      });

      const p = ro.add(rd.mul(t)).toVar();
      const d = sceneMap(p).toVar();
      const eps = max(0.007, t.mul(0.00048)).toVar();

      If(d.x.lessThan(eps), () => {
        mat.assign(d.y);
        Break();
      });

      const stepD = max(0.05, d.x.mul(0.87)).toVar();

      If(p.y.lessThan(34).and(t.lessThan(270)), () => {
        stepD.assign(min(stepD, 4.8));
      });

      t.addAssign(stepD);
    });

    return vec2(t, mat);
  },
);

export const getNormal = /*@__PURE__*/ Fn(([p, t]: [Node<"vec3">, Node<"float">]) => {
  const e = max(0.008, t.mul(0.00032)).toVar();
  const k = vec2(1, -1).mul(0.5773).toVar();

  return normalize(
    k.xyy
      .mul(sceneMap(p.add(k.xyy.mul(e))).x)
      .add(k.yyx.mul(sceneMap(p.add(k.yyx.mul(e))).x))
      .add(k.yxy.mul(sceneMap(p.add(k.yxy.mul(e))).x))
      .add(k.xxx.mul(sceneMap(p.add(k.xxx.mul(e))).x)),
  );
});

export const baseColor = /*@__PURE__*/ Fn(
  ([p, mat, n]: [Node<"vec3">, Node<"float">, Node<"vec3">]) => {
    const grit = noise2(p.xz.mul(4.3).add(p.y))
      .mul(0.2)
      .add(noise2(p.xz.mul(31)).mul(0.09))
      .toVar();

    // One value, one return. The transpiler turns a GLSL early return into a JavaScript return that
    // only leaves the `If` callback the node graph is being built inside, so the branch is never
    // assigned and every material would take the colour of the last line. `else if` keeps the
    // first-match order the five separate `if`s had, and `res` is seeded with the fall-through value.

    const res = vec3(0.1).toVar();

    If(mat.lessThan(1.5), () => {
      const moss = smoothstep(0.46, 0.66, fbm2(p.xz.mul(0.3).add(p.y.mul(0.4))))
        .mul(smoothstep(0.4, 0.9, n.y))
        .toVar();
      res.assign(
        mix(vec3(0.075, 0.091, 0.09), vec3(0.038, 0.068, 0.042), moss).mul(add(0.7, grit)),
      );
    })
      .ElseIf(mat.lessThan(2.5), () => {
        res.assign(
          mix(
            vec3(0.017, 0.034, 0.027),
            vec3(0.045, 0.071, 0.047),
            noise2(p.xz.mul(5).add(p.y)),
          ).mul(add(0.8, max(n.y, 0).mul(0.35))),
        );
      })
      .ElseIf(mat.lessThan(3.5), () => {
        res.assign(vec3(0.06, 0.047, 0.036));
      })
      .ElseIf(mat.lessThan(4.5), () => {
        res.assign(vec3(0.12, 0.155, 0.17).mul(add(0.8, grit)));
      })
      .ElseIf(mat.greaterThan(8.5), () => {
        const seam = add(
          0.75,
          mul(0.25, smoothstep(0.01, 0.1, abs(fract(p.x.mul(3)).sub(0.5)))),
        ).toVar();
        res.assign(vec3(0.09, 0.13, 0.14).mul(seam));
      });

    return res;
  },
);

export const surfaceLight = /*@__PURE__*/ Fn(
  ([p, n, v, albedo, rough]: [
    Node<"vec3">,
    Node<"vec3">,
    Node<"vec3">,
    Node<"vec3">,
    Node<"float">,
  ]) => {
    const hemi = add(0.45, mul(0.55, max(n.y, 0))).toVar();
    const c = albedo.mul(uFill.mul(hemi).add(uSunColor.mul(max(dot(n, uSunDir), 0)))).toVar();
    c.addAssign(
      albedo
        .mul(uFlash)
        .mul(add(0.6, max(dot(n, normalize(uStrike.sub(p))), 0).mul(2.5)))
        .mul(uFlashLight),
    );

    Loop({ start: int(0), end: 6 }, ({ i }) => {
      const z = float(-10).sub(float(i).mul(38)).toVar();
      const lp = vec3(roadCenter(z).sub(3.9), 7.87, z).toVar();
      const l = lp.sub(p).toVar();
      const dist2 = dot(l, l).toVar();
      l.assign(normalize(l));
      const ndl = max(dot(n, l), 0).toVar();
      const cone = smoothstep(0.1, 0.62, l.y.negate())
        .mul(smoothstep(-0.1, 0.1, l.y))
        .toVar();
      const atten = div(48, add(1, dist2)).toVar();
      const warm = uLampLight.toVar();
      c.addAssign(albedo.mul(warm).mul(atten).mul(ndl).mul(2));
      const hv = normalize(l.add(v)).toVar();
      const shin = mix(20, 900, sub(1, rough)).toVar();
      const spec = pow(max(dot(n, hv), 0), shin)
        .mul(shin.add(2))
        .mul(0.018)
        .toVar();
      c.addAssign(
        warm
          .mul(spec)
          .mul(atten)
          .mul(ndl)
          .mul(select(rough.greaterThan(0.55), 0.022, 1)),
      );
    });

    return c;
  },
);

export const rippleSlope = /*@__PURE__*/ Fn(([p]: [Node<"vec2">]) => {
  const cell = floor(p.div(2.2)).toVar();
  const sum = vec2(0).toVar();

  Loop(
    { start: int(-1), end: int(1), condition: "<=" },
    { start: int(-1), end: int(1), condition: "<=" },
    ({ i, j }) => {
      const c = cell.add(vec2(float(i), float(j))).toVar();
      const h = hash12(c.add(3.9)).toVar();
      const ctr = c
        .add(vec2(h, hash12(c.add(19))))
        .mul(2.2)
        .toVar();
      const v = p.sub(ctr).toVar();
      const d = length(v).add(0.001).toVar();
      const age = fract(uTime.mul(add(0.6, uRain.mul(0.2))).add(h.mul(7.3))).toVar();
      const ring = d.sub(age.mul(1.7)).toVar();
      const env = exp(abs(ring).negate().mul(20))
        .mul(sub(1, age))
        .mul(smoothstep(0.025, 0.1, age))
        .toVar();
      sum.addAssign(
        v
          .div(d)
          .mul(cos(ring.mul(95)))
          .mul(env)
          .mul(0.055),
      );
    },
  );

  return sum.mul(uRain);
});

export const reflected = /*@__PURE__*/ Fn(
  ([p, rd, sky]: [Node<"vec3">, Node<"vec3">, Node<"vec3">]) => {
    // Same reason as baseColor: no early return. The `uReflect` guard becomes the condition around the
    // march, which is still a skip, and a hit becomes a `res` plus a `Break`, which is what the trace
    // already does. A ray that reaches the end of the march leaves `res` as the sky, as it did.

    const res = sky.toVar();

    If(uReflect.notEqual(0), () => {
      const t = float(0.5).toVar();

      Loop({ start: int(0), end: 36 }, ({ i }) => {
        If(t.greaterThan(280), () => {
          Break();
        });

        const q = p.add(rd.mul(t)).toVar();
        const d = sceneMap(q).toVar();

        If(d.x.lessThan(max(0.03, t.mul(0.0016))), () => {
          If(d.y.greaterThan(5.5).and(d.y.lessThan(6.5)), () => {
            res.assign(uLampGlow.mul(0.75));
          }).Else(() => {
            res.assign(
              mix(
                baseColor(q, d.y, vec3(0, 1, 0)).mul(0.7),
                hazeColor(rd),
                sub(1, exp(t.negate().mul(add(0.0015, uFog.mul(0.004))))),
              ),
            );
          });

          Break();
        });

        t.addAssign(max(0.15, d.x.mul(0.9)));
      });
    });

    return res;
  },
);

export const tempestWorld = /*@__PURE__*/ Fn(([vUv]: [Node<"vec2">]) => {
  const worldDepth = float(1).toVar();
  const rd = ray(vUv).toVar();
  const sky = uSky.sample(vec2(vUv.x, vUv.y.oneMinus())).rgb.toVar();
  const planeT = select(rd.y.lessThan(-0.0001), uCam.y.negate().div(rd.y), 2200).toVar();
  const pp = uCam.add(rd.mul(planeT)).toVar();
  const water = pp.x.greaterThan(coast(pp.z)).and(terrain(pp.xz).lessThan(0)).toVar();

  If(water.and(rd.y.lessThan(-0.0001)), () => {
    planeT.assign(float(-0.6).sub(uCam.y).div(rd.y));
  });

  const hit = trace(uCam, rd, min(planeT, 2200)).toVar();
  const t = hit.x.toVar();
  const mat = hit.y.toVar();
  const p = uCam.add(rd.mul(t)).toVar();
  const n = property("vec3").toVar();
  const color = sky.toVar();
  const ground = mat.lessThan(0).and(planeT.greaterThan(0)).and(planeT.lessThan(1800)).toVar();

  If(ground, () => {
    t.assign(planeT);
    p.assign(uCam.add(rd.mul(t)));
    const rx = abs(p.x.sub(roadCenter(p.z))).toVar();
    water.assign(p.x.greaterThan(coast(p.z)).and(terrain(p.xz).lessThan(0)));
    const road = rx.lessThan(5.35).and(p.z.greaterThan(-190)).toVar();
    const ripple = rippleSlope(p.xz).toVar();
    const coarse = noise2(p.xz.mul(2.6)).toVar();
    const micro = noise2(p.xz.mul(72)).toVar();
    const puddle = smoothstep(0.37, 0.64, fbm2(p.xz.mul(0.25).add(7)))
      .mul(uWet)
      .toVar();

    If(water, () => {
      puddle.assign(1);
    });

    const wave = vec2(
      cos(p.x.mul(1.3).add(p.z.mul(0.8)).add(uTime.mul(1.7))),
      sin(p.z.mul(1.7).sub(p.x.mul(0.4)).sub(uTime.mul(1.2))),
    )
      .mul(select(water, 0.018, 0.0015))
      .toVar();
    const bump = vec2(noise2(p.xz.mul(35)), noise2(p.xz.mul(35).add(9)))
      .sub(0.5)
      .mul(mix(0.22, 0.013, puddle))
      .toVar();
    n.assign(
      normalize(vec3(bump.x.add(wave.x).add(ripple.x), 1, bump.y.add(wave.y).add(ripple.y))),
    );
    const alb = select(
      road,
      vec3(0.031, 0.037, 0.042).mul(add(0.58, coarse.mul(0.4)).add(micro.mul(0.3))),
      vec3(0.075, 0.086, 0.07).mul(add(0.7, coarse.mul(0.45))),
    ).toVar();
    const rough = mix(0.7, 0.08, puddle).toVar();

    If(road, () => {
      const center = p.x.sub(roadCenter(p.z)).toVar();
      const stripe = sub(1, smoothstep(0.042, 0.062, abs(abs(center).sub(0.14)))).toVar();
      const edge = sub(1, smoothstep(0.06, 0.085, abs(rx.sub(5.04)))).toVar();
      const wear = smoothstep(0.1, 0.35, noise2(p.xz.mul(26))).toVar();
      alb.assign(mix(alb, vec3(0.5, 0.36, 0.11), stripe.mul(wear).mul(0.85)));
      alb.assign(mix(alb, vec3(0.49, 0.54, 0.5), edge.mul(wear).mul(0.6)));
    });

    If(water, () => {
      alb.assign(uWater);
      rough.assign(0.045);
    });

    color.assign(surfaceLight(p, n, rd.negate(), alb, rough));
    const fres = add(0.025, mul(0.975, pow(sub(1, max(dot(rd.negate(), n), 0)), 5))).toVar();
    const suv = clamp(vUv.add(vec2(n.x, n.z).mul(vec2(0.07, 0.05))), 0.002, 0.998).toVar();
    const refl = reflected(
      p.add(n.mul(0.1)),
      reflect(rd, n),
      uSky.sample(vec2(suv.x, suv.y.oneMinus())).rgb,
    ).toVar();
    const reflection = select(
      water,
      add(0.25, fres.mul(0.7)),
      uWet.mul(0.05).add(puddle.mul(0.23)).add(fres.mul(0.5)),
    ).toVar();
    color.assign(mix(color, refl, clamp(reflection, 0, 0.94)));

    // Tiny high-frequency impact coronas, strongest against dark wet tarmac.

    color.addAssign(
      length(ripple)
        .mul(vec3(0.055, 0.077, 0.09))
        .mul(uRain),
    );
    mat.assign(select(water, 8, select(road, 7, 1)));
  }).ElseIf(mat.greaterThan(0), () => {
    n.assign(getNormal(p, t));

    If(mat.greaterThan(5.5).and(mat.lessThan(6.5)), () => {
      color.assign(uLampGlow);
    }).Else(() => {
      color.assign(
        surfaceLight(
          p,
          n,
          rd.negate(),
          baseColor(p, mat, n),
          select(mat.greaterThan(3.5), 0.28, 0.88),
        ),
      );
    });

    const ao = clamp(p.y.sub(terrain(p.xz)).mul(0.09).add(0.5), 0.4, 1).toVar();

    If(mat.notEqual(6), () => {
      color.mulAssign(ao);
    });
  });

  If(mat.greaterThan(0).or(ground), () => {
    // Height-dependent aerial perspective with advected rain curtains.

    const curtain = add(
      0.8,
      mul(0.4, fbm2(p.xz.mul(0.012).add(vec2(uTime.mul(0.014), 0)))),
    ).toVar();
    const fog = sub(
      1,
      exp(
        t
          .negate()
          .mul(add(0.0011, uFog.mul(0.0048)))
          .mul(curtain)
          .mul(exp(max(p.y, 0).negate().mul(0.008))),
      ),
    ).toVar();
    color.assign(mix(color, hazeColor(rd), clamp(fog, 0, 0.98)));
    const d = max(0.15, t.mul(dot(rd, uForward))).toVar();
    worldDepth.assign(clamp(sub(1.00006, div(0.150009, d)), 0, 0.999999));
  }).Else(() => {
    worldDepth.assign(1);
  });

  return vec4(max(color, vec3(0)), worldDepth);
});
