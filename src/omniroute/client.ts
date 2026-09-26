import { connection, type Connection } from "../domain/account.js";
import { type ParsedAuth, parseAuth, record } from "../domain/auth.js";
import { AppError } from "../domain/errors.js";
import { type Config, validateUrl } from "../config.js";
export interface Vault {
  list(): Promise<Connection[]>;
  exportAuth(id: string): Promise<ParsedAuth>;
  importAuth(auth: ParsedAuth, expectedId: string): Promise<Connection>;
  health(): Promise<void>;
}
export class Client implements Vault {
  private readonly baseUrl: string;
  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = validateUrl(config.baseUrl);
  }
  private async request(route: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new AppError("PROTOCOL");
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new AppError("PROTOCOL");
        }
        chunks.push(value);
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        data = undefined;
      }
      if (!response.ok) {
        const code = record(data).code;
        if (response.status === 401) throw new AppError("AUTHENTICATION");
        if (response.status === 403) throw new AppError("AUTHORIZATION");
        if (
          code === "reauth_required" ||
          code === "access_token_missing" ||
          code === "account_id_missing"
        )
          throw new AppError("REAUTH_REQUIRED");
        if (code === "refresh_failed") throw new AppError("REFRESH_FAILED");
        if (response.status === 404) throw new AppError("NOT_FOUND");
        if (code === "duplicate_account" || response.status === 409)
          throw new AppError("CONFLICT");
        if (response.status >= 500 || response.status === 429)
          throw new AppError("UNAVAILABLE");
        throw new AppError("PROTOCOL");
      }
      if (data === undefined) throw new AppError("PROTOCOL");
      return data;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("UNAVAILABLE");
    }
  }
  async list(): Promise<Connection[]> {
    const d = record(await this.request("/api/providers?provider=codex"));
    if (
      !Array.isArray(d.connections) ||
      (typeof d.total === "number" && d.total > d.connections.length)
    )
      throw new AppError("PROTOCOL");
    const found = d.connections
      .filter((v) => {
        const c = record(v);
        return c.provider === "codex" && c.authType === "oauth";
      })
      .map(connection);
    if (new Set(found.map((c) => c.id)).size !== found.length)
      throw new AppError("PROTOCOL");
    return found;
  }
  async exportAuth(id: string): Promise<ParsedAuth> {
    return parseAuth(
      await this.request(
        `/api/providers/${encodeURIComponent(id)}/codex-auth/export`,
        {},
      ),
    );
  }
  async importAuth(auth: ParsedAuth, expectedId: string): Promise<Connection> {
    const d = record(
      await this.request("/api/providers/codex-auth/import", {
        source: { kind: "json", json: auth.auth },
        overwriteExisting: true,
      }),
    );
    const c = connection(d.connection);
    if (
      c.id !== expectedId ||
      d.created !== false ||
      !c.identity ||
      c.identity.workspaceId !== auth.identity.workspaceId ||
      c.identity.userId !== auth.identity.userId
    )
      throw new AppError("IDENTITY_MISMATCH");
    return c;
  }
  async health(): Promise<void> {
    await this.list();
  }
  async verifySetupAccess(): Promise<void> {
    const identity = record(await this.request("/api/cli/whoami"));
    if (identity.authenticated !== true) throw new AppError("AUTHENTICATION");
    // Provider import/export needs admin. A provider listing alone only proves read access.
    if (identity.viaAccessToken !== true || identity.scope !== "admin")
      throw new AppError("AUTHORIZATION");
    await this.list();
  }
}
