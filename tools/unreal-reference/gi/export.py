"""Unreal side of the PRD-638 GI calibration scenes.

build_level.py loads this module when TN_UE_SCENE names a scene in gi/scenes.json, and passes its
own helpers in `ref`. Modes:

  build    author gi/<scene>/scene.py in an empty level: Geometry Script boxes, glTF proxy
           materials, Unreal light actors, one unbound post-process volume with a fixed EV100.
           A second level holds the same boxes in flat region-ID colours. Then export scene.glb
           with the glTF exporter and write scene.json from the actors read back from the level.
  capture  one Movie Render Queue job per (pose, kind) for the variant in TN_UE_VARIANT, with
           TN_UE_WARMUP render warm-up frames (default 90). Every job prints the variant's expect
           console variables from its start commands, so capture.ts reads the GI level back from
           the editor log.

Unreal is the source of truth: scene.json holds what the level reports, not what scene.py asked for.
The proxy materials (/GLTFExporter/Materials/Proxy/M_GLTF_Default) are the exporter's own, so their
factors reach scene.glb unchanged. This file holds no Unreal code; it drives the editor through its
Python API.
"""

import importlib.util
import json
import math
import os

import unreal

GI = os.path.dirname(os.path.abspath(__file__))
REGISTRY = json.load(open(os.path.join(GI, "scenes.json")))
PROXY = "/GLTFExporter/Materials/Proxy/M_GLTF_Default"
# Region IDs are unlit: with lighting off, the lit proxy still adds its rough specular albedo, so a
# 0 channel arrives as 112 in the ID frame (Unreal 5.8.3, Substrate).
UNLIT_PROXY = "/GLTFExporter/Materials/Proxy/M_GLTF_Unlit"
# Region-ID colours, sRGB8, given out in box order. Black is the background ("Sky" in compare.ts).
ID_COLORS = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255],
    [255, 128, 0], [128, 0, 255], [0, 128, 64], [128, 255, 128], [64, 0, 128], [128, 128, 128],
]
mel = unreal.MaterialEditingLibrary


def load_scene(name):
    if name not in [s["name"] for s in REGISTRY["scenes"]]:
        raise ValueError(f"scene {name} is not registered in gi/scenes.json")
    spec = importlib.util.spec_from_file_location(f"tn_gi_{name}", os.path.join(GI, name, "scene.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SCENE


def root(name):
    return f"/Game/GI/{name}"


# --- build -------------------------------------------------------------------
def material(ref, folder, name, values, proxy=PROXY):
    mi = ref.asset_tools.create_asset(name, folder, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
    mel.set_material_instance_parent(mi, unreal.load_asset(proxy))
    r, g, b = values["baseColor"]
    mel.set_material_instance_vector_parameter_value(mi, "Base Color Factor", unreal.LinearColor(r, g, b, 1.0))
    mel.set_material_instance_scalar_parameter_value(mi, "Roughness Factor", values["roughness"])
    mel.set_material_instance_scalar_parameter_value(mi, "Metallic Factor", values["metallic"])
    if "emissive" in values:
        r, g, b = values["emissive"]
        mel.set_material_instance_vector_parameter_value(mi, "Emissive Factor", unreal.LinearColor(r, g, b, 1.0))
        mel.set_material_instance_scalar_parameter_value(mi, "Emissive Strength", values.get("emissiveStrength", 1.0))
    mel.update_material_instance(mi)
    unreal.EditorAssetLibrary.save_loaded_asset(mi)
    return mi


def box_mesh(folder, box):
    sx, sy, sz = box["size"]
    mesh = unreal.DynamicMesh()
    # Unreal X, Y, Z = three.js x, z, y, in centimetres.
    unreal.GeometryScript_Primitives.append_box(
        mesh, unreal.GeometryScriptPrimitiveOptions(), unreal.Transform(),
        sx * 100.0, sz * 100.0, sy * 100.0, 0, 0, 0, unreal.GeometryScriptPrimitiveOriginMode.CENTER,
    )
    result = unreal.GeometryScript_NewAssetUtils.create_new_static_mesh_asset_from_mesh(
        mesh, f"{folder}/SM_{box['name']}", unreal.GeometryScriptCreateNewStaticMeshAssetOptions()
    )
    asset = result[0] if isinstance(result, tuple) else result
    if not isinstance(asset, unreal.StaticMesh):
        raise RuntimeError(f"Geometry Script made no static mesh for {box['name']}: {result}")
    unreal.EditorAssetLibrary.save_loaded_asset(asset)
    return asset


def spawn_light(ref, light):
    classes = {"PointLight": unreal.PointLight, "SpotLight": unreal.SpotLight, "RectLight": unreal.RectLight}
    if light["class"] not in classes:
        raise ValueError(f"light {light['name']}: unknown class {light['class']}")
    actor = ref.actor_subsystem.spawn_actor_from_class(classes[light["class"]], ref.to_unreal(light["position"]))
    actor.set_actor_label(light["name"])
    actor.root_component.set_mobility(unreal.ComponentMobility.MOVABLE)
    component = actor.get_component_by_class(unreal.LocalLightComponent)
    units = {"lumens": unreal.LightUnits.LUMENS, "candelas": unreal.LightUnits.CANDELAS}
    component.set_editor_property("intensity_units", units[light["units"]])
    component.set_editor_property("intensity", light["intensity"])
    component.set_editor_property("attenuation_radius", light["attenuationRadiusM"] * 100.0)
    component.set_editor_property("use_temperature", False)
    r, g, b = light["color"]
    component.set_editor_property("light_color", unreal.Color(r=round(r * 255), g=round(g * 255), b=round(b * 255), a=255))
    component.set_editor_property("cast_shadows", light["castShadows"])
    if light["class"] != "RectLight":
        component.set_editor_property("source_radius", light["sourceRadiusM"] * 100.0)


def exposure_volume(ref, ev100):
    volume = ref.actor_subsystem.spawn_actor_from_class(unreal.PostProcessVolume, unreal.Vector(0, 0, 0))
    volume.set_actor_label("Exposure")
    volume.set_editor_property("unbound", True)
    settings = volume.get_editor_property("settings")
    # Manual exposure without the physical camera, biased by -EV100: a surface of L nits reads
    # L x 2^-EV100 (PostProcessEyeAdaptation.cpp, CalculateManualAutoExposure; measured, scene.json).
    settings.set_editor_property("override_auto_exposure_method", True)
    settings.set_editor_property("auto_exposure_method", unreal.AutoExposureMethod.AEM_MANUAL)
    settings.set_editor_property("override_auto_exposure_apply_physical_camera_exposure", True)
    settings.set_editor_property("auto_exposure_apply_physical_camera_exposure", False)
    settings.set_editor_property("override_auto_exposure_bias", True)
    settings.set_editor_property("auto_exposure_bias", -float(ev100))
    volume.set_editor_property("settings", settings)
    return volume


def build_level(ref, path, scene, meshes, materials, lights):
    if not ref.level_subsystem.new_level(path):
        raise RuntimeError("new_level failed for " + path)
    actors = []
    for box in scene["boxes"]:
        actor = ref.actor_subsystem.spawn_actor_from_object(
            meshes[box["name"]], ref.to_unreal(box["position"]),
            unreal.Rotator(roll=0.0, pitch=0.0, yaw=-box.get("rotationYDeg", 0.0)),
        )
        actor.set_actor_label(box["name"])
        actor.static_mesh_component.set_material(0, materials[box["name"]])
        actors.append(actor)
    if lights:
        for light in scene["lights"]:
            spawn_light(ref, light)
    exposure_volume(ref, scene["ev100"])
    ref.level_subsystem.save_current_level()
    return actors


def build(ref, name):
    scene = load_scene(name)
    if scene.get("sky") or scene.get("sun") or scene.get("fog"):
        raise ValueError(f"scene {name}: sky, sun and fog are not authored yet (PRD-638 Phase 2)")
    if len(scene["boxes"]) > len(ID_COLORS):
        raise ValueError(f"scene {name}: more boxes than region-ID colours")
    base = root(name)
    named = {m: material(ref, f"{base}/Materials", f"MI_{m}", v) for m, v in scene["materials"].items()}
    regions = {box["name"]: ID_COLORS[i] for i, box in enumerate(scene["boxes"])}
    # Linear base colour id/255: Unreal display-encodes it, and compare.ts accepts both forms.
    ids = {
        b: material(ref, f"{base}/Materials", f"MI_ID_{b}", {"baseColor": [c / 255.0 for c in rgb], "roughness": 1.0, "metallic": 0.0}, UNLIT_PROXY)
        for b, rgb in regions.items()
    }
    meshes = {box["name"]: box_mesh(f"{base}/Meshes", box) for box in scene["boxes"]}
    build_level(ref, f"{base}/GI_{name}_id", scene, meshes, ids, False)
    actors = build_level(ref, f"{base}/GI_{name}", scene, meshes, {b["name"]: named[b["material"]] for b in scene["boxes"]}, True)
    write_json(name, describe_level(ref, name, scene, regions))
    export_glb(name, actors)
    ref.build_cameras(scene["poses"], base)
    ref.level_subsystem.save_all_dirty_levels()
    ref.log(f"gi build done scene={name}")


def export_glb(name, actors):
    options = unreal.GLTFExportOptions()
    options.set_editor_property("export_lights", False)  # scene.json is the authority for lights
    options.set_editor_property("export_cameras", False)
    options.set_editor_property("export_proxy_materials", True)
    options.set_editor_property("skip_near_default_values", False)
    options.set_editor_property("bake_material_inputs", unreal.GLTFMaterialBakeMode.DISABLED)
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    result = unreal.GLTFExporter.export_to_gltf(world, os.path.join(GI, name, "scene.glb"), options, set(actors))
    ok = result[0] if isinstance(result, tuple) else result
    if not ok:
        raise RuntimeError(f"glTF export failed for {name}: {result}")


# --- scene.json: read back from the level ------------------------------------------------
def to_three(v):
    return [round(v.x / 100.0, 6), round(v.z / 100.0, 6), round(v.y / 100.0, 6)]


def describe_level(ref, name, scene, regions):
    meshes, lights, exposure = [], [], None
    for actor in ref.actor_subsystem.get_all_level_actors():
        label, cls = actor.get_actor_label(), actor.get_class().get_name()
        if cls == "StaticMeshActor":
            rot = actor.get_actor_rotation()
            if abs(rot.pitch) > 1e-3 or abs(rot.roll) > 1e-3:
                raise ValueError(f"{label}: only rotation about the vertical axis is exported")
            component = actor.static_mesh_component
            box = component.static_mesh.get_bounding_box()
            mi = component.get_material(0)
            meshes.append({
                "name": label,
                "class": cls,
                "position": to_three(actor.get_actor_location()),
                "rotationYDeg": round(-rot.yaw, 6),
                "size": to_three(unreal.Vector(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)),
                "material": material_values(mi),
            })
        elif cls in ("PointLight", "SpotLight", "RectLight"):
            c = actor.get_component_by_class(unreal.LocalLightComponent)
            color = c.get_editor_property("light_color")
            light = {
                "name": label,
                "class": cls,
                "position": to_three(actor.get_actor_location()),
                "intensity": c.get_editor_property("intensity"),
                "units": enum_name(c.get_editor_property("intensity_units")),
                "attenuationRadiusM": c.get_editor_property("attenuation_radius") / 100.0,
                "color": [color.r / 255.0, color.g / 255.0, color.b / 255.0],
                "useTemperature": c.get_editor_property("use_temperature"),
                "castShadows": c.get_editor_property("cast_shadows"),
                "inverseSquaredFalloff": c.get_editor_property("use_inverse_squared_falloff"),
            }
            if cls != "RectLight":
                light["sourceRadiusM"] = c.get_editor_property("source_radius") / 100.0
            lights.append(light)
        elif cls == "PostProcessVolume":
            s = actor.get_editor_property("settings")
            bias = s.get_editor_property("auto_exposure_bias")
            lens = unreal.SystemLibrary.get_console_variable_float_value("r.EyeAdaptation.LensAttenuation")
            exposure = {
                "method": enum_name(s.get_editor_property("auto_exposure_method")),
                "physicalCamera": s.get_editor_property("auto_exposure_apply_physical_camera_exposure"),
                "bias": bias,
                "ev100": -bias,
                "lensAttenuation": lens,
                # Measured on cornell L1 (EV100 3 and 5, scene-linear EXR): a lit surface of L nits
                # reads L x 2^-EV100 at the default lens attenuation of 0.78, so the 0.18 of
                # GetEyeAdaptationFixedExposure cancels against the meter's mid-grey. The lens
                # attenuation scales the saturation luminance (LuminanceMaxFromLensAttenuation).
                "exposureScale": 2.0 ** bias * lens / 0.78,
            }
    return {
        "note": f"Written by gi/export.py from the Unreal 5.8.3 level GI_{name}. three.js frame: Y up, metres. Unreal is the authority; scene.py is only the authoring input.",
        "scene": name,
        "resolution": REGISTRY["resolution"],
        "meshes": meshes,
        "lights": lights,
        "sky": None,
        "sun": None,
        "fog": None,
        "exposure": exposure,
        "poses": scene["poses"],
        "regions": regions,
    }


def enum_name(value):
    # str() of an Unreal enum is "<LightUnits.LUMENS: 2>"; .name is "LUMENS".
    return value.name.lower()


def material_values(mi):
    def vector(param):
        c = mel.get_material_instance_vector_parameter_value(mi, param)
        return [round(c.r, 6), round(c.g, 6), round(c.b, 6)]

    return {
        "name": mi.get_name(),
        "baseColor": vector("Base Color Factor"),
        "roughness": round(mel.get_material_instance_scalar_parameter_value(mi, "Roughness Factor"), 6),
        "metallic": round(mel.get_material_instance_scalar_parameter_value(mi, "Metallic Factor"), 6),
        "emissive": vector("Emissive Factor"),
        "emissiveStrength": round(mel.get_material_instance_scalar_parameter_value(mi, "Emissive Strength"), 6),
    }


def write_json(name, value):
    with open(os.path.join(GI, name, "scene.json"), "w") as f:
        json.dump(value, f, indent=2)
        f.write("\n")


# --- capture -----------------------------------------------------------------
def capture(ref, name, out):
    scene = load_scene(name)
    variant = next((v for v in REGISTRY["variants"] if v["name"] == os.environ.get("TN_UE_VARIANT")), None)
    if variant is None:
        raise ValueError(f"unknown TN_UE_VARIANT {os.environ.get('TN_UE_VARIANT')}")
    layer = next(l for l in ref.LAYERS if l["name"] == variant["layer"])
    warm_up = int(os.environ.get("TN_UE_WARMUP", "90"))
    run = int(os.environ.get("TN_UE_RUN", "1"))
    # Same naming as folderName() in scripts/unreal-look/gi.ts.
    folder = variant["name"] + ("" if warm_up == 90 else f"@{warm_up}") + ("" if run == 1 else f"#{run}")
    level = f"{root(name)}/GI_{name}" + ("_id" if variant.get("level") == "id" else "")
    cvars = dict(layer["cvars"], **variant["cvars"])
    queue = ref.queue()
    count = 0
    for pose in scene["poses"]:
        for kind in variant["kinds"]:
            ref.add_job(
                queue, pose["name"], level, f"{root(name)}/Sequences/Seq_{pose['name']}",
                os.path.join(out, name, folder), cvars, layer["showFlags"], kind, warm_up,
                list(variant["expect"]),
            )
            count += 1
    ref.log(f"gi capture scene={name} variant={folder} queued={count}")
    ref.render()
