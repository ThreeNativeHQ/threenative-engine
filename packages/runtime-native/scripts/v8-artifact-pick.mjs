#!/usr/bin/env node

/**
 * Which published workflow artifact a run may restore the Android V8 payload from.
 *
 * A workflow artifact has no ref scope, so it is the only GitHub store through which a payload one
 * run built reaches a pull request's later run (PRD-628). It is also, unlike the `ci-v8-android`
 * release asset, writable by every run — a fork's pull request run included. So the reader trusts
 * only this repository's own head, never a fork, and only main, develop or the run's own pull
 * request head branch. The downloaded payload must still pass `build-android-v8.mjs --verify`
 * before it is used, and only a run that compiled the payload itself may publish it.
 *
 * Usage (stdin is the artifacts list):
 *   gh api "repos/<repo>/actions/artifacts?name=v8-android-<hash>" \
 *     | node scripts/v8-artifact-pick.mjs --branches "main develop <head branch>"
 *
 * Prints the run id to download, or nothing when no artifact is trusted.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The API answered with something this filter cannot reason about. Never a silent "no artifact". */
export const ARTIFACT_MALFORMED = 'TN_V8_ARTIFACT_MALFORMED';
/** A caller named no trusted branch, which would make every branch trusted. */
export const ARTIFACT_NO_BRANCHES = 'TN_V8_ARTIFACT_NO_BRANCHES';

function trustedBranches(branches) {
  const allowed = new Set(String(branches).split(/\s+/u).filter((branch) => branch !== ''));
  if (allowed.size === 0) throw new Error(`${ARTIFACT_NO_BRANCHES}: no trusted branch was given`);
  return allowed;
}

function createdDays(artifact) {
  const at = Date.parse(artifact.created_at ?? '');
  return Number.isFinite(at) ? at : 0;
}

/** The artifacts list, whether the caller kept the response object or its array. */
export function artifactsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.artifacts)) return payload.artifacts;
  throw new Error(`${ARTIFACT_MALFORMED}: expected an artifacts list or an object with one`);
}

/**
 * The newest artifact this run may download: this repository's own head, a trusted head branch,
 * not expired. `null` when none qualifies, so the caller falls back to a cache restore or a build.
 */
export function pickPublishedArtifact(payload, branches) {
  const allowed = trustedBranches(branches);
  const usable = artifactsOf(payload).filter((artifact) => {
    const run = artifact?.workflow_run;
    if (!run || typeof run !== 'object' || typeof run.id !== 'number') {
      throw new Error(`${ARTIFACT_MALFORMED}: an artifact carries no workflow run id`);
    }
    if (artifact.expired === true) return false;
    // A fork's pull request run uploads into this repository's artifact store, so the head
    // repository is what tells its bytes apart from one this repository built. Both ids must be
    // numbers before they are compared: two missing ids are equal, and an artifact of unknown
    // origin then read as this repository's own.
    if (!Number.isSafeInteger(run.head_repository_id) || !Number.isSafeInteger(run.repository_id))
      throw new Error(`${ARTIFACT_MALFORMED}: an artifact carries no numeric repository id`);
    if (run.head_repository_id !== run.repository_id) return false;
    return allowed.has(run.head_branch);
  });
  const [newest] = usable.sort((left, right) => createdDays(right) - createdDays(left));
  if (newest === undefined) return null;
  return {
    runId: newest.workflow_run.id,
    headBranch: newest.workflow_run.head_branch,
    createdAt: newest.created_at ?? '',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf('--branches');
  const branches = at < 0 ? '' : (process.argv[at + 1] ?? '');
  if (branches === '') {
    console.error('usage: node scripts/v8-artifact-pick.mjs --branches "main develop <head branch>"');
    process.exit(2);
  }
  const picked = pickPublishedArtifact(JSON.parse(readFileSync(0, 'utf8')), branches);
  if (picked !== null) process.stdout.write(`${picked.runId}\n`);
}
