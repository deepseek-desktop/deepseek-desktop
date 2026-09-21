import assert from "node:assert/strict";
import { test } from "node:test";

import {
  communityReleaseAssetNames,
  prepareCommunityReleaseNotes,
  unreleasedChanges
} from "../prepare-ci-release-notes.mjs";

test("community release notes expose direct links for every public asset", () => {
  const notes = prepareCommunityReleaseNotes({
    template: "# Community\n\n<!-- release-downloads -->\n\n<!-- release-changes -->\n",
    repository: "example/desktop",
    tag: "v0.1.6.1",
    assetNames: communityReleaseAssetNames("0.1.6.1"),
    changes: "- Current change"
  });

  assert.doesNotMatch(notes, /release-downloads/u);
  assert.doesNotMatch(notes, /release-changes/u);
  assert.match(notes, /## 直接下载 \/ Direct downloads/u);
  assert.match(notes, /## 主要变化\n\n- Current change/u);
  for (const name of communityReleaseAssetNames("0.1.6.1")) {
    assert.match(notes, new RegExp(`releases/download/v0\\.1\\.6\\.1/${name.replaceAll(".", "\\.")}`, "u"));
  }
});

test("community release notes reject incomplete or ambiguous inputs", () => {
  assert.throws(() => prepareCommunityReleaseNotes({
    template: "<!-- release-downloads -->\n<!-- release-changes -->",
    repository: "example/desktop",
    tag: "v0.1.6.1",
    assetNames: communityReleaseAssetNames("0.1.6.1").slice(1),
    changes: "- Current change"
  }), /complete public asset set/u);
  assert.throws(() => prepareCommunityReleaseNotes({
    template: "missing marker",
    repository: "example/desktop",
    tag: "v0.1.6.1",
    assetNames: communityReleaseAssetNames("0.1.6.1"),
    changes: "- Current change"
  }), /one download marker/u);
  assert.throws(() => prepareCommunityReleaseNotes({
    template: "<!-- release-downloads -->\n<!-- release-changes -->",
    repository: "example/desktop",
    tag: "v0.1.6.1",
    assetNames: communityReleaseAssetNames("0.1.6.1"),
    changes: ""
  }), /require release changes/u);
});

test("release notes take changes from the unreleased changelog section", () => {
  const changelog = "# Log\n\n## 未发布\n\n- First\n- Second\n\n## 1.0.0\n\n- Old\n";
  assert.equal(unreleasedChanges(changelog), "- First\n- Second");
  assert.throws(() => unreleasedChanges("# Log\n\n## 未发布\n\n## 1.0.0\n"), /non-empty unreleased changes/u);
});
