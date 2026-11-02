import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';

const { createFFmpegExecution } = createRequire(import.meta.url)('../electron/ffmpeg-execution-engine.js');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const real = fs.realpathSync(root);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('subtool-input-pipe-'))
      throw new Error('拒絕清理測試根目錄之外的資料');
    fs.rmSync(real, { recursive:true, force:true });
  }
});
function fixture(makeInput) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-input-pipe-')); roots.push(root);
  let spawned;
  const engine = createFFmpegExecution({ getFFmpegPath:()=> 'ffmpeg', getUserDataDir:()=>root,
    spawnDirect:(_exe,args,options)=>{
      const child = new EventEmitter();
      child.stdin = makeInput(); child.stderr = new EventEmitter(); child.killed = false;
      child.kill = () => { child.killed = true; };
      spawned = { child, args, options }; return child;
    } });
  return { engine, get spawned() { return spawned; } };
}
const args = ['-f','wav','-i','pipe:0','-f','mp3','fd:'];

it('受控 stdin 背壓期間只讀取呼叫時複本，完成寫入且 child close 後才成功', async () => {
  const chunks = [], callbacks = [];
  const f = fixture(()=>new Writable({ highWaterMark:1, write(chunk,_encoding,callback) { chunks.push(Buffer.from(chunk)); callbacks.push(callback); } }));
  const bytes = Buffer.alloc(200_000, 17);
  let settled = false;
  const work = f.engine.execute(args,{ executionKind:'direct', inputBytes:bytes, outputDescriptor:7 }).finally(()=>{ settled=true; });
  expect(f.spawned.options.stdio).toEqual(['pipe',7,'pipe']);
  bytes.fill(99);
  while (!f.spawned.child.stdin.writableFinished) {
    if (callbacks.length) callbacks.shift()();
    await new Promise(resolve=>setImmediate(resolve));
  }
  expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(200_000,17));
  expect(settled).toBe(false);
  f.spawned.child.emit('close',0,null);
  await work;
});

it('stdin EPIPE 時終止 child、等待 close，不能成功或出現未處理錯誤', async () => {
  const f = fixture(()=>new Writable({ write(_chunk,_encoding,callback) { callback(Object.assign(new Error('broken pipe'),{code:'EPIPE'})); } }));
  let settled = false;
  const work = f.engine.execute(args,{ executionKind:'direct', inputBytes:Buffer.alloc(100_000), outputDescriptor:7 })
    .finally(()=>{ settled=true; }).catch(error=>error);
  await new Promise(resolve=>setImmediate(resolve));
  expect(f.spawned.child.killed).toBe(true);
  expect(settled).toBe(false);
  f.spawned.child.emit('close',0,null);
  expect(await work).toMatchObject({code:'EPIPE'});
});

it('onProcess 同步取消不寫入、等待 child close', async () => {
  let writes = 0;
  const f = fixture(()=>new Writable({ write(_chunk,_encoding,callback) { writes++; callback(); } }));
  let settled = false;
  const work = f.engine.execute(args,{ executionKind:'direct', inputBytes:Buffer.alloc(100), outputDescriptor:7,
    onProcess:child=>child.kill() }).finally(()=>{ settled=true; }).catch(error=>error);
  await new Promise(resolve=>setImmediate(resolve));
  expect(writes).toBe(0); expect(settled).toBe(false);
  f.spawned.child.emit('close',0,null);
  expect(await work).toBeInstanceOf(Error);
});

it('背壓中 child 提早 close 即使回傳 0 也不能成功或繼續寫入', async () => {
  const callbacks = []; let writes = 0;
  const f = fixture(()=>new Writable({ highWaterMark:1, write(_chunk,_encoding,callback) { writes++; callbacks.push(callback); } }));
  const work = f.engine.execute(args,{ executionKind:'direct', inputBytes:Buffer.alloc(200_000), outputDescriptor:7 }).catch(error=>error);
  expect(writes).toBe(1);
  f.spawned.child.emit('close',0,null);
  expect(await work).toBeInstanceOf(Error);
  callbacks[0]();
  await new Promise(resolve=>setImmediate(resolve));
  expect(writes).toBe(1);
});

it.each([
  { inputBytes:Buffer.alloc(0) },
  { inputBytes:Buffer.alloc(20_000_001) },
  { inputBytes:'not bytes' },
  { inputBytes:Buffer.from([1]), inputDescriptor:3 },
])('拒絕不合法的 inputBytes，不能啟動程序', async options => {
  const f = fixture(()=>new Writable({ write(_chunk,_encoding,callback) { callback(); } }));
  await expect(f.engine.execute(args,{ executionKind:'direct', ...options })).rejects.toThrow(/inputBytes/);
  expect(f.spawned).toBeUndefined();
});

it('inputBytes 不可用於 queued delivery、錯誤來源或重複 stdin 來源', async () => {
  const f = fixture(()=>new Writable({ write(_chunk,_encoding,callback) { callback(); } }));
  const inputBytes=Buffer.from([1]);
  await expect(f.engine.execute(args,{executionKind:'queued-delivery',inputBytes})).rejects.toThrow(/inputBytes/);
  await expect(f.engine.execute(['-i','file.wav','fd:'],{executionKind:'direct',inputBytes})).rejects.toThrow(/inputBytes/);
  await expect(f.engine.execute(['-i','pipe:0','-i','pipe:0','fd:'],{executionKind:'direct',inputBytes})).rejects.toThrow(/inputBytes/);
  expect(f.spawned).toBeUndefined();
});
