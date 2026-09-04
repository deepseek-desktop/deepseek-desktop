import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { assertSourceRepository, loadTargets } from "./common.mjs";
import { parseReleaseTag } from "../lib/release-tag.mjs";

const defaultRoot = resolve(import.meta.dirname, "../..");

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export async function createReleasePlan({
  root = defaultRoot,
  tag,
  channel = "community",
  signed = false,
  sourceRepository = "",
  productName = "DeepSeek Desktop",
  requestedTargetIds = [],
  trustedNodes = new Map(),
  prepared = null
}) {
  const workspace = resolve(root);
  const { version } = parseReleaseTag(tag);
  const status = git(workspace, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error("distributed release creation requires a clean Desktop worktree");
  const commit = git(workspace, ["rev-parse", `${tag}^{commit}`]);
  if (git(workspace, ["rev-parse", "HEAD"]) !== commit) throw new Error(`release tag ${tag} must point at current HEAD`);
  const repository = assertSourceRepository(sourceRepository || git(workspace, ["remote", "get-url", "origin"]));
  const lock = JSON.parse(await readFile(join(workspace, "harness", "toolchain-lock.json"), "utf8"));
  const harness = lock.harnessSource;
  if (!harness?.repository || !harness?.ref || !harness?.commit) {
    throw new Error("harness/toolchain-lock.json has no immutable Harness source");
  }
  const targetConfig = await loadTargets();
  const targetIds = requestedTargetIds.length > 0
    ? requestedTargetIds
    : targetConfig.targets.map(target => target.id);
  return {
    productName,
    version,
    channel,
    signed,
    source: { repository, tag, commit },
    harness,
    toolchain: {
      nodeVersion: lock.node.version,
      nodeModuleAbi: lock.node.moduleAbi,
      rustVersion: lock.toolchain.rust,
      pnpmVersion: lock.toolchain.pnpm,
      tauriCliVersion: lock.toolchain.tauriCli
    },
    ...(prepared ? { prepared } : {}),
    targets: targetIds.map(id => ({ id, trustedNodeId: trustedNodes.get(id) || "" }))
  };
}
