import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
const { retireProxyCheckpoints } = require('../electron/preview-proxy-checkpoints.js');
const roots = [], runtimes = [];
const audio = [{ channels: 1 }, { channels: 1 }];
const filesOf = meta => [meta.proxy, meta.wave, ...meta.channels.map(channel => channel.file)].filter(Boolean);
async function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-local-preview-'));
  roots.push(root);
  const media = path.join(root, 'shared'), cacheRoot = path.join(root, 'profile', 'cache'), tempRoot = path.join(root, 'tmp');
  fs.mkdirSync(media); fs.mkdirSync(tempRoot);
  const source = path.join(media, 'mother.mov'); fs.writeFileSync(source, 'same authorized mother source');
  const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
  authority.grantTrustedFile(source);
  const execute = vi.fn(async args => {
    let byte = 15;
    for (const file of args.filter(arg => /\.(mp4|m4a|wav)$/.test(arg)))
      fs.writeFileSync(file, Buffer.alloc(file.endsWith('proxy.mp4') ? 131072 : 4096, byte++));
  });
  const options = { cacheRoot, tempRoot, fileAuthority: authority, ffmpegExecution: { execute },
    describeAudio: async () => audio, delay: async () => {}, ...overrides };
  const runtime = createMediaIntakeRuntime(options); runtimes.push(runtime);
  const saved = await runtime.ingest({ src: source, duration: 1, audio, needsProxy: true });
  const shared = path.join(media, '.subtool_Cache');
  return { root, media, shared, source, saved, runtime, authority, cacheRoot, options, execute };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each(['完成', '換收據', '取消'])('讀取 Proxy 分段收據時能存檔，%s 後只回收仍符合的分段', async action => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-local-preview-'));
  roots.push(root);
  const key = 'proxy-part-' + 'a'.repeat(64);
  const folder = path.join(root, key, 'entry-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  fs.mkdirSync(folder, { recursive: true });
  const receipt = path.join(folder, 'ready'), content = path.join(folder, 'content.mp4');
  fs.writeFileSync(receipt, JSON.stringify({ key }));
  fs.writeFileSync(content, 'keep this checkpoint');
  let reading, resume, current = true;
  const started = new Promise(resolve => { reading = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === receipt) {
      const read = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        const result = await read(buffer, offset, Math.min(7, length), position);
        reading();
        await gate;
        return result;
      };
    }
    return handle;
  });
  const cleanup = retireProxyCheckpoints({ dir: root, assertRetryOwner() {} }, () => current);
  try {
    await Promise.race([started, cleanup.then(() => { throw new Error('未進入收據讀取'); })]);
    const draft = path.join(root, 'draft.json');
    await fs.promises.writeFile(draft, JSON.stringify({ text: 'editing' }));
    expect(JSON.parse(await fs.promises.readFile(draft, 'utf8')).text).toBe('editing');
    if (action === '取消') current = false;
    else if (action === '換收據') fs.writeFileSync(receipt, JSON.stringify({ key, revision: 2 }));
  } finally {
    resume();
    await cleanup;
  }
  expect(fs.existsSync(content)).toBe(action !== '完成');
  expect(fs.existsSync(receipt)).toBe(action !== '完成');
  if (action !== '完成') expect(fs.readFileSync(content, 'utf8')).toBe('keep this checkpoint');
});

it('正式預覽只建立素材旁 cache，不建立本機中央 cache',async()=>{
  const f=await fixture();
  for(const file of filesOf(f.saved))expect(path.relative(f.shared,file)).not.toMatch(/^\.\./);
  expect(fs.existsSync(f.cacheRoot)).toBe(false);
  expect(f.runtime.prepareLocalPreview).toBeUndefined();
});

it('素材旁 cache 不能建立時明確失敗，不悄悄轉寫本機',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-local-preview-'));roots.push(root);
  const media=path.join(root,'media'),cacheRoot=path.join(root,'central');fs.mkdirSync(media);
  const source=path.join(media,'mother.mov');fs.writeFileSync(source,'mother');
  fs.writeFileSync(path.join(media,'.subtool_Cache'),'external file must remain');
  const authority=new FileAuthority({internalDirectories:[cacheRoot,root]});authority.grantTrustedFile(source);
  const execute=vi.fn(async args=>{for(const file of args.filter(arg=>/proxy\.mp4$/.test(arg)))fs.writeFileSync(file,Buffer.alloc(131072));});
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot:root,fileAuthority:authority,ffmpegExecution:{execute}});runtimes.push(runtime);
  await expect(runtime.ingest({src:source,duration:1,audio:[],needsProxy:true})).rejects.toThrow(/素材.*資料夾/);
  expect(execute).not.toHaveBeenCalled();expect(fs.existsSync(cacheRoot)).toBe(false);
  expect(fs.readFileSync(path.join(media,'.subtool_Cache'),'utf8')).toBe('external file must remain');
});

it('舊中央快取不作為正式預覽來源，也不搬回或刪除舊檔',async()=>{
  const f=await fixture({allowSidecarCache:false});
  const oldFiles=filesOf(f.saved),before=oldFiles.map(file=>fs.readFileSync(file));
  const runtime=createMediaIntakeRuntime({...f.options,allowSidecarCache:true});runtimes.push(runtime);
  f.execute.mockClear();
  const result=await runtime.ingest({src:f.source,duration:1,audio,needsProxy:true});
  expect(result.cached).toBe(false);expect(f.execute).toHaveBeenCalledOnce();
  for(const file of filesOf(result))expect(path.relative(f.shared,file)).not.toMatch(/^\.\./);
  oldFiles.forEach((file,index)=>expect(fs.readFileSync(file)).toEqual(before[index]));
});

it('重新開啟可直接重用已完成同夾資產，不轉檔、不複製到中央',async()=>{
  const f=await fixture(),runtime=createMediaIntakeRuntime(f.options);runtimes.push(runtime);f.execute.mockClear();
  const result=await runtime.ingest({src:f.source,duration:1,audio,needsProxy:true});
  expect(result).toMatchObject({cached:true,proxy:f.saved.proxy,channels:f.saved.channels,wave:f.saved.wave});
  expect(f.execute).not.toHaveBeenCalled();expect(fs.existsSync(f.cacheRoot)).toBe(false);
});

it('只重建播放器指認的損毀 Proxy，舊的失敗通知不會重建較新的世代',async()=>{
  const f=await fixture(),request={src:f.source,duration:1,audio:[],needsProxy:true,failedProxy:f.saved.proxy};
  fs.writeFileSync(f.saved.proxy,Buffer.alloc(fs.statSync(f.saved.proxy).size));
  f.execute.mockClear();
  const result=await f.runtime.ingest(request);
  expect(result.cached).toBe(false);expect(result.proxy).not.toBe(f.saved.proxy);
  expect(result.channels).toEqual(f.saved.channels);expect(result.wave).toBe(f.saved.wave);
  const args=f.execute.mock.calls[0][0];
  expect(args.filter(arg=>/\.(m4a|wav)$/.test(arg))).toEqual([]);
  expect(await f.runtime.ingest(request)).toMatchObject({cached:true,proxy:result.proxy});
  expect(f.execute).toHaveBeenCalledOnce();
});

function setRecordedProfile(shared, profile) {
  for(const entry of fs.readdirSync(shared,{recursive:true,withFileTypes:true})){
    if(!entry.isFile()||!['meta.json','cache-meta.json'].includes(entry.name))continue;
    const file=path.join(entry.parentPath||entry.path,entry.name),raw=JSON.parse(fs.readFileSync(file,'utf8'));
    if(raw.proxy){raw.proxyProfileVersion=profile;fs.writeFileSync(file,JSON.stringify(raw));}
  }
}

it('上版 480p Proxy 直接命中；補波形時保留來源規格',async()=>{
  const f=await fixture({describeVideo:async()=>({codec:'h264',width:1920,height:1080})});
  const profile='480p-1000k-fast-v1';
  setRecordedProfile(f.shared,profile);
  const runtime=createMediaIntakeRuntime(f.options);runtimes.push(runtime);f.execute.mockClear();
  const request={src:f.source,duration:1,audio,needsProxy:true};
  expect(await runtime.ingest(request)).toMatchObject({cached:true,proxy:f.saved.proxy});
  expect(f.execute).not.toHaveBeenCalled();
  fs.unlinkSync(f.saved.wave);
  expect(await runtime.ingest(request)).toMatchObject({cached:false,proxy:f.saved.proxy});
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.execute.mock.calls[0][0]).not.toContain('-c:v');
  const index=path.resolve(f.saved.proxy,'..','..','meta.json');
  expect(JSON.parse(fs.readFileSync(index,'utf8')).proxyProfileVersion).toBe(profile);
});

it('舊 720p Proxy 規格只重建影片，保留已驗證聲道與波形',async()=>{
  const f=await fixture({describeVideo:async()=>({codec:'h264',width:1920,height:1080,fps:25})});
  setRecordedProfile(f.shared,'720p-crf26-v1');
  const oldProxy=fs.readFileSync(f.saved.proxy);f.execute.mockClear();
  const runtime=createMediaIntakeRuntime(f.options);runtimes.push(runtime);
  const result=await runtime.ingest({src:f.source,duration:1,audio,needsProxy:true});
  expect(result.proxy).not.toBe(f.saved.proxy);expect(result.cached).toBe(false);
  expect(result.channels).toEqual(f.saved.channels);expect(result.wave).toBe(f.saved.wave);
  expect(f.execute).toHaveBeenCalledOnce();
  const args=f.execute.mock.calls[0][0],outputs=args.filter(arg=>/\.(mp4|m4a|wav)$/.test(arg));
  expect(outputs).toEqual([result.proxy]);expect(args[args.indexOf('-vf')+1]).toContain("scale=-2:'clip(trunc(ih/2)*2,2,720)'");
  expect(args[args.indexOf('-b:v')+1]).toBe('4000k');
  expect(fs.readFileSync(f.saved.proxy)).toEqual(oldProxy);
  expect(fs.existsSync(f.cacheRoot)).toBe(false);
});
