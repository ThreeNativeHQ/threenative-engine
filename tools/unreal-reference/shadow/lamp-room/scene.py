"""PRD-649 shadow calibration scene `lamp-room`: lamp shadows of three kinds, and a thin rod.

A 6 x 4 x 3 m room, open at +z, with a white floor, ceiling and walls. Three lamps hang in it and
there is no sun, no sky light and no fog, so every shadow is a lamp's. A spot of source radius 0
(`spot`) and one of 10 cm (`spot-soft`) hang over two tables of the same size, so the pair differs
in the radius alone. A point light of 5 cm radius (`point`) stands in front of a crate and a 1 cm rod
that is 5 cm from the back wall (`rod`): the rod's shadow is the thinnest a lamp map must keep.

Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back.
"""

WHITE = {"baseColor": [0.73, 0.73, 0.73], "roughness": 1.0, "metallic": 0.0}
GREY = {"baseColor": [0.4, 0.4, 0.4], "roughness": 1.0, "metallic": 0.0}

CONE = {"innerConeDeg": 20, "outerConeDeg": 35}


def spot(name, x, radius):
    return {
        "name": name,
        "class": "SpotLight",
        "position": [x, 2.8, -0.5],
        "target": [x, 0.0, -0.5],
        "intensity": 600,
        "units": "candelas",
        "sourceRadiusM": radius,
        "attenuationRadiusM": 12,
        "color": [1, 1, 1],
        "castShadows": True,
        **CONE,
    }


SCENE = {
    "materials": {"White": WHITE, "Grey": GREY},
    # name: size [x, y, z] m, centre [x, y, z] m, rotation about +Y in degrees, material.
    "boxes": [
        {"name": "Floor", "size": [6.2, 0.2, 4.2], "position": [0, -0.1, 0], "material": "White"},
        {"name": "Ceiling", "size": [6.2, 0.2, 4.2], "position": [0, 3.1, 0], "material": "White"},
        {"name": "Back", "size": [6.2, 3.2, 0.2], "position": [0, 1.5, -2.1], "material": "White"},
        {"name": "Wall_L", "size": [0.2, 3.2, 4.2], "position": [-3.1, 1.5, 0], "material": "White"},
        {"name": "Wall_R", "size": [0.2, 3.2, 4.2], "position": [3.1, 1.5, 0], "material": "White"},
        {"name": "Table_L", "size": [1.0, 0.05, 0.8], "position": [-2.0, 0.8, -0.5], "material": "Grey"},
        {"name": "Table_R", "size": [1.0, 0.05, 0.8], "position": [2.0, 0.8, -0.5], "material": "Grey"},
        {"name": "Crate", "size": [0.5, 0.5, 0.5], "position": [-0.4, 0.25, -0.6], "rotationYDeg": 20, "material": "Grey"},
        {"name": "Rod", "size": [0.01, 2.0, 0.01], "position": [0.6, 1.0, -1.945], "material": "Grey"},
    ],
    "lights": [
        spot("Spot", -2.0, 0.0),
        spot("SpotSoft", 2.0, 0.10),
        {
            "name": "Point",
            "class": "PointLight",
            "position": [0.6, 1.5, 0.4],
            "intensity": 400,
            "units": "candelas",
            "sourceRadiusM": 0.05,
            "attenuationRadiusM": 12,
            "color": [1, 1, 1],
            "castShadows": True,
        },
    ],
    "sky": None,
    "sun": None,
    "fog": None,
    "ev100": 5,
    "poses": [
        {"name": "spot", "position": [-2, 1.6, 2.2], "target": [-2, 0.4, -0.5], "hfovDeg": 60},
        {"name": "spot-soft", "position": [2, 1.6, 2.2], "target": [2, 0.4, -0.5], "hfovDeg": 60},
        {"name": "point", "position": [-0.4, 1.6, 2.2], "target": [-0.4, 0.3, -0.9], "hfovDeg": 60},
        {"name": "rod", "position": [1.5, 1.2, -0.4], "target": [0.6, 1.0, -1.95], "hfovDeg": 45},
    ],
}
