WGSLDUMP fragment_SMAANode.edges
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
var<private> nodeVar2 : vec3<f32>;
var<private> nodeVar3 : vec4<f32>;
var<private> nodeVar4 : vec3<f32>;
var<private> nodeVar5 : vec3<f32>;
var<private> nodeVar6 : vec4<f32>;
var<private> nodeVar7 : vec3<f32>;
var<private> nodeVar8 : vec3<f32>;
var<private> nodeVar9 : vec2<f32>;
var<private> nodeVar10 : vec4<f32>;
var<private> nodeVar11 : vec3<f32>;
var<private> nodeVar12 : vec3<f32>;
var<private> nodeVar13 : vec4<f32>;
var<private> nodeVar14 : vec3<f32>;
var<private> nodeVar15 : vec3<f32>;
var<private> nodeVar16 : f32;
var<private> nodeVar17 : vec4<f32>;
var<private> nodeVar18 : vec3<f32>;
var<private> nodeVar19 : vec3<f32>;
var<private> nodeVar20 : vec4<f32>;
var<private> nodeVar21 : vec3<f32>;
var<private> nodeVar22 : vec3<f32>;

// codes


@fragment
fn main( @location( 0 ) nodeVarying4 : vec2<f32>,
	@location( 1 ) vOffset0 : vec4<f32>,
	@location( 2 ) vOffset1 : vec4<f32>,
	@location( 3 ) vOffset2 : vec4<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar0 = vec4<f32>( 0.0, 0.0, 0.0, 1.0 );
	nodeVar1 = textureSample( nodeUniform0, nodeUniform0_sampler, nodeVarying4 );
	nodeVar2 = nodeVar1.xyz;
	nodeVar3 = textureSample( nodeUniform0, nodeUniform0_sampler, vOffset0.xy );
	nodeVar4 = nodeVar3.xyz;
	nodeVar5 = abs( ( nodeVar2 - nodeVar4 ) );
	nodeVar0.x = max( max( nodeVar5.x, nodeVar5.y ), nodeVar5.z );
	nodeVar6 = textureSample( nodeUniform0, nodeUniform0_sampler, vOffset0.zw );
	nodeVar7 = nodeVar6.xyz;
	nodeVar8 = abs( ( nodeVar2 - nodeVar7 ) );
	nodeVar0.y = max( max( nodeVar8.x, nodeVar8.y ), nodeVar8.z );
	nodeVar9 = step( vec2<f32>( 0.1, 0.1 ), nodeVar0.xy );

	if ( ( dot( nodeVar9, vec2<f32>( 1.0, 1.0 ) ) == 0.0 ) ) {

		discard;
		

	}

	nodeVar10 = textureSample( nodeUniform0, nodeUniform0_sampler, vOffset1.xy );
	nodeVar11 = nodeVar10.xyz;
	nodeVar12 = abs( ( nodeVar2 - nodeVar11 ) );
	nodeVar0.z = max( max( nodeVar12.x, nodeVar12.y ), nodeVar12.z );
	nodeVar13 = textureSample( nodeUniform0, nodeUniform0_sampler, vOffset1.zw );
	nodeVar14 = nodeVar13.xyz;
	nodeVar15 = abs( ( nodeVar2 - nodeVar14 ) );
	nodeVar0.w = max( max( nodeVar15.x, nodeVar15.y ), nodeVar15.z );
	nodeVar16 = max( max( max( nodeVar0.x, nodeVar0.y ), nodeVar0.z ), nodeVar0.w );
	nodeVar17 = textureSample( nodeUniform0, nodeUniform0_sampler, vOffset2.xy );
	nodeVar18 = nodeVar17.xyz;
	nodeVar19 = abs( ( nodeVar2 - nodeVar18 ) );
	nodeVar0.z = max( max( nodeVar19.x, nodeVar19.y ), nodeVar19.z );
	nodeVar20 = textureSample( nodeUniform0, nodeUniform0_sampler, vOffset2.zw );
	nodeVar21 = nodeVar20.xyz;
	nodeVar22 = abs( ( nodeVar2 - nodeVar21 ) );
	nodeVar0.w = max( max( nodeVar22.x, nodeVar22.y ), nodeVar22.z );
	nodeVar9 = ( nodeVar9 * step( vec2<f32>( ( 0.5 * max( max( nodeVar16, nodeVar0.z ), nodeVar0.w ) ) ), nodeVar0.xy ) );

	// result

	output.color = vec4<f32>( nodeVar9, 0.0, 0.0 );

	return output;

}
