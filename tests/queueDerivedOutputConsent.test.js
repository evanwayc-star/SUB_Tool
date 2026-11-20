import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';

const require=createRequire(import.meta.url);
const {FileAuthority}=require('../electron/file-authority');
const {createExportAdmission,createExportQueue}=require('../electron/export-queue');
const ExportLease=require('../electron/export-lease');
const QueueStore=require('../electron/queue-store');
const {expectedExportExtension}=require('../electron/ipc-guards');
const {deriveDeliverySpec}=require('../shared/delivery-resolution.cjs');
const formats=require('../shared/delivery-formats.cjs');
const source=fs.readFileSync('electron/main.js','utf8'),tree=parse(source,{ecmaVersion:'latest',sourceType:'script'});
const roots=[];
afterEach(()=>{for(const root of roots.splice(0)){
  const real=fs.realpathSync(root);
  if(path.dirname(real)!==fs.realpathSync(os.tmpdir())||!path.basename(real).startsWith('subtool-queue-consent-')) throw new Error('拒絕刪除測試目錄以外資料');
  fs.rmSync(real,{recursive:true,force:true});
}});
function setup({existingOutput=false,outputName='delivery.mp4',payload={}}={}){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-queue-consent-'));roots.push(root);
  const directory=path.join(root,'out'),queueDir=path.join(root,'queue');fs.mkdirSync(directory);
  const mother=path.join(root,'source.mp4');fs.writeFileSync(mother,'mother');
  const outPath=path.join(directory,outputName),authority=new FileAuthority();
  if(existingOutput) fs.writeFileSync(outPath,'existing output');
  authority.grantTrustedFile(mother);authority.grantDeliveryDirectory(directory);
  let queue;
  const admission=createExportAdmission({expectedExtensionFor:expectedExportExtension,outputKeyFor:ExportLease.outputKey,
    mergeSourcePaths:QueueStore.mergeSourcePaths,currentJobs:()=>queue?.jobs()||[],canReadSource:p=>authority.canRead(p),
    canWriteDelivery:p=>authority.canWriteDelivery(p),isPreviewCacheMedia:()=>false});
  const context=vm.createContext({path,ExportLease,expectedExportExtension,deriveDeliverySpec,...formats,
    JOB_STATUS:{QUEUED:'queued'},fileAuthority:authority,_admission:admission});
  const declaration=tree.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name==='prepareQueueDeliveryUpdate');
  vm.runInContext(source.slice(declaration.start,declaration.end),context);
  queue=createExportQueue({dir:()=>queueDir,store:QueueStore,history:QueueStore.QueueHistory,admission,
    canReadSource:p=>authority.canRead(p),canWriteDelivery:p=>authority.canWriteDelivery(p),isFile:p=>fs.statSync(p).isFile(),
    captureOutputAuthority:p=>authority.captureDeliveryOutput(p),prepareDeliveryUpdate:(...args)=>context.prepareQueueDeliveryUpdate(...args),
    runJob:vi.fn(),onChanged(){}});
  queue.setPaused(true);
  queue.addJob({id:'job',status:'queued',createdAt:1,payload:{outPath,format:'h264',width:640,height:360,fps:25,duration:1,timelineStartTimecode:'00:00:00:00',
    clips:[{path:mother,in:0,out:1,offset:0}],...payload}});
  const call=tree.body.map(node=>node.expression).find(node=>node?.callee?.object?.name==='ipcMain'
    &&node.callee.property?.name==='handle'&&node.arguments?.[0]?.value==='queue:updateDelivery');
  let invoke;
  vm.runInNewContext(source.slice(call.start,call.end),{ipcMain:{handle:(_name,fn)=>{invoke=fn;}},QueueManager:queue});
  return {queue,queueDir,outPath,invoke};
}

it.each([
  ['格式','file',{format:'prores'},'delivery.mov'],['格式','directory',{format:'prores'},'delivery.mov'],
  ['燒入時碼','file',{burnTimecode:true},'delivery_TC.mp4'],['燒入時碼','directory',{burnTimecode:true},'delivery_TC.mp4'],
])('queue IPC 修改%s碰到既有%s時拒絕，保留檔案與持久化工作',(_change,kind,patch,name)=>{
  const f=setup(),target=path.join(path.dirname(f.outPath),name);
  if(kind==='file') fs.writeFileSync(target,'other delivery');else fs.mkdirSync(target);
  const before=structuredClone(f.queue.get('job'));
  const persisted=structuredClone(QueueStore.loadJobs(f.queueDir).jobs[0]);
  expect(()=>f.invoke({},'job',patch)).toThrow(/輸出.*已存在/);
  expect(f.queue.get('job')).toEqual(before);
  expect(QueueStore.loadJobs(f.queueDir).jobs[0]).toEqual(persisted);
  if(kind==='file') expect(fs.readFileSync(target,'utf8')).toBe('other delivery');
  else expect(fs.statSync(target).isDirectory()).toBe(true);
});

it('同路徑修改保留當初已授權的既有輸出檔',()=>{
  const f=setup({existingOutput:true});
  const evidence=structuredClone(f.queue.get('job').outputAuthority.destinationEvidence);
  f.invoke({},'job',{format:'h264',targetH:720});
  expect(f.queue.get('job').outputAuthority.destinationEvidence).toEqual(evidence);
  expect(fs.readFileSync(f.outPath,'utf8')).toBe('existing output');
});

it('自訂尺寸持久化，保留其他欄位修改；切回高度預設後，重新以畫布比例計算',()=>{
  const f=setup();
  const persisted=()=>QueueStore.loadJobs(f.queueDir).jobs[0].payload;
  f.invoke({},'job',{targetW:480,targetH:720});
  expect(persisted()).toMatchObject({targetW:480,targetH:720,width:480,height:720,outPath:f.outPath});
  f.invoke({},'job',{kbps:2400});
  expect(persisted()).toMatchObject({targetW:480,width:480,height:720,videoKbps:2400});
  expect(()=>f.invoke({},'job',{targetW:481,targetH:720})).toThrow(/自訂寬度與高度/);
  expect(persisted().targetW).toBe(480);
  f.invoke({},'job',{targetH:720});
  expect(persisted()).not.toHaveProperty('targetW');
  expect(persisted()).toMatchObject({width:1280,height:720,targetH:720,outPath:f.outPath});
});

it('影片工作改 MP3 時清除影片專用選項，保留選軌與單一音檔權限',()=>{
  const audioPlan={buses:[{id:'L'},{id:'R'}],streams:[{layout:'mono',busIds:['R']},{layout:'mono',busIds:['L']}]};
  const f=setup({outputName:'delivery_TC.mp4',payload:{audioPlan,timecodeWatermark:{start:'00:00:00:00'},
    targetW:800,targetH:640,chapters:[{kind:'note',title:'備註',start:0}]}});
  f.invoke({},'job',{format:'mp3',burnTimecode:true});
  const saved=QueueStore.loadJobs(f.queueDir).jobs[0].payload;
  expect(saved).toMatchObject({outPath:path.join(path.dirname(f.outPath),'delivery.mp3'),timecodeWatermark:null,
    videoKbps:null,audioPlan:{streams:[{layout:'stereo',busIds:['R','L']}]}});
  expect(saved).not.toHaveProperty('chapters');
  expect(saved).not.toHaveProperty('targetW');
  f.invoke({},'job',{format:'prores'});
  expect(f.queue.get('job').payload).toMatchObject({outPath:path.join(path.dirname(f.outPath),'delivery.mov'),
    audioPlan:{streams:[{layout:'stereo',busIds:['R','L']}]}});
});

it('舊 WAV 依選定 bus 順序改 MP3；純音訊工作經任一格式都需有影片才能改回影片',()=>{
  const f=setup({outputName:'delivery.wav',payload:{format:'wav',clips:[],audioPlan:{buses:[{id:'B'},{id:'A'}],streams:[]}}});
  f.invoke({},'job',{format:'mp3'});
  expect(f.queue.get('job').payload.audioPlan.streams[0]).toMatchObject({layout:'stereo',busIds:['B','A']});
  expect(()=>f.invoke({},'job',{format:'h264'})).toThrow(/沒有影像/);
  f.invoke({},'job',{format:'wav'});
  expect(()=>f.invoke({},'job',{format:'prores'})).toThrow(/沒有影像/);
});

it('多套影片語言／M&E 未選單一交付組時，改 MP3 被拒並維持原本工作',()=>{
  const ids=['主左','主右','配樂左','配樂右'];
  const f=setup({payload:{audioPlan:{buses:ids.map(id=>({id})),
    streams:[{layout:'stereo',busIds:ids.slice(0,2)},{layout:'stereo',busIds:ids.slice(2)}]}}});
  expect(()=>f.invoke({},'job',{format:'mp3'})).toThrow(/MP3 需要一組音軌/);
  expect(QueueStore.loadJobs(f.queueDir).jobs[0].payload.outPath).toBe(f.outPath);
});

it('只修改解析度時保留原副檔名大小寫，另一個大小寫不同的目錄項目不受影響',()=>{
  const f=setup({existingOutput:true,outputName:'delivery.MP4'});
  const other=path.join(path.dirname(f.outPath),'delivery.mp4');
  const distinct=!fs.existsSync(other);
  if(distinct) fs.writeFileSync(other,'distinct lower-case entry');
  const evidence=structuredClone(f.queue.get('job').outputAuthority.destinationEvidence);
  f.invoke({},'job',{targetH:720});
  expect(f.queue.get('job').payload.outPath).toBe(f.outPath);
  expect(f.queue.get('job').outputAuthority.destinationEvidence).toEqual(evidence);
  expect(fs.readFileSync(f.outPath,'utf8')).toBe('existing output');
  if(distinct) expect(fs.readFileSync(other,'utf8')).toBe('distinct lower-case entry');
});

it('大小寫不同的硬連結也是不同目錄項目，設定更新只保留原路徑',context=>{
  const f=setup({existingOutput:true,outputName:'delivery.MP4'});
  const other=path.join(path.dirname(f.outPath),'delivery.mp4');
  if(fs.existsSync(other)) context.skip('此測試需要大小寫敏感的目錄');
  fs.linkSync(f.outPath,other);
  f.invoke({},'job',{targetH:720});
  expect(f.queue.get('job').payload.outPath).toBe(f.outPath);
  expect(fs.statSync(other).ino).toBe(fs.statSync(f.outPath).ino);
  expect(fs.readFileSync(other,'utf8')).toBe('existing output');
});

it('原大寫副檔名的目的檔入列後被移除，設定更新不重新接受不存在的狀態',()=>{
  const f=setup({existingOutput:true,outputName:'delivery.MP4'});
  const evidence=structuredClone(f.queue.get('job').outputAuthority.destinationEvidence);
  fs.unlinkSync(f.outPath);
  f.invoke({},'job',{targetH:720});
  expect(f.queue.get('job').payload.outPath).toBe(f.outPath);
  expect(f.queue.get('job').outputAuthority.destinationEvidence).toEqual(evidence);
  expect(()=>ExportLease.assertDestinationEvidence(f.queue.get('job').outputAuthority)).toThrow(/輸出檔.*變更/);
});

it('舊快照更改為不存在的新路徑會建立目標證據，同路徑修改仍沿用原證據',()=>{
  const f=setup();delete f.queue.get('job').outputAuthority.destinationEvidence;f.queue.persistJob(f.queue.get('job'));
  f.invoke({},'job',{format:'prores'});
  const target=f.queue.get('job').payload.outPath;
  expect(target).toBe(path.join(path.dirname(f.outPath),'delivery.mov'));
  expect(f.queue.get('job').outputAuthority.destinationEvidence).toEqual({version:1,identity:null});
  fs.writeFileSync(target,'newer content');
  f.invoke({},'job',{format:'prores',targetH:720});
  expect(f.queue.get('job').outputAuthority.destinationEvidence).toEqual({version:1,identity:null});
  expect(()=>ExportLease.assertDestinationEvidence(f.queue.get('job').outputAuthority)).toThrow(/輸出檔.*變更/);
  expect(fs.readFileSync(target,'utf8')).toBe('newer content');
});
