#!/usr/bin/env node
import os from "node:os";
import { readFile } from "node:fs/promises";
import { checkCodexConfig, loadConfig } from "./config.js";
import { safeError, AppError } from "./domain/errors.js";
import { Store } from "./local/store.js";
import { refreshCodexDaemon } from "./local/daemon.js";
import { Client, type Vault } from "./omniroute/client.js";
import { Engine } from "./sync/engine.js";
import { current, doctor, list } from "./commands.js";
import { safeOutput } from "./output.js";
import { isConfigured, setupInteractive } from "./setup.js";
import {
  commandHelp,
  globalHelp,
  isCommandName,
  isHelpFlag,
  type CommandName,
} from "./help.js";

function usageError(command?: CommandName): void {
  const hint = command
    ? `codex-account ${command} --help`
    : "codex-account --help";
  process.stderr.write(`USAGE: Invalid command or arguments. Run '${hint}'.\n`);
  process.exitCode = 2;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "help" || isHelpFlag(command ?? "")) {
    if (args.length === 0) process.stdout.write(globalHelp());
    else if (args.length === 1 && isCommandName(args[0]!))
      process.stdout.write(commandHelp(args[0]!));
    else usageError();
    return;
  }
  if (command === "--version" || command === "-V") {
    if (args.length !== 0) return usageError();
    const metadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`${metadata.version}\n`);
    return;
  }
  if (
    command &&
    isCommandName(command) &&
    args.length === 1 &&
    isHelpFlag(args[0]!)
  ) {
    process.stdout.write(commandHelp(command));
    return;
  }
  const home = os.homedir();
  if (!command) {
    if (await isConfigured(home)) process.stdout.write(globalHelp());
    else process.stdout.write(safeOutput(await setupInteractive(home)) + "\n");
    return;
  }
  if (!isCommandName(command)) return usageError();
  const forceFlags = args.filter((arg) => arg === "--force" || arg === "-f");
  const selectors = args.filter((arg) => arg !== "--force" && arg !== "-f");
  if (
    command === "use"
      ? selectors.length !== 1 ||
        selectors[0]!.startsWith("-") ||
        forceFlags.length > 1
      : args.length !== 0
  )
    return usageError(command);
  if (command === "setup" && args.length === 0) {
    process.stdout.write(safeOutput(await setupInteractive(home)) + "\n");
    return;
  }
  const force = forceFlags.length === 1;
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
  if (command === "use") {
    r.daemon = await refreshCodexDaemon();
    if (r.daemon === "failed") {
      r.warnings.push(
        "CODEX_DAEMON: Local auth was updated, but the Codex background server could not be restarted. Its running sessions may still use the previous account.",
      );
      process.exitCode = 1;
    }
  }
  process.stdout.write(safeOutput(r) + "\n");
  if (r.failures?.length) process.exitCode = 1;
}
main().catch((error: unknown) => {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
});
