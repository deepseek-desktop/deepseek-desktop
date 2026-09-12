import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { applyPackagePatch } from "../lib/package-patch.mjs";

const root = resolve(import.meta.dirname, "../..");
const temporaryRoot = join(root, "target");

function withAmbientAutoCrlf(value, callback) {
  const keys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
  process.env.GIT_CONFIG_VALUE_0 = value;
  try {
    return callback();
  } finally {
    for (const [key, original] of previous) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

async function temporaryDirectory(prefix) {
  await mkdir(temporaryRoot, { recursive: true });
  return mkdtemp(join(temporaryRoot, prefix));
}

test("applies package-relative patches inside a parent Git worktree", async () => {
  const directory = await temporaryDirectory("package-patch-test-");
  const packageRoot = join(directory, "node_modules", "example-package");
  const sourceFile = join(packageRoot, "lib", "client.js");
  const patchFile = join(directory, "client.patch");
  await mkdir(join(packageRoot, "lib"), { recursive: true });
  await writeFile(sourceFile, 'const message = "before";\r\n');
  await writeFile(patchFile, [
    "diff --git a/lib/client.js b/lib/client.js",
    "index ea0a2cc..63b9130 100644",
    "--- a/lib/client.js",
    "+++ b/lib/client.js",
    "@@ -1 +1 @@",
    '-const message = "before";',
    '+const message = "after";',
    ""
  ].join("\n"));

  try {
    assert.equal(
      withAmbientAutoCrlf("true", () => applyPackagePatch(packageRoot, patchFile)),
      "applied"
    );
    const patchedSource = await readFile(sourceFile, "utf8");
    assert.equal(patchedSource, 'const message = "after";\n');
    assert.equal(applyPackagePatch(packageRoot, patchFile), "already-applied");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
