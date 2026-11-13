import fs from 'node:fs';
import vm from 'node:vm';
import {parse} from 'acorn';
import {expect,it,vi} from 'vitest';

it('preload/main no longer expose an IPC that copies NAS preview assets into a local cache',()=>{
  let api;const invoke=vi.fn();
  vm.runInNewContext(fs.readFileSync('electron/preload.js','utf8'),{require:()=>({
    contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},
    ipcRenderer:{invoke,on(){},send(){}},webUtils:{},
  })});
  expect(api.prepareLocalPreview).toBeUndefined();
  const ast=parse(fs.readFileSync('electron/main.js','utf8'),{ecmaVersion:'latest',sourceType:'script'});
  const endpoints=ast.body.filter(node=>node.expression?.callee?.object?.name==='ipcMain'
    &&node.expression?.callee?.property?.name==='handle').map(node=>node.expression.arguments[0]?.value);
  expect(endpoints).not.toContain('ffmpeg:prepareLocalPreview');
  expect(endpoints).toContain('ffmpeg:ingest');
  expect(invoke).not.toHaveBeenCalled();
});

it('desktop cache IPC only queries and clears the authorized current source, never the legacy central cache', async()=>{
  const source=fs.readFileSync('electron/main.js','utf8');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'}),handlers=new Map();
  const runtime={cacheInfo:vi.fn(async()=>({source:{path:'C:/movie.mov',locations:[]}})),
    clearSource:vi.fn(async()=>({bytes:0,incomplete:false})),clearAll:vi.fn(),cleanOrphans:vi.fn()};
  const guard=vi.fn((_label,file)=>{if(file!=='C:/movie.mov')throw Error('source denied');});
  for(const node of ast.body){
    const call=node.expression;
    if(call?.callee?.object?.name!=='ipcMain'||call.callee.property?.name!=='handle'
      ||!String(call.arguments[0]?.value).startsWith('cache:'))continue;
    vm.runInNewContext(source.slice(node.start,node.end),{ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
      mediaIntakeRuntime:runtime,requireReadablePath:guard});
  }
  expect(handlers.has('cache:cleanOrphans')).toBe(false);
  expect(await handlers.get('cache:info')({},null)).toEqual({source:null});
  expect(runtime.cacheInfo).not.toHaveBeenCalled();
  expect(()=>handlers.get('cache:clearAll')({},null)).toThrow();
  expect(()=>handlers.get('cache:clearAll')({},'C:/unknown.mov')).toThrow('source denied');
  expect(runtime.clearSource).not.toHaveBeenCalled();
  await handlers.get('cache:info')({},'C:/movie.mov');
  expect(runtime.cacheInfo).toHaveBeenCalledExactlyOnceWith('C:/movie.mov',{sourceOnly:true});
  expect(await handlers.get('cache:clearAll')({},'C:/movie.mov')).toEqual({bytes:0,incomplete:false});
  expect(runtime.clearSource).toHaveBeenCalledExactlyOnceWith('C:/movie.mov');
  expect(runtime.clearAll).not.toHaveBeenCalled();expect(runtime.cleanOrphans).not.toHaveBeenCalled();
});
