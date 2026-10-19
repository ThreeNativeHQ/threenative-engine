import { afterEach, beforeEach, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execute }));
const { readAttemptJobs } = await import(
  new URL("../ci-attempt-receipts.mjs", import.meta.url).href
);
const identity = { repository: "owner/repo", runId: "123", runAttempt: "2" };
const complete = JSON.stringify([{ total_count: 1, jobs: [{ id: 10, run_attempt: 2 }] }]);
beforeEach(() => {
  execute.mockReset();
  vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
});
afterEach(() => {
  vi.restoreAllMocks();
});
const failure = (stderr: string) => Object.assign(new Error(stderr), { stderr, status: 1 });
it("fetches every small page without requesting the 100-job response that returns 502", () => {
  execute.mockImplementation((_command, args) => {
    if (args.at(-1).endsWith("per_page=100")) throw failure("HTTP 502: Server Error");
    return JSON.stringify([
      { total_count: 2, jobs: [{ id: 10, run_attempt: 2 }] },
      { total_count: 2, jobs: [{ id: 11, run_attempt: 2 }] },
    ]);
  });
  expect(readAttemptJobs(identity)).toEqual({
    totalCount: 2,
    jobs: [
      { id: 10, run_attempt: 2 },
      { id: 11, run_attempt: 2 },
    ],
  });
  expect(execute.mock.calls[0]?.[1]).toEqual([
    "api",
    "--paginate",
    "--slurp",
    "repos/owner/repo/actions/runs/123/attempts/2/jobs?per_page=10",
  ]);
});
it("retries a transport outage against the same exact attempt endpoint", () => {
  execute.mockImplementationOnce(() => {
    throw failure("error connecting to api.github.com");
  });
  execute.mockReturnValueOnce(complete);
  expect(readAttemptJobs(identity).jobs).toEqual([{ id: 10, run_attempt: 2 }]);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
});
it.each([500, 502, 503, 504])(
  "retries HTTP %s against the same exact attempt endpoint",
  (status) => {
    execute.mockImplementationOnce(() => {
      throw failure(`gh: Server Error (HTTP ${status})`);
    });
    execute.mockReturnValueOnce(complete);
    expect(readAttemptJobs(identity).jobs).toEqual([{ id: 10, run_attempt: 2 }]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
  },
);
it("fails closed after eight server failures without accepting partial pages", () => {
  execute.mockImplementation(() => {
    throw Object.assign(failure("gh: Server Error (HTTP 502)"), { stdout: complete });
  });
  expect(() => readAttemptJobs(identity)).toThrow("HTTP 502");
  expect(execute).toHaveBeenCalledTimes(8);
});
it("refetches every page when new jobs change the inventory during pagination", () => {
  execute.mockReturnValueOnce(
    JSON.stringify([
      { total_count: 1, jobs: [{ id: 99 }] },
      { total_count: 2, jobs: [{ id: 100 }] },
    ]),
  );
  execute.mockReturnValueOnce(complete);
  expect(readAttemptJobs(identity).jobs).toEqual([{ id: 10, run_attempt: 2 }]);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
});
it("fails closed when every paginated inventory changes", () => {
  execute.mockReturnValue(
    JSON.stringify([
      { total_count: 1, jobs: [{ id: 99 }] },
      { total_count: 2, jobs: [{ id: 100 }] },
    ]),
  );
  expect(() => readAttemptJobs(identity)).toThrow("API_INCOMPLETE");
  expect(execute).toHaveBeenCalledTimes(8);
});
it("fails closed after eight connection failures without returning a receipt", () => {
  execute.mockImplementation(() => {
    throw failure("error connecting to api.github.com");
  });
  expect(() => readAttemptJobs(identity)).toThrow("error connecting");
  expect(execute).toHaveBeenCalledTimes(8);
});
it("resolves a valid one-page response after two connection failures", () => {
  execute.mockImplementationOnce(() => {
    throw failure("error connecting to api.github.com");
  });
  execute.mockImplementationOnce(() => {
    throw failure("error connecting to api.github.com");
  });
  execute.mockReturnValueOnce(complete);
  expect(readAttemptJobs(identity)).toEqual({
    totalCount: 1,
    jobs: [{ id: 10, run_attempt: 2 }],
  });
  expect(execute).toHaveBeenCalledTimes(3);
  expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
  expect(execute.mock.calls[0]).toEqual(execute.mock.calls[2]);
  expect(vi.mocked(Atomics.wait).mock.calls.map((call) => call[3])).toEqual([1000, 2000]);
});
it("throws after eight connection failures with seven exponential backoffs", () => {
  const error = failure("error connecting to api.github.com");
  execute.mockImplementation(() => {
    throw error;
  });
  expect(() => readAttemptJobs(identity)).toThrow(error);
  expect(execute).toHaveBeenCalledTimes(8);
  expect(vi.mocked(Atomics.wait).mock.calls.map((call) => call[3])).toEqual([
    1000, 2000, 4000, 8000, 16000, 32000, 64000,
  ]);
});
it("throws on the first HTTP 403 failure without connection text", () => {
  execute.mockImplementation(() => {
    throw failure("HTTP 403");
  });
  expect(() => readAttemptJobs(identity)).toThrow("HTTP 403");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(Atomics.wait).not.toHaveBeenCalled();
});
it.each([
  "HTTP 403: Resource not accessible by integration",
  "HTTP 401: Bad credentials",
  "HTTP 404: Not Found",
  "HTTP 429: rate limit",
  "unknown failure",
])("does not retry permissions or non-transport error: %s", (message) => {
  execute.mockImplementation(() => {
    throw failure(message);
  });
  expect(() => readAttemptJobs(identity)).toThrow(message);
  expect(execute).toHaveBeenCalledTimes(1);
});
it.each([
  "{bad-json",
  JSON.stringify([{ total_count: 2, jobs: [{ id: 10 }] }]),
  JSON.stringify([{ total_count: 2, jobs: [{ id: 10 }, { id: 10 }] }]),
])("never retries malformed or incomplete API evidence: %s", (response) => {
  execute.mockReturnValue(response);
  expect(() => readAttemptJobs(identity)).toThrow();
  expect(execute).toHaveBeenCalledTimes(1);
});
it("rejects an invalid attempt before accessing the API", () => {
  expect(() => readAttemptJobs({ ...identity, runAttempt: "0" })).toThrow("RUN_IDENTITY");
  expect(execute).not.toHaveBeenCalled();
});

it("does not retry a permission denial even if it also mentions connectivity", () => {
  execute.mockImplementation(() => {
    throw failure("HTTP 403: Resource not accessible; error connecting to api.github.com");
  });
  expect(() => readAttemptJobs(identity)).toThrow("HTTP 403");
  expect(execute).toHaveBeenCalledTimes(1);
});
it("does not retry an interrupted request or use its partial output", () => {
  execute.mockImplementation(() => {
    throw Object.assign(failure("error connecting to api.github.com"), {
      signal: "SIGTERM",
      stdout: complete,
    });
  });
  expect(() => readAttemptJobs(identity)).toThrow("error connecting");
  expect(execute).toHaveBeenCalledTimes(1);
});
it("rereads while a job the caller depends on still reads as unfinished", () => {
  const stale = JSON.stringify([
    { total_count: 1, jobs: [{ id: 10, name: "integration / animation", status: "queued" }] },
  ]);
  const settled = JSON.stringify([
    {
      total_count: 1,
      jobs: [
        { id: 10, name: "integration / animation", status: "completed", conclusion: "success" },
      ],
    },
  ]);
  execute.mockReturnValueOnce(stale).mockReturnValueOnce(settled);
  expect(readAttemptJobs(identity, "CI_INTEGRATION", ["integration / animation"]).jobs).toEqual([
    { id: 10, name: "integration / animation", status: "completed", conclusion: "success" },
  ]);
  expect(execute).toHaveBeenCalledTimes(2);
});
it("returns the last unfinished read so the caller's own check fails closed", () => {
  const stale = JSON.stringify([
    { total_count: 1, jobs: [{ id: 10, name: "integration / animation", status: "queued" }] },
  ]);
  execute.mockReturnValue(stale);
  expect(readAttemptJobs(identity, "CI_INTEGRATION", ["integration / animation"]).jobs).toEqual([
    { id: 10, name: "integration / animation", status: "queued" },
  ]);
  expect(execute).toHaveBeenCalledTimes(8);
});
it("does not wait on unfinished jobs the caller does not depend on", () => {
  execute.mockReturnValue(
    JSON.stringify([
      { total_count: 1, jobs: [{ id: 10, name: "integration / tone", status: "in_progress" }] },
    ]),
  );
  expect(
    readAttemptJobs(identity, "CI_INTEGRATION", ["integration / animation"]).jobs,
  ).toHaveLength(1);
  expect(execute).toHaveBeenCalledTimes(1);
});
