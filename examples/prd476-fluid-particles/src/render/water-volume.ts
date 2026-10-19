import type { FluidParticles3D } from "@threenative/core";
import { BackSide, BoxGeometry, Mesh } from "three";
import * as tsl from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";

// The look is this file's: a raymarch of the solver's density volume with a refracted checker
// floor, Beer-Lambert absorption and Schlick Fresnel. Swap any of it without touching packages/.
// quality-allow: TSL nodes are typed per swizzle by three 0.185; this file is arithmetic over them.
// biome-ignore lint/suspicious/noExplicitAny: see above.
type N = any;
const {
  Break,
  Fn,
  If,
  Loop,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  floor,
  hash,
  max,
  min,
  mix,
  select,
  normalize,
  pow,
  positionWorld,
  reflect,
  refract,
  texture3D,
  vec3,
  vec4,
  // biome-ignore lint/suspicious/noExplicitAny: see above.
} = tsl as unknown as Record<string, any>;

export interface IWaterVolumeOptions {
  /** Ray steps through the tank. 72 resolves 0.11 m voxels across a 7 m diagonal. */
  readonly steps?: number;
  readonly deep?: readonly [number, number, number];
  readonly shallow?: readonly [number, number, number];
  /** Absorption per metre of water, per channel. */
  readonly absorption?: readonly [number, number, number];
}

const DENSITY_THRESHOLD = 0.5;

export function createWaterVolume(
  water: FluidParticles3D,
  options: IWaterVolumeOptions = {},
): Mesh {
  const steps = options.steps ?? 72;
  const deep = vec3(...(options.deep ?? [0.0, 0.2, 0.45]));
  const shallow = vec3(...(options.shallow ?? [0.15, 0.72, 0.95]));
  const absorption = vec3(...(options.absorption ?? [0.7, 0.22, 0.1]));
  const { min: lo, max: hi } = water.bounds;
  const bmin = vec3(...lo);
  const bmax = vec3(...hi);
  const size = vec3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const voxel = water.voxelSize;
  // The density texture spans whole voxels, a little past the bounds on the long axes.
  const extent = vec3(...water.volumeSize.map((count) => count * voxel));
  const volume = water.density;

  // Sample inside the walls: the field fades over the last spacing next to a wall, which would
  // read as a free surface pressed against the glass. Clamping keeps the water full to the wall.
  const pad = water.spacing * 1.2;
  const inner = (p: N): N =>
    vec3(
      clamp(p.x, bmin.x.add(pad), bmax.x.sub(pad)),
      max(p.y, bmin.y.add(pad)),
      clamp(p.z, bmin.z.add(pad), bmax.z.sub(pad)),
    );
  const density = (p: N): N => texture3D(volume, inner(p).sub(bmin).div(extent).clamp(0, 1)).x;
  const gradient = (p: N): N => {
    const e = voxel * 1.5;
    return vec3(
      density(p.add(vec3(e, 0, 0))).sub(density(p.sub(vec3(e, 0, 0)))),
      density(p.add(vec3(0, e, 0))).sub(density(p.sub(vec3(0, e, 0)))),
      density(p.add(vec3(0, 0, e))).sub(density(p.sub(vec3(0, 0, e)))),
    );
  };
  const sky = (d: N): N =>
    mix(vec3(0.7, 0.85, 1.0), vec3(0.12, 0.3, 0.6), clamp(d.y.mul(1.4), 0, 1));
  const floorColor = (p: N): N => {
    const cell = floor(p.x.mul(2))
      .add(floor(p.z.mul(2)))
      .mod(2);
    return mix(vec3(0.12, 0.2, 0.3), vec3(0.28, 0.42, 0.55), cell);
  };

  const march = Fn(() => {
    const origin = cameraPosition;
    const direction = normalize(positionWorld.sub(cameraPosition));
    const inverse = vec3(1).div(direction);
    const t1 = bmin.sub(origin).mul(inverse);
    const t2 = bmax.sub(origin).mul(inverse);
    const near = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), max(min(t1.z, t2.z), 0));
    const far = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));
    const stride = far.sub(near).div(steps);
    const t = near
      .add(stride.mul(hash(positionWorld.x.mul(131).add(positionWorld.y.mul(197)))))
      .toVar();
    const hit = float(0).toVar();
    const hitPoint = vec3(0).toVar();
    const previous = float(0).toVar();
    // A ray that starts under water (looking through the glass) travels until it leaves the water;
    // one that starts in air travels until it meets the surface.
    const entry = origin.add(direction.mul(near));
    const inside = density(entry).greaterThan(DENSITY_THRESHOLD);
    previous.assign(density(origin.add(direction.mul(t))));
    Loop(steps, () => {
      const p = origin.add(direction.mul(t));
      const d = density(p);
      const crossed = select(
        inside,
        d.lessThan(DENSITY_THRESHOLD),
        d.greaterThan(DENSITY_THRESHOLD),
      );
      If(crossed.and(hit.lessThan(0.5)), () => {
        const k = clamp(
          float(DENSITY_THRESHOLD)
            .sub(previous)
            .div(max(d.sub(previous).abs(), 1e-4).mul(select(inside, float(-1), float(1)))),
          0,
          1,
        );
        hitPoint.assign(origin.add(direction.mul(t.sub(stride.mul(float(1).sub(k))))));
        hit.assign(1);
        Break();
      });
      previous.assign(d);
      t.addAssign(stride);
    });

    // Through the glass: Beer-Lambert along the path in water, then whatever the ray reaches.
    const farPoint = origin.add(direction.mul(far));
    const leave = select(hit.greaterThan(0.5), hitPoint, farPoint);
    const path = clamp(leave.sub(entry).length().mul(2.2), 0, 6);
    const trans = exp(absorption.mul(path).negate());
    const sideBody = mix(deep, shallow, clamp(float(1.1).sub(path.mul(0.25)), 0, 1));
    const underside = mix(sky(vec3(direction.x, direction.y.negate(), direction.z)), shallow, 0.35);
    const onFloor = leave.y.lessThan(lo[1] + 0.05);
    const sideEnd = select(
      hit.greaterThan(0.5),
      underside,
      select(onFloor, floorColor(leave).mul(0.8), mix(deep, shallow, 0.45)),
    );
    const sideColor = sideEnd.mul(trans).add(sideBody.mul(vec3(1).sub(trans)));

    // From the air: gradient normal, refracted floor, Fresnel, sun glint.
    const normal = normalize(
      gradient(hitPoint)
        .negate()
        .add(vec3(0, 1e-3, 0)),
    );
    const facing = clamp(dot(normal, direction.negate()), 0, 1);
    const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(facing), 5)));
    const bent = refract(direction, normal, float(1 / 1.33));
    const toFloor = max(hitPoint.y.sub(lo[1]), 0.02).div(max(bent.y.negate(), 0.05));
    const floorPoint = hitPoint.add(bent.mul(toFloor));
    const through = clamp(toFloor, 0, 6);
    const transmittance = exp(absorption.mul(through).negate());
    const body = mix(deep, shallow, clamp(through.mul(-0.4).add(1.2), 0, 1));
    const refracted = floorColor(floorPoint)
      .mul(transmittance)
      .add(body.mul(vec3(1).sub(transmittance)));
    const mirror = sky(reflect(direction, normal));
    const sun = pow(
      clamp(dot(reflect(direction, normal), normalize(vec3(0.4, 0.8, 0.3))), 0, 1),
      90,
    ).mul(1.2);
    const airColor = mix(refracted, mirror, fresnel).add(sun);
    const color = select(inside, sideColor, airColor);
    return vec4(color, select(inside, float(1), hit));
  });

  const material = new MeshBasicNodeMaterial({
    side: BackSide,
    transparent: true,
    depthWrite: false,
  });
  material.toneMapped = false;
  const shaded = march();
  material.colorNode = shaded.xyz;
  material.opacityNode = shaded.w;
  const mesh = new Mesh(new BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), material);
  mesh.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}
