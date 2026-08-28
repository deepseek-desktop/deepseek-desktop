import { parseEnv } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, normalize, resolve, sep } from "node:path";

export const CONFIG_KEYS = Object.freeze([
  "DESKTOP_APP_NAME",
  "DESKTOP_APP_VERSION",
  "DESKTOP_APP_IDENTIFIER",
  "DESKTOP_APP_SLUG",
  "DESKTOP_APP_DESCRIPTION",
  "DESKTOP_APP_AUTHORS",
  "DESKTOP_APP_REPOSITORY",
  "DESKTOP_APP_ICON",
  "RUNTIME_REPOSITORY",
  "RUNTIME_REF",
  "RUNTIME_UPDATE_MANIFEST_URL",
  "RUNTIME_UPDATE_CHANNEL",
  "RUNTIME_AUTO_UPDATE",
  "RUNTIME_UPDATE_PUBLISHER",
  "RUNTIME_UPDATE_PUBLIC_KEY",
  "RELEASE_CHANNEL",
  "RELEASE_SIGNED"
]);

export const DEFAULT_CONFIG = Object.freeze({
  DESKTOP_APP_NAME: "DeepSeek Desktop",
  DESKTOP_APP_VERSION: "1.0.0",
  DESKTOP_APP_IDENTIFIER: "deepseek.desktop",
  DESKTOP_APP_SLUG: "deepseek-desktop",
  DESKTOP_APP_DESCRIPTION: "Local AI agent workspace",
  DESKTOP_APP_AUTHORS: "DeepSeek Desktop Contributors",
  DESKTOP_APP_REPOSITORY: "",
  DESKTOP_APP_ICON: "src-tauri/icons/icon.png",
  RUNTIME_REPOSITORY: "https://github.com/deepseek-desktop/deepseek-harness.git",
  RUNTIME_REF: "",
  RUNTIME_UPDATE_MANIFEST_URL: "",
  RUNTIME_UPDATE_CHANNEL: "stable",
  RUNTIME_AUTO_UPDATE: "true",
  RUNTIME_UPDATE_PUBLISHER: "deepseek-desktop",
  RUNTIME_UPDATE_PUBLIC_KEY: "",
  RELEASE_CHANNEL: "local",
  RELEASE_SIGNED: "false"
});

const OPTIONAL_EMPTY_KEYS = new Set([
  "DESKTOP_APP_REPOSITORY",
  "RUNTIME_REF",
  "RUNTIME_UPDATE_MANIFEST_URL",
  "RUNTIME_UPDATE_PUBLIC_KEY"
]);

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const identifierPattern = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/u;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function formatDisplayVersion(version) {
  return version.startsWith("v") ? version : `v${version}`;
}

function assertKnownKeys(values, source) {
  const unknown = Object.keys(values)
    .filter(key => (
      key.startsWith("DESKTOP_APP_")
      || key.startsWith("RUNTIME_")
      || key.startsWith("RELEASE_")
    ) && !CONFIG_KEYS.includes(key))
    .sort();
  if (unknown.length > 0) throw new Error(`${source} contains unsupported build configuration: ${unknown.join(", ")}`);
}

function assertText(name, value) {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
  if ([...value].some(character => /[\u0000-\u001f\u007f]/u.test(character))) {
    throw new Error(`${name} must not contain control characters`);
  }
}

function normalizeRelativePath(value) {
  const portable = value.replaceAll("\\", "/");
  if (isAbsolute(portable) || /^[A-Za-z]:\//u.test(portable)) {
    throw new Error("DESKTOP_APP_ICON must be relative to the repository root");
  }
  const normalized = normalize(portable).split(sep).join("/");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("DESKTOP_APP_ICON must stay inside the repository root");
  }
  return normalized;
}

async function inspectPng(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("DESKTOP_APP_ICON must point to a PNG file");
  const bytes = await readFile(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("DESKTOP_APP_ICON must be a valid PNG file");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== height || width < 512) {
    throw new Error(`DESKTOP_APP_ICON must be square and at least 512 x 512, got ${width} x ${height}`);
  }
  return { width, height };
}

function normalizeRepository(value, name = "RUNTIME_REPOSITORY") {
  const repository = value.trim();
  if (/^(?:https?|ssh|git):\/\//u.test(repository)) {
    const url = new URL(repository);
    if (url.username || url.password) throw new Error(`${name} must not contain embedded credentials`);
    return repository;
  }
  if (/^[\w.-]+@[\w.-]+:.+/u.test(repository)) return repository;
  throw new Error(`${name} must be an HTTP(S), SSH, or Git repository URL`);
}

function normalizeRuntimeUpdateManifestUrl(value) {
  if (!value) return "";
  const url = new URL(value);
  if (!["https:", "http:", "file:"].includes(url.protocol)) {
    throw new Error("RUNTIME_UPDATE_MANIFEST_URL must use HTTPS, HTTP, or file");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("RUNTIME_UPDATE_MANIFEST_URL must not contain credentials, a query, or a fragment");
  }
  return url.toString();
}

function validateRuntimeUpdatePublicKey(value) {
  if (!value) return;
  let decoded;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new Error("RUNTIME_UPDATE_PUBLIC_KEY must be base64 encoded");
  }
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error("RUNTIME_UPDATE_PUBLIC_KEY must encode exactly 32 Ed25519 public-key bytes");
  }
}

export function normalizePublicRepository(value) {
  let publicUrl = value.trim().replace(/^git\+/u, "");
  const scpMatch = /^[^@/\s]+@([^:]+):(.+)$/u.exec(publicUrl);
  if (scpMatch) publicUrl = `https://${scpMatch[1]}/${scpMatch[2]}`;
  if (publicUrl.startsWith("ssh://")) {
    const url = new URL(publicUrl);
    if (url.password) throw new Error("DESKTOP_APP_REPOSITORY must not contain embedded credentials");
    publicUrl = `https://${url.hostname}${url.pathname}`;
  }
  const url = new URL(publicUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("DESKTOP_APP_REPOSITORY must resolve to a public HTTP(S) URL");
  }
  if (url.username || url.password) throw new Error("DESKTOP_APP_REPOSITORY must not contain embedded credentials");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\.git\/?$/u, "").replace(/\/$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function resolveGitHubRepository(environment) {
  if (environment.GITHUB_ACTIONS !== "true") return "";
  const server = environment.GITHUB_SERVER_URL?.trim();
  const repository = environment.GITHUB_REPOSITORY?.trim();
  if (!server || !repository) {
    throw new Error("GitHub Actions repository metadata is incomplete");
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must use owner/repository notation");
  }
  return normalizePublicRepository(`${server.replace(/\/$/u, "")}/${repository}`);
}

export async function resolveDesktopRepository(root, configured, environment = {}) {
  if (configured) return normalizePublicRepository(configured);
  const githubRepository = resolveGitHubRepository(environment);
  if (githubRepository) return githubRepository;
  const remote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (remote.status === 0 && remote.stdout.trim()) {
    try {
      return normalizePublicRepository(remote.stdout.trim());
    } catch {}
  }
  try {
    const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    if (repository) return normalizePublicRepository(repository);
  } catch {}
  return "https://github.com/deepseek-desktop/deepseek-desktop";
}

export function resolveBuildValues({ fileValues = {}, environment = {} } = {}) {
  assertKnownKeys(fileValues, ".env");
  assertKnownKeys(environment, "environment");
  const values = {};
  for (const key of CONFIG_KEYS) {
    if (Object.hasOwn(environment, key)) values[key] = environment[key];
    else if (Object.hasOwn(fileValues, key)) values[key] = fileValues[key];
    else values[key] = DEFAULT_CONFIG[key];
    if (typeof values[key] !== "string") throw new Error(`${key} must be a string`);
    if (!values[key].trim() && !OPTIONAL_EMPTY_KEYS.has(key)) throw new Error(`${key} must not be empty`);
    values[key] = values[key].trim();
  }
  return values;
}

export async function loadBuildConfig(root, { environment = process.env, envFile = resolve(root, ".env") } = {}) {
  let fileValues = {};
  try {
    fileValues = parseEnv(await readFile(envFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const values = resolveBuildValues({ fileValues, environment });
  assertText("DESKTOP_APP_NAME", values.DESKTOP_APP_NAME);
  assertText("DESKTOP_APP_DESCRIPTION", values.DESKTOP_APP_DESCRIPTION);
  if (!semverPattern.test(values.DESKTOP_APP_VERSION)) throw new Error("DESKTOP_APP_VERSION must be valid SemVer");
  if (!identifierPattern.test(values.DESKTOP_APP_IDENTIFIER)) {
    throw new Error("DESKTOP_APP_IDENTIFIER must use reverse-domain notation");
  }
  if (!slugPattern.test(values.DESKTOP_APP_SLUG)) {
    throw new Error("DESKTOP_APP_SLUG may contain only lowercase letters, digits, and single hyphens");
  }
  const authors = values.DESKTOP_APP_AUTHORS.split(",").map(value => value.trim()).filter(Boolean);
  if (authors.length === 0) throw new Error("DESKTOP_APP_AUTHORS must contain at least one author");
  authors.forEach(author => assertText("DESKTOP_APP_AUTHORS", author));
  const desktopRepository = await resolveDesktopRepository(root, values.DESKTOP_APP_REPOSITORY, environment);
  const iconSource = normalizeRelativePath(values.DESKTOP_APP_ICON);
  const icon = await inspectPng(resolve(root, iconSource));
  const repository = normalizeRepository(values.RUNTIME_REPOSITORY);
  const runtimeUpdateManifestUrl = normalizeRuntimeUpdateManifestUrl(values.RUNTIME_UPDATE_MANIFEST_URL);
  assertText("RUNTIME_UPDATE_PUBLISHER", values.RUNTIME_UPDATE_PUBLISHER);
  validateRuntimeUpdatePublicKey(values.RUNTIME_UPDATE_PUBLIC_KEY);
  if (!new Set(["stable", "preview"]).has(values.RUNTIME_UPDATE_CHANNEL)) {
    throw new Error("RUNTIME_UPDATE_CHANNEL must be stable or preview");
  }
  if (!new Set(["true", "false"]).has(values.RUNTIME_AUTO_UPDATE)) {
    throw new Error("RUNTIME_AUTO_UPDATE must be true or false");
  }
  if (Boolean(runtimeUpdateManifestUrl) !== Boolean(values.RUNTIME_UPDATE_PUBLIC_KEY)) {
    throw new Error("RUNTIME_UPDATE_MANIFEST_URL and RUNTIME_UPDATE_PUBLIC_KEY must be configured together");
  }
  if (!new Set(["local", "community", "stable"]).has(values.RELEASE_CHANNEL)) {
    throw new Error("RELEASE_CHANNEL must be local, community, or stable");
  }
  if (!new Set(["true", "false"]).has(values.RELEASE_SIGNED)) {
    throw new Error("RELEASE_SIGNED must be true or false");
  }
  const toolchainLock = JSON.parse(await readFile(resolve(root, "runtime/toolchain-lock.json"), "utf8"));
  assertText("runtime/toolchain-lock.json node.version", toolchainLock.node?.version || "");
  assertText("runtime/toolchain-lock.json toolchain.rust", toolchainLock.toolchain?.rust || "");
  const year = new Date().getUTCFullYear();
  const displayVersion = formatDisplayVersion(values.DESKTOP_APP_VERSION);
  return Object.freeze({
    schemaVersion: 3,
    productName: values.DESKTOP_APP_NAME,
    version: values.DESKTOP_APP_VERSION,
    displayVersion,
    windowTitle: `${values.DESKTOP_APP_NAME} ${displayVersion}`,
    identifier: values.DESKTOP_APP_IDENTIFIER,
    slug: values.DESKTOP_APP_SLUG,
    description: values.DESKTOP_APP_DESCRIPTION,
    authors,
    repository: desktopRepository,
    copyright: `Copyright ${year} ${authors.join(", ")}`,
    iconSource,
    icon,
    harness: {
      repository,
      ref: values.RUNTIME_REF
    },
    runtimeUpdate: {
      manifestUrl: runtimeUpdateManifestUrl,
      channel: values.RUNTIME_UPDATE_CHANNEL,
      autoUpdate: values.RUNTIME_AUTO_UPDATE === "true" && !values.RUNTIME_REF,
      publisher: values.RUNTIME_UPDATE_PUBLISHER,
      publicKey: values.RUNTIME_UPDATE_PUBLIC_KEY,
      desktopProtocolVersion: 1,
      runtimeProtocolVersion: 1,
      credentialProtocolVersion: 1
    },
    release: {
      channel: values.RELEASE_CHANNEL,
      signed: values.RELEASE_SIGNED === "true"
    },
    toolchain: {
      nodeVersion: toolchainLock.node.version,
      rustVersion: toolchainLock.toolchain.rust
    }
  });
}
