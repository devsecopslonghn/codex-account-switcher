import { type Identity, record, str } from './auth.js';
import { AppError } from './errors.js';
export type AccountStatus = 'ACTIVE_LOCAL' | 'AVAILABLE' | 'STALE' | 'CONFLICT' | 'REAUTH_REQUIRED' | 'UNKNOWN';
export interface Connection { id: string; name?: string; email?: string; identity?: Identity; updatedAt?: string; expiresAt?: string; testStatus?: string }
export function validId(id: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) && !['state','config','lock'].includes(id); }
export function connection(input: unknown): Connection {
  const c = record(input); if (!str(c.id) || !validId(c.id as string)) throw new AppError('PROTOCOL');
  let ps = record(c.providerSpecificData); if (typeof c.providerSpecificData === 'string') { try { ps = record(JSON.parse(c.providerSpecificData)); } catch { throw new AppError('PROTOCOL'); } }
  const workspaceId = str(ps.workspaceId), userId = str(ps.chatgptUserId);
  return {id:c.id as string,name:str(c.name),email:str(c.email),identity:workspaceId && userId ? {workspaceId,userId,email:str(c.email)} : undefined,updatedAt:str(c.updatedAt),expiresAt:str(c.expiresAt),testStatus:str(c.testStatus)};
}
export function resolveIdentity(connections: Connection[], identity: Identity): Connection {
  const found = connections.filter(c => c.identity?.workspaceId === identity.workspaceId && c.identity.userId === identity.userId);
  if (found.length > 1) throw new AppError('AMBIGUOUS'); if (!found[0]) throw new AppError('NOT_FOUND'); return found[0];
}
export function select(connections: Connection[], selector: string): Connection {
  const byId = connections.filter(c => c.id === selector); if (byId.length === 1) return byId[0]!;
  const s = selector.toLowerCase(); const matches = connections.filter(c => c.id.startsWith(selector) || c.name?.toLowerCase() === s || c.email?.toLowerCase() === s);
  if (!matches.length) throw new AppError('NOT_FOUND'); if (matches.length > 1) throw new AppError('AMBIGUOUS'); return matches[0]!;
}
