import { parseEnv } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, normalize, resolve, sep } from "node:path";

export const CONFIG_KEYS = Object.freeze([
  "DESKTOP_APP_NAME",
  "DESKTOP_APP_VERSION",
  "DESKTOP_APP_IDENTIFIER",
  "DESKTOP_APP_SLUG",
  "DESKTOP_APP_DESCRIPTION",
  "DESKTOP_APP_AUTHORS",
  "DESKTOP_APP_ICON",
  "HARNESS_REPOSITORY",
  "HARNESS_REF"
]);

export const DEFAULT_CONFIG = Object.freeze({
  DESKTOP_APP_NAME: "DeepSeek Desktop",
  DESKTOP_APP_VERSION: "1.0.0",
  DESKTOP_APP_IDENTIFIER: "deepseek.desktop",
  DESKTOP_APP_SLUG: "deepseek-desktop",
  DESKTOP_APP_DESCRIPTION: "Local AI agent workspace",
  DESKTOP_APP_AUTHORS: "DeepSeek Desktop Contributors",
  DESKTOP_APP_ICON: "src-tauri/icons/icon.png",
  HARNESS_REPOSITORY: "https://github.com/deepseek-desktop/deepseek-harness.git",
  HARNESS_REF: "dsh-v0.1.1-rc.2"
});

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const identifierPattern = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/u;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function assertKnownKeys(values, source) {
  const unknown = Object.keys(values)
    .filter(key => (key.startsWith("DESKTOP_APP_") || key.startsWith("HARNESS_")) && !CONFIG_KEYS.includes(key))
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

function normalizeRepository(value) {
  const repository = value.trim();
  if (/^(?:https?|ssh|git):\/\//u.test(repository)) {
    const url = new URL(repository);
    if (url.username || url.password) throw new Error("HARNESS_REPOSITORY must not contain embedded credentials");
    return repository;
  }
  if (/^[\w.-]+@[\w.-]+:.+/u.test(repository)) return repository;
  throw new Error("HARNESS_REPOSITORY must be an HTTP(S), SSH, or Git repository URL");
}

export function resolveBuildValues({ fileValues = {}, environment = {} } = {}) {
  assertKnownKeys(fileValues, ".env");
  assertKnownKeys(environment, "environment");
  const values = {};
  for (const key of CONFIG_KEYS) {
    if (Object.hasOwn(environment, key)) values[key] = environment[key];
    else if (Object.hasOwn(fileValues, key)) values[key] = fileValues[key];
    else values[key] = DEFAULT_CONFIG[key];
    if (typeof values[key] !== "string" || !values[key].trim()) throw new Error(`${key} must not be empty`);
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
  const iconSource = normalizeRelativePath(values.DESKTOP_APP_ICON);
  const icon = await inspectPng(resolve(root, iconSource));
  const repository = normalizeRepository(values.HARNESS_REPOSITORY);
  assertText("HARNESS_REF", values.HARNESS_REF);
  const year = new Date().getUTCFullYear();
  return Object.freeze({
    schemaVersion: 1,
    productName: values.DESKTOP_APP_NAME,
    version: values.DESKTOP_APP_VERSION,
    identifier: values.DESKTOP_APP_IDENTIFIER,
    slug: values.DESKTOP_APP_SLUG,
    description: values.DESKTOP_APP_DESCRIPTION,
    authors,
    copyright: `Copyright ${year} ${authors.join(", ")}`,
    iconSource,
    icon,
    harness: {
      repository,
      ref: values.HARNESS_REF
    }
  });
}
