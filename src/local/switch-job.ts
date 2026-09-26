import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicWrite, directory, readPrivate } from "./files.js";
import { Store } from "./store.js";
import type { Report } from "../sync/engine.js";

export interface SwitchJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  finishedAt?: string;
  report?: Report;
  error?: string;
}

export function newSwitchJob(): SwitchJob {
  return {
    id: randomUUID(),
    status: "queued",
    createdAt: new Date().toISOString(),
  };
}

function jobFile(store: Store, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid switch ID");
  return path.join(store.root, "switch-jobs", `${id}.json`);
}

export async function readSwitchJob(
  store: Store,
): Promise<SwitchJob | undefined> {
  const id = await readPrivate(path.join(store.root, "last-switch.json"));
  if (id === undefined) return undefined;
  const raw = await readPrivate(jobFile(store, id));
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("status" in value) ||
    !["queued", "running", "succeeded", "failed"].includes(String(value.status))
  )
    throw new Error("Invalid switch status");
  if (value.id !== id) throw new Error("Invalid switch status");
  return value as SwitchJob;
}

export async function writeSwitchJob(
  store: Store,
  job: SwitchJob,
  newestOnly = false,
): Promise<void> {
  await store.init();
  await directory(path.join(store.root, "switch-jobs"), true);
  await atomicWrite(jobFile(store, job.id), JSON.stringify(job));
  if (!newestOnly)
    await atomicWrite(path.join(store.root, "last-switch.json"), job.id);
}
