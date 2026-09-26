import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type DaemonRefresh = "not-running" | "restarted" | "failed";

function absentDaemon(error: unknown): boolean {
  if (
    error === null ||
    typeof error !== "object" ||
    !("stderr" in error) ||
    typeof error.stderr !== "string"
  )
    return false;
  return (
    error.stderr.includes("app-server-control.sock") &&
    /No such file or directory|Connection refused|os error (?:2|111)/.test(
      error.stderr,
    )
  );
}

// Codex's interactive CLI can attach to a long-lived app server which retains
// the account it loaded before auth.json was replaced. Restart only that
// managed server; never log out, alter its credential store, or print output.
export async function refreshCodexDaemon(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DaemonRefresh> {
  const childEnv = { ...env };
  delete childEnv.OMNIROUTE_MANAGEMENT_TOKEN;
  delete childEnv.OMNIROUTE_URL;
  const options = {
    env: childEnv,
    timeout: 10000,
    maxBuffer: 4096,
    encoding: "utf8" as const,
  };
  try {
    const { stdout } = await run(
      "codex",
      ["app-server", "daemon", "version"],
      options,
    );
    const status: unknown = JSON.parse(stdout);
    if (status === null || typeof status !== "object" || !("status" in status))
      return "failed";
    if (status.status === "stopped" || status.status === "not-running")
      return "not-running";
    if (status.status !== "running") return "failed";
    // Codex drains active turns before restarting, for up to five minutes with
    // a custom grace setting. Do not kill the lifecycle command after 15s.
    await run("codex", ["app-server", "daemon", "restart"], {
      ...options,
      timeout: 360000,
    });
    return "restarted";
  } catch (error) {
    if (absentDaemon(error)) return "not-running";
    // The file switch has already committed. Never imply that the live runtime
    // switched when the daemon could not be inspected or restarted.
    return "failed";
  }
}
