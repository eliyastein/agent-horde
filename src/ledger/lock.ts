import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { hordePaths } from "./files.js";

const LOCK_STALE_MS = 10_000;

const LOCK_ABANDON_MS = 300_000;

const LOCK_TIMEOUT_MS = 5_000;

interface LockInfo {
  holder: string;
  pid: number;
  token: string;
  at: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLockInfo(lockPath: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8").trim()) as Partial<LockInfo>;
    if (
      typeof parsed?.holder === "string" &&
      typeof parsed?.token === "string" &&
      typeof parsed?.pid === "number"
    ) {
      return parsed as LockInfo;
    }
  } catch {
    // Legacy lock or a partial write; fall through.
  }
  return undefined;
}

function describeLockHolder(lockPath: string): string {
  const info = readLockInfo(lockPath);
  if (info) return info.holder;
  try {
    return fs.readFileSync(lockPath, "utf-8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryAcquireLock(lockPath: string, holder: string): LockInfo | undefined {
  const info: LockInfo = {
    holder,
    pid: process.pid,
    token: randomUUID(),
    at: new Date().toISOString(),
  };
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, `${JSON.stringify(info)}\n`);
    fs.closeSync(fd);
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

/**
 * Reclaim a lock only when its holder is gone. A live holder is never preempted
 * (except after LOCK_ABANDON_MS, a safety valve against pid reuse), because
 * stealing a live lock is what lets two writers into the critical section.
 */
function reclaimStaleLock(lockPath: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const age = Date.now() - mtimeMs;
  const info = readLockInfo(lockPath);
  if (info) {
    if (isProcessAlive(info.pid) && age < LOCK_ABANDON_MS) return false;
  } else if (age < LOCK_STALE_MS) {
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function releaseLock(lockPath: string, token: string): void {
  const info = readLockInfo(lockPath);
  if (!info || info.token !== token) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Run `fn` while holding the cross-process lock for a .horde directory.
 *
 * `fn` must be synchronous so the critical section cannot interleave with other
 * async work in the same process.
 */
export async function withHordeLock<T>(hordeDir: string, holder: string, fn: () => T): Promise<T> {
  const lockPath = hordePaths(hordeDir).lock;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lock: LockInfo | undefined;
  for (;;) {
    lock = tryAcquireLock(lockPath, holder);
    if (lock) break;
    if (reclaimStaleLock(lockPath)) continue;
    if (Date.now() > deadline) {
      throw new Error(
        `horde: could not acquire .horde/.lock within ${Math.round(LOCK_TIMEOUT_MS / 1000)}s ` +
          `(held by ${describeLockHolder(lockPath)})`,
      );
    }
    await sleep(10 + Math.random() * 40);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockPath, lock.token);
  }
}
