WGSLDUMP vertex_SMAANode.edges
// Three.js r185 - Node System

// directives


// structs


// uniforms

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

struct objectStruct {
	nodeUniform1 : mat4x4<f32>,
	nodeUniform3 : vec2<f32>
};
@binding( 2 ) @group( 1 )
var<uniform> object : objectStruct;

// varyings

struct VaryingsStruct {
	@location( 0 ) nodeVarying4 : vec2<f32>,
	@location( 1 ) vOffset0 : vec4<f32>,
	@location( 2 ) vOffset1 : vec4<f32>,
	@location( 3 ) vOffset2 : vec4<f32>,
	@builtin( position ) builtinClipSpace : vec4<f32>
};
var<private> varyings : VaryingsStruct;

// vars
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar23 : vec4<f32>;
var<private> v_modelViewProjection : vec4<f32>;
var<private> v_positionView : vec3<f32>;
var<private> positionLocal : vec3<f32>;
var<private> VERTEX_v_modelViewProjection : vec4<f32>;

// codes


@vertex
fn main( @location( 0 ) uv : vec2<f32>,
	@location( 1 ) position : vec3<f32> ) -> VaryingsStruct {

	// flow
	// code

	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform1 );
	varyings.nodeVarying4 = uv;
	varyings.vOffset0 = ( vec4<f32>( uv, uv ) + ( vec4<f32>( object.nodeUniform3, object.nodeUniform3 ) * vec4<f32>( -1.0, 0.0, 0.0, -1.0 ) ) );
	varyings.vOffset1 = ( vec4<f32>( uv, uv ) + ( vec4<f32>( object.nodeUniform3, object.nodeUniform3 ) * vec4<f32>( 1.0, 0.0, 0.0, 1.0 ) ) );
	varyings.vOffset2 = ( vec4<f32>( uv, uv ) + ( vec4<f32>( object.nodeUniform3, object.nodeUniform3 ) * vec4<f32>( -2.0, 0.0, 0.0, -2.0 ) ) );
	positionLocal = position;
	v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	VERTEX_nodeVar23 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar23;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
