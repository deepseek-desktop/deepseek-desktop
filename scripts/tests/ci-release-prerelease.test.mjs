import assert from "node:assert/strict";
import { test } from "node:test";

import { releaseIsPrerelease } from "../ci-release-prerelease.mjs";

const signed = version => ({ version, release: { channel: "stable", signed: true } });
const community = version => ({ version, release: { channel: "community", signed: false } });

test("an unsigned build is a prerelease no matter how its version reads", () => {
  assert.equal(releaseIsPrerelease(community("1.0.16")), true);
  assert.equal(releaseIsPrerelease(community("2.0.0")), true);
  assert.equal(releaseIsPrerelease(community("1.0.0-rc.1")), true);
});

test("a signed build follows its SemVer prerelease segment", () => {
  assert.equal(releaseIsPrerelease(signed("1.0.16")), false);
  assert.equal(releaseIsPrerelease(signed("1.0.16+build.7")), false);
  assert.equal(releaseIsPrerelease(signed("1.0.0-rc.1")), true);
  assert.equal(releaseIsPrerelease(signed("0.1.0-community.16")), true);
});

test("a missing or non-boolean signature claim never promotes a release", () => {
  assert.equal(releaseIsPrerelease({ version: "1.0.16" }), true);
  assert.equal(releaseIsPrerelease({ version: "1.0.16", release: {} }), true);
  assert.equal(releaseIsPrerelease({ version: "1.0.16", release: { signed: "true" } }), true);
});

test("rejects configuration without a version", () => {
  assert.throws(() => releaseIsPrerelease({ release: { signed: true } }), /release version is missing/u);
});
