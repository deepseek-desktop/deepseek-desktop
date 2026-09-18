export async function cleanCachedCheckout({ clean, recreate, retries = 1, warn = console.warn }) {
  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error("cached checkout cleanup retries must be a non-negative integer");
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await clean();
      return { recreated: false, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        warn(`Harness cache cleanup failed; retrying (${attempt + 1}/${retries}): ${error.message}`);
      }
    }
  }

  warn(`Harness cache cleanup remained unstable; recreating the immutable checkout: ${lastError.message}`);
  await recreate();
  return { recreated: true, attempts: retries + 1 };
}
