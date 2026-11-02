'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('acorn');
const { FileAuthority } = require('../../electron/file-authority');
const { createDirectoryOutputRuntime } = require('../../electron/directory-output');
const { createScreenshotOutput } = require('../../electron/screenshot-output');
const { fileCommitCoordinator } = require('../../electron/file-commit-coordinator');

const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-screenshot-race-'));
process.env.SUBTOOL_DIRECTORY_RACE_GATE=root;
const target=path.join(root,'Shot-001.jpg');
const authority=new FileAuthority(); authority.grantScreenshotDirectory(root);
const directoryOutput=createDirectoryOutputRuntime({coordinator:fileCommitCoordinator});
const screenshotOutput=createScreenshotOutput({fileAuthority:authority,tempDir:root,coordinator:fileCommitCoordinator});
const source=fs.readFileSync(path.join(process.cwd(),'electron/main.js'),'utf8');
const tree=parse(source,{ecmaVersion:'latest',sourceType:'script'});
function handler(channel,context){
  const node=tree.body.find(item=>item.expression?.callee?.object?.name==='ipcMain'
    && item.expression.callee.property?.name==='handle' && item.expression.arguments[0]?.value===channel);
  let result;
  vm.runInNewContext(source.slice(node.start,node.end),{ipcMain:{handle:(_name,fn)=>{result=fn;}},...context});
  return result;
}
const exportSub=handler('dialog:exportSub',{dialog:{showSaveDialog:async()=>({canceled:false,filePath:target})},directoryOutput,path});
const reserve=handler('fs:reserveScreenshotPath',{screenshotOutput});
const write=handler('fs:writeScreenshot',{screenshotOutput,console});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  try {
    const initial=process.argv[2]==='reserved-first' ? await reserve({}, {directory:root}) : null;
    const oldExport=exportSub({}, {name:'subtitle.srt',b64:Buffer.from('old subtitle').toString('base64'),ext:'srt'});
    const deadline=Date.now()+10000;
    while(!fs.existsSync(path.join(root,'ready'))){if(Date.now()>deadline)throw new Error('worker 未抵達 gate');await sleep(10);}
    const capture=(async()=>{
      const reservation=initial || await reserve({}, {directory:root});
      if(!reservation?.path)throw new Error('截圖未保留路徑');
      const saved=await write({}, {path:reservation.path,token:reservation.token,b64:Buffer.from('new screenshot').toString('base64')});
      return {saved,reservation};
    })();
    let timer;
    const early=await Promise.race([capture.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);
    clearTimeout(timer);
    fs.writeFileSync(path.join(root,'release'),'go');
    const [{saved,reservation},exported]=await Promise.all([capture,oldExport.catch(error=>({error:error.message}))]);
    process.stdout.write(JSON.stringify({saved:!!saved,exported,early,content:fs.readFileSync(reservation.path,'utf8'),name:reservation.name}));
  } finally {
    fs.writeFileSync(path.join(root,'release'),'go');
    await directoryOutput.close();await screenshotOutput.close();
    const actual=fs.realpathSync(root);
    if(path.dirname(actual)!==fs.realpathSync(os.tmpdir())||!path.basename(actual).startsWith('subtool-screenshot-race-'))throw new Error('拒絕清理測試目錄外路徑');
    fs.rmSync(actual,{recursive:true,force:true});
  }
}
main().catch(error=>{process.stderr.write(error.stack||String(error));process.exitCode=1;});
