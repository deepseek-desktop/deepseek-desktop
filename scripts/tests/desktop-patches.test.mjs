import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyDesktopCompatibilityPatches } from "../lib/desktop-patches.mjs";

async function fixture(t, version = "1.2.3", source = 'const state = "before";\n') {
  const root = await mkdtemp(join(tmpdir(), "desktop-patches-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, "node_modules");
  const packageRoot = join(modules, "@example", "core");
  const patchRoot = join(root, "patches");
  await mkdir(join(packageRoot, "lib"), { recursive: true });
  await mkdir(patchRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@example/core", version }));
  await writeFile(join(packageRoot, "lib/index.js"), source);
  const patchBytes = Buffer.from([
    "diff --git a/lib/index.js b/lib/index.js",
    "--- a/lib/index.js",
    "+++ b/lib/index.js",
    "@@ -1 +1 @@",
    '-const state = "before";',
    '+const state = "after";',
    ""
  ].join("\n"));
  await writeFile(join(patchRoot, "core.patch"), patchBytes);
  const record = {
    packageName: "@example/core",
    version: "1.2.3",
    id: "state-after",
    file: "core.patch",
    sha256: createHash("sha256").update(patchBytes).digest("hex"),
    moduleFile: "lib/index.js",
    markers: ['const state = "after";']
  };
  return { modules, packageRoot, patchRoot, record };
}

test("applies an exact locked Desktop compatibility patch and verifies its marker", async t => {
  const { modules, packageRoot, patchRoot, record } = await fixture(t);
  assert.deepEqual(
    await applyDesktopCompatibilityPatches([modules], [record], patchRoot),
    ["@example/core:state-after:1"]
  );
  assert.equal(await readFile(join(packageRoot, "lib/index.js"), "utf8"), 'const state = "after";\n');
});

test("accepts a newer upstream package when it already satisfies the compatibility contract", async t => {
  const { modules, packageRoot, patchRoot, record } = await fixture(t, "2.0.0", 'const state = "after";\n');
  await applyDesktopCompatibilityPatches([modules], [record], patchRoot);
  assert.equal(await readFile(join(packageRoot, "lib/index.js"), "utf8"), 'const state = "after";\n');
});

test("rejects an unpatched package version outside the exact compatibility patch gate", async t => {
  const { modules, patchRoot, record } = await fixture(t, "2.0.0");
  await assert.rejects(
    applyDesktopCompatibilityPatches([modules], [record], patchRoot),
    /is absent from 2\.0\.0; expected 1\.2\.3/
  );
});

test("rejects a compatibility patch whose bytes do not match the toolchain lock", async t => {
  const { modules, patchRoot, record } = await fixture(t);
  record.sha256 = "0".repeat(64);
  await assert.rejects(
    applyDesktopCompatibilityPatches([modules], [record], patchRoot),
    /checksum mismatch/
  );
});
