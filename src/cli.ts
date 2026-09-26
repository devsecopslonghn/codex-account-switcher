#!/usr/bin/env node
import os from 'node:os';
import { checkCodexConfig, loadConfig } from './config.js';
import { safeError, AppError } from './domain/errors.js';
import { Store } from './local/store.js';
import { Client, type Vault } from './omniroute/client.js';
import { Engine } from './sync/engine.js';
import { current, doctor, list } from './commands.js';
import { safeOutput } from './output.js';
const help=`codex-account — official Codex OAuth account manager\n\nCommands:\n  list             List OmniRoute Codex OAuth accounts\n  current          Show active local identity and sync status\n  sync             Push authoritative active auth to OmniRoute\n  sync-all         Push active auth; pull inactive account caches\n  use <selector>   Switch by unique ID, ID prefix, name, or email\n  rollback         Restore latest valid distinct backup (offline)\n  doctor           Check configuration, auth, permissions, connectivity, locks\n\nOnly ~/.codex/auth.json switches. Close Codex before use/rollback.\nConfigure ~/.codex-accounts/config.json with baseUrl and credentialCommand,\nor supply OMNIROUTE_URL and OMNIROUTE_MANAGEMENT_TOKEN via a secret manager.\nNo token command-line arguments are accepted. See README for setup.\n`;
async function main():Promise<void> {
  const [command,...args]=process.argv.slice(2);
  if(!command||command==='--help'||command==='help'){process.stdout.write(help);return;}
  if(command==='--version'){process.stdout.write('1.0.0\n');return;}
  if(!['list','current','sync','sync-all','use','rollback','doctor'].includes(command) || (command==='use'?args.length!==1||args[0]!.startsWith('-'):args.length!==0))throw new AppError('CONFIG');
  const home=os.homedir(),store=new Store(home),getVault=async()=>new Client(await loadConfig(home));
  if(command==='doctor'){const r=await doctor(store,getVault,home);process.stdout.write(safeOutput(r)+'\n');if(!r.ok)process.exitCode=1;return;}
  await checkCodexConfig(home);
  if(command==='rollback') {
    // Deliberately avoid loading management configuration or touching the network.
    const unavailable:Vault={list:async()=>{throw new AppError('CONFIG');},exportAuth:async()=>{throw new AppError('CONFIG');},importAuth:async()=>{throw new AppError('CONFIG');},health:async()=>{throw new AppError('CONFIG');}};
    process.stdout.write(safeOutput(await new Engine(store,unavailable).rollback())+'\n');return;
  }
  if(command==='current'){let vault:Vault|undefined,error:string|undefined;try{vault=await getVault();}catch(e){error=safeError(e);}process.stdout.write(safeOutput(await current(store,vault,error))+'\n');return;}
  const vault=await getVault();
  if(command==='list'){process.stdout.write(safeOutput(await list(store,vault))+'\n');return;}
  const engine=new Engine(store,vault),r=command==='use'?await engine.use(args[0]!):await engine.sync(command==='sync-all');
  process.stdout.write(safeOutput(r)+'\n');if(r.failures?.length)process.exitCode=1;
}
main().catch((error:unknown)=>{process.stderr.write(safeError(error)+'\n');process.exitCode=1;});
