WGSLDUMP 
@group(0) @binding(0) var t_input: texture_2d<f32>;
@group(0) @binding(1) var smp_input: sampler;

fn colorDelta(a: vec3<f32>, b: vec3<f32>) -> f32 { let t=abs(a-b); return max(max(t.r,t.g),t.b); }
@fragment fn main(@location(0) coord: vec2<f32>) -> @location(0) vec4<f32> {
    let inv = 1.0/vec2<f32>(textureDimensions(t_input));
    let c = textureSampleLevel(t_input,smp_input,coord,0.0).rgb;
    var delta = vec4<f32>(0.0);
    delta.x = colorDelta(c,textureSampleLevel(t_input,smp_input,coord+inv*vec2<f32>(-1,0),0.0).rgb);
    delta.y = colorDelta(c,textureSampleLevel(t_input,smp_input,coord+inv*vec2<f32>(0,-1),0.0).rgb);
    var edges = step(vec2<f32>(0.1),delta.xy);
    if (dot(edges,vec2<f32>(1.0))==0.0) { discard; }
    delta.z = colorDelta(c,textureSampleLevel(t_input,smp_input,coord+inv*vec2<f32>(1,0),0.0).rgb);
    delta.w = colorDelta(c,textureSampleLevel(t_input,smp_input,coord+inv*vec2<f32>(0,1),0.0).rgb);
    var maxDelta = max(max(delta.x,delta.y),max(delta.z,delta.w));
    delta.z = colorDelta(c,textureSampleLevel(t_input,smp_input,coord+inv*vec2<f32>(-2,0),0.0).rgb);
    delta.w = colorDelta(c,textureSampleLevel(t_input,smp_input,coord+inv*vec2<f32>(0,-2),0.0).rgb);
    maxDelta = max(maxDelta,max(delta.z,delta.w));
    edges *= step(vec2<f32>(0.5*maxDelta),delta.xy);
    return vec4<f32>(edges,0,0);
}
