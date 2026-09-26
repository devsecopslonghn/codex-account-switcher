import { fork } from "node:child_process";
import path from "node:path";
import { checkCodexConfig, type Config } from "../config.js";
import { AppError, safeError } from "../domain/errors.js";
import { Client } from "../omniroute/client.js";
import { Engine } from "../sync/engine.js";
import { Store } from "./store.js";
import { quiesceCodexSessions } from "./sessions.js";
import { newSwitchJob, writeSwitchJob, type SwitchJob } from "./switch-job.js";

interface WorkerMessage {
  home: string;
  selector: string;
  config: Config;
  job: SwitchJob;
}

export async function startSwitchWorker(
  home: string,
  selector: string,
  config: Config,
  entry = process.argv[1]!,
  execArgv: string[] = [],
): Promise<SwitchJob> {
  const store = new Store(home);
  const job = newSwitchJob();
  await writeSwitchJob(store, job);
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    CODEX_HOME: path.join(home, ".codex"),
  };
  try {
    const child = fork(entry, ["--switch-worker"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env,
      execArgv,
    });
    await new Promise<void>((resolve, reject) => {
      const onError = () => finish(new AppError("UNAVAILABLE"));
      const onExit = () => finish(new AppError("UNAVAILABLE"));
      const onMessage = (reply: unknown) =>
        finish(reply === "received" ? undefined : new AppError("PROTOCOL"));
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(
        () => finish(new AppError("UNAVAILABLE")),
        5000,
      );
      child.once("error", onError);
      child.once("exit", onExit);
      child.once("message", onMessage);
      child.send(
        { home, selector, config, job } satisfies WorkerMessage,
        (error) => {
          if (error) finish(new AppError("UNAVAILABLE"));
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new AppError("UNAVAILABLE")),
        5000,
      );
      child.once("message", (value: unknown) => {
        clearTimeout(timeout);
        if (value === "started") resolve();
        else reject(new AppError("PROTOCOL"));
      });
      child.send("proceed", (error) => {
        if (error) {
          clearTimeout(timeout);
          reject(new AppError("UNAVAILABLE"));
        }
      });
    });
    child.disconnect();
    child.unref();
    return job;
  } catch (error) {
    await writeSwitchJob(
      store,
      {
        ...job,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: safeError(error),
      },
      true,
    );
    throw error;
  }
}

export async function runSwitchWorker(): Promise<void> {
  if (!process.send) throw new AppError("CONFIG");
  const message = await new Promise<WorkerMessage>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new AppError("UNAVAILABLE")), 5000);
    process.once("message", (value: unknown) => {
      clearTimeout(timeout);
      if (
        !value ||
        typeof value !== "object" ||
        !("home" in value) ||
        typeof value.home !== "string" ||
        !path.isAbsolute(value.home) ||
        !("selector" in value) ||
        typeof value.selector !== "string" ||
        !("config" in value) ||
        typeof value.config !== "object" ||
        value.config === null ||
        !("job" in value) ||
        typeof value.job !== "object" ||
        value.job === null
      )
        return reject(new AppError("PROTOCOL"));
      resolve(value as WorkerMessage);
    });
  });
  const store = new Store(message.home);
  const job = { ...message.job, status: "running" as const };
  try {
    process.send("received");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new AppError("UNAVAILABLE")),
        5000,
      );
      process.once("message", (value: unknown) => {
        clearTimeout(timeout);
        if (value === "proceed") resolve();
        else reject(new AppError("PROTOCOL"));
      });
    });
    process.send("started");
    await writeSwitchJob(store, job, true);
    await checkCodexConfig(message.home);
    const engine = new Engine(store, new Client(message.config));
    const report = await engine.use(message.selector, true, () =>
      quiesceCodexSessions(store.codex),
    );
    await writeSwitchJob(
      store,
      {
        ...job,
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        report,
      },
      true,
    );
  } catch (error) {
    await writeSwitchJob(
      store,
      {
        ...job,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: safeError(error),
      },
      true,
    );
  }
}
