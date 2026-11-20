// ground.js — terrain, ground patches, clouds, sky and the scatter() instancing helper.
import * as THREE from 'three';
import { RNG, noise3, fbm, smoothstep, col, mixc, paint, paintFaces, xform, blob, piece, materials } from './core.js';
import { GROUND } from './palettes.js';

/**
 * Heightfield terrain. You supply height(x, z) -> y and
 * color(x, z, y, normal, outColor, blend). Set blend.tint and blend.mask (0..1,
 * changing smoothly) to lay a second colour over the first: the material cuts
 * the mask at 0.5 with noise, so a path or a lawn gets a sharp, irregular edge.
 * The ground is flat-shaded, so keep `segments` modest: the facets are the look.
 */
export function terrain({ size = 200, segments = 160, height, color, focus = 1 }) {
  const g = new THREE.PlaneGeometry(2, 2, segments, segments);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position, half = size / 2;
  // focus < 1 packs more vertices into the middle of the map, where the camera lives
  const warp = (u) => half * (focus * u + (1 - focus) * u * u * u);
  const rng = new RNG(7), du = 1 / segments;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i), v = pos.getZ(i), edge = Math.abs(u) > 0.999 || Math.abs(v) > 0.999;
    // nudge every vertex inside its cell so the facets are irregular, not a grid
    const x = warp(u) + (edge ? 0 : rng.range(-0.3, 0.3) * (warp(u + du) - warp(u - du)));
    const z = warp(v) + (edge ? 0 : rng.range(-0.3, 0.3) * (warp(v + du) - warp(v - du)));
    pos.setXYZ(i, x, height(x, z), z);
  }
  g.computeVertexNormals();
  const tint = new Float32Array(pos.count * 3), mask = new Float32Array(pos.count), blend = { tint: new THREE.Color(), mask: 0 };
  paint(g, (p, n, o, i) => {
    blend.mask = 0; blend.tint.setRGB(1, 1, 1);
    color(p.x, p.z, p.y, n, o, blend);
    tint[i * 3] = blend.tint.r; tint[i * 3 + 1] = blend.tint.g; tint[i * 3 + 2] = blend.tint.b; mask[i] = blend.mask;
  });
  g.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
  g.setAttribute('mask', new THREE.BufferAttribute(mask, 1));
  g.deleteAttribute('uv');
  const m = new THREE.Mesh(g, materials.ground);
  m.receiveShadow = true; m.name = 'terrain'; m.userData = { kit: 'terrain' };
  return m;
}

/** A small terrain swatch for the library, with the same material as the biome scenes. */
export function terrainSample({ seed = 1, palette = 'grass' } = {}) {
  const { a, b, path = b } = GROUND[palette] ?? GROUND.grass;
  return terrain({
    size: 30, segments: 36,
    height: (x, z) => 1.9 + 1.8 * fbm(x * 0.14, 0, z * 0.14, 4, seed),
    color: (x, z, _y, _normal, out, blend) => {
      mixc(out, a, b, 0.5 + 0.5 * fbm(x * 0.17, 0, z * 0.17, 3, seed));
      blend.tint.set(path);
      blend.mask = 1 - smoothstep(0.85, 1.9, Math.abs(x - 4 * Math.sin(z * 0.17)));
    },
  });
}

/** Round patch of ground with soft bumps — grass, snow or sand. A tall `bump` makes a dune or drift. */
export function groundPatch({ seed = 1, radius = 6, palette = 'grass', bump = 0.5 } = {}) {
  const rng = new RNG(seed), pal = GROUND[palette], s = rng.seed() % 997;
  const rings = 8, radial = 36, P = [], I = [];
  P.push(0, 0, 0);
  for (let j = 1; j <= rings; j++) for (let i = 0; i < radial; i++) {
    const r = (j / rings) * radius * (1 + 0.1 * noise3(Math.cos((i / radial) * 6.283) * 1.5 + s, Math.sin((i / radial) * 6.283) * 1.5, 0, s));
    P.push(Math.cos((i / radial) * 6.283) * r, 0, Math.sin((i / radial) * 6.283) * r);
  }
  for (let i = 0; i < radial; i++) I.push(0, 1 + ((i + 1) % radial), 1 + i);
  for (let j = 1; j < rings; j++) for (let i = 0; i < radial; i++) {
    const a = 1 + (j - 1) * radial + i, b = 1 + (j - 1) * radial + ((i + 1) % radial), c = a + radial, d = b + radial;
    I.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); geo.setIndex(I);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), q = Math.hypot(x, z) / radius, fall = 1 - smoothstep(0.55, 1, q);
    pos.setY(i, (bump * (0.55 + 0.45 * fbm(x * 0.25 + s, 0, z * 0.25, 3, s)) + 0.15) * fall - 0.05);
  }
  geo.computeVertexNormals();
  paint(geo, (p, n, o) => mixc(o, pal.a, pal.b, 0.5 + 0.5 * fbm(p.x * 0.3 + s, 0, p.z * 0.3, 2, s) + (n.y - 0.9) * 2));
  return piece('groundPatch', { solid: [geo] });
}

/** Puffy cloud. Unshadowed and slightly self-lit so it stays bright in any sky. */
export function cloud({ seed = 1, size = 12 } = {}) {
  const rng = new RNG(seed), parts = [], white = col(0xffffff), shade = col(0xb7d3f5);
  const n = rng.int(5, 8);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1) - 0.5, r = size * (0.34 - 0.3 * u * u) * rng.range(0.8, 1.15);
    const b = paintFaces(blob(rng, { r, detail: 2, squash: [1.25, 0.7, 1], lumpy: 0.18 }), (c, nn, o) => o.copy(shade).lerp(white, smoothstep(-0.5, 0.35, nn.y)));
    parts.push(xform(b, { pos: [u * size * 1.5, r * 0.45 + rng.range(-0.05, 0.08) * size, rng.range(-0.15, 0.15) * size] }));
  }
  return piece('cloud', { cloud: parts });
}

/** Gradient sky dome. */
export function sky({ top = 0x2f86e6, horizon = 0xcfe9ff, radius = 900 } = {}) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uTop: { value: col(top) }, uHorizon: { value: col(horizon) } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uTop, uHorizon; varying vec3 vDir;
      void main(){ float t = pow(clamp(vDir.y * 1.15 + 0.08, 0.0, 1.0), 0.6); gl_FragColor = vec4(mix(uHorizon, uTop, t), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 12), mat);
  m.name = 'sky'; m.renderOrder = -10; m.frustumCulled = false;
  return m;
}

/**
 * Stamp one piece many times with GPU instancing.
 * placements: [{ x, y, z, rot (yaw), scale }] — scale may be a number or [x, y, z].
 */
export function scatter(source, placements) {
  const out = new THREE.Group(); out.name = `scatter:${source.name}`;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  source.traverse((child) => {
    if (!child.isMesh) return;
    const inst = new THREE.InstancedMesh(child.geometry, child.material, placements.length);
    placements.forEach((pl, i) => {
      const sc = Array.isArray(pl.scale) ? pl.scale : [pl.scale ?? 1, pl.scale ?? 1, pl.scale ?? 1];
      e.set(pl.tiltX ?? 0, pl.rot ?? 0, pl.tiltZ ?? 0, 'YXZ');
      m.compose(p.set(pl.x, pl.y ?? 0, pl.z), q.setFromEuler(e), s.set(...sc));
      inst.setMatrixAt(i, m);
    });
    inst.castShadow = child.castShadow; inst.receiveShadow = child.receiveShadow; inst.renderOrder = child.renderOrder;
    out.add(inst);
  });
  return out;
}
