WGSLDUMP 
struct Uniforms {
  f_viewMatrix: mat4x4<f32>,
  f_modelMatrix: mat4x4<f32>,
  f_projectionMatrix: mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
struct Out {
  @builtin(position) position: vec4<f32>,
}
@vertex
fn main(@location(0) a_position: vec3<f32>) -> Out {
  var out: Out;
  out.position = (u.f_projectionMatrix * (u.f_viewMatrix * (u.f_modelMatrix * vec4<f32>(a_position, 1f))));
  return out;
}
