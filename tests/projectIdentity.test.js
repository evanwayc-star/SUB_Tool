// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

let Project, resetProject, renderProjectIdentity, desk;
const data={app:'SUB Tool',version:3,fps:25,media:{},clips:[],tracks:[{name:'字幕'}],
  cues:[{track:1,start:0,end:1,text:'測試'}],notes:[]};
const input=name=>({path:`C:/projects/${name}.subtool`,b64:Buffer.from(JSON.stringify(data)).toString('base64')});

beforeEach(async()=>{
  vi.resetModules();
  document.body.innerHTML=new DOMParser().parseFromString(readFileSync('index.html','utf8'),'text/html').body.innerHTML;
  desk={isDesktop:true,fontsList:vi.fn(async()=>({fonts:[]})),
    saveProject:vi.fn(async()=> 'C:/projects/另存名稱.subtool'),writeProject:vi.fn(async path=>path)};
  window.subtool=desk;
  HTMLElement.prototype.scrollIntoView=vi.fn();
  HTMLMediaElement.prototype.pause=vi.fn();HTMLMediaElement.prototype.load=vi.fn();
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText(){return {width:this.font?.includes('"')?2:1};},
    createLinearGradient:()=>({addColorStop(){}})}, {get:(object,key)=>object[key]||(()=>{}),set:(object,key,value)=>(object[key]=value,true)});
  ({Project,resetProject}=await import('../src/project.js'));
  ({renderProjectIdentity}=await import('../src/ui.js'));
  const {on}=await import('../src/events.js');on('project:identity',renderProjectIdentity);
  renderProjectIdentity(Project.identity());
});
afterEach(()=>{resetProject();vi.clearAllTimers();vi.restoreAllMocks();delete window.subtool;});
const title=name=>name+' — SUB TOOL';

it('開啟與另存成功更新視窗標題；新建恢復未命名，工作區不另加名稱列',async()=>{
  expect(document.title).toBe(title('未命名專案'));
  expect(document.querySelector('.project-titlebar')).toBeNull();
  await Project.loadDesktop(input('電影 第三版'));
  expect(document.title).toBe(title('電影 第三版'));
  await Project.saveAs();
  expect(desk.saveProject.mock.calls[0][0]).toBe('電影 第三版.subtool');
  expect(document.title).toBe(title('另存名稱'));
  await Project.save();
  expect(desk.writeProject.mock.calls[0][0]).toBe('C:/projects/另存名稱.subtool');
  expect(document.title).toBe(title('另存名稱'));
  resetProject();expect(document.title).toBe(title('未命名專案'));
});

it('取消、讀取失敗與晚到儲存結果不改成錯誤專案名稱',async()=>{
  await Project.loadDesktop(input('原專案'));
  desk.saveProject.mockResolvedValueOnce(null);
  await Project.saveAs();expect(document.title).toBe(title('原專案'));
  await Project.open(async()=>null);expect(document.title).toBe(title('原專案'));
  await Project.loadDesktop({path:'C:/broken.subtool',b64:Buffer.from('{broken').toString('base64')});
  expect(document.title).toBe(title('原專案'));
  let finish;desk.saveProject.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const saving=Project.saveAs();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  await Project.loadDesktop(input('新專案'));
  finish('C:/old-save.subtool');await saving;
  expect(document.title).toBe(title('新專案'));
});

it('瀏覽器選檔保留專案檔名，分頁標題按文字顯示',async()=>{
  delete window.subtool;vi.resetModules();
  ({Project,resetProject}=await import('../src/project.js'));
  ({renderProjectIdentity}=await import('../src/ui.js'));
  const {on}=await import('../src/events.js');on('project:identity',renderProjectIdentity);
  const filename='剪輯 <b>定稿</b>.subtool';
  await Project.load(new File([JSON.stringify(data)],filename));
  expect(document.title).toBe(title('剪輯 <b>定稿</b>'));
  expect(Project.identity().path).toBeNull();
  const util=await import('../src/util.js');vi.spyOn(util,'downloadBytes').mockImplementation(()=>{});
  await Project.save();
  expect(util.downloadBytes.mock.calls[0][1]).toBe(filename);
  expect(document.title).toBe(title('剪輯 <b>定稿</b>'));
});
