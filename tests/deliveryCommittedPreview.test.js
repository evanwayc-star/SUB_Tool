// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let originalBody, originalSubtool, originalElementFromPoint;
beforeAll(()=>{
  originalBody=document.body.innerHTML;
  originalSubtool=Object.getOwnPropertyDescriptor(window,'subtool');
  originalElementFromPoint=Object.getOwnPropertyDescriptor(document,'elementFromPoint');
  Object.defineProperty(window,'subtool',{configurable:true,value:{isDesktop:true,exportVideo:vi.fn(async()=> 'job-1'),
    listDir:vi.fn(async()=>[]),saveProject:vi.fn(async()=> 'C:/test.subtool'),configSave:vi.fn()}});
  const parsed=new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'),'utf8'),'text/html');
  document.body.innerHTML=parsed.body.innerHTML;
});
beforeEach(()=>{
  vi.useFakeTimers();window.subtool.exportVideo.mockClear();
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(()=>
    new Proxy({measureText:()=>({width:1})},{get:(target,key)=>target[key]||(()=>{})}));
});
afterEach(async()=>{
  window.dispatchEvent(new Event('blur'));
  const {closeModal}=await import('../src/ui.js');closeModal();
  if(originalElementFromPoint) Object.defineProperty(document,'elementFromPoint',originalElementFromPoint);
  else delete document.elementFromPoint;
  vi.restoreAllMocks();vi.clearAllTimers();vi.useRealTimers();
});
afterAll(()=>{
  document.body.innerHTML=originalBody;
  if(originalSubtool) Object.defineProperty(window,'subtool',originalSubtool);else delete window.subtool;
});

it('圖片拖曳預覽時從交付視窗送出，只交付已提交的幾何且不中斷手勢', async () => {
  const {State}=await import('../src/state.js'),{History}=await import('../src/history.js');
  const {Media}=await import('../src/media.js'),Renderer=await import('../src/video-renderer.js');
  const SubIO=await import('../src/subio.js');
  Object.assign(State,{tracks:[{name:'字幕',visible:true}],cues:[],notes:[],videoTracks:[{name:'V1',visible:true}],
    clips:[{id:'img',type:'image',name:'picture',path:'C:/picture.png',web:{url:'blob:image'},dur:5,in:0,out:5,
      offset:0,vtrack:0,natW:100,natH:50,posX:.5,posY:.5,scale:1}],externalAudioState:[],duration:5,
    exportIn:null,exportOut:null,fps:25,dropFrame:false,videoWidth:1000,videoHeight:500});
  History.reset();vi.spyOn(Media,'displayTime').mockReturnValue(1.5);
  const wrap=document.getElementById('videoWrap');Object.defineProperty(wrap,'clientWidth',{configurable:true,value:1000});
  Object.defineProperty(wrap,'clientHeight',{configurable:true,value:500});Renderer.renderVideoSub();
  document.elementFromPoint=()=>null;
  const image=document.querySelector('#imageLayer .img-wrap');expect(image).toBeTruthy();
  image.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:100,clientY:100}));
  document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:150,clientY:120}));
  expect(State.clips[0].posX).toBe(.55);expect(History.committedSnapshot().clips[0].posX).toBe(.5);
  await SubIO.showExportVideoDialog();vi.advanceTimersByTime(30);
  const out=document.querySelector('.ev-outdir');out.value='D:/delivery';out.dispatchEvent(new Event('input',{bubbles:true}));
  document.getElementById('evSubmitBtn').click();for(let n=0;n<20;n++)await Promise.resolve();
  expect(window.subtool.exportVideo).toHaveBeenCalledOnce();
  expect(window.subtool.exportVideo.mock.calls[0][0].clips[0].posX).toBe(.5);
  expect(State.clips[0].posX).toBe(.55);
  document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:150,clientY:120}));
  expect(State.clips[0].posX).toBe(.55);
});

it('交付視窗取代尚未儲存的音訊配線時，交付列不能沿用已取消的輸出草稿', async () => {
  const {State,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js');
  const {History}=await import('../src/history.js'),{AudioRouting}=await import('../src/audio-routing.js');
  const SubIO=await import('../src/subio.js');
  Object.assign(State,{cues:[],notes:[],clips:[{id:'master',audioSourceId:'master',audioSrc:'video',primary:true,
    path:'C:/master.mov',name:'master',in:0,out:5,offset:0,dur:5,vtrack:0}],
  videoTracks:[{name:'V1',visible:true}],duration:5,exportIn:null,exportOut:null});
  resetAudioProject();ensureAudioSourceMap('master',Array.from({length:8},(_,sourceChannel)=>({sourceStream:0,sourceChannel})));
  const original=structuredClone(State.audioProject.exportLayout);History.reset();
  AudioRouting.openOutputSettings();vi.runAllTimers();
  document.querySelector('.audio-delivery-preset[data-preset="6-fm"]').click();vi.runAllTimers();
  expect(State.audioProject.exportLayout.streams[0].layout).toBe('5.1');
  await SubIO.showExportVideoDialog();vi.advanceTimersByTime(30);
  expect(State.audioProject.exportLayout).toEqual(original);
  const out=document.querySelector('.ev-outdir');out.value='D:/delivery';out.dispatchEvent(new Event('input',{bubbles:true}));
  window.subtool.exportVideo.mockClear();document.getElementById('evSubmitBtn').click();
  for(let n=0;n<20;n++)await Promise.resolve();
  expect(window.subtool.exportVideo).toHaveBeenCalledOnce();
  expect(window.subtool.exportVideo.mock.calls[0][0].audioPlan.streams).toEqual(original.streams);
});
