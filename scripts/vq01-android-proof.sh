#!/bin/sh
# PRD-VQ-01 Phase 3, Android box: cook the unchanged examples/abyss-framework/vq-assets fixture for
# the selected Android target (V8 by default), install its APK on one named emulator, and run the shared scenario.
#
#   sh scripts/vq01-android-proof.sh <artifact-dir> <serial>
#
# The V8 engine is the Android default and needs `third_party/v8-android`, which
# `node packages/runtime-native/scripts/download-deps.mjs --android` provisions with a build
# receipt. The playtest runner launches an installed app; it never builds or installs one, so both
# steps are here. Everything it writes is untracked build output.
set -eu

artifacts=${1:?usage: sh scripts/vq01-android-proof.sh <artifact-dir> <serial>}
serial=${2:?usage: sh scripts/vq01-android-proof.sh <artifact-dir> <serial>}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

# adb and the SDK are usually installed but off PATH; Gradle and Kotlin want JDK 17, and the
# Android slice is one ABI so the emulator's x86_64 runtime is the only one this build needs.
: "${ANDROID_HOME:=$HOME/Android/Sdk}"
: "${JAVA_HOME:=/usr/lib/jvm/java-17-openjdk}"
PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH
export PATH JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-$ANDROID_HOME}
adb -s "$serial" get-state >/dev/null

# The authored sources the cook reads, through the same generator the web and desktop lanes use.
node --import tsx -e '
const { generateNativeAssetFixture } = await import("./examples/abyss-framework/vq-assets/generate.ts");
await generateNativeAssetFixture("examples/abyss-framework/vq-assets/.generated/assets");
'

# The maintainer source build cooks for the selected Gradle engine. Default to V8/x86_64;
# append caller flags after the default ABI so an explicit engine or ABI remains authoritative.
(
  cd examples/abyss-framework/vq-assets
  THREENATIVE_RUNTIME_SOURCE="$root/packages/runtime-native" \
  THREENATIVE_GRADLE_ARGS="-PthreenativeAbis=x86_64 ${THREENATIVE_GRADLE_ARGS:--PthreenativeJsEngine=v8}" \
    node "$root/packages/create-threenative/dist/threenative.js" build --target android --allow-source-build
)

apk=examples/abyss-framework/vq-assets/dist-native/vq-native-assets.apk
adb -s "$serial" install -r --no-streaming "$apk"

node packages/playtest/dist/runner/cli.js \
  examples/abyss-framework/playtests/vq-native-asset-capabilities.playtest.json \
  --target android \
  --device "$serial" \
  --package com.threenative.vq01 \
  --activity com.threenative.runtime.MystralActivity \
  --adb "$ANDROID_HOME/platform-tools/adb" \
  --artifact "$apk" \
  --build-report "$apk.build-report.json" \
  --timeout 120000 \
  --artifacts "$artifacts"