WGSLDUMP vertex
// Three.js r185 - Node System

// directives


// structs


// uniforms


// varyings

struct VaryingsStruct {
	@location( 0 ) nodeVarying0 : vec2<f32>,
	@builtin( position ) builtinClipSpace : vec4<f32>
};
var<private> varyings : VaryingsStruct;

// vars
var<private> nodeVar6 : vec4<f32>;

// codes


@vertex
fn main( @location( 0 ) uv : vec2<f32>,
	@location( 1 ) position : vec3<f32> ) -> VaryingsStruct {

	// flow
	// code

	varyings.nodeVarying0 = uv;
	nodeVar6 = vec4<f32>( position.xy, 0.0, 1.0 );

	// result

	varyings.builtinClipSpace = nodeVar6;

	return varyings;

}
