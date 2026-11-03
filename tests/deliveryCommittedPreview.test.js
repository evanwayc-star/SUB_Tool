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
    exportSub:vi.fn(async()=>null),listDir:vi.fn(async()=>[]),saveProject:vi.fn(async()=> 'C:/test.subtool'),configSave:vi.fn()}});
  const parsed=new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'),'utf8'),'text/html');
  document.body.innerHTML=parsed.body.innerHTML;
});
beforeEach(()=>{
  vi.useFakeTimers();window.subtool.exportVideo.mockClear();window.subtool.exportSub.mockClear();
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

it.each(['字幕檔案','影片交付'])('%s 在變速仍等待播放器時，以已提交片長收尾暫存字幕',async kind=>{
  const {State}=await import('../src/state.js'),{History}=await import('../src/history.js');
  const {Media}=await import('../src/media.js'),{Seq}=await import('../src/sequence.js');
  const {setClipSpeed}=await import('../src/clip-model.js'),SubIO=await import('../src/subio.js');
  Object.assign(State,{tracks:[{name:'字幕',visible:true}],cues:[
    {id:'pending-cue',track:0,start:2,end:3,text:'尚未指定 Out',timed:true,_tempEnd:true},
  ],notes:[],clips:[],videoTracks:[{name:'V1',visible:true,locked:false}],
    externalAudioState:[],externalAudioEnd:0,duration:3,exportIn:null,exportOut:null,
    audioProject:{buses:[],sourceMaps:{},exportLayout:{streams:[]}},
    fps:25,dropFrame:false,videoWidth:1000,videoHeight:500});
  Media.tracks=[];Media.playing=false;
  const clip=Seq.add({id:'source',name:'source.mov',path:'C:/source.mov',primary:true,
    audioDetached:true,in:0,out:3,dur:3,offset:0,vtrack:0});
  History.reset();vi.spyOn(Media,'displayTime').mockReturnValue(2);
  let present;
  const frame=new Promise(resolve=>{present=resolve;});
  vi.spyOn(Media,'refreshClipPlayback').mockResolvedValue(true).mockReturnValueOnce(frame);
  const editing=setClipSpeed(clip,.5);
  let settled=false;editing.then(()=>{settled=true;});
  try {
    await Promise.resolve();
    expect(settled).toBe(false);expect(clip.speed).toBe(.5);expect(State.duration).toBe(6);
    expect(History.committedSnapshot().clips[0]).not.toHaveProperty('speed');
    if(kind==='字幕檔案') {
      SubIO.showExportDialog();
      for(const checkbox of document.querySelectorAll('[data-fmt]')) checkbox.checked=checkbox.dataset.fmt==='srt';
      document.querySelector('#modalFoot .primary').click();
      expect(window.subtool.exportSub).toHaveBeenCalledOnce();
      const contents=Buffer.from(window.subtool.exportSub.mock.calls[0][1],'base64').subarray(2).toString('utf16le');
      expect(contents).toContain('00:00:02,000 --> 00:00:03,000');
      expect(contents).not.toContain('00:00:04,000');
    } else {
      // 使用者在 live 6 秒範圍設定 5 秒交付 Out；交付尾端可有空隙，
      // 不能靠成品裁到原片尾來掩蓋字幕誤採未提交片長的問題。
      State.exportOut=5;
      await SubIO.showExportVideoDialog();vi.advanceTimersByTime(30);
      const out=document.querySelector('.ev-outdir');out.value='D:/delivery';out.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('evSubmitBtn').click();for(let n=0;n<20;n++) await Promise.resolve();
      expect(window.subtool.exportVideo).toHaveBeenCalledOnce();
      const job=window.subtool.exportVideo.mock.calls[0][0];
      expect(job.duration).toBe(5);expect(job.clips[0]).toMatchObject({speed:1,in:0,out:3});
      expect(job.assText).toMatch(/Dialogue:.*0:00:02\.00,0:00:03\.00/);
      expect(job.assText).not.toMatch(/Dialogue:.*0:00:02\.00,0:00:04\.00/);
    }
    expect(clip.speed).toBe(.5);expect(State.duration).toBe(6);
    expect(State.cues[0]).toMatchObject({start:2,end:3,_tempEnd:true});
    expect(History.stack).toHaveLength(1);expect(settled).toBe(false);
  } finally {present(true);await editing;}
});
