import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

function runGh(args, token) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      env: { ...process.env, GH_TOKEN: token },
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
      else reject(new Error(`GitHub release provider failed: ${(stderr || stdout).trim()}`));
    });
  });
}

export async function publishGitHub({ release, stagingDirectory, options }) {
  const repository = options.repository?.trim();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository || "")) {
    throw new Error("GitHub provider requires repository in owner/name form");
  }
  const token = process.env.DISTRIBUTED_RELEASE_GITHUB_TOKEN?.trim();
  if (!token) throw new Error("GitHub provider requires DISTRIBUTED_RELEASE_GITHUB_TOKEN on the controller host");
  const assets = (await readdir(stagingDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(stagingDirectory, entry.name))
    .sort();
  const args = [
    "release", "create", release.tag, ...assets,
    "--repo", repository,
    "--title", `${release.productName} ${release.version}`,
    "--notes", options.notes || "由 DeepSeek Desktop 分布式本地发布系统生成。",
    "--verify-tag"
  ];
  if (release.channel !== "stable") args.push("--prerelease");
  const location = await runGh(args, token);
  return { provider: "github", location };
}
