WGSLDUMP 
struct Out {
  @builtin(position) position: vec4<f32>,
  @location(0) o_uv: vec2<f32>,
}
@vertex
fn main(@location(0) a_position: vec2<f32>) -> Out {
  var out: Out;
  out.position = vec4<f32>(a_position, 0f, 1f);
  out.o_uv = vec2<f32>((((a_position).x * 0.5f) + 0.5f), (0.5f - ((a_position).y * 0.5f)));
  return out;
}
