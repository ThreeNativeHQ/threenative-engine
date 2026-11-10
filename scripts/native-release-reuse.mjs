#!/usr/bin/env node

// PRD-630: a tag run publishes the bytes its promotion proof already built and installed.
// `find <sha>` prints `proof_run=<id>`, empty when no proof qualifies, so the tag run builds.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gh } from "./lib/gh.mjs";

const repository = () => process.env.GITHUB_REPOSITORY ?? "";

const api = (path) => JSON.parse(gh(["api", `repos/${repository()}/${path}`]));
const treeOf = (sha) => api(`commits/${sha}`).commit.tree.sha;

/** What a proof must have passed. The iOS consumer job is evidence, so it is left out. */
const PROOF_JOBS = [
  /^build \(/u,
  /^build-android$/u,
  /^build-ios-simulator$/u,
  /^publish$/u,
  /^clean-consumer$/u,
  /^clean-consumer-windows$/u,
  /^finalize$/u,
];

export function passedProof(jobs) {
  return PROOF_JOBS.every((name) => {
    const matches = jobs.filter((job) => name.test(job.name));
    return matches.length > 0 && matches.every((job) => job.conclusion === "success");
  });
}

function identityOf(runId) {
  const dir = mkdtempSync(join(tmpdir(), "tn-proof-"));
  gh([
    "run",
    "download",
    String(runId),
    "--repo",
    repository(),
    "-n",
    "clean-consumer-linux-x64",
    "-D",
    dir,
  ]);
  return JSON.parse(readFileSync(join(dir, "proof-asset-identity.json"), "utf8"));
}

/** The newest green proof whose tested commit has the tree of `sha`. Every miss is `{ reason }`. */
export function findProof(sha, read = { api, identityOf, treeOf }) {
  const parents = read.api(`commits/${sha}`).parents;
  if (parents?.length !== 2) return { reason: `${sha} is not a promotion merge` };
  const head = parents[1].sha;
  const listed = read.api(
    `actions/workflows/native-release.yml/runs?event=pull_request&head_sha=${head}&status=completed&per_page=20`,
  );
  const runs = [...listed.workflow_runs].sort((a, b) => b.run_number - a.run_number);
  const tree = read.treeOf(sha);
  for (const run of runs) {
    const jobs = read.api(`actions/runs/${run.id}/jobs?per_page=100`).jobs;
    if (!passedProof(jobs)) continue;
    const identity = read.identityOf(run.id);
    if (read.treeOf(identity.candidateSha) === tree) return { runId: run.id };
  }
  return { reason: `no green proof of ${head} tested this tree` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.argv[2];
  // Any read failure means no reuse: the tag run then builds.
  let found;
  try {
    found = findProof(sha);
  } catch (error) {
    found = { reason: String(error?.message ?? error) };
  }
  if (found.reason) console.error(`No proof to reuse, the tag run builds: ${found.reason}`);
  console.log(`proof_run=${found.runId ?? ""}`);
}
