import assert from "node:assert/strict";
import test from "node:test";

import { assertPinnedHarnessSource } from "../lib/harness-source-pin.mjs";

const pin = {
  repository: "https://github.com/deepseek-desktop/deepseek-harness.git",
  ref: "dsh-v0.1.3-alpha.1",
  commit: "d347e703908d0406b7a7ef80e3a0e594d86b2215"
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

test("the cached Harness checkout is cloned without hardlinks", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../harness-sync.mjs", import.meta.url), "utf8");
  // Hardlinking .git/objects from the local mirror races the mirror's own
  // commit-graph maintenance and aborts the clone on any platform.
  assert.match(source, /"clone",\s*"--no-hardlinks",\s*"--no-checkout"/u);
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
