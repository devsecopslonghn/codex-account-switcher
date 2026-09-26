import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setup } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { AppError } from "../src/domain/errors.js";
import { doctor } from "../src/commands.js";
import { safeOutput } from "../src/output.js";
import { promptHidden, provision, setupInteractive } from "../src/setup.js";
import {
  kernelCache,
  openVault,
  vaultPath,
  type KeyCache,
} from "../src/local/vault.js";

const run = promisify(execFile);
const token = "FAKE_MANAGEMENT_SECRET";
const passphrase = "test passphrase 12345";
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;

function fakeCache(): KeyCache {
  const keys = new Map<string, Buffer>();
  return {
    get: async (id) => {
      const found = keys.get(id);
      return found && Buffer.from(found);
    },
    put: async (id, key) => {
      keys.set(id, Buffer.from(key));
      return true;
    },
    remove: async (id) => {
      keys.delete(id);
    },
  };
}

test("setup validates admin access, encrypts token on disk, and reuses session key", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const cache = fakeCache();
  const result = await provision(f.home, f.server.url, token, passphrase, {
    cache,
  });
  assert.equal(result.credentialStore, "encrypted local vault");
  const configPath = path.join(f.store.root, "config.json");
  const config = await fs.readFile(configPath, "utf8");
  const id = (JSON.parse(config) as { managedVaultId: string }).managedVaultId;
  const vault = await fs.readFile(vaultPath(f.home, id), "utf8");
  assert.ok(!config.includes(token));
  assert.ok(!vault.includes(token));
  assert.ok(!vault.includes(passphrase));
  assert.equal((await fs.stat(configPath)).mode & 0o077, 0);
  assert.equal((await fs.stat(vaultPath(f.home, id))).mode & 0o077, 0);
  assert.equal(
    (await loadConfig(f.home, { PATH: process.env.PATH }, { cache })).token,
    token,
  );
  assert.ok(!safeOutput({ value: token }).includes(token));
  await assert.rejects(
    run(process.execPath, ["--import", "tsx", "src/cli.ts", "list"], {
      env: { HOME: f.home, PATH: process.env.PATH },
      timeout: 10000,
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      String(error.stderr).includes("VAULT_LOCKED"),
  );
});

test("Linux kernel cache lets another CLI process use the encrypted vault", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const result = await provision(f.home, f.server.url, token, passphrase, {
    cache: kernelCache,
  });
  const config = JSON.parse(
    await fs.readFile(path.join(f.store.root, "config.json"), "utf8"),
  ) as { managedVaultId: string };
  t.after(() => kernelCache.remove(config.managedVaultId));
  if (result.warning) {
    t.skip("keyctl session cache unavailable on this host");
    return;
  }
  const cli = await run(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "list"],
    {
      env: { HOME: f.home, PATH: process.env.PATH },
      timeout: 10000,
    },
  );
  assert.match(cli.stdout, /ACTIVE_LOCAL/);
  assert.ok(!cli.stdout.includes(token));
  assert.equal(cli.stderr, "");
});

test("setup rejects wrong credentials and non-admin Access Tokens before writing", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  await assert.rejects(
    provision(f.home, f.server.url, "WRONG_SECRET", passphrase),
    code("AUTHENTICATION"),
  );
  f.server.whoamiScope = "read";
  await assert.rejects(
    provision(f.home, f.server.url, token, passphrase),
    code("AUTHORIZATION"),
  );
  f.server.whoamiScope = "admin";
  f.server.whoamiViaAccessToken = false;
  await assert.rejects(
    provision(f.home, f.server.url, token, passphrase),
    code("AUTHORIZATION"),
  );
  await assert.rejects(
    fs.stat(path.join(f.store.root, "config.json")),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT",
  );
});

test("wrong passphrase retries; corrupted vault and failed config write preserve old setup", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const cache = fakeCache();
  await provision(f.home, f.server.url, token, passphrase, { cache });
  const configPath = path.join(f.store.root, "config.json");
  const before = await fs.readFile(configPath, "utf8");
  const oldId = (JSON.parse(before) as { managedVaultId: string })
    .managedVaultId;
  await assert.rejects(
    provision(f.home, f.server.url, token, passphrase, {
      cache,
      writeConfig: async () => {
        throw new AppError("FILESYSTEM");
      },
    }),
    code("FILESYSTEM"),
  );
  assert.equal(await fs.readFile(configPath, "utf8"), before);
  assert.deepEqual(
    (await fs.readdir(f.store.root)).filter((name) =>
      name.startsWith("vault-"),
    ),
    [`vault-${oldId}.json`],
  );
  await cache.remove(oldId);
  let attempts = 0;
  const recovered = await openVault(f.home, oldId, {
    cache,
    prompt: async () => {
      attempts++;
      return attempts === 1 ? "wrong password" : passphrase;
    },
  });
  assert.equal(recovered.token, token);
  assert.equal(attempts, 2);
  await cache.remove(oldId);
  const file = vaultPath(f.home, oldId);
  const data = JSON.parse(await fs.readFile(file, "utf8")) as Record<
    string,
    string
  >;
  data.tag = "AAAAAAAAAAAAAAAAAAAAAA==";
  await fs.writeFile(file, JSON.stringify(data), { mode: 0o600 });
  await assert.rejects(
    openVault(f.home, oldId, { cache, prompt: async () => passphrase }),
    code("VAULT_UNLOCK_FAILED"),
  );
});

test("interactive setup retries invalid URL, rejected token, and mismatched passphrases", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const urls = [
    "http://remote.example",
    f.server.url,
    f.server.url,
    f.server.url,
  ];
  const secrets = [
    token,
    passphrase,
    "mismatch",
    "WRONG_SECRET",
    passphrase,
    passphrase,
    token,
    passphrase,
    passphrase,
  ];
  const output: string[] = [];
  const result = await setupInteractive(
    f.home,
    {
      text: async () => urls.shift()!,
      secret: async () => secrets.shift()!,
      print: (line) => output.push(line),
    },
    { cache: fakeCache() },
  );
  assert.equal(result.baseUrl, f.server.url);
  assert.match(output.join("\n"), /Passphrases do not match/);
  assert.match(output.join("\n"), /AUTHENTICATION/);
  assert.ok(!output.join("\n").includes("WRONG_SECRET"));
  assert.ok(!output.join("\n").includes(token));
});

test("hidden input does not echo and restores terminal mode", async () => {
  let raw = false;
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      raw = value;
      this.isRaw = value;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let shown = "";
  output.on("data", (chunk) => (shown += String(chunk)));
  const result = promptHidden(
    "Token: ",
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );
  input.write(`${token}\r`);
  assert.equal(await result, token);
  assert.equal(raw, false);
  assert.ok(!shown.includes(token));
});

test("setup refuses non-TTY input, and doctor initializes missing backup directory", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  await assert.rejects(
    run(process.execPath, ["--import", "tsx", "src/cli.ts", "setup"], {
      env: { HOME: f.home, PATH: process.env.PATH },
      timeout: 10000,
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      String(error.stderr).includes("SETUP_REQUIRED"),
  );
  await fs.rm(f.store.backupDir, { recursive: true });
  const report = await doctor(
    f.store,
    async () => f.client,
    f.home,
    async () => false,
  );
  assert.equal(
    report.checks.find((c) => c.check === "cache-permissions")?.ok,
    true,
  );
});
