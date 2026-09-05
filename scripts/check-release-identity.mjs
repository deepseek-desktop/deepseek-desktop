import { resolve } from "node:path";
import { releaseIdentity, githubReleaseRemote } from "./lib/release-identity.mjs";
import { parseReleaseTag } from "./lib/release-tag.mjs";

const tag = process.env.GITHUB_REF_NAME;
const result = releaseIdentity({
  root: resolve(import.meta.dirname, ".."), tag,
  version: process.env.DESKTOP_APP_VERSION || parseReleaseTag(tag).version,
  commit: process.env.GITHUB_SHA,
  expectedObject: process.env.RELEASE_TAG_OBJECT,
  remote: githubReleaseRemote(process.env.GITHUB_REPOSITORY)
});
console.log(`tag-object=${result.object}`);
console.log(`commit=${result.commit}`);
