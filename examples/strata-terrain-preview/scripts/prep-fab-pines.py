"""Strip the licensed Fab Scots pines down to the Temperate starter's triangle and texture budget.

Run headless, once per tree, writing into the example's own ignored folder:

    ~/.local/bin/blender -b --factory-startup --python scripts/prep-fab-pines.py -- \
        --source <fab>/Trees/ScotsPineTall_01/ScotsPineTall_01.glb \
        --out local-assets/prepared --species pine-tall \
        --near 6000 --mid 1500 --far 8 --impostor

What this is, and what it deliberately is not
--------------------------------------------
A driver, not a second implementation. Every measurement, cut and gate it uses
(card connectivity, the front-view coverage rasteriser, the exported-file
triangle gate) already exists in `scripts/prep-trees.py`, which was written
against the CC0 Poly Haven firs; this file imports it and overrides only the
three things the Fab files actually differ in:

  - the source is one self-contained `.glb` rather than a `.gltf` plus a `.bin`,
    so the import and the image extraction are different;
  - the crown is `ScotsPine_01_Leaves_Mat`, which is not in `prep-trees.py`'s
    needle hints, so the material split is named explicitly;
  - the atlas has to be *written out*, not merely unlinked. The CC0 fir's twig
    atlas is committed next to its model in the starter's own asset folder; the
    Fab atlas is licensed and cannot be, so it is downscaled to <=1024^2 and
    written beside the prepared GLBs into the example's gitignored
    `local-assets/prepared/`, and the game binds that copy by path.

The Fab tree is a far better candidate than the CC0 fir and the numbers say why:
ScotsPineTall_01's crown is 22,320 triangles of leaf *cards* 0.28-0.53 m
across, drawn from 116 atlas rects, and the near budget buys 4,800 of them -
about 21% of the crown, which is a crown rather than a haze. The fir was 0.3%.

The trunk is the other half of the answer to "trees still suck". The Fab trunk is
4,742 triangles of *modelled* bark including the root flare and the dead lower
limbs, against the procedural spruce's smooth tapered tube, and it is the part
that carries the eye down to the ground. It is decimated, not dissolved, and
given a cylindrical unwrap so the starter's own bark map still samples on it.

Three levels, and the far one is a cross-card
---------------------------------------------
near <=6000, mid <=1500, far = the 8-triangle four-quad cross impostor
`prep-trees.py` already bakes. The three stay independent copies of the
untouched geometry, so the near level is never a re-export of a thinned crown.

The gate is the EXPORTED FILE
-----------------------------
Every count in the summary comes from reloading the GLB this script just wrote
and parsing its JSON chunk, and the texture sizes from `os.path.getsize` on the
files it just wrote. A level over its triangle budget, a texture over 1024^2 or
over 1 MiB, or a card that rasterised to nothing raises and the script exits
non-zero. Nothing is reported that was not measured on disk.
"""

import argparse
import json
import math
import os
import re
import sys

# `prep-trees.py` has a hyphen in its name, so it is loaded by path rather than
# by `import`. Reusing the module is the whole point: a second copy of the card
# cutter, the coverage rasteriser and the exported-file gate is a second thing to
# keep honest, and this file is only the three things the Fab files differ in.
import importlib.util  # noqa: E402

_PREP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prep-trees.py")
_SPEC = importlib.util.spec_from_file_location("prep_trees", _PREP)
if _SPEC is None or _SPEC.loader is None:
    raise SystemExit(f"prep-fab-pines: cannot load the shared prep module at {_PREP}")
prep_trees = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(prep_trees)

# The height every prepared tree is normalised to, in metres.
#
# ScotsPineTall_01 is authored at 22.1 m and that is not the height the starter grows. Its own
# procedural spruce is twelve to seventeen metres, and the meadow's placement rule scales whatever it
# is given by 0.62 to 1.18 — so the authored tree arrives as a 13.7 to 26.1 m specimen in a meadow of
# 7.4 to 20.1 m ones. At the meadow-close framing, where the eye is at 1.7 m and the nearest tree is
# a few metres away, a 0.36 m needle card on a 22 m tree is a plate across a third of the frame; on a
# 14 m one it is a spray. Scale is a decision about the picture, so it is made here, once, and every
# level, the far card and the reported bounds are in the starter's metres rather than the source's.
TARGET_HEIGHT = 14.0

# The budgets PRD-466 AC-5 holds the starter to, and the far level's own.
NEAR = 6000
MID = 1500
FAR = 8

# How much of the authored front silhouette each level has to keep, as a share
# of the source tree's own coverage rather than an absolute fraction of the
# card. An absolute target is the wrong question on a 22 m spire whose bounding
# box is mostly sky: measured on ScotsPineTall_01 the full tree covers 5.2% of
# a 300x600 card, so no cut could ever reach the CC0 fir's 42% target and the
# gate would fail on a tree that is perfectly good. What has to survive the cut
# is the *silhouette it had*, so both levels are held to a share of the source's
# own coverage: 35% at near, 30% at mid.
#
# And the share is measured at the resolution the level is *looked at*, which is
# the part that matters. A 6,000-triangle crown is 4,800 of the source's 22,320
# cards; rasterised at 37 pixels per metre — a whole 14 m tree in a 512-pixel
# card — the survivors overlap and the crown measures 97% of the source's
# coverage, so the gate passes and nothing is enlarged. Rasterised at 110 pixels
# per metre, which is what a tree three metres from the meadow-close camera is
# actually drawn at, the same crown is a see-through spray. One number, two
# answers, and the one that decides whether the game looks right is the second.
MEASURE_PX_PER_METRE = {"mid": 40, "near": 110}

# The share of the source crown's own silhouette each level has to end up with, measured in
# both elevations.
#
# Both are *shares* rather than absolute fractions because a 22 m spire whose bounding box is
# mostly sky covers a few per cent of its own card, so no absolute target is meaningful across
# species. Both elevations are gated because one is half the problem: a crown stratified across
# its width alone covers a front view at any budget and collapses into a slab seen from the side.
#
# The share is one, not the brief's floor of 60% near and 50% mid. Those floors are satisfied by
# a crown you can see the sky through, and the brief's own instruction is to scale the survivors
# until the silhouette is preserved — a floor just stops the solve early, and stopping early is
# what produced the bare trunk with leaf confetti in the first place. What the triangle budget
# actually costs is card *size*, not silhouette: measured by sweeping the exported near level,
# growing the kept cards 1.33x covers 5.1% of the card, 4x covers 25.7%, and the uncut source
# covers 9.7% — so the silhouette is bought back well inside the cap, and the cap is the thing
# that stops a needle from becoming a plate.
COVERAGE_KEEP = {"mid": 1.0, "near": 1.0}

# How far one card may grow before it stops reading as a needle, per level. The brief's cap is
# three times, which the solve reaches on neither level; the mid level is given more because it
# only ever draws past the near band, where its own cards are a fraction of a pixel across and
# the question is not what a needle looks like but whether the crown covers its silhouette.
prep_trees.CARD_SCALE_MAX = {"mid": 4.0, "near": 3.0}

# Each level's share of its budget spent on the branch structure, and the two are
# not the same number. Up close the branches are what a pine is made of — the
# source tree's crown is mostly brown scaffolding with needles hanging off it — so
# the near level gives them two fifths and spends the rest on leaf cards. At forty
# metres the scaffolding is a handful of pixels and the leaf cards are the whole
# silhouette, so the mid level gives it a fifth and buys 300 more cards with the
# difference. Both figures are what each level's own coverage target is reachable
# at; the log prints what each one reached.
WOOD_SHARE = {"mid": 0.2, "near": 0.2}

# The alpha the game's pine material cuts at, set on the shared rasteriser so the
# prep measures the picture the game draws rather than a stricter one. Kept here as
# a literal rather than imported because the game's copy is in TypeScript; the two
# are the same number and the log prints it so a drift shows up in the run.
PINE_CUTOUT = 0.11

# The texture ceiling, and the size both are held to. 1024 is divisible by four
# so a later mip or block resize never lands on a half texel.
TEXTURE_MAX_PX = 1024
TEXTURE_MAX_BYTES = 1024 * 1024

# Which material is the crown, which is the wood, and which is neither.
#
# Named rather than hinted because the Fab names do not read like the Poly
# Haven ones: `ScotsPine_01_Leaves_Mat` is the alpha-cut leaf atlas,
# `ScotsPine_01_Fronds_Mat` is 252 triangles of dead lower frond that belongs
# with the wood (it is drawn from a bark map, not the atlas), and the two
# `Branches` materials are the trunk and limbs. Anything unrecognised is
# reported and treated as wood, so a renamed upstream material shows up in the log
# rather than silently joining the crown.
CROWN_HINT = "leaves"
WOOD_HINTS = ("branches", "bark", "wood", "fronds", "trunk")


def log(message):
    prep_trees.log(message)


def parse_args(argv):
    if "--" not in argv:
        raise SystemExit("prep-fab-pines: pass arguments after `--`")
    parser = argparse.ArgumentParser(prog="prep-fab-pines")
    parser.add_argument("--source", required=True, help="the licensed .glb, never committed")
    parser.add_argument("--out", required=True, help="gitignored output directory")
    parser.add_argument("--species", required=True, help="stem used in the output names")
    parser.add_argument(
        "--height",
        type=float,
        default=TARGET_HEIGHT,
        help="metres every prepared tree is normalised to",
    )
    parser.add_argument("--near", type=int, default=NEAR)
    parser.add_argument("--mid", type=int, default=MID)
    parser.add_argument("--far", type=int, default=FAR)
    parser.add_argument("--impostor-px", type=int, default=384)
    parser.add_argument("--impostor-height-px", type=int, default=768)
    return parser.parse_args(argv[argv.index("--") + 1 :])


def import_glb(path):
    """Import one self-contained GLB, which is the only shape the Fab ships."""
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)
    if not os.path.isfile(path):
        raise SystemExit(f"prep-fab-pines: no source model at {path}")
    log(f"importing {path}")
    bpy.ops.import_scene.gltf(filepath=path)
    return bpy


def split_materials(objects):
    """The crown objects and the wood objects, by named material.

    `prep_trees.is_needle` keys on the Poly Haven vocabulary and would read
    `ScotsPine_01_Leaves_Mat` correctly by accident but `Fronds` wrongly, so
    the split is stated here rather than inherited.
    """
    crown, wood = [], []
    for obj in objects:
        name = prep_trees.material_names(obj).lower()
        if CROWN_HINT in name:
            crown.append(obj)
            continue
        matched = [hint for hint in WOOD_HINTS if hint in name]
        if not matched:
            raise SystemExit(
                f"prep-fab-pines: {obj.name} has material '{prep_trees.material_names(obj)}', "
                "which is neither crown nor wood; name it here rather than guess"
            )
        log(f"wood by '{matched[0]}': {obj.name}")
        wood.append(obj)
    if not crown:
        raise SystemExit("prep-fab-pines: the tree has no leaf crown material")
    if not wood:
        raise SystemExit("prep-fab-pines: the tree has no trunk")
    return crown, wood


def write_atlas(out_dir, species, material, max_px, max_bytes):
    """The crown's own base-colour atlas, downscaled to the budget, written to disk.

    The licensed bytes never enter the repository, so the prepared GLB carries no
    texture at all and this file is the only copy the game loads. Downscaled
    because the source is 2048^2 and 1.8 MB: the crown is 116 atlas rects spread
    over a 22 m tree, and at the near band's 22 m a rect is a few hundred texels
    on screen, so 1024^2 is not the limit that shows.

    Written as PNG rather than JPEG because the alpha channel *is* the cutout:
    a JPEG of this atlas has no alpha at all and the crown becomes a rectangle.
    """
    import bpy
    import numpy as np

    image = None
    for node in prep_trees.material_nodes(material):
        candidate = getattr(node, "image", None)
        if candidate is None:
            continue
        if not candidate.has_data:
            candidate.reload()
        if candidate.size[0] > 0:
            image = candidate
            break
    if image is None:
        raise SystemExit("prep-fab-pines: the crown material has no base-colour image")
    width, height = image.size
    pixels = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(pixels)
    pixels = pixels.reshape(height, width, 4)

    if max(width, height) > max_px:
        # Box-average down to the ceiling. A `bpy` scale would be one call, but it
        # resamples through the image's own colour space and the alpha edge is
        # what the cutout reads, so the average is taken on the raw samples.
        factor_w = width // max_px if width >= height else 1
        factor_h = height // max_px if height > width else 1
        factor = max(factor_w, factor_h)
        if factor > 1:
            trimmed = pixels[: height - height % factor, : width - width % factor]
            pixels = (
                trimmed.reshape(height // factor, factor, width // factor, factor, 4)
                .mean(axis=(1, 3))
                .astype(np.float32)
            )
            height, width = pixels.shape[:2]
    if max(width, height) > max_px:
        raise SystemExit(
            f"prep-fab-pines: atlas is {width}x{height} after the box average; the "
            f"source dimensions do not divide down to {max_px}"
        )

    name = f"{species}-atlas.png"
    path = os.path.join(out_dir, name)
    os.makedirs(out_dir, exist_ok=True)

    # The two Fab pines draw their crowns from the *same* atlas upstream — the
    # same bytes — so the second run finds the first run's file, compares it and
    # reuses it rather than writing a second identical 683 KB copy the game would
    # load once. Compared on the downsampled samples, because that is what is on
    # disk and what the game samples, and compared to within a quantisation step
    # rather than exactly: the file went out as 8-bit sRGB and came back as
    # linear floats, so an exact test can never pass and would silently write the
    # duplicate this is here to avoid.
    for existing in sorted(os.listdir(out_dir)):
        if not existing.endswith("-atlas.png") or existing == name:
            continue
        other = bpy.data.images.load(os.path.join(out_dir, existing))
        if not other.has_data:
            other.reload()
        identical = (
            other.size[0] == width
            and other.size[1] == height
            and float(np.abs(np.asarray(other.pixels[:]) - pixels.reshape(-1)).max())
            <= 1.5 / 255.0
        )
        bpy.data.images.remove(other)
        if identical:
            log(f"atlas: {existing} is already this tree's atlas; reusing it")
            return {
                "name": existing,
                "path": os.path.join(out_dir, existing),
                "shared": True,
                "size": os.path.getsize(os.path.join(out_dir, existing)),
                "width": width,
                "height": height,
            }

    written = bpy.data.images.new(name, width=width, height=height, alpha=True)
    written.colorspace_settings.name = "sRGB"
    written.pixels.foreach_set(np.ascontiguousarray(pixels, dtype=np.float32).reshape(-1))
    written.filepath_raw = path
    written.file_format = "PNG"
    written.save()
    bpy.data.images.remove(written)
    size = os.path.getsize(path)
    log(f"atlas: {name} {width}x{height}, {size} bytes (source {image.size[0]}x{image.size[1]})")
    if size > max_bytes:
        raise SystemExit(
            f"prep-fab-pines: {name} is {size} bytes, over the {max_bytes} texture budget"
        )
    if max(width, height) % 4 != 0:
        raise SystemExit(f"prep-fab-pines: {name} is {width}x{height}, not divisible by four")
    return {
        "name": name,
        "path": path,
        "shared": False,
        "size": size,
        "width": width,
        "height": height,
    }


def atlas_view(atlas):
    """The prepared atlas as the linear float array `rasterise_front` samples.

    Read back from the file just written rather than reused from the source
    image, so the coverage the prep measures is the coverage of the bytes the
    game will load. Measuring the 2048 source would flatter the cut.
    """
    import bpy
    import numpy as np

    image = bpy.data.images.load(atlas["path"])
    if not image.has_data:
        image.reload()
    width, height = image.size
    pixels = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(height, width, 4), width, height


def card_size(width_m, height_m, long_px):
    """The far card's pixel size, holding the tree's own aspect.

    The shared bake takes a fixed width and height, which silently assumes every
    tree is a portrait: a card baked 384x768 for a pine that is 18 m across and
    13 m tall is a portrait picture of a landscape tree, and the quad it is drawn
    on has to be squashed to match or the far band shows a pine three times too
    narrow. Sized from the tree instead, on the long side, and rounded to a
    multiple of four like every other texture here.
    """
    if width_m >= height_m:
        width = long_px
        height = max(4, int(round(long_px * height_m / width_m / 4)) * 4)
    else:
        height = long_px
        width = max(4, int(round(long_px * width_m / height_m / 4)) * 4)
    return width, height


# The crown's inner mass: a lathe of fifty triangles, joined into the crown's own mesh.
#
# A pine's crown is 12% needle by area out of an atlas that is 12% opaque, and that is
# the arithmetic behind every "airy spray" in the captures. Growing cards fixes the
# *silhouette* — the previous round's 100% coverage measurement — and cannot fix the
# *interior*, because the interior is a property of how much solid colour the atlas
# carries, not of how many cards are drawn: at the near band's twenty-two metres the
# cards are already big enough that growing them more only bleaches their own alpha.
#
# So the missing half of a conifer is added as geometry. It costs fifty triangles out
# of six thousand, and it costs *no draw*: it is joined into the crown mesh before the
# export, so it is the crown's own primitive, in the crown's own batch, with the crown's
# own material. What it samples is the one trick here — see `solid_texel_uv`.
MASS_SEGMENTS = 14

# Radius at each ring, base to apex. A conifer is widest just above its lowest limbs
# and tapers from there, so this is a crown's profile and not a cone's: a cone has a
# straight silhouette and reads as a party hat the moment it is visible at all.
MASS_PROFILE = ((0.0, 1.0), (0.26, 0.94), (0.55, 0.62), (0.8, 0.3), (1.0, 0.0))

# How much of the crown's own width the mass spans, and how far up the crown it starts.
# Inside the envelope on purpose: the sprays are the outside of a pine and this is its
# dark interior, so anything of the volume that pokes through a card is a bug in the fit.
# A fifth, and measured rather than guessed. At a third of the crown's width the volume is
# opaque enough to *be* the silhouette: the captures came back with faceted olive kites
# where the pines were, which is the same "geometric blob" failure the far band had, one
# scale in. A fifth is a dark core the sprays hang off and only ever shows through the gaps
# between cards, which is the whole point of it.
MASS_WIDTH = 0.18
MASS_BASE = 0.16

# How far each ring's radius wobbles, per segment. Deterministic, so a re-run bakes the
# same tree: a lathe whose silhouette is a perfect curve says "geometry" at every
# distance, and the ten degrees of wobble is the difference between a pine and a cone.
MASS_WOBBLE = 0.1


def solid_texel_uv(atlas, score):
    """One opaque texel of the atlas, as the UV every vertex of a solid volume collapses onto.

    `score` ranks a candidate by its linear colour and returns "lower is better". Only
    fully opaque texels are eligible, because a volume that samples a half-empty one is
    a volume with holes in it.

    Collapsing the UVs onto a single texel is what makes the volume work, and it is a
    property of the *derivative*: a quad whose four corners carry the same UV has a UV
    footprint of zero, so the sampler stays on mip zero at any distance. A volume with a
    real UV rect behaves like a card does — its alpha minifies into the atlas average the
    moment the tree is thirty metres away, which is the entire failure this volume exists
    to repair, so a volume with a real UV rect would fail at exactly the distance it was
    added for.
    """
    import numpy as np

    pixels, width, height = atlas
    flat = pixels.reshape(-1, 4)
    eligible = np.flatnonzero(flat[:, 3] >= 0.95)
    if eligible.size == 0:
        raise SystemExit("prep-fab-pines: the atlas carries no opaque texel to cut a solid volume from")
    colours = flat[eligible, :3]
    winner = int(eligible[int(np.argmin(score(colours, colours.max(axis=1))))])
    row, column = divmod(winner, width)
    # `atlas_view` hands back Blender's bottom-up buffer, and glTF's V runs the other
    # way, so the row is flipped here rather than in both callers.
    return ((column + 0.5) / width, 1.0 - (row + 0.5) / height)


def crown_mass(crown, uv, material):
    """The dark volume inside a crown's own envelope, collapsed onto one atlas texel.

    `material` is the crown's own, and it is not optional: a mesh that joins the crown
    carrying no material is exported as a second primitive of the same mesh, and the
    starter's role is read from the *material name*, so an unnamed primitive comes back
    as `stone` — a mossy rock inside every pine, and two more draws than the ceiling has
    room for. Sharing the slot is what keeps it one primitive, one role and one draw.
    """
    import bpy

    lo, hi = prep_trees.bounds(crown)
    height = max(hi[2] - lo[2], 1e-6)
    base = lo[2] + height * MASS_BASE
    radius = max(hi[0] - lo[0], hi[1] - lo[1]) * MASS_WIDTH
    centre = ((lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5)
    vertices = []
    rings = []
    for fraction, width in MASS_PROFILE:
        z = base + height * (1.0 - MASS_BASE) * fraction
        if width <= 0.0:
            rings.append([len(vertices)])
            vertices.append((centre[0], centre[1], z))
            continue
        ring = []
        for step in range(MASS_SEGMENTS):
            angle = step * 2.0 * math.pi / MASS_SEGMENTS
            # Strongest at the base: a pine's lowest branches are the ragged edge of its
            # crown, and a lathe that starts on a level ring draws a shelf across it.
            r = radius * width * (
                1.0
                + MASS_WOBBLE
                * (1.0 + 2.0 * (1.0 - fraction))
                * math.sin(step * 2.3 + fraction * 11.0)
            )
            ring.append(len(vertices))
            vertices.append(
                (centre[0] + r * math.cos(angle), centre[1] + r * math.sin(angle), z)
            )
        rings.append(ring)
    faces = []
    for index in range(len(rings) - 1):
        lower, upper = rings[index], rings[index + 1]
        for step in range(MASS_SEGMENTS):
            following = (step + 1) % MASS_SEGMENTS
            if len(upper) == 1:
                faces.append((lower[step], lower[following], upper[0]))
                continue
            faces.append((lower[step], lower[following], upper[following]))
            faces.append((lower[step], upper[following], upper[step]))
    mesh = bpy.data.meshes.new("mass")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    for polygon in mesh.polygons:
        # Smooth, because a fourteen-sided lathe shaded flat is a faceted solid and the
        # facets are the one thing about it that cannot be called foliage.
        polygon.use_smooth = True
    layer = mesh.uv_layers.new(name="UVMap")
    for entry in layer.data:
        entry.uv = uv
    obj = bpy.data.objects.new("mass", mesh)
    bpy.context.scene.collection.objects.link(obj)
    prep_trees.assign_material(obj, material)
    return obj


def flat_copy(obj, name, uv):
    """`obj` again with every UV collapsed onto one texel, so it rasterises as a solid.

    The far card is a *picture*, and a picture of a tree has to contain its trunk: the
    card is the only representation a tree past the last band has, so a card baked from
    the crown's atlas alone is a crown hanging in the air three metres above the ground
    with nothing holding it up. That is exactly what the round-2 captures show, and the
    cause is not the placement — every level's exported geometry has its base at y=0
    (near -0.0004 m, mid 0.0000 m, impostor 0.0000 m, measured on the files themselves).
    It is that `rasterise_front` cuts against the *leaf* atlas, and the trunk's bark
    unwrap samples that atlas at random and rasterises to nothing.

    So the impostor bake re-points the real trunk at an opaque bark-coloured texel and
    lets the shared rasteriser draw it. Modelled trunk, modelled root flare, no extra
    geometry in the exported file, and the card stops being a blob.
    """
    import bpy

    copy = bpy.data.objects.new(name, obj.data.copy())
    copy.matrix_world = obj.matrix_world.copy()
    bpy.context.scene.collection.objects.link(copy)
    layer = copy.data.uv_layers.active or copy.data.uv_layers.new(name="UVMap")
    for entry in layer.data:
        entry.uv = uv
    copy.data.update()
    return copy


def bake_impostor(args, objects, top, bottom, atlas, width_m, height_m):
    """The far cross-card: the *uncut* crown, supersampled and area-averaged.

    Three things the shared bake cannot know about this tree.

    It bakes from whatever is in the scene when it runs, which for the CC0 path is
    the finished near level. That is the wrong tree here. A far card is a picture
    of a whole crown, and the near level is a fifth of one: at 4,800 of 22,320
    cards the crown has holes everywhere, and a 0.36 m card is about a dozen
    pixels across on a card of a 22 m tree, so each of those pixels picks one
    texel out of the fifty its footprint covers and the cut crown bakes down to
    almost nothing. The uncut crown overlaps itself often enough to survive the
    same minification, which is the whole reason a card of the *source* reads as
    a tree where a card of the cut does not. It is baked from the source, and it
    is two triangles a view whatever it was made of.

    Its floor is an absolute fraction of the card, calibrated on a broad fir
    crown that fills its own bounding box. A tree's share of its own card is a
    function of its aspect, so the floor is set here against the *same* scene at
    the card's own size — the only comparison that survives a change of species.

    And it is rasterised at three times the card size and box-averaged down with
    alpha-weighted colour, because the rasteriser samples nearest-texel and a
    sparse cutout has to be area-averaged to become a card at all. The game's own
    coverage ramp then takes the averaged alpha the rest of the way to solid.
    """
    import numpy as np

    scale = 3
    card_px = card_size(width_m, height_m, args.impostor_px)
    reference = prep_trees.rasterise_front(
        objects, card_px[0], card_px[1], atlas, top, bottom
    )[1]
    card, _coverage, triangles, width, height = prep_trees.rasterise_front(
        objects, card_px[0] * scale, card_px[1] * scale, atlas, top, bottom
    )
    blocks = card.reshape(card_px[1], scale, card_px[0], scale, 4)
    # The colour of a partly covered pixel is the average of the texels under it
    # *weighted by their own alpha*. A flat average of an RGBA bleaches the edge
    # towards the colour of the transparent texels around the needle, and a pine's
    # edge is where the rim light lives.
    alpha = blocks[:, :, :, :, 3:4].mean(axis=(1, 3))
    premultiplied = (blocks * blocks[:, :, :, :, 3:4]).mean(axis=(1, 3))
    averaged = np.empty_like(premultiplied)
    covered = alpha > 1e-5
    averaged[:, :, :3] = np.where(
        covered, premultiplied[:, :, :3] / np.maximum(alpha, 1e-5), 0.0
    )
    averaged[:, :, 3] = alpha[:, :, 0]
    coverage = float((averaged[:, :, 3] >= prep_trees.NEEDLE_CUTOUT).mean())
    solid = float((alpha[:, :, 0] > 0.02).mean())
    log(
        f"impostor: {triangles} triangles at {card_px[0] * scale}x{card_px[1] * scale}, "
        f"averaged to {card_px[0]}x{card_px[1]}, {coverage * 100:.2f}% of the card over "
        f"the cutoff and {solid * 100:.2f}% carrying any alpha at all, against "
        f"{reference * 100:.2f}% at full resolution; {round(width, 2)} m wide on a "
        f"{round(height, 2)} m tree"
    )
    if solid < reference * 0.8:
        raise SystemExit(
            f"prep-fab-pines: the impostor card carries alpha over {solid * 100:.2f}% of "
            f"itself, under 80% of the {reference * 100:.2f}% the same tree covers"
        )
    # The card is written upside down, and the gate is how that stopped being invisible.
    #
    # `write_card` hands the array to Blender's bottom-up pixel buffer, so the raster's
    # row 0 lands at the *bottom* of the file — and `rasterise_front` puts the top of the
    # tree in row 0. Measured on round 2's own file: the alpha ran from 24% below the top
    # to 11% above the base, which is the two ends exchanged; a Scots pine's crown is its
    # top two thirds and its bare trunk is the bottom quarter, and the file had them the
    # wrong way round. The game samples this card with `flipY` set, so the file's bottom
    # row is the quad's bottom corner, so the far band has been drawing every distant
    # pine upside down with its crown in the air and its leader on the ground.
    #
    # Which is most of what the overview capture's "dark blobs floating in the air" was.
    # Not the placement: every level's exported geometry has its base at y=0, measured on
    # the files themselves (near -0.0004 m, mid 0.0000 m, impostor 0.0000 m).
    rows = np.flatnonzero((averaged[:, :, 3] >= 0.5).any(axis=1))
    if rows.size == 0:
        raise SystemExit("prep-fab-pines: the impostor card rasterised to nothing at all")
    top_gap = float(rows[0]) / averaged.shape[0]
    bottom_gap = float(averaged.shape[0] - 1 - rows[-1]) / averaged.shape[0]
    log(
        f"impostor: silhouette from {top_gap * 100:.1f}% below the card's top to "
        f"{bottom_gap * 100:.1f}% above its base"
    )
    if bottom_gap > 0.04:
        raise SystemExit(
            f"prep-fab-pines: the impostor card stops {bottom_gap * 100:.1f}% short of its own "
            "base, so the far band draws a crown hanging in the air with nothing under it"
        )
    if top_gap > 0.2:
        raise SystemExit(
            f"prep-fab-pines: the impostor card's silhouette starts {top_gap * 100:.1f}% below "
            "its own top, so the far band draws a pine with no leader"
        )
    name = f"{args.species}-impostor.png"
    prep_trees.write_card(averaged[::-1], os.path.join(args.out, name))
    size = os.path.getsize(os.path.join(args.out, name))
    log(f"impostor: {name} {card_px[0]}x{card_px[1]}, {size} bytes")
    if size > TEXTURE_MAX_BYTES:
        raise SystemExit(f"prep-fab-pines: {name} is {size} bytes, over the texture budget")
    # The quad has to be the card's own aspect or the far band draws a squashed
    # tree; the rasteriser fitted the tree into the card, so the card's metres are
    # the tree's metres and the quad takes them directly.
    return name, height * card_px[0] / card_px[1]


# The linear colours the two solid texels are chosen to be *nearest*, measured off the
# atlas's own opaque texels rather than picked: the opaque needles run from linear 0.041
# (5th percentile) through 0.063/0.060/0.019 (25th) to 0.112/0.084/0.025 (median), and
# the crown's own shading multiplies the sampled colour by `PINE_LOOK.tint` before the
# frame is lit. So the target is a percentile of the atlas rather than a colour someone
# liked: the mass wants the 25th percentile's green and the trunk a bark brown below it.
MASS_TINT = (0.046, 0.042, 0.013)
TRUNK_TINT = (0.055, 0.035, 0.013)


def main(argv):
    args = parse_args(argv)
    bpy = import_glb(args.source)

    objects = prep_trees.mesh_objects()
    if not objects:
        raise SystemExit("prep-fab-pines: the model imported no geometry")
    log(f"{len(objects)} mesh objects, {sum(prep_trees.triangle_count(o) for o in objects)} triangles before")

    # The Fab ships one prop per file, so there is no variant to choose. Isolating
    # to a single object anyway keeps the rest of the pipeline (one wood, one
    # crown) identical to the CC0 path rather than a second code path.
    prep_trees.isolate(objects, objects[0])
    objects = prep_trees.separate_by_material(prep_trees.mesh_objects())
    crown_objects, wood_objects = split_materials(objects)
    log(
        f"crown {len(crown_objects)} objects "
        f"({', '.join(sorted({prep_trees.material_names(o) for o in crown_objects}))}), "
        f"wood {len(wood_objects)} objects "
        f"({', '.join(sorted({prep_trees.material_names(o) for o in wood_objects}))})"
    )

    wood = prep_trees.join(wood_objects, "wood")
    wood.data.name = "wood"
    prep_trees.assign_material(wood, prep_trees.solid_material("TN_bark"))
    # The trunk keeps its own UVs when it has usable ones: the Fab bark is a real
    # tiling unwrap, and a cylindrical re-wrap would trade a correct plate scale
    # for a seam on a mesh that is mostly hidden inside the crown anyway.
    if not wood.data.uv_layers:
        prep_trees.cylindrical_uv(wood, 1.0)
    prep_trees.strip_attributes(wood, keep_uv=True)

    crown = prep_trees.join(crown_objects, "crown")
    crown.data.name = "crown"
    prep_trees.strip_attributes(crown, keep_uv=True)
    crown_material = next(slot.material for slot in crown.material_slots if slot.material)
    atlas = write_atlas(args.out, args.species, crown_material, TEXTURE_MAX_PX, TEXTURE_MAX_BYTES)
    # The licensed bytes stay out of the GLB: the maps ship as files beside it.
    prep_trees.unlink_images(crown)

    # Normalised to the starter's own tree height before anything is measured or cut, so the
    # coverage figures, the card sizes, the far quad and the reported bounds are all in the metres
    # the meadow is actually built in. Uniform, and about the tree's own base, so nothing about its
    # proportions changes — only how many metres tall it is.
    authored_lo, authored_hi = prep_trees.scene_bounds()
    authored_height = max(authored_hi[2] - authored_lo[2], 1e-6)
    factor = args.height / authored_height
    from mathutils import Matrix

    for obj in (wood, crown):
        obj.data.transform(Matrix.Diagonal((factor, factor, factor, 1.0)))
        obj.data.update()
    # `bound_box` is cached on the object and only recomputed when the depsgraph
    # runs, so without this every measurement below fits its card to the tree's
    # *authored* 22.1 m while the vertices are already 14 m: the source coverage
    # is measured on a clipped tree and every level after it is judged against a
    # baseline that is wrong by the square of the scale factor.
    bpy.context.view_layer.update()
    log(
        f"scale: {authored_height:.2f} m authored -> {args.height:.2f} m "
        f"(x{factor:.4f}), base at y={authored_lo[2]:.3f}"
    )

    lo, hi = prep_trees.scene_bounds()
    height = max(hi[2] - lo[2], 1e-6)
    log(f"source: wood {prep_trees.triangle_count(wood)}, crown {prep_trees.triangle_count(crown)}, height {height:.2f} m")

    # The coverage the cut has to keep, measured on the untouched model at each
    # level's own resolution, so the bar a level is held to is the source tree
    # drawn the way that level is drawn. Taken before anything is cut and from the
    # prepared atlas rather than the 2048 source, so the number describes the bytes
    # the game will sample.
    setattr(prep_trees, "CUTOUT", PINE_CUTOUT)
    log(f"cutout: measuring at {PINE_CUTOUT}, the alpha the game's pine material cuts at")
    source_atlas = atlas_view(atlas)
    prep_trees.ATLAS[0] = source_atlas
    prep_trees.TOP[0], prep_trees.BOTTOM[0] = hi[2], lo[2]

    # The two solid texels the volumes cut from, found once and reused by all three
    # levels. Green for the crown's interior and bark-brown for the trunk, both from the
    # same opaque pool and both scored for a mid-dark peak rather than the darkest texel
    # available: the pine's material lifts a texel by `floor / peak`, so a texel darker
    # than the floor comes back *multiplied*, and a volume cut from the darkest needle in
    # the atlas is a brighter cone than the crown it is supposed to sit inside.
    import numpy as np

    mass_uv = solid_texel_uv(source_atlas, lambda colour, _peak: abs(colour - MASS_TINT).sum(axis=1))
    trunk_uv = solid_texel_uv(source_atlas, lambda colour, _peak: abs(colour - TRUNK_TINT).sum(axis=1))
    for label, uv in (("mass", mass_uv), ("trunk", trunk_uv)):
        texel = source_atlas[0][
            min(int((1.0 - uv[1]) * source_atlas[1]), source_atlas[1] - 1),
            min(int(uv[0] * source_atlas[2]), source_atlas[2] - 1),
        ]
        log(
            f"solid {label}: atlas texel at uv {uv[0]:.5f},{uv[1]:.5f} is linear "
            f"({texel[0]:.4f}, {texel[1]:.4f}, {texel[2]:.4f}) at alpha {texel[3]:.2f}"
        )
    # Both elevations, because one is a picture of half the problem. A crown stratified
    # only across its width covers a front view at any budget and collapses into a slab
    # seen from the side; ScotsPineTall_01's crown is nearly as deep as it is wide, so
    # the side view is where a cut that has quietly become a wall shows up.
    source_coverage = {}
    for level, px_per_metre in MEASURE_PX_PER_METRE.items():
        px = int(height * px_per_metre)
        for view in ("front", "side"):
            _card, coverage, _t, _w, _h = prep_trees.rasterise_front(
                [crown],
                max(64, px // 2),
                px,
                source_atlas,
                hi[2],
                lo[2],
                side=view == "side",
            )
            source_coverage[(level, view)] = coverage
            log(
                f"source: {view} coverage {coverage * 100:.2f}% at {px_per_metre} px/m "
                f"({max(64, px // 2)}x{px})"
            )

    pristine = {"wood": wood.data.copy(), "crown": crown.data.copy()}
    source_wood = prep_trees.triangle_count(wood)
    source_crown = prep_trees.triangle_count(crown)
    results = {}
    for level, budget in (("mid", args.mid), ("near", args.near)):
        for obj in (wood, crown):
            obj.data = pristine[obj.name].copy()
        lo, hi = prep_trees.scene_bounds()
        prep_trees.TOP[0], prep_trees.BOTTOM[0] = hi[2], lo[2]

        # Where the budget goes, and it is not where the first guess put it.
        #
        # A pine is not a trunk with a hat of leaves on it. Measured on
        # ScotsPineTall_01, the source tree's crown is 2.9% opaque and the cut that
        # spends four fifths of its budget on leaf cards is 1.9% — but the source's
        # *look* is mostly the brown: its 5,504 triangles of branches and twigs are
        # the scaffolding the needles hang from, and a cut that keeps only the
        # biggest few hundred of them loses the dark spiky mass that makes the tree
        # read as a pine rather than as a spray. So two fifths goes to the wood,
        # thinned by part size so the trunk and the main limbs survive, and the
        # crown makes do with the rest and enlarges its survivors to compensate.
        #
        # Thinned *before* collapsed, and the order matters: a tree's branches are
        # thousands of loose shells sharing no vertices, so collapsing them first
        # merges the shells into metre-wide flat facets and leaves the part ranking
        # nothing to choose between. Ranking by size and keeping the biggest is the
        # cut a person makes to a tree that is too detailed.
        prep_trees.thin_solid(wood, int(budget * WOOD_SHARE[level]))
        prep_trees.decimate_to(wood, int(budget * WOOD_SHARE[level]), "wood")
        prep_trees.smooth(wood)
        log(f"{level}: wood {prep_trees.triangle_count(wood)} after thinning")

        px_per_metre = MEASURE_PX_PER_METRE[level]
        px = int(height * px_per_metre)
        card_px = (max(64, px // 2), px)
        views = ((card_px[0], card_px[1], False), (card_px[0], card_px[1], True))

        def coverage(side):
            return prep_trees.rasterise_front(
                [crown], card_px[0], card_px[1], source_atlas, prep_trees.TOP[0],
                prep_trees.BOTTOM[0], side=side,
            )[1]

        before = {"front": coverage(False), "side": coverage(True)}
        # The mass comes out of the crown's own share rather than on top of the budget:
        # `export_level` re-reads the file it wrote and fails on any triangle over the cap,
        # so fifty triangles added after the cut would fail the gate rather than trade
        # against fifty cards. The cards lose exactly the mass's cost, which is under one
        # per cent of the level and inside the solve's own slack.
        mass_budget = MASS_SEGMENTS * (2 * (len(MASS_PROFILE) - 2) + 1)
        stats = prep_trees.thin_needles(
            crown, budget - prep_trees.triangle_count(wood) - mass_budget
        )
        # The target is the *worse* of the two elevations, so the solve cannot buy a full
        # front view with a bare side one, and the gate below cannot be passed by a crown
        # that has collapsed into a slab.
        target = min(source_coverage[(level, view)] for view in ("front", "side")) * COVERAGE_KEEP[level]
        # Solved, not applied once. Coverage is not proportional to card area — the
        # survivors already overlap, so growing them by 1.25 in length buys well
        # under 1.25 squared in covered pixels — and one pass therefore lands short
        # of the target on a crown this sparse. Each pass re-measures from the
        # geometry as it now stands, so the loop converges, and it stops on its own
        # because `enlarge_cards` never shrinks and returns a factor of one once the
        # target is met.
        grown = {"cards": 0, "scale": 1.0}
        kept = {"front": 0.0, "side": 0.0}
        best = 0.0
        for attempt in range(20):
            grown = prep_trees.enlarge_cards(target, level, views)
            kept = {"front": coverage(False), "side": coverage(True)}
            share = {
                view: kept[view] / source_coverage[(level, view)]
                if source_coverage[(level, view)] > 1e-9
                else 0.0
                for view in kept
            }
            log(
                f"{level}: enlargement pass {attempt + 1} reached "
                f"front {share['front'] * 100:.1f}% / side {share['side'] * 100:.1f}% of source "
                f"(target {COVERAGE_KEEP[level] * 100:.0f}%)"
            )
            # Stop on the target, on a pass that grew nothing, or on a pass that stopped
            # moving: past that point the surviving cards are as dense as this many of them
            # can get and growing them further only averages their own alpha away. The
            # stall margin is a tenth of a per cent because the last pass is usually worth
            # a few hundredths — coverage grows more slowly than card area does, so a
            # one-per-cent plateau is a real plateau and a tenth of one is still progress.
            if min(share.values()) >= COVERAGE_KEEP[level] or grown["scale"] <= 1.0 or (
                min(kept.values()) <= best * 1.001
            ):
                break
            best = min(kept.values())
        stats.update(grown)
        stats["pxPerMetre"] = px_per_metre
        stats["sourceCoverage"] = {
            view: round(source_coverage[(level, view)], 5) for view in ("front", "side")
        }
        stats["coverageBeforeCards"] = {view: round(before[view], 5) for view in before}
        stats["coverage"] = {view: round(kept[view], 5) for view in kept}
        stats["coverageKept"] = {
            view: round(
                kept[view] / source_coverage[(level, view)]
                if source_coverage[(level, view)] > 1e-9
                else 0.0,
                4,
            )
            for view in kept
        }
        # A per cent of slack, because the solve converges from below and a hundred per
        # cent measured in floats is a rounding away from failing.
        worst = min(stats["coverageKept"].values())
        if worst < COVERAGE_KEEP[level] * 0.99:
            raise SystemExit(
                f"prep-fab-pines: the {level} level keeps "
                + ", ".join(f"{view} {value * 100:.1f}%" for view, value in stats["coverageKept"].items())
                + f" of the source silhouette, under its {COVERAGE_KEEP[level] * 100:.0f}% gate"
            )
        log(
            f"{level}: crown {stats['triangles']} triangles in {stats.get('cards_kept')} cards, "
            f"enlarged {stats.get('scale')}x, silhouette "
            + " / ".join(f"{view} {value * 100:.1f}%" for view, value in stats["coverageKept"].items())
            + f" of source at {px_per_metre} px/m (gate {COVERAGE_KEEP[level] * 100:.0f}%)"
        )

        prep_trees.stand_on_ground()
        lo, hi = prep_trees.scene_bounds()
        # Joined in *after* the coverage gate, because the gate is about the cards: the
        # mass has full coverage by construction and would pass any silhouette bar while
        # saying nothing about the cut. It is fitted to the cut crown's own bounds, so
        # what the solve kept is what the volume sits inside.
        mass = crown_mass(crown, mass_uv, crown_material)
        crown = prep_trees.join([crown, mass], "crown")
        crown.data.name = "crown"
        stats["massTriangles"] = mass_budget
        stats["boundsMetres"] = [round(v, 4) for v in (*lo, *hi)]
        stats["heightM"] = round(hi[2] - lo[2], 4)
        stats.update(
            prep_trees.export_level(
                os.path.join(args.out, f"{args.species}-{level}.glb"), budget, level
            )
        )
        results[level] = stats

    # The far card is baked last, from the source geometry, because a card of the
    # cut crown is a picture of a fifth of a tree. The levels are already written
    # and measured, so putting the untouched meshes back costs nothing but makes
    # the bake honest.
    for obj in (wood, crown):
        obj.data = pristine[obj.name].copy()
    lo, hi = prep_trees.scene_bounds()
    prep_trees.TOP[0], prep_trees.BOTTOM[0] = hi[2], lo[2]
    # The card is a picture of a whole tree, so the picture gets a whole tree: the
    # uncut crown's sprays, the mass that gives them something to hang off, and the
    # trunk re-pointed at an opaque bark texel so the cross-card is a pine standing on
    # the ground rather than a crown hanging in the air three metres above it.
    impostor_parts = [
        crown,
        crown_mass(crown, mass_uv, crown_material),
        flat_copy(wood, "impostor_wood", trunk_uv),
    ]
    card, quad_width = bake_impostor(
        args,
        impostor_parts,
        hi[2],
        lo[2],
        atlas_view(atlas),
        hi[0] - lo[0],
        hi[2] - lo[2],
    )
    prep_trees.cross_card_geometry(args, hi[2], lo[2], quad_width)
    written, per_mesh, images, size = prep_trees.count_exported(
        os.path.join(args.out, f"{args.species}-impostor.glb")
    )
    if written > args.far:
        raise SystemExit(
            f"prep-fab-pines: the impostor is {written} triangles, over its {args.far} budget"
        )
    log(f"impostor: {written} triangles in {per_mesh} ({size} bytes), images {images}")
    results["impostor"] = {
        "bytes": size,
        "card": card,
        "quadWidthMetres": round(quad_width, 3),
        "tris": args.far,
        "triangles": written,
    }

    summary = {
        "atlas": {
            "bytes": atlas["size"],
            "name": atlas["name"],
            "pixels": [atlas["width"], atlas["height"]],
            "shared": atlas["shared"],
        },
        "budgets": {"far": args.far, "mid": args.mid, "near": args.near},
        "source": {
            "crownTriangles": source_crown,
            "coverage": {
                f"{level}-{view}": round(value, 5)
                for (level, view), value in source_coverage.items()
            },
            "heightM": round(height, 3),
            "model": os.path.basename(args.source),
            "woodTriangles": source_wood,
        },
        "species": args.species,
        "levels": results,
    }
    os.makedirs(args.out, exist_ok=True)
    # Same one-line short arrays `prep-trees.py` collapses, so a re-run leaves a
    # summary the repository's own formatter is already happy with.
    text = re.sub(
        r"\[\s+([^\[\]]+?)\s+\]",
        lambda m: "[" + " ".join(m.group(1).split()) + "]",
        json.dumps(summary, indent=2, sort_keys=True),
        flags=re.S,
    )
    with open(os.path.join(args.out, f"{args.species}-prep.json"), "w", encoding="utf-8") as handle:
        handle.write(text + "\n")
    log("done: " + json.dumps(results, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
