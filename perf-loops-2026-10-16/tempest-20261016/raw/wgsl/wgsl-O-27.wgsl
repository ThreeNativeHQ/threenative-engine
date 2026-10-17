WGSLDUMP 
struct Uniforms {
  f_viewMatrix: mat4x4<f32>,
  f_modelMatrix: mat4x4<f32>,
  f_projectionMatrix: mat4x4<f32>,
  f_nodeUniform44: f32,
  f_nodeUniform46: f32,
  f_nodeUniform50: vec3<f32>,
  f_nodeUniform52: vec3<f32>,
  f_nodeUniform48: f32,
  f_nodeUniform49: f32,
  f_nodeUniform53: vec3<f32>,
  f_cameraNear: f32,
  f_cameraFar: f32,
  f_nodeUniform51: vec3<f32>,
  f_screenSize: vec2<f32>,
  f_nodeUniform45: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
struct Out {
  @location(0) o_vAcross: f32,
  @location(1) o_vAlong: f32,
  @location(2) o_vOpacity: f32,
  @builtin(position) position: vec4<f32>,
}
fn tsl_mod_float(x : f32, y : f32) -> f32 { return x - y * floor(x / y); }
fn tsl_mod_vec2(x : vec2<f32>, y : vec2<f32>) -> vec2<f32> { return x - y * floor(x / y); }
fn tsl_mod_vec3(x : vec3<f32>, y : vec3<f32>) -> vec3<f32> { return x - y * floor(x / y); }
fn tsl_mod_vec4(x : vec4<f32>, y : vec4<f32>) -> vec4<f32> { return x - y * floor(x / y); }
@vertex
fn main(@location(0) a_position: vec3<f32>, @builtin(instance_index) b_instanceIndex: u32) -> Out {
  var out: Out;
  let e12 = f32(b_instanceIndex);
  let e47 = vec3<f32>(((fract((sin((((e12 * 3.1f) + 2f) * 127.1f)) * 43758.547f)) * 66f) - 33f), (fract((sin((((e12 * 7.3f) + 5f) * 127.1f)) * 43758.547f)) * 30f), ((fract((sin((((e12 * 5.7f) + 8f) * 127.1f)) * 43758.547f)) * 66f) - 33f));
  let e54 = fract((sin(((e12 + 1f) * 127.1f)) * 43758.547f));
  let e57 = (u.f_nodeUniform44 + (e54 * 10f));
  let e59 = (e57 * u.f_nodeUniform46);
  let e69 = (14f + (e54 * 8f));
  let e94 = (vec3<f32>((tsl_mod_float((((e47).x + (e59 * 20f)) + 33f), 66f) - 33f), (tsl_mod_float(((e47).y - (e57 * e69)), 30f) - 0.45f), (tsl_mod_float((((e47).z + (e59 * 2f)) + 33f), 66f) - 33f)) + vec3<f32>((floor(((u.f_nodeUniform50).x / 12f)) * 12f), 0f, (floor(((u.f_nodeUniform50).z / 12f)) * 12f)));
  let e102 = vec3<f32>((e94).x, ((e94).y + max(((u.f_nodeUniform50).y - 5f), 0f)), (e94).z);
  let e103 = (e102 - u.f_nodeUniform50);
  let e108 = (u.f_nodeUniform48 * u.f_nodeUniform49);
  let e115 = (u.f_cameraNear + u.f_cameraFar);
  let e117 = ((u.f_cameraNear * u.f_cameraFar) * 2f);
  let e119 = dot(e103, u.f_nodeUniform51);
  let e122 = (u.f_cameraFar - u.f_cameraNear);
  let e129 = vec4<f32>((dot(e103, u.f_nodeUniform52) / e108), (dot(e103, u.f_nodeUniform53) / u.f_nodeUniform49), (clamp(((((e115 - (e117 / e119)) / e122) + 1f) * 0.5f), 0f, 1f) * e119), e119);
  let e143 = ((e102 - (vec3<f32>((u.f_nodeUniform46 * 20f), (-e69), (u.f_nodeUniform46 * 2f)) * (0.013f + (e54 * 0.011f)))) - u.f_nodeUniform50);
  let e148 = dot(e143, u.f_nodeUniform51);
  let e156 = vec4<f32>((dot(e143, u.f_nodeUniform52) / e108), (dot(e143, u.f_nodeUniform53) / u.f_nodeUniform49), (clamp(((((e115 - (e117 / e148)) / e122) + 1f) * 0.5f), 0f, 1f) * e148), e148);
  let e161 = (a_position).xy;
  let e162 = (e161).y;
  let e163 = mix(e129, e156, e162);
  let e157 = (e156).w;
  let e130 = (e129).w;
  let e176 = normalize((((((e156).xy / max(e157, 0.1f)) - ((e129).xy / max(e130, 0.1f))) * u.f_screenSize) + 1e-04f));
  let e181 = (e161).x;
  let e190 = (((((vec2<f32>((-(e176).y), (e176).x) * e181) * mix(0.42f, 0.85f, e54)) / u.f_screenSize) * (e163).w) * 2f);
  out.position = vec4<f32>(select((e163 + vec4<f32>((e190).x, (e190).y, 0f, 0f)), vec4<f32>(2f, 2f, 2f, 1f), ((e130 < 0.4f) || (e157 < 0.4f))));
  out.o_vAcross = e181;
  out.o_vAlong = e162;
  out.o_vOpacity = ((((0.07f + (e54 * 0.14f)) * u.f_nodeUniform45) * smoothstep(0.3f, 1.8f, e130)) * (1f - smoothstep(12f, 43f, e130)));
  return out;
}
