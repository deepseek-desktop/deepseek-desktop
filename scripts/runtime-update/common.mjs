import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const supportedTargets = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu"
});

export function hostTarget(platform = process.platform, architecture = process.arch) {
  const target = supportedTargets[`${platform}-${architecture}`];
  if (!target) throw new Error(`unsupported Runtime update host ${platform}-${architecture}`);
  return target;
}

export function assertSemVer(value, label) {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
  if (!pattern.test(value)) throw new Error(`${label} must be valid SemVer`);
  return value;
}

export function compareSemVer(left, right) {
  const parse = value => {
    assertSemVer(value, "version");
    const buildIndex = value.indexOf("+");
    const coreAndPrerelease = buildIndex === -1 ? value : value.slice(0, buildIndex);
    const prereleaseIndex = coreAndPrerelease.indexOf("-");
    const core = prereleaseIndex === -1
      ? coreAndPrerelease
      : coreAndPrerelease.slice(0, prereleaseIndex);
    const prerelease = prereleaseIndex === -1 ? "" : coreAndPrerelease.slice(prereleaseIndex + 1);
    return {
      core: core.split(".").map(Number),
      prerelease: prerelease ? prerelease.split(".") : []
    };
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] < rightVersion.core[index] ? -1 : 1;
    }
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    return leftVersion.prerelease.length === rightVersion.prerelease.length
      ? 0
      : leftVersion.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function isPrereleaseSemVer(value) {
  assertSemVer(value, "version");
  return value.split("+", 1)[0].includes("-");
}

export async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export function parseArguments(argumentsList) {
  if (argumentsList[0] === "--") argumentsList = argumentsList.slice(1);
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument ${key || ""}`.trim());
    values.set(key.slice(2), value);
  }
  return values;
}

export function artifactName(runtimeVersion, target) {
  assertSemVer(runtimeVersion, "Runtime version");
  if (!Object.values(supportedTargets).includes(target)) throw new Error(`unsupported Runtime target ${target}`);
  return `deepseek-runtime_${runtimeVersion}_${target}.tar.gz`;
}
