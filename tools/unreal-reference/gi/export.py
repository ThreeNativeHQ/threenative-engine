"""Unreal side of the PRD-638 GI calibration scenes.

build_level.py loads this module when TN_UE_SCENE names a scene in gi/scenes.json, and passes its
own helpers in `ref`. Modes:

  build    author gi/<scene>/scene.py in an empty level: Geometry Script boxes, glTF proxy
           materials, Unreal light actors, one unbound post-process volume with a fixed EV100.
           A second level holds the same boxes in flat region-ID colours. Then export scene.glb
           with the glTF exporter and write scene.json from the actors read back from the level.
  capture  one Movie Render Queue job per (pose, kind) for the variant in TN_UE_VARIANT, with
           TN_UE_WARMUP render warm-up frames (default 180). Every job prints the variant's expect
           console variables from its start commands, so capture.ts reads the GI level back from
           the editor log.

PRD-638 motion: a scene may carry a "motion" record in scene.py (runs of 30 frames a second: a pan, a light
that switches). build also writes one Level Sequence per run (Seq_motion_<run>, a camera-only Seq_motion_<run>_id
when the run keys a light, and one 1-frame Seq_motion_<run>_still_<frame> per still), and capture with
TN_UE_MOTION=<run> renders them: <run>.NNNN.png for every frame and still-NNNN.0000.png for every still, into
<out>/<scene>/motion/<run>/<variant>/.

PRD-649: a `shadow:<name>` scene lives in ../shadow/<name>/ with ../shadow/scenes.json. A scene with
"template": "default" is lit by Unreal's default level (Template_Default): one level per entry of
"suns", the template floor deleted, the boxes added, and an unbound post-process volume with no
overrides, as build_level.py builds the PRD-631 reference. Its poses run once per sun.

A box may be a card ("kind": "card"): a zero-thickness quad, standing upright, that several actors share
as one static mesh ("mesh"). A material may be masked ("alphaMode": "MASK") and two-sided with a texture
(PRD-651 leaf cards): the glTF exporter writes it as alphaMode MASK, doubleSided and a base colour texture.
A box names a "region" to share its region-ID colour with a group of cards (`Leaves`).

A scene may place real assets ("glbs": instances of GLB files, PRD-651 wildwood). Unreal's own glTF importer
reads each decoded GLB that scripts/unreal-look/wildwood.ts prepared (TN_WILDWOOD_FILES), the lit materials are
rebuilt on the exporter's glTF master as Masked and two-sided where the glTF says so, and no scene.glb is exported:
the files are licensed Fab art and are read from the asset root by both engines.

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
FAMILIES = {"gi": GI, "shadow": os.path.join(os.path.dirname(GI), "shadow")}
PROXY = "/GLTFExporter/Materials/Proxy/M_GLTF_Default"
# Region IDs are unlit: with lighting off, the lit proxy still adds its rough specular albedo, so a
# 0 channel arrives as 112 in the ID frame (Unreal 5.8.3, Substrate).
UNLIT_PROXY = "/GLTFExporter/Materials/Proxy/M_GLTF_Unlit"
# Region-ID colours, sRGB8, given out in box order. Black is the background ("Sky" in compare.ts).
ID_COLORS = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255],
    [255, 128, 0], [128, 0, 255], [0, 128, 64], [128, 255, 128], [64, 0, 128], [128, 128, 128],
    [192, 64, 0], [128, 0, 0], [0, 0, 128], [128, 128, 0], [255, 128, 192], [0, 192, 255],
]
mel = unreal.MaterialEditingLibrary


def split(name):
    """`cornell` or `gi:cornell` -> ("gi", "cornell"); `shadow:penumbra-lab` -> ("shadow", "penumbra-lab")."""
    family, _, short = name.rpartition(":")
    return family or "gi", short


def scene_dir(name):
    family, short = split(name)
    return os.path.join(FAMILIES[family], short)


def registry(name):
    return json.load(open(os.path.join(FAMILIES[split(name)[0]], "scenes.json")))


def out_key(name):
    """The capture folder, as sceneKey() in scripts/unreal-look/gi.ts: `cornell` or `shadow/<name>`."""
    family, short = split(name)
    return short if family == "gi" else f"{family}/{short}"


def load_scene(name):
    family, short = split(name)
    if short not in [s["name"] for s in registry(name)["scenes"]]:
        raise ValueError(f"scene {name} is not registered in {family}/scenes.json")
    spec = importlib.util.spec_from_file_location(f"tn_{family}_{short}", os.path.join(scene_dir(name), "scene.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SCENE


def root(name):
    family, short = split(name)
    return f"/Game/{'GI' if family == 'gi' else family.capitalize()}/{short}"


def level_path(name, suffix=""):
    return f"{root(name)}/GI_{split(name)[1]}{suffix}"


def poses_of(scene):
    """A template-lit scene runs each pose once per sun, as `<sun>-<pose>`; other scenes as authored.

    A pose may carry `perSun`: {sun name: values that replace the pose's own for that sun}, for a camera
    that must stand elsewhere when the shadows fall elsewhere (the foliage canopy at a 15 degree sun).
    """
    if scene.get("template") != "default":
        return scene["poses"]
    return [
        dict(
            {k: v for k, v in p.items() if k != "perSun"},
            **p.get("perSun", {}).get(s["name"], {}),
            name=f"{s['name']}-{p['name']}",
            sun=s["name"],
        )
        for s in scene["suns"]
        for p in scene["poses"]
    ]


# --- build -------------------------------------------------------------------
def import_texture(ref, folder, path):
    """A mask texture (PRD-651): imported uncompressed, clamped and with a plain box mip chain, so a mask keeps its edge."""
    task = unreal.AssetImportTask()
    task.filename = path
    task.destination_path = folder
    task.automated = True
    task.replace_existing = True
    task.save = False
    ref.asset_tools.import_asset_tasks([task])
    texture = unreal.load_asset(str(task.imported_object_paths[0]))
    if not isinstance(texture, unreal.Texture2D):
        raise RuntimeError(f"{path}: import made no texture ({task.imported_object_paths})")
    texture.set_editor_property("compression_settings", unreal.TextureCompressionSettings.TC_EDITOR_ICON)
    texture.set_editor_property("mip_gen_settings", unreal.TextureMipGenSettings.TMGS_SIMPLE_AVERAGE)
    texture.set_editor_property("address_x", unreal.TextureAddress.TA_CLAMP)
    texture.set_editor_property("address_y", unreal.TextureAddress.TA_CLAMP)
    texture.set_editor_property("never_stream", True)
    unreal.EditorAssetLibrary.save_loaded_asset(texture)
    return texture


def set_two_sided(mi, two_sided):
    overrides = mi.get_editor_property("base_property_overrides")
    overrides.set_editor_property("override_two_sided", True)
    overrides.set_editor_property("two_sided", two_sided)
    mi.set_editor_property("base_property_overrides", overrides)


def set_masked(mi, values):
    """Masked blend, a clip value and the two-sided flag, as base property overrides on the instance."""
    overrides = mi.get_editor_property("base_property_overrides")
    overrides.set_editor_property("override_blend_mode", True)
    overrides.set_editor_property("blend_mode", unreal.BlendMode.BLEND_MASKED)
    overrides.set_editor_property("override_opacity_mask_clip_value", True)
    overrides.set_editor_property("opacity_mask_clip_value", values["alphaCutoff"])
    mi.set_editor_property("base_property_overrides", overrides)
    set_two_sided(mi, values["doubleSided"])


def texture(ref, folder, name, path):
    """Imports an image file beside scene.py as an sRGB Texture2D (PRD-639: a material's albedo texels)."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"texture {name}: {path} is missing")
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", path)
    task.set_editor_property("destination_path", folder)
    task.set_editor_property("destination_name", name)
    task.set_editor_property("replace_existing", True)
    task.set_editor_property("automated", True)
    task.set_editor_property("save", True)
    ref.asset_tools.import_asset_tasks([task])
    asset = unreal.load_asset(f"{folder}/{name}")
    if not isinstance(asset, unreal.Texture2D):
        raise RuntimeError(f"texture {name}: the import made no Texture2D from {path}")
    return asset


def material(ref, folder, name, values, proxy=PROXY, textures=None):
    mi = ref.asset_tools.create_asset(name, folder, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
    mel.set_material_instance_parent(mi, unreal.load_asset(proxy))
    if "baseColorTexture" in values:
        # The proxy's "Base Color Texture" multiplies "Base Color Factor", as glTF's baseColorTexture does.
        mel.set_material_instance_texture_parameter_value(mi, "Base Color Texture", (textures or {})[values["baseColorTexture"]])
    r, g, b = values["baseColor"]
    mel.set_material_instance_vector_parameter_value(mi, "Base Color Factor", unreal.LinearColor(r, g, b, 1.0))
    if "texture" in values:
        mel.set_material_instance_texture_parameter_value(mi, "Base Color Texture", textures[values["texture"]])
    if values.get("alphaMode") == "MASK":
        set_masked(mi, values)
    mel.set_material_instance_scalar_parameter_value(mi, "Roughness Factor", values["roughness"])
    mel.set_material_instance_scalar_parameter_value(mi, "Metallic Factor", values["metallic"])
    if "emissive" in values:
        r, g, b = values["emissive"]
        mel.set_material_instance_vector_parameter_value(mi, "Emissive Factor", unreal.LinearColor(r, g, b, 1.0))
        mel.set_material_instance_scalar_parameter_value(mi, "Emissive Strength", values.get("emissiveStrength", 1.0))
    mel.update_material_instance(mi)
    unreal.EditorAssetLibrary.save_loaded_asset(mi)
    return mi


def mesh_key(box):
    """The static mesh a box uses: its own, or the one its card kind shares (`Leaf`)."""
    return box.get("mesh", box["name"])


def region_of(box):
    """The region a box belongs to: a card group shares one (`Leaves`), any other box is its own."""
    return box.get("region", box["name"])


def box_mesh(folder, box):
    sx, sy, sz = box["size"]
    mesh = unreal.DynamicMesh()
    if box.get("kind") == "card":
        if sz != 0:
            raise ValueError(f"card {box['name']}: a card has no thickness, size z must be 0")
        # A quad that stands upright, as the three.js XY plane does: width along X, height along Z. The
        # rectangle lies in XY, and a quarter turn about X stands it up. The turn is +90 so that the top
        # of the texture (V = 0) is the top of the card: with -90 the leaves hung upside down (measured, ID frame).
        unreal.GeometryScript_Primitives.append_rectangle_xy(
            mesh, unreal.GeometryScriptPrimitiveOptions(),
            unreal.Transform(unreal.Vector(0, 0, 0), unreal.Rotator(roll=90.0, pitch=0.0, yaw=0.0), unreal.Vector(1, 1, 1)),
            sx * 100.0, sy * 100.0, 0, 0,
        )
    else:
        # Unreal X, Y, Z = three.js x, z, y, in centimetres.
        unreal.GeometryScript_Primitives.append_box(
            mesh, unreal.GeometryScriptPrimitiveOptions(), unreal.Transform(),
            sx * 100.0, sz * 100.0, sy * 100.0, 0, 0, 0, unreal.GeometryScriptPrimitiveOriginMode.CENTER,
        )
    result = unreal.GeometryScript_NewAssetUtils.create_new_static_mesh_asset_from_mesh(
        mesh, f"{folder}/SM_{mesh_key(box)}", unreal.GeometryScriptCreateNewStaticMeshAssetOptions()
    )
    asset = result[0] if isinstance(result, tuple) else result
    if not isinstance(asset, unreal.StaticMesh):
        raise RuntimeError(f"Geometry Script made no static mesh for {box['name']}: {result}")
    unreal.EditorAssetLibrary.save_loaded_asset(asset)
    return asset


# --- real assets (PRD-651 wildwood) ------------------------------------------------------------------
def glb_files():
    """The decoded GLBs the TypeScript half prepared: TN_WILDWOOD_FILES holds one `<asset>=<path>` line each."""
    files = dict(line.split("=", 1) for line in os.environ.get("TN_WILDWOOD_FILES", "").splitlines() if line)
    if not files:
        raise ValueError("TN_WILDWOOD_FILES is empty: build through `pnpm unreal-look:capture`, which verifies the asset root")
    return files


def import_glb(ref, folder, name, path):
    """Unreal's own glTF import (Interchange) of one decoded GLB. Returns its one static mesh."""
    task = unreal.AssetImportTask()
    for key, value in (("filename", path), ("destination_path", f"{folder}/{name}"), ("automated", True),
                       ("replace_existing", True), ("replace_existing_settings", True), ("save", True)):
        task.set_editor_property(key, value)
    ref.asset_tools.import_asset_tasks([task])
    meshes = [a for a in (unreal.load_asset(str(p)) for p in task.imported_object_paths) if isinstance(a, unreal.StaticMesh)]
    if len(meshes) != 1:
        raise RuntimeError(f"{path}: the import made {len(meshes)} static meshes, expected 1 ({list(task.imported_object_paths)})")
    mesh = meshes[0]
    # Nanite off. Interchange builds Nanite by default (bBuildNanite = true, Engine/Plugins/Interchange/Runtime/Source/
    # Pipelines/Public/InterchangeGenericMeshPipeline.h:134), and Nanite drew without the branch stub of GreenTree_1
    # (647 px, PRD-649). A calibration scene needs the same geometry in both engines, so this is the named override.
    settings = mesh.get_editor_property("nanite_settings")
    settings.set_editor_property("enabled", False)
    mesh.set_editor_property("nanite_settings", settings)
    unreal.EditorAssetLibrary.save_loaded_asset(mesh)
    return mesh


def parameter_table(values):
    return {str(p.get_editor_property("parameter_info").get_editor_property("name")): p.get_editor_property("parameter_value") for p in values}


def read_instance(mi):
    """The glTF values Interchange stored on an imported material instance: scalars, textures, vectors, two-sided."""
    overrides = mi.get_editor_property("base_property_overrides")
    return (
        parameter_table(mi.get_editor_property("scalar_parameter_values")),
        parameter_table(mi.get_editor_property("texture_parameter_values")),
        parameter_table(mi.get_editor_property("vector_parameter_values")),
        bool(overrides.get_editor_property("override_two_sided") and overrides.get_editor_property("two_sided")),
    )


def glb_slot_material(ref, folder, name, source):
    """One imported slot rebuilt on the exporter's glTF master, as the glTF says (PRD-651).

    Interchange's own master draws a masked glTF material through Substrate translucency (blend mode
    translucent coloured transmittance): sorted, no depth write, no cut shadow. A leaf card is alpha tested, so
    the slot keeps Interchange's textures and factors and draws Masked with the glTF alphaCutoff, on both faces
    when the glTF says double sided. Returns (material, base colour texture, alphaMode, cutoff, double sided).
    """
    scalars, textures, vectors, two_sided = read_instance(source)
    base = textures.get("BaseColorTexture")
    if base is None:
        raise ValueError(f"{source.get_name()}: no base colour texture")
    masked = scalars.get("AlphaMode", 0.0) == 1.0
    if scalars.get("AlphaMode", 0.0) == 2.0:
        raise ValueError(f"{source.get_name()}: only opaque and masked glTF materials are rebuilt, this one blends")
    tint = vectors.get("BaseColorFactor", unreal.LinearColor(1.0, 1.0, 1.0, 1.0))
    values = {
        "baseColor": [tint.r, tint.g, tint.b], "baseColorTexture": "base",
        # glTF defaults (2.0 spec, section 5.22): a factor the file leaves out is 1.
        "roughness": scalars.get("RoughnessFactor", 1.0), "metallic": scalars.get("MetallicFactor", 1.0),
    }
    if masked:
        values.update(alphaMode="MASK", alphaCutoff=scalars.get("AlphaCutoff", 0.5), doubleSided=two_sided)
    mi = material(ref, folder, name, values, textures={"base": base})
    if two_sided and not masked:
        set_two_sided(mi, True)
    for tex in textures.values():
        # A mask must be resident at the first frame; the importer's compression and mips stay as imported.
        tex.set_editor_property("never_stream", True)
        unreal.EditorAssetLibrary.save_loaded_asset(tex)
    for param, key in (("Normal Texture", "NormalTexture"), ("Occlusion Texture", "OcclusionTexture"), ("Metallic Roughness Texture", "MetallicRoughnessTexture")):
        if key in textures:
            mel.set_material_instance_texture_parameter_value(mi, param, textures[key])
    mel.update_material_instance(mi)
    unreal.EditorAssetLibrary.save_loaded_asset(mi)
    normal = textures.get("NormalTexture")
    ref.log(
        f"wildwood slot {name} masked={masked} cutoff={scalars.get('AlphaCutoff')} two_sided={two_sided} "
        f"base={base.get_name()} normal={normal.get_name() if normal else None} "
        f"normal_flip_green={normal.get_editor_property('flip_green_channel') if normal else None} "
        f"base_srgb={base.get_editor_property('srgb')} base_compression={base.get_editor_property('compression_settings')}"
    )
    return mi, base, masked, scalars.get("AlphaCutoff", 0.5), two_sided


def region_id_master(ref, folder):
    """An unlit master that draws a flat region colour and keeps only the alpha of a mask texture (PRD-651).

    The exporter's unlit proxy multiplies the texture's colour into the region colour; a real leaf texture is
    green, so the region colour would shift. Opaque by default; an instance draws Masked and two-sided.
    """
    master = ref.asset_tools.create_asset("M_TN_RegionID", folder, unreal.Material, unreal.MaterialFactoryNew())
    master.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    colour = mel.create_material_expression(master, unreal.MaterialExpressionVectorParameter, -400, 0)
    colour.set_editor_property("parameter_name", "Region Colour")
    colour.set_editor_property("default_value", unreal.LinearColor(1.0, 1.0, 1.0, 1.0))
    mel.connect_material_property(colour, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    mask = mel.create_material_expression(master, unreal.MaterialExpressionTextureSampleParameter2D, -400, 250)
    mask.set_editor_property("parameter_name", "Mask Texture")
    mask.set_editor_property("texture", unreal.load_asset("/Engine/EngineResources/WhiteSquareTexture"))
    mel.connect_material_property(mask, "A", unreal.MaterialProperty.MP_OPACITY_MASK)
    mel.recompile_material(master)
    unreal.EditorAssetLibrary.save_loaded_asset(master)
    return master


def glb_id_material(ref, folder, name, master, rgb, mask, cutoff, two_sided):
    mi = ref.asset_tools.create_asset(name, folder, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
    mel.set_material_instance_parent(mi, master)
    r, g, b = (c / 255.0 for c in rgb)
    mel.set_material_instance_vector_parameter_value(mi, "Region Colour", unreal.LinearColor(r, g, b, 1.0))
    if mask is not None:
        mel.set_material_instance_texture_parameter_value(mi, "Mask Texture", mask)
        set_masked(mi, {"alphaCutoff": cutoff, "doubleSided": two_sided})
    elif two_sided:
        set_two_sided(mi, True)
    mel.update_material_instance(mi)
    unreal.EditorAssetLibrary.save_loaded_asset(mi)
    return mi


def import_glbs(ref, base, scene, regions):
    """Imports every asset the scene's instances name. Returns the meshes and, per instance, a lit and an ID
    material for each slot of its mesh."""
    files = glb_files()
    meshes, slots = {}, {}
    for asset in sorted({g["asset"] for g in scene["glbs"]}):
        if asset not in files:
            raise ValueError(f"asset {asset}: no decoded file in TN_WILDWOOD_FILES")
        meshes[asset] = import_glb(ref, f"{base}/Models", asset, files[asset])
        slots[asset] = [
            glb_slot_material(ref, f"{base}/Materials", f"MI_{asset}_{i}", slot.material_interface)
            for i, slot in enumerate(meshes[asset].static_materials)
        ]
    master = region_id_master(ref, f"{base}/Materials")
    lit, ids = {}, {}
    for inst in scene["glbs"]:
        lit[inst["name"]] = [s[0] for s in slots[inst["asset"]]]
        ids[inst["name"]] = [
            glb_id_material(ref, f"{base}/Materials", f"MI_ID_{inst['name']}_{i}", master, regions[inst["region"]],
                            base_tex if masked else None, cutoff, two_sided)
            for i, (_, base_tex, masked, cutoff, two_sided) in enumerate(slots[inst["asset"]])
        ]
    return {"meshes": meshes, "lit": lit, "id": ids}


def spawn_glbs(ref, scene, meshes, materials):
    actors = []
    for inst in scene.get("glbs", []):
        actor = ref.actor_subsystem.spawn_actor_from_object(
            meshes[inst["asset"]], ref.to_unreal(inst["position"]),
            # The axis swap that flips handedness negates the yaw, as for a box.
            unreal.Rotator(roll=0.0, pitch=0.0, yaw=-inst["rotationYDeg"]),
        )
        actor.set_actor_label(inst["name"])
        actor.set_actor_scale3d(unreal.Vector(inst["scale"], inst["scale"], inst["scale"]))
        for i, mi in enumerate(materials[inst["name"]]):
            actor.static_mesh_component.set_material(i, mi)
        actors.append(actor)
    return actors


def glb_slot_values(mi):
    """A slot's material as the level reports it: the glTF fields both engines must agree on."""
    tex = lambda param: mel.get_material_instance_texture_parameter_value(mi, param)
    named = lambda param: (lambda t: None if t is None or t.get_name().startswith("T_GLTF_Default") else t.get_name())(tex(param))
    overrides = mi.get_editor_property("base_property_overrides")
    masked = overrides.get_editor_property("override_blend_mode") and overrides.get_editor_property("blend_mode") == unreal.BlendMode.BLEND_MASKED
    values = {
        "name": mi.get_name(),
        "baseColor": [round(c, 6) for c in (lambda c: (c.r, c.g, c.b))(mel.get_material_instance_vector_parameter_value(mi, "Base Color Factor"))],
        "roughness": round(mel.get_material_instance_scalar_parameter_value(mi, "Roughness Factor"), 6),
        "metallic": round(mel.get_material_instance_scalar_parameter_value(mi, "Metallic Factor"), 6),
        "emissive": [0.0, 0.0, 0.0],
        "emissiveStrength": 1.0,
        "baseColorTexture": named("Base Color Texture"),
        "normalTexture": named("Normal Texture"),
        "occlusionTexture": named("Occlusion Texture"),
        "alphaMode": "MASK" if masked else "OPAQUE",
        "doubleSided": bool(overrides.get_editor_property("override_two_sided") and overrides.get_editor_property("two_sided")),
    }
    if masked:
        values["alphaCutoff"] = round(overrides.get_editor_property("opacity_mask_clip_value"), 6)
    return values


def describe_glb(actor, inst):
    rot = actor.get_actor_rotation()
    if abs(rot.pitch) > 1e-3 or abs(rot.roll) > 1e-3:
        raise ValueError(f"{inst['name']}: an instance turns about the vertical only")
    component = actor.static_mesh_component
    mesh = component.static_mesh
    box = mesh.get_bounding_box()
    scale = actor.get_actor_scale3d()
    slots = [dict(glb_slot_values(component.get_material(i)), slot=str(mesh.static_materials[i].material_slot_name)) for i in range(len(mesh.static_materials))]
    return {
        "name": inst["name"],
        "class": "StaticMeshActor",
        "asset": inst["asset"],
        "region": inst["region"],
        "position": to_three(actor.get_actor_location()),
        "rotationYDeg": round(-rot.yaw, 6),
        "scale": round(scale.x, 6),
        # The mesh's own bounds in metres, three.js frame, before the instance scale.
        "boundsMin": to_three(box.min),
        "boundsMax": to_three(box.max),
        # LOD 0 of the render data. With Nanite on (Interchange's default) this is the coarser fallback mesh
        # (3645 against 14927 for the green tree); `import_glb` turns Nanite off, so it holds every source triangle.
        "triangles": mesh.get_num_triangles(0),
        "material": slots[0],
        "slots": slots,
    }


def spawn_light(ref, light):
    classes = {"PointLight": unreal.PointLight, "SpotLight": unreal.SpotLight, "RectLight": unreal.RectLight}
    if light["class"] not in classes:
        raise ValueError(f"light {light['name']}: unknown class {light['class']}")
    actor = ref.actor_subsystem.spawn_actor_from_class(classes[light["class"]], ref.to_unreal(light["position"]))
    actor.set_actor_label(light["name"])
    if light["class"] == "SpotLight":
        # PRD-649 lamp-room: a spot shines along its forward vector, toward `target` (three.js frame).
        actor.set_actor_rotation(ref.look_rotation(light["position"], light["target"]), False)
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
    if light["class"] == "SpotLight":
        component.set_editor_property("inner_cone_angle", light["innerConeDeg"])
        component.set_editor_property("outer_cone_angle", light["outerConeDeg"])


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


def spawn_boxes(ref, scene, meshes, materials):
    actors = []
    for box in scene["boxes"]:
        actor = ref.actor_subsystem.spawn_actor_from_object(
            meshes[mesh_key(box)], ref.to_unreal(box["position"]),
            # three's +X is Unreal's +X: a roll is the same angle about it. The axis swap that flips
            # handedness negates the yaw. Unreal turns the roll first, then the yaw: a tilt, then a turn.
            unreal.Rotator(roll=box.get("rotationXDeg", 0.0), pitch=0.0, yaw=-box.get("rotationYDeg", 0.0)),
        )
        actor.set_actor_label(box["name"])
        actor.static_mesh_component.set_material(0, materials[box["name"]])
        actors.append(actor)
    return actors


def build_template_level(ref, path, scene, meshes, materials, sun, glb=None):
    """PRD-649: Unreal's default level with the template floor replaced by the scene's boxes."""
    if not ref.level_subsystem.new_level_from_template(path, ref.TEMPLATE_MAP):
        raise RuntimeError("new_level_from_template failed for " + path)
    for actor in ref.actor_subsystem.get_all_level_actors():
        cls = actor.get_class().get_name()
        if cls == "StaticMeshActor" and actor.get_actor_label() == "Floor":
            ref.actor_subsystem.destroy_actor(actor)
        elif cls == "DirectionalLight":
            actor.set_actor_rotation(ref.sun_rotation(sun), False)
    actors = spawn_boxes(ref, scene, meshes, materials)
    if glb:
        actors += spawn_glbs(ref, scene, glb["meshes"], glb["lit"])
    volume = ref.actor_subsystem.spawn_actor_from_class(unreal.PostProcessVolume, unreal.Vector(0, 0, 0))
    volume.set_editor_property("unbound", True)
    ref.level_subsystem.save_current_level()
    return actors


def build_level(ref, path, scene, meshes, materials, lights, glb_materials=None):
    if not ref.level_subsystem.new_level(path):
        raise RuntimeError("new_level failed for " + path)
    actors = spawn_boxes(ref, scene, meshes, materials)
    if glb_materials:
        actors += spawn_glbs(ref, scene, glb_materials["meshes"], glb_materials["id"])
    if lights:
        for light in scene["lights"]:
            spawn_light(ref, light)
    exposure_volume(ref, scene["ev100"])
    ref.level_subsystem.save_current_level()
    return actors


# --- motion runs (PRD-638) ----------------------------------------------------------------
UNIT = unreal.MovieSceneTimeUnit.DISPLAY_RATE
STEP = unreal.MovieSceneKeyInterpolation.CONSTANT
LINE = unreal.MovieSceneKeyInterpolation.LINEAR


def heading_at(camera, frame):
    """Degrees at a frame: linear from the first heading to the second over sweepFrames, then held."""
    first, last = camera["headingDeg"]
    return first + (last - first) * min(max(frame / camera["sweepFrames"], 0.0), 1.0)


def pan_pose(camera, frame):
    """The pose of a pan at a frame, in the three.js frame: heading 0 looks down -z, a positive heading turns toward +x."""
    heading, pitch = math.radians(heading_at(camera, frame)), math.radians(camera.get("pitchDeg", 0.0))
    x, y, z = camera["position"]
    return {
        "position": [x, y, z],
        "target": [x + math.sin(heading) * math.cos(pitch), y + math.sin(pitch), z - math.cos(heading) * math.cos(pitch)],
        "hfovDeg": camera["hfovDeg"],
    }


def run_pose(scene, run, frame):
    camera = run["camera"]
    if camera["kind"] == "pan":
        return pan_pose(camera, frame)
    return next(p for p in scene["poses"] if p["name"] == camera["pose"])


def spawn_camera(ref, name, pose, label):
    camera = ref.actor_subsystem.spawn_actor_from_class(unreal.CameraActor, ref.to_unreal(pose["position"]), ref.look_rotation(pose["position"], pose["target"]))
    camera.set_actor_label(label)
    component = camera.get_editor_property("camera_component")
    component.set_editor_property("field_of_view", pose["hfovDeg"])
    width, height = registry(name)["resolution"]
    component.set_editor_property("aspect_ratio", width / height)
    component.set_editor_property("constrain_aspect_ratio", False)
    return camera


def key_summary(channel):
    """[frame, value] of every key, for the build log. A diagnostic: a failure to read them never fails the build."""
    try:
        return json.dumps([[k.get_time().frame_number.value, k.get_value()] for k in channel.get_keys()])
    except Exception as error:
        return f"<unreadable: {error}>"


def key_pan(ref, binding, camera, frames):
    """Location and scale hold; the rotation turns linearly from the first heading to the last over sweepFrames."""
    track = binding.add_track(unreal.MovieScene3DTransformTrack)
    section = track.add_section()
    section.set_range(0, frames)
    channels = section.get_all_channels()
    if len(channels) < 9:
        raise RuntimeError(f"a transform section has {len(channels)} channels, expected 9")
    first = pan_pose(camera, 0)
    where = ref.to_unreal(first["position"])
    for channel, value in zip(channels[0:3], (where.x, where.y, where.z)):
        channel.add_key(unreal.FrameNumber(0), value, 0.0, UNIT, STEP)
    for channel in channels[6:9]:
        channel.add_key(unreal.FrameNumber(0), 1.0, 0.0, UNIT, STEP)
    # Channels 3, 4 and 5 are the roll, pitch and yaw in degrees.
    last = pan_pose(camera, camera["sweepFrames"])
    for frame, pose in ((0, first), (camera["sweepFrames"], last)):
        turn = ref.look_rotation(pose["position"], pose["target"])
        for channel, value in zip(channels[3:6], (turn.roll, turn.pitch, turn.yaw)):
            channel.add_key(unreal.FrameNumber(frame), value, 0.0, UNIT, LINE)
    yaw = channels[5]
    ref.log("motion pan yaw keys " + key_summary(yaw))


def key_light(ref, sequence, spec, scene, frames):
    """A float track on the light's Intensity: the authored intensity times `scale`, constant between keys."""
    lamp = next(a for a in ref.actor_subsystem.get_all_level_actors() if a.get_actor_label() == spec["name"])
    authored = next(l["intensity"] for l in scene["lights"] if l["name"] == spec["name"])
    component_class = unreal.SpotLightComponent if lamp.get_class().get_name() == "SpotLight" else unreal.PointLightComponent
    binding = sequence.add_possessable(lamp.get_component_by_class(component_class))
    track = binding.add_track(unreal.MovieSceneFloatTrack)
    track.set_property_name_and_path("Intensity", "Intensity")
    section = track.add_section()
    section.set_range(0, frames)
    channel = section.get_all_channels()[0]
    for frame, scale in spec["keys"]:
        channel.add_key(unreal.FrameNumber(frame), authored * scale, 0.0, UNIT, STEP)
    ref.log("motion light keys " + key_summary(channel))


def motion_sequence(ref, name, scene, run, sequence_name, frames, pose_at, with_light):
    """One Level Sequence at 30 frames a second: a spawnable camera, its cut, a keyed turn when the run pans, and the light track."""
    sequence = ref.asset_tools.create_asset(sequence_name, root(name) + "/Sequences", unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
    sequence.set_display_rate(unreal.FrameRate(30, 1))
    sequence.set_playback_start(0)
    sequence.set_playback_end(frames)
    camera = spawn_camera(ref, name, pose_at(0), "Cam_" + sequence_name)
    binding = sequence.add_spawnable_from_instance(camera)
    ref.actor_subsystem.destroy_actor(camera)
    cut = sequence.add_track(unreal.MovieSceneCameraCutTrack)
    section = cut.add_section()
    section.set_range(0, frames)
    section.set_camera_binding_id(sequence.get_binding_id(binding))
    if run["camera"]["kind"] == "pan" and frames > 1:
        key_pan(ref, binding, run["camera"], frames)
    if with_light and run.get("light"):
        key_light(ref, sequence, run["light"], scene, frames)
    unreal.EditorAssetLibrary.save_loaded_asset(sequence)


def build_motion(ref, name, scene):
    """Sequences of every motion run. The lit level is the current editor level, so the light track binds to its actor.

    A run that fails is logged with its traceback and the others still build, so one editor pass shows every fault.
    """
    failed = []
    for run_name, run in scene.get("motion", {}).items():
        try:
            frames = run["frames"]
            at = lambda frame, run=run: run_pose(scene, run, frame)
            motion_sequence(ref, name, scene, run, f"Seq_motion_{run_name}", frames, at, True)
            if run.get("light"):
                motion_sequence(ref, name, scene, run, f"Seq_motion_{run_name}_id", frames, at, False)
            for still in run.get("stills", []):
                fixed = run_pose(scene, run, still)
                still_run = dict(run, camera={"kind": "pose", "pose": "still"})
                motion_sequence(ref, name, scene, still_run, f"Seq_motion_{run_name}_still_{still:04d}", 1, lambda frame, fixed=fixed: fixed, False)
            ref.log(f"gi motion built scene={name} run={run_name} frames={frames} stills={run.get('stills', [])}")
        except Exception:
            import traceback

            ref.log(f"gi motion FAILED scene={name} run={run_name}\n{traceback.format_exc()}")
            failed.append(run_name)
    if failed:
        raise RuntimeError(f"motion runs failed to build: {failed}")


def build(ref, name):
    scene = load_scene(name)
    template = scene.get("template") == "default"
    if not template and (scene.get("sky") or scene.get("sun") or scene.get("fog")):
        raise ValueError(f"scene {name}: sky, sun and fog are not authored yet (PRD-638 Phase 2)")
    if template and (scene["lights"] or not scene.get("suns")):
        raise ValueError(f"scene {name}: a template-lit scene names its suns and adds no light")
    glbs = scene.get("glbs", [])
    if glbs and not template:
        raise ValueError(f"scene {name}: real assets are placed in a template-lit scene")
    region_material = {}
    for box in scene["boxes"]:
        if region_material.setdefault(region_of(box), box["material"]) != box["material"]:
            raise ValueError(f"scene {name}: region {region_of(box)} mixes materials, its ID frame could not tell them apart")
    # An instance of a real asset is a region of its own (or shares one, as the manifest says).
    region_names = list(region_material) + [r for r in dict.fromkeys(g["region"] for g in glbs) if r not in region_material]
    if len(region_names) > len(ID_COLORS):
        raise ValueError(f"scene {name}: more regions than region-ID colours")
    base = root(name)
    # Two ways to bind a texture, side by side. A scene's "textures" names image files and a material binds one
    # by that name as "baseColorTexture" (PRD-639: an sRGB albedo, as the glTF exporter writes it). A masked
    # material names its file as "texture" (PRD-651: uncompressed and clamped, so the cut keeps its edge).
    textures = {t: texture(ref, f"{base}/Textures", f"T_{t}", os.path.join(scene_dir(name), file)) for t, file in scene.get("textures", {}).items()}
    textures.update({
        f: import_texture(ref, f"{base}/Textures", os.path.join(scene_dir(name), f))
        for f in sorted({m["texture"] for m in scene["materials"].values() if "texture" in m})
    })
    named = {m: material(ref, f"{base}/Materials", f"MI_{m}", v, textures=textures) for m, v in scene["materials"].items()}
    regions = {r: ID_COLORS[i] for i, r in enumerate(region_names)}
    # Linear base colour id/255: Unreal display-encodes it, and compare.ts accepts both forms. A masked
    # region keeps its cut in the ID frame: the same texture, clip value and sides, unlit.
    ids = {}
    for region in region_material:
        rgb = regions[region]
        spec = scene["materials"][region_material[region]]
        values = {"baseColor": [c / 255.0 for c in rgb], "roughness": 1.0, "metallic": 0.0}
        values.update({k: spec[k] for k in ("texture", "alphaMode", "alphaCutoff", "doubleSided") if k in spec})
        ids[region] = material(ref, f"{base}/Materials", f"MI_ID_{region}", values, UNLIT_PROXY, textures)
    meshes = {}
    for box in scene["boxes"]:
        key = mesh_key(box)
        if key not in meshes:
            meshes[key] = box_mesh(f"{base}/Meshes", box)
        elif box["size"] != next(b for b in scene["boxes"] if mesh_key(b) == key)["size"]:
            raise ValueError(f"scene {name}: {box['name']} shares mesh {key} with a box of another size")
    glb = import_glbs(ref, base, scene, regions) if glbs else None
    build_level(ref, level_path(name, "_id"), scene, meshes, {b["name"]: ids[region_of(b)] for b in scene["boxes"]}, False, glb)
    lit = {b["name"]: named[b["material"]] for b in scene["boxes"]}
    if template:
        for sun in scene["suns"]:
            actors = build_template_level(ref, level_path(name, f"_{sun['name']}"), scene, meshes, lit, sun, glb)
    else:
        actors = build_level(ref, level_path(name), scene, meshes, lit, True)
    write_json(name, describe_level(ref, name, scene, regions))
    # Real assets are licensed files both engines read from the asset root; no scene.glb carries them.
    if not glbs:
        export_glb(name, actors)
    ref.build_cameras(poses_of(scene), base)
    try:
        build_motion(ref, name, scene)
    finally:
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
    result = unreal.GLTFExporter.export_to_gltf(world, os.path.join(scene_dir(name), "scene.glb"), options, set(actors))
    ok = result[0] if isinstance(result, tuple) else result
    if not ok:
        raise RuntimeError(f"glTF export failed for {name}: {result}")


# --- scene.json: read back from the level ------------------------------------------------
def to_three(v):
    return [round(v.x / 100.0, 6), round(v.z / 100.0, 6), round(v.y / 100.0, 6)]


def describe_level(ref, name, scene, regions):
    meshes, lights, exposure, sun, template_meshes = [], [], None, None, []
    boxes = {b["name"] for b in scene["boxes"]}
    instances = {g["name"]: g for g in scene.get("glbs", [])}
    region_by_box = {b["name"]: region_of(b) for b in scene["boxes"]}
    for actor in ref.actor_subsystem.get_all_level_actors():
        label, cls = actor.get_actor_label(), actor.get_class().get_name()
        if cls == "StaticMeshActor" and label in instances:
            meshes.append(describe_glb(actor, instances[label]))
        elif cls == "StaticMeshActor" and label not in boxes and scene.get("template") == "default":
            # The default level's own meshes (its sky sphere and the like) are Unreal's, not the scene's.
            template_meshes.append(label)
        elif cls == "StaticMeshActor":
            rot = actor.get_actor_rotation()
            if abs(rot.pitch) > 1e-3:
                raise ValueError(f"{label}: only a turn about the vertical and a tilt about the x axis are exported")
            component = actor.static_mesh_component
            box = component.static_mesh.get_bounding_box()
            mi = component.get_material(0)
            meshes.append({
                "name": label,
                "class": cls,
                "position": to_three(actor.get_actor_location()),
                "rotationYDeg": round(-rot.yaw, 6),
                # A roll is the same angle about three's +X: the glTF export writes it so (penumbra-lab's ramp).
                # With a yaw too, the tilt is turned first (a leaf card), as the actor's rotation does.
                **({"rotationXDeg": round(rot.roll, 6)} if abs(rot.roll) > 1e-3 else {}),
                # A region is the actor's own unless scene.py groups it (the leaf cards).
                **({"region": region_by_box[label]} if region_by_box.get(label, label) != label else {}),
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
            if cls == "SpotLight":
                # One metre along the actor's forward vector is the target; the cone angles are Unreal's.
                ahead = actor.get_actor_location() + actor.get_actor_forward_vector() * 100.0
                light["target"] = to_three(ahead)
                light["innerConeDeg"] = round(c.get_editor_property("inner_cone_angle"), 6)
                light["outerConeDeg"] = round(c.get_editor_property("outer_cone_angle"), 6)
            lights.append(light)
        elif cls == "DirectionalLight":
            # A template-lit scene: the default sun, read back; its rotation is the last sun's level.
            c = actor.get_component_by_class(unreal.DirectionalLightComponent)
            sun = {
                "intensityLux": c.get_editor_property("intensity"),
                "temperatureK": c.get_editor_property("temperature"),
                "useTemperature": c.get_editor_property("use_temperature"),
                "sourceAngleDeg": c.get_editor_property("light_source_angle"),
                "sourceSoftAngleDeg": c.get_editor_property("light_source_soft_angle"),
                "castShadows": c.get_editor_property("cast_shadows"),
                "contactShadowLength": c.get_editor_property("contact_shadow_length"),
            }
        elif cls == "PostProcessVolume" and scene.get("template") != "default":
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
        "note": f"Written by gi/export.py from the Unreal 5.8.3 level {level_path(name)}. three.js frame: Y up, metres. Unreal is the authority; scene.py is only the authoring input.",
        "scene": name,
        "resolution": registry(name)["resolution"],
        "meshes": meshes,
        "lights": lights,
        "sky": "template" if scene.get("template") == "default" else None,
        "sun": sun,
        **({"template": "default", "suns": scene["suns"], "templateMeshes": sorted(template_meshes)} if scene.get("template") == "default" else {}),
        "fog": None,
        "exposure": exposure,
        "poses": poses_of(scene),
        # The motion record is authored in scene.py: a Level Sequence cannot report it back as it was asked for.
        **({"motion": scene["motion"]} if scene.get("motion") else {}),
        "regions": regions,
    }


def enum_name(value):
    # str() of an Unreal enum is "<LightUnits.LUMENS: 2>"; .name is "LUMENS".
    return value.name.lower()


def material_values(mi):
    def vector(param):
        c = mel.get_material_instance_vector_parameter_value(mi, param)
        return [round(c.r, 6), round(c.g, 6), round(c.b, 6)]

    # The proxy parent's default is its own white texture: only a texture the scene bound counts (PRD-639).
    bound = mel.get_material_instance_texture_parameter_value(mi, "Base Color Texture")
    textured = bound is not None and not bound.get_name().startswith("T_GLTF_Default")
    values = {
        "name": mi.get_name(),
        "baseColor": vector("Base Color Factor"),
        **({"baseColorTexture": bound.get_name().removeprefix("T_")} if textured else {}),
        "roughness": round(mel.get_material_instance_scalar_parameter_value(mi, "Roughness Factor"), 6),
        "metallic": round(mel.get_material_instance_scalar_parameter_value(mi, "Metallic Factor"), 6),
        "emissive": vector("Emissive Factor"),
        "emissiveStrength": round(mel.get_material_instance_scalar_parameter_value(mi, "Emissive Strength"), 6),
    }
    # A masked material also reports its texture, clip value and sides, read from the instance.
    overrides = mi.get_editor_property("base_property_overrides")
    if overrides.get_editor_property("override_blend_mode") and overrides.get_editor_property("blend_mode") == unreal.BlendMode.BLEND_MASKED:
        texture = mel.get_material_instance_texture_parameter_value(mi, "Base Color Texture")
        values["texture"] = os.path.basename(texture.get_editor_property("asset_import_data").get_first_filename())
        values["alphaMode"] = "MASK"
        values["alphaCutoff"] = round(overrides.get_editor_property("opacity_mask_clip_value"), 6)
        values["doubleSided"] = bool(overrides.get_editor_property("override_two_sided") and overrides.get_editor_property("two_sided"))
        # A masked material names its texture as "texture" (PRD-651), not as "baseColorTexture" (PRD-639).
        values.pop("baseColorTexture", None)
    return values


def write_json(name, value):
    with open(os.path.join(scene_dir(name), "scene.json"), "w") as f:
        json.dump(value, f, indent=2)
        f.write("\n")


# --- capture -----------------------------------------------------------------
def capture(ref, name, out):
    scene = load_scene(name)
    variant = next((v for v in registry(name)["variants"] if v["name"] == os.environ.get("TN_UE_VARIANT")), None)
    if variant is None:
        raise ValueError(f"unknown TN_UE_VARIANT {os.environ.get('TN_UE_VARIANT')}")
    layer = next(l for l in ref.LAYERS if l["name"] == variant["layer"])
    warm_up = int(os.environ.get("TN_UE_WARMUP", "180"))
    run = int(os.environ.get("TN_UE_RUN", "1"))
    # Same naming as folderName() in scripts/unreal-look/gi.ts.
    folder = variant["name"] + ("" if warm_up == 180 else f"@{warm_up}") + ("" if run == 1 else f"#{run}")
    cvars = dict(layer["cvars"], **variant["cvars"])
    if os.environ.get("TN_UE_MOTION"):
        return capture_motion(ref, name, scene, variant, layer, cvars, out, folder, warm_up, os.environ["TN_UE_MOTION"])
    queue = ref.queue()
    count = 0
    for pose in poses_of(scene):
        level = level_path(name, "_id" if variant.get("level") == "id" else f"_{pose['sun']}" if "sun" in pose else "")
        for kind in variant["kinds"]:
            ref.add_job(
                queue, pose["name"], level, f"{root(name)}/Sequences/Seq_{pose['name']}",
                os.path.join(out, out_key(name), folder), cvars, layer["showFlags"], kind, warm_up,
                list(variant["expect"]),
            )
            count += 1
    ref.log(f"gi capture scene={name} variant={folder} queued={count}")
    ref.render()


def capture_motion(ref, name, scene, variant, layer, cvars, out, folder, warm_up, run_name):
    """PRD-638: the frames of one motion run, and one converged frame per still, for the variant in TN_UE_VARIANT."""
    run = scene.get("motion", {}).get(run_name)
    if run is None:
        raise ValueError(f"scene {name} has no motion run {run_name}")
    if scene.get("template") == "default":
        raise ValueError(f"scene {name}: a template-lit scene has no motion run")
    is_id = variant.get("level") == "id"
    level = level_path(name, "_id" if is_id else "")
    out_dir = os.path.join(out, out_key(name), "motion", run_name, folder)
    # The ID level holds no light, so a run that keys a light renders its ID frames from the camera-only sequence.
    jobs = [(run_name, f"Seq_motion_{run_name}" + ("_id" if is_id and run.get("light") else ""))]
    jobs += [(f"still-{s:04d}", f"Seq_motion_{run_name}_still_{s:04d}") for s in run.get("stills", [])]
    queue = ref.queue()
    for job_name, sequence in jobs:
        for kind in variant["kinds"]:
            ref.add_job(
                queue, job_name, level, f"{root(name)}/Sequences/{sequence}", out_dir, cvars, layer["showFlags"], kind,
                warm_up, list(variant["expect"]), frames=True,
            )
    ref.log(f"gi capture motion scene={name} run={run_name} variant={folder} queued={len(jobs) * len(variant['kinds'])}")
    ref.render()
