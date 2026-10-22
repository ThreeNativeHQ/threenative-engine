"""PRD-649 shadow calibration scene `foliage`: leaf cards that cast leaf-shaped shadows, and card grass.

Serves PRD-651 (the shadow of an alpha-tested leaf card) and PRD-643 (the bounce light on leaves). A
tree stands over open ground: a 0.3 x 3 x 0.3 m trunk and 8 leaf cards, 1.8 x 1.8 m, two-sided,
cut by leaf.png. The cards sit 2.5 to 4.5 m up on a disc of about 4 m, each with its own yaw and tilt,
so the ground shadow holds gaps between the cards and the gaps inside each card. A pawn stand-in box
stands 3 m from the trunk, and 12 upright card-grass quads (0.4 x 0.5 m, grass.png) ring its feet.
The lighting is Unreal's default template, one level per sun, as in penumbra-lab.

Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back. A card is
a quad in the actor's local XY plane, so it stands upright with its front face toward +z. Its tilt
(rotationXDeg) turns it about its own x axis first, then rotationYDeg turns it about the vertical.
The sun is on +x: the shadows fall toward -x, across the camera's view.

The textures come from make_leaf.py: white RGB with an alpha mask. The material colour tints them.
"""

import math

TREE = (3.0, -2.0)  # x, z of the trunk
PAWN = (3.0, 1.0)  # 3 m from the trunk

# A masked, two-sided material is a glTF alphaMode MASK with doubleSided true (the exporter reads the
# material instance's blend mode, two-sided flag and clip value; the texture is a proxy parameter).
BARK = {"baseColor": [0.22, 0.15, 0.09], "roughness": 1.0, "metallic": 0.0}
LEAF = {"baseColor": [0.10, 0.28, 0.05], "roughness": 1.0, "metallic": 0.0,
        "texture": "leaf.png", "alphaMode": "MASK", "alphaCutoff": 0.5, "doubleSided": True}
GRASS = {"baseColor": [0.16, 0.34, 0.06], "roughness": 1.0, "metallic": 0.0,
         "texture": "grass.png", "alphaMode": "MASK", "alphaCutoff": 0.5, "doubleSided": True}

LEAF_HEIGHTS = [2.5, 3.1, 3.8, 4.5, 2.9, 3.5, 4.1, 3.3]
LEAF_RADII = [0.6, 1.3, 1.1, 0.5, 1.4, 1.2, 0.9, 1.5]
LEAF_TILTS = [62, -55, 75, -70, 50, -80, 68, -48]  # degrees from upright; 90 would lie flat

leaf_cards = []
for i in range(8):
    angle = math.radians(i * 45 + 12 * (i % 3))
    leaf_cards.append({
        "name": f"Leaf_{i + 1}", "mesh": "Leaf", "kind": "card", "size": [1.8, 1.8, 0],
        "position": [round(TREE[0] + LEAF_RADII[i] * math.cos(angle), 2), LEAF_HEIGHTS[i],
                     round(TREE[1] + LEAF_RADII[i] * math.sin(angle), 2)],
        "rotationYDeg": (i * 67) % 180 - 90, "rotationXDeg": LEAF_TILTS[i],
        "material": "Leaf", "region": "Leaves",
    })

grass_cards = []
for i in range(12):
    angle = math.radians(i * 30 + 15 * (i % 2))
    radius = 0.5 + 0.45 * ((i * 5) % 7) / 6
    grass_cards.append({
        "name": f"Grass_{i + 1}", "mesh": "Grass", "kind": "card", "size": [0.4, 0.5, 0],
        "position": [round(PAWN[0] + radius * math.cos(angle), 2), 0.25,
                     round(PAWN[1] + radius * math.sin(angle), 2)],
        "rotationYDeg": (i * 37) % 180 - 90,
        "material": "Grass", "region": "Grass",
    })

SCENE = {
    "materials": {
        "Floor": {"baseColor": [0.8, 0.8, 0.8], "roughness": 1.0, "metallic": 0.0},
        "Bark": BARK,
        "Pawn": {"baseColor": [0.5, 0.5, 0.5], "roughness": 1.0, "metallic": 0.0},
        "Leaf": LEAF,
        "Grass": GRASS,
    },
    # name: size [x, y, z] m, centre [x, y, z] m, yaw and tilt in degrees, material, region. A card has
    # "kind": "card", "mesh" (one static mesh is shared by all cards of a kind) and a zero z size.
    "boxes": [
        {"name": "Floor", "size": [40, 0.2, 40], "position": [-4, -0.1, 0], "material": "Floor"},
        {"name": "Trunk", "size": [0.3, 3.0, 0.3], "position": [TREE[0], 1.5, TREE[1]], "material": "Bark"},
        {"name": "Pawn", "size": [0.5, 1.8, 0.5], "position": [PAWN[0], 0.9, PAWN[1]], "material": "Pawn"},
        *leaf_cards,
        *grass_cards,
    ],
    "lights": [],
    # Unreal's Template_Default lighting, one level per sun elevation, as in penumbra-lab. At 15 degrees
    # the canopy shadow is 13 m long, so that sun gets its own wide canopy camera.
    "template": "default",
    "suns": [
        {"name": "sun60", "elevationDeg": 60, "azimuthDeg": 90},
        {"name": "sun15", "elevationDeg": 15, "azimuthDeg": 90},
    ],
    "sky": "template",
    "fog": None,
    "ev100": 3,  # the template sun is 6 lux: a 0.8 floor reads about 1.5 nits
    "poses": [
        # Above and a few metres from the dappled ground shadow, with the lower canopy in view.
        {"name": "canopy", "position": [8.5, 5.0, 5.0], "target": [1.5, 1.2, -2.0], "hfovDeg": 66,
         "perSun": {"sun15": {"position": [5, 8, 11], "target": [-2.5, 0.5, -2], "hfovDeg": 68}}},
        # The card grass at the pawn's feet, and the pawn's shadow.
        {"name": "grass", "position": [5.2, 2.1, 3.4], "target": [2.6, 0.2, 0.9], "hfovDeg": 55,
         "perSun": {"sun15": {"target": [1.6, 0.2, 0.9], "hfovDeg": 60}}},
    ],
}
