function normalizeRepository(value) {
  return value.trim().replace(/^git\+/u, "").replace(/\/+$/u, "").replace(/\.git$/u, "");
}

export function assertPinnedRuntimeSource(source, pin) {
  if (!pin || typeof pin.repository !== "string" || typeof pin.ref !== "string"
    || typeof pin.commit !== "string" || !/^[0-9a-f]{40}$/u.test(pin.commit)) {
    throw new Error("runtime/toolchain-lock.json must declare an immutable runtimeSource pin");
  }
  if (normalizeRepository(source.repository) !== normalizeRepository(pin.repository)) {
    throw new Error(`release Runtime repository does not match source pin: expected ${pin.repository}, got ${source.repository}`);
  }
  if (source.commit !== pin.commit) {
    throw new Error(`release Runtime commit does not match source pin ${pin.ref}: expected ${pin.commit}, got ${source.commit}`);
  }
}
