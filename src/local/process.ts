import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, isErrno } from "../domain/errors.js";

export interface CodexProcess {
  pid: number;
  ppid: number;
  startTime: string;
}

export interface ProcessScan {
  matches: CodexProcess[];
  inaccessible: number[];
}

function isCodex(comm: string, args: string[]): boolean {
  const name = comm.trim();
  if (/^codex(?:$|[-.])/i.test(name) && !/^codex-account/i.test(name))
    return true;
  const exe = path.basename(args[0] ?? "");
  if (/^codex(?:\.exe)?$/.test(exe)) return true;
  return (
    /^(node|nodejs|bun)(\.exe)?$/.test(exe) &&
    args.slice(1, 3).some((arg) => /(?:^|\/)codex(?:\.js|\.mjs)?$/.test(arg))
  );
}

export function parseProcessStat(raw: string): {
  state: string;
  ppid: number;
  startTime: string;
} {
  const close = raw.lastIndexOf(")");
  const fields = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (
    close < 0 ||
    !state ||
    !Number.isSafeInteger(ppid) ||
    !startTime ||
    !/^\d+$/.test(startTime)
  )
    throw new AppError("UNSUPPORTED");
  return { state, ppid, startTime };
}

function procEnv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const item of raw.split("\0")) {
    const equal = item.indexOf("=");
    if (equal > 0) values[item.slice(0, equal)] = item.slice(equal + 1);
  }
  return values;
}

function codexHome(
  env: Record<string, string>,
  fallbackHome: string,
): string | undefined {
  const home = env.CODEX_HOME || path.join(env.HOME || fallbackHome, ".codex");
  return path.isAbsolute(home) ? path.resolve(home) : undefined;
}

// Only same-user Codex executables with the same Codex home are eligible for
// termination. An unreadable environment is reported, never guessed.
export async function scanCodexProcesses(
  targetHome: string,
  procRoot = "/proc",
  uid = process.getuid?.(),
  fallbackHome = os.homedir(),
): Promise<ProcessScan> {
  if (process.platform !== "linux") throw new AppError("UNSUPPORTED");
  let entries: string[];
  try {
    entries = await fs.readdir(procRoot);
  } catch {
    throw new AppError("UNSUPPORTED");
  }
  const matches: CodexProcess[] = [];
  const inaccessible: number[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    const root = path.join(procRoot, name);
    try {
      const owner = await fs.stat(root);
      if (uid !== undefined && owner.uid !== uid) continue;
      const [comm, cmd] = await Promise.all([
        fs.readFile(path.join(root, "comm"), "utf8"),
        fs.readFile(path.join(root, "cmdline"), "utf8"),
      ]);
      if (!isCodex(comm, cmd.split("\0"))) continue;
      let env: string;
      try {
        env = await fs.readFile(path.join(root, "environ"), "utf8");
      } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) continue;
        inaccessible.push(pid);
        continue;
      }
      if (codexHome(procEnv(env), fallbackHome) !== path.resolve(targetHome))
        continue;
      const stat = parseProcessStat(
        await fs.readFile(path.join(root, "stat"), "utf8"),
      );
      if (stat.state !== "Z" && stat.state !== "X")
        matches.push({ pid, ppid: stat.ppid, startTime: stat.startTime });
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) continue;
      throw new AppError("UNSUPPORTED");
    }
  }
  return { matches, inaccessible };
}

export async function codexRunning(): Promise<boolean> {
  const scan = await scanCodexProcesses(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  );
  return scan.matches.length > 0 || scan.inaccessible.length > 0;
}

export async function hasCodexAncestor(
  targetHome: string,
  procRoot = "/proc",
  parentPid = process.ppid,
  fallbackHome = os.homedir(),
): Promise<boolean> {
  const scan = await scanCodexProcesses(
    targetHome,
    procRoot,
    process.getuid?.(),
    fallbackHome,
  );
  const matches = new Set(scan.matches.map((record) => record.pid));
  const inaccessible = new Set(scan.inaccessible);
  let pid = parentPid;
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    if (matches.has(pid) || inaccessible.has(pid)) return true;
    seen.add(pid);
    try {
      const raw = await fs.readFile(
        path.join(procRoot, String(pid), "stat"),
        "utf8",
      );
      pid = parseProcessStat(raw).ppid;
    } catch {
      break;
    }
  }
  return false;
}
