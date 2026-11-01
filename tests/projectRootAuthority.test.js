import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';

const require=createRequire(import.meta.url);
const {FileAuthority}=require('../electron/file-authority.js');
const {createAtomicProjectWriter,createBoundProjectReader,createProjectWorkspace}=require('../electron/project-file-authority-engine.js');
const {captureOutputDirectory}=require('../electron/export-lease.js');
const ExportLease=require('../electron/export-lease.js');
const roots=[];
const projectBytes=Buffer.from(JSON.stringify({app:'SUB Tool',version:3,tracks:[],cues:[],media:{name:'source'}}));
const payload=projectBytes.toString('base64');
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function fixture({readFile=fs.promises.readFile,writeFile=createAtomicProjectWriter()}={}){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-project-root-test-'));roots.push(root);
  const selected=path.join(root,'chosen');fs.mkdirSync(selected);
  const project=path.join(selected,'edit.subtool');fs.writeFileSync(project,projectBytes);
  const authority=new FileAuthority();
  const workspace=createProjectWorkspace({readFile,writeFile,
    captureProjectRoot:file=>captureOutputDirectory(path.dirname(file)),
    grantProjectFile:(file,projectRoot)=>authority.grantProjectFile(file,projectRoot),
    grantMediaFile:file=>authority.grantTrustedFile(file),canReadMedia:file=>authority.canRead(file)});
  const source=fs.readFileSync(path.resolve('electron/main.js'),'utf8'),ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});
  const registration=ast.body.find(node=>node.type==='ExpressionStatement'&&node.expression.type==='CallExpression'
    &&node.expression.callee.object?.name==='ipcMain'&&node.expression.callee.property?.name==='handle'
    &&node.expression.arguments[0]?.value==='fs:writeProject');
  let handler;
  vm.runInNewContext(source.slice(registration.start,registration.end),{fileAuthority:authority,projectWorkspace:workspace,
    ipcMain:{handle:(_channel,callback)=>{handler=callback;}},console});
  return {root,selected,project,authority,workspace,handler};
}
function replaceRoot(fixture){
  const original=path.join(fixture.root,'original');
  fs.renameSync(fixture.selected,original);fs.mkdirSync(fixture.selected);
  fs.writeFileSync(fixture.project,'外部既有專案，絕不覆寫');
  return original;
}
function saveDialogHandler(workspace,file,{cancelled=false}={}){
  const source=fs.readFileSync(path.resolve('electron/main.js'),'utf8'),ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});
  const registration=ast.body.find(node=>node.type==='ExpressionStatement'&&node.expression.type==='CallExpression'
    &&node.expression.callee.object?.name==='ipcMain'&&node.expression.callee.property?.name==='handle'
    &&node.expression.arguments[0]?.value==='dialog:saveProject');
  let handler;
  vm.runInNewContext(source.slice(registration.start,registration.end),{projectWorkspace:workspace,ExportLease,path,mainWin:{},
    dialog:{showSaveDialog:async()=>({canceled:cancelled,filePath:file})},ipcMain:{handle:(_channel,callback)=>{handler=callback;}}});
  return handler;
}
afterEach(()=>{
  for(const root of roots.splice(0)){
    const actual=fs.realpathSync(root);
    if(path.dirname(actual)!==fs.realpathSync(os.tmpdir())||!path.basename(actual).startsWith('subtool-project-root-test-')) throw new Error('拒絕清理不屬於測試的目錄');
    fs.rmSync(actual,{recursive:true,force:true,maxRetries:5,retryDelay:30});
  }
});

describe('專案根授權與真實 IPC',()=>{
  it('實體專案可開啟並使用原根完成儲存及建立自動備份',async()=>{
    const f=fixture({readFile:createBoundProjectReader()});
    expect(await f.workspace.open(f.project)).not.toBeNull();
    expect(f.authority.canWriteProject(['fake.subtool'])).toBe(false);
    expect(await f.handler({}, {path:f.project,b64:payload})).toBe(f.project);
    const backup=path.join(f.selected,'.subtool_AutoSave','backup.subtool');
    expect(await f.handler({}, {path:backup,b64:payload})).toBe(backup);
    for(const file of [f.project,backup]){
      const bytes=fs.readFileSync(file);expect([...bytes.subarray(0,2)]).toEqual([255,254]);
      expect(JSON.parse(bytes.subarray(2).toString('utf16le')).media.name).toBe('source');
    }
  });

  it('另存新檔的真實對話框取得選定根，完成後保留後續儲存授權',async()=>{
    const f=fixture({readFile:createBoundProjectReader()});
    const destination=path.join(f.selected,'new.subtool');
    const save=saveDialogHandler(f.workspace,destination);
    expect(await save({}, {name:'new.subtool',b64:payload})).toBe(destination);
    expect(f.authority.canWriteProject(destination)).toBe(true);
    expect(await f.handler({}, {path:destination,b64:payload})).toBe(destination);
    const bytes=fs.readFileSync(destination);
    expect(JSON.parse(bytes.subarray(2).toString('utf16le')).media.name).toBe('source');
  });

  it('取消另存對話框不建立檔案或擴張專案授權',async()=>{
    const f=fixture({readFile:createBoundProjectReader()});
    const destination=path.join(f.selected,'cancelled.subtool');
    expect(await saveDialogHandler(f.workspace,destination,{cancelled:true})({}, {name:'cancelled',b64:payload})).toBeNull();
    expect(fs.existsSync(destination)).toBe(false);
    expect(f.authority.canWriteProject(destination)).toBe(false);
  });

  it('使用者可將備份資料夾本身明確選作新專案的根',async()=>{
    const f=fixture({readFile:createBoundProjectReader()});
    const selected=path.join(f.selected,'.subtool_AutoSave');fs.mkdirSync(selected);
    const destination=path.join(selected,'chosen.subtool');
    expect(await saveDialogHandler(f.workspace,destination)({}, {name:'chosen',b64:payload})).toBe(destination);
    expect(await f.handler({}, {path:destination,b64:payload})).toBe(destination);
    expect(f.authority.canWriteProject(destination)).toBe(true);
    const bytes=fs.readFileSync(destination);
    expect(JSON.parse(bytes.subarray(2).toString('utf16le')).media.name).toBe('source');
  });

  it('巢狀專案備份根遭替換時不得退回祖先授權，重新選根才可恢復',async()=>{
    const f=fixture({readFile:createBoundProjectReader()});
    expect(await f.workspace.open(f.project)).not.toBeNull();
    const nested=path.join(f.selected,'.subtool_AutoSave');fs.mkdirSync(nested);
    const child=path.join(nested,'chosen.subtool');
    expect(await saveDialogHandler(f.workspace,child)({}, {name:'chosen',b64:payload})).toBe(child);
    const backup=path.join(nested,'.subtool_AutoSave','backup.subtool');
    expect(await f.handler({}, {path:backup,b64:payload})).toBe(backup);
    const oldRoot=f.authority.captureProjectWriteRoot(backup);
    const retained=path.join(f.selected,'retained-child-root');fs.renameSync(nested,retained);
    fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,'FOREIGN-BACKUP');
    expect(await f.handler({}, {path:backup,b64:payload})).toBeNull();
    expect(fs.readFileSync(backup,'utf8')).toBe('FOREIGN-BACKUP');
    expect(await f.workspace.open(f.project)).not.toBeNull();
    expect(await f.handler({}, {path:backup,b64:payload})).toBeNull();
    expect(fs.readFileSync(backup,'utf8')).toBe('FOREIGN-BACKUP');
    const renewed=path.join(nested,'renewed.subtool');
    expect(await saveDialogHandler(f.workspace,renewed)({}, {name:'renewed',b64:payload})).toBe(renewed);
    expect(()=>ExportLease.captureOutputAuthority(path.join(oldRoot.requestedPath,'.subtool-project-check'),oldRoot)).toThrow();
    expect(await f.handler({}, {path:backup,b64:payload})).toBe(backup);
    const bytes=fs.readFileSync(backup);
    expect([...bytes.subarray(0,2)]).toEqual([255,254]);
    expect(JSON.parse(bytes.subarray(2).toString('utf16le')).media.name).toBe('source');
    expect(fs.existsSync(path.join(retained,'chosen.subtool'))).toBe(true);
  });

  it('長路徑的所選 junction 根可正常讀取與儲存',async()=>{
    const f=fixture({readFile:createBoundProjectReader()});
    const deep=path.join(f.selected,...Array.from({length:5},(_,index)=>`folder-${index}-${'x'.repeat(48)}`));
    fs.mkdirSync(deep,{recursive:true});
    const target=path.join(f.root,'real-target');fs.mkdirSync(target);
    const alias=path.join(deep,'selected-link');fs.symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');
    const project=path.join(alias,'long.subtool');
    expect(project.length).toBeGreaterThan(260);
    fs.writeFileSync(project,projectBytes);
    expect(await f.workspace.open(project)).not.toBeNull();
    expect(await f.handler({}, {path:project,b64:payload})).toBe(project);
    const bytes=fs.readFileSync(path.join(target,'long.subtool'));
    expect(JSON.parse(bytes.subarray(2).toString('utf16le')).media.name).toBe('source');
  });

  it('開啟後根目錄被替換，儲存不得覆寫替代目錄的檔案',async()=>{
    const f=fixture();expect(await f.workspace.open(f.project)).not.toBeNull();
    const original=replaceRoot(f);
    expect(await f.handler({}, {path:f.project,b64:payload})).toBeNull();
    expect(fs.readFileSync(f.project,'utf8')).toBe('外部既有專案，絕不覆寫');
    expect(fs.readFileSync(path.join(original,'edit.subtool'))).toEqual(projectBytes);
  });

  it('開檔讀取已完成但尚未取得回覆時根被替換，不能接受舊內容並授權新根',async()=>{
    const gate=deferred(),started=deferred();
    const f=fixture({readFile:async file=>{const bytes=await fs.promises.readFile(file);started.resolve();await gate.promise;return bytes;}});
    const pending=f.workspace.open(f.project);await started.promise;
    replaceRoot(f);gate.resolve();
    expect(await pending).toBeNull();
    expect(f.authority.canRead(f.project)).toBe(false);
    expect(f.authority.canWriteProject(f.project)).toBe(false);
    expect(fs.readFileSync(f.project,'utf8')).toBe('外部既有專案，絕不覆寫');
  });

  it('真實 handle 讀取後，同一目錄的專案檔被替換不能取得舊檔授權',async()=>{
    const gate=deferred(),started=deferred();
    const reader=createBoundProjectReader({fsModule:{...fs,...fs.promises,async open(...args){
      const handle=await fs.promises.open(...args);
      return {stat:options=>handle.stat(options),close:()=>handle.close(),async readFile(){
        const bytes=await handle.readFile();started.resolve();await gate.promise;return bytes;
      }};
    }}});
    const f=fixture({readFile:reader});const pending=f.workspace.open(f.project);await started.promise;
    const retained=path.join(f.selected,'retained.subtool');fs.renameSync(f.project,retained);
    fs.writeFileSync(f.project,'外部新檔');gate.resolve();
    expect(await pending).toBeNull();
    expect(f.authority.canRead(f.project)).toBe(false);
    expect(fs.readFileSync(f.project,'utf8')).toBe('外部新檔');
    expect(fs.readFileSync(retained)).toEqual(projectBytes);
  });

  it('獨立正式讀取完成後、workspace 提交前根被替換仍拒絕授權',async()=>{
    const gate=deferred(),started=deferred(),reader=createBoundProjectReader();
    const f=fixture({readFile:async (...args)=>{const result=await reader(...args);started.resolve();await gate.promise;return result;}});
    const pending=f.workspace.open(f.project);await started.promise;
    replaceRoot(f);gate.resolve();
    expect(await pending).toBeNull();
    expect(f.authority.canRead(f.project)).toBe(false);
  });

  it('真實讀取較舊專案等待時，較新開檔維持唯一授權',async()=>{
    const gate=deferred(),started=deferred(),reader=createBoundProjectReader();
    let slow;
    const f=fixture({readFile:async (file,options)=>{
      const result=await reader(file,options);
      if(file===slow){started.resolve();await gate.promise;}
      return result;
    }});
    slow=f.project;
    const newer=path.join(f.selected,'newer.subtool');fs.writeFileSync(newer,projectBytes);
    const pending=f.workspace.open(slow);await started.promise;
    expect((await f.workspace.open(newer))?.path).toBe(newer);
    gate.resolve();expect(await pending).toBeNull();
    expect(f.authority.canRead(slow)).toBe(false);
    expect(f.authority.canRead(newer)).toBe(true);
  });

  it('待發布的儲存遇到根目錄替換，保留替代目錄與原始專案內容',async()=>{
    const gate=deferred(),started=deferred();
    const writer=createAtomicProjectWriter({fsModule:{...fs,...fs.promises,async open(...args){
      started.resolve();await gate.promise;return fs.promises.open(...args);
    }}});
    const f=fixture({readFile:createBoundProjectReader(),writeFile:writer});
    expect(await f.workspace.open(f.project)).not.toBeNull();
    const pending=f.handler({}, {path:f.project,b64:payload});await started.promise;
    const original=replaceRoot(f);gate.resolve();
    expect(await pending).toBeNull();
    expect(fs.readFileSync(f.project,'utf8')).toBe('外部既有專案，絕不覆寫');
    expect(fs.readFileSync(path.join(original,'edit.subtool'))).toEqual(projectBytes);
  });
});
