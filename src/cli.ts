#!/usr/bin/env node
import os from "node:os";
import { readFile } from "node:fs/promises";
import { checkCodexConfig, loadConfig } from "./config.js";
import { safeError, AppError } from "./domain/errors.js";
import { Store } from "./local/store.js";
import { Client, type Vault } from "./omniroute/client.js";
import { Engine } from "./sync/engine.js";
import { current, doctor, list } from "./commands.js";
import { safeOutput } from "./output.js";
import { isConfigured, setupInteractive } from "./setup.js";
const help = `codex-account — official Codex OAuth account manager\n\nCommands:\n  setup                      Save URL and admin token in an encrypted local vault\n  list                       List OmniRoute Codex OAuth accounts\n  current                    Show active local identity and sync status\n  sync                       Push authoritative active auth to OmniRoute\n  sync-all                   Push active auth; pull inactive account caches\n  use <selector> [--force]   Switch by unique ID, ID prefix, name, or email\n  rollback                   Restore latest valid distinct backup (offline)\n  doctor                     Check configuration, auth, permissions, connectivity, locks\n\nOnly ~/.codex/auth.json switches. Close Codex before use/rollback.\nUse --force only if you accept that running Codex processes may retain or overwrite old credentials; restart them after switching.\nRun codex-account setup once; later commands reuse a session key, or ask for the vault passphrase.\nExplicit credential helpers and secret-manager environment injection also work.\nNo token command-line arguments are accepted. See README for setup.\n`;
const useHelp = `Usage: codex-account use <selector> [--force]\n\nChoose a connection by full ID, unique ID prefix, name, or email. Use the full ID to avoid ambiguity.\nNormally all Codex CLI and IDE processes must be closed first.\n--force bypasses only the running-process check. A live Codex process may continue using the old account or refresh and overwrite auth.json after the switch. Restart all Codex sessions immediately afterward. File, identity, lock, and backup checks still apply.\n`;
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "help") {
    process.stdout.write(help);
    return;
  }
  if (command === "--version") {
    const metadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`${metadata.version}\n`);
    return;
  }
  if (command === "use" && args.length === 1 && args[0] === "--help") {
    process.stdout.write(useHelp);
    return;
  }
  const home = os.homedir();
  if (!command) {
    if (await isConfigured(home)) process.stdout.write(help);
    else process.stdout.write(safeOutput(await setupInteractive(home)) + "\n");
    return;
  }
  if (command === "setup" && args.length === 0) {
    process.stdout.write(safeOutput(await setupInteractive(home)) + "\n");
    return;
  }
  const force = command === "use" && args.includes("--force");
  const selectors =
    command === "use" ? args.filter((arg) => arg !== "--force") : [];
  if (
    ![
      "list",
      "current",
      "sync",
      "sync-all",
      "use",
      "rollback",
      "doctor",
    ].includes(command) ||
    (command === "use"
      ? selectors.length !== 1 ||
        selectors[0]!.startsWith("-") ||
        args.length !== selectors.length + Number(force)
      : args.length !== 0)
  )
    throw new AppError("CONFIG");
  const store = new Store(home),
    getVault = async () => new Client(await loadConfig(home));
  if (command === "doctor") {
    const r = await doctor(store, getVault, home);
    process.stdout.write(safeOutput(r) + "\n");
    if (!r.ok) process.exitCode = 1;
    return;
  }
  await checkCodexConfig(home);
  if (command === "rollback") {
    // Deliberately avoid loading management configuration or touching the network.
    const unavailable: Vault = {
      list: async () => {
        throw new AppError("CONFIG");
      },
      exportAuth: async () => {
        throw new AppError("CONFIG");
      },
      importAuth: async () => {
        throw new AppError("CONFIG");
      },
      health: async () => {
        throw new AppError("CONFIG");
      },
    };
    process.stdout.write(
      safeOutput(await new Engine(store, unavailable).rollback()) + "\n",
    );
    return;
  }
  if (command === "current") {
    let vault: Vault | undefined, error: string | undefined;
    try {
      vault = await getVault();
    } catch (e) {
      error = safeError(e);
    }
    process.stdout.write(safeOutput(await current(store, vault, error)) + "\n");
    return;
  }
  const vault = await getVault();
  if (command === "list") {
    process.stdout.write(safeOutput(await list(store, vault)) + "\n");
    return;
  }
  const engine = new Engine(store, vault),
    r =
      command === "use"
        ? await engine.use(selectors[0]!, force)
        : await engine.sync(command === "sync-all");
  process.stdout.write(safeOutput(r) + "\n");
  if (r.failures?.length) process.exitCode = 1;
}
main().catch((error: unknown) => {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
});
