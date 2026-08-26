import assert from "node:assert/strict";
import { test } from "node:test";

import { selectLatestHarnessTag } from "../lib/harness-ref.mjs";

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
