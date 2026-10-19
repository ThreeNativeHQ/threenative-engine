/// <reference lib="webworker" />

import {
  type ITerrainJob,
  type ITerrainJobResult,
  runTerrainJob,
  terrainJobTransfers,
} from "./terrain-jobs.js";

/** The worker half of the terrain jobs: one message in, one transferred result back. */
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent): void => {
  const request = event.data as { id: number; job: ITerrainJob };
  const result: ITerrainJobResult = runTerrainJob(request.job);
  self.postMessage({ id: request.id, result }, terrainJobTransfers(result));
};
