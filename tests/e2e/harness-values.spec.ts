import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

test("Harness JSON snapshots preserve browser-native and cross-realm messages", async ({ page }) => {
  const targets: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc", "linux-x64": "x86_64-unknown-linux-gnu"
  };
  const modules = join("harness/staging", targets[`${process.platform}-${process.arch}`], "node_modules/@deepseek-ai");
  const source = await readFile(join(modules, "dsh-util-values/lib/index.js"), "utf8");
  for (const name of ["dsh-client-connection", "dsh-api-session-controller", "dsh-client-ui-chat", "dsh-client-ui-trajectory"]) {
    const client = await readFile(join(modules, name, "lib/client.js"), "utf8");
    expect(client).not.toContain('=== `function ${name}() { [native code] }`');
  }
  const result = await page.evaluate(async moduleUrl => {
    const { snapshotJsonValue, isJsonValue } = await import(/* @vite-ignore */ moduleUrl);
    const input = { type: "usage", usage: { inputTokens: 7 }, content: ["message", { text: "reply" }] };
    const snapshot = snapshotJsonValue(input);
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreign = frame.contentWindow as unknown as { Object: ObjectConstructor; Array: ArrayConstructor };
    const other = new foreign.Object() as Record<string, unknown>;
    other.content = new foreign.Array("cross-realm");
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    class Custom { value = 1; }
    const forged = Object.create({ constructor: function Object() {} });
    const invalid = [undefined, -0, NaN, Infinity, 1n, new Date(), new Custom(), forged,
      [, "sparse"], { lost: undefined }, { [Symbol("lost")]: 1 }, cycle,
      Object.defineProperty({}, "hidden", { value: 1 })];
    return {
      nativeSource: Function.prototype.toString.call(Object),
      snapshot, detached: snapshot !== input && snapshot?.content !== input.content,
      foreign: snapshotJsonValue(other),
      nullPrototype: snapshotJsonValue(Object.assign(Object.create(null), { valid: true })),
      rejected: invalid.every(value => snapshotJsonValue(value) === undefined && !isJsonValue(value))
    };
  }, `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  expect(result.snapshot).toEqual({ type: "usage", usage: { inputTokens: 7 }, content: ["message", { text: "reply" }] });
  expect(result.detached).toBe(true);
  expect(result.foreign).toEqual({ content: ["cross-realm"] });
  expect(result.nullPrototype).toEqual({ valid: true });
  expect(result.rejected).toBe(true);
});
