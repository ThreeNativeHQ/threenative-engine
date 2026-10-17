WGSLDUMP 
diagnostic(off, derivative_uniformity);
@group(0) @binding(0) var t_scene: texture_2d<f32>;
@group(0) @binding(1) var smp_scene: sampler;
@group(0) @binding(2) var t_native_live_post_1: texture_2d<f32>;
@group(0) @binding(3) var smp_native_live_post_1: sampler;
struct Out {
  @location(0) color: vec4<f32>,
}
@fragment
fn main(@location(0) i_uv: vec2<f32>) -> Out {
  var out: Out;
  let e2 = textureSample(t_native_live_post_1, smp_native_live_post_1, i_uv);
  out.color = (e2 / max((1f - max((e2).x, max((e2).y, (e2).z))), 1e-04f));
  return out;
}
