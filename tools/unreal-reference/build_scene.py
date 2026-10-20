"""Build the PRD-631 reference scene and export it as glTF binary.

Run headless:  blender -b --python tools/unreal-reference/build_scene.py

Writes two files next to this script:
  scene.glb     the lit scene that both engines load
  scene-id.glb  the same geometry with one flat, distinct base colour per region;
                rendered unlit (layer L0) it is the region mask for compare.ts

Layout is given in three.js coordinates (Y up, metres, camera looks down -Z);
glTF export with +Y up maps Blender (x, y, z) to glTF (x, z, -y).
"""

import json
import os

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))

# name: (base colour linear RGB, roughness, metallic, emissive RGB, emissive strength)
MATERIALS = {
    "Floor": ((0.18, 0.18, 0.18), 0.8, 0.0, None, 0.0),
    "Sphere_RoughDielectric": ((0.5, 0.5, 0.5), 0.7, 0.0, None, 0.0),
    "Sphere_SmoothDielectric": ((0.5, 0.5, 0.5), 0.1, 0.0, None, 0.0),
    "Sphere_RoughMetal": ((0.8, 0.8, 0.8), 0.5, 1.0, None, 0.0),
    "Sphere_Chrome": ((0.95, 0.95, 0.95), 0.05, 1.0, None, 0.0),
    "Sphere_Emissive": ((0.1, 0.1, 0.1), 0.5, 0.0, (1.0, 0.6, 0.3), 5.0),
    "Box_Red": ((0.6, 0.05, 0.05), 0.7, 0.0, None, 0.0),
    "Box_Green": ((0.05, 0.5, 0.05), 0.7, 0.0, None, 0.0),
    "Box_White": ((0.8, 0.8, 0.8), 0.7, 0.0, None, 0.0),
    "Room": ((0.6, 0.6, 0.6), 0.9, 0.0, None, 0.0),
    "BacklitWall": ((0.4, 0.4, 0.4), 0.9, 0.0, None, 0.0),
    "Capsule": ((0.5, 0.5, 0.5), 0.6, 0.0, None, 0.0),
}

# Region id colours (sRGB 8-bit, so a PNG pixel classifies exactly). The sky is
# whatever is not one of these; compare.ts reads the same table from regions.json.
ID_COLOURS = {
    "Floor": (128, 128, 128),
    "Sphere_RoughDielectric": (255, 0, 0),
    "Sphere_SmoothDielectric": (0, 255, 0),
    "Sphere_RoughMetal": (0, 0, 255),
    "Sphere_Chrome": (255, 255, 0),
    "Sphere_Emissive": (255, 0, 255),
    "Box_Red": (0, 255, 255),
    "Box_Green": (255, 128, 0),
    "Box_White": (128, 0, 255),
    "Room": (0, 128, 64),
    "BacklitWall": (128, 255, 128),
    "Capsule": (64, 0, 128),
}


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def three_to_blender(x, y, z):
    return (x, -z, y)


def material(name, flat_id):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    base, rough, metal, emissive, strength = MATERIALS[name]
    if flat_id:
        base = tuple(srgb_to_linear(c) for c in ID_COLOURS[name])
        rough, metal, emissive, strength = 1.0, 0.0, None, 0.0
    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emissive:
        bsdf.inputs["Emission Color"].default_value = (*emissive, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def finish(obj, name, flat_id):
    obj.name = name
    obj.data.name = name
    obj.data.materials.clear()
    obj.data.materials.append(material(name, flat_id))
    return obj


def box(name, centre, size, flat_id):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=three_to_blender(*centre))
    obj = bpy.context.active_object
    # three.js size (x, y, z) -> Blender scale (x, z, y)
    obj.scale = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(scale=True)
    return finish(obj, name, flat_id)


def build(flat_id):
    bpy.ops.wm.read_factory_settings(use_empty=True)

    bpy.ops.mesh.primitive_plane_add(size=40.0, location=(0, 0, 0))
    finish(bpy.context.active_object, "Floor", flat_id)

    spheres = [
        "Sphere_RoughDielectric",
        "Sphere_SmoothDielectric",
        "Sphere_RoughMetal",
        "Sphere_Chrome",
        "Sphere_Emissive",
    ]
    for i, name in enumerate(spheres):
        bpy.ops.mesh.primitive_uv_sphere_add(
            radius=0.5, segments=48, ring_count=24, location=three_to_blender(-3.0 + 1.5 * i, 0.5, 0.0)
        )
        bpy.ops.object.shade_smooth()
        finish(bpy.context.active_object, name, flat_id)

    for i, name in enumerate(["Box_Red", "Box_Green", "Box_White"]):
        box(name, (-1.2 + 1.2 * i, 0.4, -2.0), (0.8, 0.8, 0.8), flat_id)

    # 6 m room centred at (-10, 0, -8), 3 m high, open towards +Z.
    cx, cz, half, h, t = -10.0, -8.0, 3.0, 3.0, 0.2
    parts = [
        ((cx, h / 2, cz - half), (2 * half, h, t)),  # back wall
        ((cx - half, h / 2, cz), (t, h, 2 * half)),  # left wall
        ((cx + half, h / 2, cz), (t, h, 2 * half)),  # right wall
        ((cx, h + t / 2, cz), (2 * half + t, t, 2 * half + t)),  # roof
    ]
    room = [box("Room", c, s, flat_id) for c, s in parts]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in room:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = room[0]
    bpy.ops.object.join()
    finish(bpy.context.active_object, "Room", flat_id)

    # A 10 m wall between the backlit camera and the low sun.
    box("BacklitWall", (8.0, 1.5, 8.0), (10.0, 3.0, 0.3), flat_id)

    # 1.8 m capsule standing on the floor.
    bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=1.2, vertices=32, location=three_to_blender(0.0, 0.9, 2.0))
    cylinder = bpy.context.active_object
    caps = [cylinder]
    for y in (0.3, 1.5):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.3, segments=32, ring_count=16, location=three_to_blender(0.0, y, 2.0))
        caps.append(bpy.context.active_object)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in caps:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = cylinder
    bpy.ops.object.join()
    bpy.ops.object.shade_smooth()
    finish(bpy.context.active_object, "Capsule", flat_id)


def export(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_lights=False,
        export_cameras=False,
    )
    size = os.path.getsize(path)
    if size >= 1_000_000:
        raise SystemExit(f"{path} is {size} bytes; the PRD-631 budget is under 1 MB")
    print(f"wrote {path} ({size} bytes)")


with open(os.path.join(HERE, "regions.json"), "w") as f:
    # Biome's JSON layout, so the generated file passes `pnpm lint` unchanged.
    rows = ",\n".join(f'    "{k}": {json.dumps(list(v)).replace(",", ", ").replace(",  ", ", ")}' for k, v in ID_COLOURS.items())
    f.write('{\n  "srgb8": {\n' + rows + "\n  }\n}\n")

for flat, filename in ((False, "scene.glb"), (True, "scene-id.glb")):
    build(flat)
    export(os.path.join(HERE, filename))
