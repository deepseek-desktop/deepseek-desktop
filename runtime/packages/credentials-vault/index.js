import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Service } from "@deepseek-ai/cordis";
import { CredentialProvider, parseCredentialKey } from "@deepseek-ai/dsh-credentials";

const HELPER_ARGUMENT = "--credential-vault-helper";
const HELPER_SESSION = readFileSync(0, "utf8").trim();
const HELPER_PATH = process.env.DEEPSEEK_DESKTOP_HELPER_PATH;
const HELPER_SCRIPT = process.env.DEEPSEEK_DESKTOP_HELPER_SCRIPT;
const HELPER_DATA_DIR = process.env.DEEPSEEK_DESKTOP_DATA_DIR;
const OPERATIONS = Symbol("operations");
const CLOSED = Symbol("closed");

delete process.env.DEEPSEEK_DESKTOP_HELPER_PATH;
delete process.env.DEEPSEEK_DESKTOP_HELPER_SCRIPT;
delete process.env.DEEPSEEK_DESKTOP_DATA_DIR;

if (!HELPER_SESSION) {
  throw new Error("credentials-vault: desktop credential session is unavailable");
}

function helperEnvironment() {
  if (!HELPER_DATA_DIR) throw new Error("credentials-vault: desktop credential data directory is not configured");
  const environment = { DEEPSEEK_DESKTOP_DATA_DIR: HELPER_DATA_DIR };
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function callHelper(request) {
  return new Promise((resolve, reject) => {
    if (!HELPER_PATH) throw new Error("credentials-vault: desktop credential helper is not configured");
    const child = spawn(HELPER_PATH, [...(HELPER_SCRIPT ? [HELPER_SCRIPT] : []), HELPER_ARGUMENT], {
      env: helperEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      try {
        const response = JSON.parse(stdout);
        if (!response.ok) {
          const helperCode = response.error?.code ?? "vault-failed";
          const message = response.error?.message ?? "credential vault operation failed";
          throw new Error(`credentials-vault: ${helperCode}: ${message}`);
        }
        if (code !== 0) {
          throw new Error(`credentials-vault: helper exited with code ${String(code)}`);
        }
        resolve(response.value);
      } catch (error) {
        if (error instanceof SyntaxError) {
          const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
          reject(new Error(`credentials-vault: invalid helper response (code ${String(code)})${detail}`));
        } else {
          reject(error);
        }
      }
    });
    child.stdin.end(`${JSON.stringify({ ...request, session: HELPER_SESSION })}\n`);
  });
}

export class VaultCredentialProvider extends CredentialProvider {
  [OPERATIONS] = Promise.resolve();
  [CLOSED] = false;

  async *[Service.init]() {
    yield async () => {
      this[CLOSED] = true;
      await this[OPERATIONS];
    };
  }

  enqueue(operation) {
    if (this[CLOSED]) return Promise.reject(new Error("credentials-vault: provider is disposed"));
    const task = this[OPERATIONS].then(operation);
    this[OPERATIONS] = task.then(() => undefined, () => undefined);
    return task;
  }

  async resolve(ref) {
    const value = await callHelper({ operation: "get-ref", key: ref });
    return value === null ? undefined : { value, source: "encrypted-vault" };
  }

  async describe(ref) {
    const response = await callHelper({ operation: "describe-ref", key: ref });
    return { configured: response.configured, source: response.configured ? "encrypted-vault" : undefined, writable: true };
  }

  async set(ref, value) {
    if (!value) throw new Error(`credentials-vault: an empty value cannot be stored for "${ref}"; use unset`);
    await this.enqueue(() => callHelper({ operation: "set-ref", key: ref, value }));
    this.notifyUpdated(ref);
  }

  async unset(ref) {
    await this.enqueue(() => callHelper({ operation: "delete-ref", key: ref }));
    this.notifyUpdated(ref);
  }

  async readRecord(key) {
    const value = await callHelper({ operation: "get-record", key });
    return value === null ? undefined : value;
  }

  async describeRecord(key) {
    const response = await callHelper({ operation: "describe-record", key });
    return response.configured
      ? { configured: true, kind: response.kind, writable: true }
      : { configured: false, writable: true };
  }

  async listRecords() {
    const response = await callHelper({ operation: "list-records" });
    return response.records.map(entry => ({ key: parseCredentialKey(entry.key), kind: entry.kind }));
  }

  async modifyRecord(key, mutate) {
    return this.enqueue(async () => {
      const current = await this.readRecord(key);
      const next = await mutate(current);
      if (next === undefined) return current;
      await callHelper({ operation: "set-record", key, value: next });
      this.notifyRecordUpdated(key);
      return next;
    });
  }

  async deleteRecord(key) {
    await this.enqueue(() => callHelper({ operation: "delete-record", key }));
    this.notifyRecordUpdated(key);
  }
}

export default VaultCredentialProvider;
