import assert from "node:assert/strict";
import test from "node:test";
import { assertPinnedHarnessSource } from "../lib/harness-source-pin.mjs";
import { selectLatestHarnessTag } from "../lib/harness-ref.mjs";
import { cleanCachedCheckout } from "../lib/cached-checkout-clean.mjs";

const pin = {
  repository: "https://github.com/deepseek-desktop/deepseek-harness.git",
  ref: "ddefc45fbc7f8e46dd73185e68295696d1297887",
  commit: "ddefc45fbc7f8e46dd73185e68295696d1297887"
};

test("accepts the pinned Harness repository and commit", () => {
  assert.doesNotThrow(() => assertPinnedHarnessSource({
    repository: "https://github.com/deepseek-desktop/deepseek-harness",
    commit: pin.commit
  }, pin));
});

test("rejects release Harness source drift", () => {
  assert.throws(() => assertPinnedHarnessSource({
    repository: "https://github.com/example/deepseek-harness.git",
    commit: pin.commit
  }, pin), /repository does not match source pin/u);
  assert.throws(() => assertPinnedHarnessSource({
    repository: pin.repository,
    commit: "a".repeat(40)
  }, pin), /commit does not match source pin/u);
});

test("rejects an invalid committed source pin", () => {
  assert.throws(() => assertPinnedHarnessSource({
    repository: pin.repository,
    commit: pin.commit
  }, { ...pin, commit: "latest" }), /immutable harnessSource pin/u);
});


test("desktop patches never embed a build-machine path", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  // The Harness build writes its own source directory into `#region` comments, so a
  // patch generated with wide context can capture the authoring machine's absolute
  // path as context. It then applies locally and fails on every other machine — the
  // CI runner builds under a different root. Keep patch context free of them.
  // fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..." and
  // joining it produces "C:\\C:\\...", which fails only on that platform.
  const directory = fileURLToPath(new URL("../../harness/patches/", import.meta.url));
  const files = (await readdir(directory)).filter(name => name.endsWith(".patch"));
  assert.ok(files.length > 0, "expected at least one desktop patch");
  // Match anywhere in the line: the offending path sits behind a "\0dsh-css:" prefix,
  // so anchoring on a leading delimiter misses it.
  const machinePath = /\/Users\/|\/home\/|\/__w\/|\/root\/|[A-Za-z]:\\\\/u;
  for (const file of files) {
    const patch = await readFile(join(directory, file), "utf8");
    const offending = patch
      .split("\n")
      .filter(line => machinePath.test(line))
      .slice(0, 3);
    assert.deepEqual(offending, [], `${file} embeds a build-machine path`);
  }
});


test("selects the newest Harness SemVer tag", () => {
  assert.equal(selectLatestHarnessTag([
    "dsh-v0.1.0-rc.8",
    "dsh-v0.1.1-rc.2",
    "dsh-v0.1.1-rc.10",
    "feature-preview"
  ]), "dsh-v0.1.1-rc.10");
});

test("prefers a stable release over a prerelease with the same version", () => {
  assert.equal(selectLatestHarnessTag(["v1.0.0-rc.2", "v1.0.0"]), "v1.0.0");
});

test("rejects repositories without a version tag", () => {
  assert.throws(() => selectLatestHarnessTag(["main", "nightly"]), /no SemVer release tags/u);
});


test("retries a transient cached checkout cleanup failure", async () => {
  let cleanAttempts = 0;
  let recreateAttempts = 0;
  const warnings = [];

  const result = await cleanCachedCheckout({
    clean: async () => {
      cleanAttempts += 1;
      if (cleanAttempts === 1) throw new Error("Directory not empty");
    },
    recreate: async () => { recreateAttempts += 1; },
    warn: message => warnings.push(message)
  });

  assert.deepEqual(result, { recreated: false, attempts: 2 });
  assert.equal(recreateAttempts, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Directory not empty/u);
});

test("recreates an immutable checkout after repeated cleanup failures", async () => {
  let cleanAttempts = 0;
  let recreateAttempts = 0;
  const warnings = [];

  const result = await cleanCachedCheckout({
    clean: async () => {
      cleanAttempts += 1;
      throw new Error(`cleanup failure ${cleanAttempts}`);
    },
    recreate: async () => { recreateAttempts += 1; },
    warn: message => warnings.push(message)
  });

  assert.deepEqual(result, { recreated: true, attempts: 2 });
  assert.equal(recreateAttempts, 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /recreating the immutable checkout/u);
});

test("rejects an invalid retry count before cleanup", async () => {
  await assert.rejects(
    cleanCachedCheckout({ clean: async () => {}, recreate: async () => {}, retries: -1 }),
    /non-negative integer/u
  );
});
