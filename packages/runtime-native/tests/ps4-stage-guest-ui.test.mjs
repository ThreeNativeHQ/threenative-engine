import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import { stageGuestUi } from '../scripts/ps4/stage-guest-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function scene(files) {
  const dir = makeTempDirSync('tn-ps4-ui-');
  const built = path.join(dir, 'scene', '.threenative', 'build', 'ui-css');
  mkdirSync(built, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(built, name), text);
  mkdirSync(path.join(dir, 'app'));
  return { app: path.join(dir, 'app'), scene: path.join(dir, 'scene') };
}

test('stages the built UI, a stub index.html and one OFL font beside game.js (PRD-784)', () => {
  const { app, scene: dir } = scene({ 'index-1.css': 'body{color:red}', 'stylesheets.json': '{"version":1,"stylesheets":["index-1.css"]}' });
  const ui = stageGuestUi(dir, app, {});
  assert.equal(ui, path.join(app, 'ui'));
  assert.ok(existsSync(path.join(ui, 'index.html')));
  assert.ok(readdirSync(ui).includes('NotoSans-Regular.ttf'));
  assert.deepEqual(JSON.parse(readFileSync(path.join(ui, 'stylesheets.json'), 'utf8')).stylesheets, ['index-1.css', 'zz-ps4-fonts.css']);
});

test('keeps the UI font when the build ships one, and stages nothing for a scene with no UI', () => {
  const { app, scene: dir } = scene({ 'a.css': 'x{}', 'own.woff2': 'f' });
  assert.ok(!readdirSync(stageGuestUi(dir, app, {})).includes('zz-ps4-fonts.css'));
  assert.equal(stageGuestUi(path.join(dir, 'missing'), app, {}), '');
  // The previous scene's ui/ must go, or the player attaches a UI this scene never shipped.
  assert.ok(!existsSync(path.join(app, 'ui')));
});

test('the Rust archives call the musl-ABI shims, not OpenOrbis libc (PRD-784)', () => {
  const e5 = readFileSync(path.join(root, 'scripts/ps4/e5-build.sh'), 'utf8');
  for (const name of ['readdir', 'stat', 'lstat', 'fstat', 'open', 'openat']) assert.match(e5, new RegExp(`${name} tn_musl_${name}`, 'u'));
  assert.match(e5, /CSS_UI_LIB="\$\(musl_abi "\$CSS_UI_LIB"\)"/u);
  const shim = readFileSync(path.join(root, 'scripts/ps4/ps4-guest-libcxx.cc'), 'utf8');
  for (const name of ['readdir', 'stat', 'lstat', 'fstat', 'open', 'openat']) assert.match(shim, new RegExp(` tn_musl_${name}\\(`, 'u'));
  assert.match(shim, /#undef pthread_getattr_np/u);
});

test('a guest abort names its caller (PRD-784)', () => {
  assert.match(readFileSync(path.join(root, 'scripts/ps4/e5-build.sh'), 'utf8'), /--wrap=abort/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/ps4-guest-libcxx.cc'), 'utf8'), /void __wrap_abort\(void\)[^}]*TN_PS4_ABORT caller=/su);
});

test('integer vertex attributes keep their format, so skinned meshes animate (PRD-784)', () => {
  // Read as R32_FLOAT, the Uint8x4/Uint16x4 skin index gave every vertex bone 0: the humanoid stayed in bind pose.
  assert.match(readFileSync(path.join(root, 'scripts/ps4/e2-build.sh'), 'utf8'), /git apply "\$SCRIPTS\/patches\/0051-vk-ps4-integer-vertex-formats\.patch"/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0051-vk-ps4-integer-vertex-formats.patch'), 'utf8'), /^\+\s+GnmDataFormat mapped = vk_ps4_vk_format_to_gnm_buffer\(format\);/mu);
});

test('a cube face view and its clear keep their layer, so the environment light is not black (PRD-784)', () => {
  // A one-face view was a 1-slice 2D T# and a face clear painted layer 0: the PMREM cube came out empty.
  assert.match(readFileSync(path.join(root, 'scripts/ps4/e2-build.sh'), 'utf8'), /git apply "\$SCRIPTS\/patches\/0052-vk-ps4-layer-views-and-layer-clears\.patch"/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0052-vk-ps4-layer-views-and-layer-clears.patch'), 'utf8'), /^\+\s+view->create_info\.subresourceRange\.baseArrayLayer\);/mu);
});

test('depth uses Vulkan 0..1 clip space, so shadow maps compare the depth they stored (PRD-784)', () => {
  // PA_CL_CLIP_CNTL 0 named the -w..w space: every depth landed in 0.5..1 and no caster shadowed anything.
  assert.match(readFileSync(path.join(root, 'scripts/ps4/e2-build.sh'), 'utf8'), /git apply "\$SCRIPTS\/patches\/0053-vk-ps4-dx-clip-space-depth\.patch"/u);
  const patch = readFileSync(path.join(root, 'scripts/ps4/patches/0053-vk-ps4-dx-clip-space-depth.patch'), 'utf8');
  assert.match(patch, /^\+.*R_028810_PA_CL_CLIP_CNTL, S_028810_DX_CLIP_SPACE_DEF\(1\)\);/mu);
  assert.match(patch, /^\+\s+vp_info\.offset\[2\] = vp->minDepth;/mu);
});

test('TN_PS4_HOST_HZ runs the emulator in gamescope inside the lane Xvfb, so E5 can pass above 60 fps (PRD-784)', () => {
  // Each present copied into Xvfb held the guest at 60 fps; gamescope takes it with no copy and the captures still read Xvfb.
  const runner = readFileSync(path.join(root, 'scripts/ps4/run-experiment.mjs'), 'utf8');
  assert.match(runner, /'gamescope', '--backend', 'sdl'/u);
  assert.match(runner, /\$TN_PS4_HOST_WRAP "\$appimage" -g "\$eboot" &/u);
  assert.match(runner, /vblank_frequency: HOST_HZ/u);
  // On by default where gamescope exists; TN_PS4_HOST_HZ=0 is the named override and the run reports it.
  assert.match(runner, /HOST_HZ_SET \? Number\(process\.env\.TN_PS4_HOST_HZ\) : HAS_GAMESCOPE \? 144 : 0/u);
  assert.match(runner, /PS4_EMULATED host: plain Xvfb/u);
});

test('sampler LODs clamp to the 4.8 field, so WebGPU maxLod 32 keeps the mips (PRD-784)', () => {
  // (32 * 256) & 0xFFF is 0: every sampler read mip 0 and minified grids aliased into dashed lines.
  assert.match(readFileSync(path.join(root, 'scripts/ps4/e2-build.sh'), 'utf8'), /git apply "\$SCRIPTS\/patches\/0054-vk-ps4-sampler-lod-clamp\.patch"/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0054-vk-ps4-sampler-lod-clamp.patch'), 'utf8'), /^\+\s+if \(max_lod > 4095\.0f \/ 256\.0f\) max_lod = 4095\.0f \/ 256\.0f;/mu);
});

test('a mipmapped colour target is micro-tiled on every level, so its rendered levels are sampled (PRD-784)', () => {
  // 2D tiling degraded to 1D on small levels; shadPS4 then dropped the rough PMREM levels and every shadow read black.
  assert.match(readFileSync(path.join(root, 'scripts/ps4/e2-build.sh'), 'utf8'), /git apply "\$SCRIPTS\/patches\/0055-vk-ps4-mipmapped-targets-micro-tiled\.patch"/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0055-vk-ps4-mipmapped-targets-micro-tiled.patch'), 'utf8'), /^\+\s+: mip_levels > 1 \? GNM_TM_DISPLAY_1D_THIN/mu);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0055-vk-ps4-mipmapped-targets-micro-tiled.patch'), 'utf8'), /^\+\s+tex_ci\.tilemodehint = mip_levels > 1 \? GNM_TM_DISPLAY_1D_THIN/mu);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/e2-build.sh'), 'utf8'), /git apply "\$SCRIPTS\/patches\/0056-opengnm-psbc-front-face-float\.patch"/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0056-opengnm-psbc-front-face-float.patch'), 'utf8'), /^\+\s+\.spibaryccntl = S_0286E0_FRONT_FACE_ALL_BITS\(0\),/mu);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/e2-build.sh'), 'utf8'), /git apply "\$SCRIPTS\/patches\/0057-vk-ps4-volumes-linear\.patch"/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0057-vk-ps4-volumes-linear.patch'), 'utf8'), /^\+\s+if \(pCreateInfo->imageType == VK_IMAGE_TYPE_3D\) tex_ci\.tilemodehint = GNM_TM_DISPLAY_LINEAR_ALIGNED;/mu);
});

test('a storage buffer range counts bytes, so compute writes and vertex reads reach the whole buffer (PRD-784)', () => {
  // num_records stayed in 16-byte records with stride 0: 15/16 of each storage buffer read 0, and the cloth pennant vanished.
  assert.match(readFileSync(path.join(root, 'scripts/ps4/e2-build.sh'), 'utf8'), /git apply "\$SCRIPTS\/patches\/0058-vk-ps4-storage-buffer-byte-range\.patch"/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0058-vk-ps4-storage-buffer-byte-range.patch'), 'utf8'), /^\+\s+gnm_buf->numrecords = size;/mu);
});

test('a VS input is its attribute location on both sides, so a skipped location keeps later inputs (PRD-784)', () => {
  // The cloth pennant reads uv at location 1 and no position: dense indices fetched uv into the wrong VGPRs.
  const build = readFileSync(path.join(root, 'scripts/ps4/e2-build.sh'), 'utf8');
  assert.match(build, /git apply "\$SCRIPTS\/patches\/0059-opengnm-psbc-vs-inputs-by-location\.patch"/u);
  assert.match(build, /git apply "\$SCRIPTS\/patches\/0060-vk-ps4-vertex-table-by-semantic\.patch"/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0059-opengnm-psbc-vs-inputs-by-location.patch'), 'utf8'), /^\+\s+\.vgpr = ctx->rargs->ac\.args\[ctx->rargs->vs_inputs\[loc\]\.arg_index\]\.offset,/mu);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0060-vk-ps4-vertex-table-by-semantic.patch'), 'utf8'), /^\+\s+if \(vi->pVertexAttributeDescriptions\[j\]\.location == pipe->vs_input_semantics\[i\]\.semantic\) \{/mu);
});

test('base_vertex has its own user SGPR and the driver writes it, so gl_VertexIndex is exact (PRD-784)', () => {
  // base_vertex sat in the high half of the 64-bit vertex buffer table pointer: the cloth VS added the
  // pointer's high dword to every vertex index (a torn pennant), and writing base_vertex zeroed the pointer.
  const build = readFileSync(path.join(root, 'scripts/ps4/e2-build.sh'), 'utf8');
  assert.match(build, /git apply "\$SCRIPTS\/patches\/0063-opengnm-psbc-vertex-buffer-table-64bit\.patch"/u);
  assert.match(build, /git apply "\$SCRIPTS\/patches\/0061-opengnm-psbc-base-vertex-slot\.patch"/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0063-opengnm-psbc-vertex-buffer-table-64bit.patch'), 'utf8'), /^\+\s+state->args->user_sgprs_locs\.shader_data\[AC_UD_VS_VERTEX_BUFFERS\]\.num_sgprs\+\+;/mu);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/patches/0061-opengnm-psbc-base-vertex-slot.patch'), 'utf8'), /^\+\s+\.apislot = 0xFE,/mu);
});

test('refuses a UI with no stylesheet', () => {
  const { app, scene: dir } = scene({ 'a.png': 'x' });
  assert.throws(() => stageGuestUi(dir, app, {}), /TN_PS4_UI_NO_CSS/u);
});

test('the PS4 eboot links the CSS UI archive, built by ps4-deps (PRD-784)', () => {
  const e5 = readFileSync(path.join(root, 'scripts/ps4/e5-build.sh'), 'utf8');
  assert.match(e5, /x86_64-unknown-linux-musl\/release\/libthreenative_css_ui\.a/u);
  assert.match(e5, /\$\{CSS_UI_LIB:\+"\$CSS_UI_LIB"\}/u);
  assert.match(e5, /build-native-css-ui\.mjs --ps4/u);
  assert.match(readFileSync(path.join(root, 'scripts/ps4/ps4-deps.sh'), 'utf8'), /build-native-css-ui\.mjs --ps4/u);
  assert.match(readFileSync(path.join(root, 'CMakePresets.json'), 'utf8'), /"TN_ENABLE_CSS_UI": "ON"/u);
});
