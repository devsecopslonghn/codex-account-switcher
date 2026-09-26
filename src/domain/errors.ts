export type ErrorCode = 'INVALID_AUTH' | 'IDENTITY_MISMATCH' | 'AMBIGUOUS' | 'NOT_FOUND' | 'REAUTH_REQUIRED' | 'REFRESH_FAILED' | 'AUTHENTICATION' | 'AUTHORIZATION' | 'UNAVAILABLE' | 'PROTOCOL' | 'CONFIG' | 'FILESYSTEM' | 'LOCKED' | 'PROCESS_RUNNING' | 'UNSUPPORTED' | 'CONFLICT' | 'CHANGED' | 'COMMITTED' | 'NO_BACKUP';
const messages: Record<ErrorCode, string> = {
  INVALID_AUTH: 'Auth is malformed or incomplete; active credentials were not replaced.',
  IDENTITY_MISMATCH: 'Workspace and user identity do not match the selected connection.',
  AMBIGUOUS: 'More than one connection matches. Use a unique connection ID; remove duplicate identities on the server.',
  NOT_FOUND: 'No strong workspace/user connection match. Import the session into OmniRoute using its trusted import UI first.',
  REAUTH_REQUIRED: 'The selected account requires reauthentication in OmniRoute.',
  REFRESH_FAILED: 'OmniRoute could not refresh the selected account. No automatic retry was made.',
  AUTHENTICATION: 'OmniRoute rejected the management credential. Renew the credential through your secret manager or remote login.',
  AUTHORIZATION: 'The management credential lacks the required scope (write for import/export).',
  UNAVAILABLE: 'OmniRoute is unavailable or the request timed out. A timed-out mutation may have completed; inspect status before retrying.',
  PROTOCOL: 'OmniRoute returned an unexpected response. Check server compatibility.',
  CONFIG: 'Configuration is missing, unsafe, or incompatible. See README bootstrap and doctor.',
  FILESYSTEM: 'A local file operation failed or an unsafe file/permission was detected.',
  LOCKED: 'Another account operation holds the lock. Wait for it to finish; do not delete the lock file.',
  PROCESS_RUNNING: 'Codex appears to be running. Close CLI and IDE Codex processes before switching or rollback; they may retain or rotate credentials.',
  UNSUPPORTED: 'Safe process detection and locking currently require Linux with /proc and util-linux flock.',
  CONFLICT: 'Independent cache changes were detected and preserved. See conflict resolution in README.',
  CHANGED: 'Active auth changed during the operation. It was not replaced. Run sync again to preserve the latest rotation.',
  COMMITTED: 'Auth replacement committed, but final state bookkeeping failed. Inspect current before retrying; rollback is available.',
  NO_BACKUP: 'No valid distinct backup is available for rollback.',
};
export class AppError extends Error {
  constructor(public readonly code: ErrorCode) { super(messages[code]); this.name = 'AppError'; }
}
export function safeError(error: unknown): string { return error instanceof AppError ? `${error.code}: ${error.message}` : 'INTERNAL: Operation failed; no diagnostic payload is printed because it may contain credentials.'; }
export function isErrno(e: unknown, code: string): boolean { return typeof e === 'object' && e !== null && 'code' in e && e.code === code; }
