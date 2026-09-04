import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deployHarnessClosure, findCliPackage, findWorkspacePackages, mergeDesktopClosure } from "../lib/harness-deployment.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-deployment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function packageAt(root, name, manifest = {}) {
  const directory = join(root, ...name.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  return directory;
}

test("desktop closure includes transitive dependencies but preserves the new Harness core", async t => {
  const root = await fixture(t);
  const desktop = join(root, "desktop");
  const candidate = join(root, "candidate");
  const from = join(desktop, "node_modules");
  const to = join(candidate, "node_modules");
  await packageAt(from, "desktop", { dependencies: { yaml: "1", extension: "1" } });
  await packageAt(from, "yaml", { dependencies: { parser: "1" } });
  await packageAt(from, "parser");
  await packageAt(from, "extension", { peerDependencies: { core: "1" }, optionalDependencies: { absent: "1" } });
  await packageAt(from, "core");
  await packageAt(from, "unrelated");
  await packageAt(to, "core", { version: "2.0.0" });
  const copied = await mergeDesktopClosure(desktop, candidate, ["desktop"]);
  assert.deepEqual(copied.sort(), ["desktop", "extension", "parser", "yaml"]);
  assert.equal(JSON.parse(await readFile(join(to, "core/package.json"))).version, "2.0.0");
  await assert.rejects(readFile(join(to, "unrelated/package.json")), { code: "ENOENT" });
});

test("missing candidate peer fails instead of copying an old core", async t => {
  const root = await fixture(t);
  await packageAt(join(root, "old/node_modules"), "desktop", { peerDependencies: { core: "1" } });
  await packageAt(join(root, "old/node_modules"), "core");
  await assert.rejects(mergeDesktopClosure(join(root, "old"), join(root, "new"), ["desktop"]), /Candidate Harness peer is missing: core/);
});

test("desktop client and its Harness dependencies survive replacement and reject incomplete candidates", async t => {
  const root = await fixture(t);
  const old = join(root, "old");
  const next = join(root, "next");
  const extension = await packageAt(join(old, "node_modules"), "extension", {
    exports: { "./client": "./client.js" },
    dsh: { client: { inject: ["settings-ui"] }, desktop: { harnessPackages: ["agent"] } }
  });
  await assert.rejects(mergeDesktopClosure(old, next, ["extension"]), /extension dependency is missing: agent/);
  await packageAt(join(next, "node_modules"), "agent");
  await assert.rejects(mergeDesktopClosure(old, next, ["extension"]), /Desktop client entry is missing/);
  await writeFile(join(extension, "client.js"), "independent-settings");
  await assert.rejects(mergeDesktopClosure(old, next, ["extension"]), /client dependency is missing: settings-ui/);
  await packageAt(join(next, "node_modules"), "settings-ui");
  await mergeDesktopClosure(old, next, ["extension"]);
  assert.equal(await readFile(join(next, "node_modules/extension/client.js"), "utf8"), "independent-settings");
  await writeFile(join(next, "settings.yaml"), "user-choice");
  await mergeDesktopClosure(old, next, ["extension"]);
  assert.equal(await readFile(join(next, "settings.yaml"), "utf8"), "user-choice");
});

test("missing required desktop dependency fails preparation", async t => {
  const root = await fixture(t);
  await packageAt(join(root, "old/node_modules"), "desktop", { dependencies: { missing: "1" } });
  await assert.rejects(mergeDesktopClosure(join(root, "old"), join(root, "new"), ["desktop"]), /Desktop dependency is missing: missing/);
  await packageAt(join(root, "old/node_modules"), "optional-first", { optionalDependencies: { missing: "1" } });
  await assert.rejects(mergeDesktopClosure(join(root, "old"), join(root, "new"), ["optional-first", "desktop"]), /Desktop dependency is missing: missing/);
});

test("production deployment restores workspace peers and original input files", async t => {
  const root = await fixture(t);
  const source = join(root, "source");
  const destination = join(root, "deployment");
  await packageAt(source, "python/sdk-runtime", { name: "closure" });
  await packageAt(source, "apps/cli", { name: "cli", bin: { dsh: "lib/custom.js" } });
  const peer = await packageAt(source, "packages/peer", { name: "peer" });
  await writeFile(join(peer, "index.js"), "export default 1;");
  const lock = join(source, "pnpm-lock.yaml");
  await writeFile(lock, "original lock\n");
  const original = await readFile(join(source, "python/sdk-runtime/package.json"), "utf8");
  const packages = await findWorkspacePackages(source);
  const cli = findCliPackage(packages);
  assert.equal(cli.entry, "lib/custom.js");
  const calls = [];
  // The callback models pnpm's deployment, which can omit workspace peers.
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const restored = await deployHarnessClosure(source, packages, cli, destination, args => {
    calls.push(args);
    if (args.includes("deploy")) {
      mkdirSync(join(destination, "node_modules"), { recursive: true });
      writeFileSync(join(destination, "package.json"), JSON.stringify({ peerDependencies: { peer: "*" } }));
    }
  });
  assert.deepEqual(restored, ["peer"]);
  assert.equal(await readFile(join(destination, "node_modules/peer/index.js"), "utf8"), "export default 1;");
  assert.equal(await readFile(join(source, "python/sdk-runtime/package.json"), "utf8"), original);
  assert.equal(await readFile(lock, "utf8"), "original lock\n");
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes("--prod"));
  await assert.rejects(deployHarnessClosure(source, packages, cli, destination, () => { throw new Error("pnpm failed"); }), /pnpm failed/);
  assert.equal(await readFile(join(source, "python/sdk-runtime/package.json"), "utf8"), original);
  assert.equal(await readFile(lock, "utf8"), "original lock\n");
});
