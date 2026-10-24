"""PRD-643 calibration scene `fog`: volumetric fog in a room takes the bounce light of the room.

The same closed 6 x 3 x 6 m room as `glass` (red left wall, green right wall, white elsewhere), empty, with
one point light hanging 0.7 m under the ceiling and an exponential height fog with volumetric fog on. The
light lights the fog directly; the walls light it again with the bounce, which Lumen adds to the fog
(UE 5.8.3: Engine/Shaders/Private/VolumetricFog.usf, the LUMEN_GI permutation). The fog is not a mesh, so
its effect is read on the walls behind it and on the glow around the light. There is no sun and no sky light.
The light casts no shadow: nothing stands in the room, and the fog pass then takes one unshadowed point light.
Exposure is fixed.

Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back.
"""

WHITE = {"baseColor": [0.73, 0.73, 0.73], "roughness": 1.0, "metallic": 0.0}
RED = {"baseColor": [0.63, 0.065, 0.05], "roughness": 1.0, "metallic": 0.0}
GREEN = {"baseColor": [0.14, 0.45, 0.091], "roughness": 1.0, "metallic": 0.0}

SCENE = {
    "materials": {"White": WHITE, "Red": RED, "Green": GREEN},
    # name: size [x, y, z] m, centre [x, y, z] m, rotation about +Y in degrees, material.
    # The room is x -3..3, y 0..3, z -3..3; its walls are 0.2 m thick.
    "boxes": [
        {"name": "Floor", "size": [6.4, 0.2, 6.4], "position": [0, -0.1, 0], "material": "White"},
        {"name": "Ceiling", "size": [6.4, 0.2, 6.4], "position": [0, 3.1, 0], "material": "White"},
        {"name": "Back", "size": [6.4, 3.4, 0.2], "position": [0, 1.5, -3.1], "material": "White"},
        {"name": "Front", "size": [6.4, 3.4, 0.2], "position": [0, 1.5, 3.1], "material": "White"},
        {"name": "Wall_Red", "size": [0.2, 3.4, 6.4], "position": [-3.1, 1.5, 0], "material": "Red"},
        {"name": "Wall_Green", "size": [0.2, 3.4, 6.4], "position": [3.1, 1.5, 0], "material": "Green"},
    ],
    "lights": [
        {
            "name": "Lamp",
            "class": "PointLight",
            "position": [0, 2.3, -0.3],
            "intensity": 2000,
            "units": "lumens",
            "sourceRadiusM": 0.05,
            "attenuationRadiusM": 20,
            "color": [1, 1, 1],
            "castShadows": False,
        }
    ],
    "sky": None,
    "sun": None,
    # Unreal's exponential height fog. Density is Unreal's own number: the extinction per metre is
    # density / 10 (UE 5.8.3: Renderer/Private/SceneCore.cpp, FogDensity / 1000 per centimetre).
    # The actor stands on the floor (y 0); every other value is the actor's default.
    "fog": {
        "position": [0, 0, 0],
        "density": 1.0,
        "volumetric": True,
    },
    "ev100": 5,
    "poses": [
        {"name": "fog", "position": [0, 1.4, 2.7], "target": [0, 1.5, -3.0], "hfovDeg": 80},
        {"name": "fog-corner", "position": [-1.5, 1.4, 1.5], "target": [-3.0, 1.2, -2.5], "hfovDeg": 70},
    ],
}
