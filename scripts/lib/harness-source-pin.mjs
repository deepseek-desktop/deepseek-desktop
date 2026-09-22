import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertStableHarnessVersion, matchesHarnessChannel } from "./harness-ref.mjs";

export async function assertPackagedHarnessVersion(root, harness, channel = "stable") {
  const check = version => {
    if (channel === "stable") assertStableHarnessVersion(version);
    if (!matchesHarnessChannel(version, channel)) throw new Error("Harness version does not match the selected channel");
  };
  check(harness.version);
  const manifest = JSON.parse(await readFile(join(root, "node_modules", ...harness.packageName.split("/"), "package.json"), "utf8"));
  check(manifest.version);
  if (manifest.version !== harness.version) {
    throw new Error(`packaged Harness version ${manifest.version} does not match lock ${harness.version}`);
  }
}

function normalizeRepository(value) {
  return value.trim().replace(/^git\+/u, "").replace(/\/+$/u, "").replace(/\.git$/u, "");
}

export function assertPinnedHarnessSource(source, pin) {
  if (!pin || typeof pin.repository !== "string" || typeof pin.ref !== "string"
    || typeof pin.commit !== "string" || !/^[0-9a-f]{40}$/u.test(pin.commit)) {
    throw new Error("harness/toolchain-lock.json must declare an immutable harnessSource pin");
  }
  if (normalizeRepository(source.repository) !== normalizeRepository(pin.repository)) {
    throw new Error(`release Harness repository does not match source pin: expected ${pin.repository}, got ${source.repository}`);
  }
  if (source.commit !== pin.commit) {
    throw new Error(`release Harness commit does not match source pin ${pin.ref}: expected ${pin.commit}, got ${source.commit}`);
  }
}
