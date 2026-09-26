import * as fs from "node:fs/promises";
import path from "node:path";
import { AppError, isErrno } from "../domain/errors.js";
export async function codexRunning(): Promise<boolean> {
  if (process.platform !== "linux") throw new AppError("UNSUPPORTED");
  let entries: string[];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    throw new AppError("UNSUPPORTED");
  }
  for (const pid of entries.filter((p) => /^\d+$/.test(p))) {
    if (Number(pid) === process.pid) continue;
    try {
      const st = await fs.stat(`/proc/${pid}`);
      if (process.getuid && st.uid !== process.getuid()) continue;
      const [comm, cmd] = await Promise.all([
        fs.readFile(`/proc/${pid}/comm`, "utf8"),
        fs.readFile(`/proc/${pid}/cmdline`, "utf8"),
      ]);
      const args = cmd.split("\0");
      if (
        /^codex(?:$|[-.])/i.test(comm.trim()) &&
        !/^codex-account/.test(comm.trim())
      )
        return true;
      const exe = path.basename(args[0] ?? "");
      if (/^codex(?:\.exe)?$/.test(exe)) return true;
      if (
        /^(node|nodejs|bun)(\.exe)?$/.test(exe) &&
        args.slice(1, 3).some((a) => /(?:^|\/)codex(?:\.js|\.mjs)?$/.test(a))
      )
        return true;
    } catch (e) {
      if (!isErrno(e, "ENOENT") && !isErrno(e, "ESRCH"))
        throw new AppError("UNSUPPORTED");
    }
  }
  return false;
}
