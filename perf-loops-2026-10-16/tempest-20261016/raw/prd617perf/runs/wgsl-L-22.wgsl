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
@binding( 0 ) @group( 1 ) var nodeUniform0_sampler : sampler;
@binding( 1 ) @group( 1 ) var nodeUniform0 : texture_2d<f32>;

struct frameStruct {
	nodeUniform1 : vec2<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> frame : frameStruct;

// vars
var<private> nodeVar0 : vec3<f32>;
var<private> nodeVar1 : f32;
var<private> nodeVar2 : f32;
var<private> nodeVar3 : vec4<f32>;
var<private> nodeVar4 : vec3<f32>;
var<private> nodeVar5 : f32;

// codes


@fragment
fn main( @location( 0 ) nodeVarying0 : vec2<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar0 = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar1 = 0.0;

	for ( var i : i32 = -2; i <= 2; i ++ ) {

		for ( var j : i32 = -2; j <= 2; j ++ ) {

			nodeVar2 = exp( ( ( - f32( ( ( j * j ) + ( i * i ) ) ) ) * 0.32 ) );
			nodeVar3 = textureSample( nodeUniform0, nodeUniform0_sampler, ( vec2<f32>( nodeVarying0.x, ( 1.0 - nodeVarying0.y ) ) + ( ( vec2<f32>( f32( j ), f32( i ) ) / frame.nodeUniform1 ) * vec2<f32>( 2.0 ) ) ) );
			nodeVar4 = nodeVar3.xyz;
			nodeVar5 = max( nodeVar4.x, max( nodeVar4.y, nodeVar4.z ) );
			nodeVar0 = ( nodeVar0 + ( ( nodeVar4 * vec3<f32>( smoothstep( 0.7, 1.6, nodeVar5 ) ) ) * vec3<f32>( nodeVar2 ) ) );
			nodeVar1 = ( nodeVar1 + nodeVar2 );

		}

	}


	// result

	output.color = vec4<f32>( ( nodeVar0 / vec3<f32>( nodeVar1 ) ), 1.0 );

	return output;

}
