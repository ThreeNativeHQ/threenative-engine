# SPDX-License-Identifier: GPL-2.0-or-later
#
# Writes this example's world package: a heightfield, one mask plane set and sixteen terrain
# layers with an albedo, a normal and an ORM map each. Sixteen is the point — every map is its own
# uncompressed JPEG, which is the shape that used to bind one sampler per map and stop at WebGPU's
# sixteen sampled textures a stage.
#
# The layer table and the texture files are authored here and assembled by the shipped recipe
# (`export_terrain_layers` in export_world.py), so the package is the one a DCC export produces and
# not a second format. Run it through Blender, which is also what writes the JPEGs:
#
#   blender --background --factory-startup --python examples/prd493-terrain-splat/scripts/make_world.py \
#     -- --out examples/prd493-terrain-splat/public/world
#
# The maps are proof fixtures, not art: values are written straight into 8-bit sRGB JPEGs, so the
# normal and ORM channels carry the transfer curve of the file format rather than exact numbers.

import colorsys
import json
import math
import os
import sys

import bpy

LAYER_COUNT = 16
TEXTURE_SIZE = 128
SPLAT_SIZE = 128
MASK_RAMP = 8.0
HEIGHT_COLUMNS = 64
HEIGHT_ROWS = 64
SPACING = 2.0
RECIPE = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "packages", "core", "gpl", "recipes")
)


def fail(message):
    sys.stderr.write("TN_PRD493_ERROR: %s\n" % message)
    sys.stderr.flush()
    os._exit(2)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    out = None
    index = 0
    while index < len(argv):
        if argv[index] == "--out" and index + 1 < len(argv):
            out = argv[index + 1]
            index += 1
        index += 1
    if out is None:
        fail("make_world needs --out <package directory>")
        raise SystemExit(2)
    return os.path.abspath(out)


def write_image(path, width, height, pixel, file_format="JPEG", quality=80):
    """One image written from a `(x, y) -> (r, g, b)` function in 0..1, rows bottom-up."""
    image = bpy.data.images.new(os.path.basename(path), width=width, height=height, alpha=False)
    try:
        pixels = []
        for y in range(height):
            for x in range(width):
                r, g, b = pixel(x, y)
                pixels.extend((r, g, b, 1.0))
        image.pixels.foreach_set(pixels)
        image.filepath_raw = path
        image.file_format = file_format
        image.save(quality=quality)
    finally:
        bpy.data.images.remove(image)


def noise(x, y, seed):
    """A cheap deterministic value in -1..1: layered sines, so every map tiles without seams."""
    return (
        math.sin((x + seed * 13.0) * 0.37 + seed) * 0.5
        + math.sin((y + seed * 7.0) * 0.23 - seed) * 0.3
        + math.sin((x + y) * 0.11 + seed * 3.0) * 0.2
    )


def write_layer_maps(tex, layer):
    """The three maps of one layer: a tinted albedo with a visible weave, a normal, and an ORM."""
    hue, saturation, value = layer["_hsv"]
    tint = layer["tint"]
    roughness = layer["roughness"]
    metalness = layer["metalness"]
    seed = layer["_seed"]
    period = 8.0 if layer["_weave"] else 5.0
    albedo_r, albedo_g, albedo_b = colorsys.hsv_to_rgb(hue, saturation, value)
    weave = lambda x, y: ((x // (TEXTURE_SIZE / period)) + (y // (TEXTURE_SIZE / period))) % 2 == 0
    write_image(
        os.path.join(tex, "%s_diff.jpg" % layer["id"]),
        TEXTURE_SIZE,
        TEXTURE_SIZE,
        lambda x, y: (
            (albedo_r if weave(x, y) else albedo_r * 0.78) * tint[0],
            (albedo_g if weave(x, y) else albedo_g * 0.78) * tint[1],
            (albedo_b if weave(x, y) else albedo_b * 0.78) * tint[2],
        ),
    )
    slope = 0.25 + 0.35 * roughness
    write_image(
        os.path.join(tex, "%s_nrm.jpg" % layer["id"]),
        TEXTURE_SIZE,
        TEXTURE_SIZE,
        lambda x, y: (
            0.5 + noise(x, y, seed) * slope * 0.35,
            0.5 + noise(x, y, seed + 5) * slope * 0.35,
            1.0,
        ),
    )
    # Occlusion in r, roughness in g, metalness in b, exactly as the loader reads them.
    write_image(
        os.path.join(tex, "%s_orm.jpg" % layer["id"]),
        TEXTURE_SIZE,
        TEXTURE_SIZE,
        lambda x, y: (
            0.55 + 0.45 * (0.5 + 0.5 * noise(x, y, seed + 9)),
            roughness * (0.85 + 0.15 * noise(x, y, seed + 11)),
            metalness,
        ),
    )


def write_height_map(tex, layer):
    """The layer's own height in 0..1: stones with grout between, so an edge has relief to follow.

    Whole cycles per tile in both axes, so the map wraps without a seam where the tile repeats.
    """
    seed = layer["_seed"]
    turn = 2.0 * math.pi / TEXTURE_SIZE
    phase = seed * 0.9

    def stones(x, y):
        beads = math.sin(x * turn * 5 + phase) * math.sin(y * turn * 4 - phase)
        drift = math.sin((x * 3 + y * 2) * turn + phase * 2.0)
        return min(1.0, max(0.0, 0.5 + 0.9 * (0.65 * beads + 0.35 * drift)))

    write_image(
        os.path.join(tex, "%s_h.jpg" % layer["id"]),
        TEXTURE_SIZE,
        TEXTURE_SIZE,
        lambda x, y: (lambda v: (v, v, v))(stones(x, y)),
        file_format="JPEG",
        quality=90,
    )


def build(out):
    source = os.path.join(out, "dcc")
    tex = os.path.join(source, "tex")
    os.makedirs(tex, exist_ok=True)
    os.makedirs(os.path.join(out, "terrain"), exist_ok=True)

    layers = []
    masks = {}
    for index in range(LAYER_COUNT):
        hue = (0.09 + index * 0.061) % 1.0
        layers.append(
            {
                "_hsv": (hue, 0.25 + 0.05 * (index % 4), 0.35 + 0.03 * (index % 5)),
                "_seed": index + 1,
                "_weave": index % 3 == 0,
                # The two topmost layers blend by their own height, so the band they bound has relief on its edge.
                "height": index in (14, 15),
                "id": "layer-%02d" % index,
                "metalness": 0.0 if index % 5 else 0.35,
                "normal": True,
                "orm": True,
                "roughness": 0.45 + 0.05 * (index % 6),
                "tile": 3.0 + 0.5 * (index % 4),
                "tint": [0.75 + 0.05 * (index % 3), 0.8 + 0.05 * (index % 2), 0.85],
            }
        )

    for layer in layers:
        write_layer_maps(tex, layer)
        if layer["height"]:
            write_height_map(tex, layer)

    # Fifteen masked layers over three channels per mask image: five planes, each band a gradient
    # MASK_RAMP texels across, so a layer's own height map has room to decide where it takes over.
    # Layers composite over the one below, so a layer reaches MASK_RAMP texels under the edge of the
    # layer above it: weights that merely sum to one would let the layer beneath show through.
    def band(position, start, stop):
        """0..1 across MASK_RAMP texels centred on each edge of the periodic band [start, stop)."""
        along = (position - start) % SPLAT_SIZE
        width = stop - start
        if along < width:
            inside = min(along, width - along)
        else:
            inside = -min(along - width, SPLAT_SIZE - along)
        return min(1.0, max(0.0, 0.5 + inside / MASK_RAMP))

    for plane in range(5):
        name = "mask-%d" % plane
        masks[name] = {"image": "%s.png" % name, "channels": "rgb"}
        write_image(
            os.path.join(source, "%s.png" % name),
            SPLAT_SIZE,
            SPLAT_SIZE,
            lambda x, y, plane=plane: (
                band(x + plane * 24, 0.0, SPLAT_SIZE / 3),
                band(x + plane * 24, -MASK_RAMP, 2 * SPLAT_SIZE / 3),
                band(x + plane * 24, SPLAT_SIZE / 3, SPLAT_SIZE + MASK_RAMP),
            ),
            file_format="PNG",
        )

    def table_entry(layer, masked):
        entry = {key: value for key, value in layer.items() if not key.startswith("_")}
        if not entry.get("height"):
            entry.pop("height", None)
        if masked:
            entry.update(
                {
                    "channel": "rgb"[(layer["_seed"] - 1) % 3],
                    "hi": 0.55 + 0.1 * (layer["_seed"] % 3),
                    "lo": 0.2,
                    "mask": "mask-%d" % ((layer["_seed"] - 2) // 3),
                }
            )
        return entry

    table = {
        "base": table_entry(layers[0], False),
        "breakup": {"push": 0.12, "scale": 0.08},
        "layers": [table_entry(layer, True) for layer in layers[1:]],
        "macro": {"max": 1.08, "min": 0.92, "scale": 0.02},
        "masks": masks,
        "splatSize": SPLAT_SIZE,
        "textures": {
            "diff": "{id}_diff.jpg",
            "h": "{id}_h.jpg",
            "nrm": "{id}_nrm.jpg",
            "orm": "{id}_orm.jpg",
            "search": ["."],
        },
    }
    table_path = os.path.join(source, "layers.json")
    with open(table_path, "w") as handle:
        json.dump(table, handle, indent=2, sort_keys=True)
        handle.write("\n")

    # The shipped recipe writes splat.rgba8, layers.json and the maps, through the same path a
    # game's DCC export takes.
    sys.path.insert(0, RECIPE)
    import export_world

    paths = export_world.export_terrain_layers(out, table_path, source)

    heights = []
    for row in range(HEIGHT_ROWS):
        for column in range(HEIGHT_COLUMNS):
            metres_x = (column - HEIGHT_COLUMNS / 2) * SPACING
            metres_z = (row - HEIGHT_ROWS / 2) * SPACING
            heights.append(
                int(
                    max(0.0, min(65535.0, 32768.0 + 26000.0 * math.sin(metres_x * 0.06) * math.cos(metres_z * 0.05)))
                )
            )
    with open(os.path.join(out, "terrain", "heightmap.u16"), "wb") as handle:
        handle.write(b"".join(value.to_bytes(2, "little") for value in heights))

    extent = (HEIGHT_COLUMNS - 1) * SPACING
    manifest = {
        "assets": {},
        "cellSize": 64,
        "cells": [],
        "extent": {
            "maxY": 3.0,
            "minY": -3.0,
            "sizeX": extent,
            "sizeZ": extent,
            "minX": -extent / 2,
            "minZ": -extent / 2,
        },
        "placements": "placements.bin",
        "terrain": {
            "columns": HEIGHT_COLUMNS,
            "heightMax": 3.0,
            "heightMin": -3.0,
            "heightmap": "terrain/heightmap.u16",
            "layers": paths,
            "rows": HEIGHT_ROWS,
            "spacing": SPACING,
        },
        "version": 1,
    }
    with open(os.path.join(out, "world.json"), "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    with open(os.path.join(out, "placements.bin"), "wb") as handle:
        handle.write(b"")

    shutil.rmtree(source, ignore_errors=True)
    sys.stdout.write(
        "TN_PRD493_WORLD layers=%d maps=%d splatPlanes=%d out=%s\n"
        % (LAYER_COUNT, LAYER_COUNT * 3 + 2, len(masks), out)
    )


if __name__ == "__main__":
    import shutil

    build(parse_args())
