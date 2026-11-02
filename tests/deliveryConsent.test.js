import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import crypto from 'node:crypto';

const require=createRequire(import.meta.url);
const {FileAuthority}=require('../electron/file-authority');
const {createDeliveryConsent}=require('../electron/delivery-consent');
const Lease=require('../electron/export-lease');
const roots=[];
it('正式 preload 暴露預檢及釋放通道，不接收 renderer 提供的目的檔身分',async()=>{
  let api;const invoke=vi.fn(async()=>({id:'opaque',existing:[]}));
  vm.runInNewContext(fs.readFileSync('electron/preload.js','utf8'),{
    require:()=>({contextBridge:{exposeInMainWorld:(_name,exposed)=>{api=exposed;}},ipcRenderer:{invoke},webUtils:{}}),
    ArrayBuffer,Uint8Array,Promise,TypeError,RangeError,
  });
  await api.beginDeliveryTargetRequest('request-id');
  expect(invoke).toHaveBeenLastCalledWith('delivery:beginTargetRequest','request-id');
  await api.prepareDeliveryTargets(['output.mp4'],'request-id','ticket');
  expect(invoke).toHaveBeenCalledWith('delivery:prepareTargets',{paths:['output.mp4'],requestId:'request-id',ticket:'ticket'});
  await api.cancelDeliveryTargetRequest('request-id','ticket');
  expect(invoke).toHaveBeenLastCalledWith('delivery:cancelTargetRequest',{requestId:'request-id',ticket:'ticket'});
  await api.finishDeliveryTargetRequest('request-id','ticket');
  expect(invoke).toHaveBeenLastCalledWith('delivery:finishTargetRequest',{requestId:'request-id',ticket:'ticket'});
  await api.releaseDeliveryTargets('opaque');
  expect(invoke).toHaveBeenLastCalledWith('delivery:releaseTargets','opaque');
});
afterEach(()=>{for(const root of roots.splice(0)){
  const real=fs.realpathSync(root);
  if(path.dirname(real)!==fs.realpathSync(os.tmpdir())||!path.basename(real).startsWith('subtool-consent-')) throw new Error('拒絕刪除測試目錄以外資料');
  fs.rmSync(real,{recursive:true,force:true});
}});
it('receipt 僅供相同 sender／path 各使用一次；取消及視窗銷毀清除剩餘項目',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-consent-'));roots.push(root);
  const authority=new FileAuthority();authority.grantDeliveryDirectory(root);
  const owner=new EventEmitter(),other=new EventEmitter(),a=path.join(root,'a.mp4'),b=path.join(root,'b.mp4');
  fs.writeFileSync(b,'existing');
  const consent=createDeliveryConsent({captureOutputAuthority:p=>authority.captureDeliveryOutput(p)});
  const receipt=await consent.prepare(owner,[a,b]);expect(receipt.existing).toEqual([b]);
  expect(()=>consent.take(other,receipt.id,a)).toThrow();
  expect(()=>consent.take(owner,'forged',a)).toThrow();
  expect(()=>consent.take(owner,receipt.id,path.join(root,'else.mp4'))).toThrow();
  expect(consent.take(owner,receipt.id,a).destinationEvidence.identity).toBeNull();
  expect(()=>consent.take(owner,receipt.id,a)).toThrow();
  expect(consent.release(other,receipt.id)).toBe(false);
  expect(consent.release(owner,receipt.id)).toBe(true);
  expect(()=>consent.take(owner,receipt.id,b)).toThrow();
  const next=await consent.prepare(owner,[b]);owner.emit('destroyed');
  expect(()=>consent.take(owner,next.id,b)).toThrow();
});

it('完整內容證據偵測同 inode 同大小且時間戳相同的原位覆寫',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-consent-'));roots.push(root);
  const file=path.join(root,'output.mp4');fs.writeFileSync(file,'original target');
  const authority=Lease.captureOutputAuthority(file,Lease.captureOutputDirectory(root));
  const original=fs.lstatSync(file,{bigint:true});
  const withFrozenTimes=stat=>{
    stat.mtimeNs=original.mtimeNs;stat.ctimeNs=original.ctimeNs;return stat;
  };
  const io={...fs,lstatSync:(name,...args)=>{
    const stat=fs.lstatSync(name,...args);
    return path.resolve(String(name))===path.resolve(file)&&typeof stat.mtimeNs==='bigint'?withFrozenTimes(stat):stat;
  },promises:{open:async(...args)=>{
    const handle=await fs.promises.open(...args);
    return {read:(...params)=>handle.read(...params),close:()=>handle.close(),
      stat:async(...params)=>withFrozenTimes(await handle.stat(...params))};
  }}};
  const proof=await Lease.captureDestinationEvidenceAsync(authority,{io});
  expect(proof.destinationEvidence.sha256).toBe(crypto.createHash('sha256').update('original target').digest('hex'));
  fs.writeFileSync(file,'modified target');
  expect(()=>Lease.assertDestinationEvidence(proof,io)).not.toThrow();
  await expect(Lease.assertDestinationEvidenceAsync(proof,{io})).rejects.toMatchObject({code:'DELIVERY_DESTINATION_CHANGED'});
  expect(fs.readFileSync(file,'utf8')).toBe('modified target');
});

it('雜湊期間取消會中止後續讀取並關閉描述符',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-consent-'));roots.push(root);
  const file=path.join(root,'output.mp4');fs.writeFileSync(file,Buffer.alloc(2*1024*1024,1));
  const authority=Lease.captureOutputAuthority(file,Lease.captureOutputDirectory(root));
  let entered,release,closed=false,reads=0;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const io={...fs,promises:{open:async(...args)=>{
    const handle=await fs.promises.open(...args);
    return {stat:(...params)=>handle.stat(...params),close:async()=>{closed=true;await handle.close();},
      read:async(...params)=>{reads++;entered();await gate;return handle.read(...params);}};
  }}};
  const controller=new AbortController();
  const pending=Lease.captureDestinationEvidenceAsync(authority,{signal:controller.signal,io});
  await started;controller.abort();release();
  await expect(pending).rejects.toMatchObject({name:'AbortError'});
  expect(reads).toBe(1);expect(closed).toBe(true);
});

it('內容讀完後若在關閉 handle 期間取消，等待實際關閉且不交出成功證據',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-consent-'));roots.push(root);
  const file=path.join(root,'output.mp4');fs.writeFileSync(file,'original');
  const authority=Lease.captureOutputAuthority(file,Lease.captureOutputDirectory(root));
  let entered,release,closed=false;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const io={...fs,promises:{open:async(...args)=>{
    const handle=await fs.promises.open(...args);
    return {stat:(...params)=>handle.stat(...params),read:(...params)=>handle.read(...params),
      close:async()=>{entered();await gate;await handle.close();closed=true;}};
  }}};
  const controller=new AbortController();
  const pending=Lease.captureDestinationEvidenceAsync(authority,{signal:controller.signal,io});
  await started;controller.abort();release();
  await expect(pending).rejects.toMatchObject({name:'AbortError'});
  expect(closed).toBe(true);
  expect(fs.readFileSync(file,'utf8')).toBe('original');
});

it.each(['取消','視窗銷毀'])('收據準備期間%s，後續證據不會發布收據',async action=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-consent-'));roots.push(root);
  const owner=new EventEmitter(),file=path.join(root,'existing.mp4'),controller=new AbortController();fs.writeFileSync(file,'original');
  const authority=new FileAuthority();authority.grantDeliveryDirectory(root);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const consent=createDeliveryConsent({captureOutputAuthority:p=>authority.captureDeliveryOutput(p),randomId:()=> 'receipt',
    captureEvidence:async (entry,{signal})=>{await gate;signal.throwIfAborted();return Lease.captureDestinationEvidenceAsync(entry,{signal});}});
  const preparing=consent.prepare(owner,[file],{signal:controller.signal});
  if(action==='取消')controller.abort();else owner.emit('destroyed');
  release();await expect(preparing).rejects.toBeTruthy();
  expect(()=>consent.take(owner,'receipt',file)).toThrow();
  expect(owner.listenerCount('destroyed')).toBe(0);
});

it('舊有目的檔的 v1 證據不可當成完整覆寫確認',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-consent-'));roots.push(root);
  const file=path.join(root,'output.mp4');fs.writeFileSync(file,'existing');
  const authority=Lease.captureDestinationEvidence(Lease.captureOutputAuthority(file,Lease.captureOutputDirectory(root)));
  expect(Lease.needsDeliveryDestinationConfirmation(authority)).toBe(true);
  await expect(Lease.assertDeliveryDestinationEvidenceAsync(authority)).rejects.toMatchObject({code:'DELIVERY_DESTINATION_CONFIRMATION_REQUIRED'});
  const current=await Lease.captureDestinationEvidenceAsync(authority);
  expect(Lease.needsDeliveryDestinationConfirmation(current)).toBe(false);
  await expect(Lease.assertDeliveryDestinationEvidenceAsync(current)).resolves.toBeUndefined();
});
