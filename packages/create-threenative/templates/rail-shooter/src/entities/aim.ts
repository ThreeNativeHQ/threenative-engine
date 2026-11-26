import { Vector3 } from "three";

const _r = new Vector3();

/**
 * The unit direction that sends a shot of `speed` from `from` to meet a target that keeps moving at
 * `velocity`. Solves |r + v t| = s t for the first positive t. A target no shot can catch gets a
 * straight shot at where it is.
 */
export function interceptDirection(
  from: Vector3,
  position: Vector3,
  velocity: Vector3,
  speed: number,
  out: Vector3,
): Vector3 {
  _r.subVectors(position, from);
  const a = velocity.lengthSq() - speed * speed;
  const b = 2 * _r.dot(velocity);
  const c = _r.lengthSq();
  const roots =
    Math.abs(a) < 1e-6
      ? [-c / b]
      : (() => {
          const disc = b * b - 4 * a * c;
          return disc < 0
            ? []
            : [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)];
        })();
  const t = roots.filter((root) => root > 0).sort((x, y) => x - y)[0];
  return out
    .copy(_r)
    .addScaledVector(velocity, t ?? 0)
    .normalize();
}
