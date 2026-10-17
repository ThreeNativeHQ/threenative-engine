WGSLDUMP 
diagnostic(off, derivative_uniformity);
@group(0) @binding(0) var t_scene: texture_2d<f32>;
@group(0) @binding(1) var smp_scene: sampler;
struct Out {
  @location(0) color: vec4<f32>,
}
@fragment
fn main(@location(0) i_uv: vec2<f32>) -> Out {
  var out: Out;
  let e2 = textureSample(t_scene, smp_scene, i_uv);
  let e6 = clamp((e2).w, 0f, 1f);
  out.color = vec4<f32>((select(((e2).xyz / e6), vec3<f32>(0f), (e6 == 0f)) * e6), e6);
  return out;
}
