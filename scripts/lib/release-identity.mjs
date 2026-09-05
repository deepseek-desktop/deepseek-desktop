import { execFileSync } from "node:child_process";
import { parseReleaseTag } from "./release-tag.mjs";

export function releaseIdentity({ root, tag, version, commit, expectedObject, remote }) {
  if (parseReleaseTag(tag).version !== version) throw new Error("release tag/version mismatch");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 }).trim();
  const ref = `refs/tags/${tag}`;
  if (git("cat-file", "-t", ref) !== "tag") throw new Error("release requires an annotated tag");
  const object = git("rev-parse", ref);
  const target = git("rev-parse", `${ref}^{commit}`);
  if (target !== git("rev-parse", "HEAD") || (commit && target !== commit)) throw new Error("release tag/build commit mismatch");
  if (expectedObject && expectedObject !== object) throw new Error("release tag object changed during the build");
  if (remote) {
    const references = new Map(git("ls-remote", remote, ref, `${ref}^{}`).split("\n").filter(Boolean).map(line => {
      const [sha, name] = line.split(/\s+/u);
      return [name, sha];
    }));
    if (references.get(ref) !== object || references.get(`${ref}^{}`) !== target) {
      throw new Error("remote release tag changed or is not annotated");
    }
  }
  return { object, commit: target };
}

export function githubReleaseRemote(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository || "")) throw new Error("invalid GitHub release repository");
  return `https://github.com/${repository}.git`;
}
