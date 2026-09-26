import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, isErrno } from "../domain/errors.js";
import {
  type CodexProcess,
  parseProcessStat,
  scanCodexProcesses,
} from "./process.js";

export interface SessionResult {
  terminated: number;
}

export interface SessionOptions {
  procRoot?: string;
  uid?: number;
  fallbackHome?: string;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function live(
  record: CodexProcess,
  procRoot: string,
  uid: number | undefined,
): Promise<boolean> {
  try {
    const root = path.join(procRoot, String(record.pid));
    const owner = await fs.stat(root);
    if (uid !== undefined && owner.uid !== uid) return false;
    const stat = parseProcessStat(
      await fs.readFile(path.join(root, "stat"), "utf8"),
    );
    return (
      stat.startTime === record.startTime &&
      stat.state !== "Z" &&
      stat.state !== "X"
    );
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return false;
    throw error;
  }
}

export async function terminateOne(
  record: CodexProcess,
  options: SessionOptions = {},
): Promise<boolean> {
  const root = options.procRoot ?? "/proc";
  const uid = options.uid ?? process.getuid?.();
  const send = options.signal ?? process.kill;
  const wait = options.wait ?? sleep;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!(await live(record, root, uid))) return true;
    try {
      send(record.pid, signal);
    } catch (error) {
      if (isErrno(error, "ESRCH")) return true;
      return false;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await wait(75);
      if (!(await live(record, root, uid))) return true;
    }
  }
  return !(await live(record, root, uid));
}

// The caller must be outside Codex's process tree (or a detached worker).
// Every matching session is gone before the caller may replace auth.json.
export async function quiesceCodexSessions(
  targetHome: string,
  options: SessionOptions = {},
): Promise<SessionResult> {
  const procRoot = options.procRoot ?? "/proc";
  const uid = options.uid ?? process.getuid?.();
  const wait = options.wait ?? sleep;
  const stopped = new Set<number>();
  let emptyScans = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const scan = await scanCodexProcesses(
      targetHome,
      procRoot,
      uid,
      options.fallbackHome ?? os.homedir(),
    );
    if (scan.inaccessible.length) throw new AppError("PROCESS_STOP_FAILED");
    if (!scan.matches.length) {
      if (++emptyScans >= 2) return { terminated: stopped.size };
      await wait(150);
      continue;
    }
    emptyScans = 0;
    for (const record of scan.matches) {
      try {
        if (!(await terminateOne(record, options)))
          throw new AppError("PROCESS_STOP_FAILED");
        stopped.add(record.pid);
      } catch {
        throw new AppError("PROCESS_STOP_FAILED");
      }
    }
    await wait(150);
  }
  throw new AppError("PROCESS_STOP_FAILED");
}
