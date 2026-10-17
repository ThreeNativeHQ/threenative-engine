WGSLDUMP 
@group(0) @binding(0) var t_area: texture_2d<f32>;
@group(0) @binding(1) var smp_area: sampler;
@group(0) @binding(2) var t_edges: texture_2d<f32>;
@group(0) @binding(3) var smp_edges: sampler;
@group(0) @binding(4) var t_search: texture_2d<f32>;
@group(0) @binding(5) var smp_search: sampler;

fn searchLength(e: vec2<f32>, bias: f32) -> f32 {
    return 255.0*textureSampleLevel(t_search,smp_search,vec2<f32>(bias+e.r*0.5,e.g),0.0).r;
}
fn area(dist: vec2<f32>, e1: f32, e2: f32) -> vec2<f32> {
    let pixel = vec2<f32>(1.0/160.0,1.0/560.0);
    let coord = pixel*(16.0*round(4.0*vec2<f32>(e1,e2))+dist)+0.5*pixel;
    return textureSampleLevel(t_area,smp_area,coord,0.0).rg;
}
fn searchX(start: vec2<f32>, end: f32, direction: f32, inv: vec2<f32>) -> f32 {
    var e = vec2<f32>(0,1); var coord = start;
    for (var i=0; i<8; i++) {
        e = textureSampleLevel(t_edges,smp_edges,coord,0.0).rg;
        coord += vec2<f32>(2.0*direction,0)*inv;
        if ((direction<0.0 && coord.x<=end) || (direction>0.0 && coord.x>=end) || e.g<=0.8281 || e.r!=0.0) { break; }
    }
    let bias = select(0.0,0.5,direction>0.0);
    if (direction<0.0) {
        coord.x += 0.25*inv.x; coord.x += inv.x; coord.x += 2.0*inv.x;
        coord.x -= inv.x*searchLength(e,bias);
    } else {
        coord.x -= 0.25*inv.x; coord.x -= inv.x; coord.x -= 2.0*inv.x;
        coord.x += inv.x*searchLength(e,bias);
    }
    return coord.x;
}
fn searchY(start: vec2<f32>, end: f32, direction: f32, inv: vec2<f32>) -> f32 {
    var e = vec2<f32>(1,0); var coord = start;
    for (var i=0; i<8; i++) {
        e = textureSampleLevel(t_edges,smp_edges,coord,0.0).rg;
        coord += vec2<f32>(0,2.0*direction)*inv;
        if ((direction<0.0 && coord.y<=end) || (direction>0.0 && coord.y>=end) || e.r<=0.8281 || e.g!=0.0) { break; }
    }
    let bias = select(0.0,0.5,direction>0.0);
    if (direction<0.0) {
        coord.y += 0.25*inv.y; coord.y += inv.y; coord.y += 2.0*inv.y;
        coord.y -= inv.y*searchLength(e.gr,bias);
    } else {
        coord.y -= 0.25*inv.y; coord.y -= inv.y; coord.y -= 2.0*inv.y;
        coord.y += inv.y*searchLength(e.gr,bias);
    }
    return coord.y;
}
@fragment fn main(@location(0) coord: vec2<f32>) -> @location(0) vec4<f32> {
    let inv = 1.0/vec2<f32>(textureDimensions(t_edges));
    let pixcoord = coord/inv;
    let o0 = coord.xyxy+inv.xyxy*vec4<f32>(-0.25,-0.125,1.25,-0.125);
    let o1 = coord.xyxy+inv.xyxy*vec4<f32>(-0.125,-0.25,-0.125,1.25);
    let o2 = vec4<f32>(o0.xz,o1.yw)+vec4<f32>(-2,2,-2,2)*vec4<f32>(inv.xx,inv.yy)*8.0;
    var weights = vec4<f32>(0.0);
    let e = textureSampleLevel(t_edges,smp_edges,coord,0.0).rg;
    if (e.g>0.0) {
        let left = vec2<f32>(searchX(o0.xy,o2.x,-1.0,inv),o1.y);
        let e1 = textureSampleLevel(t_edges,smp_edges,left,0.0).r;
        let right = vec2<f32>(searchX(o0.zw,o2.y,1.0,inv),o1.y);
        let d = vec2<f32>(left.x,right.x)/inv.x-pixcoord.x;
        let e2 = textureSampleLevel(t_edges,smp_edges,right+vec2<f32>(1,0)*inv,0.0).r;
        let a = area(sqrt(abs(d)),e1,e2); weights.r=a.x; weights.g=a.y;
    }
    if (e.r>0.0) {
        let up = vec2<f32>(o0.x,searchY(o1.xy,o2.z,-1.0,inv));
        let e1 = textureSampleLevel(t_edges,smp_edges,up,0.0).g;
        let down = vec2<f32>(o0.x,searchY(o1.zw,o2.w,1.0,inv));
        let d = vec2<f32>(up.y,down.y)/inv.y-pixcoord.y;
        let e2 = textureSampleLevel(t_edges,smp_edges,down+vec2<f32>(0,1)*inv,0.0).g;
        let a = area(sqrt(abs(d)),e1,e2); weights.b=a.x; weights.a=a.y;
    }
    return weights;
}
