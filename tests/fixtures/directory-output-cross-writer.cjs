'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('acorn');
const { FileAuthority } = require('../../electron/file-authority');
const { createAtomicProjectWriter, createBoundProjectReader, createProjectWorkspace } = require('../../electron/project-file-authority-engine');
const { captureOutputDirectory } = require('../../electron/export-lease');
const { createDirectoryOutputRuntime } = require('../../electron/directory-output');
const { fileCommitCoordinator } = require('../../electron/file-commit-coordinator');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-directory-cross-writer-'));
process.env.SUBTOOL_DIRECTORY_RACE_GATE = root;
const selected = path.join(root, 'output'), target = path.join(selected, 'shared.json');
fs.mkdirSync(selected);
const project = name => Buffer.from(JSON.stringify({ app:'SUB Tool',version:3,tracks:[],cues:[],media:{name} }));
const style = Buffer.concat([Buffer.from([255,254]),Buffer.from(JSON.stringify([{name:'shared',style:{fontSize:80}}],null,2),'utf16le')]);
fs.writeFileSync(target, project('original'));
const authority = new FileAuthority();
const workspace = createProjectWorkspace({ readFile:createBoundProjectReader(),writeFile:createAtomicProjectWriter(),
  captureProjectRoot:file=>captureOutputDirectory(path.dirname(file)),
  grantProjectFile:(file,projectRoot)=>authority.grantProjectFile(file,projectRoot),
  grantMediaFile:file=>authority.grantTrustedFile(file),canReadMedia:file=>authority.canRead(file) });
const runtime = createDirectoryOutputRuntime({coordinator:fileCommitCoordinator});
let queuedWrites=0,queuedResolve,mixedResult;
const queued = new Promise(resolve=>{queuedResolve=resolve;});
const directoryOutput = {write(...args){
  const number=++queuedWrites;
  const result=runtime.write(...args);
  if(number===2)queuedResolve();
  return result.then(value=>{if(number===2)mixedResult=value;return value;});
}};
const source = fs.readFileSync(path.join(process.cwd(),'electron/main.js'),'utf8');
const tree = parse(source,{ecmaVersion:'latest',sourceType:'script'});
function handler(channel, context) {
  const node = tree.body.find(item=>item.expression?.callee?.object?.name==='ipcMain'
    && item.expression.callee.property?.name==='handle' && item.expression.arguments[0]?.value===channel);
  let callback;
  vm.runInNewContext(source.slice(node.start,node.end),{ipcMain:{handle:(_name,fn)=>{callback=fn;}},...context});
  return callback;
}
const exportBatch = handler('dialog:exportDirectory',{dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[selected]})},
  fileAuthority:authority,directoryOutput,console});
const save = handler('fs:writeProject',{fileAuthority:authority,projectWorkspace:workspace,console});
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

async function main() {
  let output;
  try {
    if (!await workspace.open(target)) throw new Error('無法開啟測試專案');
    const isMixed = ['mixed','mixed-conflict'].includes(process.argv[2]);
    const isQueued = process.argv[2] === 'queued' || isMixed;
    // The first worker holds this same target; the second request must really
    // queue even when the runtime executes unrelated destinations concurrently.
    const first = exportBatch({},[{name:'shared.json',b64:style.toString('base64')}]);
    const firstOutcome = first.then(value=>({value}),error=>({error:error.message}));
    const deadline = Date.now()+15000;
    while (!fs.existsSync(path.join(root,'ready'))) {
      if (Date.now()>deadline) throw new Error('匯出工作未抵達預期 gate');
      await sleep(10);
    }
    let outcome=firstOutcome;
    if(isQueued){
      let entries=[{name:'shared.json',b64:style.toString('base64')}];
      if(isMixed){
        const outside=path.join(root,'outside');fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside,'forbidden.json'),'outside unchanged');
        fs.writeFileSync(path.join(root,'escape.json'),'escape unchanged');
        fs.symlinkSync(outside,path.join(selected,'link'),process.platform==='win32'?'junction':'dir');
        entries=[{name:'../escape.json',b64:style.toString('base64')},
          {name:'link/forbidden.json',b64:style.toString('base64')},...entries];
      }
      const exporting=exportBatch({},entries);
      outcome=exporting.then(value=>({value}),error=>({error:error.message}));
      await queued;
    }
    if(process.argv[2] === 'mixed'){
      fs.writeFileSync(path.join(root,'release'),'go');
      const [exportResult]=await Promise.all([outcome,firstOutcome]);
      output={mixedResult,exportResult,finalIsStyle:fs.readFileSync(target).equals(style),
        outside:fs.readFileSync(path.join(root,'outside','forbidden.json'),'utf8'),
        escape:fs.readFileSync(path.join(root,'escape.json'),'utf8')};
      process.stdout.write(JSON.stringify(output));
      return;
    }
    const saving = save({}, {path:target,b64:project('new project').toString('base64')});
    // A shared coordinator may make the later save wait for the first commit;
    // release either when it commits or after it has had time to queue.
    let timer;
    const waiting = new Promise(resolve=>{timer=setTimeout(()=>resolve(false),2000);});
    const early = await Promise.race([saving.then(()=>true),waiting]);
    clearTimeout(timer);
    fs.writeFileSync(path.join(root,'release'),'go');
    const [saved,exportResult] = await Promise.all([saving,outcome,firstOutcome]);
    const bytes = fs.readFileSync(target);
    let finalName = null;
    if (bytes[0]===255 && bytes[1]===254) {
      try { finalName=JSON.parse(bytes.subarray(2).toString('utf16le')).media?.name; } catch (_) {}
    }
    output = {saved:saved===target ? 'saved' : saved?.code,finalName,
      finalIsStyle:bytes.equals(style),early,exportResult,
      ...(isMixed?{mixedResult,outside:fs.readFileSync(path.join(root,'outside','forbidden.json'),'utf8'),
        escape:fs.readFileSync(path.join(root,'escape.json'),'utf8')}: {})};
  } finally {
    fs.writeFileSync(path.join(root,'release'),'go');
    await runtime.close();
    const actual=fs.realpathSync(root);
    if(path.dirname(actual)!==fs.realpathSync(os.tmpdir())||!path.basename(actual).startsWith('subtool-directory-cross-writer-'))
      throw new Error('拒絕清理測試目錄外路徑');
    fs.rmSync(actual,{recursive:true,force:true});
  }
  process.stdout.write(JSON.stringify(output));
}
main().catch(error=>{process.stderr.write(error.stack||String(error));process.exitCode=1;});
