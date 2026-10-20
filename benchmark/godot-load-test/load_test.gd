# PRD-117 Godot control arm. A line-for-line port of
# `examples/engine-load-test/src/workload.ts` plus `game.ts`; the two are held together by
# `position_hash`, which the scorer's equivalence gate compares before publishing any comparison.
extends Node3D

const LCG_SEED := 1337
const CUBE_SPACING := 2.5

# PRD-464's realistic-scene ladder. Every constant here is the port of
# `examples/engine-load-test/src/ladder.ts`; the two are held together by the asserted counts the
# report parser checks, so a rung that did not build what it claims fails the run rather than
# publishing a number for a scene this arm never drew.
const LADDER_SHADOW_MAP_SIZE := 2048
const LADDER_POINT_LIGHTS := 8
const LADDER_CHARACTERS := 50
# The Khronos Fox's own clip name. Godot and three both read it out of the glTF unchanged, so the
# two arms play the same clip and neither has to rename it.
const LADDER_CLIP := "Run"
const LADDER_WIDTH := 1280
const LADDER_HEIGHT := 720
const LADDER_HEADLINE_WIDTH := 1920
const LADDER_HEADLINE_HEIGHT := 1080
# `LADDER_TONEMAPPING` in `ladder.ts` is "ACESFilmic", and `LADDER_BLOOM_*` are matched to the same
# band rather than to the same numbers: Godot's glow is three knobs where three's bloom is one node.
const LADDER_BLOOM_INTENSITY := 0.5
const LADDER_BLOOM_THRESHOLD := 0.9
const LADDER_CHARACTER_SIDE := 10
const LADDER_CHARACTER_SPACING := 2.5
const LADDER_CHARACTER_Y := 0.0
# How tall one of R3's characters stands, in metres, and how far a measured height may sit from it.
# The Khronos Fox is authored in centimetres, so an unscaled import is a 79 m statue that fills the
# camera; both engines scale their own import to this height and the parser reads the result back.
const LADDER_FOX_HEIGHT := 0.5
# Where `runGodotDesktop` puts the digest-pinned asset for the duration of the export, so Godot's
# importer builds the rig instead of `GLTFDocument` rebuilding it (and corrupting the heap) at run
# time. Read, never written, by this script.
const FOX_RESOURCE := "res://fox.glb"
# `LADDER_SAMPLE_STRIDE` in `examples/engine-load-test/src/ladder.ts`, where the read-back stats and
# the guard that reads them are defined. A per-pixel walk of a 1920x1080 frame is seconds of engine
# time; a 32k-pixel sample answers the same question.
const LADDER_SAMPLE_STRIDE := 8
# The only key Godot reads a directional shadow map size from. Under `[rendering]` in
# `project.godot`, which is where the 2048 lives.
const SHADOW_MAP_SETTING := "rendering/lights_and_shadows/directional_shadow/size"

var _lcg_state: int = LCG_SEED

var _frames: int = 600
var _warmup: int = 120
var _repeats: int = 3
var _ladder: Array[int] = [256, 1024, 4096, 16384]
var _modes: Array[String] = ["L1", "L2"]
var _refresh_hz: int = 60
var _window_width: int = LADDER_WIDTH
var _window_height: int = LADDER_HEIGHT

var _material: StandardMaterial3D
var _cube_mesh: BoxMesh
var _cubes: Array[MeshInstance3D] = []
var _multimesh_instance: MultiMeshInstance3D = null
var _placements: PackedVector3Array = PackedVector3Array()
var _camera: Camera3D
var _sun: DirectionalLight3D
var _window: Window

# PRD-464's ladder bits, torn down and rebuilt per rung exactly as the TypeScript arm does.
var _point_lights: Array[OmniLight3D] = []
var _characters: Array[Node3D] = []
var _character_players: Array[AnimationPlayer] = []
var _character_staggers: PackedFloat32Array = PackedFloat32Array()
var _character_packed: PackedScene = null
var _fox_bytes: PackedByteArray = PackedByteArray()
var _character_clip_seconds: float = 1.0
var _ladder_post := false
# PRD-464's read-back: taken once per rung, on the last warmup frame, so the frame it stalls the
# GPU for is never a frame the timed window counts. Empty until it arrives, and an empty read-back
# is a failed run rather than an unmeasured one.
var _probed := false
var _render_check: Dictionary = {}
# R3's characters, measured off this engine's own import: the world height one of them came out at
# and the fraction of the viewport it covers. The parser gates both, so a fox that stayed 79 m tall
# fails the run instead of turning the rung into a measurement of overdraw.
var _fox_measurement: Dictionary = {}

var _plan: Array = []
var _plan_index: int = 0
var _frame_index: int = 0
var _mode: String = "L1"
var _object_count: int = 0
var _repeat: int = 0
var _samples: PackedFloat64Array = PackedFloat64Array()
# Godot's Android export stays vsync-paced whatever the project asks for, so the frame interval
# reports the display rather than the engine. TIME_PROCESS is the main-loop CPU time with the swap
# wait excluded, which is what compares against the other arm's script cost.
var _cpu_samples: PackedFloat64Array = PackedFloat64Array()
var _draw_calls: int = 0
var _triangles: int = 0
var _visible_objects: int = 0
var _last_usec: int = 0
var _rungs: Array = []
var _finished := false


func _lcg_reset() -> void:
	_lcg_state = LCG_SEED


# state = (state * 1664525 + 1013904223) mod 2^32 — PRD-117 §3.3, verbatim.
func _lcg_next() -> float:
	_lcg_state = (_lcg_state * 1664525 + 1013904223) % 4294967296
	return float(_lcg_state) / 4294967296.0


func _lattice_side(object_count: int) -> int:
	return maxi(1, int(ceil(sqrt(float(object_count)))))


func _lattice_extent(object_count: int) -> float:
	return float(_lattice_side(object_count)) * CUBE_SPACING


func _create_placements(object_count: int) -> PackedVector3Array:
	_lcg_reset()
	var side := _lattice_side(object_count)
	var half := float(side - 1) / 2.0
	var out := PackedVector3Array()
	out.resize(object_count)
	for index in object_count:
		var grid_x := index % side
		var grid_z := index / side
		var jitter_x := _lcg_next()
		var jitter_z := _lcg_next()
		var jitter_y := _lcg_next()
		out[index] = Vector3(
			(float(grid_x) - half) * CUBE_SPACING + (jitter_x - 0.5) * CUBE_SPACING * 0.6,
			0.5 + jitter_y * 3.0,
			(float(grid_z) - half) * CUBE_SPACING + (jitter_z - 0.5) * CUBE_SPACING * 0.6
		)
	return out


# Quantised to millimetres before hashing, and kept to 32 bits throughout, so the integers agree
# with the TypeScript arm exactly rather than agreeing on how each language prints a float.
func _position_hash(placements: PackedVector3Array) -> String:
	var parts: Array[String] = []
	for index in mini(8, placements.size()):
		var placement := placements[index]
		parts.append(
			"%d,%d,%d" % [
				int(round(placement.x * 1000.0)),
				int(round(placement.y * 1000.0)),
				int(round(placement.z * 1000.0))
			]
		)
	var text := "|".join(parts)
	var value := 2166136261
	for index in text.length():
		value = (value ^ text.unicode_at(index)) & 0xFFFFFFFF
		value = (value * 16777619) & 0xFFFFFFFF
	return "%08x" % value


func _camera_pose(frame_index: int, object_count: int) -> Array:
	var extent := _lattice_extent(object_count)
	var angle := float(frame_index) * 0.0045
	var radius := extent * 0.34
	var position := Vector3(cos(angle) * radius, extent * 0.09 + 4.0, sin(angle) * radius)
	var target := Vector3(
		cos(angle + PI) * extent * 0.12, 1.5, sin(angle + PI) * extent * 0.12
	)
	return [position, target]


func _cube_rotation_x(index: int, frame_index: int) -> float:
	return float(index) * 0.011 + float(frame_index) * 0.013


func _cube_rotation_y(index: int, frame_index: int) -> float:
	return float(index) * 0.017 + float(frame_index) * 0.02


func _cube_bob_y(index: int, frame_index: int, base_y: float) -> float:
	return base_y + sin(float(frame_index) * 0.05 + float(index) * 0.3) * 0.5


# L4's per-cube material, the port of `uniqueMaterialColor` in
# `examples/engine-load-test/src/workload.ts`: red pinned and the index in the other two channels, so
# no two cubes below 2^24 can share an albedo and this arm has nothing to pair two materials on.
# Created with the rung, before its warmup, so the program it compiles lands in the warmup frames.
func _unique_material(index: int) -> StandardMaterial3D:
	var owned := StandardMaterial3D.new()
	owned.albedo_color = Color(
		1.0, float((index >> 16) & 0xff) / 255.0, float(index & 0xff) / 255.0
	)
	owned.roughness = _material.roughness
	owned.metallic = _material.metallic
	return owned


func _read_query() -> Dictionary:
	var query := {}
	var search := ""
	if OS.has_feature("web"):
		search = str(JavaScriptBridge.eval("window.location.search", true))
	else:
		for argument in OS.get_cmdline_user_args():
			if argument.begins_with("--query="):
				search = argument.substr(8)
	if search.begins_with("?"):
		search = search.substr(1)
	for pair in search.split("&", false):
		var halves := pair.split("=", true, 1)
		if halves.size() == 2:
			# The runner builds this query with `URLSearchParams`, so a value is percent-encoded —
			# and R3's Fox path is an absolute one, which is nothing but slashes and escapes.
			query[halves[0].uri_decode()] = halves[1].uri_decode()
	return query


func _ready() -> void:
	Engine.max_fps = 0
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	# Before anything reads it. `_ready` aborted on a null `_window` once, and the window that
	# resulted was a flat clear colour: no light, no camera, no cubes, nothing to explain it.
	_window = get_window()

	var query := _read_query()
	if query.has("frames"):
		_frames = int(query["frames"])
	if query.has("warmup"):
		_warmup = int(query["warmup"])
	if query.has("repeats"):
		_repeats = int(query["repeats"])
	if query.has("refreshHz"):
		_refresh_hz = int(query["refreshHz"])
	if query.has("ladder"):
		_ladder = []
		for part in str(query["ladder"]).split(",", false):
			_ladder.append(int(part))
	if query.has("modes"):
		_modes = []
		for part in str(query["modes"]).split(",", false):
			_modes.append(str(part))
	# The window the run was given, which is also the resolution this rung draws at: the runner runs
	# R1-R4 in a 1280x720 window and R5 in a 1920x1080 one, and `_ladder_counts` reads the viewport
	# back rather than restating either. A window that came up at another size fails the rung's
	# asserted resolution instead of being reported as the one that was asked for.
	if query.has("width") and query.has("height"):
		_window_width = int(query["width"])
		_window_height = int(query["height"])
		_window.size = Vector2i(_window_width, _window_height)
	if query.has("fox"):
		_load_fox(str(query["fox"]))

	# One shared lit material for ground and cubes, one directional light, no shadows (§3.1).
	_material = StandardMaterial3D.new()
	_material.albedo_color = Color(0.722, 0.769, 0.800)
	_material.roughness = 0.75
	_material.metallic = 0.0
	_cube_mesh = BoxMesh.new()
	_cube_mesh.size = Vector3.ONE

	var ground := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(200, 200)
	ground.mesh = plane
	ground.material_override = _material
	# A receiver, not a caster, in every rung: the asserted `shadowCasters` count has to mean the
	# same thing here as it does in the ThreeNative arm, where `castShadow` is false by default.
	ground.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(ground)

	var light := DirectionalLight3D.new()
	# three's physical lights divide diffuse by pi and Godot's do not, so the same 2.4 is a 3x brighter
	# sun here; dividing by pi is what makes the two arms light the same scene the same way.
	light.light_energy = 2.4 / PI
	light.shadow_enabled = false
	light.look_at_from_position(Vector3(40, 80, 25), Vector3.ZERO, Vector3.UP)
	add_child(light)
	_sun = light

	# The ThreeNative page draws on #0b0f14 behind a transparent canvas; Godot's default is mid grey.
	RenderingServer.set_default_clear_color(Color(0.043, 0.059, 0.078))

	_camera = Camera3D.new()
	_camera.fov = 60.0
	_camera.near = 0.1
	_camera.far = 4000.0
	_camera.current = true
	add_child(_camera)

	for object_count in _ladder:
		for mode in _modes:
			for repeat in _repeats:
				_plan.append({"count": object_count, "mode": mode, "repeat": repeat})
	_begin_rung()


func _clear_rung() -> void:
	for cube in _cubes:
		remove_child(cube)
		cube.queue_free()
	_cubes.clear()
	if _multimesh_instance != null:
		remove_child(_multimesh_instance)
		_multimesh_instance.queue_free()
		_multimesh_instance = null
	_clear_ladder()


# The port of `pointLightPosition` in `examples/engine-load-test/src/ladder.ts`: a pure function of
# the light index and the frame index, never of elapsed time.
func _point_light_position(index: int, frame_index: int, extent: float) -> Vector3:
	var angle := float(frame_index) * 0.01 + (float(index) / float(LADDER_POINT_LIGHTS)) * TAU
	return Vector3(
		cos(angle) * extent * 0.3, 6.0 + sin(angle * 1.7) * 2.0, sin(angle) * extent * 0.3
	)


# The port of `characterPlacement`: a 10x5 block on the ground among the cubes, inside the sun's
# frustum and inside the camera's orbit, so the skinning is a submitted cost and not a culled one.
func _character_position(index: int) -> Vector3:
	return Vector3(
		(float(index % LADDER_CHARACTER_SIDE) - (LADDER_CHARACTER_SIDE - 1) / 2.0)
		* LADDER_CHARACTER_SPACING,
		LADDER_CHARACTER_Y,
		(float(index / LADDER_CHARACTER_SIDE) - 2.0) * LADDER_CHARACTER_SPACING
	)


# The combined AABB of every mesh under `node`, in world space. A skinned rig's bones are not
# meshes, so this is the fox's geometry and not its skeleton — the same box three's `Box3` reports.
func _mesh_bounds(node: Node) -> AABB:
	var bounds := AABB()
	var found := false
	var stack: Array[Node] = [node]
	while not stack.is_empty():
		var current: Node = stack.pop_back()
		if current is MeshInstance3D and (current as MeshInstance3D).mesh != null:
			var world := (current as MeshInstance3D).global_transform * (current as MeshInstance3D).get_aabb()
			if not found:
				bounds = world
				found = true
			else:
				bounds = bounds.merge(world)
		for child in current.get_children():
			stack.append(child)
	return bounds if found else AABB()


# The factor that turns this engine's import of the fox into a `LADDER_FOX_HEIGHT` character, read
# off the instance's own bind-pose bounds. Measured rather than assumed because the two engines
# import the same bytes differently, and a hardcoded constant would hide exactly that.
func _fox_scale(character: Node3D) -> float:
	var bounds := _mesh_bounds(character)
	if bounds.size.y <= 0.0:
		print("TN_BENCH_FOX_EMPTY_BOUNDS")
		get_tree().quit(1)
		return 1.0
	return LADDER_FOX_HEIGHT / bounds.size.y


# The first character's world height and its share of the viewport, measured at the camera's live
# pose at the frame the rung is read on. `unproject_position` is the same projection three's
# `Vector3.project` performs, so the two arms' screen fractions are comparable numbers.
func _measure_fox() -> void:
	if _characters.is_empty():
		return
	var bounds := _mesh_bounds(_characters[0])
	var size := get_viewport().get_visible_rect().size
	var centre := bounds.get_center()
	var top := _camera.unproject_position(Vector3(centre.x, bounds.end.y, centre.z))
	var bottom := _camera.unproject_position(Vector3(centre.x, bounds.position.y, centre.z))
	_fox_measurement = {
		"heightM": bounds.size.y,
		"screenFraction": absf(top.y - bottom.y) / size.y,
	}


func _clear_ladder() -> void:
	for point in _point_lights:
		remove_child(point)
		point.queue_free()
	_point_lights.clear()
	for character in _characters:
		remove_child(character)
	_characters.clear()
	# The rigs are detached, never freed: the run has already reported by the time this runs, and a
	# teardown that frees 50 glTF rigs is a teardown that can take the report with it. They cost a
	# few MB each and the process exits seconds later. The cubes and the WorldEnvironment are freed.
	_character_players.clear()
	_character_staggers = PackedFloat32Array()
	if _ladder_post:
		for child in get_children():
			if child is WorldEnvironment:
				remove_child(child)
				child.queue_free()
	_ladder_post = false
	_sun.shadow_enabled = false


# The Khronos Fox, loaded through Godot's own importer rather than through `GLTFDocument` at
# runtime. The runner copies the digest-pinned file to `res://fox.glb` before the export, so the
# importer — the same path any game loading a glTF takes — is what builds the rig.
#
# `GLTFDocument` was the first attempt and it is unusable here: reading this file at runtime
# corrupted the heap in this Godot build, non-deterministically, in 4 of 5 runs ("corrupted size vs.
# prev_size", SIGABRT) *after* the report had been printed — so the arm published nothing and the
# run died with the answer in a stdout buffer abort() never flushes. Copying the asset into the
# project and letting the importer handle it is 5 runs out of 5 clean, and it is the path a game
# would take anyway. A missing asset stops the run here rather than at R3, where the first
# `ladder.skinnedMeshes` assertion would fail with a message about counts instead of about the file.
func _load_fox(path: String) -> void:
	if not FileAccess.file_exists(path):
		print("TN_BENCH_FOX_MISSING:", path)
		get_tree().quit(1)
		return
	if FileAccess.get_file_as_bytes(path).is_empty():
		print("TN_BENCH_FOX_EMPTY:", path)
		get_tree().quit(1)
		return
	var resource := ResourceLoader.load(FOX_RESOURCE, "", ResourceLoader.CACHE_MODE_IGNORE)
	_character_packed = resource as PackedScene
	if _character_packed == null:
		print("TN_BENCH_FOX_PARSE_FAILED")
		get_tree().quit(1)
		return
	# Validated on a throwaway instance, not on the run's characters: the clip has to exist and the
	# rig has to carry a skin, or R3 is 50 frozen meshes and a `skinnedMeshes` count that means
	# nothing. `CACHE_MODE_IGNORE` above is what keeps this probe from becoming one of the 50.
	var probe := _character_packed.instantiate() as Node3D
	if probe == null or not probe.has_node("AnimationPlayer"):
		print("TN_BENCH_FOX_CLIP_MISSING")
		get_tree().quit(1)
		return
	var player := probe.get_node("AnimationPlayer") as AnimationPlayer
	if not player.has_animation(LADDER_CLIP):
		print("TN_BENCH_FOX_CLIP_MISSING")
		get_tree().quit(1)
		return
	_character_clip_seconds = player.get_animation(LADDER_CLIP).length
	probe.free()


# R1's sun, R2's local lights, R3's characters, R4's post chain and R5's resolution, each added only
# when the rung above it is the one being built — the same order the ThreeNative arm builds in.
func _apply_ladder(mode: String) -> void:
	var rank := int(mode.substr(1)) - 1
	var extent := _lattice_extent(_object_count)
	_sun.shadow_enabled = true
	_sun.directional_shadow_max_distance = extent * 2.0 + 100.0
	# The map size itself is a project setting, declared 2048 in `project.godot` to match the
	# ThreeNative arm. Godot reads a shadow map size from nowhere else, and setting it from here
	# instead would re-allocate the shadow atlas mid-run — a setup cost the other arm never pays.
	# Read back rather than assumed: a project.godot edit that let this fall to the 4096 default
	# would make R1 a comparison of two resolutions rather than of two renderers.
	if int(ProjectSettings.get_setting(SHADOW_MAP_SETTING, 0)) != LADDER_SHADOW_MAP_SIZE:
		print("TN_BENCH_SHADOW_MAP_SIZE:", ProjectSettings.get_setting(SHADOW_MAP_SETTING, 0))
		get_tree().quit(1)
		return
	if rank >= 1:
		for index in LADDER_POINT_LIGHTS:
			var point := OmniLight3D.new()
			point.light_energy = 1.2 / PI
			point.shadow_enabled = false
			point.position = _point_light_position(index, 0, extent)
			add_child(point)
			_point_lights.append(point)
	if rank >= 2:
		if _character_packed == null:
			print("TN_BENCH_FOX_CLIP_MISSING")
			get_tree().quit(1)
			return
		var fox_scale := 1.0
		for index in LADDER_CHARACTERS:
			var character := _character_packed.instantiate() as Node3D
			character.position = _character_position(index)
			add_child(character)
			# One scale for the whole crowd, measured off the first instance before it is posed. The
			# Khronos Fox is authored in centimetres and Godot imports those units literally, so an
			# unscaled character is a 79 m statue; the same rule and the same number as
			# `foxScale` in `ladder.ts` bring both engines to a 0.5 m fox.
			if index == 0:
				fox_scale = _fox_scale(character)
			character.scale = Vector3.ONE * fox_scale
			var player := _find_animation_player(character)
			if player == null or not player.has_animation(LADDER_CLIP):
				print("TN_BENCH_FOX_CLIP_MISSING")
				get_tree().quit(1)
				return
			player.play(LADDER_CLIP)
			_characters.append(character)
			_character_players.append(player)
			_character_staggers.append((float(index) / float(LADDER_CHARACTERS)) * _character_clip_seconds)
	if rank >= 3:
		var environment := Environment.new()
		environment.background_mode = Environment.BG_COLOR
		environment.background_color = ProjectSettings.get_setting(
			"rendering/environment/defaults/default_clear_color"
		)
		# No ambient: an Environment that exists defaults to taking ambient from its own background,
		# which would light the scene a second way and make R4 a different scene from R3.
		environment.ambient_light_source = Environment.AMBIENT_SOURCE_DISABLED
		environment.tonemap_mode = Environment.TONE_MAPPER_ACES
		environment.glow_enabled = true
		environment.glow_blend_mode = Environment.GLOW_BLEND_MODE_ADDITIVE
		environment.glow_intensity = LADDER_BLOOM_INTENSITY
		environment.glow_bloom = 0.2
		environment.glow_hdr_threshold = LADDER_BLOOM_THRESHOLD
		var world := WorldEnvironment.new()
		world.environment = environment
		add_child(world)
		_ladder_post = true


func _find_animation_player(node: Node) -> AnimationPlayer:
	if node is AnimationPlayer:
		return node as AnimationPlayer
	for child in node.get_children():
		var found := _find_animation_player(child)
		if found != null:
			return found
	return null


# The asserted counts, read off the built scene exactly as the ThreeNative arm reads them off its
# own, so the report parser's comparison means the same thing on both sides. The resolution is the
# viewport's, read back rather than restated from the rung's name: a window that came up at another
# size fails the rung's asserted resolution instead of being published as the one that was asked for.
func _ladder_counts() -> Dictionary:
	# `ImporterMeshInstance3D` is what a glTF skin arrives as; a `MeshInstance3D` covers the cubes.
	# Counts are returned rather than accumulated into captured locals because a GDScript lambda
	# captures by value, and a census that always reads zero is exactly the bug that hides.
	var census := _census(self)
	var size := get_viewport().get_visible_rect().size
	return {
		"pointLights": _point_lights.size(),
		"postPasses": 1 if _ladder_post else 0,
		"resolution": "%dx%d" % [size.x, size.y],
		"shadowCasters": census.x,
		"skinnedMeshes": census.y,
		"tonemapping": 1 if _ladder_post else 0,
	}


# x = shadow casters, y = skinned meshes. A caster is a mesh that casts, which is the same
# definition the ThreeNative census uses on `isMesh && castShadow`; a fox's 24 joint nodes are not
# casters in either engine. Godot 4.7 carries the skin on `MeshInstance3D` itself — a glTF skin
# arrives as an ordinary mesh instance with a `Skin`, not as the old `ImporterMeshInstance3D`.
func _census(node: Node) -> Vector2i:
	var counts := Vector2i.ZERO
	if node is MeshInstance3D:
		if node.cast_shadow == GeometryInstance3D.SHADOW_CASTING_SETTING_ON:
			counts.x += 1
		if node.skin != null:
			counts.y += 1
	for child in node.get_children():
		counts += _census(child)
	return counts


# The read-back is a real GPU→CPU copy on this renderer, and `TN_BENCH_NO_PROBE=1` is the switch
# that A/B'd it against an empty rung. It is a diagnostic switch, not a way to publish a run: a
# ladder rung with no read-back fails the parser's gate.
func _probe_enabled() -> bool:
	return OS.get_environment("TN_BENCH_NO_PROBE") != "1"


# What the rung actually drew, in the shape `frameStats` computes in
# `examples/engine-load-test/src/ladder.ts` and `blankFrameReason` in `scripts/capture-guard.ts`
# decides on. Awaiting `frame_post_draw` is what makes it the frame just submitted rather than the
# one before it; a read inside `_process` without it returns the previous frame, and on the first
# frame there is no previous one, so a rung would report an empty image over a scene that drew.
func _probe_frame() -> void:
	await RenderingServer.frame_post_draw
	# Duplicated, and walked a frame later: walking the viewport's own image inside the post-draw
	# signal, while the render server still owns the buffer behind it, corrupted the heap on the
	# way out (glibc "corrupted size vs. prev_size") and cost the run its report. The copy is the
	# pixels; the walk is arithmetic over a buffer nothing else writes to.
	var image: Image = get_viewport().get_texture().get_image().duplicate()
	# Diagnostic only: `TN_BENCH_SHOT=<file.png>` keeps the frame the rung just drew, for a human to look at.
	if OS.get_environment("TN_BENCH_SHOT") != "":
		image.save_png(OS.get_environment("TN_BENCH_SHOT"))
	var width := image.get_width()
	var height := image.get_height()
	var colors := {}
	var luminance_total := 0.0
	var luminance_squared_total := 0.0
	var max_luminance := 0.0
	var sampled := 0
	var y := 0
	while y < height:
		var x := 0
		while x < width:
			var color := image.get_pixel(x, y)
			colors[
				(
					(roundi(color.r * 255.0) << 24)
					| (roundi(color.g * 255.0) << 16)
					| (roundi(color.b * 255.0) << 8)
					| roundi(color.a * 255.0)
				)
			] = true
			if color.a > 0.0:
				var luminance := 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
				sampled += 1
				max_luminance = maxf(max_luminance, luminance)
				luminance_total += luminance
				luminance_squared_total += luminance * luminance
			x += LADDER_SAMPLE_STRIDE
		y += LADDER_SAMPLE_STRIDE
	var mean := 0.0 if sampled == 0 else luminance_total / float(sampled)
	_render_check = {
		"distinctColors": colors.size(),
		"luminanceStdDev": sqrt(
			maxf(0.0, 0.0 if sampled == 0 else luminance_squared_total / float(sampled) - mean * mean)
		),
		"maxLuminance": max_luminance,
		"sampledPixels": sampled,
	}


func _begin_rung() -> void:
	_clear_rung()
	var entry: Dictionary = _plan[_plan_index]
	_mode = str(entry["mode"])
	_object_count = int(entry["count"])
	_repeat = int(entry["repeat"])
	_placements = _create_placements(_object_count)
	_frame_index = 0
	_samples = PackedFloat64Array()
	_cpu_samples = PackedFloat64Array()
	_draw_calls = 0
	_triangles = 0
	_visible_objects = 0

	# R1-R5 are L1's authoring with real-game costs on top, so the cubes are one MeshInstance3D
	# each here exactly as they are in L1 — never the L2 batch.
	if _mode == "L1" or _mode == "L4" or _mode.begins_with("R"):
		for index in _object_count:
			var cube := MeshInstance3D.new()
			cube.mesh = _cube_mesh
			# L4 owns one material resource per cube, so this arm cannot fold the lattice into fewer
			# draws the way it does for L1's single shared material.
			cube.material_override = _unique_material(index) if _mode == "L4" else _material
			cube.position = _placements[index]
			add_child(cube)
			_cubes.append(cube)
	elif _object_count > 0:
		var multimesh := MultiMesh.new()
		multimesh.transform_format = MultiMesh.TRANSFORM_3D
		multimesh.mesh = _cube_mesh
		multimesh.instance_count = _object_count
		_multimesh_instance = MultiMeshInstance3D.new()
		_multimesh_instance.multimesh = multimesh
		_multimesh_instance.material_override = _material
		# The batch is one cull unit on both engines; a derived bounding volume would make the
		# cull, not the batch, the thing being measured.
		var span := _lattice_extent(_object_count)
		_multimesh_instance.custom_aabb = AABB(
			Vector3(-span, -span, -span), Vector3(span * 2.0, span * 2.0, span * 2.0)
		)
		add_child(_multimesh_instance)
	if _mode.begins_with("R"):
		_apply_ladder(_mode)
		_probed = false
		_render_check = {}
		_fox_measurement = {}
	_last_usec = Time.get_ticks_usec()


func _step(frame_index: int) -> void:
	var pose := _camera_pose(frame_index, _object_count)
	_camera.position = pose[0]
	_camera.look_at(pose[1], Vector3.UP)
	# R2's lights and R3's characters, both pure functions of the frame index, so the two engines
	# frame the same scene at frame 317.
	if not _point_lights.is_empty():
		var extent := _lattice_extent(_object_count)
		for index in _point_lights.size():
			(_point_lights[index] as OmniLight3D).position = _point_light_position(
				index, frame_index, extent
			)
	for index in _character_players.size():
		(_character_players[index] as AnimationPlayer).seek(
			_character_staggers[index] + float(frame_index) / 60.0, true
		)
	# 100% dirty transforms every frame — the honest worst case a game with moving actors pays.
	if _mode == "L1" or _mode == "L4" or _mode.begins_with("R"):
		for index in _cubes.size():
			var placement := _placements[index]
			var basis := Basis.from_euler(
				Vector3(_cube_rotation_x(index, frame_index), _cube_rotation_y(index, frame_index), 0.0)
			)
			_cubes[index].transform = Transform3D(
				basis,
				Vector3(placement.x, _cube_bob_y(index, frame_index, placement.y), placement.z)
			)
		return
	if _multimesh_instance == null:
		return
	var multimesh := _multimesh_instance.multimesh
	for index in _placements.size():
		var placement := _placements[index]
		var basis := Basis.from_euler(
			Vector3(_cube_rotation_x(index, frame_index), _cube_rotation_y(index, frame_index), 0.0)
		)
		multimesh.set_instance_transform(
			index,
			Transform3D(
				basis,
				Vector3(placement.x, _cube_bob_y(index, frame_index, placement.y), placement.z)
			)
		)


func _process(_delta: float) -> void:
	if _finished:
		return
	var now := Time.get_ticks_usec()
	var interval_ms := float(now - _last_usec) / 1000.0
	_last_usec = now

	if _frame_index > 0 and _frame_index > _warmup:
		_samples.append(snappedf(interval_ms, 0.001))
		_cpu_samples.append(
			snappedf(Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0, 0.001)
		)
		# `_process` reports the frame that just ended, so the sample lands one call later than
		# the TypeScript arm's mid-run index in order to describe the same frame.
		if _frame_index == (_frames + _warmup) / 2 + 1:
			_draw_calls = int(
				RenderingServer.get_rendering_info(
					RenderingServer.RENDERING_INFO_TOTAL_DRAW_CALLS_IN_FRAME
				)
			)
			_triangles = int(
				RenderingServer.get_rendering_info(
					RenderingServer.RENDERING_INFO_TOTAL_PRIMITIVES_IN_FRAME
				)
			)
			_visible_objects = int(
				RenderingServer.get_rendering_info(
					RenderingServer.RENDERING_INFO_TOTAL_OBJECTS_IN_FRAME
				)
			)
			# The fox, at the live camera pose and on the same frame as the counters, so a rung
			# reporting counts but not a character size is a failed rung rather than a fast one.
			_measure_fox()

	# The rung's own read-back, on the last warmup frame: after the shader work has settled and
	# before the timed window opens, so the frame the read-back stalls the GPU for is not one this
	# rung is measured on. A ladder rung with no read-back when it finishes is a failed run.
	if _probe_enabled() and _mode.begins_with("R") and not _probed and _frame_index == _warmup:
		_probed = true
		_probe_frame()

	if _frame_index >= _frames:
		_finish_rung()
		return
	_step(_frame_index)
	_frame_index += 1


func _finish_rung() -> void:
	var rung := {
		"drawCalls": _draw_calls,
		"frameMs": Array(_samples),
		"cpuMs": Array(_cpu_samples),
		"mode": _mode,
		"objectCount": _object_count,
		"positionHash": _position_hash(_placements),
		"repeat": _repeat,
		"triangles": _triangles,
		"visibleObjects": _visible_objects,
	}
	# Only on a realistic-scene rung, and only once the read-back has arrived. The parser refuses a
	# ladder block on an L rung, so an empty one written onto L1 would fail the cube scoreboard this
	# arm also serves, and a missing one fails the ladder's own gate rather than passing it.
	if _mode.begins_with("R"):
		rung["ladder"] = _ladder_counts()
		if not _fox_measurement.is_empty():
			rung["foxMeasurement"] = _fox_measurement
		if not _render_check.is_empty():
			rung["renderCheck"] = _render_check
	# The existing viewport read-back, after the last measured draw; PNG transport is persisted by the runner.
	var frame_image: Image = get_viewport().get_texture().get_image().duplicate()
	frame_image.convert(Image.FORMAT_RGBA8)
	var source: Image = frame_image.duplicate()
	frame_image.resize(160, 90, Image.INTERPOLATE_NEAREST)
	# Image.resize has no box filter: replace the resized pixels with area-weighted RGBA means.
	var scale_x := source.get_width() / 160.0
	var scale_y := source.get_height() / 90.0
	for y in range(90):
		var top := y * scale_y
		var bottom := (y + 1) * scale_y
		for x in range(160):
			var left := x * scale_x
			var right := (x + 1) * scale_x
			var total := Color(0, 0, 0, 0)
			for sy in range(floori(top), ceili(bottom)):
				for sx in range(floori(left), ceili(right)):
					var weight := (minf(bottom, sy + 1) - maxf(top, sy)) * (minf(right, sx + 1) - maxf(left, sx))
					total += source.get_pixel(sx, sy) * weight
			frame_image.set_pixel(x, y, total / (scale_x * scale_y))
	rung["framePng"] = Marshalls.raw_to_base64(frame_image.save_png_to_buffer())
	_rungs.append(rung)
	_plan_index += 1
	if _plan_index >= _plan.size():
		_emit_report()
		return
	_begin_rung()


# The arm is read from the running platform, never passed in: a desktop binary labelled as the
# phone arm would be published as device evidence.
func _arm_name() -> String:
	if OS.has_feature("web"):
		return "godot-web"
	if OS.get_name() == "Android":
		return "godot-android"
	return "godot-desktop"


func _emit_report() -> void:
	_finished = true
	_clear_rung()
	# Let the `queue_free()`s above actually run before the tree quits. Quitting with nodes still
	# queued leaves the renderer's pages alive, and the process then died in its own teardown with
	# stdout half-flushed — a report that arrived truncated rather than a crash anyone could read.
	await get_tree().process_frame
	var version: Dictionary = Engine.get_version_info()
	var report := {
		"arm": _arm_name(),
		"build": {
			"notes": "godot export, rendering method read from the engine at runtime",
			"type": "debug" if OS.is_debug_build() else "release",
		},
		"device": {"battery": null, "label": OS.get_name() + " " + OS.get_model_name()},
		"display": {
			# The window the run was given, not the viewport a rung drew into: R1-R4 render at
			# 1280x720 inside it, and the per-rung `ladder.resolution` is the field that says so.
			"height": _window_height,
			"refreshHz": _refresh_hz,
			"vsync": false,
			"width": _window_width,
		},
		"driver": {
			"adapter": (
				RenderingServer.get_video_adapter_name()
				+ " / "
				+ RenderingServer.get_video_adapter_api_version()
			),
			"renderer": (
				RenderingServer.get_current_rendering_method()
				+ " / "
				+ RenderingServer.get_current_rendering_driver_name()
			),
		},
		"engine": {"name": "godot", "version": str(version["string"])},
		"rungs": _rungs,
	}
	var payload := JSON.stringify(report)
	if OS.has_feature("web"):
		JavaScriptBridge.eval(
			"window.__ENGINE_LOAD_TEST__ = JSON.parse(" + JSON.stringify(payload) + ");", true
		)
	else:
		# Android's logcat truncates a line at ~1 KB, so the payload goes out in chunks the
		# collector rejoins. A single print looks fine on desktop and silently loses the phone run.
		print("ENGINE_LOAD_TEST_JSON_BEGIN")
		var offset := 0
		while offset < payload.length():
			print("TNJSON:", payload.substr(offset, 800))
			offset += 800
		print("ENGINE_LOAD_TEST_JSON_END")
		get_tree().quit()
