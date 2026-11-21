// A continuous mass with offset summits, sloping buttresses and snow caught on ledges.
import * as THREE from 'three';
import { RNG, fbm, smoothstep, mixc, col, paint, facet, piece } from './core.js';
import { ROCK } from './palettes.js';

export function mountain({ seed = 1, width = 54, depth = 40, height = 31, palette = 'alpine', detail = 0.75 } = {}) {
  const rng = new RNG(seed);
  const flip = rng.chance(0.5) ? -1 : 1;
  const peaks = [-0.48, 0.02, 0.48].map((centre, i) => ({
    x: (centre + rng.range(-0.13, 0.13)) * flip,
    z: rng.range(-0.30, 0.30),
    height: i === 1 ? 1 : rng.range(0.51, 0.88),
    twist: rng.range(0, Math.PI * 2),
    spread: rng.range(0.85, 1.2),
  }));
  const count = Math.round(16 + detail * 30);
  const geo = new THREE.PlaneGeometry(2, 2, count, count).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  let top = 0;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i), v = pos.getZ(i);
    // Map a square lattice into a disk, so the foothills have no straight cut edges.
    const fade = 1 - Math.max(Math.abs(u), Math.abs(v));
    const x = u * Math.sqrt(1 - v * v / 2) + rng.range(-0.025, 0.025) * fade;
    const z = v * Math.sqrt(1 - u * u / 2) + rng.range(-0.025, 0.025) * fade;
    let y = 0;
    for (const peak of peaks) {
      const dx = x - peak.x, dz = (z - peak.z) * peak.spread;
      const angle = Math.atan2(dz, dx), radius = Math.hypot(dx, dz);
      const spur = Math.cos(4 * angle + peak.twist + radius * 3) + 0.4 * Math.cos(7 * angle - peak.twist);
      const slope = radius * (1.13 + 0.22 * spur);
      y = Math.max(y, peak.height * Math.max(0, 1 - slope) ** 1.24);
    }
    const rim = smoothstep(1, 0.58, Math.hypot(x, z));
    y = Math.max(0, y + 0.10 * fbm(x * 4, 0, z * 4, 4, seed)) * rim;
    top = Math.max(top, y);
    pos.setXYZ(i, x * width / 2, y, z * depth / 2);
  }
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) * height / top);

  const pal = ROCK[palette] ?? ROCK.alpine;
  const snow = col(0xf1f6ff), rock = col(palette === 'snow' ? 0x7185a0 : pal.dark);
  const grass = col(pal.capDark);
  const shape = facet(geo, { angle: 38 });
  paint(shape, (p, n, color, _i, surface, cap) => {
    const altitude = p.y / height;
    const patch = fbm(p.x * 0.22, p.y * 0.19, p.z * 0.22, 3, seed);
    mixc(color, rock, pal.base, 0.46 + patch * 0.5 + n.y * 0.16);
    if (palette === 'snow') {
      const cover = smoothstep(0.23, 0.71, altitude + n.y * 0.44 + patch * 0.25);
      cap.set(snow.r, snow.g, snow.b, cover);
    } else if (palette === 'alpine') {
      color.lerp(grass, 0.45 * (1 - smoothstep(0.08, 0.44, altitude)) * Math.max(0, n.y));
    }
    surface.set(0.94, palette === 'desert' ? 0.74 : 0, seed % 1024, 0.035);
  });
  return piece('mountain', { solid: [shape] });
}
