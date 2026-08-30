import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import { isPrereleaseVersion } from "./lib/release-tag.mjs";

const root = resolve(import.meta.dirname, "..");

/**
 * A GitHub release that is not marked prerelease becomes "Latest": the default
 * download and what `/releases/latest` returns. That has to track assurance, not
 * version shape — an unsigned artifact warns on Gatekeeper and SmartScreen, and
 * the release gate already refuses to let a community build claim a signature.
 * Signing the release is what promotes it, not dropping a prerelease segment.
 */
export function releaseIsPrerelease(config) {
  if (typeof config?.version !== "string") throw new Error("release version is missing");
  if (config?.release?.signed !== true) return true;
  return isPrereleaseVersion(config.version);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const config = JSON.parse(await readFile(join(root, "target/generated/app-config.json"), "utf8"));
  process.stdout.write(`${String(releaseIsPrerelease(config))}\n`);
}
