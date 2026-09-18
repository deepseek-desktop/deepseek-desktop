import assert from "node:assert/strict";
import test from "node:test";

import { cleanCachedCheckout } from "../lib/cached-checkout-clean.mjs";

test("retries a transient cached checkout cleanup failure", async () => {
  let cleanAttempts = 0;
  let recreateAttempts = 0;
  const warnings = [];

  const result = await cleanCachedCheckout({
    clean: async () => {
      cleanAttempts += 1;
      if (cleanAttempts === 1) throw new Error("Directory not empty");
    },
    recreate: async () => { recreateAttempts += 1; },
    warn: message => warnings.push(message)
  });

  assert.deepEqual(result, { recreated: false, attempts: 2 });
  assert.equal(recreateAttempts, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Directory not empty/u);
});

test("recreates an immutable checkout after repeated cleanup failures", async () => {
  let cleanAttempts = 0;
  let recreateAttempts = 0;
  const warnings = [];

  const result = await cleanCachedCheckout({
    clean: async () => {
      cleanAttempts += 1;
      throw new Error(`cleanup failure ${cleanAttempts}`);
    },
    recreate: async () => { recreateAttempts += 1; },
    warn: message => warnings.push(message)
  });

  assert.deepEqual(result, { recreated: true, attempts: 2 });
  assert.equal(recreateAttempts, 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /recreating the immutable checkout/u);
});

test("rejects an invalid retry count before cleanup", async () => {
  await assert.rejects(
    cleanCachedCheckout({ clean: async () => {}, recreate: async () => {}, retries: -1 }),
    /non-negative integer/u
  );
});
