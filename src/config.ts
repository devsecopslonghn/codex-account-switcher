import { rememberSecret } from "./output.js";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { record, str } from "./domain/auth.js";
import { AppError, isErrno } from "./domain/errors.js";
import { directory, readPrivate } from "./local/files.js";
export interface Config {
  baseUrl: string;
  token: string;
}
export function validateUrl(value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AppError("CONFIG");
  }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["http:", "https:"].includes(u.protocol)
  )
    throw new AppError("CONFIG");
  if (
    u.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
  )
    throw new AppError("CONFIG");
  return u.toString().replace(/\/$/, "");
}
export async function checkCodexConfig(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (
    env.CODEX_HOME &&
    path.resolve(env.CODEX_HOME) !== path.join(home, ".codex")
  )
    throw new AppError("CONFIG");
  if (
    [
      "OPENAI_BASE_URL",
      "OPENAI_API_BASE",
      "CHATGPT_BASE_URL",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "OPENAI_IDENTITY_TOKEN",
      "OPENAI_IDENTITY_TOKEN_FILE",
      "CODEX_AUTH_JSON",
    ].some((k) => env[k])
  )
    throw new AppError("CONFIG");
  let raw: string;
  try {
    raw = await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8");
  } catch (e) {
    if (isErrno(e, "ENOENT")) return;
    throw new AppError("CONFIG");
  }
  try {
    const d = record(parseToml(raw));
    if (
      (d.cli_auth_credentials_store !== undefined &&
        d.cli_auth_credentials_store !== "file") ||
      (d.model_provider !== undefined && d.model_provider !== "openai") ||
      d.chatgpt_base_url ||
      d.openai_base_url ||
      d.forced_login_method === "api"
    )
      throw new Error();
    // Profile-specific policy must be reviewed by the operator; reject conflicting stores/providers.
    for (const p of [d, ...Object.values(record(d.profiles)).map(record)]) {
      if (
        (p.cli_auth_credentials_store !== undefined &&
          p.cli_auth_credentials_store !== "file") ||
        (p.model_provider !== undefined && p.model_provider !== "openai") ||
        p.chatgpt_base_url
      )
        throw new Error();
    }
    const openai = record(record(d.model_providers).openai);
    if (openai.base_url) throw new Error();
  } catch {
    throw new AppError("CONFIG");
  }
}
export async function loadConfig(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config> {
  let baseUrl = env.OMNIROUTE_URL,
    token = env.OMNIROUTE_MANAGEMENT_TOKEN;
  let c: Record<string, unknown> = {};
  if (!baseUrl || !token) {
    const dir = path.join(home, ".codex-accounts");
    await directory(dir);
    const raw = await readPrivate(path.join(dir, "config.json"));
    if (raw !== undefined) {
      try {
        c = record(JSON.parse(raw));
      } catch {
        throw new AppError("CONFIG");
      }
    }
    if ("token" in c || "accessToken" in c || "apiKey" in c)
      throw new AppError("CONFIG");
    baseUrl = baseUrl ?? str(c.baseUrl);
  }
  if (!baseUrl) throw new AppError("CONFIG");
  const normalized = validateUrl(baseUrl);
  if (!token) {
    const cmd = c.credentialCommand;
    if (
      !Array.isArray(cmd) ||
      !cmd.length ||
      cmd.some((v) => typeof v !== "string" || !v) ||
      !path.isAbsolute(cmd[0] as string)
    )
      throw new AppError("CONFIG");
    token = await new Promise<string>((resolve, reject) => {
      execFile(
        cmd[0] as string,
        cmd.slice(1) as string[],
        { timeout: 10000, maxBuffer: 16384, encoding: "utf8", env: { ...env } },
        (error, stdout) => {
          if (error) reject(new AppError("CONFIG"));
          else resolve(stdout.trim());
        },
      );
    });
  }
  if (!token || token.length > 8192 || /\s/.test(token))
    throw new AppError("CONFIG");
  rememberSecret(token);
  return { baseUrl: normalized, token };
}
