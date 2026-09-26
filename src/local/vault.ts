import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import { AppError } from "../domain/errors.js";
import { readPrivate } from "./files.js";
import { promptHidden } from "./terminal.js";

const run = promisify(execFile);
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const kdfOptions = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export interface KeyCache {
  get(id: string): Promise<Buffer | undefined>;
  put(id: string, key: Buffer): Promise<boolean>;
  remove(id: string): Promise<void>;
}

async function keyctlPath(): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, "keyctl");
    try {
      const stat = await fs.stat(file);
      await fs.access(file, constants.X_OK);
      if (stat.isFile()) return file;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

const cacheName = (id: string) => `codex-account-vault-${id}`;

export const kernelCache: KeyCache = {
  async get(id) {
    const executable = await keyctlPath();
    if (!executable) return undefined;
    try {
      const { stdout } = await run(
        executable,
        ["search", "@u", "user", cacheName(id)],
        { timeout: 3000, maxBuffer: 100 },
      );
      const keyId = stdout.trim();
      if (!/^\d+$/.test(keyId)) return undefined;
      const value = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(executable, ["pipe", keyId], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        const chunks: Buffer[] = [];
        let size = 0;
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 32) child.kill();
          else chunks.push(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 && size === 32
            ? resolve(Buffer.concat(chunks))
            : reject(new Error("keyctl unavailable")),
        );
      });
      return value;
    } catch {
      return undefined;
    }
  },
  async put(id, key) {
    const executable = await keyctlPath();
    if (!executable) return false;
    // A new session keyring grants possession during creation; the user keyring
    // then retains the key for later CLI processes in the same login session.
    const script =
      `key="$1"; name="$2";\n` +
      `kid=$("$key" padd user "$name" @s) || exit 1\n` +
      `"$key" setperm "$kid" 0x3f3f0000 && "$key" link "$kid" @u`;
    return await new Promise<boolean>((resolve) => {
      const child = spawn(
        executable,
        [
          "session",
          `codex-account-${id}`,
          "/bin/sh",
          "-c",
          script,
          "sh",
          executable,
          cacheName(id),
        ],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      timer.unref();
      child.stdin.on("error", () => {});
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      child.stdin.end(key);
    });
  },
  async remove(id) {
    const executable = await keyctlPath();
    if (!executable) return;
    try {
      const { stdout } = await run(
        executable,
        ["search", "@u", "user", cacheName(id)],
        { timeout: 3000 },
      );
      if (/^\d+\s*$/.test(stdout))
        await run(executable, ["unlink", stdout.trim(), "@u"], {
          timeout: 3000,
        });
    } catch {
      // Expired or inaccessible cache is already unusable.
    }
  },
};

interface VaultFile {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function decode(value: unknown, bytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new AppError("VAULT_CORRUPT");
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value || (bytes && data.length !== bytes))
    throw new AppError("VAULT_CORRUPT");
  return data;
}

async function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scryptCallback(passphrase, salt, 32, kdfOptions, (error, key) =>
        error ? reject(error) : resolve(key),
      ),
    );
  } catch {
    throw new AppError("VAULT_CORRUPT");
  }
}

export function vaultPath(home: string, id: string): string {
  if (!idPattern.test(id)) throw new AppError("CONFIG");
  return path.join(home, ".codex-accounts", `vault-${id}.json`);
}

export async function sealVault(
  id: string,
  baseUrl: string,
  token: string,
  passphrase: string,
): Promise<{ data: string; key: Buffer }> {
  if (!idPattern.test(id)) throw new AppError("CONFIG");
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const key = await derive(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`codex-account-vault-v1:${id}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ baseUrl, token }), "utf8"),
    cipher.final(),
  ]);
  const data: VaultFile = {
    version: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return { data: JSON.stringify(data, null, 2) + "\n", key };
}

export interface VaultOptions {
  cache?: KeyCache;
  prompt?: (message: string) => Promise<string>;
}

export async function openVault(
  home: string,
  id: string,
  options: VaultOptions = {},
): Promise<{ baseUrl: string; token: string }> {
  const raw = await readPrivate(vaultPath(home, id));
  if (!raw) throw new AppError("VAULT_CORRUPT");
  let data: VaultFile;
  try {
    data = JSON.parse(raw) as VaultFile;
    if (data.version !== 1) throw new Error();
  } catch {
    throw new AppError("VAULT_CORRUPT");
  }
  const salt = decode(data.salt, 16),
    iv = decode(data.iv, 12);
  const tag = decode(data.tag, 16),
    ciphertext = decode(data.ciphertext);
  const decrypt = (key: Buffer) => {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`codex-account-vault-v1:${id}`));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const result = JSON.parse(plain.toString("utf8")) as {
      baseUrl: string;
      token: string;
    };
    if (typeof result.baseUrl !== "string" || typeof result.token !== "string")
      throw new Error();
    return result;
  };
  const cache = options.cache ?? kernelCache;
  const cached = await cache.get(id).catch(() => undefined);
  if (cached) {
    try {
      return decrypt(cached);
    } catch {
      await cache.remove(id).catch(() => {});
    } finally {
      cached.fill(0);
    }
  }
  if (!options.prompt && (!process.stdin.isTTY || !process.stderr.isTTY))
    throw new AppError("VAULT_LOCKED");
  const prompt = options.prompt ?? ((message: string) => promptHidden(message));
  for (let attempt = 0; attempt < 3; attempt++) {
    const passphrase = await prompt("Vault passphrase: ");
    const key = await derive(passphrase, salt);
    let result: { baseUrl: string; token: string };
    try {
      result = decrypt(key);
    } catch {
      key.fill(0);
      if (attempt === 2) throw new AppError("VAULT_UNLOCK_FAILED");
      process.stderr.write("Incorrect vault passphrase; try again.\n");
      continue;
    }
    await cache.put(id, key).catch(() => false);
    key.fill(0);
    return result;
  }
  throw new AppError("VAULT_UNLOCK_FAILED");
}
