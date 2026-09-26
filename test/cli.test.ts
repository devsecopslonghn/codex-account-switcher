import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setup } from "./helpers.js";
const run = promisify(execFile);

async function fakeCodexDaemon(home: string): Promise<{
  bin: string;
  log: string;
}> {
  const bin = path.join(home, "bin");
  const log = path.join(home, "daemon.log");
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "codex"),
    `#!/bin/sh
if [ -n "$OMNIROUTE_MANAGEMENT_TOKEN" ]; then exit 41; fi
if [ "$1" != app-server ] || [ "$2" != daemon ]; then exit 42; fi
case "$3" in
  version)
    if [ "${"$"}FAKE_DAEMON_STATUS" = absent ]; then
      printf 'failed to connect to app-server-control.sock: No such file or directory (os error 2)\\n' >&2
      exit 1
    fi
    printf '{"status":"%s"}\\n' "${"$"}FAKE_DAEMON_STATUS" ;;
  restart) printf 'restart\\n' >> "${"$"}FAKE_DAEMON_LOG"; [ "${"$"}FAKE_DAEMON_FAIL" != 1 ] ;;
  *) exit 43 ;;
esac
`,
    { mode: 0o700 },
  );
  return { bin, log };
}

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
  const daemon = await fakeCodexDaemon(f.home);
  const env = {
    PATH: `${daemon.bin}:${process.env.PATH}`,
    HOME: f.home,
    OMNIROUTE_URL: f.server.url,
    OMNIROUTE_MANAGEMENT_TOKEN: "FAKE_MANAGEMENT_SECRET",
    FAKE_DAEMON_STATUS: "running",
    FAKE_DAEMON_LOG: daemon.log,
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
  const same = JSON.parse((await cli("use", "B", "-f")).stdout);
  assert.equal(same.action, "already-active");
  assert.equal(same.daemon, "restarted");
  assert.equal(
    (await fs.readFile(daemon.log, "utf8")).trim().split("\n").length,
    4,
  );
  await assert.rejects(cli("use", "B", "--force", "--force"));
  await assert.rejects(cli("use", "missing", "-f"));
  env.FAKE_DAEMON_STATUS = "absent";
  const withoutDaemon = JSON.parse((await cli("use", "A", "-f")).stdout);
  assert.equal(withoutDaemon.daemon, "not-running");
  assert.equal(
    (await fs.readFile(daemon.log, "utf8")).trim().split("\n").length,
    4,
  );
});

test("failed daemon restart reports a committed local switch", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const daemon = await fakeCodexDaemon(f.home);
  const env = {
    PATH: `${daemon.bin}:${process.env.PATH}`,
    HOME: f.home,
    OMNIROUTE_URL: f.server.url,
    OMNIROUTE_MANAGEMENT_TOKEN: "FAKE_MANAGEMENT_SECRET",
    FAKE_DAEMON_STATUS: "running",
    FAKE_DAEMON_LOG: daemon.log,
    FAKE_DAEMON_FAIL: "1",
  };
  await assert.rejects(
    run(process.execPath, ["--import", "tsx", "src/cli.ts", "use", "B", "-f"], {
      env,
      timeout: 10000,
    }),
    (error: unknown) => {
      if (!error || typeof error !== "object" || !("stdout" in error))
        return false;
      const report = JSON.parse(String(error.stdout));
      return (
        "code" in error &&
        error.code === 1 &&
        report.action === "use" &&
        report.connectionId === "B" &&
        report.daemon === "failed" &&
        report.warnings.some((warning: string) =>
          warning.includes("Local auth was updated"),
        )
      );
    },
  );
  assert.equal((await f.store.activeRaw())?.includes("FAKE_REFRESH_b_1"), true);
});
