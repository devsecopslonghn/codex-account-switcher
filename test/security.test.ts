import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fakeAuth, setup } from './helpers.js';
import { parseAuth, serialize } from '../src/domain/auth.js';
import { AppError, safeError } from '../src/domain/errors.js';
import { acquireLock } from '../src/local/lock.js';
import { loadConfig, checkCodexConfig, validateUrl } from '../src/config.js';
import { Client } from '../src/omniroute/client.js';
import { doctor } from '../src/commands.js';
import { safeOutput } from '../src/output.js';
const code=(expected:string)=>(e:unknown)=>e instanceof AppError&&e.code===expected;

test('auth_mode absent/null and upstream user identity fallback are supported',()=>{
  const a=fakeAuth();delete a.auth.auth_mode;assert.equal(parseAuth(a.auth).identity.userId,'a');a.auth.auth_mode=null;assert.equal(parseAuth(a.auth).identity.userId,'a');
  const parts=a.auth.tokens.id_token.split('.');const claims=JSON.parse(Buffer.from(parts[1]!,'base64url').toString()) as Record<string,unknown>;
  delete (claims['https://api.openai.com/auth'] as Record<string,unknown>).chatgpt_user_id;parts[1]=Buffer.from(JSON.stringify(claims)).toString('base64url');a.auth.tokens.id_token=parts.join('.');assert.equal(parseAuth(a.auth).identity.userId,'a');
});
test('invalid JWT, missing tokens, wrong mode, and account contradictions are rejected',()=>{
  for(const alter of [(a:ReturnType<typeof fakeAuth>)=>{a.auth.tokens.id_token='bad';},(a:ReturnType<typeof fakeAuth>)=>{a.auth.tokens.refresh_token='';},(a:ReturnType<typeof fakeAuth>)=>{a.auth.tokens.account_id='wrong';}]){const a=fakeAuth();alter(a);assert.throws(()=>parseAuth(a.auth),code('INVALID_AUTH'));}
  assert.throws(()=>parseAuth({...fakeAuth().auth,auth_mode:'apikey'}),code('INVALID_AUTH'));
});
test('symlinks and permissive credential files fail closed',async t=>{
  const f=await setup();t.after(f.cleanup);const victim=path.join(f.home,'victim');await fs.rename(f.store.authPath,victim);await fs.symlink(victim,f.store.authPath);await assert.rejects(f.engine.use('B'),code('FILESYSTEM'));await fs.unlink(f.store.authPath);await fs.rename(victim,f.store.authPath);await fs.chmod(f.store.authPath,0o644);await assert.rejects(f.engine.sync(),code('FILESYSTEM'));
});
test('cache root symlink and hardlinked auth are rejected',async t=>{
  const f=await setup();t.after(f.cleanup);await fs.link(f.store.authPath,path.join(f.home,'hardlink'));await assert.rejects(f.engine.sync(),code('FILESYSTEM'));await fs.unlink(path.join(f.home,'hardlink'));
  const renamed=f.store.root+'-old';await fs.rename(f.store.root,renamed);await fs.symlink(renamed,f.store.root);await assert.rejects(f.store.state(),code('FILESYSTEM'));
});
test('configuration rejects credential URLs, non-loopback HTTP, redirects, keyring, alternate home and provider',async t=>{
  const f=await setup();t.after(f.cleanup);
  for(const url of ['http://server.example','https://secret@example.invalid','https://example.invalid/?token=secret'])assert.throws(()=>validateUrl(url),code('CONFIG'));
  await assert.rejects(checkCodexConfig(f.home,{CODEX_HOME:'/elsewhere'}),code('CONFIG'));
  for(const text of ['cli_auth_credentials_store="keyring"','model_provider="proxy"','[profiles.work]\ncli_auth_credentials_store="auto"']){await fs.writeFile(path.join(f.store.codex,'config.toml'),text);await assert.rejects(checkCodexConfig(f.home,{}),code('CONFIG'));}
  const client=new Client({baseUrl:'https://example.invalid',token:'secret'},async(_input,init)=>{assert.equal(init?.redirect,'error');throw new Error('redirect secret');});await assert.rejects(client.list(),code('UNAVAILABLE'));
});
test('management credential helper is explicit, secret stays in memory, stderr is suppressed',async t=>{
  const f=await setup();t.after(f.cleanup);const helper=path.join(f.home,'helper.mjs');await fs.writeFile(helper,"process.stdout.write('FAKE_HELPER_SECRET');");
  const file=path.join(f.store.root,'config.json');await fs.writeFile(file,JSON.stringify({baseUrl:f.server.url,credentialCommand:[process.execPath,helper]}),{mode:0o600});const c=await loadConfig(f.home,{});assert.equal(c.token,'FAKE_HELPER_SECRET');assert.ok(!safeOutput({name:c.token}).includes(c.token));assert.ok(!(await fs.readFile(file,'utf8')).includes(c.token));
  await fs.writeFile(helper,"process.stderr.write('FAKE_HELPER_SECRET');process.exit(1)");await assert.rejects(loadConfig(f.home,{}),e=>!safeError(e).includes('FAKE_HELPER_SECRET'));
});
test('HTTP error bodies are suppressed and authentication vs scope vs server failures are distinct',async()=>{
  for(const [status,expected] of [[401,'AUTHENTICATION'],[403,'AUTHORIZATION'],[503,'UNAVAILABLE']] as const){let attempts=0;const client=new Client({baseUrl:'https://example.invalid',token:'secret'},async()=>{attempts++;return new Response(JSON.stringify({error:'FAKE_SECRET'}),{status});});await assert.rejects(client.list(),code(expected));assert.equal(attempts,1);}
});
test('wrong import connection ID or newly created connection is rejected',async()=>{
  const client=new Client({baseUrl:'https://example.invalid',token:'secret'},async()=>new Response(JSON.stringify({created:true,connection:{id:'unexpected'}})));await assert.rejects(client.importAuth(fakeAuth(),'A'),code('IDENTITY_MISMATCH'));
});
test('doctor reports useful checks without throwing or revealing credentials',async t=>{
  const f=await setup();t.after(f.cleanup);await f.engine.sync();const report=await doctor(f.store,async()=>f.client,f.home,async()=>false);assert.ok(report.checks.some(c=>c.check==='active-mapping-and-conflict'&&c.ok));assert.ok(!JSON.stringify(report).includes('FAKE_REFRESH'));f.server.listStatus=401;const bad=await doctor(f.store,async()=>f.client,f.home,async()=>true);assert.equal(bad.ok,false);assert.ok(bad.checks.some(c=>c.detail.startsWith('AUTHENTICATION')));
});
test('killed lock holder releases kernel lock; SIGKILL during staging leaves active auth valid',async t=>{
  const f=await setup();t.after(f.cleanup);const before=await f.store.activeRaw();
  const source=`import {Store} from './src/local/store.ts';import {atomicWrite} from './src/local/files.ts';const s=new Store(process.argv[1]);await s.lock();await atomicWrite(s.authPath,${JSON.stringify(serialize(fakeAuth('b')))},{beforeRename:async()=>{setInterval(()=>{},1000);process.stdout.write('ready\\n');await new Promise(()=>{});}});`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source,f.home],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
  t.after(()=>{child.kill('SIGKILL');});
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('exit',()=>reject(new Error('child exited before staging')));child.once('error',reject);});
  await assert.rejects(acquireLock(path.join(f.store.root,'lock')),code('LOCKED'));child.kill('SIGKILL');await once(child,'exit');assert.equal(await f.store.activeRaw(),before);
  await f.engine.use('B');assert.equal(parseAuth((await f.store.activeRaw())!).identity.userId,'b');assert.deepEqual(await fs.readdir(f.store.codex),['auth.json']);
});
