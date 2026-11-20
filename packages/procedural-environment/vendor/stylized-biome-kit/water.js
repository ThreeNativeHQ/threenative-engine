// water.js — animated stylized water surface and waterfalls.
import * as THREE from 'three';
import { RNG, uniforms, col, paintFaces, xform, blob, piece } from './core.js';
import { WATER } from './palettes.js';

const SURFACE_VERT = /* glsl */`
  attribute float depth;
  varying float vDepth; varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vDepth = depth;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const SURFACE_FRAG = /* glsl */`
  uniform float uTime, uDepthRange; uniform vec3 uShallow, uDeep, uFoam;
  varying float vDepth; varying vec3 vWorld;
  #include <fog_pars_fragment>
  vec2 hash2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i).x, hash2(i + vec2(1, 0)).x, f.x), mix(hash2(i + vec2(0, 1)).x, hash2(i + vec2(1, 1)).x, f.x), f.y); }
  void main() {
    if (vDepth < -0.03) discard;
    float d = clamp(vDepth / uDepthRange, 0.0, 1.0);
    vec3 c = mix(uShallow, uDeep, smoothstep(0.0, 1.0, d));
    // drifting foam curls: contour lines of slow noise, shown only in patches
    vec2 uv = vWorld.xz * 0.2;
    float n = vnoise(uv + vec2(uTime * 0.07, -uTime * 0.05)) + 0.5 * vnoise(uv * 2.3 - uTime * 0.06);
    float lines = 1.0 - smoothstep(0.02, 0.05, abs(fract(n * 2.2) - 0.5));
    lines *= smoothstep(0.5, 0.72, vnoise(uv * 0.45 + 3.7 + uTime * 0.02));
    float wob = 0.07 * sin(uTime * 1.4 + vWorld.x * 0.9 + vWorld.z * 0.7);
    float shore = 1.0 - smoothstep(0.02, 0.15, vDepth + wob);
    float ring = (1.0 - smoothstep(0.02, 0.07, abs(vDepth - 0.42 - wob * 1.6))) * 0.4;
    float foam = clamp(lines * 0.75 + shore + ring, 0.0, 1.0);
    c = mix(c, uFoam, foam);
    gl_FragColor = vec4(c, max(mix(0.5, 0.94, d), foam));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

function surfaceMaterial(palette, depthRange) {
  const pal = WATER[palette];
  return new THREE.ShaderMaterial({
    vertexShader: SURFACE_VERT, fragmentShader: SURFACE_FRAG, transparent: true, depthWrite: false, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uDepthRange: { value: depthRange }, uShallow: { value: col(pal.shallow) }, uDeep: { value: col(pal.deep) }, uFoam: { value: col(pal.foam) }, uTime: { value: 0 },
    }]),
  });
}

/**
 * Water surface. `depth(x, z)` returns how deep the water is at a world position
 * (negative = dry land, which is cut away), so the shoreline, foam and colour
 * follow whatever terrain you put underneath. Without it you get a round pond.
 */
export function water({ width = 20, length = 20, segments = 48, palette = 'river', depth = null, depthRange = 2.2, x = 0, y = 0, z = 0 } = {}) {
  const g = new THREE.PlaneGeometry(width, length, segments, Math.max(1, Math.round((segments * length) / width)));
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position, d = new Float32Array(pos.count), R = Math.min(width, length) / 2;
  const fn = depth || ((px, pz) => (R * 0.92 - Math.hypot(px - x, pz - z)) * 0.3);
  for (let i = 0; i < pos.count; i++) d[i] = fn(pos.getX(i) + x, pos.getZ(i) + z);
  g.setAttribute('depth', new THREE.BufferAttribute(d, 1));
  const mat = surfaceMaterial(palette, depthRange);
  mat.uniforms.uTime = uniforms.uTime;
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z); m.renderOrder = 2; m.name = 'water'; m.userData = { kit: 'water' };
  return m;
}

const FALL_VERT = /* glsl */`
  varying vec2 vUv;
  #include <fog_pars_vertex>
  void main() { vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const FALL_NOISE = /* glsl */`
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }`;
const FALL_FRAG = /* glsl */`
  uniform float uTime; uniform vec3 uShallow, uDeep, uFoam; uniform vec2 uSize;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  ${FALL_NOISE}
  void main() {
    float x = vUv.x * uSize.x, drop = (1.0 - vUv.y) * uSize.y;     // metres across, metres fallen
    // three layers of streaks sliding down at different speeds; they stretch as the water speeds up
    float stretch = 0.42 - 0.012 * drop;
    float a = n(vec2(x * 1.6, drop * stretch - uTime * 1.9));
    float b = n(vec2(x * 4.3 + 7.0, drop * stretch * 1.6 - uTime * 3.1));
    float c2 = n(vec2(x * 9.0 + 19.0, drop * stretch * 2.4 - uTime * 4.4));
    float body = a * 0.55 + b * 0.45;
    vec3 c = mix(uDeep, uShallow, smoothstep(0.3, 0.62, body));
    float w = max(fwidth(body) * 1.5, 0.01);
    c = mix(c, uFoam, smoothstep(0.6 - w, 0.6 + w, body) * 0.9);                      // broad white ribbons
    c = mix(c, uFoam, smoothstep(0.66, 0.7, c2) * smoothstep(0.35, 0.6, body) * 0.8); // thin fast threads
    float lip = smoothstep(0.045, 0.0, 1.0 - vUv.y + (a - 0.5) * 0.03);
    float churn = smoothstep(0.09 + 0.1 * n(vec2(x * 2.5, uTime * 2.6)), 0.0, vUv.y); // boiling foot
    c = mix(c, uFoam, clamp(lip * 0.85 + churn, 0.0, 1.0));
    float side = min(vUv.x, 1.0 - vUv.x) + (n(vec2(vUv.x * 9.0, drop * 0.5 - uTime * 2.0)) - 0.5) * 0.1 * (0.3 + 0.7 * (1.0 - vUv.y));
    if (side < 0.03) discard;
    gl_FragColor = vec4(c, 0.95);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

// Rings spreading over the pool from the foot of the fall.
const RIPPLE_FRAG = /* glsl */`
  uniform float uTime; uniform vec3 uFoam; uniform vec2 uSize; uniform float uWidth;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  ${FALL_NOISE}
  void main() {
    vec2 q = vec2((vUv.x - 0.5) * uSize.x, vUv.y * uSize.y - 0.9);
    float r = length(vec2(max(abs(q.x) - uWidth * 0.5, 0.0), q.y)) + (n(q * 1.3 + uTime * 0.3) - 0.5) * 0.35;
    float reach = uSize.y - 1.4, fade = 1.0 - smoothstep(reach * 0.25, reach, r);
    float ring = abs(fract(r * 0.75 - uTime * 0.7) - 0.5);
    float lines = (1.0 - smoothstep(0.06, 0.13, ring)) * fade;
    float boil = (1.0 - smoothstep(0.2, 0.9, r)) * (0.65 + 0.35 * n(q * 3.0 + vec2(0.0, -uTime * 2.0)));
    float alpha = clamp(lines * 0.8 + boil, 0.0, 1.0);
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(uFoam, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

// Droplets thrown up where the water lands. position = (phase, across, energy), all 0..1.
const SPRAY_VERT = /* glsl */`
  uniform float uTime, uWidth, uPixels;
  varying float vLife;
  void main() {
    float life = fract(uTime * (0.55 + position.z * 0.5) + position.x);
    float side = fract(position.x * 7.31) - 0.5;
    vec3 p = vec3((position.y - 0.5) * uWidth + side * 1.4 * life, 0.1, 0.15 + (0.4 + position.z * 1.5) * life);
    p.y += 4.0 * life * (1.0 - life) * (0.35 + position.z * 1.1);
    vLife = life;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uPixels * (0.5 + position.z) * (1.0 - life * 0.6) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const SPRAY_FRAG = /* glsl */`
  varying float vLife;
  void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(1.0, 1.0, 1.0, (1.0 - vLife) * smoothstep(0.5, 0.25, d)); }`;

/**
 * Waterfall: a scrolling sheet, spray at its foot and rings on the pool.
 * Origin is the centre of the pool at the bottom; the water leaves the lip at
 * y = height and lands `throwDist` metres towards +Z.
 */
export function waterfall({ seed = 1, width = 6, height = 8, throwDist = 1.5, palette = 'river', foam = true } = {}) {
  const rng = new RNG(seed), pal = WATER[palette], g = new THREE.PlaneGeometry(width, height, 14, 20);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const tau = 1 - uv.getY(i), x = pos.getX(i);
    const bow = 0.25 * Math.cos((x / width) * Math.PI) + 0.1 * Math.sin(x * 2.1 + seed);
    pos.setXYZ(i, x * (1 + 0.06 * tau), height * (1 - tau * tau), throwDist * (tau - 1) + bow * tau);
  }
  const shared = () => ({ uShallow: { value: col(pal.shallow) }, uDeep: { value: col(pal.deep) }, uFoam: { value: col(pal.foam) }, uTime: { value: 0 } });
  const mat = new THREE.ShaderMaterial({
    vertexShader: FALL_VERT, fragmentShader: FALL_FRAG, transparent: true, side: THREE.DoubleSide, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uSize: { value: new THREE.Vector2(width, height) }, ...shared() }]),
  });
  mat.uniforms.uTime = uniforms.uTime;
  const sheet = new THREE.Mesh(g, mat); sheet.name = 'waterfall:sheet'; sheet.renderOrder = 4;

  const reach = 2.2 + height * 0.22, rg = new THREE.PlaneGeometry(width + reach * 2, reach + 1.4);
  rg.rotateX(-Math.PI / 2); rg.translate(0, 0.05, -(reach + 1.4) / 2 + 0.9 + reach * 0.0);
  // uv.y runs from the cliff side (0) out over the pool (1)
  const ruv = rg.attributes.uv; for (let i = 0; i < ruv.count; i++) ruv.setY(i, 1 - ruv.getY(i));
  rg.translate(0, 0, reach + 1.4 - 0.9 - 0.9);
  const rmat = new THREE.ShaderMaterial({
    vertexShader: FALL_VERT, fragmentShader: RIPPLE_FRAG, transparent: true, depthWrite: false, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uSize: { value: new THREE.Vector2(width + reach * 2, reach + 1.4) }, uWidth: { value: width }, ...shared() }]),
  });
  rmat.uniforms.uTime = uniforms.uTime;
  const ripples = new THREE.Mesh(rg, rmat); ripples.name = 'waterfall:ripples'; ripples.renderOrder = 3;

  const count = Math.round(width * 14), sp = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) sp[i] = rng.next();
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const smat = new THREE.ShaderMaterial({ vertexShader: SPRAY_VERT, fragmentShader: SPRAY_FRAG, transparent: true, depthWrite: false, uniforms: { uTime: uniforms.uTime, uWidth: { value: width }, uPixels: { value: 190 } } });
  const spray = new THREE.Points(sg, smat); spray.name = 'waterfall:spray'; spray.frustumCulled = false; spray.renderOrder = 5;

  const parts = [];
  if (foam) {
    const white = col(0xffffff), tint = col(pal.shallow);
    for (let i = 0; i < Math.round(width * 1.6); i++) {
      const r = rng.range(0.25, 0.6), b = paintFaces(blob(rng, { r, detail: 2, squash: [1, 0.55, 1], lumpy: 0.2 }), (c, n, o) => o.copy(tint).lerp(white, 0.55 + 0.45 * Math.max(0, n.y)));
      parts.push(xform(b, { pos: [rng.range(-0.5, 0.5) * width, rng.range(-0.05, 0.12), rng.range(-0.3, 0.9)] }));
    }
  }
  const group = piece('waterfall', { cloud: parts }, { height });
  group.add(sheet, ripples, spray);
  return group;
}
