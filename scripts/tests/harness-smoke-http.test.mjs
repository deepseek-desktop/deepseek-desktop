import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { requestLoopback, waitForLoopback } from "../../harness/scripts/loopback-http.mjs";

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("loopback readiness retries until the Harness accepts HTTP requests", async t => {
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);

  const server = createServer((request, response) => {
    response.writeHead(303, { location: "/", "set-cookie": "session=test; HttpOnly" });
    response.end();
  });
  t.after(() => close(server));
  setTimeout(() => { void listen(server, port); }, 150);

  const response = await waitForLoopback(`http://127.0.0.1:${port}/?token=test`, {
    child: { exitCode: null, signalCode: null },
    timeoutMs: 3_000,
    retryDelayMs: 25
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, "/");
});

test("loopback requests reject non-loopback origins and oversized responses", async t => {
  assert.throws(() => requestLoopback("https://example.com/"), /only accepts/u);
  const server = createServer((request, response) => response.end("x".repeat(128)));
  t.after(() => close(server));
  const port = await listen(server);
  await assert.rejects(
    () => requestLoopback(`http://127.0.0.1:${port}/`, { bodyLimit: 64 }),
    /exceeds 64 bytes/u
  );
});

test("loopback readiness stops when the Harness has already exited", async () => {
  await assert.rejects(
    () => waitForLoopback("http://127.0.0.1:9/", {
      child: { exitCode: 1, signalCode: null },
      timeoutMs: 100
    }),
    /harness exited before/u
  );
});
