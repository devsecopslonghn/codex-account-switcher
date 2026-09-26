import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { AppError } from '../domain/errors.js';
// flock locks an inherited open-file description. This parent retains that same
// description after flock exits. Kernel releases it even on SIGKILL: never unlink.
export async function acquireLock(file: string): Promise<() => Promise<void>> {
  if(process.platform !== 'linux') throw new AppError('UNSUPPORTED');
  let f: fs.FileHandle;
  try { f=await fs.open(file,constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,0o600); } catch { throw new AppError('FILESYSTEM'); }
  try {
    const s=await f.stat(); if(!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) throw new AppError('FILESYSTEM');
    const code=await new Promise<number|null>((resolve,reject)=>{const c=spawn('flock',['-n','-E','73','3'],{stdio:['ignore','ignore','ignore',f.fd]}); c.once('error',()=>reject(new AppError('UNSUPPORTED'))); c.once('close',resolve);});
    if(code === 73) throw new AppError('LOCKED'); if(code !== 0) throw new AppError('UNSUPPORTED');
    await f.truncate(0); await f.writeFile(JSON.stringify({pid:process.pid,acquiredAt:new Date().toISOString()}));
    return async()=>{await f.close();};
  } catch(e) {await f.close(); throw e;}
}
