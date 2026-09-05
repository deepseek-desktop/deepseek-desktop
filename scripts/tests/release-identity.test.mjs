import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("container checkout trust preserves annotated tag checks without trusting other repositories", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-container-"));
  const source = join(directory, "source");
  const checkout = join(directory, "checkout");
  const config = join(directory, "gitconfig");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    await mkdir(source);
    await mkdir(checkout);
    git(source, "init");
    git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "tag", "-a", "v1.0.0", "-m", "release");
    const object = git(source, "rev-parse", "refs/tags/v1.0.0");
    const commit = git(source, "rev-parse", "HEAD");
    git(checkout, "init");
    // Match checkout's explicit shallow tag fetch, including the annotated object.
    git(checkout, "fetch", "--no-tags", "--depth=1", pathToFileURL(source).href, "+refs/tags/v1.0.0:refs/tags/v1.0.0");
    git(checkout, "checkout", "--detach", "refs/tags/v1.0.0");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GITHUB_WORKSPACE: checkout };
    const execute = (file, args, cwd = checkout) => execFileSync(file, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    assert.throws(() => execute("git", ["cat-file", "-t", "refs/tags/v1.0.0"]), /dubious ownership/u);
    const workflow = await readFile(new URL("../../.github/workflows/community-build.yml", import.meta.url), "utf8");
    const shellJob = workflow.slice(workflow.indexOf("  shell-quality:"), workflow.indexOf("  native-build:"));
    const command = shellJob.match(/run: (git config --global --add safe\.directory "\$GITHUB_WORKSPACE")/u)?.[1];
    assert.ok(command, "container job must trust its exact checkout before release identity checks");
    assert.ok(shellJob.indexOf(command) < shellJob.indexOf("node scripts/check-release-identity.mjs"));
    execute("sh", ["-eu", "-c", command]);
    assert.equal(execute("git", ["config", "--global", "--get-all", "safe.directory"]), checkout);
    assert.throws(() => execute("git", ["status", "--porcelain"], source), /dubious ownership/u);
    const moduleUrl = new URL("../lib/release-identity.mjs", import.meta.url).href;
    const input = { root: checkout, tag: "v1.0.0", version: "1.0.0", commit, expectedObject: object };
    const script = value => `import { releaseIdentity } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(releaseIdentity(${JSON.stringify(value)})));`;
    assert.deepEqual(JSON.parse(execute(process.execPath, ["--input-type=module", "-e", script(input)])), { object, commit });
    // A local upload-pack inherits this test hook, unlike the actual GitHub server.
    delete env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    assert.deepEqual(JSON.parse(execute(process.execPath, ["--input-type=module", "-e", script({ ...input, remote: checkout })])), { object, commit });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
