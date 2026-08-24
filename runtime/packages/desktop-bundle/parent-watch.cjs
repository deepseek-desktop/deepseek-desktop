const expectedParent = Number.parseInt(process.env.DSH_DESKTOP_PARENT_PID || "", 10);
delete process.env.DSH_DESKTOP_PARENT_PID;

if (!Number.isInteger(expectedParent) || expectedParent <= 1) {
  throw new Error("desktop runtime parent is unavailable");
}

function parentIsAlive() {
  if (process.ppid !== expectedParent) return false;
  try {
    process.kill(expectedParent, 0);
    return true;
  } catch {
    return false;
  }
}

const monitor = setInterval(() => {
  if (parentIsAlive()) return;
  clearInterval(monitor);
  if (process.platform !== "win32") {
    try {
      process.kill(-process.pid, "SIGTERM");
      return;
    } catch {
      // Fall through to an immediate local exit when the process group is unavailable.
    }
  }
  process.exit(1);
}, 500);

monitor.unref();
