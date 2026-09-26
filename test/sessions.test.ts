import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hasCodexAncestor,
  scanCodexProcesses,
  type CodexProcess,
} from "../src/local/process.js";
import { quiesceCodexSessions, terminateOne } from "../src/local/sessions.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-account-proc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const procRoot = path.join(root, "proc");
  await fs.mkdir(procRoot);
  const home = path.join(root, "home");
  async function add(
    pid: number,
    ppid: number,
    startTime: string,
    command = "codex",
    envHome = home,
  ): Promise<CodexProcess> {
    const dir = path.join(procRoot, String(pid));
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "comm"), `${command}\n`);
    await fs.writeFile(
      path.join(dir, "cmdline"),
      `/bin/${command}\0app-server\0`,
    );
    await fs.writeFile(path.join(dir, "environ"), `HOME=${envHome}\0`);
    await fs.writeFile(
      path.join(dir, "stat"),
      `${pid} (${command}) ${["S", ppid, ...Array(17).fill("0"), startTime].join(" ")}\n`,
    );
    return { pid, ppid, startTime };
  }
  return { root, procRoot, home, add };
}

test("scanner selects only same-home Codex processes", async (t) => {
  const f = await fixture(t);
  await f.add(1001, 1, "111");
  await f.add(1002, 1, "222", "codex", path.join(f.root, "other"));
  await f.add(1003, 1, "333", "other-tool");
  const scan = await scanCodexProcesses(
    path.join(f.home, ".codex"),
    f.procRoot,
    process.getuid?.(),
    f.home,
  );
  assert.deepEqual(
    scan.matches.map((record) => record.pid),
    [1001],
  );
  assert.deepEqual(scan.inaccessible, []);
});

test("a Codex ancestor selects the detached worker path", async (t) => {
  const f = await fixture(t);
  await f.add(1401, 1, "100");
  await f.add(1402, 1401, "200", "node");
  assert.equal(
    await hasCodexAncestor(
      path.join(f.home, ".codex"),
      f.procRoot,
      1402,
      f.home,
    ),
    true,
  );
  assert.equal(
    await hasCodexAncestor(
      path.join(f.root, "other", ".codex"),
      f.procRoot,
      1402,
      f.home,
    ),
    false,
  );
});

test("quiesce terminates all matching sessions before returning", async (t) => {
  const f = await fixture(t);
  await f.add(2000, 1, "100");
  await f.add(2001, 1, "200");
  await f.add(2002, 1, "300", "codex", path.join(f.root, "other"));
  const signalled: number[] = [];
  let removePid: number | undefined;
  const result = await quiesceCodexSessions(path.join(f.home, ".codex"), {
    procRoot: f.procRoot,
    fallbackHome: f.home,
    signal: (pid) => {
      signalled.push(pid);
      removePid = pid;
    },
    wait: async () => {
      if (removePid !== undefined)
        await fs.rm(path.join(f.procRoot, String(removePid)), {
          recursive: true,
          force: true,
        });
    },
  });
  assert.deepEqual(result, { terminated: 2 });
  assert.deepEqual(signalled, [2000, 2001]);
});

test("a stubborn session prevents quiescence", async (t) => {
  const f = await fixture(t);
  await f.add(3001, 1, "100");
  await assert.rejects(
    quiesceCodexSessions(path.join(f.home, ".codex"), {
      procRoot: f.procRoot,
      fallbackHome: f.home,
      signal: () => {},
      wait: async () => {},
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "PROCESS_STOP_FAILED",
  );
});

test("termination checks process start time and escalates stubborn sessions", async (t) => {
  const f = await fixture(t);
  const record = await f.add(4001, 1, "100");
  const signals: string[] = [];
  let kill = false;
  assert.equal(
    await terminateOne(record, {
      procRoot: f.procRoot,
      signal: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") kill = true;
      },
      wait: async () => {
        if (kill)
          await fs.rm(path.join(f.procRoot, "4001"), {
            recursive: true,
            force: true,
          });
      },
    }),
    true,
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  await f.add(4002, 1, "200");
  const old = { pid: 4002, ppid: 1, startTime: "100" };
  assert.equal(
    await terminateOne(old, {
      procRoot: f.procRoot,
      signal: () => assert.fail("reused PID must not be signalled"),
    }),
    true,
  );
});

test("Linux integration stops a disposable same-home Codex-named process", async (t) => {
  const f = await fixture(t);
  const codexHome = path.join(f.home, ".codex");
  const child = spawn("bash", ["-c", "exec -a codex sleep 30"], {
    env: { HOME: f.home, CODEX_HOME: codexHome, PATH: process.env.PATH },
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  let found = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const scan = await scanCodexProcesses(codexHome);
    if (scan.matches.some((record) => record.pid === child.pid)) {
      found = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(found, true);
  const result = await quiesceCodexSessions(codexHome);
  assert.ok(result.terminated >= 1);
  if (child.exitCode === null && child.signalCode === null)
    await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(child.signalCode, "SIGTERM");
});
