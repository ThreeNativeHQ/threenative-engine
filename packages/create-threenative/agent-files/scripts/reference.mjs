#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MODEL = "meta/muse-image";
const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const SCHEMA_VERSION = 1;
let activeController;

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

class ProviderError extends Error {
  constructor(message, metadata = {}) {
    super(message);
    this.name = "ProviderError";
    Object.assign(this, metadata);
  }
}

function fail(message) {
  throw new InputError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(root, candidate, label) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${label} escapes the declared artifact root`);
  }
  return resolved;
}

async function assertExistingPathInside(root, candidate, label) {
  const resolved = safeRelative(root, candidate, label);
  const existing = await realpath(resolved).catch(() => undefined);
  if (existing !== undefined) safeRelative(root, existing, label);
  else {
    const parent = await realpath(path.dirname(resolved)).catch(() => undefined);
    if (parent !== undefined && parent !== root) safeRelative(root, parent, label);
  }
  return resolved;
}

function projectRelative(projectRoot, file) {
  const relative = path.relative(projectRoot, file);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail("artifact path is outside projectRoot");
  }
  return relative.split(path.sep).join("/");
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set([
    "record",
    "request-id",
    "prompt-file",
    "out",
    "model",
    "reference",
    "timeout-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument?.startsWith("--")) fail(`unexpected argument '${argument ?? ""}'`);
    const name = argument.slice(2);
    if (!flags.has(name)) fail(`unknown option '--${name}'`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`option '--${name}' needs a value`);
    values[name] = value;
    index += 1;
  }
  for (const name of ["record", "request-id", "prompt-file", "out"]) {
    if (values[name] === undefined || values[name] === "")
      fail(`missing required option '--${name}'`);
  }
  const timeout =
    values["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(values["timeout-ms"]);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > DEFAULT_TIMEOUT_MS)
    fail("timeout-ms must be an integer from 1 to 120000");
  return { ...values, timeoutMs: timeout, model: values.model ?? DEFAULT_MODEL };
}

function printHelp() {
  console.log(
    "Usage: node scripts/reference.mjs --record RUN.json --request-id ID --prompt-file PROMPT.txt --out IMAGE [--model MODEL] [--reference IMAGE]",
  );
}

function imageInfo(bytes) {
  if (bytes.length < 12) return undefined;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (png) {
    if (
      bytes.length < 33 ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND"
    )
      return undefined;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0
      ? { mime: "image/png", width, height, extension: ".png" }
      : undefined;
  }
  if (
    bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
    bytes.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    const width = bytes.readUInt16LE(6);
    const height = bytes.readUInt16LE(8);
    return width > 0 && height > 0
      ? { mime: "image/gif", width, height, extension: ".gif" }
      : undefined;
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", width: undefined, height: undefined, extension: ".webp" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > bytes.length) return undefined;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return undefined;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = bytes.readUInt16BE(offset + 3);
        const width = bytes.readUInt16BE(offset + 5);
        return width > 0 && height > 0
          ? { mime: "image/jpeg", width, height, extension: ".jpg" }
          : undefined;
      }
      offset += length;
    }
  }
  return undefined;
}

function validateImage(bytes, expectedExtension) {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
    fail(`image payload must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`);
  const info = imageInfo(bytes);
  if (info === undefined) fail("provider response is not a supported raster image");
  if (
    expectedExtension !== undefined &&
    ![info.extension, info.extension === ".jpg" ? ".jpeg" : info.extension].includes(
      expectedExtension.toLowerCase(),
    )
  ) {
    fail(`image MIME '${info.mime}' does not match output extension '${expectedExtension}'`);
  }
  return info;
}

function outputExtension(file) {
  const extension = path.extname(file).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension))
    fail("output must use .png, .jpg, .jpeg, .webp or .gif");
  return extension;
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

async function atomicWriteBytes(file, bytes) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

async function acquireLock(recordFile) {
  const lockFile = `${recordFile}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.close();
      return async () => rm(lockFile, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = JSON.parse(await readFile(lockFile, "utf8").catch(() => "{}"));
      const pid = Number(owner.pid);
      let live = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          live = true;
        } catch {
          live = false;
        }
      }
      if (live)
        throw new ProviderError("run is locked by another writer", { category: "lock-busy" });
      await rm(lockFile, { force: true });
    }
  }
  throw new ProviderError("could not acquire run lock", { category: "lock-busy" });
}

function ensureRecord(record) {
  if (
    !record ||
    record.schemaVersion !== SCHEMA_VERSION ||
    typeof record.runId !== "string" ||
    typeof record.projectRoot !== "string"
  )
    fail("record schemaVersion, runId and projectRoot are required");
  if (!path.isAbsolute(record.projectRoot)) fail("record projectRoot must be absolute");
  if (
    !record.limits ||
    !Number.isInteger(record.limits.maxImageRequests) ||
    record.limits.maxImageRequests < 1
  )
    fail("record limits.maxImageRequests is required");
  if (!record.limits.deadlineAt || Number.isNaN(Date.parse(record.limits.deadlineAt)))
    fail("record limits.deadlineAt is required");
  record.requests ??= {};
  for (const key of ["pending", "completed", "unknown", "failed"]) record.requests[key] ??= [];
  if (!Array.isArray(record.rounds)) record.rounds = [];
  if (!Array.isArray(record.decisionHistory)) record.decisionHistory = [];
  const ids = new Set();
  for (const key of ["pending", "completed", "unknown", "failed"]) {
    for (const request of record.requests[key]) {
      if (typeof request?.requestId !== "string" || ids.has(request.requestId))
        fail("record request ledger contains a duplicate or malformed request ID");
      ids.add(request.requestId);
    }
  }
  return record;
}

async function readRecord(recordFile) {
  let value;
  try {
    value = JSON.parse(await readFile(recordFile, "utf8"));
  } catch (error) {
    fail(`cannot read record: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  return ensureRecord(value);
}

function recordRoot(record, recordFile) {
  const projectRoot = path.resolve(record.projectRoot);
  const artifactRoot = path.resolve(
    projectRoot,
    record.artifactRoot ?? path.relative(projectRoot, path.dirname(recordFile)),
  );
  if (artifactRoot !== projectRoot) safeRelative(projectRoot, artifactRoot, "artifactRoot");
  return { projectRoot, artifactRoot };
}

function requestCount(record) {
  return (
    record.requests.completed.length +
    record.requests.pending.length +
    record.requests.unknown.length
  );
}

function findRequest(record, requestId) {
  for (const key of ["completed", "pending", "unknown", "failed"]) {
    const found = record.requests[key].find((entry) => entry.requestId === requestId);
    if (found !== undefined) return { key, entry: found };
  }
  return undefined;
}

function removeRequest(record, requestId, key) {
  const index = record.requests[key].findIndex((entry) => entry.requestId === requestId);
  if (index >= 0) return record.requests[key].splice(index, 1)[0];
  return undefined;
}

function dataUri(value) {
  if (typeof value !== "string" || !value.startsWith("data:")) return undefined;
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/u.exec(value);
  if (match === null) return undefined;
  return {
    mime: match[1] === "image/jpg" ? "image/jpeg" : match[1],
    bytes: Buffer.from(match[2].replace(/\s+/gu, ""), "base64"),
  };
}

function findImagePayload(value, seen = new Set()) {
  if (value === null || value === undefined || seen.has(value)) return undefined;
  if (typeof value === "string") return dataUri(value);
  if (typeof value !== "object") return undefined;
  seen.add(value);
  if (typeof value.b64_json === "string") {
    const mime = typeof value.mime_type === "string" ? value.mime_type : "image/png";
    return { mime, bytes: Buffer.from(value.b64_json, "base64") };
  }
  if (typeof value.base64 === "string") {
    const mime = typeof value.mime === "string" ? value.mime : "image/png";
    return { mime, bytes: Buffer.from(value.base64, "base64") };
  }
  if (typeof value.url === "string") return dataUri(value.url);
  if (value.image_url !== undefined) return findImagePayload(value.image_url, seen);
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findImagePayload(child, seen);
      if (found !== undefined) return found;
    }
  } else {
    for (const child of Object.values(value)) {
      const found = findImagePayload(child, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function hasImageModality(architecture, key) {
  return Array.isArray(architecture?.[key])
    ? architecture[key].some((modality) => typeof modality === "string" && modality === "image")
    : false;
}

function capabilitySupportsImages(value, needsInput) {
  if (!Array.isArray(value?.data)) return false;
  return value.data.some((endpoint) => {
    const architecture = endpoint?.architecture;
    return (
      hasImageModality(architecture, "output_modalities") &&
      (!needsInput || hasImageModality(architecture, "input_modalities"))
    );
  });
}

function capabilityEndpoint(apiEndpoint, model) {
  if (process.env.NODE_ENV === "test" && process.env.TN_REFERENCE_CAPABILITIES_ENDPOINT)
    return process.env.TN_REFERENCE_CAPABILITIES_ENDPOINT;
  const endpoint = new URL(apiEndpoint);
  // OpenRouter routes `<author>/<slug>` as two path segments; an encoded slash is a 404.
  endpoint.pathname = `/api/v1/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`;
  endpoint.search = "";
  return endpoint.toString();
}

async function fetchJson(url, options, timeoutMs) {
  activeController = new AbortController();
  const timer = setTimeout(() => activeController.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: activeController.signal });
    const text = await response.text();
    let body;
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new ProviderError("provider returned non-JSON output", {
        category: "invalid-response",
        status: response.status,
      });
    }
    return { response, body };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error?.name === "AbortError")
      throw new ProviderError("provider request timed out or was cancelled", {
        category: "timeout",
      });
    throw new ProviderError("provider request failed", { category: "network" });
  } finally {
    clearTimeout(timer);
    activeController = undefined;
  }
}

async function discoverCapabilities(endpoint, model, needsInput, timeoutMs) {
  const { response, body } = await fetchJson(
    capabilityEndpoint(endpoint, model),
    {
      headers: {
        // biome-ignore lint/style/useNamingConvention: HTTP header uses the exact wire spelling.
        Accept: "application/json",
      },
    },
    timeoutMs,
  );
  if (!response.ok)
    throw new ProviderError("model capability discovery failed", {
      category: "capability",
      status: response.status,
      retryAfter: response.headers.get("retry-after") ?? undefined,
    });
  if (!capabilitySupportsImages(body, needsInput))
    throw new ProviderError(
      "selected model does not advertise the required image input/output support",
      { category: "capability" },
    );
  return body;
}

function requestBody(model, prompt, reference) {
  const content = [{ type: "text", text: prompt }];
  if (reference !== undefined)
    content.unshift({
      type: "image_url",
      // biome-ignore lint/style/useNamingConvention: provider payload uses the exact API field name.
      image_url: {
        url: `data:${reference.info.mime};base64,${reference.bytes.toString("base64")}`,
      },
    });
  return { model, messages: [{ role: "user", content }], modalities: ["image"] };
}

function providerMessage(status) {
  if (status === 400) return "provider rejected the request";
  if (status === 401 || status === 403) return "provider credentials were rejected";
  if (status === 402) return "provider reported insufficient credit";
  if (status === 404) return "provider route or model was not found";
  if (status === 429) return "provider rate-limited the request";
  if (status >= 500) return "provider returned a server error";
  return "provider returned an error";
}

async function generate(options, recordFile, record, roots) {
  const promptFile = await assertExistingPathInside(
    roots.artifactRoot,
    path.resolve(process.cwd(), options["prompt-file"]),
    "prompt file",
  );
  const outFile = await assertExistingPathInside(
    roots.artifactRoot,
    path.resolve(process.cwd(), options.out),
    "output file",
  );
  const referenceFile =
    options.reference === undefined
      ? undefined
      : await assertExistingPathInside(
          roots.artifactRoot,
          path.resolve(process.cwd(), options.reference),
          "reference image",
        );
  const prompt = await readFile(promptFile, "utf8");
  if (prompt.trim() === "") fail("prompt file is empty");
  const referenceBytes = referenceFile === undefined ? undefined : await readFile(referenceFile);
  const referenceInfo = referenceBytes === undefined ? undefined : validateImage(referenceBytes);
  const extension = outputExtension(outFile);
  if (!process.env.OPENROUTER_API_KEY) fail("OPENROUTER_API_KEY is required for generated targets");
  if (Date.now() >= Date.parse(record.limits.deadlineAt))
    throw new ProviderError("run deadline has expired", { category: "deadline" });
  if (requestCount(record) >= record.limits.maxImageRequests)
    throw new ProviderError("image request allowance is exhausted", { category: "budget" });

  const requestId = options["request-id"];
  const previous = findRequest(record, requestId);
  if (previous?.key === "completed") {
    const artifact = previous.entry.artifact;
    if (!artifact?.path || !artifact.sha256)
      throw new ProviderError("completed request receipt is malformed", { category: "receipt" });
    const artifactFile = path.resolve(roots.projectRoot, artifact.path);
    await assertExistingPathInside(roots.projectRoot, artifactFile, "completed artifact");
    const bytes = await readFile(artifactFile).catch(() => {
      throw new ProviderError("completed artifact is missing", { category: "receipt" });
    });
    if (sha256(bytes) !== artifact.sha256)
      throw new ProviderError("completed artifact hash does not match its receipt", {
        category: "receipt",
      });
    console.log(
      JSON.stringify({
        action: "reused",
        requestId,
        model: previous.entry.model,
        output: artifact.path,
        sha256: artifact.sha256,
      }),
    );
    return;
  }
  if (previous !== undefined)
    throw new ProviderError(
      "request ID has a pending, unknown or failed receipt and will not be sent again",
      { category: previous.key === "failed" ? "request-failed" : "request-not-replayable" },
    );
  if (
    await stat(outFile)
      .then(() => true)
      .catch(() => false)
  )
    fail("output path already exists; locked targets are never overwritten");

  const pending = {
    requestId,
    model: options.model,
    promptSha256: sha256(prompt),
    referenceSha256: referenceBytes === undefined ? undefined : sha256(referenceBytes),
    outputPath: projectRelative(roots.projectRoot, outFile),
    startedAt: new Date().toISOString(),
  };
  record.requests.pending.push(pending);
  await atomicWriteJson(recordFile, record);
  let posted = false;
  const endpoint =
    process.env.NODE_ENV === "test" && process.env.TN_REFERENCE_ENDPOINT
      ? process.env.TN_REFERENCE_ENDPOINT
      : DEFAULT_ENDPOINT;
  try {
    const capabilities = await discoverCapabilities(
      endpoint,
      options.model,
      referenceBytes !== undefined,
      options.timeoutMs,
    );
    record.providerCapabilities = {
      model: options.model,
      checkedAt: new Date().toISOString(),
      imageInputOutput: true,
      response: capabilities,
    };
    await atomicWriteJson(recordFile, record);
    const result = await fetchJson(
      endpoint,
      {
        method: "POST",
        headers: {
          // biome-ignore lint/style/useNamingConvention: HTTP header uses the exact wire spelling.
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          // biome-ignore lint/style/useNamingConvention: HTTP header uses the exact wire spelling.
          Accept: "application/json",
        },
        body: JSON.stringify(
          requestBody(
            options.model,
            prompt,
            referenceBytes === undefined
              ? undefined
              : { bytes: referenceBytes, info: referenceInfo },
          ),
        ),
      },
      options.timeoutMs,
    );
    posted = true;
    if (!result.response.ok)
      throw new ProviderError(providerMessage(result.response.status), {
        category: `http-${result.response.status}`,
        status: result.response.status,
        retryAfter: result.response.headers.get("retry-after") ?? undefined,
      });
    if (process.env.NODE_ENV === "test" && process.env.TN_REFERENCE_ABORT_AFTER_POST === "1")
      throw new ProviderError("test cancellation after provider dispatch", {
        category: "cancelled",
      });
    const image = findImagePayload(result.body);
    if (image === undefined)
      throw new ProviderError("provider returned no inline raster image", {
        category: "invalid-image",
      });
    const info = validateImage(image.bytes, extension);
    if (image.mime !== info.mime && !(image.mime === "image/jpg" && info.mime === "image/jpeg"))
      throw new ProviderError("provider MIME does not match decoded image bytes", {
        category: "invalid-image",
      });
    await atomicWriteBytes(outFile, image.bytes);
    const artifact = {
      path: projectRelative(roots.projectRoot, outFile),
      sha256: sha256(image.bytes),
      bytes: image.bytes.length,
      mime: info.mime,
      width: info.width,
      height: info.height,
    };
    const receipt = removeRequest(record, requestId, "pending");
    record.requests.completed.push({
      ...receipt,
      completedAt: new Date().toISOString(),
      artifact,
      usage: result.body.usage ?? result.body.cost ?? "unknown",
    });
    await atomicWriteJson(recordFile, record);
    console.log(
      JSON.stringify({
        action: "generated",
        requestId,
        model: options.model,
        output: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        mime: artifact.mime,
        width: artifact.width,
        height: artifact.height,
        usage: result.body.usage ?? result.body.cost ?? "unknown",
      }),
    );
  } catch (error) {
    const safeError =
      error instanceof ProviderError
        ? error
        : new ProviderError("provider operation failed", { category: "provider" });
    const receipt = removeRequest(record, requestId, "pending");
    if (receipt !== undefined) {
      const destination =
        posted ||
        safeError.category === "timeout" ||
        safeError.category === "network" ||
        safeError.category === "cancelled" ||
        String(safeError.category).startsWith("http-") ||
        safeError.category === "invalid-image"
          ? "unknown"
          : "failed";
      record.requests[destination].push({
        ...receipt,
        finishedAt: new Date().toISOString(),
        category: safeError.category,
        status: safeError.status,
        retryAfter: safeError.retryAfter,
      });
      await atomicWriteJson(recordFile, record);
    }
    throw safeError;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const recordFile = path.resolve(process.cwd(), options.record);
  const record = await readRecord(recordFile);
  const roots = recordRoot(record, recordFile);
  const release = await acquireLock(recordFile);
  try {
    await generate(options, recordFile, record, roots);
  } finally {
    await release();
  }
}

process.on("SIGINT", () => activeController?.abort());
process.on("SIGTERM", () => activeController?.abort());
main().catch((error) => {
  const category = error instanceof InputError ? "invalid-input" : (error.category ?? "provider");
  const exitCode = error instanceof InputError ? 2 : 1;
  console.log(
    JSON.stringify({
      action: "failed",
      category,
      status: error.status,
      retryAfter: error.retryAfter,
      message: error.message,
    }),
  );
  process.exitCode = exitCode;
});
