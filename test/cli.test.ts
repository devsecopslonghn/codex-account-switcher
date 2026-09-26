import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { setup } from "./helpers.js";
const run = promisify(execFile);

test("global and command help are contextual and work without config or network", async () => {
  const env = {
    HOME: path.join(os.tmpdir(), "codex-account-help-home-does-not-exist"),
    PATH: process.env.PATH,
  };
  const cli = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      env,
      timeout: 10000,
    });
  const global = (await cli("--help")).stdout;
  for (const alias of ["-h", "-help", "help"])
    assert.equal((await cli(alias)).stdout, global);
  assert.match(global, /-V, --version/);
  for (const command of [
    "setup",
    "list",
    "current",
    "sync",
    "sync-all",
    "use",
    "rollback",
    "doctor",
  ]) {
    const output = (await cli(command, "--help")).stdout;
    assert.match(output, new RegExp(`Usage: codex-account ${command}`));
    assert.match(output, /Examples:/);
    assert.match(output, /-h, --help/);
    assert.equal((await cli("help", command)).stdout, output);
  }
  const useHelp = (await cli("use", "--help")).stdout;
  assert.equal((await cli("use", "-h")).stdout, useHelp);
  assert.equal((await cli("use", "-help")).stdout, useHelp);
  assert.equal((await cli("--help", "use")).stdout, useHelp);
  assert.match(useHelp, /exact email/);
  assert.match(useHelp, /-f, --force/);
  assert.doesNotMatch((await cli("rollback", "-h")).stdout, /-f, --force/);
  assert.equal((await cli("-V")).stdout, (await cli("--version")).stdout);
});

test("invalid options get command-specific usage without opening the vault", async () => {
  const env = {
    HOME: path.join(os.tmpdir(), "codex-account-help-home-does-not-exist"),
    PATH: process.env.PATH,
  };
  for (const [args, hint] of [
    [["use"], "use"],
    [["use", "person@example.com", "--unknown"], "use"],
    [["use", "person@example.com", "-f", "--force"], "use"],
    [["rollback", "-f"], "rollback"],
    [["help", "missing"], ""],
  ] as const) {
    await assert.rejects(
      run(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
        env,
        timeout: 10000,
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        String(error.stderr).includes(
          hint ? `codex-account ${hint} --help` : "codex-account --help",
        ),
    );
  }
});
test("actual CLI list/current/sync/sync-all use fake HTTP and a temporary home", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const original = await f.store.activeRaw();
  // Only this child gets a temporary HOME; never change the running agent's home.
  const env = {
    PATH: process.env.PATH,
    HOME: f.home,
    OMNIROUTE_URL: f.server.url,
    OMNIROUTE_MANAGEMENT_TOKEN: "FAKE_MANAGEMENT_SECRET",
  };
  for (const command of ["list", "current", "sync", "sync-all"]) {
    const result = await run(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", command],
      { env, timeout: 10000 },
    );
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes("FAKE_REFRESH"));
    assert.ok(!result.stdout.includes("FAKE_MANAGEMENT_SECRET"));
  }
  assert.equal(await f.store.activeRaw(), original);
  const help = await run(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--help"],
    { env },
  );
  assert.match(help.stdout, /rollback/);
  await f.server.close();
  const offline = await run(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "current"],
    { env },
  );
  assert.match(offline.stdout, /UNAVAILABLE/);
  assert.match(offline.stdout, /ACTIVE_LOCAL/);
});
test("CLI exposes use help and accepts force before or after the selector", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const env = {
    PATH: process.env.PATH,
    HOME: f.home,
    OMNIROUTE_URL: f.server.url,
    OMNIROUTE_MANAGEMENT_TOKEN: "FAKE_MANAGEMENT_SECRET",
  };
  const cli = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      env,
      timeout: 10000,
    });
  assert.match((await cli("use", "--help")).stdout, /--force/);
  assert.equal(
    JSON.parse((await cli("use", "B", "--force")).stdout).connectionId,
    "B",
  );
  assert.equal(
    JSON.parse((await cli("use", "-f", "A")).stdout).connectionId,
    "A",
  );
  assert.equal(
    JSON.parse((await cli("use", "B", "-f")).stdout).connectionId,
    "B",
  );
  await assert.rejects(cli("use", "B", "--force", "--force"));
});
