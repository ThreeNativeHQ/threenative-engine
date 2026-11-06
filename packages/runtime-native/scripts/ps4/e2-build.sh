#!/usr/bin/env bash
# e2-build.sh — PRD-784 / E2: build the PS4 guest programs the experiment boots.
#
#   out/e2-triangle/app/eboot.bin   vulkan-ps4 tests/test_triangle_ps4.c + the E2
#                                   readback (e2-triangle.c, patch 0001 in the ICD)
#   out/e2-triangle-vid/app/eboot.bin  the same guest with E2_GUEST_VID: no vertex
#                                   buffer and no vertex-input state, positions
#                                   from gl_VertexIndex, constant colour
#   out/vk-triangle/app/eboot.bin   the same test, pristine ICD (control: isolates
#                                   "the readback patch broke it" from "it never booted")
#   out/gnm-triangle/app/eboot.bin  freegnm-examples triangle over OpenGNM (fallback:
#                                   isolates the emulator+driver layer from vulkan-ps4)
#
# Usage:
#   packages/runtime-native/scripts/ps4/e2-build.sh [--out DIR] [--force]
#     DIR defaults to $TN_PS4_E2_DIR, else ~/.cache/tmp-tn/prd784/e2.
#   A completed build is reused only while patches/ and e2-triangle.c are unchanged;
#   pass --force (or TN_PS4_E2_REBUILD=1) to rebuild regardless.
#   OO_PS4_TOOLCHAIN defaults to $TN_PS4_DEPS/oo/OpenOrbis/PS4Toolchain
#   ($TN_PS4_DEPS = ~/.cache/tmp-tn/prd784/deps) and must hold OpenOrbis v0.5.4.
#
# Writes only under --out. Sources are re-cloned at the pins on every build.
# Host needs clang/ld.lld/llvm-ar (tested clang 23.1.4), git, make, python3.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPS="${TN_PS4_DEPS:-$HOME/.cache/tmp-tn/prd784/deps}"
OUT="${TN_PS4_E2_DIR:-$HOME/.cache/tmp-tn/prd784/e2}"
FORCE="${TN_PS4_E2_REBUILD:-0}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

export OO_PS4_TOOLCHAIN="${OO_PS4_TOOLCHAIN:-$DEPS/oo/OpenOrbis/PS4Toolchain}"

# === Pins (override any of these from the environment) ========================
VKPS4_COMMIT="${VKPS4_COMMIT:-f4d940b723771b3fe637e8ac0704bb5d6ab19622}"        # PS4-OpenGNM/vulkan-ps4
OPENGNM_COMMIT="${OPENGNM_COMMIT:-4b295ca54c82c83acf308d1c646a2dfa9ae57350}"    # PS4-OpenGNM/opengnm
PSBC_COMMIT="${PSBC_COMMIT:-28697f007862427ebec54388ec972ce6e3545912}"          # PS4-OpenGNM/opengnm-psbc (Mesa fork)
FGNM_EX_COMMIT="${FGNM_EX_COMMIT:-ffd055563e5b849ebef1b276ba29e730199670f8}"    # PS4-OpenGNM/freegnm-examples
VK_HEADERS_REF="${VK_HEADERS_REF:-88487f687f3100ebe1d3559a8a34d971ee85b977}"    # KhronosGroup/Vulkan-Headers
SPIRV_HEADERS_REF="${SPIRV_HEADERS_REF:-6efe5ae6b7c6ad29da3f2cc3f164b9c3d72b78b1}" # KhronosGroup/SPIRV-Headers

# The inputs below the stamp are not re-cloned, so the stamp holds their hash: an
# edited patch or guest source must rebuild, never silently reuse the old binaries.
STAMP="$OUT/.build-complete"
# Only this lane's own patches: scripts/ps4/patches also holds the Dawn (dawn-*/oo-*/abseil-*)
# and V8 (v8-*) patches of E3/E4, and a stamp that hashed those would rebuild Mesa for a change
# it does not consume.
INPUT_HASH="$(cat "$HERE"/patches/0*.patch "$HERE/e2-triangle.c" | sha256sum | cut -d' ' -f1)"
if [ -f "$STAMP" ] && [ "$FORCE" != 1 ] && [ "$(cat "$STAMP")" = "$INPUT_HASH" ]; then
  echo "e2-build: reusing build in $OUT (rm $STAMP or --force to rebuild)"
  exit 0
fi

SRC="$OUT/src"
LOGS="$OUT/logs"
VENV="$OUT/venv"
PY="$VENV/bin/python"
JOBS="${JOBS:-$(nproc)}"
SCRIPTS="$HERE"

[ -d "$OO_PS4_TOOLCHAIN" ] || { echo "OO_PS4_TOOLCHAIN not found: $OO_PS4_TOOLCHAIN" >&2; exit 1; }
[ -f "$SCRIPTS/e2-triangle.c" ] || { echo "missing $SCRIPTS/e2-triangle.c" >&2; exit 1; }
mkdir -p "$SRC" "$OUT" "$LOGS"
cd "$SRC"

# === 0. Python venv (mako for Mesa codegen, pyyaml for u_format_parse) ========
if [ ! -x "$PY" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet mako pyyaml
fi
"$PY" -c "import mako, yaml" || "$VENV/bin/pip" install --quiet mako pyyaml

# === 1. Clean clones at the pins =============================================
clone_pinned() {  # <dir> <url> <commit>
  rm -rf "$1"
  git clone --quiet "$2" "$1"
  git -C "$1" checkout --quiet "$3"
}
clone_pinned vulkan-ps4       https://github.com/PS4-OpenGNM/vulkan-ps4.git         "$VKPS4_COMMIT"
clone_pinned opengnm          https://github.com/PS4-OpenGNM/opengnm.git            "$OPENGNM_COMMIT"
clone_pinned opengnm-psbc     https://github.com/PS4-OpenGNM/opengnm-psbc.git       "$PSBC_COMMIT"
clone_pinned freegnm-examples https://github.com/PS4-OpenGNM/freegnm-examples.git   "$FGNM_EX_COMMIT"
clone_pinned Vulkan-Headers   https://github.com/KhronosGroup/Vulkan-Headers.git    "$VK_HEADERS_REF"
clone_pinned SPIRV-Headers    https://github.com/KhronosGroup/SPIRV-Headers.git     "$SPIRV_HEADERS_REF"

echo "=== pins ==="
for r in vulkan-ps4 opengnm opengnm-psbc freegnm-examples Vulkan-Headers SPIRV-Headers; do
  echo "$r $(git -C "$r" rev-parse HEAD)"
done

# === 2. opengnm-psbc: codegen the files Makefile.orbis expects on disk =======
# The pinned Makefile.orbis #includes ~26 Mesa codegen outputs but only generates
# 17 of them, so the tree cannot compile as shipped. These are the same commands
# Mesa's meson.build runs; no source edit beyond patch 0002.
cd "$SRC/opengnm-psbc"
"$PY" src/util/format/u_format_table.py src/util/format/u_format.yaml --enums  > src/util/format/u_format_gen.h
"$PY" src/util/format/u_format_table.py src/util/format/u_format.yaml --header > src/util/format/u_format_pack.h
"$PY" src/util/format/u_format_table.py src/util/format/u_format.yaml          > src/util/format/u_format_table.c
"$PY" src/compiler/builtin_types_h.py src/compiler/builtin_types.h
"$PY" src/compiler/builtin_types_c.py src/compiler/builtin_types.c
"$PY" src/util/process_shader_stats.py src/util/shader_stats.rnc src/util/shader_stats.xml > src/util/shader_stats.h
"$PY" src/vulkan/util/vk_struct_type_cast_gen.py \
     --xml ../Vulkan-Headers/registry/vk.xml \
     --out src/vulkan/util/vk_struct_type_cast.h --beta false
"$PY" src/amd/packets/parse_cp_pm4_table_data_json.py \
     src/amd/packets/cp_pm4_table_data_gfx11.json \
     src/amd/packets/pm4_it_opcodes_gfx11.h gfx11 packets_h > src/amd/common/amd_cp_packets_gfx11.h
"$PY" src/amd/packets/parse_cp_pm4_table_data_json.py \
     src/amd/packets/cp_pm4_table_data_gfx12.json \
     src/amd/packets/pm4_it_opcodes_gfx12.h gfx12 packets_h > src/amd/common/amd_cp_packets_gfx12.h
"$PY" src/util/format_srgb.py > src/util/format_srgb.c
"$PY" src/amd/common/gfx10_format_table.py src/util/format/u_format.yaml \
     src/amd/registers/gfx10-rsrc.json src/amd/registers/gfx11-rsrc.json > src/amd/common/gfx10_format_table.c

# radv_shader.c passes &device->compiler_info (itself a pointer) where a pointer is
# wanted; clang >= 20 makes that an error, so the pinned tree only builds on clang 19.
git apply "$SCRIPTS/patches/0002-opengnm-psbc-compiler-info-pointer.patch"
# vtn_log() reads b->options, which vtn_create_builder() only sets after its SPIR-V
# header checks; a rejected module therefore crashed while reporting the reason.
git apply "$SCRIPTS/patches/0003-opengnm-psbc-vtn-log-null-options.patch"
# The standalone compiler has no VkPhysicalDevice to fill radv's spirv_caps from,
# so spirv_to_nir warned "Unsupported SPIR-V capability: Shader" on every module.
git apply "$SCRIPTS/patches/0005-opengnm-psbc-spirv-caps-shader.patch"
# The GNM program-address registers carry only bits 8..63 of the shader code
# address, so the code has to sit at a 256-byte offset in the binary.
git apply "$SCRIPTS/patches/0006-opengnm-psbc-shader-code-256-aligned.patch"
# A PS4 vertex shader fetches its attributes through a fetch shader and reads
# the results from VGPRs (s_swappc_b64 s[0:1], s[0:1] at the top). The
# standalone compiler has no VkPipelineVertexInputStateCreateInfo, so radv's
# non-prolog path saw every attribute as unassigned and folded each load_input
# to (0,0,0,0): the vertex-buffer triangle compiled to a 52-byte VS with no
# buffer load in it and collapsed to a point. Declaring the VS prolog keeps the
# inputs live, emits the SUBPTR_FETCHSHADER / PTR_VERTEXBUFFERTABLE usage slots
# and prepends the s_swappc the driver's fetch shader hangs off.
git apply "$SCRIPTS/patches/0015-opengnm-psbc-vs-fetch-shader-prolog.patch"
# A descriptor set base (and the indirect-descriptor table base) is a 64-bit GPU
# address in a user SGPR *pair*: sceGnmDrawCmdSetPointerUserData writes lo then
# hi, the way Sony's 64-bit SRT pointers are laid out, and shadPS4 maps guest
# memory above 4 GiB (0x200000000+). radv declared one 32-bit SGPR and widened it
# with a constant address32_hi, so the base was truncated and its high half was
# a plain constant -- which shadPS4's FlattenExtendedUserdataPass rejects
# ("ReadConst base high not from constant memory"), aborting every
# descriptor-using shader. Reserve the second SGPR and take the high half from
# it.
git apply "$SCRIPTS/patches/0017-opengnm-psbc-64bit-descriptor-set-pointers.patch"

# === 3. opengnm (orbis) ======================================================
cd "$SRC/opengnm"
cp config.orbis.mak config.mak
# shadPS4 traps on EVENT_WRITE_EOP int_sel 3 (video_core/amdgpu/pm4_cmds.h:510);
# libgnm's encoding for the same fence is 2, so both sites emit 2.
git apply "$SCRIPTS/patches/0004-opengnm-eop-int-sel-confirm.patch"
# opengnm has no CB_COLOR_CONTROL (0x28808) setter, so nothing ever left mode
# Disable (0) and shadPS4 bound no colour target: adds the setter patch 0012 calls.
git apply "$SCRIPTS/patches/0011-opengnm-cb-color-control.patch"
# A 4x MSAA colour target is four fragments per pixel, and Gpa's numfragsperpixel is that
# count: `1 << ci->numfragments` read the sample COUNT (4) as a fragment index and laid out
# sixteen fragments per pixel -- four times the surface, and for a 64 bpp format a bank
# structure the address library rejects outright. 0019 uses the count GNM's own register
# field derives (`num_fragments = ci->numfragments >> 1`, i.e. log2).
git apply "$SCRIPTS/patches/0019-opengnm-msaa-fragment-count.patch"
# computeSurfaceAlignmentsMacroTiled carries Sony's own comment -- "Sony's library ignores any
# failure, so do the same" -- and then returned the failure. HwlReduceBankWidthHeight has
# already written the reduced bank width/height into the tile info, so the create can go on;
# returning the error made sceGnmCreateRenderTarget answer GNM_ERROR_INTERNAL_FAILURE for a
# surface the hardware tiles fine: 4x MSAA RGBA16F at 1920x1080 (tile split 256 B, bank height
# align 512) is exactly the case whose sanity rule cannot be met.
git apply "$SCRIPTS/patches/0020-opengnm-gpa-bank-sanity-advisory.patch"
# config.orbis.mak's `CC ?= clang` loses to make's builtin CC=cc.
make -j"$JOBS" CC=clang AR=llvm-ar lib > "$LOGS/opengnm.log" 2>&1

# === 4. libpsbc.orbis.a ======================================================
cd "$SRC/opengnm-psbc"
# `generated` first: Makefile.orbis derives its source lists with $(wildcard ...),
# so a generated .c that is not on disk yet silently drops out of the archive.
make -f Makefile.orbis -j"$JOBS" PYTHON="$PY" generated > "$LOGS/psbc-gen.log" 2>&1
make -f Makefile.orbis -j"$JOBS" PYTHON="$PY" libpsbc  > "$LOGS/psbc.log" 2>&1

# === app folder: eboot.bin + the param.sfo shadPS4 reads ====================
# shadPS4 boots a directory (-g <dir>), and it looks for sce_sys/param.sfo next to
# the eboot. PkgTool.Core is a .NET app and the host has no ICU; invariant mode is
# its own escape hatch.
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
make_app() {  # <name> <eboot> <title> <title_id> <content_id>
  local app="$OUT/out/$1/app" sfo
  rm -rf "$OUT/out/$1"
  mkdir -p "$app/sce_sys"
  cp "$2" "$app/eboot.bin"
  sfo="$app/sce_sys/param.sfo"
  local pkgtool="$OO_PS4_TOOLCHAIN/bin/linux/PkgTool.Core"
  "$pkgtool" sfo_new "$sfo" > /dev/null
  while read -r key type maxsize value; do
    "$pkgtool" sfo_setentry "$sfo" "$key" --type "$type" --maxsize "$maxsize" --value "$value" > /dev/null
  done <<EOF
APP_TYPE Integer 4 1
APP_VER Utf8 8 1.00
ATTRIBUTE Integer 4 0
CATEGORY Utf8 4 gd
CONTENT_ID Utf8 48 $5
DOWNLOAD_DATA_SIZE Integer 4 0
SYSTEM_VER Integer 4 0
TITLE Utf8 128 $3
TITLE_ID Utf8 12 $4
VERSION Utf8 8 1.00
EOF
}

# === 5. A: vulkan-ps4 triangle, pristine ICD (control) ======================
cd "$SRC/vulkan-ps4"
make -f Makefile.orbis -j"$JOBS" self > "$LOGS/vk-triangle.log" 2>&1
make_app vk-triangle eboot.bin 'ThreeNative PS4 E2 vk' TNPRD784VK IV0000-TNPRD784VK_00-TNPS4VK000000000

# === 6. B: freegnm-examples triangle over OpenGNM (fallback) ================
cd "$SRC/freegnm-examples/triangle"
# -Wno-incompatible-pointer-types: src/main.c passes uint32_t** where opengnm's
# gnmdriver.h wants void* const* (clang >= 20 hard error). Sample source untouched.
make USE_OPENGNM=1 eboot.bin \
     CFLAGS='-std=c11 -Wall -Wextra -Wpedantic -D_BSD_SOURCE -I../shared/src \
             -DUSE_OPENGNM -I../../opengnm/include -I../../freegnm \
             -Wno-incompatible-pointer-types' \
     > "$LOGS/gnm-triangle.log" 2>&1
make_app gnm-triangle eboot.bin 'ThreeNative PS4 E2 gnm' TNPRD784GN IV0000-TNPRD784GN_00-TNPS4GN000000000

# === 7. C: E2 readback build (patch 0001 + e2-triangle.c) ===================
cd "$SRC/vulkan-ps4"
# The ICD refuses to copy from a swapchain image (it has no VkPs4DeviceMemory;
# its store is the display-linear VideoOut buffer), so the readback would no-op.
git apply "$SCRIPTS/patches/0001-vk-ps4-swapchain-readback.patch"
# Same 256-byte code-address rule on the ICD side: the compiled binary has to be
# placed 256-byte aligned or the GPU truncates the program address.
git apply "$SCRIPTS/patches/0007-vk-ps4-shader-binary-256-aligned.patch"
# One shared epilogue command buffer was rewritten while an earlier submit was
# still queued; each submission now takes its own slice.
git apply "$SCRIPTS/patches/0008-vk-ps4-per-submit-epilogue.patch"
# The colour clear returned early on "no VkPs4DeviceMemory", which is every
# swapchain image, so a loadOp=CLEAR never wrote the VideoOut buffer. Same fix
# shape as 0001: fall back to the swapchain image's GnmRenderTarget.
git apply "$SCRIPTS/patches/0009-vk-ps4-swapchain-color-clear.patch"
# A pipeline's static viewport/scissor was stored but never emitted: only
# vkCmdSetViewport/vkCmdSetScissor write those registers, so a pipeline without
# VK_DYNAMIC_STATE_VIEWPORT rasterized through a zero-size viewport (xscale 0)
# and drew nothing. vkCmdBindPipeline now applies the copied static arrays.
git apply "$SCRIPTS/patches/0010-vk-ps4-static-viewport-scissor.patch"
# Three context registers shadPS4's rasterizer needs for a colour draw and no
# driver here ever wrote: CB_COLOR_CONTROL (else no colour target is bound),
# SPI_SHADER_COL_FORMAT (else the PS translator drops every colour export) and
# PA_CL_CLIP_CNTL (else the VS is patched for screen-space output and the geometry
# collapses). vkCmdBindPipeline emits all three per bind.
git apply "$SCRIPTS/patches/0012-vk-ps4-colour-draw-context-regs.patch"
# Dawn names every WebGPU entry point "dawn_entry_point" in the SPIR-V it hands to the ICD,
# and vulkan-ps4 compiled a fixed entry point "main" (vk_ps4_shader.c:166), ignoring
# VkPipelineShaderStageCreateInfo::pName -- so every Dawn pipeline died in libpsbc with
# "Entry point not found for vertex shader "main"". This passes pName through.
git apply "$SCRIPTS/patches/0013-vk-ps4-shader-stage-entry-point.patch"
# The ICD advertises VK_KHR_surface but implements no query from it, so a caller that reads the
# surface capabilities to size a swapchain got a null proc: Dawn's wgpuSurfaceConfigure reads
# them and destroys its surface handle first, and shadPS4 caught the null jump as "Unhandled
# access violation at code address 0x0". 0014 answers for the one surface the PS4 has, the
# GnmVideoOut display vk_ps4_swapchain.c opens.
git apply "$SCRIPTS/patches/0014-vk-ps4-surface-queries.patch"
# The PTR_VERTEXBUFFERTABLE user data points at one V# per vertex input, in
# semantic order (sceGnmCreateFetchShader loads V#[i] for input i), and each V#
# has to carry that attribute's data format, offset and its binding's stride.
# The ICD filled the table per *binding* with a fixed GNM_FMT_R32_FLOAT and only
# when a fetch shader existed, so a vec2 position + vec3 colour at offset 8 read
# back as four raw floats: the vertex shader ran but every vertex landed on the
# same point. 0016 builds the table from the pipeline's attributes at draw time,
# emits the pointer whenever the pipeline has a VB table slot, and gives
# sceGnmCreateFetchShader one instancing mode per vertex *input*: it rejects the
# whole fetch shader (GNM_ERROR_INVALID_ARGS, opengnm src/shader.c "i + cursem >=
# ci->numinstancedata") when the table is sized per binding, so a second
# attribute sharing binding 0 left the VS running with an empty VGPR block.
git apply "$SCRIPTS/patches/0016-vk-ps4-vertex-buffer-table.patch"
# An image OpenGNM rejects came back as a bare VK_ERROR_OUT_OF_DEVICE_MEMORY with no record of
# which image: no allocation is attempted for it, so neither the memory log nor the size names it.
# 0018 logs the whole VkImageCreateInfo (format, extent, mips, layers, samples, usage, type,
# flags) and the OpenGNM error code from the create call that refused it, on both paths that
# return VK_ERROR_OUT_OF_DEVICE_MEMORY (vk_ps4_image.c:81 colour target, :155 texture) and on the
# depth fallback, so the failing resource is named instead of guessed.
git apply "$SCRIPTS/patches/0018-vk-ps4-log-image-create.patch"
# Two tile-mode gaps, both returning VK_ERROR_OUT_OF_DEVICE_MEMORY for an image the hardware
# supports. A depth target was created with GNM_TM_DISPLAY_2D_THIN, which sceGnmDrtSetTileMode
# rejects (it takes GNM_TM_DEPTH_2D_THIN_64 .. GNM_TM_DEPTH_2D_THIN_PRT_1K), so EVERY depth
# image fell through to the texture fallback and no depth render target existed; it now takes
# GNM_TM_DEPTH_2D_THIN_1K. A multisampled colour target is thin macro-tiled, not a display
# scanout surface: samples > 1 uses GNM_TM_THIN_2D_THIN (the tile mode opengnm's
# sceGnmRtInitColorTargetCreateInfo is documented with), 1 sample keeps the display mode.
git apply "$SCRIPTS/patches/0021-vk-ps4-depth-and-msaa-tile-modes.patch"
# The Makefile compiles TEST_SRC relative to the vulkan-ps4 tree.
cp "$SCRIPTS/e2-triangle.c" "$SRC/e2-triangle.c"
make -f Makefile.orbis -j"$JOBS" TEST_SRC=../e2-triangle.c self > "$LOGS/e2-triangle.log" 2>&1
make_app e2-triangle eboot.bin 'ThreeNative PS4 E2' TNPRD784E2 IV0000-TNPRD784E2_00-TNPS4E2000000000

# === 7b. C2: variant A, the same guest with no vertex input (TN_PS4_E2_GUEST=vid) ===
# One source, one define: the vid build gets its own object and its own eboot, so a frame
# that is still the clear with no vertex input at all rules the fetch shader out.
{ echo '#define E2_GUEST_VID 1'; cat "$SCRIPTS/e2-triangle.c"; } > "$SRC/e2-triangle-vid.c"
make -f Makefile.orbis -j"$JOBS" TEST_SRC=../e2-triangle-vid.c self > "$LOGS/e2-triangle-vid.log" 2>&1
make_app e2-triangle-vid eboot.bin 'ThreeNative PS4 E2 vid' TNPRD784VD IV0000-TNPRD784VD_00-TNPS4VD0000000000

# === 8. Report ==============================================================
echo "=== outputs ==="
ls -la "$OUT"/out/e2-triangle/app/eboot.bin "$OUT"/out/e2-triangle-vid/app/eboot.bin \
      "$OUT"/out/vk-triangle/app/eboot.bin "$OUT"/out/gnm-triangle/app/eboot.bin
printf '%s\n' "$INPUT_HASH" > "$STAMP"
echo "=== done ==="
