import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { validateUrl } from "./config.js";
import { AppError, isErrno, safeError } from "./domain/errors.js";
import { atomicWrite, directory, readPrivate } from "./local/files.js";
import { Store } from "./local/store.js";
import {
  kernelCache,
  sealVault,
  vaultPath,
  type KeyCache,
} from "./local/vault.js";
import { promptHidden } from "./local/terminal.js";
import { Client } from "./omniroute/client.js";
import { rememberSecret } from "./output.js";

const maxTokenLength = 8192;

export interface SetupResult {
  baseUrl: string;
  credentialStore: "encrypted local vault";
  warning?: string;
}

export interface SetupOptions {
  fetcher?: typeof fetch;
  writeConfig?: typeof atomicWrite;
  cache?: KeyCache;
}

export interface SetupQuestions {
  text(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  print(message: string): void;
}

function validateToken(token: string): void {
  if (!token || token.length > maxTokenLength || /[\x00-\x20\x7f]/.test(token))
    throw new AppError("CONFIG");
}

function oldVaultId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.managedVaultId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value.managedVaultId,
      )
    )
      return value.managedVaultId;
  } catch {
    // Invalid old config remains untouched until new setup commits.
  }
  return undefined;
}

export async function provision(
  home: string,
  baseUrlInput: string,
  token: string,
  passphrase: string,
  options: SetupOptions = {},
): Promise<SetupResult> {
  const baseUrl = validateUrl(baseUrlInput.trim());
  validateToken(token);
  if (passphrase.length < 12 || passphrase.length > 8192)
    throw new AppError("WEAK_PASSPHRASE");
  rememberSecret(token);
  rememberSecret(passphrase);
  const client = new Client({ baseUrl, token }, options.fetcher);
  await client.verifySetupAccess();

  const store = new Store(home);
  await store.init();
  const configPath = path.join(store.root, "config.json");
  const previous = await readPrivate(configPath);
  const previousId = oldVaultId(previous);
  const id = randomUUID();
  const { data, key } = await sealVault(id, baseUrl, token, passphrase);
  try {
    await atomicWrite(vaultPath(home, id), data);
    await (options.writeConfig ?? atomicWrite)(
      configPath,
      JSON.stringify({ managedVaultId: id }, null, 2) + "\n",
    );
  } catch (error) {
    // A directory fsync can fail after config rename. Keep its referenced vault.
    let referenced = true;
    try {
      referenced = oldVaultId(await readPrivate(configPath)) === id;
    } catch {
      /* Preserve uncertain state. */
    }
    if (!referenced) await fs.unlink(vaultPath(home, id)).catch(() => {});
    key.fill(0);
    throw error;
  }
  const cache = options.cache ?? kernelCache;
  const cached = await cache.put(id, key).catch(() => false);
  key.fill(0);
  let warning = cached
    ? undefined
    : "Session key cache unavailable. Enter the vault passphrase when running each command.";
  if (previousId && previousId !== id) {
    try {
      const oldPath = vaultPath(home, previousId);
      if (await readPrivate(oldPath)) await fs.unlink(oldPath);
      await cache.remove(previousId);
    } catch {
      warning =
        "Old vault cleanup failed; remove the previous vault file manually.";
    }
  }
  return { baseUrl, credentialStore: "encrypted local vault", warning };
}

export async function isConfigured(home = os.homedir()): Promise<boolean> {
  if (process.env.OMNIROUTE_URL && process.env.OMNIROUTE_MANAGEMENT_TOKEN)
    return true;
  const root = path.join(home, ".codex-accounts");
  try {
    await fs.lstat(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw new AppError("FILESYSTEM");
  }
  await directory(root);
  return (await readPrivate(path.join(root, "config.json"))) !== undefined;
}

export { promptHidden } from "./local/terminal.js";

function terminalQuestions(): SetupQuestions {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new AppError("SETUP_REQUIRED");
  return {
    async text(prompt) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return await rl.question(prompt);
      } catch {
        throw new AppError("SETUP_REQUIRED");
      } finally {
        rl.close();
      }
    },
    secret: (prompt) => promptHidden(prompt),
    print: (message) => process.stderr.write(`${message}\n`),
  };
}

export async function setupInteractive(
  home = os.homedir(),
  questions: SetupQuestions = terminalQuestions(),
  options: SetupOptions = {},
): Promise<SetupResult> {
  questions.print(
    "Enter the OmniRoute URL and an admin Access Token (oma_live_...).",
  );
  for (;;) {
    const baseUrl = await questions.text("OmniRoute URL: ");
    try {
      validateUrl(baseUrl.trim());
    } catch {
      questions.print("Use an HTTPS URL, or HTTP on exact loopback only.");
      continue;
    }
    const token = await questions.secret("Admin Access Token: ");
    const passphrase = await questions.secret(
      "New vault passphrase (at least 12 characters): ",
    );
    const confirmation = await questions.secret("Confirm vault passphrase: ");
    if (passphrase !== confirmation) {
      questions.print("Passphrases do not match. Try again.");
      continue;
    }
    try {
      return await provision(home, baseUrl, token, passphrase, options);
    } catch (error) {
      if (
        error instanceof AppError &&
        ["FILESYSTEM", "DURABILITY"].includes(error.code)
      )
        throw error;
      questions.print(safeError(error));
      questions.print("Try again, or press Ctrl+C to cancel.");
    }
  }
}
