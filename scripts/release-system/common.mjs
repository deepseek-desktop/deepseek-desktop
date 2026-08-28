import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";

const targetsPath = new URL("./targets.json", import.meta.url);
const sourceRepositoryPattern = /^(?:https?|ssh|git):\/\/|^[\w.-]+@[\w.-]+:.+/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const nodeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;

export async function loadTargets() {
  const document = JSON.parse(await readFile(targetsPath, "utf8"));
  if (document.schemaVersion !== 1 || !Array.isArray(document.targets)) {
    throw new Error("unsupported release target configuration");
  }
  const byId = new Map();
  for (const target of document.targets) {
    if (!target.id || byId.has(target.id)) throw new Error(`duplicate or empty release target ${String(target.id)}`);
    if (!Array.isArray(target.installerExtensions) || target.installerExtensions.length === 0) {
      throw new Error(`release target ${target.id} must declare installer extensions`);
    }
    byId.set(target.id, Object.freeze({ ...target }));
  }
  return Object.freeze({ targets: Object.freeze([...byId.values()]), byId });
}

export async function detectHostTarget(platform = process.platform, architecture = process.arch) {
  const { targets } = await loadTargets();
  const target = targets.find(candidate => candidate.platform === platform && candidate.architecture === architecture);
  if (!target) throw new Error(`unsupported release worker host ${platform}-${architecture}`);
  return target;
}

export function parseArguments(argv) {
  const options = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const separator = value.indexOf("=");
    const name = value.slice(2, separator === -1 ? undefined : separator);
    let optionValue = separator === -1 ? undefined : value.slice(separator + 1);
    if (optionValue === undefined && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      optionValue = argv[index + 1];
      index += 1;
    }
    const values = options.get(name) || [];
    values.push(optionValue ?? "true");
    options.set(name, values);
  }
  return { options, positionals };
}

export function option(parsed, name, fallback = "") {
  const values = parsed.options.get(name);
  return values?.at(-1) ?? fallback;
}

export function options(parsed, name) {
  return parsed.options.get(name) || [];
}

export function flag(parsed, name) {
  return option(parsed, name, "false") === "true";
}

export function requireOption(parsed, name) {
  const value = option(parsed, name).trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export function assertSourceRepository(repository) {
  const value = repository.trim();
  if (!sourceRepositoryPattern.test(value)) {
    throw new Error("source repository must be a credential-free HTTP(S), SSH, or Git URL");
  }
  if (/^(?:https?|ssh|git):\/\//u.test(value)) {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && (url.username || url.password)) {
      throw new Error("source repository must not contain embedded HTTP credentials");
    }
    if (url.password) throw new Error("source repository must not contain an embedded password");
  }
  return value;
}

export function assertCommit(commit, label = "commit") {
  const value = commit.trim().toLowerCase();
  if (!commitPattern.test(value)) throw new Error(`${label} must be a full 40-character Git commit`);
  return value;
}

export function assertNodeId(nodeId) {
  const value = nodeId.trim();
  if (!nodeIdPattern.test(value)) {
    throw new Error("node id must contain 3-128 letters, digits, dots, underscores, or hyphens");
  }
  return value;
}

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function atomicWriteJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function safeArtifactName(value) {
  const name = basename(value);
  if (name !== value || !name || name === "." || name === ".." || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("invalid artifact name");
  }
  return name;
}

export function resolveInside(root, ...segments) {
  const base = resolve(root);
  const path = resolve(base, ...segments);
  if (path !== base && !path.startsWith(`${base}/`) && !path.startsWith(`${base}\\`)) {
    throw new Error("path escapes release data root");
  }
  return path;
}

export function publicRelease(release) {
  return JSON.parse(JSON.stringify(release, (key, value) => (
    key === "ticketDigest" || key === "leaseDigest" ? undefined : value
  )));
}

export function redactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:sk|api)[-_][A-Za-z0-9._-]{12,}/giu, "[REDACTED]")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]");
}
