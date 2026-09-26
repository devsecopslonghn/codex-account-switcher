import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setup, fakeAuth, metadata } from './helpers.js';
import { parseAuth, serialize } from '../src/domain/auth.js';
import { AppError, safeError } from '../src/domain/errors.js';
import { Engine } from '../src/sync/engine.js';
import { safeOutput } from '../src/output.js';
import { current, list } from '../src/commands.js';
const code=(expected:string)=>(e:unknown)=>e instanceof AppError&&e.code===expected;

test('A → B → A switches, secure backups, and unrelated Codex files remain byte-identical',async t=>{
  const f=await setup();t.after(f.cleanup);
  await fs.writeFile(path.join(f.store.codex,'config.toml'),'model = "example"\n');await fs.mkdir(path.join(f.store.codex,'sessions'));await fs.writeFile(path.join(f.store.codex,'sessions','keep'),'history');
  const a=await f.store.activeRaw();await f.engine.use('B');assert.equal(parseAuth((await f.store.activeRaw())!).identity.userId,'b');
  await f.engine.use('A');assert.equal(parseAuth((await f.store.activeRaw())!).fingerprint,parseAuth(a!).fingerprint);
  assert.equal(await fs.readFile(path.join(f.store.codex,'config.toml'),'utf8'),'model = "example"\n');assert.equal(await fs.readFile(path.join(f.store.codex,'sessions','keep'),'utf8'),'history');
  assert.equal((await fs.stat(f.store.authPath)).mode&0o777,0o600);assert.equal((await f.store.backups()).length,2);
  assert.deepEqual((await fs.readdir(f.store.codex)).sort(),['auth.json','config.toml','sessions']);
});
test('local A2 rotation is imported before B export and preserved on switch back',async t=>{
  const f=await setup();t.after(f.cleanup);await f.engine.sync();const a2=fakeAuth('a',2);await fs.writeFile(f.store.authPath,serialize(a2));f.server.calls=[];
  await f.engine.use('B');assert.equal(f.server.auths.get('A')!.fingerprint,a2.fingerprint);assert.equal((await f.store.cache('A'))!.fingerprint,a2.fingerprint);
  const urls=f.server.calls.map(c=>c.url);assert.ok(urls.indexOf('/api/providers/codex-auth/import')<urls.indexOf('/api/providers/B/codex-auth/export'));
  await f.engine.use('A');assert.equal(parseAuth((await f.store.activeRaw())!).fingerprint,a2.fingerprint);
});
for(const mode of ['current malformed','target malformed','identity mismatch','unavailable','import fails','reauth required'] as const) {
  test(`failure preserves exact active bytes: ${mode}`,async t=>{
    const f=await setup();t.after(f.cleanup);let expected='INVALID_AUTH';
    if(mode==='current malformed')await fs.writeFile(f.store.authPath,'{bad');
    if(mode==='target malformed')f.server.exportOverride={tokens:{}};
    if(mode==='identity mismatch'){f.server.exportOverride=fakeAuth('different').auth;expected='IDENTITY_MISMATCH';}
    if(mode==='unavailable'){f.server.listStatus=503;expected='UNAVAILABLE';}
    if(mode==='import fails'){f.server.importStatus=403;expected='AUTHORIZATION';}
    if(mode==='reauth required'){f.server.exportStatus=409;expected='REAUTH_REQUIRED';}
    const original=await f.store.activeRaw();await assert.rejects(f.engine.use('B'),code(expected));assert.equal(await f.store.activeRaw(),original);
    if(mode==='import fails')assert.ok(!f.server.calls.some(c=>c.url.endsWith('/export')));
  });
}
test('two simultaneous switches cannot enter transaction together',async t=>{
  const f=await setup();t.after(f.cleanup);let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});f.server.beforeExport=async()=>{entered();await gate;};
  const first=f.engine.use('B');await ready;await assert.rejects(f.engine.use('B'),code('LOCKED'));release();await first;
});
test('stale lock metadata recovers without deleting or replacing the lock inode',async t=>{
  const f=await setup();t.after(f.cleanup);const lock=path.join(f.store.root,'lock');await fs.writeFile(lock,JSON.stringify({pid:99999999}),{mode:0o600});const ino=(await fs.stat(lock)).ino;await f.engine.use('B');assert.equal((await fs.stat(lock)).ino,ino);
});
test('Codex process at start or immediately before replace prevents switching',async t=>{
  const f=await setup();t.after(f.cleanup);const raw=await f.store.activeRaw();
  await assert.rejects(new Engine(f.store,f.client,async()=>true).use('B'),code('PROCESS_RUNNING'));
  let calls=0;await assert.rejects(new Engine(f.store,f.client,async()=>++calls>1).use('B'),code('PROCESS_RUNNING'));assert.equal(await f.store.activeRaw(),raw);
});
test('atomic rename fault cleans staging and leaves original auth valid',async t=>{
  const f=await setup({beforeRename:async()=>{throw new Error('simulated disk failure FAKE_REFRESH_a_1');}});t.after(f.cleanup);const raw=await f.store.activeRaw();await assert.rejects(f.engine.use('B'),code('FILESYSTEM'));assert.equal(await f.store.activeRaw(),raw);assert.deepEqual(await fs.readdir(f.store.codex),['auth.json']);
});
test('offline rollback restores latest valid backup and skips corrupt backups',async t=>{
  const f=await setup();t.after(f.cleanup);const a=await f.store.activeRaw();await f.engine.use('B');await fs.writeFile(path.join(f.store.backupDir,'9999-invalid.json'),'{bad',{mode:0o600});await f.server.close();
  await f.engine.rollback();assert.equal(await f.store.activeRaw(),a);assert.equal((await f.store.state()).activeConnectionId,'A');
});
test('rollback can recover malformed active auth without contacting server',async t=>{
  const f=await setup();t.after(f.cleanup);const a=await f.store.activeRaw();await f.engine.use('B');await fs.writeFile(f.store.authPath,'broken');f.server.listStatus=503;await f.engine.rollback();assert.equal(await f.store.activeRaw(),a);
});
test('background sync pushes active A2, never exports or overwrites A, refreshes inactive B cache',async t=>{
  const f=await setup();t.after(f.cleanup);await f.engine.sync(true);const a2=fakeAuth('a',2),b2=fakeAuth('b',2);await fs.writeFile(f.store.authPath,serialize(a2));f.server.auths.set('B',b2);f.server.connections[1]!.updatedAt='remote-change';f.server.calls=[];
  const bytes=await f.store.activeRaw();await new Engine(f.store,f.client,async()=>true).sync(true);
  assert.equal(await f.store.activeRaw(),bytes);assert.equal(f.server.auths.get('A')!.fingerprint,a2.fingerprint);assert.equal((await f.store.cache('B'))!.fingerprint,b2.fingerprint);assert.ok(!f.server.calls.some(c=>c.url==='/api/providers/A/codex-auth/export'));
});
test('same-active selection only pushes, never exports or replaces active credentials',async t=>{const f=await setup();t.after(f.cleanup);const raw=await f.store.activeRaw();assert.equal((await f.engine.use('A')).action,'already-active');assert.equal(await f.store.activeRaw(),raw);assert.ok(!f.server.calls.some(c=>c.url.endsWith('/export')));});
test('ambiguous name/email and duplicate strong identities fail closed',async t=>{
  const f=await setup();t.after(f.cleanup);f.server.connections.forEach(c=>{c.name='duplicate';c.email='same@example.invalid';});await assert.rejects(f.engine.use('duplicate'),code('AMBIGUOUS'));await assert.rejects(f.engine.use('same@example.invalid'),code('AMBIGUOUS'));
  f.server.connections.push({...f.server.connections[0]!,id:'C'});await assert.rejects(f.engine.sync(),code('AMBIGUOUS'));
});
test('two users in same workspace remain distinct',async t=>{
  const f=await setup();t.after(f.cleanup);const a=fakeAuth('a',1,'team'),b=fakeAuth('b',1,'team');f.server.auths.set('A',a);f.server.auths.set('B',b);f.server.connections=[metadata('A',a),metadata('B',b)];await fs.writeFile(f.store.authPath,serialize(a));await f.engine.use('B');assert.equal(parseAuth((await f.store.activeRaw())!).identity.userId,'b');assert.equal(f.server.auths.get('A')!.identity.userId,'a');
});
test('normal reports, state and sanitized HTTP errors never contain fake secrets',async t=>{
  const f=await setup();t.after(f.cleanup);let output=safeOutput(await f.engine.sync(true));output+=safeOutput(await current(f.store,f.client));output+=safeOutput(await list(f.store,f.client));output+=await fs.readFile(path.join(f.store.root,'state.json'),'utf8');
  f.server.exportStatus=502;f.server.exportCode='refresh_failed';try{await f.engine.use('B');}catch(e){output+=safeError(e);}
  for(const a of f.server.auths.values())for(const token of [a.auth.tokens.id_token,a.auth.tokens.access_token,a.auth.tokens.refresh_token])assert.ok(!output.includes(token));assert.ok(!output.includes('FAKE_MANAGEMENT_SECRET'));assert.match(output,/REFRESH_FAILED/);
});
test('both local and remote active divergence warns but preserves active-local authority',async t=>{
  const f=await setup();t.after(f.cleanup);await f.engine.sync();const a2=fakeAuth('a',2);await fs.writeFile(f.store.authPath,serialize(a2));f.server.connections[0]!.updatedAt='independent-remote';f.server.auths.set('A',fakeAuth('a',9));const r=await f.engine.sync();assert.match(r.warnings.join(),/Both active local/);assert.equal(f.server.auths.get('A')!.fingerprint,a2.fingerprint);assert.equal((await f.store.state()).accounts.A?.status,'CONFLICT');
});
test('inactive independently changed cache is preserved even if remote also changes',async t=>{
  const f=await setup();t.after(f.cleanup);await f.engine.sync(true);const b3=fakeAuth('b',3);await f.store.saveCache('B',b3);f.server.auths.set('B',fakeAuth('b',4));const r=await f.engine.sync(true);assert.equal(r.failures?.length,1);assert.equal((await f.store.cache('B'))!.fingerprint,b3.fingerprint);assert.equal((await f.store.state()).accounts.B?.status,'CONFLICT');
});
test('concurrent external auth rotation during export aborts replacement',async t=>{
  const f=await setup();t.after(f.cleanup);const a2=fakeAuth('a',2);f.server.beforeExport=async()=>{await fs.writeFile(f.store.authPath,serialize(a2));};await assert.rejects(f.engine.use('B'),code('CHANGED'));assert.equal(parseAuth((await f.store.activeRaw())!).fingerprint,a2.fingerprint);
});
test('rotation during import is reported unsynced without active overwrite',async t=>{
  const f=await setup();t.after(f.cleanup);const a2=fakeAuth('a',2);f.server.afterImport=async()=>{await fs.writeFile(f.store.authPath,serialize(a2));};await assert.rejects(f.engine.sync(),code('CHANGED'));assert.equal((await f.store.state()).accounts.A?.status,'STALE');assert.equal(parseAuth((await f.store.activeRaw())!).fingerprint,a2.fingerprint);
});
test('backups remain bounded to five private files',async t=>{const f=await setup();t.after(f.cleanup);for(let i=1;i<=8;i++)await f.store.backup(serialize(fakeAuth('a',i)));const files=await f.store.backups();assert.equal(files.length,5);for(const file of files)assert.equal((await fs.stat(path.join(f.store.backupDir,file))).mode&0o777,0o600);});
test('state save failure after replacement reports COMMITTED and actual target stays valid',async t=>{
  const f=await setup();t.after(f.cleanup);const original=f.store.saveState.bind(f.store);f.store.saveState=async s=>{if(parseAuth((await f.store.activeRaw())!).identity.userId==='b')throw new Error('disk failed');await original(s);};await assert.rejects(f.engine.use('B'),code('COMMITTED'));assert.equal(parseAuth((await f.store.activeRaw())!).identity.userId,'b');
});
