import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, isErrno } from "../domain/errors.js";
export async function directory(dir: string, create = false): Promise<void> {
  try {
    if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const s = await fs.lstat(dir);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      (process.getuid && s.uid !== process.getuid()) ||
      s.mode & 0o077
    )
      throw new AppError("FILESYSTEM");
  } catch {
    throw new AppError("FILESYSTEM");
  }
}
export async function readPrivate(file: string): Promise<string | undefined> {
  let f: fs.FileHandle | undefined;
  try {
    f = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const s = await f.stat();
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.size > 262144 ||
      s.mode & 0o077 ||
      (process.getuid && s.uid !== process.getuid())
    )
      throw new AppError("FILESYSTEM");
    return await f.readFile("utf8");
  } catch (e) {
    if (isErrno(e, "ENOENT")) return undefined;
    throw new AppError("FILESYSTEM");
  } finally {
    await f?.close();
  }
}
export async function assertRegularDestination(file: string): Promise<void> {
  try {
    const s = await fs.lstat(file);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      (process.getuid && s.uid !== process.getuid())
    )
      throw new AppError("FILESYSTEM");
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw new AppError("FILESYSTEM");
  }
}
export interface WriteHooks {
  beforeRename?: (file: string) => Promise<void>;
  afterRename?: (file: string) => Promise<void>;
}
export async function atomicWrite(
  file: string,
  data: string,
  hooks: WriteHooks = {},
): Promise<void> {
  const tmp = path.join(
    path.dirname(file),
    `.codex-account-${randomUUID()}.tmp`,
  );
  let f: fs.FileHandle | undefined;
  let renamed = false;
  try {
    await assertRegularDestination(file);
    f = await fs.open(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await f.writeFile(data, "utf8");
    await f.sync();
    await f.close();
    f = undefined;
    await hooks.beforeRename?.(file);
    await assertRegularDestination(file);
    await fs.rename(tmp, file);
    renamed = true;
    await hooks.afterRename?.(file);
    const dir = await fs.open(
      path.dirname(file),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (e) {
    if (renamed) throw new AppError("DURABILITY");
    if (e instanceof AppError) throw e;
    throw new AppError("FILESYSTEM");
  } finally {
    await f?.close();
    if (!renamed) await fs.unlink(tmp).catch(() => {});
  }
}
