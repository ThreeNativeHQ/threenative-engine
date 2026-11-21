import type { MeshStandardMaterial } from "three";

const GLSL = `
varying vec3 vDungeonPosition;
varying vec2 vDungeonSurface;

float grainHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.3, 0.2)) * 19.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float grain(vec3 p) {
  vec3 i = floor(p), t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  return mix(
    mix(mix(grainHash(i), grainHash(i + vec3(1,0,0)), t.x),
        mix(grainHash(i + vec3(0,1,0)), grainHash(i + vec3(1,1,0)), t.x), t.y),
    mix(mix(grainHash(i + vec3(0,0,1)), grainHash(i + vec3(1,0,1)), t.x),
        mix(grainHash(i + vec3(0,1,1)), grainHash(i + vec3(1,1,1)), t.x), t.y), t.z);
}

vec3 dungeonFinish(vec3 p, float kind) {
  float weather = grain(p * 4.6);
  if (kind > 1.5) {
    float fibers = grain(p * vec3(87.0, 17.0, 85.0));
    return vec3(0.84 + 0.24 * fibers, fibers * 0.0028, 0.84 + 0.12 * weather);
  }
  if (kind > 0.5) {
    // Blend grain axes to keep end grain legible on horizontal, vertical, and cut faces.
    float vertical = grain(p * vec3(61.0, 2.0, 57.0) + weather * 0.9);
    float horizontal = grain(p * vec3(2.5, 49.0, 48.0) + weather * 1.3);
    float bands = mix(vertical, horizontal, smoothstep(0.30, 0.67, weather));
    return vec3(0.68 + bands * 0.37 + weather * 0.14, bands * 0.006, 0.79 + bands * 0.13);
  }
  float gravel = grain(p * 23.0);
  float chips = abs(grain(p * 51.0) * 2.0 - 1.0);
  float mineral = smoothstep(0.25, 0.8, 0.57 * weather + 0.43 * gravel);
  return vec3(0.55 + 0.47 * mineral + 0.16 * chips, gravel * 0.008 + chips * 0.0035, 0.77 + mineral * 0.19);
}
`;

export function dungeonFinish(material: MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec2 dungeonSurface;
varying vec3 vDungeonPosition;
varying vec2 vDungeonSurface;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vDungeonPosition = position;
vDungeonSurface = dungeonSurface;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
${GLSL}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec3 finish = dungeonFinish(vDungeonPosition + vDungeonSurface.y, vDungeonSurface.x);
diffuseColor.rgb *= finish.x;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor *= finish.z;",
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
vec3 dx = dFdx(-vViewPosition), dy = dFdy(-vViewPosition);
vec3 row = cross(dy, normal), col = cross(normal, dx);
float det = dot(dx, row);
vec3 bump = sign(det) * (dFdx(finish.y) * row + dFdy(finish.y) * col);
normal = normalize(max(abs(det), 1e-8) * normal - bump);`,
      );
  };
}
