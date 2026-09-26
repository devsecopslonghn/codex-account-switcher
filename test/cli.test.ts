import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setup } from "./helpers.js";
const run = promisify(execFile);
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
    JSON.parse((await cli("use", "--force", "A")).stdout).connectionId,
    "A",
  );
  await assert.rejects(cli("use", "B", "--force", "--force"));
});
