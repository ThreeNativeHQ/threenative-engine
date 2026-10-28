"""PRD-649 shadow calibration scene `penumbra-lab`: penumbra growth with caster height, contact, acne.

A white 40 x 40 m floor. Five 0.5 m boxes stand in a row along -z, their bases 0, 0.25, 1, 4 and
10 m above the floor, so each shadow's penumbra grows with its caster gap. A 2 cm pole tests the
thinnest caster. A 15 degree ramp tests self-shadow acne on a slope, and a 1 m step tests a contact
edge on a vertical face. The lighting is Unreal's default template (sun, sky light, sky atmosphere):
only the sun's elevation changes per level, so its source angle stays the default a user gets.

Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back.
"""

WHITE = {"baseColor": [0.8, 0.8, 0.8], "roughness": 1.0, "metallic": 0.0}
GREY = {"baseColor": [0.5, 0.5, 0.5], "roughness": 1.0, "metallic": 0.0}

# Box bases above the floor, metres: the caster gap that sets each penumbra.
HEIGHTS = [0, 0.25, 1, 4, 10]

SCENE = {
    "materials": {"White": WHITE, "Grey": GREY},
    # name: size [x, y, z] m, centre [x, y, z] m, rotation about +Y (and +X) in degrees, material.
    "boxes": [
        {"name": "Floor", "size": [40, 0.2, 40], "position": [0, -0.1, -8], "material": "White"},
        *[
            {"name": f"Box_{str(h).replace('.', 'p')}", "size": [0.5, 0.5, 0.5], "position": [0, h + 0.25, -3.0 * i],
             "material": "Grey"}
            for i, h in enumerate(HEIGHTS)
        ],
        {"name": "Pole", "size": [0.02, 2.0, 0.02], "position": [3, 1.0, -2], "material": "Grey"},
        {"name": "Ramp", "size": [3, 0.1, 4], "position": [-5, 0.52, -4], "rotationXDeg": 15, "material": "White"},
        {"name": "Step", "size": [3, 1, 3], "position": [5, 0.5, -9], "material": "White"},
    ],
    "lights": [],
    # Unreal's Template_Default lighting, one level per sun elevation. The azimuth puts the sun on +x,
    # so shadows fall toward -x, across the camera's view.
    "template": "default",
    "suns": [
        {"name": "sun60", "elevationDeg": 60, "azimuthDeg": 90},
        {"name": "sun15", "elevationDeg": 15, "azimuthDeg": 90},
        {"name": "sun4", "elevationDeg": 4, "azimuthDeg": 90},
    ],
    "sky": "template",
    "fog": None,
    "ev100": 3,  # the template sun is 6 lux: a 0.8 floor reads about 1.5 nits
    "poses": [
        {"name": "heights", "position": [8, 9, 6], "target": [-1, 0, -6], "hfovDeg": 60},
        {"name": "contact", "position": [1.6, 1.0, 1.6], "target": [-0.3, 0.1, -0.2], "hfovDeg": 50},
        {"name": "ramp", "position": [-2, 3, 1], "target": [-5, 0.5, -4], "hfovDeg": 60},
    ],
}
