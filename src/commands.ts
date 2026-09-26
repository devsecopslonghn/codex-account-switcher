import * as fs from "node:fs/promises";
import path from "node:path";
import { parseAuth, type ParsedAuth } from "./domain/auth.js";
import { resolveIdentity, type Connection } from "./domain/account.js";
import { AppError, safeError } from "./domain/errors.js";
import { type Vault } from "./omniroute/client.js";
import { Store } from "./local/store.js";
import { directory, readPrivate } from "./local/files.js";
import { acquireLock } from "./local/lock.js";
import { codexRunning } from "./local/process.js";
import { checkCodexConfig } from "./config.js";
export async function list(store: Store, vault: Vault): Promise<unknown> {
  const raw = await store.activeRaw(),
    active = raw === undefined ? undefined : parseAuth(raw),
    cs = await vault.list(),
    state = await store.state();
  let activeId: string | undefined, warning: string | undefined;
  if (active)
    try {
      activeId = resolveIdentity(cs, active.identity).id;
    } catch (e) {
      warning = safeError(e);
    }
  return {
    accounts: cs.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      status:
        c.id === activeId
          ? "ACTIVE_LOCAL"
          : state.accounts[c.id]?.status === "CONFLICT"
            ? "CONFLICT"
            : state.accounts[c.id]?.status === "REAUTH_REQUIRED" ||
                c.testStatus === "expired"
              ? "REAUTH_REQUIRED"
              : c.expiresAt && Date.parse(c.expiresAt) < Date.now()
                ? "STALE"
                : c.identity
                  ? "AVAILABLE"
                  : "UNKNOWN",
      active: c.id === activeId,
    })),
    warning,
  };
}
export async function current(
  store: Store,
  vault?: Vault,
  remoteError?: string,
): Promise<unknown> {
  const raw = await store.activeRaw();
  if (raw === undefined) throw new AppError("INVALID_AUTH");
  const a = parseAuth(raw);
  let c: Connection | undefined,
    warning = remoteError;
  if (vault)
    try {
      c = resolveIdentity(await vault.list(), a.identity);
    } catch (e) {
      warning = safeError(e);
    }
  const state = await store.state(),
    prior = c ? state.accounts[c.id] : undefined;
  return {
    status: "ACTIVE_LOCAL",
    identity: a.identity,
    expiresAt: a.expiresAt,
    expired: a.expiresAt ? Date.parse(a.expiresAt) < Date.now() : undefined,
    name: c?.name,
    connectionId: c?.id,
    syncStatus:
      prior?.status === "CONFLICT"
        ? "CONFLICT"
        : prior?.fingerprint === a.fingerprint
          ? "LAST_SYNC_MATCHES_LOCAL"
          : "UNSYNCED_OR_UNKNOWN",
    lastSync: prior?.syncedAt,
    warning,
  };
}
export async function doctor(
  store: Store,
  getVault: () => Promise<Vault>,
  home: string,
  running: () => Promise<boolean> = codexRunning,
): Promise<{
  ok: boolean;
  checks: { check: string; ok: boolean; detail: string }[];
}> {
  const checks: { check: string; ok: boolean; detail: string }[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ check: name, ok: true, detail: await fn() });
    } catch (e) {
      checks.push({ check: name, ok: false, detail: safeError(e) });
    }
  };
  let active: ParsedAuth | undefined,
    vault: Vault | undefined,
    cs: Connection[] = [];
  await check("codex-home", async () => {
    await store.activeRaw();
    return "Normal Codex home exists; no files modified.";
  });
  await check("file-auth-configuration", async () => {
    await checkCodexConfig(home);
    return "No incompatible local defaults detected. Check managed policy and external CLI overrides separately.";
  });
  await check("active-auth", async () => {
    const raw = await store.activeRaw();
    if (raw === undefined) throw new AppError("INVALID_AUTH");
    active = parseAuth(raw);
    return "Valid workspace and user identity; JWT signatures are not verified.";
  });
  await check("cache-permissions", async () => {
    await directory(store.root);
    await directory(store.backupDir);
    for (const f of await fs.readdir(store.root)) {
      if (f.endsWith(".json")) await readPrivate(path.join(store.root, f));
    }
    for (const f of await store.backups())
      await readPrivate(path.join(store.backupDir, f));
    await store.state();
    return "Private directories and files have restrictive ownership and modes.";
  });
  await check("application-lock", async () => {
    await directory(store.root);
    const release = await acquireLock(path.join(store.root, "lock"));
    await release();
    return "Unlocked; stale owner metadata is harmless and recovered by the kernel lock.";
  });
  await check("omniroute-config", async () => {
    vault = await getVault();
    return "Base URL and management credential are available.";
  });
  await check("connectivity-and-management-auth", async () => {
    if (!vault) throw new AppError("CONFIG");
    cs = await vault.list();
    return "Authenticated provider list succeeded (admin scope is checked when import/export runs).";
  });
  await check("active-mapping-and-conflict", async () => {
    if (!active) throw new AppError("INVALID_AUTH");
    const c = resolveIdentity(cs, active.identity),
      state = await store.state(),
      prior = state.accounts[c.id];
    if (
      prior?.status === "CONFLICT" ||
      (prior?.remoteRevision && prior.remoteRevision !== c.updatedAt)
    )
      throw new AppError("CONFLICT");
    return prior?.fingerprint === active.fingerprint
      ? "Strong identity matches; last sync fingerprint matches local."
      : "Strong identity matches; local credentials need synchronization or have no baseline.";
  });
  await check("codex-processes", async () => {
    if (await running()) throw new AppError("PROCESS_RUNNING");
    return "No current-user Codex process detected.";
  });
  return { ok: checks.every((c) => c.ok), checks };
}
