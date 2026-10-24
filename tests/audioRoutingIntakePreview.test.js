// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
let Media, State, History, AudioRouting, closeModal, finishCache, Project, desk;
beforeAll(async () => {
  document.body.innerHTML = readFileSync('index.html','utf8');
  const video = document.getElementById('video');
  for (const [key,value] of Object.entries({ duration: 10, readyState: 1, videoWidth: 1920, videoHeight: 1080 })) Object.defineProperty(video,key,{ configurable: true, value });
  video.pause = vi.fn(); video.play = vi.fn(async () => {}); video.load = vi.fn();
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  window.AudioContext = class {
    constructor(){ this.state='running'; this.destination={}; this.currentTime=0; }
    createGain(){ return {...node(), gain:{ value:1 }}; }
    createAnalyser(){ return {...node(),fftSize:2048,getFloatTimeDomainData:buffer=>buffer.fill(0)}; }
    createMediaElementSource(){ return {...node(),channelCount:2}; }
    createChannelSplitter(){ return node(); } createChannelMerger(){ return node(); }
    resume(){}
  };
  desk={
    isDesktop:true,stat:async()=>({exists:true,size:100}),
    probe:async()=>({duration:10,video:{codec:'vp9',fps:25,width:1920,height:1080},audio:[{channels:2}]}),
    fileURL:async path=>'file:///'+path,
    ingest:vi.fn(()=>new Promise(resolve=>{finishCache=resolve;})),
    waveAudio:async()=>{throw new Error('fixture has no wave cache');},
    saveProject:vi.fn(async()=> 'C:/saved.subtool'),
  };
  Object.defineProperty(window,'subtool',{configurable:true,value:desk});
  ({ Media } = await import('../src/media.js'));({ State } = await import('../src/state.js'));
  ({ History } = await import('../src/history.js'));({ AudioRouting } = await import('../src/audio-routing.js'));
  ({ closeModal } = await import('../src/ui.js'));
  ({Project}=await import('../src/project.js'));
});
beforeEach(()=>{
  Object.defineProperty(window,'subtool',{configurable:true,value:desk});
  State.audioProject=null;State.clips=[];State.cues=[];State.notes=[];desk.saveProject.mockClear();
});
afterEach(()=>{closeModal();Media.reset();delete window.subtool;vi.restoreAllMocks();});

it.each([[0,'cancel'],[1,'cancel'],[1,'reset']])('公開原生影片載入的背景 Stream%s 音訊cache完成時，%s 不收輸出草稿',async(stream,ending)=>{
  await Media.loadDesktopMedia('C:/source.webm');
  const initial=structuredClone(State.audioProject);History.reset();
  AudioRouting.openOutputSettings();await new Promise(resolve=>setTimeout(resolve,0));
  document.querySelector('.audio-output-count-preset[data-count="4"]').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(State.audioProject.buses).toHaveLength(4);expect(History.committedSnapshot().audioProject).toEqual(initial);
  const save=document.querySelector('#modalFoot button.primary');
  finishCache({channels:[{file:'C:/L.m4a',sourceStream:stream,sourceChannel:0},{file:'C:/R.m4a',sourceStream:stream,sourceChannel:1}]});
  await vi.waitFor(()=>expect(Media.tracks.every(track=>!!track.file)).toBe(true));
  expect(State.audioProject.buses).toHaveLength(4);
  const committed=History.committedSnapshot().audioProject;
  expect(committed.buses).toEqual(initial.buses);expect(committed.mode).toBe(initial.mode);
  const source=Object.keys(initial.sourceMaps)[0];
  const expected=stream===0?initial.sourceMaps[source].channels:expect.arrayContaining([
    ...initial.sourceMaps[source].channels,
    expect.objectContaining({sourceStream:1,sourceChannel:0,busIds:[initial.buses[0].id]}),
    expect.objectContaining({sourceStream:1,sourceChannel:1,busIds:[initial.buses[1].id]}),
  ]);
  expect(committed.sourceMaps[source].channels).toEqual(expected);
  if(ending==='reset'){
    History.reset();expect(History.stack[0].snap.audioProject).toEqual(committed);
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
  }else closeModal();
  expect(State.audioProject).toEqual(committed);
  save.click();expect(State.audioProject).toEqual(committed);
  await Project.saveAs();
  const saved=JSON.parse(Buffer.from(desk.saveProject.mock.calls[0][1],'base64').subarray(2).toString('utf16le'));
  expect(saved.audioProject).toEqual(committed);
});

it('公開原生cache完成保留推子owner，committed/cancel/save皆不收未確認音量',async()=>{
  await Media.loadDesktopMedia('C:/source.webm');History.reset();
  const {togglePanel}=await import('../src/ui.js');togglePanel('mixerPanel');
  const {renderMixer}=await import('../src/mixer.js');renderMixer();
  const bus=State.audioProject.buses[0],fader=document.querySelector('.mx-fader');
  fader.value='40';fader.dispatchEvent(new Event('input'));expect(bus.volume).toBe(.4);
  const {routeForChannel}=await import('../src/state.js');
  routeForChannel(Media.tracks[0].audioSourceId,0,0);
  expect(State.audioProject.buses[0]).toBe(bus);
  expect(History.committedSnapshot().audioProject.buses[0].volume).toBe(1);
  finishCache({channels:[{file:'C:/L.m4a',sourceStream:1,sourceChannel:0},{file:'C:/R.m4a',sourceStream:1,sourceChannel:1}]});
  await vi.waitFor(()=>expect(Media.tracks.every(track=>!!track.file)).toBe(true));
  expect(State.audioProject.buses[0]).toBe(bus);
  expect(History.committedSnapshot().audioProject.buses[0].volume).toBe(1);
  History.record('背景來源');expect(History.stack.at(-1).snap.audioProject.buses[0].volume).toBe(1);
  window.dispatchEvent(new Event('blur'));expect(bus.volume).toBe(1);
  expect(document.querySelector('.mx-fader').value).toBe('100');
  expect(Media.tracks[0].gain.gain.value).toBe(1);
  await Project.saveAs();
  const saved=JSON.parse(Buffer.from(desk.saveProject.mock.calls[0][1],'base64').subarray(2).toString('utf16le'));
  expect(saved.audioProject.buses[0].volume).toBe(1);
  expect(saved.audioProject.sourceMaps[Object.keys(saved.audioProject.sourceMaps)[0]].channels).toHaveLength(4);
});

it.each([[4,'output'],[6,'output'],[4,'child'],[6,'child']])('公開背景補足%s聲道，%s 基準與live共用新增bus/stream識別',async(count,page)=>{
  await Media.loadDesktopMedia('C:/source.webm');History.reset();
  if(page==='child'){
    AudioRouting.openForClip(State.clips[0].id);await new Promise(resolve=>setTimeout(resolve,0));
    document.getElementById('audioRouteOutput').click();
  }else AudioRouting.openOutputSettings();
  await new Promise(resolve=>setTimeout(resolve,0));
  finishCache({channels:Array.from({length:count},(_,channel)=>({file:`C:/Ch${channel}.m4a`,sourceStream:1,sourceChannel:channel}))});
  await vi.waitFor(()=>expect(Media.tracks.every(track=>!!track.file)).toBe(true));
  expect(State.audioProject.buses).toHaveLength(count);
  const committed=History.committedSnapshot().audioProject;
  expect(State.audioProject).toEqual(committed);
  History.record('背景來源');
  const steps=History.stack.length;document.querySelector('#modalFoot button.primary').click();
  expect(History.stack).toHaveLength(steps);expect(State.audioProject).toEqual(committed);
});

it.each(['detach','split'].flatMap(operation=>['cancel','commit'].flatMap(ending=>[false,true].map(draft=>({operation,ending,draft})))))(
  '配線視窗開啟時 $operation，$ending／草稿=$draft 保留新外音繼承的自訂來源配線',async({operation,ending,draft})=>{
  const {AudioPipeline}=await import('../src/audio-routing-engine.js');
  const clip={id:'detach-with-editor',name:'A.mov',path:'C:/A.mov',dur:5,in:0,out:5,offset:0,vtrack:0,primary:true,audioSrc:'video',audioSourceId:'editor-source'};
  State.clips=[clip];State.videoTracks=[{visible:true}];
  AudioPipeline.registerSource(clip,Array.from({length:3},(_,sourceChannel)=>({sourceStream:0,sourceChannel})),3);
  const source=operation==='detach'?clip:Media.createExternalAudioSource({name:'B.wav',path:'C:/B.wav',duration:5,in:0,out:5,offset:0,fallbackCount:3});
  State.audioProject.sourceMaps[source.audioSourceId].channels[0].busIds=[State.audioProject.buses[2].id];
  const expected=structuredClone(State.audioProject.sourceMaps[source.audioSourceId]);
  History.reset();
  AudioRouting.openForSource(source.id);await new Promise(resolve=>setTimeout(resolve,0));
  if(draft){
    const select=document.querySelector('.audio-route-table tr[data-stream="0"][data-channel="0"] .audio-route-target');
    select.value=State.audioProject.buses[1].id;select.dispatchEvent(new Event('change'));
  }
  const liveExpected=structuredClone(State.audioProject.sourceMaps[source.audioSourceId]);
  const cache=vi.spyOn(Media,operation==='detach'?'_addDesktopCachedAudio':'addAudioFileDesktop').mockImplementation(async(path,restore)=>Media.createExternalAudioSource({...restore,path,fallbackCount:3}));
  try{
    const asset=operation==='detach'?(await Media.detachClipAudio(clip.id))[0]:await Media.splitExternalAudio(source.id,2.5);
    // app 的 history:record bridge 未載入此 fixture，依相同公開入口記錄背景提交。
    History.record('解除影音連結');
    expect(State.audioProject.sourceMaps[asset.audioSourceId]).toEqual(liveExpected);
    expect(History.committedSnapshot().audioProject.sourceMaps[asset.audioSourceId]).toEqual(expected);
    expect(History.stack.at(-1).snap.audioProject.sourceMaps[asset.audioSourceId]).toEqual(expected);
    if(ending==='cancel')closeModal();
    else document.querySelector('#modalFoot button.primary').click();
    expect(State.audioProject.sourceMaps[asset.audioSourceId]).toEqual(ending==='cancel'?expected:liveExpected);
  }finally{cache.mockRestore();}
});
