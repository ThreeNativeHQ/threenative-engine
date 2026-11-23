"""Compile the CharDynProbe editor module against the installed UE 5.8.3 at $UE_ROOT.

    python3 tools/unreal-reference/character-dynamics/build_module.py

Why a shadow tree: the install at $UE_ROOT carries Engine/Build/InstalledBuild.txt, but its
Engine/Intermediate/Build has neither BuildRules/UE5Rules.dll nor the UHT headers of the engine
modules (Inc/Engine/UHT/*.generated.h), so UBT cannot compile any C++ project against it
("Precompiled rules assembly ... UE5Rules.dll does not exist"). This script mirrors the engine
as symlinks in ${UE_ROOT}-chardyn-shadow (a sibling, so relative include paths that UHT writes
from Engine/Source still resolve), with its own Intermediate, Saved, UBT copy and every plugin's
Intermediate as real folders, so nothing is written into $UE_ROOT. Then:

  1. without InstalledBuild.txt: `Build.sh UnrealEditor ... -SkipBuild` compiles the rules
     assembly and runs UHT for every engine module (about 1 minute, nothing is compiled);
  2. with InstalledBuild.txt: `Build.sh CharacterDynamicsReferenceEditor ... -NoUBA` compiles only
     this module and links it against the installed engine libraries.

The GDK online plugins (Engine/Plugins/Online/Microsoft) are left out of the mirror: their rules
reference the GDK platform extension, which this Linux install does not have.
"""

import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
UE_ROOT = os.path.realpath(os.environ.get("UE_ROOT", os.path.expanduser("~/UnrealEngine-5.8.3")))
SHADOW = UE_ROOT + "-chardyn-shadow"
REAL = os.path.join(UE_ROOT, "Engine")
ENGINE = os.path.join(SHADOW, "Engine")
EXCLUDED = {os.path.join("Plugins", "Online", "Microsoft")}
OWN = {"Intermediate", "Saved"}  # real, empty folders in the shadow


def link(src, dst):
    if not os.path.lexists(dst):
        os.symlink(src, dst)


def mirror(rel, keep_real):
    """Make Engine/<rel> a real folder whose children link to the install, except those in keep_real."""
    os.makedirs(os.path.join(ENGINE, rel), exist_ok=True)
    for name in sorted(os.listdir(os.path.join(REAL, rel))):
        child = os.path.join(rel, name)
        if child in EXCLUDED or child in keep_real:
            continue
        link(os.path.join(REAL, child), os.path.join(ENGINE, child))


def build_shadow():
    plugin_dirs = set()
    for root, dirs, files in os.walk(os.path.join(REAL, "Plugins")):
        dirs[:] = [d for d in dirs if d not in ("Intermediate", "Binaries", "Content", "Source", "Resources")]
        if any(f.endswith(".uplugin") for f in files):
            plugin_dirs.add(os.path.relpath(root, REAL))
    # Every ancestor of a plugin is a real folder; inside a plugin only Intermediate is real.
    real_dirs = {"", "Build", "Binaries", os.path.join("Binaries", "DotNET"), os.path.join("Binaries", "Linux"),
                 "Programs", os.path.join("Programs", "UnrealHeaderTool"),
                 "Source", "Plugins"}
    for plugin in plugin_dirs:
        parts = plugin.split(os.sep)
        for i in range(1, len(parts) + 1):
            real_dirs.add(os.path.join(*parts[:i]))
    for rel in sorted(real_dirs, key=lambda r: r.count(os.sep)):
        if any(rel == e or rel.startswith(e + os.sep) for e in EXCLUDED):
            continue
        children = {os.path.join(rel, n) for n in os.listdir(os.path.join(REAL, rel)) if os.path.join(rel, n) in real_dirs}
        if rel in plugin_dirs or rel == "":
            children |= {os.path.join(rel, n) for n in OWN}
        if rel == "Programs":
            children.add(os.path.join("Programs", "UnrealBuildTool"))  # UBT writes its log here
        if rel == "Build":
            children.add(os.path.join("Build", "InstalledBuild.txt"))
        if rel == os.path.join("Binaries", "DotNET"):
            children.add(os.path.join(rel, "UnrealBuildTool"))
        if rel == os.path.join("Binaries", "Linux"):
            children.add(os.path.join(rel, "UnrealEditor.target"))
        mirror(rel, children)
    for rel in OWN:
        os.makedirs(os.path.join(ENGINE, rel, "Build", "BuildRules"), exist_ok=True)
    os.makedirs(os.path.join(ENGINE, "Programs", "UnrealBuildTool"), exist_ok=True)
    for plugin in plugin_dirs:
        if not any(plugin == e or plugin.startswith(e + os.sep) for e in EXCLUDED):
            os.makedirs(os.path.join(ENGINE, plugin, "Intermediate"), exist_ok=True)
    for name in os.listdir(UE_ROOT):
        if name != "Engine":
            link(os.path.join(UE_ROOT, name), os.path.join(SHADOW, name))
    # UBT finds the engine from its own path, and the receipt is rewritten: both are copies.
    ubt = os.path.join(ENGINE, "Binaries", "DotNET", "UnrealBuildTool")
    if not os.path.isdir(ubt):
        shutil.copytree(os.path.join(REAL, "Binaries", "DotNET", "UnrealBuildTool"), ubt, symlinks=True)
    receipt = os.path.join(ENGINE, "Binaries", "Linux", "UnrealEditor.target")
    if not os.path.exists(receipt):
        shutil.copy2(os.path.join(REAL, "Binaries", "Linux", "UnrealEditor.target"), receipt)
    link(os.path.join(REAL, "Programs", "UnrealHeaderTool", "Config"), os.path.join(ENGINE, "Programs", "UnrealHeaderTool", "Config"))


def build_sh(*args):
    command = [os.path.join(ENGINE, "Build", "BatchFiles", "Linux", "Build.sh"), *args, "-MaxParallelActions=4", "-NoUBA"]
    print("TN_UE_CHARDYN", " ".join(command), flush=True)
    return subprocess.call(command, cwd=SHADOW)


def main():
    build_shadow()
    installed = os.path.join(ENGINE, "Build", "InstalledBuild.txt")
    if not os.path.exists(os.path.join(ENGINE, "Intermediate", "Build", "Linux", "UnrealEditor", "Inc", "Engine", "UHT")):
        if os.path.lexists(installed):
            os.unlink(installed)
        if build_sh("UnrealEditor", "Linux", "Development", "-SkipBuild", "-IgnoreJunk") != 0:
            return 1
    link(os.path.join(REAL, "Build", "InstalledBuild.txt"), installed)
    project = os.path.join(HERE, "CharacterDynamicsReference.uproject")
    return build_sh("CharacterDynamicsReferenceEditor", "Linux", "Development", f"-Project={project}")


if __name__ == "__main__":
    sys.exit(main())
