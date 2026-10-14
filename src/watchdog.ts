/** How often a child checks that the pi process that spawned it is still alive. */
const PARENT_POLL_MS = 2_000;
/** How long a child gives its own graceful SIGTERM path before it exits outright. */
const SELF_EXIT_GRACE_MS = 5_000;

/** Whether the process with `pid` still exists; EPERM counts as alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface ParentWatchdogOptions {
  pollMs?: number | undefined;
  graceMs?: number | undefined;
  /** Replaces the default self-termination; used by tests. */
  onParentGone?: (() => void) | undefined;
}

/**
 * Terminate this process once its parent pi process is gone, so a crashed or
 * SIGKILLed parent never leaves horde children running. The graceful path
 * sends SIGTERM to ourselves, which lets pi's print mode kill its own bash
 * children and dispose the session; if that hangs, exit outright.
 */
export function startParentWatchdog(parentPid: number, options: ParentWatchdogOptions = {}): () => void {
  const pollMs = options.pollMs ?? PARENT_POLL_MS;
  const graceMs = options.graceMs ?? SELF_EXIT_GRACE_MS;
  const onParentGone =
    options.onParentGone ??
    ((): void => {
      process.stderr.write(`[horde] parent pi process ${parentPid} is gone; exiting\n`);
      const fallback = setTimeout(() => process.exit(143), graceMs);
      fallback.unref();
      try {
        process.kill(process.pid, "SIGTERM");
      } catch {
        process.exit(143);
      }
    });
  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) return;
    clearInterval(timer);
    onParentGone();
  }, pollMs);
  timer.unref();
  return () => clearInterval(timer);
}
