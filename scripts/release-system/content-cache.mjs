import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { sha256File } from "./common.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function contentCacheKey(input) {
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

async function runBounded(items, concurrency, operation) {
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
}

async function writableEntries(root) {
  const output = [];
  let pending = [root];
  while (pending.length > 0) {
    const next = [];
    await runBounded(pending, 32, async current => {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`release working tree cannot contain symbolic links: ${relative(root, current).replaceAll("\\", "/")}`);
      output.push({ path: current, mode: info.mode });
      if (!info.isDirectory()) return;
      for (const entry of await readdir(current)) next.push(join(current, entry));
    });
    pending = next;
  }
  return output;
}

export async function makeContentTreeWritable(root) {
  const entries = await writableEntries(root);
  await runBounded(entries, 32, entry => chmod(entry.path, entry.mode | 0o200));
}

export async function collectContentFiles(root, current = root, output = [], ignored = new Set(["cache-manifest.json"])) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const portablePath = relative(root, path).replaceAll("\\", "/");
    if (ignored.has(portablePath)) continue;
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`release cache cannot contain symbolic links: ${portablePath}`);
    if (info.isDirectory()) await collectContentFiles(root, path, output, ignored);
    else if (info.isFile()) output.push({ path: portablePath, size: info.size, sha256: await sha256File(path) });
    else throw new Error(`release cache contains an unsupported entry: ${portablePath}`);
  }
  return output;
}

export async function createContentCacheManifest(directory, identity) {
  const files = await collectContentFiles(directory);
  return {
    schemaVersion: 1,
    identity: canonical(identity),
    files,
    treeSha256: contentCacheKey(files)
  };
}

export async function verifyContentCache(directory, expectedIdentity) {
  const manifestPath = join(directory, "cache-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error("unsupported release cache manifest");
  if (JSON.stringify(manifest.identity) !== JSON.stringify(canonical(expectedIdentity))) {
    throw new Error("release cache identity does not match the requested build");
  }
  const files = await collectContentFiles(directory);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error("release cache file manifest does not match its contents");
  if (manifest.treeSha256 !== contentCacheKey(files)) throw new Error("release cache tree hash is invalid");
  await stat(manifestPath);
  return manifest;
}
