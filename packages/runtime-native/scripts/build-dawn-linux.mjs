#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Same Linux recipe as the pinned upstream ci.yml; no host packages or cleanup.
const sourceCommit = 'd14ae3d97ad74100e9f382efef5e9c0872ddbeb2';
const container = 'dockcross/manylinux_2_28-x64@sha256:5c844b0636fc4837dfa06f7ea1790c7b6cf22790b1082c3b3410320fce145c6e';
const topdir = `Dawn-${sourceCommit}-ubuntu-latest-Release`;
const flags = [
  '-C', '.github/workflows/dawn-ci.cmake',
  '-DCMAKE_CXX_COMPILER=g++', '-DCMAKE_C_COMPILER=gcc',
  '-DCMAKE_BUILD_TYPE=Release', '-DDAWN_USE_WAYLAND=ON', '-DDAWN_USE_X11=ON',
];

if (process.argv.length !== 2) throw new Error('Usage: node build-dawn-linux.mjs (no arguments)');
const output = fileURLToPath(new URL('../artifacts/dawn-linux-x64/', import.meta.url));
mkdirSync(fileURLToPath(new URL('../artifacts/', import.meta.url)), { recursive: true });
// Refuse previous build trees rather than reusing stale CMake or dependency state.
mkdirSync(output);
const result = spawnSync('docker', [
  'run', '--rm', '--platform', 'linux/amd64',
  '--volume', `${output}:/work`, '--workdir', '/work',
  '--entrypoint', '/bin/bash', container, '-euo', 'pipefail', '-c', `
test "$(uname -m)" = x86_64
git init source
cd source
git remote add origin https://github.com/google/dawn.git
git fetch --depth=1 origin ${sourceCommit}
git checkout --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = ${sourceCommit}
dnf install -y mesa-libGL-devel libxcb libxcb-devel libX11-xcb libXcursor-devel libXrandr-devel libXinerama-devel libXi-devel libXext-devel libxkbcommon libxkbcommon-devel libxkbcommon-x11-devel mesa-vulkan-drivers wayland-protocols-devel wayland-devel
cmake -S . -B out/Release ${flags.join(' ')}
cmake --build out/Release --config Release --parallel 4
cmake --install out/Release --config Release --prefix /work/${topdir}
test -s /work/${topdir}/include/webgpu/webgpu.h
test -s /work/${topdir}/include/webgpu/webgpu_cpp.h
test -s /work/${topdir}/lib64/libwebgpu_dawn.a || test -s /work/${topdir}/lib/libwebgpu_dawn.a
for library in /work/${topdir}/lib64/libwebgpu_dawn.a /work/${topdir}/lib/libwebgpu_dawn.a; do
  if test -s "$library"; then strings "$library" > /work/dawn-symbols.txt; break; fi
done
for symbol in vkCreateWaylandSurfaceKHR vkCreateXcbSurfaceKHR vkCreateXlibSurfaceKHR; do
  grep -Fx "$symbol" /work/dawn-symbols.txt
done
cd /work
cmake -E tar czf ${topdir}.tar.gz ${topdir}
`,
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Dawn container failed: ${result.status ?? result.signal}`);
const archive = `${topdir}.tar.gz`;
writeFileSync(`${output}/manifest-linux-x64.json`, `${JSON.stringify({
  artifact_revision: 1,
  upstream_commit: sourceCommit,
  source_commit: sourceCommit,
  target: 'linux-x64',
  expected_tag: 'dawn-linux-x64-v1',
  toolchain: { container, flags, DAWN_FETCH_DEPENDENCIES: 'ON', DAWN_ENABLE_INSTALL: 'ON' },
  archive,
  archive_sha256: createHash('sha256').update(readFileSync(`${output}/${archive}`)).digest('hex'),
}, null, 2)}\n`);
