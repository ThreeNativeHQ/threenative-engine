WGSLDUMP 

@group(0) @binding(0) var msaaDepth: texture_depth_multisampled_2d;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let x = select(-1.0, 3.0, index == 1u);
    let y = select(-1.0, 3.0, index == 0u);
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @builtin(frag_depth) f32 {
    return textureLoad(msaaDepth, vec2<i32>(position.xy), 0);
}
