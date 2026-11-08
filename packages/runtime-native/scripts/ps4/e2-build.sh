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
# WebGPU's Compatibility guarantee is four bind groups and vulkan-ps4 already
# reports maxBindGroups 4, but psbc refused any resource whose descriptor set
# was not 0 -- and the engine's material fragment module binds @group(1), so
# every material pipeline died with "resource uses descriptor set 1, only set 0
# is supported" -> VK_ERROR_FEATURE_NOT_PRESENT. Each used set now gets its own
# layout, and each set's base is reported as its own input-usage slot (apislot =
# set index) over its own 64-bit user-SGPR pair: four sets cost eight of a
# stage's sixteen user SGPRs, and a four-set PS4 vertex shader spends twelve
# (eight for the sets, two for the fetch-shader prolog pointer, one for the
# vertex-buffer table, one for the base vertex). radv's fallback -- one pointer
# to an indirect table of 32-bit set pointers -- would truncate a set base above
# 4 GiB, so the compiler names that limit instead of emitting it.
git apply "$SCRIPTS/patches/0022-opengnm-psbc-descriptor-sets-0-3.patch"
# Wave32 does not exist before GFX10, but the subgroup-size chooser took the
# "small workgroup" branch anyway and handed radv_nir_shader_info_pass a
# wave_size of 32 on a GFX8 target, whose assert (radv_shader_info.c:1125)
# aborts the whole process: the first small compute shader in the engine did
# exactly that, before any frame. Below GFX10 a compute stage is wave64.
git apply "$SCRIPTS/patches/0024-opengnm-psbc-wave64-below-gfx10.patch"
# BinaryInfo.length covered ACO's constant data after s_endpgm (a const array:
# Cube Spin's fullscreen-triangle positions). shadPS4 decodes `length` bytes as
# GCN (regs_shader.h GetParams), so the float 3.0 decoded as an instruction with
# a literal and the decoder ran into the footer: "illegal encoding" = the hash.
# length is now radv's exec_size; the constant data stays in the binary.
git apply "$SCRIPTS/patches/0040-opengnm-psbc-length-excludes-constant-data.patch"
# shadPS4 (v0.21.0 and upstream main) does not translate S_LSHR_B64: Cube Spin's
# fragment shader logged "Unknown opcode S_LSHR_B64", then EmitControlFlowGraph
# aborted. The PS4 GPU has the instruction; the emulator does not. psbc emits
# every scalar 64-bit logical right shift as 32-bit SALU ops instead.
git apply "$SCRIPTS/patches/0041-opengnm-psbc-no-s-lshr-b64.patch"
# The same emulator gap for S_OR_SAVEEXEC_B64 (shadPS4 has the AND and ORN2
# forms only). A pass after lower_branches rewrites it as s_mov_b64 + s_or_b64.
git apply "$SCRIPTS/patches/0042-opengnm-psbc-no-s-or-saveexec.patch"
# Varyings by slot: VS export and PS input semantics were dense indices (15 + i), so a pixel shader
# that reads a subset of the VS outputs could not be matched to them. Both now carry the varying slot
# (SPIR-V location), VS exports the parameter radv assigned, PS inputs a flat bit (PRD-784 P4-3).
git apply "$SCRIPTS/patches/0046-opengnm-psbc-varying-slot-semantics.patch"
# Front face as a float (+1.0/-1.0): psbc's Mesa reads it with fgt and fsign, but SPI_BARYC_CNTL
# asked for the integer form, so every face read back-facing and the normal-map frame scaled to 0
# (no concrete relief on PS4, PRD-784 visuals).
git apply "$SCRIPTS/patches/0056-opengnm-psbc-front-face-float.patch"
# A VS input is named by its attribute location and reads vs_inputs[location]: dense indices broke a VS
# that skips a location (the pennant reads uv at 1 and no position), so its UVs were undefined (PRD-784 visuals).
git apply "$SCRIPTS/patches/0059-opengnm-psbc-vs-inputs-by-location.patch"
# The vertex buffer table base is a 64-bit pointer (the driver and the fetch shader use both SGPRs), so
# its high half gets its own user SGPR; base_vertex had taken it, which shifted every gl_VertexIndex
# by the pointer's high dword and tore the cloth pennant (PRD-784 visuals).
git apply "$SCRIPTS/patches/0063-opengnm-psbc-vertex-buffer-table-64bit.patch"
# gl_VertexIndex adds base_vertex from a user SGPR, and the driver writes it only for an apislot 0xFE
# slot: psbc emitted none, so the VS read whatever that SGPR held (PRD-784 visuals).
git apply "$SCRIPTS/patches/0061-opengnm-psbc-base-vertex-slot.patch"
# InstanceIndex = instance_id + start_instance, and the driver writes start_instance only for an apislot 0xFF
# slot: psbc emitted none, so instanced draws read a stale SGPR as firstInstance (PRD-784 capability sweep).
git apply "$SCRIPTS/patches/0064-opengnm-psbc-start-instance-slot.patch"
# The same emulator gap for S_BFM_B64 and S_BREV_B64: the soft lamp-shadow shader logged "Unknown opcode
# S_BFM_B64" and aborted shadPS4 (Unreal calibration on PS4). A 64-bit SGPR constant takes two s_mov_b32 halves.
git apply "$SCRIPTS/patches/0073-opengnm-psbc-no-s-bfm-brev-b64.patch"
# A gather cleared TRUNC_COORD in its sampler, which the driver never sets, and shadPS4 cannot trace a sampler
# built that way: the TRAA resolve asserted (resource_discover_pass.cpp:289) on every run (Unreal calibration).
git apply "$SCRIPTS/patches/0074-opengnm-psbc-no-tg4-trunc-coord-clear.patch"
# psbc keyed SPI_SHADER_COL_FORMAT for target 0 only, so ACO dropped every MRT1..7 export: the TRAA resolve never
# wrote its history target, read zeros, and drew dark 1 px rims round bright edges on PS4 (Unreal calibration L1/L7).
git apply "$SCRIPTS/patches/0078-opengnm-psbc-fp16-export-every-mrt.patch"
# psbc wrote no input usage slot for an inlined push constant, so the driver never wrote one and every push
# constant read 0: Dawn clamps frag_depth to push-constant min/max depth, so a depth blit wrote 0 (P5-15).
git apply "$SCRIPTS/patches/0079-opengnm-psbc-push-constant-usage-slots.patch"

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
# A PKT3 count field is payload dwords minus one (Mesa's ac_pm4_cmd_end writes
# ndw - last_pm4 - 2, and shadPS4 consumes count + 2 words, liverpool.cpp:961).
# DispatchDirect encoded four payload words as count 4, so the command processor
# swallowed the trailing NOP's header as well and read that NOP's first zero body
# word as a PM4 type-0 packet: the first compute dispatch in the engine died at
# liverpool.cpp:291 "Unimplemented PM4 type 0, base reg: 0, size: 1".
git apply "$SCRIPTS/patches/0027-opengnm-dispatch-direct-count.patch"
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
# A descriptor set has to reach the shader as the memory radv's lowering reads:
# one 64-byte slot per binding (psbc's PSBC_BINDING_STRIDE), binding N's GNM
# descriptors at N*64, with dynamic offsets shifting a buffer's base in the
# copy. psbc emits one base slot per used set, apislot naming the set; binding
# set S writes S's base pointer to that slot's user-SGPR pair (one
# SetPointerUserData writes both halves), so firstSet > 0 and several sets in
# one call both land on the right registers. Before this the driver looked the
# slot up as a *binding number* across every bound set and pointed the pair at
# that binding's GnmBuffer array, so a set with more than one binding read the
# wrong bytes and any set past the first was never bound at all.
git apply "$SCRIPTS/patches/0023-vk-ps4-bind-every-descriptor-set.patch"
# Two tile-mode gaps, both returning VK_ERROR_OUT_OF_DEVICE_MEMORY for an image the hardware
# supports. A depth target was created with GNM_TM_DISPLAY_2D_THIN, which sceGnmDrtSetTileMode
# rejects (it takes GNM_TM_DEPTH_2D_THIN_64 .. GNM_TM_DEPTH_2D_THIN_PRT_1K), so EVERY depth
# image fell through to the texture fallback and no depth render target existed; it now takes
# GNM_TM_DEPTH_2D_THIN_1K. A multisampled colour target is thin macro-tiled, not a display
# scanout surface: samples > 1 uses GNM_TM_THIN_2D_THIN (the tile mode opengnm's
# sceGnmRtInitColorTargetCreateInfo is documented with), 1 sample keeps the display mode.
git apply "$SCRIPTS/patches/0021-vk-ps4-depth-and-msaa-tile-modes.patch"
# The embedded clear PS is the one shader binary in this driver that predates psbc's 256-byte code
# layout (0006): its GCN code sits at blob+0x74. sceGnmPsRegsSetAddress keeps only bits 8..63 of a
# program address (opengnm include/gnm_shader.h:162), so that address was truncated to the 256-byte
# boundary BELOW the code and the PS stage ran from the container's file header instead: shadPS4
# decoded SPI_SHADER_PGM_HI (0xffffffff) as an instruction and aborted at decode.cpp:115 "illegal
# encoding: 0xffffffff". 0025 places the blob in its buffer so the code lands on a boundary
# (breadcrumb: code=0x...1000, pgmhi=0).
git apply "$SCRIPTS/patches/0025-vk-ps4-clear-ps-code-256-aligned.patch"
# A compute pipeline copied only the code address out of the shader binary and left
# COMPUTE_PGM_RSRC1/RSRC2 and COMPUTE_NUM_THREAD_XYZ zeroed, so every dispatch ran with
# RSRC2.USER_SGPR=0 while psbc had compiled USER_SGPR=4 (RSRC2=0x88) for the same shader.
# shadPS4 then translated the shader with no user SGPRs, its descriptor-set ReadConst base
# came from an undefined SGPR pair, and every compute dispatch died at
# flatten_extended_userdata_pass.cpp:832 "ReadConst base low not from constant memory".
# The pipeline copies the whole GnmCsStageRegisters word set before patching the address.
git apply "$SCRIPTS/patches/0026-vk-ps4-cs-stage-registers.patch"
# The CS input-usage slot table follows the whole GnmCsShader header (0x24 bytes: CommonData 8 +
# COMPUTE_PGM_LO..NUM_THREAD_Z 0x1c), the same way sceGnmVsShaderInputUsageSlotTable follows
# GnmVsShader. It was read at +sizeof(GnmShaderCommonData) = +8, inside COMPUTE_PGM_LO, so the one
# slot it yielded was noise (usagetype 0xcc, apislot 0, startregister 0) and binding 0's Vsharp
# went to CS user SGPRs 0-3 -- while the shader's descriptor-set base is SGPR2/3 (psbc's
# PTR_INDIRECTRESOURCETABLE slot: type 0x1c, apislot 0, startregister 2 at the real offset). Every
# compute dispatch then ran with a Vsharp where its descriptor table pointer belongs, and the host
# device was lost on the first one.
git apply "$SCRIPTS/patches/0028-vk-ps4-cs-input-usage-slots.patch"
# The GPU reads a table it reaches by pointer when it EXECUTES the draw, not when
# the CPU recorded it, and every queued draw in a command buffer shared the one
# mutable V# table in that command buffer (`cmd->gnm_vertex_buffers`, memset and
# refilled per draw): all queued draws resolved against the LAST draw's table, so
# the 1-attribute fullscreen pass left slot 1 zeroed and the mesh lost its normal
# V# (dfmt 0 -> VK_FORMAT_UNDEFINED in shadPS4 -> host fault on
# SET_VERTEX_ATTRIBUTE_A(1), Xid 69). Confirmed by breadcrumb: draws 1-3 of a
# frame all emitted table 0x20009d544. Each draw now takes its own immutable copy
# from the command buffer itself (sceGnmCmdAllocInside, the allocator the clear
# shader's colour and the indirect/dispatch staging already use), which is
# GPU-visible, unique per draw, and released with the command buffer. The same
# audit found the descriptor-set memory: one buffer per set re-composed at every
# bind with that bind's dynamic offsets, i.e. the same reuse, so 0029 composes a
# per-bind copy there too. Audited and left alone: the fetch-shader pointer
# (per pipeline, written once at creation), the descriptor bindings' own V#/T#/S#
# arrays (per set, written only by vkUpdateDescriptorSets, which is illegal while
# the set is in use), push constants and every Set*UserData descriptor (copied
# inline into the PM4 stream).
git apply "$SCRIPTS/patches/0029-vk-ps4-per-draw-vertex-buffer-table.patch"
# A clear is a DRAW (vk_ps4_clear_color_draw), so it rasterized through whatever viewport the
# previous draw left in the context, and the first draw of a command buffer through the device's
# init state: neither belongs to the target being cleared. The clear now names the target's own
# viewport (extent -> scale/offset, the same mapping vk_ps4_CmdSetViewport derives from a Vulkan
# one) before it draws.
git apply "$SCRIPTS/patches/0030-vk-ps4-clear-draw-viewport.patch"
# A tiled colour target was cleared by that draw alone, and the draw was measured covering part of
# its target and none of another: on the E3TEX repro, an R8G8B8A8 offscreen target came back with
# the clear colour over its top quarter only (0,0,64 over rows 0..63 of 256, black below, read back
# by the sampling pass as a 25% band) and the same image as 16_16_16_16 float carried no clear at
# all (background (0,0,0) where the guest asked for (0,0,64)). The clear's own CB_COLOR0_INFO /
# ATTRIB / extent (breadcrumbs: base, pitch, slice, tile mode 10, info fmt/ntype) matched the
# triangle draw's word for word, so the target was never the disagreement -- the clear draw was.
# A whole-surface clear of a CONSTANT colour does not depend on the tiling at all: every byte takes
# the same value, so a linear FillMemory over the RT's own byte size produces the tiled layout's
# image. Uniform-word clears (every format up to 32 bpp, plus a 64 bpp one whose two words repeat)
# now go through FillMemory; only a colour the one 32-bit word cannot express, or a sub-rect
# clear, still needs the draw.
git apply "$SCRIPTS/patches/0031-vk-ps4-clear-whole-surface-fill.patch"
# A 4x colour target with a 1x resolve target (Dawn's resolveTarget, which arrives as
# VkSubpassDescription::pResolveAttachments) was stored and never resolved: nothing acted on
# the resolve list at CmdEndRenderPass/CmdNextSubpass, so the 1x image stayed black and every
# later pass sampled black -- the engine's scene pass in E5. 0033 emits the GCN hardware
# CB resolve (CB_COLOR_CONTROL.MODE = CB_RESOLVE, ROP3 0xCC, CB_COLOR0 = MSAA source,
# CB_COLOR1 = 1x destination), the register recipe RADV uses on GFX7 and the exact case
# shadPS4 executes at draw time (vk_rasterizer.cpp FilterDraw -> Rasterizer::Resolve); it also
# emits PA_SC_AA_CONFIG for the pipeline's sample count, which no register in this driver
# ever told the hardware.
git apply "$SCRIPTS/patches/0033-vk-ps4-msaa-resolve.patch"
# A depth target is neither a colour target nor a texture, and neither of those two paths binds
# it: vk_ps4_BindImageMemory gave the image its sample-time T# address only, and its
# GnmDepthRenderTarget kept zreadbase256b = zwritebase256b = 0. sceGnmDrawCmdSetDepthRenderTarget
# (opengnm src/drawcommandbuffer.c) publishes the DB_Z_INFO block only when
# sceGnmDrtGetZReadAddress() is non-NULL and otherwise writes DB_Z_INFO = DB_STENCIL_INFO = 0, so
# every draw ran with no depth buffer at all: a register dump of every E5 draw read DB_Z_INFO 0,
# DB_STENCIL_INFO 0, DB_DEPTH_VIEW 0, DB_DEPTH_SIZE 0 under a DB_DEPTH_CONTROL of 0x36 (Z enable
# + write) in a render pass with a 4x D32 depth attachment, and shadPS4 binds a depth attachment
# only when the Z address and format are valid (vk_pipeline_cache.cpp:418 db_enabled,
# regs_depth.h DepthValid) -- so the box showed its back faces through its front ones. The bind
# now sets the Z read/write and stencil read/write addresses, the size comes from
# sceGnmDrtCalcByteSize (a 4x Z plane is four times the 1x one, and the stencil plane follows it)
# and numfragments is the sample COUNT, not 1, so a 4x pass gets a 4x Z plane. The depth clear's
# lazy-clear draw also binds and names its own target (scissor, viewport, AA config) and drops
# DB_RENDER_CONTROL's clear bits again: shadPS4 runs the clear as that draw's depth load op, so a
# bit left set clears the depth buffer at every later draw of the pass AND disables their depth
# writes, which is the same no-depth-test symptom.
git apply "$SCRIPTS/patches/0034-vk-ps4-depth-target-addresses.patch"
# GNM_EMBEDDED_VSH_FULLSCREEN is a RECTLIST's three corners, not a fullscreen triangle: drawn as a
# TRILIST it covered half the target below the diagonal, so every clear, depth clear and resolve
# left the other half stale (E5's box showed old frames past a diagonal edge).
git apply "$SCRIPTS/patches/0035-vk-ps4-fullscreen-rectlist.patch"
# 0008's epilogue ring reused a slice while shadPS4 still had its submit queued: a WaitMem (7
# dwords) written over a queued EOP (6) derailed the parse at "count=7, remaining=6", and an EOP
# over a queued WaitMem left its poll interval as a type-0 header. Dumps of every submit parsed
# clean, so the bytes changed after submit. Each slice now ends with a WRITE_DATA of its ticket,
# and the next use of the slice waits for that ticket.
git apply "$SCRIPTS/patches/0036-vk-ps4-epilogue-slice-retire.patch"
# 0031 moved every uniform-colour render-target clear to a whole-surface FillMemory after the clear
# draw covered part of its target, which was 0035's TRILIST. A whole-target fill is a CPU-visible
# write of every byte (15 MB at 720p 4x) that shadPS4 re-syncs into its GPU copy each frame: the E5
# profile spent a third of the GPU thread in memcpy. Tiled targets clear with the RECTLIST draw again.
git apply "$SCRIPTS/patches/0037-vk-ps4-draw-clear-render-targets.patch"
# The format table never set SAMPLED_IMAGE_FILTER_LINEAR on any format, so Dawn reported no
# float32-filterable and Cube Spin (a linear-filtered FloatType texture) was refused at boot. GCN
# filters every normalized, sRGB and float format; integer formats stay point-only.
git apply "$SCRIPTS/patches/0038-vk-ps4-filter-linear-formats.patch"
# Every VkFence and VkSemaphore took its own 64 KB direct-memory block for an 8-byte label, and
# Dawn creates and destroys swapchain semaphores every frame: two GPU maps and unmaps per frame,
# each one a shadPS4 memory-tracker re-sync on its GPU thread. Labels now come from a pooled slab.
git apply "$SCRIPTS/patches/0039-vk-ps4-pooled-sync-labels.patch"
# QueuePresent called sceGnmVideoOutSubmitFlipAndWait, which blocks until the flip shows: every
# frame waited one vblank more than its work, so a 20 ms frame presented at 30 fps. Present now
# queues the flip (sceVideoOutSubmitFlip) and returns; Acquire hands back an image only once a
# later flip completed (sceVideoOutGetFlipStatus), so the display never reads an image in reuse.
git apply "$SCRIPTS/patches/0043-vk-ps4-async-flip.patch"
# Diagnostic: per-100-frame wait counters (PRD-784 P4-2)
git apply "$SCRIPTS/patches/0044-vk-ps4-wait-counters.patch"
# Mip levels: images, views, copies, colour targets and clears all walked level 0, so a texture's
# per-level mip pass overwrote its base level. One level table (sceGpaComputeSurfaceSizeOffset over
# the image's own tile mode) now drives sizing, the view T#'s base/last level and array range,
# buffer<->image copies at level > 0, level-N colour targets and clears (PRD-784 P4-3). Level 0 keeps
# the old copy and fill sizes: tile-padded sizes overran images Dawn suballocates in one VkDeviceMemory
# (shadPS4 then read garbage PM4). Uploads into tiled (DISPLAY_2D_THIN) surfaces are tiled on the CPU
# with sceGpaTileSurfaceRegion; linear row DMA scrambled them. Depth mips stay level 0.
git apply "$SCRIPTS/patches/0045-vk-ps4-mip-levels.patch"
# SPI_PS_INPUT_CNTL was never programmed, so a lit material's pixel shader read its UVs from another
# varying (flat floor, no grid). Bind now matches PS inputs to VS exports by slot (PRD-784 P4-3).
git apply "$SCRIPTS/patches/0047-vk-ps4-ps-input-cntl.patch"
# 16 epilogue slices were about one frame of Dawn submits, so the submit thread spun until the GPU retired
# the previous frame (93% of its samples on the starter). 256 slices let the CPU run ahead (PRD-784).
git apply "$SCRIPTS/patches/0048-vk-ps4-epilogue-slots.patch"
# Every image view kept the image's 2D T# type, so a cube view of the environment's PMREM was sampled as
# one 2D slice. Cube and array views now set their T# type and depth (PRD-784 P4-3).
git apply "$SCRIPTS/patches/0049-vk-ps4-cube-array-view-types.patch"
# A (mip, layer) colour target: the layer by CB_COLOR_VIEW.SLICE_START (radv), the mip's own degraded tile
# mode, and CB_COLOR_SLICE from the level table (64 KB against the texture's 32 KB at 64 px RGBA16F wrote
# each face onto the next and past the image: a guest heap abort). A target that still reaches past the
# image is refused with TN_VKPS4_LEVEL_RT_OVERRUN.
git apply "$SCRIPTS/patches/0050-vk-ps4-level-target-layout.patch"
# A Uint8x4 / Uint16x4 vertex attribute (the skin index) had no GNM mapping and read as R32_FLOAT, so every vertex
# followed bone 0 and the humanoid stayed in its bind pose. The format table now serves any attribute (PRD-784 P4-4).
git apply "$SCRIPTS/patches/0051-vk-ps4-integer-vertex-formats.patch"
# A view of one layer of a layered image (a cube face) was a 2D T# of one slice, so shadPS4 read layer 0 for every
# face, and a load-op clear of a face painted layer 0: the PMREM cube came out empty and every face lit only by the
# environment was black. Layer views are 2D_ARRAY T#s of the whole image; a clear takes its layer (PRD-784 P4-3).
git apply "$SCRIPTS/patches/0052-vk-ps4-layer-views-and-layer-clears.patch"
# Vulkan's clip-space z is 0..w. The driver named the -w..w space (PA_CL_CLIP_CNTL 0) and a -1..1 viewport z transform,
# so shadPS4 ran a negativeOneToOne viewport and every depth landed in 0.5..1: a shadow map held 0.5 + d/2 while the
# lookup compared the plain d, and no caster shadowed anything. DX_CLIP_SPACE_DEF plus z * (max - min) + min (PRD-784 P4-3).
git apply "$SCRIPTS/patches/0053-vk-ps4-dx-clip-space-depth.patch"
# S# MIN_LOD/MAX_LOD are unsigned 4.8. WebGPU's default lodMaxClamp 32 wrapped to 0 under `& 0xFFF`, so every sampler
# read mip 0: minified grids aliased into dashed lines and the normal map lost its relief next to web (PRD-784 visuals).
git apply "$SCRIPTS/patches/0054-vk-ps4-sampler-lod-clamp.patch"
# A mipmapped colour target is micro-tiled on every level: 2D tiling degraded to 1D on the small levels, so the
# rendered PMREM levels had another array mode than the cube that samples them and shadPS4 dropped them (black sky fill).
git apply "$SCRIPTS/patches/0055-vk-ps4-mipmapped-targets-micro-tiled.patch"
# A 3D texture is linear: its upload is the row copy (the tiled upload refuses depth > 1), which
# only lands right in a linear surface. Tiled, the cloud noise volume scrambled (PRD-784 visuals).
git apply "$SCRIPTS/patches/0057-vk-ps4-volumes-linear.patch"
# A storage buffer's V# range is in bytes: the const-buffer base counted 16-byte records, so 15/16 of every
# storage buffer read 0 and dropped writes. The cloth pennant collapsed to a point and never moved (PRD-784 visuals).
git apply "$SCRIPTS/patches/0058-vk-ps4-storage-buffer-byte-range.patch"
# V# i and instancing mode i follow semantic i (a location), not the dense list of declared attributes, so an
# attribute the VS does not read no longer shifts the later ones (PRD-784 visuals).
git apply "$SCRIPTS/patches/0060-vk-ps4-vertex-table-by-semantic.patch"
# radv's GFX7/8 VS reads InstanceID from v1 = InstanceID / VGT_INSTANCE_STEP_RATE_0, which nothing set: at its
# cleared 0 every instance read 0, so instanced meshes and GPU particles drew instance 0 only (PRD-784 sweep).
git apply "$SCRIPTS/patches/0065-vk-ps4-instance-step-rate.patch"
# Nothing wrote PA_SU_SC_MODE_CNTL, so every draw kept the reset value, no culling: a FrontSide mesh drew its
# back faces too. Bind and rebind now emit the pipeline's cull mode and front face; clears draw unculled (P5-8).
git apply "$SCRIPTS/patches/0066-vk-ps4-cull-mode.patch"
# shadPS4 v0.21.0 detiles DISPLAY micro tiling at 128 bpp in the thin order, so an RGBA32F texture read zero at
# every odd texel (procedural-animals' pose texture). 16-byte texels take thin tiling, ordered alike by both (P5-6).
git apply "$SCRIPTS/patches/0067-vk-ps4-128bpp-textures-thin-tiling.patch"
# The clear PS zeroed the four SGPRs of its colour V# before loading through them (and declared USER_SGPR 3),
# and the depth clear's dummy PS exported zeros into the colour target the colour clear left bound: every PS4
# scene pass lost its background colour. Repair the blob at load, mask colour writes in the depth clear, and
# give the colour clear its own target mask, CB mode and depth state (P5-5).
git apply "$SCRIPTS/patches/0068-vk-ps4-clear-keeps-its-colour.patch"
# Dawn bakes WebGPU's depth bias into the pipeline, which the driver never read, and the slope register is in
# 1/16 units: polygonOffset and the lamp shadow bias were no-ops on PS4 (gap sweep).
git apply "$SCRIPTS/patches/0069-vk-ps4-pipeline-depth-bias.patch"
# A depth view's array layer reaches DB_DEPTH_VIEW.SLICE_START: every point-lamp cube face rendered into face 0,
# so PS4 drew no lamp shadow (gap sweep).
git apply "$SCRIPTS/patches/0070-vk-ps4-depth-array-layer.patch"
# A volume's row copy wrote packed rows into its linear-aligned surface: a 3D texture whose width is not
# already aligned read skewed rows, and the cornell GI volume drew blocky streaks (Unreal calibration on PS4).
git apply "$SCRIPTS/patches/0072-vk-ps4-volume-upload-pitch.patch"
# Present flipped from the CPU at once while the GPU still drew the frame: a frame showed with a black band
# over its top whenever the last full-screen pass had not finished (4 of 16 frames with virtual shadows on).
# The flip now rides the GPU queue behind the frame (sceGnmSubmitAndFlipCommandBuffers), so the CPU never waits.
git apply "$SCRIPTS/patches/0077-vk-ps4-present-flips-on-gpu.patch"
# The driver reported a 4096 framebuffer and viewport limit; GCN addresses 16384, and the virtual-shadow atlas
# is about 6500 texels square, so the engine refused it (P5-16).
git apply "$SCRIPTS/patches/0080-vk-ps4-16k-framebuffer-limits.patch"
# A full 256 KB PM4 buffer dropped every later packet without a word: a frame of virtual-shadow pages lost
# its page draws, and those pages read as full shadow. The buffer now continues in chained 1 MB chunks (P5-16).
git apply "$SCRIPTS/patches/0082-vk-ps4-pm4-chunks-grow.patch"
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
