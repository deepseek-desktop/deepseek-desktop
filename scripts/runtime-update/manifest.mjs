import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { assertSemVer, compareSemVer, parseArguments, sha256, supportedTargets } from "./common.mjs";

function normalizeBaseUrl(value) {
  if (!value) return "";
  const url = new URL(value);
  if (!["file:", "http:", "https:"].includes(url.protocol)) {
    throw new Error("--base-url must use file, HTTP, or HTTPS");
  }
  if (url.username || url.password || url.hash || url.search || !url.pathname.endsWith("/")) {
    throw new Error("--base-url must be a credential-free directory URL without query or fragment");
  }
  return url.toString();
}

function normalizeAllowedOrigins(value) {
  const origins = value.split(",").map(origin => origin.trim()).filter(Boolean).map(origin => {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash) {
      throw new Error("--allowed-origins must contain credential-free HTTP(S) origins");
    }
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error("--allowed-origins must be unique");
  return origins;
}

const args = parseArguments(process.argv.slice(2));
const directory = resolve(args.get("directory") || ".");
const signingKeyPath = args.get("signing-key");
if (!signingKeyPath) throw new Error("--signing-key is required");
const channel = args.get("channel") || "stable";
if (!new Set(["stable", "preview"]).has(channel)) throw new Error("--channel must be stable or preview");
const minimumDesktopVersion = assertSemVer(args.get("minimum-desktop") || "1.0.0", "minimum Desktop version");
const maximumDesktopVersion = assertSemVer(args.get("maximum-desktop") || "2.0.0", "maximum Desktop version");
if (compareSemVer(minimumDesktopVersion, maximumDesktopVersion) > 0) {
  throw new Error("minimum Desktop version must not exceed maximum Desktop version");
}
const baseUrl = normalizeBaseUrl(args.get("base-url") || "");
const allowedOrigins = normalizeAllowedOrigins(args.get("allowed-origins") || "");
const expectedTargets = (args.get("targets") || Object.values(supportedTargets).join(","))
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);
if (expectedTargets.length === 0 || new Set(expectedTargets).size !== expectedTargets.length) {
  throw new Error("--targets must contain unique Runtime targets");
}
for (const target of expectedTargets) {
  if (!Object.values(supportedTargets).includes(target)) throw new Error(`unsupported Runtime target ${target}`);
}
const descriptors = [];
for (const filename of (await readdir(directory)).sort()) {
  if (/^runtime-update-descriptor\..+\.json$/u.test(filename)) {
    descriptors.push(JSON.parse(await readFile(join(directory, filename), "utf8")));
  }
}
if (descriptors.length === 0) throw new Error("no Runtime update descriptors were found");
const first = descriptors[0];
for (const descriptor of descriptors) {
  for (const field of [
    "runtimeVersion",
    "runtimeCommit",
    "runtimeRepository",
    "desktopCommit",
    "runtimeProtocolVersion",
    "credentialProtocolVersion",
    "credentialProviderVersion",
    "marketVersion",
    "nodeVersion",
    "nodeModuleAbi"
  ]) {
    if (descriptor[field] !== first[field]) throw new Error(`descriptor mismatch for ${field}`);
  }
}
if (descriptors.some(descriptor => descriptor.desktopDirty || descriptor.runtimeDirty)) {
  throw new Error("Runtime update manifests require clean Desktop and Runtime sources");
}
if (!/^[0-9a-f]{40}$/u.test(first.desktopCommit) || !/^[0-9a-f]{40}$/u.test(first.runtimeCommit)) {
  throw new Error("Runtime update descriptors must contain full Git commits");
}
const descriptorTargets = descriptors.map(descriptor => descriptor.target);
if (new Set(descriptorTargets).size !== descriptorTargets.length) {
  throw new Error("Runtime update descriptors contain duplicate targets");
}
const missingTargets = expectedTargets.filter(target => !descriptorTargets.includes(target));
const unexpectedTargets = descriptorTargets.filter(target => !expectedTargets.includes(target));
if (missingTargets.length > 0 || unexpectedTargets.length > 0) {
  throw new Error(`Runtime update target set mismatch; missing=${missingTargets.join(",") || "none"}; unexpected=${unexpectedTargets.join(",") || "none"}`);
}
if (channel === "stable" && first.runtimeVersion.includes("-")) {
  throw new Error("stable channel cannot publish a prerelease Runtime");
}
const artifacts = {};
for (const descriptor of descriptors) {
  const artifactFile = descriptor.artifact?.file;
  if (typeof artifactFile !== "string" || isAbsolute(artifactFile)) {
    throw new Error(`Runtime artifact path is invalid for ${descriptor.target}`);
  }
  const artifactPath = resolve(directory, artifactFile);
  const artifactRelative = relative(directory, artifactPath);
  if (!artifactRelative || artifactRelative.startsWith("..") || isAbsolute(artifactRelative)) {
    throw new Error(`Runtime artifact escapes the descriptor directory for ${descriptor.target}`);
  }
  const artifactSize = (await stat(artifactPath)).size;
  const artifactSha256 = await sha256(artifactPath);
  if (artifactSize !== descriptor.artifact.size || artifactSha256 !== descriptor.artifact.sha256) {
    throw new Error(`Runtime artifact does not match its descriptor for ${descriptor.target}`);
  }
  artifacts[descriptor.target] = {
    url: baseUrl ? new URL(artifactFile, baseUrl).toString() : artifactFile,
    size: artifactSize,
    sha256: artifactSha256
  };
}
const payload = {
  schemaVersion: 1,
  publisher: args.get("publisher") || "deepseek-desktop",
  issuedAt: new Date().toISOString(),
  runtimeVersion: first.runtimeVersion,
  channel,
  desktopProtocolVersion: 1,
  runtimeProtocolVersion: first.runtimeProtocolVersion,
  credentialProtocolVersion: first.credentialProtocolVersion,
  minimumDesktopVersion,
  maximumDesktopVersion,
  runtimeCommit: first.runtimeCommit,
  runtimeRepository: first.runtimeRepository,
  desktopCommit: first.desktopCommit,
  credentialProviderVersion: first.credentialProviderVersion,
  marketVersion: first.marketVersion,
  nodeVersion: first.nodeVersion,
  nodeModuleAbi: first.nodeModuleAbi,
  allowedOrigins,
  artifacts
};
const payloadBytes = Buffer.from(JSON.stringify(payload));
const privateKey = createPrivateKey(await readFile(resolve(signingKeyPath)));
const signature = sign(null, payloadBytes, privateKey);
const envelope = {
  schemaVersion: 1,
  signedPayload: payloadBytes.toString("base64"),
  signature: signature.toString("base64")
};
const output = resolve(args.get("output") || join(directory, "runtime-update-manifest.json"));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(envelope, null, 2)}\n`);
const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
console.log(`Runtime update manifest: ${output}`);
console.log(`RUNTIME_UPDATE_PUBLIC_KEY=${Buffer.from(publicDer).subarray(-32).toString("base64")}`);
