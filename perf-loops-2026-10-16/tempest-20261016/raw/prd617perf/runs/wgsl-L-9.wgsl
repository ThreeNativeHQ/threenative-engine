WGSLDUMP fragment
// Three.js r185 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms

struct frameStruct {
	nodeUniform2 : f32,
	nodeUniform1 : f32,
	nodeUniform3 : f32,
	nodeUniform0 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform4 : vec3<f32>,
	nodeUniform11 : vec3<f32>,
	nodeUniform5 : vec3<f32>,
	nodeUniform8 : vec3<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> frame : frameStruct;

// vars


// codes


@fragment
fn main( @location( 0 ) vAcross : f32,
	@location( 1 ) vAlong : f32,
	@location( 2 ) vOpacity : f32 ) -> OutputStruct {

	// flow
	// code


	// result

	output.color = vec4<f32>( ( vec3<f32>( 0.41, 0.56, 0.68 ) + ( vec3<f32>( frame.nodeUniform0 ) * vec3<f32>( 0.35, 0.48, 0.65 ) ) ), ( ( pow( max( 0.0, ( 1.0 - abs( vAcross ) ) ), 1.6 ) * sin( ( vAlong * 3.141592653589793 ) ) ) * vOpacity ) );

	return output;

}
