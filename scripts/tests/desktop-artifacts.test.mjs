import assert from "node:assert/strict";
import { test } from "node:test";

import { desktopArtifactName } from "../lib/desktop-artifacts.mjs";

const input = { productName: "DeepSeek Desktop", version: "0.1.6.1" };

test("uses the four-part public version in every installer name", () => {
  assert.equal(desktopArtifactName({ ...input, target: "aarch64-apple-darwin", extension: ".dmg" }), "DeepSeek Desktop_0.1.6.1_aarch64.dmg");
  assert.equal(desktopArtifactName({ ...input, target: "x86_64-apple-darwin", extension: ".dmg" }), "DeepSeek Desktop_0.1.6.1_x64.dmg");
  assert.equal(desktopArtifactName({ ...input, target: "x86_64-pc-windows-msvc", extension: ".exe" }), "DeepSeek Desktop_0.1.6.1_x64-setup.exe");
  assert.equal(desktopArtifactName({ ...input, target: "x86_64-unknown-linux-gnu", extension: ".AppImage" }), "DeepSeek Desktop_0.1.6.1_amd64.AppImage");
  assert.equal(desktopArtifactName({ ...input, target: "x86_64-unknown-linux-gnu", extension: ".deb" }), "DeepSeek Desktop_0.1.6.1_amd64.deb");
});

test("rejects unknown target and extension pairs", () => {
  assert.throws(() => desktopArtifactName({ ...input, target: "x86_64-unknown-linux-gnu", extension: ".rpm" }), /unsupported/u);
  assert.throws(() => desktopArtifactName({ ...input, target: "unknown", extension: ".dmg" }), /unsupported/u);
});
