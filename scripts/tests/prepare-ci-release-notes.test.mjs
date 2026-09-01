import assert from "node:assert/strict";
import { test } from "node:test";

import {
  communityReleaseAssetNames,
  prepareCommunityReleaseNotes
} from "../prepare-ci-release-notes.mjs";

test("community release notes expose direct links for every public asset", () => {
  const notes = prepareCommunityReleaseNotes({
    template: "# Community\n\n<!-- release-downloads -->\n\nDetails\n",
    repository: "example/desktop",
    tag: "v1.2.3",
    assetNames: communityReleaseAssetNames("1.2.3")
  });

  assert.doesNotMatch(notes, /release-downloads/u);
  assert.match(notes, /## 直接下载 \/ Direct downloads/u);
  for (const name of communityReleaseAssetNames("1.2.3")) {
    assert.match(notes, new RegExp(`releases/download/v1\\.2\\.3/${name.replaceAll(".", "\\.")}`, "u"));
  }
});

test("community release notes reject incomplete or ambiguous inputs", () => {
  assert.throws(() => prepareCommunityReleaseNotes({
    template: "<!-- release-downloads -->",
    repository: "example/desktop",
    tag: "v1.2.3",
    assetNames: communityReleaseAssetNames("1.2.3").slice(1)
  }), /complete public asset set/u);
  assert.throws(() => prepareCommunityReleaseNotes({
    template: "missing marker",
    repository: "example/desktop",
    tag: "v1.2.3",
    assetNames: communityReleaseAssetNames("1.2.3")
  }), /one download marker/u);
});
