import { appendFile } from "node:fs/promises";
import process from "node:process";
import { parseReleaseTag } from "./lib/release-tag.mjs";

if (process.env.GITHUB_REF_TYPE !== "tag") {
  console.log("using the default application version");
  process.exit(0);
}

const { version } = parseReleaseTag(process.env.GITHUB_REF_NAME);
if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required for a tagged release");

// The prerelease decision also depends on whether the artifacts are signed, which
// is only known once app:sync has generated the configuration, so it lives in
// scripts/ci-release-prerelease.mjs rather than in this environment export.
await appendFile(process.env.GITHUB_ENV, `DESKTOP_APP_VERSION=${version}\n`);
console.log(`using release version ${version}`);
