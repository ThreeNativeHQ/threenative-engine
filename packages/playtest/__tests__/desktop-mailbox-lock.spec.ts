import { beforeEach, expect, test, vi } from "vitest";

const fs = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: fs.mkdir,
  readFile: fs.readFile,
  rename: fs.rename,
  rm: fs.rm,
  writeFile: fs.writeFile,
}));

const { LocalDeviceMailbox } = await import("../src/runner/desktop.js");

const coded = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  fs.readFile.mockReset();
  fs.rm.mockReset();
  fs.rename.mockReset();
  fs.writeFile.mockReset();
});

// CI run 35818304207: the Windows starter HUD playtest died on EPERM lstat of
// tn-playtest-response.json while the native game was replacing it.
test("a Windows mailbox lock reads as not-yet-written so the poller retries", async () => {
  const mailbox = new LocalDeviceMailbox();
  fs.readFile.mockRejectedValueOnce(coded("EPERM")).mockRejectedValueOnce(coded("EBUSY"));
  expect(await mailbox.read("response.json")).toBeUndefined();
  expect(await mailbox.read("response.json")).toBeUndefined();
  fs.readFile.mockRejectedValueOnce(coded("EACCES"));
  await expect(mailbox.read("response.json")).rejects.toThrow("EACCES");
});

test("removing the mailbox file retries a Windows lock without recursive deletion", async () => {
  fs.rm.mockRejectedValueOnce(coded("EPERM")).mockResolvedValueOnce(undefined);
  await new LocalDeviceMailbox().remove("response.json");
  expect(fs.rm).toHaveBeenNthCalledWith(1, "response.json", { force: true });
  expect(fs.rm).toHaveBeenNthCalledWith(2, "response.json", { force: true });
});

test("removing the mailbox file surfaces a permanent error without retrying", async () => {
  fs.rm.mockRejectedValueOnce(coded("EACCES"));
  await expect(new LocalDeviceMailbox().remove("response.json")).rejects.toMatchObject({ code: "EACCES" });
  expect(fs.rm).toHaveBeenCalledTimes(1);
  expect(fs.rm).toHaveBeenCalledWith("response.json", { force: true });
});

// CI run 41348117470: the Windows startup sample died on a path-bearing error while every other
// mailbox operation already retried a lock. A scanner or a pending delete can hold the target.
test("writing a mailbox request retries a Windows lock on the rename", async () => {
  fs.rename
    .mockRejectedValueOnce(coded("EPERM"))
    .mockRejectedValueOnce(coded("EBUSY"))
    .mockResolvedValueOnce(undefined);
  await new LocalDeviceMailbox().write("mailbox/request.json", "{}");
  expect(fs.rename).toHaveBeenCalledTimes(3);
  expect(fs.rename).toHaveBeenLastCalledWith("mailbox/request.json.tmp", "mailbox/request.json");
});

test("writing a mailbox request surfaces a permanent error without retrying", async () => {
  fs.rename.mockRejectedValueOnce(coded("ENOSPC"));
  await expect(new LocalDeviceMailbox().write("mailbox/request.json", "{}")).rejects.toMatchObject({
    code: "ENOSPC",
  });
  expect(fs.rename).toHaveBeenCalledTimes(1);
});
