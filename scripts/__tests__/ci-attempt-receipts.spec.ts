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
it("retries a transport outage against the same exact attempt endpoint", () => {
  execute.mockImplementationOnce(() => {
    throw failure("error connecting to api.github.com");
  });
  execute.mockReturnValueOnce(complete);
  expect(readAttemptJobs(identity).jobs).toEqual([{ id: 10, run_attempt: 2 }]);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
});
it("fails closed after five connection failures without returning a receipt", () => {
  execute.mockImplementation(() => {
    throw failure("error connecting to api.github.com");
  });
  expect(() => readAttemptJobs(identity)).toThrow("error connecting");
  expect(execute).toHaveBeenCalledTimes(5);
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
it("throws after five connection failures with four exponential backoffs", () => {
  const error = failure("error connecting to api.github.com");
  execute.mockImplementation(() => {
    throw error;
  });
  expect(() => readAttemptJobs(identity)).toThrow(error);
  expect(execute).toHaveBeenCalledTimes(5);
  expect(vi.mocked(Atomics.wait).mock.calls.map((call) => call[3])).toEqual([
    1000, 2000, 4000, 8000,
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
