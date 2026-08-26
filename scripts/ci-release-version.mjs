import { appendFile } from "node:fs/promises";
import process from "node:process";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

if (process.env.GITHUB_REF_TYPE !== "tag") {
  console.log("using the default application version");
  process.exit(0);
}

const tag = process.env.GITHUB_REF_NAME?.trim();
const version = tag?.startsWith("v") ? tag.slice(1) : "";
if (!semverPattern.test(version)) throw new Error(`unsupported release tag: ${tag || "<empty>"}`);
if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required for a tagged release");

await appendFile(process.env.GITHUB_ENV, `DESKTOP_APP_VERSION=${version}\n`);
console.log(`using release version ${version}`);
