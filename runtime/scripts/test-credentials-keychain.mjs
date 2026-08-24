import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const providerUrl = pathToFileURL(resolve(import.meta.dirname, "../packages/credentials-keychain/index.js")).href;
const script = `
  import { Context } from "@deepseek-ai/cordis";
  process.env.DSH_DESKTOP_HELPER_PATH = ${JSON.stringify(resolve(import.meta.dirname, "missing-keychain-helper"))};
  const { KeychainCredentialProvider } = await import(${JSON.stringify(providerUrl)});
  const provider = new KeychainCredentialProvider(new Context());
  const proxied = new Proxy(provider, {});
  const result = await proxied.enqueue(async () => "proxy-safe");
  let setFailure = "";
  try {
    await proxied.set("SMOKE_API_KEY", "not-a-real-secret");
  } catch (error) {
    setFailure = String(error);
  }
  process.stdout.write(JSON.stringify({ result, setFailure }));
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
assert.match(result.setFailure, /ENOENT|spawn/u);
assert.doesNotMatch(result.setFailure, /Receiver must be an instance of class KeychainCredentialProvider/u);
assert.doesNotMatch(stderr, /Receiver must be an instance of class KeychainCredentialProvider/);
console.log("credential provider proxy regression passed");
