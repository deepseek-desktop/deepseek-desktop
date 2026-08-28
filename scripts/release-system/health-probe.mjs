const controller = process.argv[2];
if (!controller) throw new Error("controller URL is required");

const response = await fetch(new URL("/v1/health", controller), { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`release controller health check returned HTTP ${response.status}`);
const body = await response.json();
if (body.ok !== true || body.service !== "deepseek-desktop-release-controller") {
  throw new Error("release controller health response is invalid");
}
console.log(`Release controller is reachable from ${process.platform}-${process.arch}.`);
