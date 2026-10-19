# The `tn-local` self-hosted runner image (PRD-480). One container per job: `scripts/ci-runners.sh`
# starts a host-side loop of `docker run --rm`, so nothing survives a job but the image itself.
#
# Ubuntu 24.04 to match hosted `ubuntu-24.04`, with the `runner` user's passwordless sudo intact so
# the workflow's own `sudo apt-get install` steps keep working. The Docker CLI is deliberately
# absent and the socket is never mounted: `supply-chain` needs `docker run` for gitleaks and stays
# on a hosted runner for exactly that reason.
FROM ghcr.io/actions/actions-runner:latest

USER root

# Build and test toolchain the moving Linux jobs take from the hosted image. `git`, `curl`, `jq`
# and `unzip` are the runner's own prerequisites; the rest is what ci.yml's jobs actually invoke.
# Playwright's Chromium dependencies are the exact `tools` and `chromium` lists Playwright 1.62.1
# resolves for ubuntu24.04-x64 (playwright-core's bundled nativeDeps), transcribed so the apt layer
# does not depend on the Node layer below.
# The -dev packages and xcompmgr are what the native jobs `apt-get install` every run (52 s of
# test-native, run 37089715252); baked in, that step finds them present. Mesa's Vulkan ICDs stay
# per-job: baked in, they blanked the tone and decals captures.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build ccache clang lld pkg-config \
      git curl jq unzip zip xz-utils xvfb xauth python3 python3-pip \
      7zip ffmpeg imagemagick zstd file lsof procps openjdk-17-jdk-headless \
      libasound2-dev libcurl4-openssl-dev libfontconfig1-dev libfreetype6-dev libgtk-3-dev \
      libpulse-dev libudev-dev libwebkit2gtk-4.1-dev libx11-dev libxcomposite-dev libxcursor-dev \
      libxext-dev libxfixes-dev libxi-dev libxkbcommon-dev libxrandr-dev libxss-dev xcompmgr zlib1g-dev \
      fonts-noto-color-emoji fonts-unifont fonts-liberation fonts-freefont-ttf \
      libfontconfig1 libfreetype6 \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 \
      libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 \
      libnspr4 libnss3 libpango-1.0-0 \
      libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
 && rm -rf /var/lib/apt/lists/*

# Hosted ubuntu-24.04 ships Node 20 and gh on PATH, and jobs rely on both before any setup step:
# the `scope` job runs `node scripts/ci-change-scope.mjs` straight after checkout.
ARG NODE_VERSION=20.19.6
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  | tar -xJ -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=README.md --exclude=LICENSE \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Android platform-tools where hosted ubuntu-24.04 keeps its SDK: the playtest doctor resolves adb
# through ANDROID_HOME before PATH.
ENV ANDROID_HOME=/usr/local/lib/android/sdk ANDROID_SDK_ROOT=/usr/local/lib/android/sdk
# Hosted runners run in C.UTF-8; without it javac reads sources as US-ASCII and rejects an em dash.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
# The emulator lane writes a udev rule before it starts; hosted has the directory, the base image does not.
RUN mkdir -p /etc/udev/rules.d "$ANDROID_HOME" \
 && curl -fsSL https://dl.google.com/android/repository/platform-tools-latest-linux.zip -o /tmp/pt.zip \
 && unzip -q /tmp/pt.zip -d "$ANDROID_HOME" && rm /tmp/pt.zip \
 && ln -s "$ANDROID_HOME/platform-tools/adb" /usr/local/bin/adb

# The SDK every routed native-platforms Android step calls into. `sdkmanager` is the whole of it:
# `android-actions/setup-android` uses an already-installed `cmdline-tools/latest` when the version
# matches, the workflows run their own `sdkmanager "platforms;android-35" "build-tools;35.0.0"
# "ndk;28.2.13676358"`, and `android-emulator-runner` installs what it is missing from it. The
# versions are the ones this repository pins — build-tools 35.0.0, which is also the emulator
# action's own constant; platforms 35 for the parity lane's api-level and 36, which
# packages/runtime-native/android/app/build.gradle.kts declares as compileSdk; and the NDK, which
# that same file names in `ndkVersion` and which the Android V8 build refuses to start without.
# Licenses are accepted at build time so none of those job-time installs stalls on a prompt.
# `emulator` and the system image are deliberately absent: android-emulator-runner installs both
# itself, which is the only Android job that wants them.
ARG CMDLINE_TOOLS=12266719
RUN set -eu; \
    curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip" -o /tmp/cli.zip; \
    mkdir -p "$ANDROID_HOME/cmdline-tools"; \
    unzip -q /tmp/cli.zip -d "$ANDROID_HOME/cmdline-tools"; \
    rm /tmp/cli.zip; \
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"; \
    export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"; \
    yes | sdkmanager --licenses > /dev/null; \
    sdkmanager --install "platform-tools" "platforms;android-35" "platforms;android-36" \
      "build-tools;35.0.0" "ndk;28.2.13676358" > /dev/null; \
    rm -rf "$ANDROID_HOME/.temp"; \
    # `runner` owns the SDK, because sdkmanager writes into ANDROID_HOME at job time: the workflows \
    # install their own packages and android-emulator-runner installs the emulator, the platform and \
    # the system image, and a root-owned SDK fails the write as the unprivileged job user. Chowned \
    # here rather than in a later layer, which would copy the whole SDK up and double its size. \
    chown -R runner:runner "$ANDROID_HOME"
ENV PATH=/usr/local/lib/android/sdk/cmdline-tools/latest/bin:$PATH

COPY entrypoint.sh /home/runner/entrypoint.sh

# Rust as hosted ubuntu-24.04 has it (stable, on PATH): the native physics ABI is built with cargo.
# Installed as `runner` so cargo can write its own registry and target caches.
USER runner
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH=/home/runner/.cargo/bin:$PATH
USER root
RUN chmod 0755 /home/runner/entrypoint.sh

USER runner
WORKDIR /home/runner
ENTRYPOINT ["/home/runner/entrypoint.sh"]
