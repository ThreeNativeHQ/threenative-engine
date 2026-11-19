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
  if (!supported.has(key)) {
    const error = new Error(`No prebuilt release is published for '${key}': this platform has no native runtime row.`);
    error.code = 'PREBUILT_RELEASE_UNPUBLISHED';
    throw error;
  }
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

function releaseFromManifest(manifest, key, options = {}) {
  if (UNPUBLISHED_PREBUILT_KEYS.includes(key)) {
    const error = new Error(
      `No prebuilt release is published for '${key}'. This platform builds from an engine checkout until its release credentials exist; see PRD-262.`,
    );
    error.code = 'PREBUILT_RELEASE_UNPUBLISHED';
    throw error;
  }
  const release = manifest?.artifacts?.[key];
  // A key the manifest itself promises and does not carry is a broken release, not a platform that
  // ships nothing: warn-and-continue here leaves an offline image that cannot build. Only an
  // explicit `requiredKeys` is a promise; without one, a partial manifest is a fixture (or a local
  // lock), and an absent key stays the pre-existing by-design absence.
  // An official release lock omits `requiredKeys` and promises the whole published cohort; a
  // caller that is preparing an offline image says so with `requireComplete`. A test or local
  // fixture stays permissive, which is how a partial manifest has always behaved.
  const required = declaredRequiredKeys(manifest) ??
    (options.requireComplete === true ? PUBLISHED_PREBUILT_KEYS : []);
  if (release === undefined && required.includes(key)) {
    const error = new Error(
      `The prebuilt release manifest requires '${key}' and records no artifact for it.`,
    );
    error.code = 'PREBUILT_RELEASE_MISSING';
    throw error;
  }
  if (release !== undefined && (!release.url || !release.sha256)) {
    // The lock advertises this asset and does not describe it: a broken release, not a platform
    // that ships nothing, so the prefetch must fail rather than warn and leave the image short.
    const error = new Error(
      `The prebuilt release manifest records an incomplete entry for '${key}' (url and sha256 are required).`,
    );
    error.code = 'PREBUILT_RELEASE_INCOMPLETE';
    throw error;
  }
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
  for (const key of requiredKeys) releaseFromManifest(manifest, key, options);
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

export function readRelease(manifestPath, key, options = {}) {
  if (!existsSync(manifestPath)) {
    const error = new Error(`No prebuilt release manifest exists for '${key}'; this target remains OPEN.`);
    error.code = 'PREBUILT_RELEASE_UNPUBLISHED';
    throw error;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Explicit artifact-only local pins predate the envelope. Never downgrade a partially
  // specified candidate, and never allow this compatibility path for a remote default lock.
  if (manifest && ['schemaVersion', 'version', 'sourceSha'].some((field) => Object.hasOwn(manifest, field))) {
    // The caller's options carry the completeness requirement: an official lock a prefetch was
    // asked to fill must fail when it omits a published asset, exactly as the remote path does.
    validateReleaseManifest(manifest, options);
  }
  return releaseFromManifest(manifest, key, options);
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

async function fetchRelease(manifestUrl, key, options = {}) {
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
    // No manifest at this tag is an expected absence for both binaries — the release that carries
    // them may not exist yet — so it is the same warning a missing local manifest earns. One
    // artifact 404 inside a manifest that promises it stays fatal, and `downloadReleaseArtifact`
    // tags that separately as PREBUILT_RELEASE_MISSING.
    if (response.status === 404) error.code = 'PREBUILT_RELEASE_UNPUBLISHED';
    throw error;
  }
  return releaseFromManifest(validateReleaseManifest(await response.json(), options), key, options);
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
 * Read one part's body, naming the asset, URL and interval when the connection dies mid-read.
 *
 * `response.arrayBuffer()` rejects with a bare `TypeError: terminated` on a dropped connection, and
 * the caller cannot see which part failed: the requested-range and the server-ignored-Range paths
 * both go through here so the failure reads the same either way.
 */
async function readRangeBody(response, { end, key, start, url }) {
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(
      `Prebuilt release fetch failed for '${key}' at ${url}: byte range ${start}-${end} was interrupted (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }
}

/**
 * One asset over parallel `Range` requests, assembled at each part's offset in one buffer.
 *
 * A `200` answer means the server ignored `Range`: the first part to see one claims the whole body
 * and cancels the siblings *before* reading it, so a range-ignoring server costs one asset in
 * memory rather than one per request. Any other status, or a short body, fails closed naming the
 * key, the URL and the byte range, and cancels the siblings so a stalled one cannot hold the
 * install lock. The sha256 in the lock is still the only trust decision.
 */
async function downloadRanges(key, url, size) {
  const chunk = Math.ceil(size / PARALLEL_RANGE_COUNT);
  const parts = Array.from({ length: PARALLEL_RANGE_COUNT }, (_, index) => {
    const start = index * chunk;
    return { end: Math.min(size, start + chunk) - 1, index, start };
  }).filter(({ start }) => start < size);
  const contents = Buffer.allocUnsafe(size);
  const controllers = parts.map(() => new AbortController());
  // The first part to see a `200` claims the whole body synchronously, before any other handler
  // can claim it too (two claims would cancel both readers). The claimed reader is never aborted
  // by a sibling: its body is the download.
  let claimed;
  let whole;
  let failure;
  const abortOthers = (keep) => {
    controllers.forEach((controller, other) => {
      if (other !== keep && other !== claimed) controller.abort();
    });
  };
  try {
    await Promise.allSettled(parts.map(async ({ start, end, index }) => {
      try {
        const response = await fetchArtifact(url, key, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: controllers[index].signal,
        });
        if (response.status === 200) {
          if (claimed !== undefined) {
            // A sibling already has the whole file: drop this body instead of reading a second one.
            await response.body?.cancel().catch(() => undefined);
            return;
          }
          claimed = index;
          // The siblings are not aborted until this body is in memory: they may share its socket,
          // and aborting them mid-read truncated it (a checksum failure, observed).
          whole = await readRangeBody(response, { end, key, start, url });
          abortOthers(index);
          return;
        }
        if (response.status !== 206) {
          const error = new Error(
            `Prebuilt release fetch failed for '${key}' at ${url}: HTTP ${response.status} for byte range ${start}-${end}.`,
          );
          if (response.status === 404) error.code = 'PREBUILT_RELEASE_MISSING';
          throw error;
        }
        const body = await readRangeBody(response, { end, key, start, url });
        if (body.length !== end - start + 1) {
          throw new Error(
            `Prebuilt release fetch failed for '${key}' at ${url}: byte range ${start}-${end} answered ${body.length} bytes.`,
          );
        }
        body.copy(contents, start);
      } catch (error) {
        // The claimed reader decides the result even when it fails: its error is the download's.
        // Any other failure is remembered only until a whole body wins, and cancels the siblings
        // so a stalled body cannot hold the install lock.
        if (index === claimed || (claimed === undefined && failure === undefined && !isAbortError(error)))
          failure = error;
        abortOthers(index);
        throw error;
      }
    }));
  } finally {
    for (const controller of controllers) controller.abort();
  }
  // A whole body wins over a sibling's failure: the sha256 still decides, and its bytes are the
  // file. Only when no complete body arrived does the recorded failure become the answer.
  if (whole !== undefined) return whole;
  if (failure !== undefined) throw failure;
  return contents;
}

function isAbortError(error) {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/u.test(error.message));
}

export async function downloadReleaseArtifact(key, options = {}) {
  // A platform this repository deliberately does not publish is a fact, not a download: answering
  // it before the manifest fetch keeps the diagnosis identical online and offline.
  if (UNPUBLISHED_PREBUILT_KEYS.includes(key)) {
    const error = new Error(
      `No prebuilt release is published for '${key}'. This platform builds from an engine checkout until its release credentials exist; see PRD-262.`,
    );
    error.code = 'PREBUILT_RELEASE_UNPUBLISHED';
    throw error;
  }
  const manifestPath = options.manifestPath ?? process.env.THREENATIVE_PREBUILT_MANIFEST;
  const release = manifestPath
    ? readRelease(resolve(manifestPath), key, options)
    : await fetchRelease(options.manifestUrl ?? releaseManifestUrl(), key, options);
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
    const error = new Error(`Prebuilt release fetch failed for '${key}' at ${release.url}: HTTP ${response.status}.`);
    // A published release that does not carry this asset is a packaging fact, not a bad network.
    if (response.status === 404) error.code = 'PREBUILT_RELEASE_MISSING';
    throw error;
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
    const pinned = manifestPath ? readRelease(resolve(manifestPath), plan.key, options) : undefined;
    if (pinned && pinned.sha256 !== status.sha256) return false;
    const contents = readFileSync(plan.output);
    if (contents.length === 0 || (pinned?.size !== undefined && contents.length !== pinned.size)) return false;
    verifyChecksum(contents, status.sha256, plan.key);
    if (!plan.toolsKey) return true;
    // A cached runtime without its verified helper is not a reusable desktop install.
    if (typeof status.toolsSha256 !== 'string') return false;
    const pinnedTools = manifestPath ? readRelease(resolve(manifestPath), plan.toolsKey, options) : undefined;
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

/** A lock older than this cannot belong to a running install, even one with no recorded pid. */
const LOCK_STALE_MS = 15 * 60 * 1000;

/** How often a waiter re-checks the winner, and the lock. */
const LOCK_POLL_MS = 250;

/** How often a waiting caller says so, so a slow install is never a silent hang. */
const LOCK_NOTICE_MS = 30 * 1000;

/**
 * Hold the install lock for one plan, and own it while doing so.
 *
 * `mkdirSync` is the atomic primitive: exactly one caller creates the directory, every other
 * caller sees `EEXIST` and waits. Two parallel commands used to race here, and the loser's
 * `beginInstall` deleted the winner's output mid-download.
 *
 * Ownership is a token written inside the lock, so releasing deletes only a lock this caller
 * still owns: a waiter that reclaimed a dead owner's lock cannot have it deleted underneath it by
 * the process that died. Waiting ends three ways, none of them spinning: the winner publishes a
 * verified binary (the waiter reuses it at once), the lock's recorded pid is gone (a killed
 * build — reclaimed immediately), or a lock with no pid at all is 15 minutes old. A reclaim
 * re-reads the dead pid before its single `rename`, so two waiters cannot both move it and one
 * cannot move the other's fresh lock.
 */
async function withInstallLock(plan, options, callback) {
  const lock = `${plan.statusPath}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const owner = randomUUID();
  const deadline = Date.now() + LOCK_STALE_MS;
  let announcedAt = 0;
  for (;;) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // The winner may have published a verified binary while this caller waited: reuse it.
      if (isVerifiedInstall(plan, options)) return plan.output;
      let age;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch (error) {
        // Released between the `mkdir` and the `stat`: retry at once. Any other filesystem error
        // is real and must not be turned into a busy loop.
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const abandoned = abandonedLockOwner(lock, age);
      if (abandoned !== undefined) {
        // A declined reclaim (another waiter is reaping) still polls, so this cannot spin.
        if (reclaimAbandonedLock(lock, abandoned)) continue;
        await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
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
        process.stderr.write(
          `Waiting for another install of '${plan.key}' to finish (${lock} is ${Math.round(age / 1000)}s old).\n`,
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
      continue;
    }
    // The lock is ours. The token ties cleanup to this caller; the pid lets a later build reclaim
    // it the moment this process is gone, so a killed build never becomes a 15-minute wait.
    try {
      writeFileSync(join(lock, 'owner'), `${owner}\n`, { flag: 'wx' });
    } catch (error) {
      // Without a token this caller cannot prove ownership on release, so it gives the lock back
      // rather than installing unprotected.
      rmSync(lock, { recursive: true, force: true });
      throw error;
    }
    try {
      writeFileSync(join(lock, 'pid'), `${process.pid}\n`, { flag: 'wx' });
    } catch {
      // The pid is an optimisation for a killed build, never a precondition.
    }
    break;
  }
  try {
    return await callback();
  } finally {
    releaseInstallLock(lock, owner);
  }
}

/** Delete the lock only while this caller still owns it. */
function releaseInstallLock(lock, owner) {
  let recorded;
  try {
    recorded = readFileSync(join(lock, 'owner'), 'utf8').trim();
  } catch {
    // A lock whose token is unreadable is not provably this caller's: leave it to go stale.
    return;
  }
  if (recorded === owner) rmSync(lock, { recursive: true, force: true });
}

/**
 * The identity of a lock nobody owns any more, or `undefined` while it must be respected.
 *
 * A recorded pid that no longer runs is reclaimed at once. A lock with no pid is reclaimed only
 * once it is 15 minutes old — that is a build killed between `mkdir` and the pid write, or a lock
 * from a release that predates the pid. A live pid, an `EPERM` (another user's process) or a
 * malformed pid is respected.
 */
function abandonedLockOwner(lock, age) {
  let pidText;
  try {
    pidText = readFileSync(join(lock, 'pid'), 'utf8').trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return age > LOCK_STALE_MS ? '' : undefined;
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return age > LOCK_STALE_MS ? pidText : undefined;
  if (pid === process.pid) return undefined;
  try {
    process.kill(pid, 0);
    return undefined;
  } catch (error) {
    return error?.code === 'ESRCH' ? pidText : undefined;
  }
}

/**
 * Move one dead lock aside, with exactly one reaper at a time.
 *
 * The reaper lock is what makes the claim atomic against a *second waiter*: without it, a waiter
 * paused between its pid check and its `rename` could come back and move a lock a faster waiter
 * had already created, leaving two installers in the same directory. A reaper that dies only
 * blocks reclaiming for its own stale window, and never installs anything.
 */
function reclaimAbandonedLock(lock, identity) {
  const reaper = `${lock}.reap`;
  const token = `${randomUUID()}`;
  try {
    mkdirSync(reaper);
    writeFileSync(join(reaper, 'owner'), token);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    // Somebody else reaps. A guard left by a dead reaper is *renamed*, not deleted: the rename is
    // atomic, so exactly one waiter can claim the stale guard and the rest see ENOENT. Deleting by
    // path would let a waiter remove a guard another waiter had just created.
    let age = 0;
    try {
      age = Date.now() - statSync(reaper).mtimeMs;
    } catch {
      return false;
    }
    if (age <= LOCK_STALE_MS) return false;
    const deadGuard = `${reaper}.${randomUUID()}.stale`;
    try {
      renameSync(reaper, deadGuard);
    } catch {
      return false;
    }
    rmSync(deadGuard, { recursive: true, force: true });
    return false;
  }
  const ownsReaper = () => {
    try {
      return readFileSync(join(reaper, 'owner'), 'utf8') === token;
    } catch {
      return false;
    }
  };
  try {
    let current;
    try {
      current = readFileSync(join(lock, 'pid'), 'utf8').trim();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      current = '';
    }
    // Re-informed, not trusted: the lock a paused waiter saw may have been replaced by a live one
    // since, so ownership and staleness are judged again while `.reap` keeps this the only reaper.
    // A fresh lock is younger than `LOCK_STALE_MS` and survives even before its owner writes a pid.
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      return false;
    }
    // The guard can be taken from a paused reaper, and the token is how it knows: if another
    // waiter renamed this guard away, the destructive step below is not ours to take.
    if (!ownsReaper()) return false;
    if (current !== identity || abandonedLockOwner(lock, age) !== identity) return false;
    const graveyard = `${lock}.${randomUUID()}.stale`;
    try {
      renameSync(lock, graveyard);
    } catch (error) {
      // The lock is already gone: the next `mkdir` decides who owns it.
      if (error?.code === 'ENOENT' || error?.code === 'ENOTEMPTY') return false;
      throw error;
    }
    rmSync(graveyard, { recursive: true, force: true });
    return true;
  } finally {
    if (ownsReaper()) rmSync(reaper, { recursive: true, force: true });
  }
}

/**
 * Name a failed ensure, because the bare download error reads like an engine bug.
 *
 * Each message names the asset, the version, the URL, the underlying reason, and the only three
 * fixes that work. `TN_NATIVE_BINARY_UNPUBLISHED` covers every packaging fact — a release with no
 * such asset, a manifest without the key, a platform whose asset is deliberately unpublished — so
 * the same absent asset is diagnosed the same way whether or not the host was online.
 * `TN_NATIVE_BINARY_UNAVAILABLE` is a network, HTTP or checksum failure.
 */
function unavailableNativeBinary(error, plan) {
  const reason = error instanceof Error ? error.message : String(error);
  // Two different facts share the UNPUBLISHED name: this platform publishes nothing (warn and move
  // on) and a release that is missing an asset it promised (a real failure). `unpublished` keeps
  // them apart for the prefetch command, which cannot see the plan.
  const byDesign =
    (error instanceof Error && error.code === 'PREBUILT_RELEASE_UNPUBLISHED') ||
    /is not published for|No prebuilt release manifest exists|No prebuilt release asset is recorded/u.test(reason);
  const code =
    error instanceof Error &&
    (['PREBUILT_RELEASE_MISSING', 'PREBUILT_RELEASE_UNPUBLISHED'].includes(error.code) ||
      /No prebuilt release (?:asset|manifest)|is not published for/u.test(reason))
      ? 'TN_NATIVE_BINARY_UNPUBLISHED'
      : 'TN_NATIVE_BINARY_UNAVAILABLE';
  const asset = PREBUILT_ASSET_NAMES[plan.key] ?? plan.key;
  const env = plan.key.endsWith('-engine-player') ? 'THREENATIVE_ENGINE_PLAYER' : 'THREENATIVE_RUNTIME_BINARY';
  const message = code === 'TN_NATIVE_BINARY_UNPUBLISHED'
    ? `${code}: no ${asset} is published for @threenative/runtime-native ${packageVersion} at ${plan.status.url} (${reason}).`
    : `${code}: ${asset} for @threenative/runtime-native ${packageVersion} could not be downloaded from ${plan.status.url} (${reason}).`;
  const wrapped = new Error(
    `${message} Fix it one of three ways: connect (or reconnect) and rerun the same command; set ${env} to a local binary; or build one from an engine checkout (${
      plan.key.endsWith('-engine-player')
        ? 'cmake --preset <platform> -B build/tn-engine-ui -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON, then cmake --build build/tn-engine-ui --target tn-native-engine-player-v8; add -DTN_ENGINE_PLAYER_UI_OVERLAY=ON on Linux when the game has a web UI (it is a Linux-only option, and elsewhere a web HUD needs engine: \"threejs\")'
        : 'pnpm --filter @threenative/runtime-native native:build'
    }).`,
  );
  wrapped.code = code;
  if (byDesign) wrapped.unpublished = true;
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
  try {
    // Inside the wrapper: an unsupported platform must read like every other absent binary, with
    // its name and the local-binary recipes, not as a bare platform error.
    platformKey(plan.platform, options.arch);
    if (isVerifiedInstall(plan, options)) return plan.output;
    return await withInstallLock(plan, options, () => installPrebuilt({ ...options, reuse: true }));
  } catch (error) {
    throw unavailableNativeBinary(error, plan);
  }
}

// The explicit "fetch now" command, for an offline image or a link known to be slow. It goes
// through the same locked, reuse-aware entry point a build uses: run beside a desktop build it
// waits instead of racing, and a failed refresh never deletes a verified cache.
//
// Real paths on both sides: this is invoked through a symlinked `node_modules` path, and a plain
// comparison with the module's real URL silently skipped the install.
if (process.argv[1] && existsSync(process.argv[1]) &&
    realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const sourceCheckout = existsSync(join(packageRoot, 'src')) && existsSync(join(packageRoot, 'CMakeLists.txt'));
  if (sourceCheckout) {
    console.log('ThreeNative runtime source checkout detected; prebuilt install is deferred to package testing.');
  } else {
    // Both targets are attempted independently: a manifest that carries the engine player but no
    // legacy runtime must still fill the cache, and one that omits either must not hide the other.
    Promise.allSettled([
      ensureNativeBinary({ requireComplete: true }),
      ensureNativeBinary({ enginePlayer: true, requireComplete: true }),
    ]).then((results) => {
      let failures = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') continue;
        const error = result.reason;
        const reason = error instanceof Error ? error.message : String(error);
        // A release that carries no asset for this platform is a packaging-state fact, not a
        // broken download: report it, and count it only as something this platform cannot fetch.
        // Only an absence this platform publishes nothing for is a warning. A published asset the
        // release is missing (404, no manifest entry) must fail the prefetch: an offline image
        // built on exit 0 would break at the game's first desktop build.
        if (error instanceof Error && (error.unpublished === true || error.code === 'PREBUILT_RELEASE_UNPUBLISHED')) {
          console.warn(reason);
          continue;
        }
        failures += 1;
        console.error(reason);
      }
      // Any target this platform publishes that was not cached is a prefetch that did not happen:
      // an offline image built on exit 0 would fail at the game's first desktop build instead.
      if (failures > 0) process.exitCode = 1;
    });
  }
}
