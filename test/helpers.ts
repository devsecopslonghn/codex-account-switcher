import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { parseAuth, type ParsedAuth, serialize } from "../src/domain/auth.js";
import { type Connection } from "../src/domain/account.js";
import { Client } from "../src/omniroute/client.js";
import { Engine } from "../src/sync/engine.js";
import { Store } from "../src/local/store.js";
import { type WriteHooks } from "../src/local/files.js";
export function fakeAuth(
  user = "a",
  rotation = 1,
  workspace = `workspace-${user}`,
): ParsedAuth {
  const jwt = (data: unknown) =>
    `${Buffer.from('{"alg":"FAKE"}').toString("base64url")}.${Buffer.from(JSON.stringify(data)).toString("base64url")}.ZmFrZS1zaWduYXR1cmU`;
  const identity = { chatgpt_account_id: workspace, chatgpt_user_id: user };
  return parseAuth({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        email: `${user}@example.invalid`,
        sub: user,
        "https://api.openai.com/auth": identity,
      }),
      access_token: jwt({
        exp: Math.floor(Date.now() / 1000) + 7200,
        rotation,
        "https://api.openai.com/auth": identity,
      }),
      refresh_token: `FAKE_REFRESH_${user}_${rotation}`,
      account_id: workspace,
    },
    last_refresh: "2026-09-26T00:00:00.000Z",
  });
}
export function metadata(id: string, a: ParsedAuth): Connection {
  return {
    id,
    name: id,
    email: a.identity.email,
    identity: a.identity,
    updatedAt: "revision-1",
    expiresAt: a.expiresAt,
  };
}
export class FakeServer {
  readonly auths = new Map<string, ParsedAuth>([
    ["A", fakeAuth("a")],
    ["B", fakeAuth("b")],
  ]);
  connections: Connection[] = [
    metadata("A", this.auths.get("A")!),
    metadata("B", this.auths.get("B")!),
  ];
  calls: { method: string; url: string }[] = [];
  importStatus = 200;
  exportStatus = 200;
  exportCode = "reauth_required";
  exportOverride: unknown = undefined;
  listStatus = 200;
  beforeExport?: () => Promise<void>;
  afterImport?: () => Promise<void>;
  server?: Server;
  url = "";
  revision = 1;
  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      try {
        const url = req.url ?? "";
        this.calls.push({ method: req.method ?? "", url });
        res.setHeader("Content-Type", "application/json");
        if (req.headers.authorization !== "Bearer FAKE_MANAGEMENT_SECRET") {
          res
            .writeHead(401)
            .end(JSON.stringify({ error: "FAKE_MANAGEMENT_SECRET" }));
          return;
        }
        if (req.method === "GET" && url.startsWith("/api/providers?")) {
          res.writeHead(this.listStatus).end(
            JSON.stringify({
              connections: this.connections.map((c) => ({
                id: c.id,
                name: c.name,
                email: c.email,
                provider: "codex",
                authType: "oauth",
                updatedAt: c.updatedAt,
                expiresAt: c.expiresAt,
                providerSpecificData: {
                  workspaceId: c.identity?.workspaceId,
                  chatgptUserId: c.identity?.userId,
                },
              })),
              total: this.connections.length,
            }),
          );
          return;
        }
        if (url.endsWith("/codex-auth/export")) {
          await this.beforeExport?.();
          const id = url.split("/")[3]!;
          if (this.exportStatus !== 200) {
            res.writeHead(this.exportStatus).end(
              JSON.stringify({
                code: this.exportCode,
                error: "FAKE_REFRESH_b_1 FAKE_MANAGEMENT_SECRET",
              }),
            );
            return;
          }
          res.end(
            JSON.stringify(this.exportOverride ?? this.auths.get(id)?.auth),
          );
          return;
        }
        if (url === "/api/providers/codex-auth/import") {
          let body = "";
          for await (const chunk of req) body += String(chunk);
          const d = JSON.parse(body) as {
            source: { kind: string; json: unknown };
            overwriteExisting: boolean;
          };
          if (this.importStatus !== 200) {
            res.writeHead(this.importStatus).end(
              JSON.stringify({
                error: "FAKE_REFRESH_a_1 FAKE_MANAGEMENT_SECRET",
              }),
            );
            return;
          }
          if (d.source.kind !== "json" || d.overwriteExisting !== true) {
            res.writeHead(400).end("{}");
            return;
          }
          const a = parseAuth(d.source.json),
            c = this.connections.find(
              (c) =>
                c.identity?.workspaceId === a.identity.workspaceId &&
                c.identity?.userId === a.identity.userId,
            );
          if (!c) {
            res.writeHead(400).end("{}");
            return;
          }
          this.auths.set(c.id, a);
          c.updatedAt = `revision-${++this.revision}`;
          await this.afterImport?.();
          res.end(
            JSON.stringify({
              created: false,
              connection: {
                ...c,
                providerSpecificData: {
                  workspaceId: c.identity?.workspaceId,
                  chatgptUserId: c.identity?.userId,
                },
              },
            }),
          );
          return;
        }
        res.writeHead(404).end("{}");
      } catch {
        res.writeHead(500).end("{}");
      }
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve),
    );
    const addr = this.server.address();
    if (!addr || typeof addr === "string") throw new Error();
    this.url = `http://127.0.0.1:${addr.port}`;
  }
  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }
}
export async function setup(hooks: WriteHooks = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-account-test-"));
  await fs.mkdir(path.join(home, ".codex"), { mode: 0o700 });
  const store = new Store(home, hooks);
  await store.init();
  const server = new FakeServer();
  await server.start();
  await fs.writeFile(store.authPath, serialize(server.auths.get("A")!), {
    mode: 0o600,
  });
  const client = new Client({
    baseUrl: server.url,
    token: "FAKE_MANAGEMENT_SECRET",
  });
  const engine = new Engine(store, client, async () => false);
  return {
    home,
    store,
    server,
    client,
    engine,
    cleanup: async () => {
      await server.close();
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}
