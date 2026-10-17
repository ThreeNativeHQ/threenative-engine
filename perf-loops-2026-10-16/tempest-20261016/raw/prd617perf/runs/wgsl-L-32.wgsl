WGSLDUMP fragment_SMAANode.blend
// Three.js r185 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 0 ) @group( 1 ) var nodeUniform2_sampler : sampler;
@binding( 1 ) @group( 1 ) var nodeUniform2 : texture_2d<f32>;
@binding( 3 ) @group( 1 ) var nodeUniform6_sampler : sampler;
@binding( 4 ) @group( 1 ) var nodeUniform6 : texture_2d<f32>;

struct objectStruct {
	nodeUniform1 : mat4x4<f32>,
	nodeUniform3 : mat3x3<f32>,
	nodeUniform4 : mat3x3<f32>,
	nodeUniform5 : mat3x3<f32>,
	nodeUniform7 : vec2<f32>,
	nodeUniform8 : vec2<f32>
};
@binding( 2 ) @group( 1 )
var<uniform> object : objectStruct;

// vars
var<private> nodeVar0 : vec4<f32>;
var<private> nodeVar1 : vec4<f32>;
var<private> nodeVar2 : vec4<f32>;
var<private> nodeVar3 : vec2<f32>;
var<private> nodeVar4 : vec4<f32>;
var<private> nodeVar5 : vec4<f32>;
var<private> nodeVar6 : vec4<f32>;
var<private> nodeVar7 : vec2<f32>;
var<private> nodeVar8 : f32;
var<private> nodeVar9 : f32;
var<private> nodeVar10 : vec4<f32>;
var<private> nodeVar11 : vec4<f32>;
var<private> nodeVar12 : vec2<f32>;
var<private> nodeVar13 : vec4<f32>;
var<private> nodeVar14 : vec4<f32>;
var<private> nodeVar15 : f32;
var<private> nodeVar16 : f32;

// codes


@fragment
fn main( @location( 0 ) nodeVarying4 : vec2<f32>,
	@location( 1 ) vOffset1 : vec4<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar0 = vec4<f32>( 0.0, 0.0, 0.0, 1.0 );
	nodeVar1 = vec4<f32>( 0.0, 0.0, 0.0, 1.0 );
	nodeVar2 = textureSample( nodeUniform2, nodeUniform2_sampler, ( object.nodeUniform3 * vec3<f32>( nodeVarying4, 1.0 ) ).xy );
	nodeVar3 = nodeVar2.xz;
	nodeVar1.x = nodeVar3[ 0 ];
	nodeVar1.z = nodeVar3[ 1 ];
	nodeVar4 = textureSample( nodeUniform2, nodeUniform2_sampler, ( object.nodeUniform4 * vec3<f32>( vOffset1.zw, 1.0 ) ).xy );
	nodeVar1.y = nodeVar4.y;
	nodeVar5 = textureSample( nodeUniform2, nodeUniform2_sampler, ( object.nodeUniform5 * vec3<f32>( vOffset1.xy, 1.0 ) ).xy );
	nodeVar1.w = nodeVar5.w;

	if ( ( dot( nodeVar1, vec4<f32>( 1.0, 1.0, 1.0, 1.0 ) ) < 0.00001 ) ) {

		nodeVar6 = textureSample( nodeUniform6, nodeUniform6_sampler, nodeVarying4 );
		nodeVar0 = nodeVar6;
		

	} else {

		nodeVar7 = vec2<f32>( 0.0, 0.0 );

		if ( ( nodeVar1.w > nodeVar1.z ) ) {

			nodeVar8 = nodeVar1.w;

		} else {

			nodeVar8 = ( - nodeVar1.z );

		}

		nodeVar7.x = nodeVar8;

		if ( ( nodeVar1.y > nodeVar1.x ) ) {

			nodeVar9 = nodeVar1.y;

		} else {

			nodeVar9 = ( - nodeVar1.x );

		}

		nodeVar7.y = nodeVar9;

		if ( ( abs( nodeVar7.x ) > abs( nodeVar7.y ) ) ) {

			nodeVar7.y = 0.0;
			

		} else {

			nodeVar7.x = 0.0;
			

		}

		nodeVar10 = textureSample( nodeUniform6, nodeUniform6_sampler, nodeVarying4 );
		nodeVar11 = nodeVar10;
		nodeVar12 = nodeVarying4;
		nodeVar12 = ( nodeVar12 + ( sign( nodeVar7 ) * object.nodeUniform7 ) );
		nodeVar13 = textureSample( nodeUniform6, nodeUniform6_sampler, nodeVar12 );
		nodeVar14 = nodeVar13;

		if ( ( abs( nodeVar7.x ) > abs( nodeVar7.y ) ) ) {

			nodeVar15 = abs( nodeVar7.x );

		} else {

			nodeVar15 = abs( nodeVar7.y );

		}

		nodeVar16 = nodeVar15;
		nodeVar0 = mix( nodeVar11, nodeVar14, nodeVar16 );
		

	}


	// result

	output.color = nodeVar0;

	return output;

}
