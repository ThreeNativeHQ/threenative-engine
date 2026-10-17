WGSLDUMP 
diagnostic(off, derivative_uniformity);
struct Uniforms {
  f_nodeUniform47: f32,
}
@group(1) @binding(0) var<uniform> u: Uniforms;
struct Out {
  @location(0) color: vec4<f32>,
}
@fragment
fn main(@location(0) i_vAcross: f32, @location(1) i_vAlong: f32, @location(2) i_vOpacity: f32) -> Out {
  var out: Out;
  out.color = vec4<f32>((vec3<f32>(0.41f, 0.56f, 0.68f) + (u.f_nodeUniform47 * vec3<f32>(0.35f, 0.48f, 0.65f))), ((pow(max(0f, (1f - abs(i_vAcross))), 1.6f) * sin((i_vAlong * 3.1415927f))) * i_vOpacity));
  return out;
}
