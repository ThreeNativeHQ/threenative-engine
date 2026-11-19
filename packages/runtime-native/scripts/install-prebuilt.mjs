#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
export const RELEASE_REPOSITORY = 'ThreeNativeHQ/threenative-engine';

/** Every asset a packaged consumer or native release workflow may request. */
export const PREBUILT_ASSET_NAMES = Object.freeze({
  'android-arm64-v8a-runtime': 'threenative-runtime-android-arm64-v8a.so',
  'android-arm64-v8a-runtime-v8': 'threenative-runtime-android-arm64-v8a-v8.so',
  'android-arm64-v8a-sdl3': 'threenative-sdl3-android-arm64-v8a.so',
  'android-arm64-v8a-v8': 'threenative-v8-android-arm64-v8a.so',
  'android-arm64-v8a-libcxx': 'threenative-libcxx-android-arm64-v8a.so',
  'android-arm64-v8a-v8-snapshot': 'threenative-v8-snapshot-android-arm64-v8a.bin',
  'android-sdl3-aar': 'threenative-sdl3-android.aar',
  'android-x86_64-runtime': 'threenative-runtime-android-x86_64.so',
  'android-x86_64-runtime-v8': 'threenative-runtime-android-x86_64-v8.so',
  'android-x86_64-sdl3': 'threenative-sdl3-android-x86_64.so',
  'android-x86_64-v8': 'threenative-v8-android-x86_64.so',
  'android-x86_64-libcxx': 'threenative-libcxx-android-x86_64.so',
  'android-x86_64-v8-snapshot': 'threenative-v8-snapshot-android-x86_64.bin',
  'darwin-arm64-engine-player': 'threenative-engine-player-darwin-arm64',
  'darwin-arm64': 'threenative-runtime-darwin-arm64',
  'darwin-arm64-tools': 'threenative-tools-darwin-arm64',
  'ios-simulator-arm64': 'threenative-ios-simulator-arm64.zip',
  'linux-x64-engine-player': 'threenative-engine-player-linux-x64',
  'linux-x64': 'threenative-runtime-linux-x64',
  'linux-x64-tools': 'threenative-tools-linux-x64',
  'win32-x64-engine-player': 'threenative-engine-player-win32-x64.exe',
  'win32-x64': 'threenative-runtime-win32-x64.exe',
  'win32-x64-tools': 'threenative-tools-win32-x64.exe',
});

/** Every key a packaged consumer or native release workflow may request. */
export const PREBUILT_KEYS = Object.freeze(Object.keys(PREBUILT_ASSET_NAMES));

/**
 * Rows this repository builds and verifies on every release run but does not publish.
 *
 * Only macOS. Gatekeeper hard-refuses an unsigned, un-notarized bundle downloaded from the web, so
 * a macOS asset without an Apple Developer Program identity is not a shippable artifact — it is a
 * support ticket. Windows is different: an unsigned executable runs, SmartScreen only warns, so
 * `win32-x64` ships unsigned rather than waiting on a certificate.
 *
 * The row keeps building and verifying on every release run — a row that stops compiling rots
 * silently — it is simply not advertised as downloadable, which is the narrowing PRD-262 allows in
 * place of building every claimed row. Publishing it again is one entry, once the Apple identity
 * exists. Status and cost of every platform's signing inputs: `docs/RELEASE-SIGNING.md`.
 */
export const UNPUBLISHED_PREBUILT_KEYS = Object.freeze(['darwin-arm64', 'darwin-arm64-tools', 'darwin-arm64-engine-player']);

/** The exact cohort a release publishes and a consumer may download. */
export const PUBLISHED_PREBUILT_KEYS = Object.freeze(
  PREBUILT_KEYS.filter((key) => !UNPUBLISHED_PREBUILT_KEYS.includes(key)),
);

const supported = new Set(['darwin-arm64', 'linux-x64', 'win32-x64']);

/**
 * The desktop runtime dispatches `threenative build --target desktop` to a `mystral-tools` helper
 * sitting beside its own executable (`src/cli/tool_dispatch.cpp:52`). A consumer that installs only
 * the runtime gets `build tool helper is missing` and exit 127, so the helper is a published
 * release asset of its own and is installed beside the runtime by the same atomic install.
 */
export function toolsKey(key) {
  return supported.has(key) ? `${key}-tools` : undefined;
}

export function toolsFilename(platform = process.platform) {
  return platform === 'win32' ? 'mystral-tools.exe' : 'mystral-tools';
}

export function platformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!supported.has(key)) throw new Error(`Unsupported native runtime platform '${key}'.`);
  return key;
}

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function verifyChecksum(contents, expected, key) {
  const actual = sha256(contents);
  if (!/^[a-f0-9]{64}$/u.test(expected) || actual !== expected) {
    throw new Error(`Checksum verification failed for '${key}': expected ${expected}, received ${actual}.`);
  }
}

function releaseFromManifest(manifest, key) {
  if (UNPUBLISHED_PREBUILT_KEYS.includes(key)) {
    const error = new Error(
      `No prebuilt release is published for '${key}'. This platform builds from an engine checkout until its release credentials exist; see PRD-262.`,
    );
    error.code = 'PREBUILT_RELEASE_UNPUBLISHED';
    throw error;
  }
  const release = manifest?.artifacts?.[key];
  if (!release?.url || !release?.sha256) {
    const error = new Error(`No prebuilt release asset is recorded for '${key}'.`);
    if (key.endsWith('-engine-player')) error.code = 'PREBUILT_RELEASE_UNPUBLISHED';
    throw error;
  }
  if (typeof release.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(release.sha256)) {
    throw new Error(`Invalid prebuilt SHA-256 for '${key}'.`);
  }
  const url = new URL(release.url);
  if (url.protocol !== 'https:' && process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT !== '1') {
    throw new Error(`Prebuilt release URL for '${key}' must use HTTPS.`);
  }
  return release;
}

function isLoopbackFixture(url) {
  return process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT === '1' &&
    url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
    !url.username && !url.password;
}

/**
 * The keys a manifest declares it advertises.
 *
 * A manifest may carry `requiredKeys`; absent, the strict full-cohort default below is unchanged, so
 * the official CI release keeps its guarantee. A scoped manifest is how a local release states which
 * of the platform matrices this host actually built, without claiming the rest.
 */
function declaredRequiredKeys(manifest) {
  if (manifest.requiredKeys === undefined) return undefined;
  if (!Array.isArray(manifest.requiredKeys) || manifest.requiredKeys.length === 0 ||
      manifest.requiredKeys.some((key) => typeof key !== 'string')) {
    throw new Error('Prebuilt manifest requiredKeys must be a non-empty array of prebuilt release keys.');
  }
  for (const key of manifest.requiredKeys) {
    if (!Object.hasOwn(PREBUILT_ASSET_NAMES, key)) {
      throw new Error(`Unknown prebuilt release key '${key}' in manifest requiredKeys.`);
    }
  }
  return manifest.requiredKeys;
}

function validateManifestEnvelope(manifest, options) {
  if (manifest?.schemaVersion !== 1) throw new Error('Unsupported or missing prebuilt manifest schemaVersion.');
  const version = options.version ?? packageVersion;
  if (manifest.version !== version) {
    throw new Error(`Prebuilt manifest version mismatch: expected ${version}, received ${manifest.version}.`);
  }
  if (typeof manifest.sourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(manifest.sourceSha)) {
    throw new Error('Prebuilt manifest must record a full source SHA.');
  }
  if (options.sourceSha !== undefined && manifest.sourceSha !== options.sourceSha) {
    throw new Error(`Prebuilt source SHA mismatch: expected ${options.sourceSha}, received ${manifest.sourceSha}.`);
  }
  declaredRequiredKeys(manifest);
  if (!manifest.artifacts || typeof manifest.artifacts !== 'object' || Array.isArray(manifest.artifacts)) {
    throw new Error('Prebuilt manifest artifacts must be an object.');
  }
  return version;
}

function validateManifestArtifact(manifest, key, version) {
  if (!Object.hasOwn(PREBUILT_ASSET_NAMES, key)) throw new Error(`Unknown prebuilt release key '${key}'.`);
  const release = releaseFromManifest(manifest, key);
  if (!Number.isSafeInteger(release.size) || release.size <= 0) {
    throw new Error(`Prebuilt release size for '${key}' must be a positive integer.`);
  }
  const expectedUrl = `${releaseManifestUrl(version).replace('/prebuilt-lock.json', '')}/${PREBUILT_ASSET_NAMES[key]}`;
  const url = new URL(release.url);
  if (release.url !== expectedUrl && !isLoopbackFixture(url)) {
    throw new Error(`Prebuilt release URL for '${key}' must match version ${version}: ${expectedUrl}.`);
  }
}

/** Validate the entire advertised cohort before selecting even one consumer artifact. */
export function validateReleaseManifest(manifest, options = {}) {
  const version = validateManifestEnvelope(manifest, options);
  // A caller's explicit scope wins; then the manifest's own advertised keys; then the strict
  // non-iOS cohort. iOS retains its separate release gate, so it is not a prerequisite for a
  // non-iOS consumer, and a scoped local manifest is accepted for exactly the keys it names.
  const requiredKeys = options.requiredKeys ?? declaredRequiredKeys(manifest) ??
    PUBLISHED_PREBUILT_KEYS.filter((key) => !key.startsWith('ios-'));
  for (const key of requiredKeys) releaseFromManifest(manifest, key);
  for (const key of Object.keys(manifest.artifacts)) validateManifestArtifact(manifest, key, version);
  return manifest;
}

/**
 * The release workflow uses this same validator, including its existing iOS requirement.
 *
 * `keys` narrows the matrix to the artifacts this caller staged: the lock then advertises exactly
 * those keys (`requiredKeys`) and refuses if one is missing from the directory. Omitted, the full
 * published matrix is required and the lock carries no `requiredKeys`, so every consumer keeps the
 * strict default.
 */
export function generateReleaseManifest(directory, { repository, tag, sourceSha, keys }) {
  if (repository !== RELEASE_REPOSITORY) {
    throw new Error(`Prebuilt releases must be published by ${RELEASE_REPOSITORY}, received ${repository}.`);
  }
  if (tag !== releaseTag()) {
    throw new Error(`Prebuilt release tag must be ${releaseTag()}, received ${tag}.`);
  }
  const selectedKeys = keys === undefined ? [...PUBLISHED_PREBUILT_KEYS] : keys;
  if (!Array.isArray(selectedKeys) || selectedKeys.length === 0) {
    throw new Error('Prebuilt release keys must be a non-empty array.');
  }
  const published = selectedKeys.map((key) => {
    if (!Object.hasOwn(PREBUILT_ASSET_NAMES, key)) throw new Error(`Unknown prebuilt release key '${key}'.`);
    return [key, PREBUILT_ASSET_NAMES[key]];
  });
  const expected = published.map(([, name]) => name).sort();
  const actual = readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Incomplete prebuilt release matrix: expected ${expected.join(', ')}; received ${actual.join(', ')}.`);
  }
  const artifacts = Object.fromEntries(published.map(([key, name]) => {
    const contents = readFileSync(join(directory, name));
    if (contents.length === 0) throw new Error(`Prebuilt release asset '${key}' is empty.`);
    return [key, { sha256: sha256(contents), size: contents.length,
      url: `${releaseManifestUrl().replace('/prebuilt-lock.json', '')}/${name}` }];
  }));
  return validateReleaseManifest(
    { schemaVersion: 1, version: packageVersion, sourceSha, artifacts,
      ...(keys === undefined ? {} : { requiredKeys: [...selectedKeys] }) },
    { sourceSha, requiredKeys: selectedKeys },
  );
}

export function readRelease(manifestPath, key) {
  if (!existsSync(manifestPath)) {
    const error = new Error(`No prebuilt release manifest exists for '${key}'; this target remains OPEN.`);
    error.code = key.endsWith('-engine-player') ? 'PREBUILT_RELEASE_UNPUBLISHED' : 'PREBUILT_RELEASE_MISSING';
    throw error;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Explicit artifact-only local pins predate the envelope. Never downgrade a partially
  // specified candidate, and never allow this compatibility path for a remote default lock.
  if (manifest && ['schemaVersion', 'version', 'sourceSha'].some((field) => Object.hasOwn(manifest, field))) {
    validateReleaseManifest(manifest);
  }
  return releaseFromManifest(manifest, key);
}

/** The GitHub release tag a version's prebuilt payload is published under. */
export function releaseTag(version = packageVersion) {
  return `runtime-native-v${version}`;
}

export function releaseManifestUrl(version = packageVersion) {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/${releaseTag(version)}/prebuilt-lock.json`;
}

export function writeInstallStatus(status, statusPath = join(packageRoot, 'prebuilt', 'install-status.json')) {
  mkdirSync(dirname(statusPath), { recursive: true });
  const temporary = `${statusPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, statusPath);
    return statusPath;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function createInstallPlan(options) {
  const platform = options.platform ?? process.platform;
  const platformId = `${platform}-${options.arch ?? process.arch}`;
  const key = options.enginePlayer ? `${platformId}-engine-player` : platformId;
  const filename = options.enginePlayer
    ? `tn-native-engine-player-v8${platform === 'win32' ? '.exe' : ''}`
    : platform === 'win32' ? 'threenative-runtime.exe' : 'threenative-runtime';
  const output = resolve(options.output ?? join(packageRoot, 'prebuilt', platformId, filename));
  const statusPath = resolve(options.statusPath ?? (options.output
    ? join(dirname(output), options.enginePlayer ? 'engine-player-install-status.json' : 'install-status.json')
    : join(packageRoot, 'prebuilt', options.enginePlayer ? 'engine-player-install-status.json' : 'install-status.json')));
  if (output === statusPath) throw new Error('Prebuilt output and install status paths must differ.');
  const toolsOutput = join(dirname(output), toolsFilename(platform));
  if (toolsOutput === output) throw new Error('Prebuilt runtime and build tool helper paths must differ.');
  return { platform, key, output, statusPath, toolsOutput, toolsKey: toolsKey(key),
    status: { key, url: options.manifestPath ?? process.env.THREENATIVE_PREBUILT_MANIFEST ??
      options.manifestUrl ?? releaseManifestUrl(), version: packageVersion } };
}

function beginInstall(plan, arch) {
  rmSync(plan.output, { force: true });
  if (plan.toolsKey) rmSync(plan.toolsOutput, { force: true });
  rmSync(plan.statusPath, { force: true });
  writeInstallStatus({ ...plan.status, ok: false, reason: 'installing' }, plan.statusPath);
  platformKey(plan.platform, arch);
}

function publishBinary(target, contents, platform) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temporary, contents, { flag: 'wx' });
    if (platform !== 'win32') chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// The success marker is written only once all requested binaries are in place: a desktop build that finds
// the runtime but not the helper dies inside the packager with exit 127, which is exactly the
// stale-success shape this install exists to prevent.
function publishInstall(plan, contents, toolsContents) {
  publishBinary(plan.output, contents, plan.platform);
  if (plan.toolsKey) publishBinary(plan.toolsOutput, toolsContents, plan.platform);
  writeInstallStatus({ ...plan.status, ok: true, reason: 'installed', sha256: sha256(contents),
    ...(plan.toolsKey ? { toolsSha256: sha256(toolsContents) } : {}) }, plan.statusPath);
}

function recordInstallFailure(plan, error) {
  try {
    rmSync(plan.output, { force: true });
    if (plan.toolsKey) rmSync(plan.toolsOutput, { force: true });
    writeInstallStatus({ ...plan.status, ok: false,
      reason: error instanceof Error ? error.message : String(error) }, plan.statusPath);
  } catch (statusError) {
    rmSync(plan.statusPath, { force: true });
    throw new Error(`Could not invalidate prebuilt install for '${plan.key}': ${statusError instanceof Error ? statusError.message : String(statusError)}`, { cause: error });
  }
}

async function fetchRelease(manifestUrl, key) {
  const url = new URL(manifestUrl);
  if (url.protocol !== 'https:' && process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT !== '1') {
    throw new Error(`Prebuilt release manifest for '${key}' must use HTTPS.`);
  }
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `Prebuilt release manifest fetch failed for '${key}' at ${url.href}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const error = new Error(
      `Prebuilt release manifest fetch failed for '${key}' at ${url.href}: HTTP ${response.status}.`,
    );
    if (response.status === 404) error.code = key.endsWith('-engine-player') ? 'PREBUILT_RELEASE_UNPUBLISHED' : 'PREBUILT_RELEASE_MISSING';
    throw error;
  }
  return releaseFromManifest(validateReleaseManifest(await response.json()), key);
}

/**
 * Above this size a release asset is fetched as parallel byte ranges (PRD-902).
 *
 * GitHub throttles one connection, not the host: a single 118 MiB engine player took about nine
 * minutes on the day a downstream loop gave up. Small assets stay on one request because the
 * per-request cost is the whole cost.
 */
export const PARALLEL_RANGE_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** How many byte ranges one large asset splits into. Measured against the real release in PRD-902. */
export const PARALLEL_RANGE_COUNT = 16;

async function fetchArtifact(url, key, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new Error(
      `Prebuilt release fetch failed for '${key}' at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * One asset over parallel `Range` requests, assembled at each part's offset in one buffer.
 *
 * A `200` answer means the server ignored `Range`: that body is the whole file, so it is returned
 * as-is and the remaining requests are cancelled. Any other status fails closed naming the key,
 * the URL and the byte range — the sha256 in the lock is still the only trust decision.
 */
async function downloadRanges(key, url, size) {
  const chunk = Math.ceil(size / PARALLEL_RANGE_COUNT);
  const parts = Array.from({ length: PARALLEL_RANGE_COUNT }, (_, index) => {
    const start = index * chunk;
    return { end: Math.min(size, start + chunk) - 1, index, start };
  }).filter(({ start }) => start < size);
  const contents = Buffer.allocUnsafe(size);
  const controllers = parts.map(() => new AbortController());
  // Set by the first part that sees a `200`: the server ignored `Range`, so its body is the file.
  let whole;
  try {
    const answers = await Promise.allSettled(parts.map(async ({ start, end, index }) => {
      const response = await fetchArtifact(url, key, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: controllers[index].signal,
      });
      if (response.status === 200) {
        // Cancel the siblings before reading the body: they are downloading the same bytes, and a
        // whole asset each in memory is what this path must not cost.
        controllers.forEach((controller, other) => {
          if (other !== index) controller.abort();
        });
        whole = Buffer.from(await response.arrayBuffer());
        return;
      }
      if (response.status !== 206) {
        throw new Error(
          `Prebuilt release fetch failed for '${key}' at ${url}: HTTP ${response.status} for byte range ${start}-${end}.`,
        );
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length !== end - start + 1) {
        throw new Error(
          `Prebuilt release fetch failed for '${key}' at ${url}: byte range ${start}-${end} answered ${body.length} bytes.`,
        );
      }
      body.copy(contents, start);
    }));
    // A whole body wins: the checksum still decides, and the aborted siblings explain themselves.
    const failure = answers.find((answer) => answer.status === 'rejected');
    if (whole === undefined && failure?.status === 'rejected') throw failure.reason;
  } finally {
    for (const controller of controllers) controller.abort();
  }
  return whole ?? contents;
}

export async function downloadReleaseArtifact(key, options = {}) {
  const manifestPath = options.manifestPath ?? process.env.THREENATIVE_PREBUILT_MANIFEST;
  const release = manifestPath
    ? readRelease(resolve(manifestPath), key)
    : await fetchRelease(options.manifestUrl ?? releaseManifestUrl(), key);
  if (release.size > PARALLEL_RANGE_THRESHOLD_BYTES) {
    const contents = await downloadRanges(key, release.url, release.size);
    verifyChecksum(contents, release.sha256, key);
    if (contents.length === 0 || contents.length !== release.size) {
      throw new Error(`Prebuilt release size verification failed for '${key}': received ${contents.length} bytes.`);
    }
    return contents;
  }
  const response = await fetchArtifact(release.url, key);
  if (!response.ok) {
    throw new Error(`Prebuilt release fetch failed for '${key}' at ${release.url}: HTTP ${response.status}.`);
  }
  let contents;
  try {
    contents = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`Prebuilt release body failed for '${key}' at ${release.url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  verifyChecksum(contents, release.sha256, key);
  if (contents.length === 0 || (release.size !== undefined && contents.length !== release.size)) {
    throw new Error(`Prebuilt release size verification failed for '${key}': received ${contents.length} bytes.`);
  }
  return contents;
}

/** Reuse only a complete install for this exact package, platform and manifest selection. */
function isVerifiedInstall(plan, options) {
  try {
    const status = JSON.parse(readFileSync(plan.statusPath, 'utf8'));
    if (status.ok !== true || status.key !== plan.key ||
        status.version !== plan.status.version || status.url !== plan.status.url) return false;
    // A caller can replace a local lock without changing its path. That explicit pin must
    // still authorize these bytes, and a missing/invalid pin must never be bypassed by cache.
    const manifestPath = options.manifestPath ?? process.env.THREENATIVE_PREBUILT_MANIFEST;
    const pinned = manifestPath ? readRelease(resolve(manifestPath), plan.key) : undefined;
    if (pinned && pinned.sha256 !== status.sha256) return false;
    const contents = readFileSync(plan.output);
    if (contents.length === 0 || (pinned?.size !== undefined && contents.length !== pinned.size)) return false;
    verifyChecksum(contents, status.sha256, plan.key);
    if (!plan.toolsKey) return true;
    // A cached runtime without its verified helper is not a reusable desktop install.
    if (typeof status.toolsSha256 !== 'string') return false;
    const pinnedTools = manifestPath ? readRelease(resolve(manifestPath), plan.toolsKey) : undefined;
    if (pinnedTools && pinnedTools.sha256 !== status.toolsSha256) return false;
    const tools = readFileSync(plan.toolsOutput);
    if (tools.length === 0 || (pinnedTools?.size !== undefined && tools.length !== pinnedTools.size)) return false;
    verifyChecksum(tools, status.toolsSha256, plan.toolsKey);
    return true;
  } catch {
    return false;
  }
}

export async function installPrebuilt(options = {}) {
  const plan = createInstallPlan(options);
  try {
    // Packaging may reuse verified bytes offline. Explicit install/retry keeps its original
    // invalidation semantics, including removing an earlier binary on a failed retry.
    if (options.reuse === true) {
      platformKey(plan.platform, options.arch);
      if (isVerifiedInstall(plan, options)) return plan.output;
    }
    // A failed retry must not leave an earlier binary usable or its old success marker intact.
    beginInstall(plan, options.arch);
    const contents = await downloadReleaseArtifact(plan.key, options);
    const toolsContents = plan.toolsKey ? await downloadReleaseArtifact(plan.toolsKey, options) : undefined;
    publishInstall(plan, contents, toolsContents);
    console.log(`Installed verified ThreeNative ${plan.toolsKey ? 'runtime and build tool helper' : 'engine player'} for '${plan.key}'.`);
    return plan.output;
  } catch (error) {
    recordInstallFailure(plan, error);
    throw error;
  }
}

/** How long a lock may outlive the process that made it. A killed install leaves one behind. */
const LOCK_STALE_MS = 15 * 60 * 1000;

/** How often a waiter re-checks the winner, and the lock. */
const LOCK_POLL_MS = 250;

/** How often a waiting caller says so, so a slow install is never a silent hang. */
const LOCK_NOTICE_MS = 30 * 1000;

/**
 * Hold the install lock for one plan.
 *
 * `mkdirSync` is the atomic primitive: exactly one caller creates the directory, every other
 * caller sees `EEXIST` and waits. Two parallel commands used to race here, and the loser's
 * `beginInstall` deleted the winner's output mid-download.
 *
 * Waiting ends three ways, and none of them spins: the winner publishes a verified binary (the
 * waiter reuses it immediately), the lock's owner is gone (a killed build — its pid no longer
 * exists — is stolen at once), or the lock is 15 minutes old and therefore stale. A steal is one
 * `rename`, so two waiters cannot both take the same stale lock and resurrect the race.
 */
async function withInstallLock(plan, options, callback) {
  const lock = `${plan.statusPath}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS;
  let announcedAt = 0;
  const notice = (suffix) => {
    process.stderr.write(`Waiting for another install of '${plan.key}' to finish (${lock}${suffix}).\n`);
  };
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // The winner may have published a verified binary while this caller waited: reuse it.
      if (isVerifiedInstall(plan, options)) return plan.output;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        // Released between the `mkdir` and the `stat`: try again without sleeping.
        continue;
      }
      const abandoned = lockOwnerIsGone(lock);
      if (abandoned || age > LOCK_STALE_MS) {
        const stale = `${lock}.${randomUUID()}.stale`;
        try {
          renameSync(lock, stale);
          rmSync(stale, { recursive: true, force: true });
        } catch {
          // Another waiter stole it first, which is the outcome this branch wants anyway.
        }
        continue;
      }
      const now = Date.now();
      if (now > deadline) {
        throw new Error(
          `Gave up waiting for another install of '${plan.key}' (${lock} is ${Math.round(age / 1000)}s old). Delete that lock if the process that made it is gone, then rerun.`,
        );
      }
      if (announcedAt === 0 || now - announcedAt >= LOCK_NOTICE_MS) {
        announcedAt = now;
        notice(` is ${Math.round(age / 1000)}s old`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
    }
  }
  try {
    return await callback();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Whether the pid recorded in a lock no longer runs, which is how a killed install is detected. */
function lockOwnerIsGone(lock) {
  let pid;
  try {
    pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim());
  } catch {
    // No pid yet: the owner may be between `mkdir` and the write, so treat it as alive.
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means it exists under another user; anything else means the process is gone.
    return error?.code === 'ESRCH';
  }
}

/**
 * Name a failed ensure, because the bare download error reads like an engine bug.
 *
 * Each message names the asset, the version, the URL, the underlying reason, and the only three
 * fixes that work. `TN_NATIVE_BINARY_UNPUBLISHED` is a packaging fact and the release census
 * already fails on it; `TN_NATIVE_BINARY_UNAVAILABLE` is a network, HTTP or checksum failure.
 */
function unavailableNativeBinary(error, plan) {
  const reason = error instanceof Error ? error.message : String(error);
  const unpublished = error instanceof Error &&
    ['PREBUILT_RELEASE_MISSING', 'PREBUILT_RELEASE_UNPUBLISHED'].includes(error.code);
  const code = unpublished ? 'TN_NATIVE_BINARY_UNPUBLISHED' : 'TN_NATIVE_BINARY_UNAVAILABLE';
  const asset = PREBUILT_ASSET_NAMES[plan.key] ?? plan.key;
  const env = plan.key.endsWith('-engine-player') ? 'THREENATIVE_ENGINE_PLAYER' : 'THREENATIVE_RUNTIME_BINARY';
  const message = unpublished
    ? `${code}: no ${asset} is published for @threenative/runtime-native ${packageVersion} at ${plan.status.url} (${reason}).`
    : `${code}: ${asset} for @threenative/runtime-native ${packageVersion} could not be downloaded from ${plan.status.url} (${reason}).`;
  const wrapped = new Error(
    `${message} Fix it one of three ways: connect (or reconnect) and rerun the same command; set ${env} to a local binary; or build one from an engine checkout (pnpm --filter @threenative/runtime-native native:build).`,
  );
  wrapped.code = code;
  return wrapped;
}

/**
 * Download what a native build needs, once, at the moment it needs it (PRD-783).
 *
 * Nothing downloads during `pnpm install` any more, so a web game fetches no binary at all. The
 * first `threenative build --target desktop` calls this: a verified cache returns with no network,
 * one lock makes parallel callers download once, and a failure carries a name and three fixes.
 */
export async function ensureNativeBinary(options = {}) {
  const plan = createInstallPlan(options);
  platformKey(plan.platform, options.arch);
  if (isVerifiedInstall(plan, options)) return plan.output;
  try {
    return await withInstallLock(plan, options, () => installPrebuilt({ ...options, reuse: true }));
  } catch (error) {
    throw unavailableNativeBinary(error, plan);
  }
}

// Real paths on both sides: pnpm runs this hook through a symlinked `node_modules` path, and a
// plain comparison with the module's real URL silently skipped the install.
if (process.argv[1] && existsSync(process.argv[1]) &&
    realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const sourceCheckout = existsSync(join(packageRoot, 'src')) && existsSync(join(packageRoot, 'CMakeLists.txt'));
  if (sourceCheckout) {
    console.log('ThreeNative runtime source checkout detected; prebuilt install is deferred to package testing.');
  } else {
    installPrebuilt().then(() => installPrebuilt({ enginePlayer: true }))
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        // An unpublished release is a packaging-state fact, not a broken download. The web game
        // this install carries must not lose node_modules/.bin over an optional native binary;
        // the native lanes fail closed later, on the missing binary itself.
        if (error instanceof Error &&
            ['PREBUILT_RELEASE_MISSING', 'PREBUILT_RELEASE_UNPUBLISHED'].includes(error.code)) {
          console.warn(
            `No prebuilt release is published for v${packageVersion} (${reason}). Continuing without the native runtime; desktop and device lanes fail closed on the missing binary.`,
          );
          return;
        }
        console.error(reason);
        process.exitCode = 1;
      });
  }
}
