import assert from "node:assert/strict";
import { test } from "node:test";

import { parseReleaseTag, releaseTagsForVersion } from "../lib/release-tag.mjs";

test("accepts release tags with or without a v prefix", () => {
  assert.deepEqual(parseReleaseTag("1.0.0"), { tag: "1.0.0", version: "1.0.0" });
  assert.deepEqual(parseReleaseTag("v1.0.0"), { tag: "v1.0.0", version: "1.0.0" });
  assert.deepEqual(parseReleaseTag("v0.1.0-community.13"), {
    tag: "v0.1.0-community.13",
    version: "0.1.0-community.13"
  });
});

test("preserves SemVer prerelease and build metadata", () => {
  assert.equal(parseReleaseTag("1.2.3-rc.1+build.7").version, "1.2.3-rc.1+build.7");
});

test("rejects non-SemVer release tags", () => {
  for (const tag of ["", "release-1.0.0", "v1.0", "V1.0.0", "v01.0.0", "v1.0.0-01"]) {
    assert.throws(() => parseReleaseTag(tag), /unsupported release tag/u);
  }
});

test("returns both accepted tag forms for a version", () => {
  assert.deepEqual(releaseTagsForVersion("1.0.0"), ["1.0.0", "v1.0.0"]);
  assert.deepEqual(releaseTagsForVersion("0.1.0-community.13"), [
    "0.1.0-community.13",
    "v0.1.0-community.13"
  ]);
});
