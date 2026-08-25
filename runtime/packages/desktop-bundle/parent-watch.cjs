const expectedParent = Number.parseInt(process.env.DEEPSEEK_DESKTOP_PARENT_PID || "", 10);
delete process.env.DEEPSEEK_DESKTOP_PARENT_PID;

// DSH Market re-invokes the current CLI with process.execArgv. Desktop-only
// preloads must not cross that process boundary: the child is no longer a
// direct child of the Tauri process, so parent-watch would reject it before
// the plugin command can start.
const desktopPreloads = new Set(["parent-watch.cjs", "locale-sync.cjs"]);
const sanitizedExecArgv = [];
for (let index = 0; index < process.execArgv.length; index += 1) {
  const argument = process.execArgv[index];
  const preload = argument === "--require" || argument === "-r";
  const preloadPath = preload ? process.execArgv[index + 1] : undefined;
  const isDesktopPreload = preloadPath && [...desktopPreloads].some(name => preloadPath.endsWith(name));
  if (isDesktopPreload) {
    index += 1;
    continue;
  }
  sanitizedExecArgv.push(argument);
}
process.execArgv = sanitizedExecArgv;

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
