import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { ICapabilityEntry, ICapabilityManifest } from "../packages/engine-mcp/src/index.js";

const MODEL = "minishlab/potion-base-2M";
const REVISION = "389b9f64be5aa4ae7a6bc6fe95ef20ce485ae5da";
const SOURCE_HASHES = {
  "tokenizer.json": "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50",
  "model.safetensors": "f95ffde02ad06f63ae38eb9d400038cd5ccaf8411ec3cb650c6025113f96cbb8",
} as const;
const MAGIC = Buffer.from(`TN-MODEL2VEC-1:${REVISION}\n`);
const FILE = "potion-base-2M-int8.bin";
const DIMENSIONS = 64;
const TOKEN_COUNT = 29_528;
const TOKEN_ROW = DIMENSIONS + 4;
const HEADER_BYTES = MAGIC.length + 32 + 4;
const MAX_TOKENS = 512;
const SPECIAL_TOKEN = /^(\[(?:PAD|UNK|CLS|SEP|MASK)\])$/u;

function sha256(bytes: Buffer | string): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export function capabilityCandidateId(
  entry: Pick<ICapabilityEntry, "symbol" | "importPath">,
): string {
  return `${entry.importPath}\0${entry.symbol}`;
}

function documentText(entry: ICapabilityEntry): string {
  const name = entry.symbol
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2");
  return [name, ...entry.aliases, ...entry.situations, entry.summary].join(". ");
}

function corpusDigest(entries: readonly ICapabilityEntry[]): Buffer {
  return sha256(
    JSON.stringify(entries.map((entry) => [capabilityCandidateId(entry), documentText(entry)])),
  );
}

// WordPiece with the pinned model's uncased BERT normalizer and pre-tokenizer.
function tokenize(text: string, vocab: Readonly<Record<string, number>>): number[] {
  const tokens: number[] = [];
  // shortcut: the benchmark uses short English queries, match full upstream Unicode behavior before general use.
  const normalized = text
    .slice(0, MAX_TOKENS * 8)
    .replace(/\p{White_Space}/gu, " ")
    .replace(/\p{C}|\uFFFD/gu, "");
  for (const specialOrText of normalized.split(/(\[(?:PAD|UNK|CLS|SEP|MASK)\])/u)) {
    const words = SPECIAL_TOKEN.test(specialOrText)
      ? [specialOrText]
      : (specialOrText
          .toLowerCase()
          .normalize("NFD")
          .replace(/\p{Mn}/gu, "")
          .match(
            /\p{Unified_Ideograph}|[!-/:-@\[-`{-~\p{P}]|[^\s!-/:-@\[-`{-~\p{P}\p{Unified_Ideograph}]+/gu,
          ) ?? []);
    for (const word of words) {
      if (word === "[UNK]") continue;
      tokens.push(...wordPieces(word, vocab));
      if (tokens.length >= MAX_TOKENS) return tokens.slice(0, MAX_TOKENS);
    }
  }
  return tokens;
}

function wordPieces(word: string, vocab: Readonly<Record<string, number>>): number[] {
  const whole = vocab[word];
  if (whole !== undefined) return [whole];
  const chars = Array.from(word);
  if (chars.length > 100) return [];
  const ids: number[] = [];
  let start = 0;
  while (start < chars.length) {
    const prefix = start ? "##" : "";
    let end = chars.length;
    let id = vocab[prefix + chars.slice(start, end).join("")];
    while (id === undefined && end > start + 1) {
      end--;
      id = vocab[prefix + chars.slice(start, end).join("")];
    }
    if (id === undefined) return [];
    ids.push(id);
    start = end;
  }
  return ids;
}

function signedBytes(buffer: Buffer): Int8Array {
  return new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function encoder(vocab: Readonly<Record<string, number>>, table: Buffer) {
  const vectors = signedBytes(table);
  return (text: string): Float64Array => {
    const sum = new Float64Array(DIMENSIONS);
    for (const id of tokenize(text, vocab)) {
      const offset = id * TOKEN_ROW;
      const scale = table.readFloatLE(offset + DIMENSIONS);
      for (let i = 0; i < DIMENSIONS; i++)
        sum[i] = (sum[i] ?? 0) + (vectors[offset + i] ?? 0) * scale;
    }
    // Unit-normalized pooling cancels the average's token-count divisor.
    const norm = Math.sqrt(sum.reduce((squares, value) => squares + value * value, 0));
    if (norm !== 0) for (const [i, value] of sum.entries()) sum[i] = value / norm;
    return sum;
  };
}

export function loadCapabilityModel2Vec(assetDir: string, entries: readonly ICapabilityEntry[]) {
  const started = performance.now();
  const asset = readFileSync(path.join(assetDir, FILE));
  if (asset.length < HEADER_BYTES || !asset.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error("Invalid Model2Vec asset revision or format.");
  if (!asset.subarray(MAGIC.length, MAGIC.length + 32).equals(corpusDigest(entries))) {
    throw new Error("Model2Vec corpus changed. Repack the asset with the benchmark manifest.");
  }
  const vocabEnd = HEADER_BYTES + asset.readUInt32LE(HEADER_BYTES - 4);
  const tableEnd = vocabEnd + TOKEN_COUNT * TOKEN_ROW;
  if (asset.length !== tableEnd + entries.length * DIMENSIONS)
    throw new Error("Invalid Model2Vec asset length.");
  const vocab: Record<string, number> = Object.setPrototypeOf(
    JSON.parse(asset.toString("utf8", HEADER_BYTES, vocabEnd)),
    null,
  );
  const encode = encoder(vocab, asset.subarray(vocabEnd, tableEnd));
  const documents = signedBytes(asset.subarray(tableEnd));
  const ids = entries.map(capabilityCandidateId);
  const assetSha256 = sha256(asset).toString("hex");
  return {
    model: MODEL,
    modelRevision: REVISION,
    assetBytes: asset.length,
    assetSha256,
    coldStartMs: performance.now() - started,
    rank(query: string, limit = 20): string[] {
      const queryVector = encode(query);
      const hits: { id: string; score: number }[] = [];
      for (const [row, id] of ids.entries()) {
        let score = 0;
        for (let i = 0; i < DIMENSIONS; i++)
          score += (queryVector[i] ?? 0) * (documents[row * DIMENSIONS + i] ?? 0);
        if (score > 0) hits.push({ id, score });
      }
      return hits
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ id }) => id);
    },
  };
}

export function fuseCapabilityRanks(
  lexicalIds: readonly string[],
  semanticIds: readonly string[],
): string[] {
  const scores = new Map<string, number>();
  for (const ids of [lexicalIds, semanticIds]) {
    let rank = 0;
    for (const id of new Set(ids)) scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + ++rank));
  }
  // Stable sort keeps lexical rank as the tie-breaker.
  return [...scores.keys()].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
}

async function fetchSource(file: keyof typeof SOURCE_HASHES): Promise<Buffer> {
  const res = await fetch(`https://huggingface.co/${MODEL}/resolve/${REVISION}/${file}`);
  if (!res.ok) throw new Error(`Model2Vec source ${file} returned HTTP ${res.status}.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (sha256(bytes).toString("hex") !== SOURCE_HASHES[file])
    throw new Error(`Model2Vec source hash mismatch for ${file}.`);
  return bytes;
}

async function prepare(assetDir: string, entries: readonly ICapabilityEntry[]) {
  const [tokenizer, weights] = await Promise.all([
    fetchSource("tokenizer.json"),
    fetchSource("model.safetensors"),
  ]);
  const vocab: Record<string, number> = Object.setPrototypeOf(
    JSON.parse(tokenizer.toString()).model.vocab,
    null,
  );
  // Reference IDs from the pinned Hugging Face tokenizer with no added special tokens.
  assert.deepEqual(
    tokenize("Café: allocatable_tiles!", vocab),
    [6674, 30, 1041, 23761, 9886, 41, 12268, 5],
  );
  assert.deepEqual(tokenize("[UNK] render [MASK] 🌎", vocab), [16558, 4]);
  const vocabJson = Buffer.from(JSON.stringify(vocab));
  // The verified safetensors file has one contiguous little-endian f32 embedding table.
  const weightsOffset = 8 + Number(weights.readBigUInt64LE(0));
  const table = Buffer.alloc(TOKEN_COUNT * TOKEN_ROW);
  for (let row = 0; row < TOKEN_COUNT; row++) {
    const offset = weightsOffset + row * DIMENSIONS * 4;
    const embedding = Array.from({ length: DIMENSIONS }, (_, i) =>
      weights.readFloatLE(offset + i * 4),
    );
    const scale = Math.max(...embedding.map(Math.abs)) / 127;
    for (const [i, value] of embedding.entries()) {
      table.writeInt8(scale ? Math.round(value / scale) : 0, row * TOKEN_ROW + i);
    }
    table.writeFloatLE(scale, row * TOKEN_ROW + DIMENSIONS);
  }
  const encode = encoder(vocab, table);
  const documents = Buffer.alloc(entries.length * DIMENSIONS);
  for (const [row, entry] of entries.entries()) {
    const normalized = encode(documentText(entry));
    for (const [i, value] of normalized.entries())
      documents.writeInt8(Math.round(127 * value), row * DIMENSIONS + i);
  }
  const vocabLength = Buffer.alloc(4);
  vocabLength.writeUInt32LE(vocabJson.length);
  const asset = Buffer.concat([
    MAGIC,
    corpusDigest(entries),
    vocabLength,
    vocabJson,
    table,
    documents,
  ]);
  mkdirSync(assetDir, { recursive: true });
  const filename = path.join(assetDir, FILE);
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, asset);
  renameSync(temporary, filename);
  console.log(
    JSON.stringify({
      filename,
      bytes: asset.length,
      sha256: sha256(asset).toString("hex"),
      revision: REVISION,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, assetDir, manifestFile] = process.argv.slice(2);
  if (command !== "--prepare" || !assetDir || !manifestFile) {
    throw new Error(
      "Usage: pnpm tsx scripts/capability-search-model2vec.ts --prepare <asset-dir> <manifest-json>",
    );
  }
  const manifest: ICapabilityManifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  void prepare(assetDir, manifest.entries).catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
