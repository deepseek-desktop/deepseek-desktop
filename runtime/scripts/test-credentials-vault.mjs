import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const providerUrl = pathToFileURL(resolve(import.meta.dirname, "../packages/credentials-vault/index.js")).href;
const script = `
  import { Context } from "@deepseek-ai/cordis";
  process.env.DEEPSEEK_DESKTOP_HELPER_PATH = ${JSON.stringify(resolve(import.meta.dirname, "missing-vault-helper"))};
  process.env.DEEPSEEK_DESKTOP_HELPER_SCRIPT = ${JSON.stringify(resolve(import.meta.dirname, "missing-vault-helper.mjs"))};
  process.env.DEEPSEEK_DESKTOP_DATA_DIR = ${JSON.stringify(resolve(import.meta.dirname, "test-credential-data"))};
  const { VaultCredentialProvider } = await import(${JSON.stringify(providerUrl)});
  const environmentCleared = !process.env.DEEPSEEK_DESKTOP_HELPER_PATH
    && !process.env.DEEPSEEK_DESKTOP_HELPER_SCRIPT
    && !process.env.DEEPSEEK_DESKTOP_DATA_DIR;
  const provider = new VaultCredentialProvider(new Context());
  const proxied = new Proxy(provider, {});
  const result = await proxied.enqueue(async () => "proxy-safe");
  let setFailure = "";
  try {
    await proxied.set("SMOKE_API_KEY", "not-a-real-secret");
  } catch (error) {
    setFailure = String(error);
  }
  process.stdout.write(JSON.stringify({ result, setFailure, environmentCleared }));
`;

const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
  cwd: resolve(import.meta.dirname, ".."),
  stdio: ["pipe", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", chunk => { stdout += chunk; });
child.stderr.on("data", chunk => { stderr += chunk; });
child.stdin.end("test-runtime-session\n");

const code = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("close", resolveExit);
});

assert.equal(code, 0, stderr);
const result = JSON.parse(stdout);
assert.equal(result.result, "proxy-safe");
assert.equal(result.environmentCleared, true);
assert.match(result.setFailure, /ENOENT|spawn/u);
assert.doesNotMatch(result.setFailure, /Receiver must be an instance of class KeychainCredentialProvider/u);
assert.doesNotMatch(stderr, /Receiver must be an instance of class KeychainCredentialProvider/);
console.log("encrypted credential provider proxy regression passed");
