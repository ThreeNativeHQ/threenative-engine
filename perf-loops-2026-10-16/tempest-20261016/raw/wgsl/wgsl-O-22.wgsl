WGSLDUMP 
@group(0) @binding(0) var t_input: texture_2d<f32>;
@group(0) @binding(1) var smp_input: sampler;
@group(0) @binding(2) var t_weights: texture_2d<f32>;
@group(0) @binding(3) var smp_weights: sampler;

@fragment fn main(@location(0) coord: vec2<f32>) -> @location(0) vec4<f32> {
    let inv = 1.0/vec2<f32>(textureDimensions(t_weights));
    let current = textureSampleLevel(t_weights,smp_weights,coord,0.0);
    let a = vec4<f32>(current.x,textureSampleLevel(t_weights,smp_weights,coord+inv*vec2<f32>(0,1),0.0).g,
        current.z,textureSampleLevel(t_weights,smp_weights,coord+inv*vec2<f32>(1,0),0.0).a);
    let c = textureSampleLevel(t_input,smp_input,coord,0.0);
    if (dot(a,vec4<f32>(1.0))<0.00001) { return c; }
    var offset = vec2<f32>(select(-a.b,a.a,a.a>a.b),select(-a.r,a.g,a.g>a.r));
    if (abs(offset.x)>abs(offset.y)) { offset.y=0.0; } else { offset.x=0.0; }
    let opposite = textureSampleLevel(t_input,smp_input,coord+sign(offset)*inv,0.0);
    let s = select(abs(offset.y),abs(offset.x),abs(offset.x)>abs(offset.y));
    return mix(c,opposite,s);
}
