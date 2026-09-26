import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { setup } from "./helpers.js";
import { startSwitchWorker } from "../src/local/switch-worker.js";
import { readSwitchJob } from "../src/local/switch-job.js";
import { parseAuth } from "../src/domain/auth.js";
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
    "switch-status",
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
test("CLI defaults to stopping sessions and keeps -f as an alias", async (t) => {
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
  const first = JSON.parse((await cli("use", "B")).stdout);
  assert.equal(first.connectionId, "B");
  assert.deepEqual(first.sessions, { terminated: 0 });
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
  assert.deepEqual(same.sessions, { terminated: 0 });
  await assert.rejects(cli("use", "B", "--force", "--force"));
  await assert.rejects(cli("use", "missing", "-f"));
  const withoutDaemon = JSON.parse((await cli("use", "A", "-f")).stdout);
  assert.deepEqual(withoutDaemon.sessions, { terminated: 0 });
  assert.doesNotMatch(
    (await cli("use", "--help")).stdout,
    /restarts automatically/,
  );
});

test("detached worker finishes a switch and records a private result", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const entry = path.resolve("src/cli.ts");
  const job = await startSwitchWorker(
    f.home,
    "B",
    { baseUrl: f.server.url, token: "FAKE_MANAGEMENT_SECRET" },
    entry,
    ["--import", "tsx"],
  );
  let latest = await readSwitchJob(f.store);
  for (
    let attempt = 0;
    attempt < 100 && latest?.status !== "succeeded";
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    latest = await readSwitchJob(f.store);
    if (latest?.status === "failed") break;
  }
  assert.equal(latest?.id, job.id);
  assert.equal(latest?.status, "succeeded", latest?.error);
  assert.equal(parseAuth((await f.store.activeRaw())!).identity.userId, "b");
  const output = await run(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "switch-status"],
    { env: { HOME: f.home, PATH: process.env.PATH }, timeout: 10000 },
  );
  assert.equal(JSON.parse(output.stdout).status, "succeeded");
  assert.doesNotMatch(output.stdout, /FAKE_MANAGEMENT_SECRET|FAKE_REFRESH/);
});

test("detached worker records a failed switch without replacing auth", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const original = await f.store.activeRaw();
  await startSwitchWorker(
    f.home,
    "missing",
    { baseUrl: f.server.url, token: "FAKE_MANAGEMENT_SECRET" },
    path.resolve("src/cli.ts"),
    ["--import", "tsx"],
  );
  let latest = await readSwitchJob(f.store);
  for (
    let attempt = 0;
    attempt < 100 && latest?.status !== "failed";
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    latest = await readSwitchJob(f.store);
  }
  assert.equal(latest?.status, "failed");
  assert.match(latest?.error ?? "", /^NOT_FOUND:/);
  assert.equal(await f.store.activeRaw(), original);
});
