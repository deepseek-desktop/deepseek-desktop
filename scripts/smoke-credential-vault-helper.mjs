import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const binary = process.argv[2];
if (!binary) throw new Error("usage: pnpm vault:smoke <desktop-binary>");
await stat(binary);

const dataDir = resolve("target", `credential-vault-helper-smoke-${process.pid}-${Date.now()}`);
const session = randomUUID();
const digest = createHash("sha256").update(session).digest("hex");
const key = `DEEPSEEK_DESKTOP_SMOKE_${randomUUID()}`;
const syntheticSecret = `not-a-real-secret-${randomUUID()}`;
await mkdir(dataDir, { recursive: true });
await writeFile(
  resolve(dataDir, "credential-session.json"),
  `${JSON.stringify({ version: 1, digest }, null, 2)}\n`,
  { mode: 0o600 }
);

async function request(operation, value) {
  const child = spawn(binary, ["--credential-vault-helper"], {
    env: { ...process.env, DEEPSEEK_DESKTOP_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ operation, key, value, session })}\n`);
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error(`credential vault helper returned invalid JSON (code ${String(code)}): ${stderr || stdout}`);
  }
  if (code !== 0 || !response.ok) {
    throw new Error(`credential vault helper request failed (code ${String(code)}): ${response.error?.message || stderr}`);
  }
  return response.value;
}

try {
  await request("set-ref", syntheticSecret);
  const files = await import("node:fs/promises").then(fs => fs.readdir(dataDir));
  for (const filename of files.filter(name => name.startsWith("credential-vault"))) {
    const bytes = await import("node:fs/promises").then(fs => fs.readFile(resolve(dataDir, filename)));
    assert.equal(bytes.includes(Buffer.from(syntheticSecret)), false, `${filename} contains plaintext credentials`);
  }
  assert.deepEqual(await request("describe-ref"), { configured: true });
  assert.equal(await request("get-ref"), syntheticSecret);
  await request("delete-ref");
  assert.deepEqual(await request("describe-ref"), { configured: false });
  const authorization = await import("node:fs/promises").then(fs => fs.readFile(resolve(dataDir, "credential-session.json"), "utf8"));
  assert.doesNotMatch(authorization, new RegExp(session, "u"));
  console.log("packaged encrypted credential vault helper smoke passed");
} finally {
  try { await request("delete-ref"); } catch {}
  await rm(dataDir, { recursive: true, force: true });
}
