# Upstream compatibility notes

Inspected 2026-09-26: [OmniRoute release/v3.8.51](https://github.com/diegosouzapw/OmniRoute/tree/release/v3.8.51), pinned commit `ae2ba35852d4e5a55486a1c0e6a779105564fd6d`. The release branch is mutable: do not treat its name as a reproducible version. The existing workspace checkout was a different fork/commit; the implementation reference was fetched directly from the requested repository.

## HTTP contract

- `GET /api/providers?provider=codex` returns `{connections, total}`. Filter `provider === "codex"` and `authType === "oauth"`. OAuth tokens are omitted; metadata includes `providerSpecificData.workspaceId`, `providerSpecificData.chatgptUserId`, and connection revision `updatedAt`.
- `POST /api/providers/{id}/codex-auth/export` returns the auth document itself (an attachment), **not** an `{auth: ...}` envelope. It can refresh and persist the server's session when access expiry is within five minutes. Missing ID/refresh tokens produce `reauth_required`; failed refresh can produce `refresh_failed`.
- `POST /api/providers/codex-auth/import` accepts `{source: {kind: "json", json: document}, overwriteExisting: true}`. It returns `{connection, created}`. There is no target connection ID parameter and no compare-and-swap revision parameter. The utility resolves strong identity before import and checks the returned ID afterward. An external concurrent DB edit cannot be rolled back atomically by this client.
- Import deliberately does **not** refresh. Access-token expiry is preferred over ID-token expiry. `auth_mode` may be absent or null in official Codex files. Exports include `auth_mode: "chatgpt"`.
- Identity is workspace ID plus ID-token claim `https://api.openai.com/auth.chatgpt_user_id`, then `user_id`, then top-level `sub`. The upstream legacy email fallback can promote old records lacking user metadata; this utility refuses such uncertain mappings until the server metadata is repaired by a trusted import. Workspace or email alone cannot establish identity.
- Management credentials travel in `Authorization: Bearer ...`. Remote CLI tokens have read/write/admin scopes; POST import/export need write access. Ordinary inference keys need the management scope. Authentication and authorization errors are distinct.

Relevant source: [export route](https://github.com/diegosouzapw/OmniRoute/blob/ae2ba35852d4e5a55486a1c0e6a779105564fd6d/src/app/api/providers/%5Bid%5D/codex-auth/export/route.ts), [auth builder](https://github.com/diegosouzapw/OmniRoute/blob/ae2ba35852d4e5a55486a1c0e6a779105564fd6d/src/lib/oauth/utils/codexAuthFile.ts), [import implementation](https://github.com/diegosouzapw/OmniRoute/blob/ae2ba35852d4e5a55486a1c0e6a779105564fd6d/src/lib/oauth/utils/codexAuthImport.ts), [identity selection](https://github.com/diegosouzapw/OmniRoute/blob/ae2ba35852d4e5a55486a1c0e6a779105564fd6d/src/lib/oauth/utils/codexConnectionSelection.ts).

## Credential bootstrap

[OmniRoute contexts](https://github.com/diegosouzapw/OmniRoute/blob/ae2ba35852d4e5a55486a1c0e6a779105564fd6d/bin/cli/contexts.mjs) use optional native `keytar`, service `omniroute-cli`, and context credential references. Without a keychain, upstream explicitly falls back to a private mode-0600 `config.json`. Its data directory follows `DATA_DIR`, legacy `~/.omniroute`, then platform/XDG rules. Native keychain availability, context hydration, and file format are CLI internals rather than a stable public client SDK.

This utility therefore uses an explicit base URL and a credential helper (or an environment token). It does not import arbitrary OmniRoute code, silently downgrade an existing keychain to plaintext, export contexts with secrets, or persist management tokens. An operator can configure a helper backed by the same OS keychain or another secret manager. See the README for setup.

## Rotation and conflict limits

Provider listing does not expose credential hashes. Exporting the active account to obtain one would itself risk token rotation. Active conflict detection therefore uses local token hashes and the server's `updatedAt` as a conservative change indicator, not a cryptographic proof of remote credential divergence. Metadata-only edits can report a conflict; same-revision changes cannot be detected.

OmniRoute contains a proactive token health scheduler. Its [provider opt-out](https://github.com/diegosouzapw/OmniRoute/blob/ae2ba35852d4e5a55486a1c0e6a779105564fd6d/src/lib/tokenHealthCheck.ts) is `OMNIROUTE_HEALTHCHECK_SKIP_PROVIDERS=codex,openai`, and individual connections can disable health checks with interval zero. This only controls that scheduler: inference, explicit exports, probes, other clients, and other jobs can still rotate tokens. Dedicate these connections to vault use, disable unrelated consumers, and never actively use one token family on multiple machines. No client-side timer or local lock can coordinate independent OpenAI refreshes on a remote server.

## Official Codex compatibility

[Official authentication documentation](https://developers.openai.com/codex/auth) describes file, keyring, auto, and ephemeral credential stores and automatic token refresh. This architecture requires effective file storage in the normal home. Managed authentication policy, profile/CLI overrides, forced workspace restrictions, API-key environment variables, or an IDE's independent credential configuration may override local defaults. The utility does not rewrite them. Confirm effective configuration before adoption.

JWT payloads are decoded for identity and expiry only, not signature-verified. The trusted source is the authenticated TLS management connection or the private local file. Session/history files remain in the single normal Codex home; retention does not imply cloud account permissions or remote conversations transfer between accounts.
