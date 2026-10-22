"""PRD-639 calibration scene `neon-corridor`: what a traced ray reads where it hits a surface.

A 3 x 3 x 9 m corridor, closed at -z, open at +z where the camera stands. The left wall is plain grey.
The right wall (`Wall_Brick`) has a white base colour factor and a brick albedo texture, as an imported
asset has: its factor says white, its texels say red-brown. Two emissive strips run along the ceiling
(cyan on the left, magenta on the right). A 5 cm emitter floats at mid height. One warm point lamp hangs
near the back. There is no sun, no sky light and no fog. Exposure is fixed.

Isolates, in the bounce light on the floor and the plain wall:
  - the brick texels (flat white against textured albedo at the ray hit),
  - the strips' glow and the 5 cm emitter (emission at the ray hit),
  - the lamp (a local light at the ray hit).

Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back.
`brick.png` comes from make_brick.py; its mean linear albedo is about (0.34, 0.134, 0.097).
"""

GREY = {"baseColor": [0.55, 0.57, 0.6], "roughness": 1.0, "metallic": 0.0}
CONCRETE = {"baseColor": [0.3, 0.3, 0.3], "roughness": 1.0, "metallic": 0.0}
DARK = {"baseColor": [0.18, 0.18, 0.2], "roughness": 1.0, "metallic": 0.0}
# A white factor and a texture: the factor alone says white, the texels say brick.
BRICK = {"baseColor": [1.0, 1.0, 1.0], "roughness": 1.0, "metallic": 0.0, "baseColorTexture": "Brick"}
CYAN = {"baseColor": [0.0, 0.0, 0.0], "roughness": 1.0, "metallic": 0.0, "emissive": [0.0, 0.85, 1.0], "emissiveStrength": 300.0}
MAGENTA = {"baseColor": [0.0, 0.0, 0.0], "roughness": 1.0, "metallic": 0.0, "emissive": [1.0, 0.1, 0.8], "emissiveStrength": 300.0}
# A 5 cm LED: small and very bright, so only a few rays of a probe's sphere can hit it.
AMBER = {"baseColor": [0.0, 0.0, 0.0], "roughness": 1.0, "metallic": 0.0, "emissive": [1.0, 0.7, 0.3], "emissiveStrength": 30000.0}

SCENE = {
    "materials": {
        "Grey": GREY,
        "Concrete": CONCRETE,
        "Dark": DARK,
        "Brick": BRICK,
        "Cyan": CYAN,
        "Magenta": MAGENTA,
        "Amber": AMBER,
    },
    # name -> file beside this scene.py, imported as a Texture2D (sRGB) and bound to the material's
    # "Base Color Texture" parameter.
    "textures": {"Brick": "brick.png"},
    # The corridor runs x -1.5..1.5, y 0..3, z 0..-9. Walls are 0.2 m thick.
    "boxes": [
        {"name": "Floor", "size": [3.4, 0.2, 9.2], "position": [0, -0.1, -4.6], "material": "Concrete"},
        {"name": "Ceiling", "size": [3.4, 0.2, 9.2], "position": [0, 3.1, -4.6], "material": "Dark"},
        {"name": "Wall_Left", "size": [0.2, 3.4, 9.2], "position": [-1.6, 1.5, -4.6], "material": "Grey"},
        {"name": "Wall_Brick", "size": [0.2, 3.4, 9.2], "position": [1.6, 1.5, -4.6], "material": "Brick"},
        {"name": "Back", "size": [3.4, 3.4, 0.2], "position": [0, 1.5, -9.1], "material": "Grey"},
        {"name": "Strip_Cyan", "size": [0.12, 0.06, 7.0], "position": [-1.2, 2.97, -4.5], "material": "Cyan"},
        {"name": "Strip_Magenta", "size": [0.12, 0.06, 7.0], "position": [1.2, 2.97, -4.5], "material": "Magenta"},
        {"name": "Emitter", "size": [0.05, 0.05, 0.05], "position": [0, 1.4, -5.5], "material": "Amber"},
    ],
    "lights": [
        {
            "name": "Lamp",
            "class": "PointLight",
            "position": [0.5, 2.55, -6.5],
            "intensity": 3000,
            "units": "lumens",
            "sourceRadiusM": 0.05,
            "attenuationRadiusM": 10,
            "color": [1.0, 0.85, 0.65],
            "castShadows": True,
        }
    ],
    "sky": None,
    "sun": None,
    "fog": None,
    "ev100": 4,
    "poses": [
        {"name": "neon", "position": [0, 1.5, -0.3], "target": [0, 1.3, -9], "hfovDeg": 75},
        {"name": "textured", "position": [-1.2, 1.6, -1.0], "target": [1.5, 1.2, -6.5], "hfovDeg": 70},
    ],
    # PRD-641 motion run `neon`: the lamp switches off at frame 60 and the camera holds the `neon` pose, the same
    # experiment as the cornell `switch` run. The strips and the emitter keep glowing, so the walls fade to the level
    # that emission alone gives (the response target), not to black. The measure reads the surfaces the lamp lights.
    "motion": {
        "neon": {
            "frames": 180,
            "camera": {"kind": "pose", "pose": "neon"},
            "light": {"name": "Lamp", "keys": [[0, 1.0], [60, 0.0]]},
            "regions": ["Floor", "Ceiling", "Wall_Left", "Wall_Brick", "Back"],
        },
    },
}
