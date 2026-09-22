import { appendFile } from "node:fs/promises";

// Reuse is confined to this invocation, never inferred from files or an env flag.
export function createBuildSession({ runPnpm, runNode, stage = async (_name, action) => action() }) {
  const preparations = new Map();
  function once(name, action) {
    if (!preparations.has(name)) preparations.set(name, Promise.resolve().then(() => stage(name, action)));
    return preparations.get(name);
  }
  const pnpm = (name, ...args) => stage(name, () => runPnpm(args));
  const syncHarness = () => once("harnessSyncMs", () => runPnpm(["harness:sync"]));
  const stageHarness = async () => {
    await syncHarness();
    await once("harnessStageMs", () => runPnpm(["harness:stage"]));
  };
  return {
    syncHarness,
    stageHarness,
    async verify() {
      await pnpm("appSyncCheckMs", "app:sync", "--check");
      await pnpm("configTestsMs", "test:config");
      await pnpm("i18nCheckMs", "check:i18n");
      await pnpm("frontendTestsMs", "test");
      await pnpm("typecheckMs", "typecheck");
      await syncHarness();
      await pnpm("localeTestsMs", "harness:test-locale");
      await pnpm("omlxTestsMs", "harness:test-omlx");
      await pnpm("credentialTestsMs", "harness:test-credentials");
      await stageHarness();
      await pnpm("followModelTestsMs", "harness:test-follow-model");
      await pnpm("harnessVerifyMs", "harness:verify");
      await pnpm("rustTestsMs", "rust:test");
      await pnpm("rustClippyMs", "rust:clippy");
    },
    async e2e(args = []) {
      await syncHarness();
      await stage("e2eMs", () => runNode(["node_modules/@playwright/test/cli.js", "test", ...args]));
    },
    async smoke() {
      await stageHarness();
      await stage("harnessSmokeMs", () => runNode(["harness/scripts/smoke-harness.mjs", "--settings-ui"]));
    }
  };
}

export function createStageReporter({ timings = {}, env = process.env, log = console.log } = {}) {
  let summaryStarted = false;
  return async (name, action) => {
    const startedAt = Date.now();
    const label = name.replace(/Ms$/u, "");
    log(env.GITHUB_ACTIONS === "true" ? `::group::${label}` : `\n[build] ${label}`);
    let status = "failed";
    try {
      const result = await action();
      status = "passed";
      return result;
    } finally {
      const elapsed = Date.now() - startedAt;
      timings[name] = elapsed;
      log(`[build] ${label}: ${status} (${(elapsed / 1000).toFixed(1)}s)`);
      if (env.GITHUB_ACTIONS === "true") log("::endgroup::");
      if (env.GITHUB_STEP_SUMMARY) {
        const header = summaryStarted ? "" : "\n### 构建阶段耗时\n\n| 阶段 | 结果 | 秒 |\n| --- | --- | ---: |\n";
        summaryStarted = true;
        await appendFile(env.GITHUB_STEP_SUMMARY, `${header}| ${label} | ${status} | ${(elapsed / 1000).toFixed(1)} |\n`);
      }
    }
  };
}
