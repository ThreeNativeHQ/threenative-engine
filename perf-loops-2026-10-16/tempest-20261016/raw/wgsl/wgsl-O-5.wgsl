WGSLDUMP 
struct Uniforms {
  f_viewMatrix: mat4x4<f32>,
  f_modelMatrix: mat4x4<f32>,
  f_projectionMatrix: mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
struct Out {
  @location(0) o_uv: vec2<f32>,
  @builtin(position) position: vec4<f32>,
}
@vertex
fn main(@location(0) a_position: vec3<f32>, @location(1) a_uv: vec2<f32>) -> Out {
  var out: Out;
  out.position = vec4<f32>(vec4<f32>((a_position).xy, 0f, 1f));
  out.o_uv = a_uv;
  return out;
}
