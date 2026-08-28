import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

const SCANNER_VERSION = 1;
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

async function filesUnder(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${path} contains a symbolic link`);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else if (entry.isFile()) files.push(child);
    else if (entry.isSymbolicLink()) throw new Error(`${child} contains a symbolic link`);
  }
  return files;
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
