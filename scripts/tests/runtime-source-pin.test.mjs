import assert from "node:assert/strict";
import test from "node:test";

import { assertPinnedRuntimeSource } from "../lib/runtime-source-pin.mjs";

const pin = {
  repository: "https://github.com/deepseek-desktop/deepseek-harness.git",
  ref: "dsh-v0.1.2-alpha.1",
  commit: "cd5ef8148158c3a752a658978873241fdf8e2bbc"
};

test("accepts the pinned Runtime repository and commit", () => {
  assert.doesNotThrow(() => assertPinnedRuntimeSource({
    repository: "https://github.com/deepseek-desktop/deepseek-harness",
    commit: pin.commit
  }, pin));
});

test("rejects release Runtime source drift", () => {
  assert.throws(() => assertPinnedRuntimeSource({
    repository: "https://github.com/example/deepseek-harness.git",
    commit: pin.commit
  }, pin), /repository does not match source pin/u);
  assert.throws(() => assertPinnedRuntimeSource({
    repository: pin.repository,
    commit: "a".repeat(40)
  }, pin), /commit does not match source pin/u);
});

test("rejects an invalid committed source pin", () => {
  assert.throws(() => assertPinnedRuntimeSource({
    repository: pin.repository,
    commit: pin.commit
  }, { ...pin, commit: "latest" }), /immutable runtimeSource pin/u);
});

test("the cached Runtime checkout is cloned without hardlinks", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../runtime-sync.mjs", import.meta.url), "utf8");
  // Hardlinking .git/objects from the local mirror races the mirror's own
  // commit-graph maintenance and aborts the clone on any platform.
  assert.match(source, /"clone",\s*"--no-hardlinks",\s*"--no-checkout"/u);
});
