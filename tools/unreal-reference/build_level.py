"""Unreal side of the PRD-631 reference capture.

Run by `pnpm unreal-look:capture --engine unreal`, which starts the editor as
  UnrealEditor <ThreeNativeReference.uproject> -RenderOffscreen -unattended
    -ExecutePythonScript=build_level.py
and passes the work through environment variables:

  TN_UE_MODE    check-cvars | build | capture
  TN_UE_OUT     output folder (captures, template-actors.json, cvar report)
  TN_UE_LAYERS  comma-separated layer names for capture (default: all)
  TN_UE_CELLS   optional comma-separated "sun/pose" filter for capture

build: one level per sun elevation, each from the editor's own default level
template (/Engine/Maps/Templates/Template_Default), so the lighting actors keep
the values a user gets. The template floor is deleted, scene.glb is imported
and placed, and one unbounded post-process volume with no overrides is added.
Every lighting actor's values go to template-actors.json.

capture: one Movie Render Queue job per (layer, sun, pose) and output kind
(PNG with the tone curve, EXR with the tone curve disabled). The layer's
console variables are set through the job's console-variable setting.

This file holds no Unreal code; it drives the editor through its Python API.
"""

import json
import math
import os
import traceback

import unreal

HERE = os.path.dirname(os.path.abspath(__file__))
MODE = os.environ.get("TN_UE_MODE", "build")
OUT = os.environ.get("TN_UE_OUT", os.path.join(HERE, "captures", "unreal"))
TEMPLATE_MAP = "/Engine/Maps/Templates/Template_Default"
ROOT = "/Game/Reference"

POSES = json.load(open(os.path.join(HERE, "poses.json")))
LAYERS = json.load(open(os.path.join(HERE, "layers.json")))["layers"]

asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
level_subsystem = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


def log(message):
    unreal.log("TNREF " + message)


def quit_editor(code=0):
    with open(os.path.join(OUT, f"{MODE}.exit"), "w") as f:
        f.write(str(code))
    unreal.SystemLibrary.quit_editor()


# --- coordinates -------------------------------------------------------------
# three.js: Y up, right-handed, metres. Unreal: Z up, left-handed, centimetres.
# The build log prints each imported mesh's bounds (TNREF probe lines), and the
# L0 silhouette IoU in compare.ts proves the mapping.
def to_unreal(p):
    x, y, z = p
    return unreal.Vector(-z * 100.0, x * 100.0, y * 100.0)


def look_rotation(position, target):
    a, b = to_unreal(position), to_unreal(target)
    d = unreal.Vector(b.x - a.x, b.y - a.y, b.z - a.z)
    yaw = math.degrees(math.atan2(d.y, d.x))
    pitch = math.degrees(math.atan2(d.z, math.hypot(d.x, d.y)))
    return unreal.Rotator(roll=0.0, pitch=pitch, yaw=yaw)


def sun_rotation(sun):
    el, az = math.radians(sun["elevationDeg"]), math.radians(sun["azimuthDeg"])
    to_sun = (math.sin(az) * math.cos(el), math.sin(el), math.cos(az) * math.cos(el))
    # A directional light shines along its forward vector, away from the sun.
    return look_rotation(to_sun, (0.0, 0.0, 0.0))


# --- build -------------------------------------------------------------------
def import_scene(filename, folder):
    task = unreal.AssetImportTask()
    task.filename = os.path.join(HERE, filename)
    task.destination_path = f"{ROOT}/{folder}"
    task.automated = True
    task.replace_existing = True
    task.save = True
    asset_tools.import_asset_tasks([task])
    paths = [str(p) for p in task.imported_object_paths]
    log("imported " + json.dumps(paths))
    return [unreal.load_asset(p) for p in paths]


def describe(actor):
    """The lighting values a layer PRD reads as its starting point."""
    out = {"class": actor.get_class().get_name(), "label": actor.get_actor_label()}
    loc, rot = actor.get_actor_location(), actor.get_actor_rotation()
    out["location"] = [loc.x, loc.y, loc.z]
    out["rotation"] = {"pitch": rot.pitch, "yaw": rot.yaw, "roll": rot.roll}
    for component in actor.get_components_by_class(unreal.ActorComponent):
        values = {}
        for prop in COMPONENT_PROPS.get(component.get_class().get_name(), []):
            try:
                value = component.get_editor_property(prop)
            except Exception as error:  # a renamed property is reported, not hidden
                value = f"<unreadable: {error}>"
            values[prop] = plain(value)
        if values:
            out[component.get_class().get_name()] = values
    return out


def plain(value):
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    if isinstance(value, unreal.LinearColor):
        return [value.r, value.g, value.b, value.a]
    if isinstance(value, unreal.Color):
        return [value.r, value.g, value.b, value.a]
    if isinstance(value, unreal.Vector):
        return [value.x, value.y, value.z]
    if isinstance(value, unreal.EnumBase):
        return str(value)
    if isinstance(value, unreal.Object):
        return value.get_path_name()
    return str(value)


COMPONENT_PROPS = {
    "DirectionalLightComponent": [
        "intensity", "light_color", "temperature", "use_temperature", "light_source_angle",
        "light_source_soft_angle", "atmosphere_sun_light", "atmosphere_sun_light_index",
        "cast_shadows", "dynamic_shadow_distance_movable_light", "contact_shadow_length",
        "indirect_lighting_intensity", "volumetric_scattering_intensity", "cast_cloud_shadows",
        "mobility",
    ],
    "SkyLightComponent": [
        "intensity", "light_color", "real_time_capture", "source_type", "cubemap_resolution",
        "lower_hemisphere_is_black", "lower_hemisphere_color", "sky_distance_threshold",
        "indirect_lighting_intensity", "volumetric_scattering_intensity", "mobility",
    ],
    "SkyAtmosphereComponent": [
        "bottom_radius", "atmosphere_height", "ground_albedo", "multi_scattering_factor",
        "rayleigh_scattering_scale", "rayleigh_scattering", "rayleigh_exponential_distribution",
        "mie_scattering_scale", "mie_scattering", "mie_absorption_scale", "mie_absorption",
        "mie_anisotropy", "mie_exponential_distribution", "other_absorption_scale",
        "other_absorption", "sky_luminance_factor", "aerial_pespective_view_distance_scale",
        "height_fog_contribution", "transform_mode",
    ],
    "ExponentialHeightFogComponent": [
        "fog_density", "fog_height_falloff", "fog_inscattering_luminance", "fog_max_opacity",
        "start_distance", "volumetric_fog", "volumetric_fog_scattering_distribution",
        "volumetric_fog_albedo", "volumetric_fog_extinction_scale", "volumetric_fog_distance",
        "directional_inscattering_luminance", "second_fog_data",
    ],
    "VolumetricCloudComponent": [
        "layer_bottom_altitude", "layer_height", "tracing_start_max_distance",
        "tracing_max_distance", "planet_radius", "ground_albedo", "material",
    ],
}


def build_level(name, sun, meshes):
    path = f"{ROOT}/Ref_{name}"
    if not level_subsystem.new_level_from_template(path, TEMPLATE_MAP):
        raise RuntimeError("new_level_from_template failed for " + path)
    actors = actor_subsystem.get_all_level_actors()
    lighting = []
    for actor in actors:
        name = actor.get_class().get_name()
        if name == "StaticMeshActor":
            log("delete template floor " + actor.get_actor_label())
            actor_subsystem.destroy_actor(actor)
        elif name == "DirectionalLight":
            actor.set_actor_rotation(sun_rotation(sun), False)
            lighting.append(actor)
        elif name in ("SkyLight", "SkyAtmosphere", "ExponentialHeightFog", "VolumetricCloud"):
            lighting.append(actor)
    for mesh in meshes:
        if isinstance(mesh, unreal.StaticMesh):
            actor = actor_subsystem.spawn_actor_from_object(mesh, unreal.Vector(0, 0, 0))
            actor.set_actor_label(mesh.get_name())
            box = mesh.get_bounding_box()
            log(f"probe {mesh.get_name()} min={box.min} max={box.max}")
    volume = actor_subsystem.spawn_actor_from_class(unreal.PostProcessVolume, unreal.Vector(0, 0, 0))
    volume.set_editor_property("unbound", True)
    level_subsystem.save_current_level()
    return [describe(a) for a in lighting]


def build_cameras():
    for pose in POSES["poses"]:
        camera = actor_subsystem.spawn_actor_from_class(
            unreal.CameraActor, to_unreal(pose["position"]), look_rotation(pose["position"], pose["target"])
        )
        camera.set_actor_label("Cam_" + pose["name"])
        component = camera.get_editor_property("camera_component")
        component.set_editor_property("field_of_view", pose["hfovDeg"])
        width, height = POSES["resolution"]
        component.set_editor_property("aspect_ratio", width / height)
        component.set_editor_property("constrain_aspect_ratio", False)
        sequence = asset_tools.create_asset(
            "Seq_" + pose["name"], ROOT + "/Sequences", unreal.LevelSequence, unreal.LevelSequenceFactoryNew()
        )
        sequence.set_display_rate(unreal.FrameRate(30, 1))
        sequence.set_playback_start(0)
        sequence.set_playback_end(1)
        binding = sequence.add_spawnable_from_instance(camera)
        cut = sequence.add_track(unreal.MovieSceneCameraCutTrack)
        section = cut.add_section()
        section.set_range(0, 1)
        section.set_camera_binding_id(sequence.get_binding_id(binding))
        unreal.EditorAssetLibrary.save_loaded_asset(sequence)
        actor_subsystem.destroy_actor(camera)


def build():
    meshes = import_scene("scene.glb", "Scene")
    actors = {}
    for sun in POSES["suns"]:
        actors[sun["name"]] = build_level(sun["name"], sun, meshes)
    # The region-id level: flat colours, rendered with the L0 switches as the mask source.
    build_level("id", POSES["suns"][0], import_scene("scene-id.glb", "SceneId"))
    build_cameras()
    level_subsystem.save_all_dirty_levels()
    with open(os.path.join(HERE, "template-actors.json"), "w") as f:
        json.dump(
            {
                "note": "Written by build_level.py (build) from /Engine/Maps/Templates/Template_Default on Unreal 5.8.3. Unreal units: lux for the directional light, cm for distances.",
                "levels": actors,
            },
            f,
            indent=2,
        )
        f.write("\n")
    log("build done")


# --- check-cvars ---------------------------------------------------------------
def check_cvars():
    names = sorted({n for layer in LAYERS for n in layer["cvars"]} | {"ShowFlag." + n for layer in LAYERS for n in layer["showFlags"]})
    missing = []
    for name in names:
        if not unreal.SystemLibrary.get_console_variable_int_value(name) and not cvar_exists(name):
            missing.append(name)
    with open(os.path.join(OUT, "cvars.json"), "w") as f:
        json.dump({"checked": names, "missing": missing}, f, indent=2)
    log(f"check-cvars checked={len(names)} missing={missing}")
    return 1 if missing else 0


def cvar_exists(name):
    # A missing console variable reads back as zero for every type; probe by writing
    # a value through the console and reading it back, then restore it.
    before = unreal.SystemLibrary.get_console_variable_float_value(name)
    unreal.SystemLibrary.execute_console_command(None, f"{name} 1")
    exists = unreal.SystemLibrary.get_console_variable_float_value(name) == 1.0
    unreal.SystemLibrary.execute_console_command(None, f"{name} {before:g}")
    return exists


# --- capture -----------------------------------------------------------------
def cells():
    wanted = set(filter(None, os.environ.get("TN_UE_CELLS", "").split(",")))
    layer_names = set(filter(None, os.environ.get("TN_UE_LAYERS", "").split(",")))
    for layer in LAYERS:
        if layer_names and layer["name"] not in layer_names:
            continue
        for sun in POSES["suns"]:
            for pose in POSES["poses"]:
                if wanted and f"{sun['name']}/{pose['name']}" not in wanted:
                    continue
                yield layer, sun, pose
    if not layer_names or "ID" in layer_names:
        id_layer = dict(LAYERS[0], name="ID")
        for pose in POSES["poses"]:
            yield id_layer, {"name": "id"}, pose


def add_job(queue, layer, sun, pose, kind):
    job = queue.allocate_new_job(unreal.MoviePipelineExecutorJob)
    job.map = unreal.SoftObjectPath(f"{ROOT}/Ref_{sun['name']}")
    job.sequence = unreal.SoftObjectPath(f"{ROOT}/Sequences/Seq_{pose['name']}")
    job.job_name = f"ID_{pose['name']}" if layer["name"] == "ID" else f"{layer['name']}_{sun['name']}_{pose['name']}"
    config = job.get_configuration()
    output = config.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
    output.output_directory = unreal.DirectoryPath(os.path.join(OUT, layer["name"]))
    output.file_name_format = "{job_name}"
    width, height = POSES["resolution"]
    output.output_resolution = unreal.IntPoint(width, height)
    output.override_existing_output = True
    deferred = config.find_or_add_setting_by_class(unreal.MoviePipelineDeferredPassBase)
    if kind == "exr":
        deferred.disable_tone_curve = True
        config.find_or_add_setting_by_class(unreal.MoviePipelineImageSequenceOutput_EXR)
    else:
        config.find_or_add_setting_by_class(unreal.MoviePipelineImageSequenceOutput_PNG)
    aa = config.find_or_add_setting_by_class(unreal.MoviePipelineAntiAliasingSetting)
    aa.override_anti_aliasing = False
    aa.render_warm_up_frames = True
    # Lumen, the virtual shadow maps and TSR settle in about 2 s; eye adaptation
    # (L9) needs about 10 s of game time at 1 stop/s darkening.
    aa.engine_warm_up_count = 30
    aa.render_warm_up_count = 300 if layer["cvars"].get("r.DefaultFeature.AutoExposure") else 90
    cvars = config.find_or_add_setting_by_class(unreal.MoviePipelineConsoleVariableSetting)
    for name, value in layer["cvars"].items():
        cvars.add_or_update_console_variable(name, float(value))
    for name, value in layer["showFlags"].items():
        cvars.add_or_update_console_variable("ShowFlag." + name, float(value))


def capture():
    subsystem = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    queue = subsystem.get_queue()
    queue.delete_all_jobs()
    count = 0
    for layer, sun, pose in cells():
        for kind in ("png",) if layer["name"] == "ID" else ("png", "exr"):
            add_job(queue, layer, sun, pose, kind)
            count += 1
    log(f"capture queued={count}")
    executor = subsystem.render_queue_with_executor(unreal.MoviePipelinePIEExecutor)

    def finished(executor_, success):
        log(f"capture finished success={success}")
        quit_editor(0 if success else 1)

    executor.on_executor_finished_delegate.add_callable_unique(finished)


# --- entry -------------------------------------------------------------------
os.makedirs(OUT, exist_ok=True)
try:
    if MODE == "check-cvars":
        quit_editor(check_cvars())
    elif MODE == "build":
        build()
        quit_editor(0)
    elif MODE == "capture":
        capture()
    else:
        raise ValueError("unknown TN_UE_MODE " + MODE)
except Exception:
    log("failed\n" + traceback.format_exc())
    quit_editor(1)
