import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { createDeliveryList } from '../src/delivery-list.js';
import { createDeliverySubmission, freezeExportSubmission } from '../src/delivery-submission.js';

const require=createRequire(import.meta.url);
const {FileAuthority}=require('../electron/file-authority');
const {createExportAdmission,createExportQueue}=require('../electron/export-queue');
const ExportLease=require('../electron/export-lease');
const {outputKey}=ExportLease;
const {createDeliveryConsent}=require('../electron/delivery-consent');
const {createDeliveryPreparation}=require('../electron/delivery-preparation');
const {prepareDeliveryPayload}=require('../electron/export-plan');
const {expectedExportExtension}=require('../electron/ipc-guards');
const {getDeliveryFormatPreset}=require('../shared/delivery-formats.cjs');
const QueueStore=require('../electron/queue-store');
const source=fs.readFileSync('electron/main.js','utf8'),tree=parse(source,{ecmaVersion:'latest',sourceType:'script'});
const roots=[];
afterEach(()=>{for(const root of roots.splice(0)){
  const real=fs.realpathSync(root);
  if(path.dirname(real)!==fs.realpathSync(os.tmpdir())||!path.basename(real).startsWith('subtool-admission-race-')) throw new Error('拒絕刪除測試目錄以外資料');
  fs.rmSync(real,{recursive:true,force:true});
}});

it('真 export IPC 同時欠缺來源與目的能力時先拒絕來源，且不授權任何路徑',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-admission-race-'));roots.push(root);
  const mother=path.join(root,'mother.mov'),target=path.join(root,'delivery.mp4'),queueDir=path.join(root,'queue');
  fs.writeFileSync(mother,'source');
  const authority=new FileAuthority();let queue;
  const admission=createExportAdmission({expectedExtensionFor:expectedExportExtension,outputKeyFor:outputKey,
    mergeSourcePaths:QueueStore.mergeSourcePaths,currentJobs:()=>queue?.jobs()||[],canReadSource:p=>authority.canRead(p),
    canWriteDelivery:p=>authority.canWriteDelivery(p),isPreviewCacheMedia:()=>false});
  queue=createExportQueue({dir:()=>queueDir,store:QueueStore,history:QueueStore.QueueHistory,admission,
    canReadSource:p=>authority.canRead(p),canWriteDelivery:p=>authority.canWriteDelivery(p),isFile:p=>fs.statSync(p).isFile(),
    captureOutputAuthority:p=>authority.captureDeliveryOutput(p),runJob:vi.fn(),onChanged(){}});queue.setPaused(true);
  const deliveryConsent=createDeliveryConsent({captureOutputAuthority:p=>authority.captureDeliveryOutput(p)});
  const deliveryPreparation=createDeliveryPreparation(deliveryConsent);
  const capabilities={assertReady:vi.fn()};
  const call=tree.body.map(node=>node.expression).find(node=>node?.callee?.object?.name==='ipcMain'
    &&node.callee.property?.name==='handle'&&node.arguments?.[0]?.value==='ffmpeg:exportVideo');
  let invoke;
  vm.runInNewContext(source.slice(call.start,call.end),{ipcMain:{handle:(_name,fn)=>{invoke=fn;}},FFMPEG:'ffmpeg',
    prepareDeliveryPayload,getDeliveryFormatPreset,expectedExportExtension,QueueManager:queue,deliveryCapabilities:capabilities,
    fileAuthority:authority,ExportLease,deliveryConsent,deliveryPreparation,newJobId:()=> 'job',JOB_STATUS:{QUEUED:'queued'},
    QueueStore,EXPORT_QUEUE_DIR:queueDir,openQueueWindow(){}});
  const payload={outPath:target,format:'h264',width:640,height:360,fps:25,duration:1,clips:[{path:mother,in:0,out:1,offset:0}]};
  await expect(invoke({sender:{id:1}},payload)).rejects.toThrow(/匯出來源未經授權/);
  expect(authority.canRead(mother)).toBe(false);expect(authority.canWriteDelivery(target)).toBe(false);
  authority.grantTrustedFile(mother);
  await expect(invoke({sender:{id:1}},payload)).rejects.toThrow(/匯出輸出位置未經授權/);
  expect(authority.canWriteDelivery(target)).toBe(false);expect(capabilities.assertReady).not.toHaveBeenCalled();
  expect(queue.jobs()).toEqual([]);expect(fs.existsSync(target)).toBe(false);
  const sender={id:2},untrusted=path.join(root,'untrusted.mov');fs.writeFileSync(untrusted,'not authorized');
  authority.grantDeliveryDirectory(root);
  const receipt=await deliveryConsent.prepare(sender,[target]);
  await expect(invoke({sender},{...payload,deliveryReceipt:receipt.id,clips:[{path:untrusted,in:0,out:1,offset:0}]}))
    .rejects.toThrow(/匯出來源未經授權/);
  expect(deliveryConsent.take(sender,receipt.id,target).destinationEvidence.identity).toBeNull();
  const idA='delivery-a',idB='delivery-b';
  const ticketA=deliveryPreparation.begin(sender,idA),ticketB=deliveryPreparation.begin(sender,idB);
  const receiptA=await deliveryPreparation.prepare(sender,[target],idA,ticketA);
  const receiptB=await deliveryPreparation.prepare(sender,[target],idB,ticketB);
  await expect(invoke({sender},{...payload,deliveryReceipt:receiptA.id,deliveryRequestId:idB,deliveryRequestTicket:ticketB}))
    .rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
  expect(deliveryPreparation.signal(sender,idA,ticketA,receiptA.id).aborted).toBe(false);
  expect(deliveryPreparation.signal(sender,idB,ticketB,receiptB.id).aborted).toBe(false);
  expect(queue.jobs()).toEqual([]);
  deliveryPreparation.finish(sender,idA,ticketA);deliveryPreparation.finish(sender,idB,ticketB);
});

it.each(['檢查後建立','確認後替換','確認後不變'])('交付清單%s時的覆寫確認與入列',async change=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-admission-race-'));roots.push(root);
  const directory=path.join(root,'out'),queueDir=path.join(root,'queue');fs.mkdirSync(directory);
  const mother=path.join(root,'mother.mov'),target=path.join(directory,'delivery.mp4');fs.writeFileSync(mother,'source');
  if(change!=='檢查後建立')fs.writeFileSync(target,'original target');
  const authority=new FileAuthority();authority.grantTrustedFile(mother);authority.grantDeliveryDirectory(directory);
  let queue;
  const admission=createExportAdmission({expectedExtensionFor:expectedExportExtension,outputKeyFor:outputKey,
    mergeSourcePaths:QueueStore.mergeSourcePaths,currentJobs:()=>queue?.jobs()||[],canReadSource:p=>authority.canRead(p),
    canWriteDelivery:p=>authority.canWriteDelivery(p),isPreviewCacheMedia:()=>false});
  queue=createExportQueue({dir:()=>queueDir,store:QueueStore,history:QueueStore.QueueHistory,admission,
    canReadSource:p=>authority.canRead(p),canWriteDelivery:p=>authority.canWriteDelivery(p),isFile:p=>fs.statSync(p).isFile(),
    captureOutputAuthority:p=>authority.captureDeliveryOutput(p),runJob:vi.fn(),onChanged(){}});
  queue.setPaused(true);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const capabilities={assertReady:vi.fn(()=>gate)};
  const deliveryConsent=createDeliveryConsent({captureOutputAuthority:p=>authority.captureDeliveryOutput(p)});
  const deliveryPreparation=createDeliveryPreparation(deliveryConsent);
  const call=tree.body.map(node=>node.expression).find(node=>node?.callee?.object?.name==='ipcMain'
    &&node.callee.property?.name==='handle'&&node.arguments?.[0]?.value==='ffmpeg:exportVideo');
  let invoke;
  vm.runInNewContext(source.slice(call.start,call.end),{ipcMain:{handle:(_name,fn)=>{invoke=fn;}},FFMPEG:'ffmpeg',
    prepareDeliveryPayload,getDeliveryFormatPreset,expectedExportExtension,QueueManager:queue,deliveryCapabilities:capabilities,
    fileAuthority:authority,ExportLease,deliveryConsent,deliveryPreparation,newJobId:()=> 'race-job',JOB_STATUS:{QUEUED:'queued'},QueueStore,EXPORT_QUEUE_DIR:queueDir,openQueueWindow(){}});
  const sender={id:1};
  function control(channel){
    const expression=tree.body.map(node=>node.expression).find(node=>node?.callee?.object?.name==='ipcMain'
      &&node.callee.property?.name==='handle'&&node.arguments?.[0]?.value===channel);
    let handler;vm.runInNewContext(source.slice(expression.start,expression.end),{ipcMain:{handle:(_name,fn)=>{handler=fn;}},deliveryConsent,deliveryPreparation});
    return (...args)=>handler({sender},...args);
  }
  const project=freezeExportSubmission({clips:[{path:mother,type:'video',in:0,out:1,offset:0,vtrack:0}],
    videoTracks:[{vt:0,visible:true}],duration:1,audioPlan:null,audioOnly:false},
  {mediaName:'mother.mov',fps:25,cues:[],tracks:[]});
  const list=createDeliveryList({projectTag:'mother',fps:25,canvasW:1920,canvasH:1080});
  list.setName(0,'delivery.mp4');list.setOutDir(0,directory);
  const confirmOverwrite=vi.fn(async()=>true);
  const submission=createDeliverySubmission({list,initialProject:project,readProject:()=>project,isCurrent:()=>true,confirmOverwrite,
    desktop:{listDir:vi.fn(async p=>fs.readdirSync(p)),beginDeliveryTargetRequest:control('delivery:beginTargetRequest'),
      prepareDeliveryTargets:(paths,requestId,ticket)=>control('delivery:prepareTargets')({paths,requestId,ticket}),
      releaseDeliveryTargets:control('delivery:releaseTargets'),
      cancelDeliveryTargetRequest:(requestId,ticket)=>control('delivery:cancelTargetRequest')({requestId,ticket}),
      finishDeliveryTargetRequest:(requestId,ticket)=>control('delivery:finishTargetRequest')({requestId,ticket}),exportVideo:payload=>invoke({sender},payload)}});
  const pending=submission.submit();
  try{
    await vi.waitFor(()=>expect(capabilities.assertReady).toHaveBeenCalledOnce());
    if(change==='確認後替換')fs.unlinkSync(target);
    if(change!=='確認後不變')fs.writeFileSync(target,'new unrelated content');
    release();
    const result=await pending;
    if(change==='確認後不變') {
      expect(result).toMatchObject({status:'submitted',accepted:1});expect(queue.jobs()).toHaveLength(1);expect(list.count()).toBe(0);
      expect(queue.jobs()[0].outputAuthority.destinationEvidence.identity).not.toBeNull();
      expect(queue.jobs()[0].payload).not.toHaveProperty('deliveryReceipt');
      expect(fs.readFileSync(target,'utf8')).toBe('original target');
    }else{
      expect(result).toMatchObject({status:'failed',accepted:0});
      expect(queue.jobs()).toEqual([]);expect(list.count()).toBe(1);
      expect(fs.readFileSync(target,'utf8')).toBe('new unrelated content');
    }
    expect(confirmOverwrite).toHaveBeenCalledTimes(change==='檢查後建立'?0:1);
  }finally{release();}
});

it.each(['舊入口既有檔','舊入口新檔','Save dialog 既有檔','Save dialog 等待時替換','視窗等待期間關閉','偽造收據'])('%s 的 main IPC 授權行為',async scenario=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-admission-race-'));roots.push(root);
  const directory=path.join(root,'out'),queueDir=path.join(root,'queue');fs.mkdirSync(directory);
  const mother=path.join(root,'mother.mov'),target=path.join(directory,'delivery.mp4');fs.writeFileSync(mother,'source');
  if(scenario.includes('既有檔')||scenario.includes('替換'))fs.writeFileSync(target,'original target');
  const authority=new FileAuthority();authority.grantTrustedFile(mother);authority.grantDeliveryDirectory(directory);
  let queue;
  const admission=createExportAdmission({expectedExtensionFor:expectedExportExtension,outputKeyFor:outputKey,
    mergeSourcePaths:QueueStore.mergeSourcePaths,currentJobs:()=>queue?.jobs()||[],canReadSource:p=>authority.canRead(p),
    canWriteDelivery:p=>authority.canWriteDelivery(p),isPreviewCacheMedia:()=>false});
  queue=createExportQueue({dir:()=>queueDir,store:QueueStore,history:QueueStore.QueueHistory,admission,
    canReadSource:p=>authority.canRead(p),canWriteDelivery:p=>authority.canWriteDelivery(p),isFile:p=>fs.statSync(p).isFile(),
    captureOutputAuthority:p=>authority.captureDeliveryOutput(p),runJob:vi.fn(),onChanged(){}});queue.setPaused(true);
  let release,closed=false;const gate=new Promise(resolve=>{release=resolve;});
  const capabilities={assertReady:vi.fn(()=>gate)},sender={id:1,isDestroyed:()=>closed};
  const deliveryConsent=createDeliveryConsent({captureOutputAuthority:p=>authority.captureDeliveryOutput(p)});
  const deliveryPreparation=createDeliveryPreparation(deliveryConsent);
  const call=tree.body.map(node=>node.expression).find(node=>node?.callee?.object?.name==='ipcMain'
    &&node.callee.property?.name==='handle'&&node.arguments?.[0]?.value==='ffmpeg:exportVideo');
  let invoke;
  vm.runInNewContext(source.slice(call.start,call.end),{ipcMain:{handle:(_name,fn)=>{invoke=fn;}},FFMPEG:'ffmpeg',
    prepareDeliveryPayload,getDeliveryFormatPreset,expectedExportExtension,QueueManager:queue,deliveryCapabilities:capabilities,
    fileAuthority:authority,ExportLease,deliveryConsent,deliveryPreparation,dialog:{showSaveDialog:async()=>({filePath:target,canceled:false})},mainWin:{},
    newJobId:()=> 'direct-job',JOB_STATUS:{QUEUED:'queued'},QueueStore,EXPORT_QUEUE_DIR:queueDir,openQueueWindow(){}});
  const payload={format:'h264',width:640,height:360,fps:25,duration:1,clips:[{path:mother,in:0,out:1,offset:0}],
    ...(scenario.startsWith('Save dialog')?{}:{outPath:target}),...(scenario==='偽造收據'?{deliveryReceipt:'forged'}:{})};
  const pending=invoke({sender},payload);
  try{
    if(scenario==='舊入口既有檔'||scenario==='偽造收據'){
      await expect(pending).rejects.toThrow();expect(capabilities.assertReady).not.toHaveBeenCalled();
    }else{
      await vi.waitFor(()=>expect(capabilities.assertReady).toHaveBeenCalledOnce());
      if(scenario==='Save dialog 等待時替換'){fs.unlinkSync(target);fs.writeFileSync(target,'replacement');}
      if(scenario==='視窗等待期間關閉')closed=true;
      release();
      if(scenario==='Save dialog 等待時替換'||scenario==='視窗等待期間關閉')await expect(pending).rejects.toThrow();
      else {
        await expect(pending).resolves.toBe('direct-job');
        expect(queue.get('direct-job').payload).not.toHaveProperty('deliveryReceipt');
        expect(queue.get('direct-job').outputAuthority.destinationEvidence.identity===null).toBe(scenario==='舊入口新檔');
      }
    }
    if(scenario==='Save dialog 等待時替換')expect(fs.readFileSync(target,'utf8')).toBe('replacement');
  }finally{release();}
});
