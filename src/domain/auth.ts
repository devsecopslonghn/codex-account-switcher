import { createHash } from "node:crypto";
import { rememberSecret } from "../output.js";
import { AppError } from "./errors.js";
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export interface Identity {
  workspaceId: string;
  userId: string;
  email?: string;
}
export interface Auth {
  auth_mode?: "chatgpt" | null;
  OPENAI_API_KEY?: null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh?: string;
}
export interface ParsedAuth {
  auth: Auth;
  identity: Identity;
  expiresAt?: string;
  fingerprint: string;
}
export function hash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
function claims(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (
    parts.length !== 3 ||
    parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))
  )
    throw new AppError("INVALID_AUTH");
  try {
    const c: unknown = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    );
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error();
    return record(c);
  } catch {
    throw new AppError("INVALID_AUTH");
  }
}
export function parseAuth(input: unknown): ParsedAuth {
  let raw: unknown = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input) > 262144) throw new AppError("INVALID_AUTH");
    try {
      raw = JSON.parse(input);
    } catch {
      throw new AppError("INVALID_AUTH");
    }
  }
  const doc = record(raw),
    t = record(doc.tokens);
  if (
    doc.auth_mode !== undefined &&
    doc.auth_mode !== null &&
    doc.auth_mode !== "chatgpt"
  )
    throw new AppError("INVALID_AUTH");
  if (doc.OPENAI_API_KEY !== undefined && doc.OPENAI_API_KEY !== null)
    throw new AppError("INVALID_AUTH");
  const id = str(t.id_token),
    access = str(t.access_token),
    refresh = str(t.refresh_token);
  if (
    !id ||
    !access ||
    !refresh ||
    [id, access, refresh].some((v) => v.length > 100000 || /\s/.test(v))
  )
    throw new AppError("INVALID_AUTH");
  [id, access, refresh].forEach(rememberSecret);
  const ic = claims(id),
    ac = claims(access),
    ia = record(ic["https://api.openai.com/auth"]),
    aa = record(ac["https://api.openai.com/auth"]);
  const fromClaim = str(ia.chatgpt_account_id) ?? str(ia.account_id);
  const workspaceId = str(t.account_id) ?? fromClaim;
  const userId = str(ia.chatgpt_user_id) ?? str(ia.user_id) ?? str(ic.sub);
  if (!workspaceId || !userId || (fromClaim && workspaceId !== fromClaim))
    throw new AppError("INVALID_AUTH");
  const aw = str(aa.chatgpt_account_id) ?? str(aa.account_id),
    au = str(aa.chatgpt_user_id) ?? str(aa.user_id);
  if ((aw && aw !== workspaceId) || (au && au !== userId))
    throw new AppError("INVALID_AUTH");
  const exp = ac.exp ?? ic.exp;
  if (
    exp !== undefined &&
    (typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      Math.abs(exp) > 8640000000000)
  )
    throw new AppError("INVALID_AUTH");
  const auth: Auth = {
    tokens: {
      id_token: id,
      access_token: access,
      refresh_token: refresh,
      account_id: workspaceId,
    },
  };
  if (doc.auth_mode !== undefined)
    auth.auth_mode = doc.auth_mode as "chatgpt" | null;
  if (doc.OPENAI_API_KEY === null) auth.OPENAI_API_KEY = null;
  if (doc.last_refresh !== undefined) {
    if (
      !str(doc.last_refresh) ||
      !Number.isFinite(Date.parse(doc.last_refresh as string))
    )
      throw new AppError("INVALID_AUTH");
    auth.last_refresh = doc.last_refresh as string;
  }
  return {
    auth,
    identity: { workspaceId, userId, email: str(ic.email) },
    expiresAt:
      typeof exp === "number" ? new Date(exp * 1000).toISOString() : undefined,
    fingerprint: hash(JSON.stringify(auth.tokens)),
  };
}
export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.workspaceId === b.workspaceId && a.userId === b.userId;
}
export function serialize(a: ParsedAuth): string {
  return `${JSON.stringify(a.auth, null, 2)}\n`;
}
