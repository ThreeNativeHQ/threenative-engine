WGSLDUMP fragment_RTT
// Three.js r185 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 0 ) @group( 1 ) var nodeUniform0_sampler : sampler;
@binding( 1 ) @group( 1 ) var nodeUniform0 : texture_2d<f32>;

// vars
var<private> nodeVar0 : vec4<f32>;
var<private> nodeVar1 : vec4<f32>;

// codes


@fragment
fn main( @location( 0 ) nodeVarying4 : vec2<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar0 = textureSample( nodeUniform0, nodeUniform0_sampler, nodeVarying4 );
	nodeVar1 = ( nodeVar0 * vec4<f32>( 1.0 ) );

	// result

	output.color = ( nodeVar1 / vec4<f32>( ( max( nodeVar1.x, max( nodeVar1.y, nodeVar1.z ) ) + 1.0 ) ) );

	return output;

}
