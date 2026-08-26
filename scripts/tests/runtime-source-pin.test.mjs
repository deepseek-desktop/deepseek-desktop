import assert from "node:assert/strict";
import test from "node:test";

import { assertPinnedRuntimeSource } from "../lib/runtime-source-pin.mjs";

const pin = {
  repository: "https://github.com/deepseek-desktop/deepseek-harness.git",
  ref: "dsh-v0.1.1-rc.2",
  commit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e"
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
