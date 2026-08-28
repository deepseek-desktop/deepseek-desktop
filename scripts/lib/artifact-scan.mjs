import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SCANNER_VERSION = 2;
const CARRY_BYTES = 2048;
const secretPatterns = [
  { pattern: /\bsk-(?!example|test|placeholder)[A-Za-z0-9._-]{20,}\b/iu, label: "API key" },
  { pattern: /\bAKIA(?!IOSFODNN7EXAMPLE\b)[0-9A-Z]{16}\b/u, label: "AWS access key" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u, label: "GitHub token" },
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{32,}/u,
    label: "private key"
  }
];

function isInside(root, path) {
  const offset = relative(root, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

async function filesUnderPath(path, root, visitedDirectories) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const link = await readlink(path);
    if (isAbsolute(link)) throw new Error(`${path} contains an absolute symbolic link`);
    const target = await realpath(path);
    if (!isInside(root, target)) throw new Error(`${path} contains a symbolic link escaping the scan root`);
    return filesUnderPath(target, root, visitedDirectories);
  }
  if (info.isFile()) return [await realpath(path)];
  if (!info.isDirectory()) return [];
  const directory = await realpath(path);
  if (!isInside(root, directory)) throw new Error(`${path} escapes the scan root`);
  if (visitedDirectories.has(directory)) return [];
  visitedDirectories.add(directory);
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnderPath(child, root, visitedDirectories));
    else if (entry.isFile()) files.push(await realpath(child));
    else if (entry.isSymbolicLink()) files.push(...await filesUnderPath(child, root, visitedDirectories));
  }
  return files;
}

async function filesUnder(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${path} cannot be a symbolic-link scan root`);
  const root = await realpath(info.isDirectory() ? path : dirname(path));
  return filesUnderPath(path, root, new Set());
}

function normalizedRoots(values) {
  return [...new Set(values.filter(Boolean).map(value => resolve(value).replaceAll("\\", "/")))]
    .sort((left, right) => right.length - left.length);
}

function scanText(path, text, roots) {
  const normalized = text.replaceAll("\\", "/");
  for (const root of roots) {
    if (normalized.includes(root)) throw new Error(`${path} contains forbidden local path`);
  }
  for (const secret of secretPatterns) {
    if (secret.pattern.test(text)) throw new Error(`${path} contains forbidden ${secret.label}`);
  }
}

async function scanFile(path, roots) {
  if (/^\.env(?:\.|$)/u.test(basename(path))) {
    throw new Error(`${path} contains an environment file`);
  }
  let bytes = 0;
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    const window = Buffer.concat([carry, chunk]);
    scanText(path, window.toString("latin1"), roots);
    for (const offset of [0, 1]) {
      const length = window.length - offset - ((window.length - offset) % 2);
      if (length >= 2) scanText(path, window.subarray(offset, offset + length).toString("utf16le"), roots);
    }
    carry = window.subarray(Math.max(0, window.length - CARRY_BYTES));
  }
  return bytes;
}

export async function scanArtifactPaths(paths, { forbiddenRoots = [] } = {}) {
  const roots = normalizedRoots(forbiddenRoots);
  const files = [];
  for (const path of paths) files.push(...await filesUnder(path));
  const uniqueFiles = [...new Set(files.map(path => resolve(path)))].sort();
  let byteCount = 0;
  for (const file of uniqueFiles) byteCount += await scanFile(file, roots);
  return {
    schemaVersion: 1,
    scannerVersion: SCANNER_VERSION,
    fileCount: uniqueFiles.length,
    byteCount
  };
}
