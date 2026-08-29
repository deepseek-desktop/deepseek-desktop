import { appendFile } from "node:fs/promises";
import process from "node:process";
import { isPrereleaseVersion, parseReleaseTag } from "./lib/release-tag.mjs";

if (process.env.GITHUB_REF_TYPE !== "tag") {
  console.log("using the default application version");
  process.exit(0);
}

const { version } = parseReleaseTag(process.env.GITHUB_REF_NAME);
if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required for a tagged release");

const prerelease = isPrereleaseVersion(version);
await appendFile(
  process.env.GITHUB_ENV,
  `DESKTOP_APP_VERSION=${version}\nDESKTOP_RELEASE_PRERELEASE=${String(prerelease)}\n`
);
console.log(`using release version ${version}`);
