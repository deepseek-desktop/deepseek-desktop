import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assertCommit, assertSourceRepository } from "./common.mjs";

function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args[0]} failed: ${(stderr || stdout).trim()}`));
    });
  });
}

export async function resolveRemoteTag(repository, tag) {
  const source = assertSourceRepository(repository);
  const output = await runGit(["ls-remote", "--tags", source, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const references = new Map(output.split("\n").filter(Boolean).map(line => {
    const [commit, reference] = line.trim().split(/\s+/u);
    return [reference, assertCommit(commit, "remote tag commit")];
  }));
  const peeled = references.get(`refs/tags/${tag}^{}`);
  const direct = references.get(`refs/tags/${tag}`);
  const commit = peeled || direct;
  if (!commit) throw new Error(`source repository does not contain release tag ${tag}`);
  return commit;
}

async function assertBundle(path) {
  const bundle = resolve(path);
  const info = await stat(bundle);
  if (!info.isFile()) throw new Error("local source bundle must be a regular file");
  await runGit(["bundle", "verify", bundle]);
  return bundle;
}

export async function createLockedSourceBundle({ repositoryRoot, tag, commit, destination }) {
  const workspace = resolve(repositoryRoot);
  const lockedCommit = assertCommit(commit, "desktop commit");
  const bundle = resolve(destination);
  const head = await runGit(["rev-parse", "HEAD"], { cwd: workspace });
  if (head !== lockedCommit) throw new Error("local source bundle commit does not match current HEAD");
  const tagCommit = await runGit(["rev-parse", `${tag}^{commit}`], { cwd: workspace });
  if (tagCommit !== lockedCommit) throw new Error("local source bundle tag does not match locked commit");
  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], { cwd: workspace });
  if (status) throw new Error("local source bundle requires a clean worktree");
  await mkdir(dirname(bundle), { recursive: true });
  await rm(bundle, { force: true });
  await runGit(["bundle", "create", bundle, `refs/tags/${tag}`], { cwd: workspace });
  await assertBundle(bundle);
  return bundle;
}

export async function cloneLockedSource({ repository, sourceBundle = "", tag, commit, destination }) {
  const source = assertSourceRepository(repository);
  const lockedCommit = assertCommit(commit, "desktop commit");
  const cloneSource = sourceBundle ? await assertBundle(sourceBundle) : source;
  await runGit(["clone", "--no-checkout", cloneSource, destination]);
  await runGit(["checkout", "--detach", lockedCommit], { cwd: destination });
  const head = await runGit(["rev-parse", "HEAD"], { cwd: destination });
  if (head !== lockedCommit) throw new Error(`checked out desktop commit ${head} does not match ${lockedCommit}`);
  const tagCommit = await runGit(["rev-parse", `${tag}^{commit}`], { cwd: destination });
  if (tagCommit !== lockedCommit) throw new Error(`release tag ${tag} does not resolve to locked desktop commit`);
  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], { cwd: destination });
  if (status) throw new Error("release worker checkout is dirty before build");
}

export { runGit };
