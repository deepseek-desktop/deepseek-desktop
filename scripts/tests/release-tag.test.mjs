import assert from "node:assert/strict";
import { test } from "node:test";

import { isPrereleaseVersion, parseDesktopVersion, parseReleaseTag, releaseTagsForVersion } from "../lib/release-tag.mjs";

test("accepts release tags with or without a v prefix", () => {
  assert.deepEqual(parseReleaseTag("0.1.6.1"), { tag: "0.1.6.1", version: "0.1.6.1" });
  assert.deepEqual(parseReleaseTag("v0.1.6.1"), { tag: "v0.1.6.1", version: "0.1.6.1" });
});

test("derives the Harness core and internal bundle SemVer", () => {
  assert.deepEqual(parseDesktopVersion("0.1.6.27"), {
    version: "0.1.6.27",
    coreVersion: "0.1.6",
    revision: 27,
    bundleVersion: "0.1.6+27"
  });
});

test("rejects tags outside the four numeric segment contract", () => {
  for (const tag of ["", "release-0.1.6.1", "v0.1.6", "V0.1.6.1", "v00.1.6.1", "v0.1.6.0", "v0.1.6-rc.1"]) {
    assert.throws(() => parseReleaseTag(tag), /unsupported release tag/u);
  }
});

test("returns both accepted tag forms for a version", () => {
  assert.deepEqual(releaseTagsForVersion("0.1.6.1"), ["0.1.6.1", "v0.1.6.1"]);
});

test("four-part release versions have no prerelease syntax", () => {
  assert.equal(isPrereleaseVersion("0.1.6.1"), false);
  assert.throws(() => isPrereleaseVersion("0.1.6-rc.1"), /unsupported release version/u);
});
