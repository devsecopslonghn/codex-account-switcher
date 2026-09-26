import path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  parseAuth,
  record,
  str,
  type Identity,
  type ParsedAuth,
  serialize,
} from "../domain/auth.js";
import { type AccountStatus, validId } from "../domain/account.js";
import { AppError, isErrno } from "../domain/errors.js";
import {
  atomicWrite,
  directory,
  readPrivate,
  type WriteHooks,
} from "./files.js";
import { acquireLock } from "./lock.js";
export interface AccountRecord {
  fingerprint?: string;
  remoteRevision?: string;
  syncedAt?: string;
  status: AccountStatus;
  identity?: Identity;
}
export interface State {
  version: 1;
  activeConnectionId?: string;
  accounts: Record<string, AccountRecord>;
}
const statuses: AccountStatus[] = [
  "ACTIVE_LOCAL",
  "AVAILABLE",
  "STALE",
  "CONFLICT",
  "REAUTH_REQUIRED",
  "UNKNOWN",
];
export class Store {
  readonly root: string;
  readonly codex: string;
  readonly authPath: string;
  readonly backupDir: string;
  constructor(
    home: string,
    readonly hooks: WriteHooks = {},
  ) {
    this.root = path.join(home, ".codex-accounts");
    this.codex = path.join(home, ".codex");
    this.authPath = path.join(this.codex, "auth.json");
    this.backupDir = path.join(this.root, "backups");
  }
  async init(): Promise<void> {
    await directory(this.root, true);
    await directory(this.backupDir, true);
  }
  async lock(): Promise<() => Promise<void>> {
    await this.init();
    const release = await acquireLock(path.join(this.root, "lock"));
    try {
      // Remove only this utility's abandoned staging names, after exclusive lock.
      for (const dir of [this.root, this.backupDir, this.codex]) {
        if (dir === this.codex) await this.activeRaw();
        for (const name of await fs.readdir(dir))
          if (/^\.codex-account-[0-9a-f-]{36}\.tmp$/.test(name))
            await fs.unlink(path.join(dir, name));
      }
      return release;
    } catch (e) {
      await release();
      throw e;
    }
  }
  async activeRaw(): Promise<string | undefined> {
    // Codex home is shared, so never chmod it. Reject symlinks and writable-by-others directories.
    try {
      const s = await fs.lstat(this.codex);
      if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        s.mode & 0o022 ||
        (process.getuid && s.uid !== process.getuid())
      )
        throw new Error();
    } catch {
      throw new AppError("FILESYSTEM");
    }
    return readPrivate(this.authPath);
  }
  cachePath(id: string): string {
    if (!validId(id)) throw new AppError("PROTOCOL");
    return path.join(this.root, `${id}.json`);
  }
  async cache(id: string): Promise<ParsedAuth | undefined> {
    const raw = await readPrivate(this.cachePath(id));
    return raw === undefined ? undefined : parseAuth(raw);
  }
  async saveCache(id: string, a: ParsedAuth): Promise<void> {
    await atomicWrite(this.cachePath(id), serialize(a));
  }
  async state(): Promise<State> {
    try {
      await fs.lstat(this.root);
    } catch (e) {
      if (isErrno(e, "ENOENT")) return { version: 1, accounts: {} };
      throw new AppError("FILESYSTEM");
    }
    await directory(this.root);
    const raw = await readPrivate(path.join(this.root, "state.json"));
    if (raw === undefined) return { version: 1, accounts: {} };
    try {
      const d = record(JSON.parse(raw));
      if (d.version !== 1) throw new Error();
      const accounts: Record<string, AccountRecord> = Object.create(
        null,
      ) as Record<string, AccountRecord>;
      for (const [id, value] of Object.entries(record(d.accounts))) {
        if (!validId(id)) throw new Error();
        const a = record(value);
        if (!statuses.includes(a.status as AccountStatus)) throw new Error();
        if (
          a.fingerprint !== undefined &&
          (typeof a.fingerprint !== "string" ||
            !/^[a-f0-9]{64}$/.test(a.fingerprint))
        )
          throw new Error();
        const i = record(a.identity);
        accounts[id] = {
          fingerprint: str(a.fingerprint),
          remoteRevision: str(a.remoteRevision),
          syncedAt: str(a.syncedAt),
          status: a.status as AccountStatus,
          identity:
            str(i.workspaceId) && str(i.userId)
              ? {
                  workspaceId: i.workspaceId as string,
                  userId: i.userId as string,
                  email: str(i.email),
                }
              : undefined,
        };
      }
      if (
        d.activeConnectionId !== undefined &&
        (typeof d.activeConnectionId !== "string" ||
          !validId(d.activeConnectionId))
      )
        throw new Error();
      return {
        version: 1,
        activeConnectionId: str(d.activeConnectionId),
        accounts,
      };
    } catch {
      throw new AppError("FILESYSTEM");
    }
  }
  async saveState(s: State): Promise<void> {
    await atomicWrite(
      path.join(this.root, "state.json"),
      JSON.stringify(s, null, 2) + "\n",
    );
  }
  async backup(raw: string): Promise<void> {
    parseAuth(raw);
    await atomicWrite(
      path.join(
        this.backupDir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`,
      ),
      raw,
    );
    await this.prune();
  }
  async backups(): Promise<string[]> {
    await directory(this.backupDir);
    return (await fs.readdir(this.backupDir))
      .filter((f) => /^\d{4}-.*\.json$/.test(f))
      .sort()
      .reverse();
  }
  async prune(): Promise<void> {
    for (const f of (await this.backups()).slice(5))
      await fs.unlink(path.join(this.backupDir, f));
  }
  async replace(
    raw: string,
    expected: string | undefined,
    guard: () => Promise<void>,
  ): Promise<void> {
    parseAuth(raw);
    try {
      await atomicWrite(this.authPath, raw, {
        afterRename: this.hooks.afterRename,
        beforeRename: async (file) => {
          await this.hooks.beforeRename?.(file);
          await guard();
          if ((await this.activeRaw()) !== expected)
            throw new AppError("CHANGED");
        },
      });
    } catch (e) {
      if (e instanceof AppError && e.code === "DURABILITY")
        throw new AppError("COMMITTED");
      throw e;
    }
  }
}
