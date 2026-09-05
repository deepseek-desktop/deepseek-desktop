import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = resolve(import.meta.dirname, "../..");
const packageRoot = resolve(root, "harness/packages/web-search-follow-model");
let client;
const document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } };
vm.runInNewContext(await readFile(resolve(packageRoot, "client.js"), "utf8"), {
  document, AbortSignal,
  window: { __ModuleLoader__: { load: entry => { client = entry.factory(() => ({})); } } }
});

function setup(user = {}, writable = true) {
  const calls = [];
  const listeners = new Set();
  const state = {
    status: "ready", writable,
    base: { mode: "follow-model", independentProvider: "deepseek-official" },
    user, revision: 1
  };
  function publish() {
    state.value = { ...state.base, ...state.user };
    for (const listener of listeners) listener();
  }
  publish();
  const scope = {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    mutate: async (ops, revision) => {
      calls.push(JSON.parse(JSON.stringify({ ops, revision })));
      if (revision !== state.revision) return;
      for (const op of ops) {
        if (op.op === "unset") delete state.user[op.path[0]];
        else state.user[op.path[0]] = op.value;
      }
      state.revision++;
      publish();
    }
  };
  const activation = async () => ({ phase: "active", revision: state.revision, selection: state.value });
  return { scope, state, calls, publish, listeners, controller: new client.SearchSettingsController(scope, activation) };
}

test("search owns its browser entry and locales without patching the official settings plugin", async () => {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const toolchain = JSON.parse(await readFile(resolve(root, "harness/toolchain-lock.json"), "utf8"));
  assert.equal(manifest.exports["./client"], "./client.js");
  assert.ok(manifest.files.includes("client.js"));
  assert.equal(manifest.dsh.client.platform, "web");
  assert.ok(!toolchain.desktopPatches.some(patch => patch.packageName === "@deepseek-ai/dsh-client-ui-settings-plugins"));
  for (const locale of ["en", "zh", "zh-TW"]) {
    assert.deepEqual(Object.keys(client.dictionaries[locale]).sort(), Object.keys(client.dictionaries.en).sort());
    assert.ok(Object.values(client.dictionaries[locale]).every(value => typeof value === "string" && value));
  }
});

test("default requires no writes; saving and resetting use the same isolated namespace", async () => {
  const { controller, calls, state } = setup();
  assert.equal(controller.getSnapshot().mode, "follow-model");
  assert.equal(controller.getSnapshot().dirty, false);
  await controller.save();
  assert.equal(calls.length, 0);
  controller.edit("mode", "disabled");
  assert.equal(calls.length, 0);
  await controller.save();
  assert.deepEqual(state.user, { mode: "disabled" });
  assert.equal(controller.getSnapshot().dirty, false);
  controller.reset();
  assert.equal(state.user.mode, "disabled");
  assert.equal(controller.getSnapshot().mode, "follow-model");
  await controller.save();
  assert.deepEqual(state.user, {});
  assert.equal(controller.getSnapshot().failed, false);
  controller.dispose();
});

test("independent Provider routing validates, saves and survives failed writes", async () => {
  const { controller, scope, calls, state } = setup();
  controller.edit("mode", "independent");
  controller.edit("independentProvider", "follow-model");
  assert.equal(controller.getSnapshot().invalid, true);
  await controller.save();
  assert.equal(calls.length, 0);
  controller.edit("independentProvider", "separate-search");
  assert.equal(controller.getSnapshot().invalid, false);
  await controller.save();
  assert.deepEqual(state.user, { mode: "independent", independentProvider: "separate-search" });
  assert.equal(calls.length, 1);
  controller.edit("mode", "disabled");
  const mutate = scope.mutate;
  scope.mutate = async () => { throw new Error("test-only failure"); };
  await controller.save();
  assert.equal(controller.getSnapshot().failed, true);
  assert.equal(controller.getSnapshot().dirty, true);
  assert.equal(controller.getSnapshot().saving, false);
  scope.mutate = mutate;
  await controller.save();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].ops.length, 2);
  assert.equal(calls[1].ops.length, 1);
  assert.deepEqual(state.user, { mode: "disabled", independentProvider: "separate-search" });
  controller.dispose();
});

test("conflicting updates keep the draft and read-only settings never write", async () => {
  const { controller, state, publish } = setup();
  controller.edit("mode", "disabled");
  state.revision++;
  publish();
  await controller.save();
  assert.equal(controller.getSnapshot().failed, true);
  assert.equal(controller.getSnapshot().mode, "disabled");
  controller.discard();
  assert.equal(controller.getSnapshot().mode, "follow-model");
  controller.dispose();
  const readOnly = setup({}, false);
  readOnly.controller.edit("mode", "disabled");
  await readOnly.controller.save();
  assert.equal(readOnly.calls.length, 0);
  assert.equal(readOnly.controller.getSnapshot().mode, "follow-model");
  readOnly.controller.dispose();
});

test("slot registration is owned by follow-model and cleans subscriptions on unload", () => {
  const { scope, controller, listeners } = setup();
  controller.dispose();
  const registrations = [];
  const disposers = [];
  const context = {
    connection: { rpc: { call: async () => ({ ok: true, value: { phase: "active", selection: scope.getSnapshot().value } }) } },
    locale: { register: () => () => {} },
    settingsScope: { bind: ({ namespace }) => { assert.equal(namespace, "web-search-follow-model"); return scope; } },
    effect: callback => { disposers.push(callback()); },
    slots: { inject: (_name, callback) => callback(), register: (options, component) => { registrations.push({ options, component }); } }
  };
  client.apply(context);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.key, "web-search-follow-model");
  assert.equal(registrations[0].options.name, "settings.plugin.item");
  assert.equal(registrations[0].options.inject().hooks.searchSettings.getSnapshot().mode, "follow-model");
  assert.equal(listeners.size, 1);
  for (const dispose of disposers.reverse()) dispose?.();
  assert.equal(listeners.size, 0);
});

test("saved settings are not reported active until the backend confirms activation", async () => {
  const { controller, state } = setup();
  let complete;
  controller.activation = () => new Promise(resolve => { complete = resolve; });
  controller.edit("mode", "disabled");
  const saving = controller.save();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.user.mode, "disabled");
  assert.equal(controller.getSnapshot().saving, true);
  complete({ phase: "failed", selection: { mode: "follow-model", independentProvider: "deepseek-official" } });
  await saving;
  assert.equal(controller.getSnapshot().failed, true);
  assert.equal(controller.getSnapshot().activationPhase, "failed");
  controller.activation = async () => ({ phase: "active", selection: state.value });
  await controller.save();
  assert.equal(controller.getSnapshot().failed, false);
  controller.dispose();
});
