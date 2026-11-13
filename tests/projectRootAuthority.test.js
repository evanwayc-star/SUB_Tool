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
function writerWithCloseUpdate(update,renameSync=fs.renameSync){
  return createAtomicProjectWriter({fsModule:{...fs,...fs.promises,renameSync,
    async open(file,...args){
      const handle=await fs.promises.open(file,...args);
      if(args[0]==='r')return handle;
      return {stat:options=>handle.stat(options),writeFile:bytes=>handle.writeFile(bytes),sync:()=>handle.sync(),
        async close(){const before=await handle.stat({bigint:true});await handle.close();update(file,before);}};
    },
  }});
}
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

  it.each(['save', 'saveAs'])('真實 %s IPC 在目的檔改變後回傳受限衝突代碼並保留外部內容',async kind=>{
    const gate=deferred(),started=deferred();
    const writer=createAtomicProjectWriter({fsModule:{...fs,...fs.promises,async open(...args){
      if(args[1]==='r')return fs.promises.open(...args);
      const handle=await fs.promises.open(...args);started.resolve();await gate.promise;return handle;
    }}});
    const f=fixture({writeFile:writer});
    expect(await f.workspace.open(f.project)).not.toBeNull();
    const saving=kind==='save'
      ?f.handler({}, {path:f.project,b64:payload})
      :saveDialogHandler(f.workspace,f.project)({}, {name:'edit.subtool',b64:payload});
    await started.promise;
    try{fs.writeFileSync(f.project,'外部更新內容');}finally{gate.resolve();}
    expect(await saving).toEqual({code:'PROJECT_DESTINATION_CHANGED'});
    expect(fs.readFileSync(f.project,'utf8')).toBe('外部更新內容');
  });

  it('其他原生儲存錯誤不透過 IPC 曝露路徑或細節',async()=>{
    const secret='C:/private/secret: unexpected native error';
    const f=fixture({writeFile:async()=>{throw new Error(secret);}});
    expect(await f.workspace.open(f.project)).not.toBeNull();
    expect(await f.handler({}, {path:f.project,b64:payload})).toBeNull();
    expect(await saveDialogHandler(f.workspace,f.project)({}, {name:'edit.subtool',b64:payload})).toBeNull();
    expect(fs.readFileSync(f.project)).toEqual(projectBytes);
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
      return {stat:options=>handle.stat(options),read:(...args)=>handle.read(...args),close:()=>handle.close(),async readFile(){
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

  it('真實讀取後同 inode 等長內容變更，即使時間戳不變也不可提交舊內容',async()=>{
    const gate=deferred(),started=deferred();let selected,initial;
    const descriptors=new Set();
    const freeze=stat=>{
      Object.defineProperties(stat,{mtimeNs:{value:initial.mtimeNs},ctimeNs:{value:initial.ctimeNs}});
      return stat;
    };
    const reader=createBoundProjectReader({fsModule:{...fs,...fs.promises,
      async open(file,...args){
        const handle=await fs.promises.open(file,...args);
        if(file!==selected) return handle;
        return {stat:async options=>freeze(await handle.stat(options)),read:(...readArgs)=>handle.read(...readArgs),
          readFile:(...readArgs)=>handle.readFile(...readArgs),close:()=>handle.close()};
      },
      openSync(file,...args){const fd=fs.openSync(file,...args);if(file===selected)descriptors.add(fd);return fd;},
      fstatSync(fd,...args){const stat=fs.fstatSync(fd,...args);return descriptors.has(fd)?freeze(stat):stat;},
      closeSync(fd){descriptors.delete(fd);return fs.closeSync(fd);},
      statSync(file,...args){const stat=fs.statSync(file,...args);return file===selected?freeze(stat):stat;},
    }});
    const f=fixture({readFile:async (...args)=>{const result=await reader(...args);started.resolve();await gate.promise;return result;}});
    selected=f.project;initial=fs.statSync(selected,{bigint:true});
    const pending=f.workspace.open(selected);await started.promise;
    const changed=Buffer.from(projectBytes.toString('utf8').replace('source','target'));
    expect(changed.length).toBe(projectBytes.length);
    try{fs.writeFileSync(selected,changed);}finally{gate.resolve();}
    expect(await pending).toBeNull();
    expect(f.authority.canRead(selected)).toBe(false);
    expect(fs.readFileSync(selected)).toEqual(changed);
  });

  it('正式開啟只在提交前同步核對一次完整內容',async()=>{
    let selected,verifiedBytes=0;
    const owned=new Set();
    const reader=createBoundProjectReader({fsModule:{...fs,...fs.promises,
      openSync(file,...args){const fd=fs.openSync(file,...args);if(file===selected)owned.add(fd);return fd;},
      closeSync(fd){owned.delete(fd);return fs.closeSync(fd);},
      readSync(fd,...args){const count=fs.readSync(fd,...args);if(owned.has(fd))verifiedBytes+=count;return count;},
    }});
    const f=fixture({readFile:reader});selected=f.project;
    const original=Buffer.concat([projectBytes,Buffer.alloc(256*1024,0x20)]);fs.writeFileSync(selected,original);
    const opened=await f.workspace.open(selected);
    expect(Buffer.from(opened.b64,'base64')).toEqual(original);
    expect(verifiedBytes).toBe(original.length);
  });

  it('初次緩衝區雜湊讓出事件迴圈時遭等長改寫，最終核對仍拒絕授權',async()=>{
    let selected,initial;const modified=deferred(),owned=new Set();
    const freeze=stat=>{
      Object.defineProperties(stat,{mtimeNs:{value:initial.mtimeNs},ctimeNs:{value:initial.ctimeNs}});
      return stat;
    };
    const reader=createBoundProjectReader({fsModule:{...fs,...fs.promises,
      async open(file,...args){
        const handle=await fs.promises.open(file,...args);
        if(file!==selected)return handle;
        return {stat:async options=>freeze(await handle.stat(options)),close:()=>handle.close(),
          async readFile(options){
            const data=await handle.readFile(options),changed=Buffer.from(data);
            changed.write('target',changed.indexOf('source'),'utf8');
            setImmediate(()=>{try{fs.writeFileSync(selected,changed);}finally{modified.resolve();}});
            return data;
          }};
      },
      openSync(file,...args){const fd=fs.openSync(file,...args);if(file===selected)owned.add(fd);return fd;},
      closeSync(fd){owned.delete(fd);return fs.closeSync(fd);},
      fstatSync(fd,...args){const stat=fs.fstatSync(fd,...args);return owned.has(fd)?freeze(stat):stat;},
      statSync(file,...args){const stat=fs.statSync(file,...args);return file===selected?freeze(stat):stat;},
    }});
    const f=fixture({readFile:reader});selected=f.project;
    const original=Buffer.concat([projectBytes,Buffer.alloc(2*1024*1024,0x20)]);fs.writeFileSync(selected,original);
    initial=fs.statSync(selected,{bigint:true});
    const result=await f.workspace.open(selected);await modified.promise;
    expect(result).toBeNull();
    expect(f.authority.canRead(selected)).toBe(false);
    expect(fs.readFileSync(selected).subarray(0,projectBytes.length).toString()).toContain('target');
  });

  it('讀取舊專案期間開始新開檔會撤銷舊讀取並釋放 handle',async()=>{
    const gate=deferred(),started=deferred();let slow,oldHandle,readSignal;
    const reader=createBoundProjectReader({fsModule:{...fs,...fs.promises,async open(file,...args){
      const handle=await fs.promises.open(file,...args);
      if(file!==slow) return handle;
      return {stat:options=>handle.stat(options),close:()=>handle.close(),
        async readFile(options){
          oldHandle=handle;readSignal=options.signal;started.resolve();await gate.promise;
          return handle.readFile(options);
        }};
    }}});
    const f=fixture({readFile:reader});slow=f.project;
    const newer=path.join(f.selected,'newer.subtool');fs.writeFileSync(newer,projectBytes);
    const pending=f.workspace.open(slow);
    try{
      await started.promise;
      expect((await f.workspace.open(newer))?.path).toBe(newer);
      expect(readSignal.aborted).toBe(true);
      expect(f.authority.canRead(slow)).toBe(false);
    }finally{gate.resolve();}
    expect(await pending).toBeNull();
    expect(oldHandle.fd).toBe(-1);
    expect(f.authority.canRead(newer)).toBe(true);
  });

  it('最後同步內容核對到授權之間不執行同程序的延後改寫',async()=>{
    const changedDone=deferred();let selected,opened=0,scheduled=false,changed;
    const owned=new Map();
    const reader=createBoundProjectReader({fsModule:{...fs,...fs.promises,
      openSync(file,...args){const fd=fs.openSync(file,...args);if(file===selected)owned.set(fd,++opened);return fd;},
      closeSync(fd){owned.delete(fd);return fs.closeSync(fd);},
      readSync(fd,...args){
        const count=fs.readSync(fd,...args);
        if(owned.get(fd)===1&&!scheduled){scheduled=true;setImmediate(()=>{fs.writeFileSync(selected,changed);changedDone.resolve();});}
        return count;
      },
    }});
    const f=fixture({readFile:reader});selected=f.project;
    const original=Buffer.concat([projectBytes,Buffer.alloc(256*1024,0x20)]);fs.writeFileSync(selected,original);
    changed=Buffer.from(original);changed.write('target',changed.indexOf('source'),'utf8');
    const openedProject=await f.workspace.open(selected);
    expect(openedProject?.path).toBe(selected);
    expect(Buffer.from(openedProject.b64,'base64')).toEqual(original);
    expect(fs.readFileSync(selected)).toEqual(original);
    await changedDone.promise;
    expect(fs.readFileSync(selected)).toEqual(changed);
  });

  it('專案暫存檔同步後遭同 inode 改寫，保留外部內容與原專案',async()=>{
    let stage;
    const writer=createAtomicProjectWriter({createToken:()=> 'owned',fsModule:{...fs,...fs.promises,
      async open(file,...args){
        if(args[0]==='r')return fs.promises.open(file,...args);
        const handle=await fs.promises.open(file,...args);stage=file;
        return {stat:options=>handle.stat(options),writeFile:bytes=>handle.writeFile(bytes),close:()=>handle.close(),
          async sync(){await handle.sync();fs.writeFileSync(file,'external');}};
      },
    }});
    const f=fixture({writeFile:writer});
    await expect(writer(f.project,Buffer.from('intended'))).rejects.toMatchObject({code:'UNSAFE_PROJECT_OUTPUT'});
    expect(fs.readFileSync(f.project)).toEqual(projectBytes);
    expect(fs.readFileSync(stage,'utf8')).toBe('external');
  });

  it('NAS 關檔才更新時間戳時，真實自動備份 IPC 發布完整 UTF-16 內容且不殘留暫存',async()=>{
    let stage,beforeClose,afterClose;
    const writer=writerWithCloseUpdate((file,before)=>{
      stage=file;beforeClose=before;
      fs.utimesSync(file,before.atime,new Date(Number(before.mtimeMs)+2000));
      afterClose=fs.statSync(file,{bigint:true});
    });
    const f=fixture({writeFile:writer});
    expect(await f.workspace.open(f.project)).not.toBeNull();
    const backup=path.join(f.selected,'.subtool_AutoSave','edit_1103-1314.subtool');
    expect(await f.handler({}, {path:backup,b64:payload})).toBe(backup);
    expect(afterClose.dev).toBe(beforeClose.dev);expect(afterClose.ino).toBe(beforeClose.ino);
    expect(afterClose.size).toBe(beforeClose.size);expect(afterClose.mtimeNs).not.toBe(beforeClose.mtimeNs);
    const saved=fs.readFileSync(backup);
    expect([...saved.subarray(0,2)]).toEqual([255,254]);
    expect(JSON.parse(saved.subarray(2).toString('utf16le'))).toEqual(JSON.parse(projectBytes.toString()));
    expect(fs.existsSync(stage)).toBe(false);
    expect(fs.readdirSync(f.selected).sort()).toEqual(['.subtool_AutoSave','edit.subtool']);
  });

  it('NAS 關檔後同 inode 同長度內容被改寫，仍拒絕發布並保留外部 bytes',async()=>{
    const intended=Buffer.from('intended'),external=Buffer.from('external');
    let stage;
    const writer=writerWithCloseUpdate((file,before)=>{
      stage=file;fs.writeFileSync(file,external);
      const after=fs.statSync(file,{bigint:true});
      expect(after.ino).toBe(before.ino);expect(after.size).toBe(before.size);
    });
    const f=fixture({writeFile:writer});
    await expect(writer(f.project,intended)).rejects.toMatchObject({code:'UNSAFE_PROJECT_OUTPUT'});
    expect(fs.readFileSync(f.project)).toEqual(projectBytes);
    expect(fs.readFileSync(stage)).toEqual(external);
  });

  it('NAS 關檔更新時間後 rename 失敗，只清理已驗證的本次暫存並保留原專案',async()=>{
    const failure=new Error('SMB rename denied');let stage;
    const writer=writerWithCloseUpdate((file,before)=>{
      stage=file;fs.utimesSync(file,before.atime,new Date(Number(before.mtimeMs)+2000));
    },()=>{throw failure;});
    const f=fixture({writeFile:writer});
    await expect(writer(f.project,Buffer.from('intended'))).rejects.toBe(failure);
    expect(fs.readFileSync(f.project)).toEqual(projectBytes);
    expect(fs.existsSync(stage)).toBe(false);
    expect(fs.readdirSync(f.selected)).toEqual(['edit.subtool']);
  });

  it('NAS 同步失敗後 finally 關檔更新時間戳，仍清除本次完整專案 tmp',async()=>{
    const failure=Object.assign(new Error('SMB sync failed'),{code:'EIO'});
    let stage,beforeClose,afterClose;
    const writer=createAtomicProjectWriter({fsModule:{...fs,...fs.promises,
      async open(file,...args){
        const handle=await fs.promises.open(file,...args);
        if(args[0]==='r')return handle;
        stage=file;
        return {stat:options=>handle.stat(options),writeFile:bytes=>handle.writeFile(bytes),
          async sync(){await handle.sync();throw failure;},
          async close(){
            beforeClose=await handle.stat({bigint:true});await handle.close();
            fs.utimesSync(file,beforeClose.atime,new Date(Number(beforeClose.mtimeMs)+2000));
            afterClose=fs.lstatSync(file,{bigint:true});
          }};
      },
    }});
    const f=fixture({writeFile:writer});
    await expect(writer(f.project,Buffer.from('intended'))).rejects.toBe(failure);
    expect(afterClose.ino).toBe(beforeClose.ino);expect(afterClose.size).toBe(beforeClose.size);
    expect(afterClose.mtimeNs).not.toBe(beforeClose.mtimeNs);
    expect(fs.readFileSync(f.project)).toEqual(projectBytes);
    expect(fs.existsSync(stage)).toBe(false);
  });

  it.each(['等長改寫','追加','替換'])('NAS 同步失敗且關檔時暫存遭%s，保留外部內容及原始錯誤',async change=>{
    const failure=Object.assign(new Error('SMB sync failed'),{code:'EIO'});
    let stage,external;
    const writer=createAtomicProjectWriter({fsModule:{...fs,...fs.promises,
      async open(file,...args){
        const handle=await fs.promises.open(file,...args);
        if(args[0]==='r')return handle;
        stage=file;
        return {stat:options=>handle.stat(options),writeFile:bytes=>handle.writeFile(bytes),
          async sync(){await handle.sync();throw failure;},
          async close(){
            const before=await handle.stat({bigint:true});await handle.close();
            if(change==='替換')fs.renameSync(file,`${file}.retained`);
            external=change==='追加'?'intended-external':'external';
            fs.writeFileSync(file,external);
            fs.utimesSync(file,before.atime,new Date(Number(before.mtimeMs)+2000));
            if(change==='等長改寫'){
              const after=fs.lstatSync(file,{bigint:true});
              expect([after.ino,after.size]).toEqual([before.ino,before.size]);
            }
          }};
      },
    }});
    const f=fixture({writeFile:writer});
    await expect(writer(f.project,Buffer.from('intended'))).rejects.toBe(failure);
    expect(fs.readFileSync(f.project)).toEqual(projectBytes);
    expect(fs.readFileSync(stage,'utf8')).toBe(external);
  });

  it('專案部分寫入後發生錯誤且暫存遭改寫，不可清理外部內容',async()=>{
    let stage;
    const writer=createAtomicProjectWriter({createToken:()=> 'partial',fsModule:{...fs,...fs.promises,
      async open(file,...args){
        if(args[0]==='r')return fs.promises.open(file,...args);
        const handle=await fs.promises.open(file,...args);stage=file;
        return {stat:options=>handle.stat(options),close:()=>handle.close(),sync:()=>handle.sync(),
          async writeFile(bytes){
            await handle.writeFile(bytes.subarray(0,3));fs.writeFileSync(file,'external');
            throw Object.assign(new Error('partial write failed'),{code:'EIO'});
          }};
      },
    }});
    const f=fixture({writeFile:writer});
    await expect(writer(f.project,Buffer.from('intended'))).rejects.toThrow('partial write failed');
    expect(fs.readFileSync(f.project)).toEqual(projectBytes);
    expect(fs.readFileSync(stage,'utf8')).toBe('external');
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
      if(args[1]==='r')return fs.promises.open(...args);
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
