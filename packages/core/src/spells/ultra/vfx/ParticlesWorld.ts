// Ported from Ultra Elements src/vfx/common.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
//
// ENGINE-GAP (compute sampler): the particle sim's copy of common.ts arenaSDF, arenaNormal and
// forceAccel, reading the world data from a vec4 storage mirror instead of the world texture. In a
// compute kernel a texture read only with textureLoad declares a sampler the WGSL never uses; the
// auto pipeline layout drops it and the engine's bind group still passes it (compute.cpp
// GraphCompute::record), so the device is lost. Once the engine skips unused samplers, delete this
// file and call common.ts's arenaSDF / arenaNormal / forceAccel from the sim again.
import {
  Break,
  Fn,
  If,
  Loop,
  PI,
  abs,
  clamp,
  cross,
  dot,
  exp,
  float,
  instancedArray,
  int,
  length,
  max,
  min,
  normalize,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  vec3,
} from "three/tsl";
import type { DataTexture, Node } from "three/webgpu";
import { MAX_FORCES, MAX_OCCLUDERS, U, WORLD_W, arenaStatic, sdCapsule } from "./common.js";

type F = Node<"float">;
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;
type I = Node<"int">;

// the world texture's own Float32Array (packWorld writes it), as 4 rows of WORLD_W vec4
const worldData = (U.uWorld.value as DataTexture).image.data as Float32Array;
export const worldMirror = instancedArray(worldData, "vec4");
const mirrorArray = (worldMirror.value as unknown as { array: Float32Array }).array;
/** once per frame after packWorld: the mirror uploads what the world texture holds */
export function syncWorldMirror(): void {
  if (mirrorArray !== worldData) mirrorArray.set(worldData);
  (worldMirror.value as unknown as { needsUpdate: boolean }).needsUpdate = true;
}
const simWorldTexel = Fn(
  ([row, i]: [I, I]) => worldMirror.element(row.mul(int(WORLD_W)).add(i)) as unknown as V4,
);

export const simArenaSDF = Fn(([p]: [V3]) => {
  const d = arenaStatic(p).toVar();
  const n = int(U.uWorldCounts.w);
  Loop({ start: 0, end: MAX_OCCLUDERS, type: "int", condition: "<" }, ({ i }: { i: I }) => {
    If(i.greaterThanEqual(n), () => {
      Break();
    });
    const a = simWorldTexel(int(3), i.mul(2));
    const b = simWorldTexel(int(3), i.mul(2).add(1));
    d.assign(min(d, sdCapsule(p, a.xyz, b.xyz, a.w)));
  });
  return d;
});

export const simArenaNormal = Fn(([p]: [V3]) => {
  const e = 0.01;
  return normalize(
    vec3(
      simArenaSDF(p.add(vec3(e, 0, 0))).sub(simArenaSDF(p.sub(vec3(e, 0, 0)))),
      simArenaSDF(p.add(vec3(0, e, 0))).sub(simArenaSDF(p.sub(vec3(0, e, 0)))),
      simArenaSDF(p.add(vec3(0, 0, e))).sub(simArenaSDF(p.sub(vec3(0, 0, e)))),
    ),
  );
});

// FORCES_GLSL
// Forces act on every particle (scaled by its kind's force response) and warp fire volumes.
//   0 wind      t2.xyz dir, t1 = (speed m/s, gustiness, coupling, -)
//   1 vortex    pos = base, t2.xyz axis, t1 = (core R, circulation G, updraft W, inflow), t2.w height
//   2 attractor t1 = (strength, softening, kill radius, range)   (negative strength repels)
//   3 orbit     Kepler disk: t2.xyz axis, t1 = (GM, inner, outer, coupling)
//   4 shock     expanding shell: t1 = (radius, thickness, impulse, -)
//   5 push      cone gust: t2.xyz dir, t1 = (speed, radius, length, coupling)
// kill: inout var
export const simForceAccel = Fn(([p, v, kill]: [V3, V3, F]) => {
  const acc = vec3(0.0).toVar();
  const n = int(U.uWorldCounts.y);
  Loop({ start: 0, end: MAX_FORCES, type: "int", condition: "<" }, ({ i }: { i: I }) => {
    If(i.greaterThanEqual(n), () => {
      Break();
    });
    const a = simWorldTexel(int(1), i.mul(4));
    const k = simWorldTexel(int(1), i.mul(4).add(1));
    const b = simWorldTexel(int(1), i.mul(4).add(2));
    const type = int(a.w);
    const d = p.sub(a.xyz);
    If(type.equal(0), () => {
      const gust = k.y
        .mul(sin(U.uTime.mul(1.7).add(dot(p, vec3(0.13, 0.05, 0.11)))))
        .mul(sin(U.uTime.mul(0.53).add(p.x.mul(0.07))))
        .add(1.0);
      acc.addAssign(b.xyz.mul(k.x).mul(gust).sub(v).mul(k.z));
    })
      .ElseIf(type.equal(1), () => {
        const ax = b.xyz;
        const h = dot(d, ax);
        const radial = d.sub(ax.mul(h));
        const r = length(radial);
        If(
          h
            .greaterThan(-0.5)
            .and(h.lessThan(b.w))
            .and(r.lessThan(k.x.mul(6.0))),
          () => {
            const er = radial.div(max(r, 1e-3));
            const et = cross(ax, er);
            const vt = select(
              r.lessThan(k.x),
              k.y
                .div(2.0 * Math.PI)
                .mul(r)
                .div(k.x.mul(k.x)),
              k.y.div(r.mul(2.0 * Math.PI)),
            );
            const up = k.z.mul(exp(r.mul(r).negate().div(k.x.mul(k.x).mul(2.0))));
            const target = et
              .mul(vt)
              .add(ax.mul(up))
              .sub(
                er
                  .mul(k.w)
                  .mul(smoothstep(k.x.mul(6.0), k.x, r))
                  .mul(float(1.0).sub(smoothstep(0.0, 2.0, h).mul(0.6))),
              );
            acc.addAssign(
              target
                .sub(v)
                .mul(3.0)
                .mul(smoothstep(k.x.mul(6.0), k.x.mul(3.0), r)),
            );
          },
        );
      })
      .ElseIf(type.equal(2), () => {
        const r2 = dot(d, d);
        If(r2.lessThan(k.w.mul(k.w)), () => {
          acc.subAssign(
            normalize(d)
              .mul(k.x)
              .div(r2.add(k.y.mul(k.y))),
          );
          If(r2.lessThan(k.z.mul(k.z)), () => {
            kill.assign(1.0);
          });
        });
      })
      .ElseIf(type.equal(3), () => {
        const ax = b.xyz;
        const h = dot(d, ax);
        const radial = d.sub(ax.mul(h));
        const r = length(radial);
        If(r.greaterThan(k.y.mul(0.5)).and(r.lessThan(k.z)), () => {
          const et = cross(ax, radial.div(r));
          const target = et.mul(sqrt(k.x.div(r))).sub(ax.mul(h).mul(4.0));
          acc.addAssign(target.sub(v).mul(k.w));
        });
        If(r.lessThan(k.y), () => {
          kill.assign(max(kill, step(abs(h), 0.5)));
        });
      })
      .ElseIf(type.equal(4), () => {
        const r = length(d);
        const shell = float(1.0).sub(clamp(abs(r.sub(k.x)).div(max(k.y, 1e-3)), 0.0, 1.0));
        acc.addAssign(d.div(max(r, 1e-3)).mul(k.z).mul(shell));
      })
      .ElseIf(type.equal(5), () => {
        const along = dot(d, b.xyz);
        const off = length(d.sub(b.xyz.mul(along)));
        If(along.greaterThan(-0.5).and(along.lessThan(k.z)).and(off.lessThan(k.y)), () => {
          acc.addAssign(
            b.xyz
              .mul(k.x)
              .sub(v)
              .mul(k.w)
              .mul(float(1.0).sub(off.div(k.y))),
          );
        });
      });
  });
  return acc;
});
