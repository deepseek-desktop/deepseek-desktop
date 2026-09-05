import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseIdentity } from "../lib/release-identity.mjs";

test("release identity rejects lightweight, moved, mismatched and replaced annotated tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-identity-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    git("tag", "v1.0.0");
    const input = { root, tag: "v1.0.0", version: "1.0.0", remote: root, commit: git("rev-parse", "HEAD") };
    assert.throws(() => releaseIdentity(input), /annotated/u);
    git("tag", "-d", "v1.0.0");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "tag", "-a", "v1.0.0", "-m", "release");
    const identity = releaseIdentity(input);
    assert.equal(identity.commit, input.commit);
    assert.throws(() => releaseIdentity({ ...input, version: "1.0.1" }), /version mismatch/u);
    assert.throws(() => releaseIdentity({ ...input, commit: "0".repeat(40) }), /commit mismatch/u);
    git("tag", "-d", "v1.0.0");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "tag", "-a", "v1.0.0", "-m", "changed");
    assert.throws(() => releaseIdentity({ ...input, expectedObject: identity.object }), /object changed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
