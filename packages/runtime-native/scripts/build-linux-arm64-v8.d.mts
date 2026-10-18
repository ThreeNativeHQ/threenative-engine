// Types for the plain-Node producer consumed by the TypeScript CI contracts.
interface IBuildIdentity {
  recipe: number;
  version: string;
  source: string;
  depotTools: string;
  gn: string;
  gnPackage: string;
  gnSha256: string;
  toolchain: {
    base: string;
    version: string;
    packageVersion: string;
    architecture: string;
    index: string;
    compilerRt: {
      packageVersion: string;
      index: string;
      archive: string;
      objects: number;
      sha256: string;
    };
    packages: Record<string, string>;
  };
}
interface IToolchainReceipt {
  packages: Record<string, string>;
  binaries: Record<
    "clang" | "clang++" | "ld.lld" | "llvm-ar" | "llvm-nm",
    { sha256: string; version: string }
  >;
  linux: { packages: Record<string, string>; modules: Record<string, string> };
  compilerRt: { archive: string; sha256: string; objects: number };
  gn?: { package: string; sha256: string; version: string };
}
interface IBuildLicense {
  revision: string;
  url: string;
  bytes: number;
  sha256: string;
}
interface IV8Receipt {
  schemaVersion: number;
  build: IBuildIdentity;
  args: string;
  buildLicense: IBuildLicense;
  toolchain: IToolchainReceipt & { gn: NonNullable<IToolchainReceipt["gn"]> };
  objects: number;
  files: Record<string, string>;
}
export declare const LINUX_ARM64_V8_BUILD: IBuildIdentity;
export declare const CHROMIUM_BUILD_LICENSE: IBuildLicense;
export declare function reusableLinuxArm64V8State(
  previous: string,
  expected: string,
  repairScriptSha?: string,
): boolean;
export declare function fetchChromiumBuildLicense(
  run?: (program: string, args: string[]) => Buffer | string,
): Buffer;
export declare function linuxArm64V8GnArgs(): string;
export declare function assertArm64V8Archive(bytes: Buffer): number;
export declare function inspectLinuxArm64V8Toolchain(options?: {
  run?: (program: string, args: string[]) => string;
  hash?: (path: string) => string;
  read?: (path: string) => Buffer;
}): IToolchainReceipt;
export declare function createLinuxArm64V8Receipt(
  root: string,
  toolchain: IToolchainReceipt,
): IV8Receipt;
export declare function verifyLinuxArm64V8Installation(root: string): IV8Receipt;
export declare function prepareLinuxArm64V8Sdk(
  source: string,
  run?: (program: string, args: string[]) => unknown,
): void;
export declare function promoteV8Payload(stage: string, destination: string, backup: string): void;
export declare function provisionLinuxArm64V8(
  destination: string,
  options?: { force?: boolean; env?: NodeJS.ProcessEnv },
): IV8Receipt;
export declare function runLinuxArm64V8Command(
  args: string[],
  options?: {
    root?: string;
    verify?: (root: string) => IV8Receipt;
    provision?: (root: string, options: { force: boolean }) => IV8Receipt;
  },
): IV8Receipt;
