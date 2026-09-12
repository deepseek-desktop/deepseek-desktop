import { appendFile, readFile } from "node:fs/promises";
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
const { harnessSource } = JSON.parse(await readFile(new URL("../harness/toolchain-lock.json", import.meta.url), "utf8"));
if (!/^[0-9a-f]{40}$/u.test(harnessSource?.commit || "")
  || !/^https:\/\/[^\s]+$/u.test(harnessSource?.repository || "")
  || typeof harnessSource?.ref !== "string" || !harnessSource.ref
  || /[\s\u0000-\u001f\u007f]/u.test(harnessSource.ref)) {
  throw new Error("release Harness source must declare an HTTPS repository, ref and immutable commit");
}
await appendFile(process.env.GITHUB_ENV, [
  `DESKTOP_APP_VERSION=${version}`,
  `HARNESS_REPOSITORY=${harnessSource.repository}`,
  `HARNESS_REF=${harnessSource.ref}`,
  ""
].join("\n"));
console.log(`using release version ${version}`);
