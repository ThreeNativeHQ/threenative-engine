"""PRD-643 calibration scene `glass`: a translucent pane takes the bounce light of the room it stands in.

A closed 6 x 3 x 6 m room with a red left wall, a green right wall and white floor, ceiling, back and front
walls. One point light stands 1 m in front of a free-standing pane of frosted glass (50% opaque, white,
rough), so the light reaches the pane head on. Behind the pane a white block stands partly behind the pane's
right edge: the pane covers 40 percent of the block and the rest shows bare, so one frame holds the same
surface seen through the glass and without it. There is no sun, no sky light and no fog. Exposure is fixed.

The glass is Unreal's default translucent material: blend mode Translucent, translucency lighting mode
"Volumetric NonDirectional", so Lumen lights it from the translucency GI volume (UE 5.8.3:
Engine/Shaders/Private/BasePassPixelShader.usf, GetSkyLighting).

Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back.
"""

WHITE = {"baseColor": [0.73, 0.73, 0.73], "roughness": 1.0, "metallic": 0.0}
RED = {"baseColor": [0.63, 0.065, 0.05], "roughness": 1.0, "metallic": 0.0}
GREEN = {"baseColor": [0.14, 0.45, 0.091], "roughness": 1.0, "metallic": 0.0}
# Frosted glass: a rough dielectric that lets half of the light behind it through.
GLASS = {"baseColor": [0.85, 0.85, 0.85], "roughness": 1.0, "metallic": 0.0, "alphaMode": "BLEND", "opacity": 0.5}

SCENE = {
    "materials": {"White": WHITE, "Red": RED, "Green": GREEN, "Glass": GLASS},
    # name: size [x, y, z] m, centre [x, y, z] m, rotation about +Y in degrees, material.
    # The room is x -3..3, y 0..3, z -3..3; its walls are 0.2 m thick.
    "boxes": [
        {"name": "Floor", "size": [6.4, 0.2, 6.4], "position": [0, -0.1, 0], "material": "White"},
        {"name": "Ceiling", "size": [6.4, 0.2, 6.4], "position": [0, 3.1, 0], "material": "White"},
        {"name": "Back", "size": [6.4, 3.4, 0.2], "position": [0, 1.5, -3.1], "material": "White"},
        {"name": "Front", "size": [6.4, 3.4, 0.2], "position": [0, 1.5, 3.1], "material": "White"},
        {"name": "Wall_Red", "size": [0.2, 3.4, 6.4], "position": [-3.1, 1.5, 0], "material": "Red"},
        {"name": "Wall_Green", "size": [0.2, 3.4, 6.4], "position": [3.1, 1.5, 0], "material": "Green"},
        {"name": "Box_White", "size": [1.0, 1.0, 1.0], "position": [1.3, 0.5, -1.8], "material": "White"},
        # A 4 cm sheet, 2.4 m wide and 2 m tall, standing 0.2 m above the floor.
        {"name": "Pane", "size": [2.4, 2.0, 0.04], "position": [0, 1.2, -0.8], "material": "Glass"},
    ],
    "lights": [
        {
            "name": "Lamp",
            "class": "PointLight",
            "position": [0, 1.6, 1.0],
            "intensity": 1600,
            "units": "lumens",
            "sourceRadiusM": 0.05,
            "attenuationRadiusM": 20,
            "color": [1, 1, 1],
            "castShadows": True,
        }
    ],
    "sky": None,
    "sun": None,
    "fog": None,
    "ev100": 5,
    "poses": [
        {"name": "glass", "position": [0, 1.45, 2.7], "target": [0, 1.2, -1.0], "hfovDeg": 80},
        {"name": "glass-edge", "position": [1.9, 1.35, 1.0], "target": [1.2, 1.0, -1.7], "hfovDeg": 60},
    ],
}
