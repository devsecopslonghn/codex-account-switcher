import path from "node:path";
import * as fs from "node:fs/promises";
import {
  type ParsedAuth,
  parseAuth,
  sameIdentity,
  serialize,
} from "../domain/auth.js";
import { type Connection, resolveIdentity, select } from "../domain/account.js";
import { AppError, safeError } from "../domain/errors.js";
import { type Vault } from "../omniroute/client.js";
import { Store, type State } from "../local/store.js";
import { readPrivate } from "../local/files.js";
import { codexRunning } from "../local/process.js";
export interface Report {
  action: string;
  connectionId?: string;
  warnings: string[];
  daemon?: "not-running" | "restarted" | "failed";
  failures?: { connectionId: string; error: string }[];
}
const runningWarning =
  "FORCED_SWITCH: Running Codex processes may keep the previous account in memory or later refresh and overwrite auth.json. The managed background server will be restarted if available; restart independent IDE sessions before using the selected account.";
export class Engine {
  constructor(
    readonly store: Store,
    readonly vault: Vault,
    readonly running: () => Promise<boolean> = codexRunning,
  ) {}
  private async stopped(force = false, warnings?: string[]): Promise<void> {
    if (!(await this.running())) return;
    if (!force) throw new AppError("PROCESS_RUNNING");
    if (warnings && !warnings.includes(runningWarning))
      warnings.push(runningWarning);
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.store.lock();
    try {
      return await fn();
    } finally {
      await release();
    }
  }
  private async unchanged(raw: string | undefined): Promise<void> {
    if ((await this.store.activeRaw()) !== raw) throw new AppError("CHANGED");
  }
  private async push(
    raw: string,
    connections: Connection[],
    state: State,
    warnings: string[],
  ): Promise<Connection> {
    const a = parseAuth(raw),
      c = resolveIdentity(connections, a.identity),
      prior = state.accounts[c.id];
    const remoteChanged =
      !!prior?.remoteRevision && c.updatedAt !== prior.remoteRevision;
    const localChanged =
      !!prior?.fingerprint && a.fingerprint !== prior.fingerprint;
    if (remoteChanged)
      warnings.push(
        localChanged
          ? "CONFLICT: Both active local credentials and the remote revision changed; active local credentials take precedence."
          : "CONFLICT: Remote revision changed while local credentials were unchanged; active local credentials take precedence.",
      );
    await this.store.saveCache(c.id, a);
    try {
      await this.unchanged(raw);
      const imported = await this.vault.importAuth(a, c.id);
      state.activeConnectionId = c.id;
      state.accounts[c.id] = {
        fingerprint: a.fingerprint,
        remoteRevision: imported.updatedAt,
        syncedAt: new Date().toISOString(),
        status: remoteChanged ? "CONFLICT" : "ACTIVE_LOCAL",
        identity: a.identity,
      };
      await this.store.saveState(state);
      await this.unchanged(raw);
      return c;
    } catch (e) {
      state.accounts[c.id] = {
        ...prior,
        status:
          e instanceof AppError && e.code === "REAUTH_REQUIRED"
            ? "REAUTH_REQUIRED"
            : "STALE",
        identity: a.identity,
      };
      await this.store.saveState(state);
      throw e;
    }
  }
  async sync(all = false): Promise<Report> {
    return this.locked(async () => {
      const raw = await this.store.activeRaw();
      if (raw === undefined) throw new AppError("INVALID_AUTH");
      parseAuth(raw);
      const connections = await this.vault.list(),
        state = await this.store.state(),
        warnings: string[] = [];
      const active = await this.push(raw, connections, state, warnings);
      const failures: { connectionId: string; error: string }[] = [];
      if (all)
        for (const c of connections) {
          if (c.id === active.id) continue;
          try {
            await this.unchanged(raw);
            await this.pull(c, state, connections);
          } catch (e) {
            if (e instanceof AppError && e.code === "CHANGED") throw e;
            state.accounts[c.id] = {
              ...state.accounts[c.id],
              status:
                e instanceof AppError && e.code === "CONFLICT"
                  ? "CONFLICT"
                  : e instanceof AppError && e.code === "REAUTH_REQUIRED"
                    ? "REAUTH_REQUIRED"
                    : "UNKNOWN",
            };
            failures.push({ connectionId: c.id, error: safeError(e) });
          }
        }
      await this.store.saveState(state);
      await this.unchanged(raw);
      return {
        action: all ? "sync-all" : "sync",
        connectionId: active.id,
        warnings,
        failures,
      };
    });
  }
  private async pull(
    c: Connection,
    state: State,
    connections: Connection[],
  ): Promise<ParsedAuth> {
    if (!c.identity) throw new AppError("NOT_FOUND");
    if (resolveIdentity(connections, c.identity).id !== c.id)
      throw new AppError("AMBIGUOUS");
    const cached = await this.store.cache(c.id),
      prior = state.accounts[c.id];
    // Without a baseline we cannot know whether a credential file is an independent edit.
    if (
      cached &&
      (!prior?.fingerprint || cached.fingerprint !== prior.fingerprint)
    )
      throw new AppError("CONFLICT");
    const a = await this.vault.exportAuth(c.id);
    if (!sameIdentity(a.identity, c.identity))
      throw new AppError("IDENTITY_MISMATCH");
    await this.store.saveCache(c.id, a);
    // Export can rotate credentials, so obtain a fresh metadata revision after export.
    const latest = resolveIdentity(await this.vault.list(), a.identity);
    if (latest.id !== c.id) throw new AppError("IDENTITY_MISMATCH");
    state.accounts[c.id] = {
      fingerprint: a.fingerprint,
      remoteRevision: latest.updatedAt,
      syncedAt: new Date().toISOString(),
      status:
        a.expiresAt && Date.parse(a.expiresAt) <= Date.now()
          ? "STALE"
          : "AVAILABLE",
      identity: a.identity,
    };
    await this.store.saveState(state);
    return a;
  }
  async use(selector: string, force = false): Promise<Report> {
    return this.locked(async () => {
      const warnings: string[] = [];
      await this.stopped(force, warnings);
      const raw = await this.store.activeRaw();
      if (raw !== undefined) parseAuth(raw);
      const connections = await this.vault.list(),
        state = await this.store.state();
      // Resolve selector before remote mutations; every selected identity must be unique.
      const target = select(connections, selector);
      if (!target.identity) throw new AppError("NOT_FOUND");
      resolveIdentity(connections, target.identity);
      const active =
        raw !== undefined
          ? await this.push(raw, connections, state, warnings)
          : undefined;
      if (active?.id === target.id)
        return { action: "already-active", connectionId: target.id, warnings };
      let auth: ParsedAuth;
      try {
        auth = await this.pull(target, state, connections);
      } catch (e) {
        state.accounts[target.id] = {
          ...state.accounts[target.id],
          status:
            e instanceof AppError && e.code === "REAUTH_REQUIRED"
              ? "REAUTH_REQUIRED"
              : e instanceof AppError && e.code === "CONFLICT"
                ? "CONFLICT"
                : "UNKNOWN",
        };
        await this.store.saveState(state);
        throw e;
      }
      if (auth.expiresAt && Date.parse(auth.expiresAt) <= Date.now())
        throw new AppError("REFRESH_FAILED");
      await this.unchanged(raw);
      if (raw !== undefined) await this.store.backup(raw);
      await this.store.replace(serialize(auth), raw, () =>
        this.stopped(force, warnings),
      );
      try {
        if (active && state.accounts[active.id])
          state.accounts[active.id]!.status = "AVAILABLE";
        state.activeConnectionId = target.id;
        state.accounts[target.id]!.status = "ACTIVE_LOCAL";
        await this.store.saveState(state);
      } catch {
        throw new AppError("COMMITTED");
      }
      return { action: "use", connectionId: target.id, warnings };
    });
  }
  async rollback(): Promise<Report> {
    return this.locked(async () => {
      await this.stopped();
      const raw = await this.store.activeRaw();
      let current: ParsedAuth | undefined;
      try {
        if (raw !== undefined) current = parseAuth(raw);
      } catch {
        /* Recovery is allowed from malformed active auth. */
      }
      let selected: { file: string; raw: string; auth: ParsedAuth } | undefined;
      for (const file of await this.store.backups()) {
        try {
          const r = await readPrivate(path.join(this.store.backupDir, file));
          if (r === undefined) continue;
          const a = parseAuth(r);
          if (a.fingerprint !== current?.fingerprint) {
            selected = { file, raw: r, auth: a };
            break;
          }
        } catch {
          /* Skip invalid backups, never restore them. */
        }
      }
      if (!selected) throw new AppError("NO_BACKUP");
      let state: State;
      try {
        state = await this.store.state();
      } catch {
        state = { version: 1, accounts: {} };
      }
      if (current && raw !== undefined) {
        const ids = Object.entries(state.accounts)
          .filter(
            ([, a]) =>
              a.identity && sameIdentity(a.identity, current!.identity),
          )
          .map(([id]) => id);
        if (ids.length === 1) {
          await this.store.saveCache(ids[0]!, current);
          state.accounts[ids[0]!]!.status = "STALE";
        }
        await this.store.backup(raw);
      }
      await this.store.replace(selected.raw, raw, () => this.stopped());
      try {
        const ids = Object.entries(state.accounts)
          .filter(
            ([, a]) =>
              a.identity && sameIdentity(a.identity, selected!.auth.identity),
          )
          .map(([id]) => id);
        state.activeConnectionId = ids.length === 1 ? ids[0] : undefined;
        if (state.activeConnectionId)
          state.accounts[state.activeConnectionId]!.status = "STALE";
        await this.store.saveState(state);
        await fs
          .unlink(path.join(this.store.backupDir, selected.file))
          .catch(() => {});
      } catch {
        throw new AppError("COMMITTED");
      }
      return {
        action: "rollback",
        connectionId: state.activeConnectionId,
        warnings: [
          "Restored tokens may have been revoked or rotated. Rollback restores the file, not server-side validity; sync before switching again.",
        ],
      };
    });
  }
}
