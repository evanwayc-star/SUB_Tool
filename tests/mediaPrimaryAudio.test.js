// @vitest-environment jsdom
import {vi,beforeAll,beforeEach,afterEach,it,expect,describe} from 'vitest';
const dom=vi.hoisted(()=>{
 const video={style:{},src:'',readyState:1,duration:12,videoWidth:1920,videoHeight:1080,playbackRate:1,currentTime:0,muted:false,hasAttribute:()=>false,pause:vi.fn(),dispatchEvent:vi.fn()};
 const elements=new Map();return {video,$(id){if(!elements.has(id))elements.set(id,{style:{},textContent:'',innerHTML:'',value:'',addEventListener:vi.fn(),removeEventListener:vi.fn(),classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:640,height:360})});return elements.get(id);}};
});
vi.mock('../src/dom.js',()=>dom);
vi.mock('../src/ui.js',()=>({setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/mixer.js',()=>({renderAudioTracks:vi.fn(),clearMeterStrips:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));
vi.mock('../src/notes.js',()=>({renderNotes:vi.fn(),updateNoteActive:vi.fn()}));
vi.mock('../src/subtitles.js',()=>({selectCueSingle:vi.fn(),commitCueTimeEdit:vi.fn()}));
vi.mock('../src/subtitle-model.js',()=>({addCue:vi.fn(),cueTrackLocked:vi.fn(),snapAllCuesToFrames:vi.fn()}));
let Media,Wave,State,setFps,resetAudioProject,ensureAudioSourceMap,Project,resetProject,Seq,AudioEngine,pickMediaFiles,importDesktopMediaFiles,importBrowserMediaFiles,openMedia;
const audioElements=[];
beforeAll(async()=>{
 Object.defineProperty(window,'subtool',{configurable:true,value:{isDesktop:true,stat:vi.fn(async()=>({exists:true,size:1024})),probe:vi.fn(async()=>({duration:12,video:{codec:'vp9',fps:30,width:1920,height:1080},audio:[]})),fileURL:vi.fn(async path=>'file:///'+path)}});
 window.AudioContext=class {constructor(){this.state='running';this.destination={};this.currentTime=0;}createGain(){return {connect:vi.fn(),disconnect:vi.fn(),gain:{value:1}};}createAnalyser(){return {connect:vi.fn(),fftSize:0};}createMediaElementSource(){return {channelCount:2,connect:vi.fn(),disconnect:vi.fn()};}createChannelSplitter(){return {connect:vi.fn(),disconnect:vi.fn()};}createChannelMerger(){return {connect:vi.fn(),disconnect:vi.fn()};}resume(){}};
 globalThis.Audio=class extends EventTarget {constructor(){super();this.src='';this.duration=12;this.currentTime=0;this.playbackRate=1;this.play=vi.fn(async()=>{});this.pause=vi.fn();audioElements.push(this);}removeAttribute(){}load(){}};
 ({Media,Wave}=await import('../src/media.js'));
 ({State,setFps,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js'));
 ({Project,resetProject,openMedia}=await import('../src/project.js'));
 ({Seq}=await import('../src/sequence.js'));
 ({AudioEngine}=await import('../src/audio-engine.js'));
 ({pickMediaFiles,importDesktopMediaFiles,importBrowserMediaFiles}=await import('../src/media-loader.js'));
 vi.spyOn(Project,'_checkMissingFonts').mockResolvedValue([]);
});
beforeEach(()=>{Media.reset();resetAudioProject();State.cues=[];State.clips=[];State.notes=[];dom.video.src='';dom.video.currentTime=0;audioElements.length=0;});
afterEach(()=>{Media.reset();resetProject();});
it('真正媒體 loader 復原期間的字幕編輯，完成後可 Undo 回已載入序列及乾淨基準',async()=>{
 const {History}=await import('../src/history.js');
 const {isProjectDirty}=await import('../src/project.js');
 let finishProbe,notify;const started=new Promise(resolve=>{notify=resolve;});
 const gate=new Promise(resolve=>{finishProbe=resolve;});
 window.subtool.probe.mockImplementationOnce(()=>{notify();return gate;});
 const data={app:'SUB Tool',version:3,media:{name:'source.webm',path:'C:/source.webm',size:1024},fps:24,duration:12,
  tracks:[{name:'S1',visible:true}],cues:[{start:1,end:2,text:'載入的字幕',track:1}],notes:[],
  clips:[{name:'source.webm',path:'C:/source.webm',dur:12,in:0,out:12,offset:0,vtrack:0,primary:true}]};
 const b64=Buffer.concat([Buffer.from([255,254]),Buffer.from(JSON.stringify(data),'utf16le')]).toString('base64');
 const loading=Project.loadDesktop({path:'C:/initial.subtool',b64});
 await started;
 State.cues[0].text='等待 probe 時已確認的修改';History.record('等待期間編輯');
 finishProbe({duration:12,video:{codec:'vp9',fps:30,width:1920,height:1080},audio:[]});
 await loading;
 expect(State.cues[0].text).toBe('等待 probe 時已確認的修改');expect(isProjectDirty()).toBe(true);
 const clipId=State.clips[0].id;
 expect(History.stack[0].snap.clipGeo.map(c=>c.id)).toEqual([clipId]);
 History.undo();expect(State.cues[0].text).toBe('載入的字幕');expect(State.clips[0].id).toBe(clipId);
 expect(isProjectDirty()).toBe(false);
 History.redo();expect(State.cues[0].text).toBe('等待 probe 時已確認的修改');expect(isProjectDirty()).toBe(true);
});
it.each([{split:false,remove:false},{split:true,remove:false},{split:true,remove:'cut'},{split:true,remove:'primary'}])('復原期間公開存檔只寫入各 placement 一次：%j',async({split,remove})=>{
 let release,notify;const started=new Promise(resolve=>{notify=resolve;}),pending=new Promise(resolve=>{release=resolve;});
 const info={duration:12,video:{codec:'vp9',fps:30,width:1920,height:1080},audio:[]};
 const previousProbe=window.subtool.probe.getMockImplementation(),previousWrite=window.subtool.writeProject;
 window.subtool.probe.mockImplementation(async path=>{if(path==='C:/second.webm'){notify();await pending;}return info;});
 window.subtool.writeProject=vi.fn(async()=> 'C:/initial.subtool');
 const clips=[{name:'first.webm',path:'C:/first.webm',audioSourceId:'first-source',dur:12,in:0,out:split?6:12,offset:0,vtrack:0,primary:true},
  ...(split?[{name:'first.webm',path:'C:/first.webm',audioSourceId:'first-source',dur:12,in:6,out:12,offset:6,vtrack:0,primary:false}]:[]),
  {name:'second.webm',path:'C:/second.webm',audioSourceId:'second-source',dur:12,in:0,out:12,offset:12,vtrack:0,primary:false}];
 const data={app:'SUB Tool',version:3,media:{name:'first.webm',path:'C:/first.webm',size:1024},fps:24,duration:24,tracks:[],cues:[],notes:[],clips};
 const b64=Buffer.concat([Buffer.from([255,254]),Buffer.from(JSON.stringify(data),'utf16le')]).toString('base64');
 const runtime=vi.spyOn(Media,'ensureClipRuntime').mockResolvedValue(),proxy=vi.spyOn(Media,'ensurePrimaryPreviewProxy').mockResolvedValue();
 const loading=Project.loadDesktop({path:'C:/initial.subtool',b64});
 const saved=()=>JSON.parse(Buffer.from(window.subtool.writeProject.mock.calls.at(-1)[1],'base64').subarray(2).toString('utf16le'));
 const placements=list=>list.map(({path,in:start,out,offset})=>({path,in:start,out,offset}));
 try{
  await started;expect(State.clips).toHaveLength(split?2:1);
  await Project.save();expect(placements(saved().clips)).toEqual(placements(clips));
  if(remove){
    // 與刪除命令相同，Media 完成資源移除後，由 History 記錄已提交的刪除。
    const {History}=await import('../src/history.js');
    expect(Media.removeClip(State.clips.find(c=>remove==='primary'?c.primary:!c.primary).id)).toBe(true);History.record('刪除已復原片段');
  }
  release();await loading;
  const expected=remove==='primary'?clips.filter(c=>!c.primary):remove==='cut'?clips.filter(c=>c.in!==6):clips;
  await Project.save();expect(placements(saved().clips)).toEqual(placements(expected));
  if(remove){
    const {History}=await import('../src/history.js');History.undo();
    await Project.save();expect(placements(saved().clips)).toEqual(placements(clips));
  }
 }finally{
  release();await loading;runtime.mockRestore();proxy.mockRestore();window.subtool.probe.mockImplementation(previousProbe);
  if(previousWrite)window.subtool.writeProject=previousWrite;else delete window.subtool.writeProject;
 }
});
it.each([1,2])('首次公有匯入 %s 支影片保留既有外部音訊、播放資源、路由與波形',async count=>{
 const asset=Media.createExternalAudioSource({name:'voice',path:'C:/voice.wav',audioSourceId:'voice-source',duration:20,in:2,out:12,offset:8,fallbackCount:2});
 const before=structuredClone(State.externalAudioState),routing=structuredClone(State.audioProject.sourceMaps['voice-source']);
 const element=new Audio();element.src='blob:keep-audio';
 const gain=Media.ensureCtx().createGain();
 const track={kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,el:element,gain};
 Media.tracks.push(track);Media.objectURLs.push(element.src);
 const peaks=new Float32Array([-.25,.25]);
 const wave=Wave.registerSourceWaveforms(asset,{mixPeaks:peaks});
 const controller=new AbortController();wave.vocals.controller=controller;
 const beforeRevoke=URL.revokeObjectURL;URL.revokeObjectURL=vi.fn();
 const runtime=vi.spyOn(Media,'ensureClipRuntime').mockResolvedValue();
 const proxy=vi.spyOn(Media,'ensurePrimaryPreviewProxy').mockResolvedValue();
 try{
  await importDesktopMediaFiles(Array.from({length:count},(_,i)=>'C:/first-'+i+'.webm'));
  expect(State.clips.filter(c=>c.type!=='image')).toHaveLength(count);
  expect(Media.externalAudioSources).toContain(asset);expect(Media.tracks).toContain(track);
  expect(State.externalAudioState).toEqual(before);expect(element.src).toBe('blob:keep-audio');
  expect(gain.disconnect).not.toHaveBeenCalled();expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(element.src);
  expect(Wave.getSourceWaveform(asset).peaks).toBe(peaks);expect(controller.signal.aborted).toBe(false);
  Wave.initLive();expect(Wave.getSourceWaveform(asset).peaks).toBe(peaks);expect(controller.signal.aborted).toBe(false);
  expect(State.audioProject.sourceMaps['voice-source']).toEqual(routing);expect(State.duration).toBeGreaterThanOrEqual(18);
  // 真正的新工作區 reset 仍釋放所有資源，不能把保留政策擴張到取代操作。
  Media.reset();expect(Media.externalAudioSources).toEqual([]);expect(element.src).toBe('');
  expect(controller.signal.aborted).toBe(true);expect(Wave.sourceWaveforms.size).toBe(0);
 }finally{runtime.mockRestore();proxy.mockRestore();URL.revokeObjectURL=beforeRevoke;}
});
it('public native intake starts at source zero and appended HTML clips retain their own origins',async()=>{
 const runtime=vi.spyOn(Media,'ensureClipRuntime').mockResolvedValue();
 const proxy=vi.spyOn(Media,'ensurePrimaryPreviewProxy').mockResolvedValue();
 const attribute=dom.video.hasAttribute;
 try{
  dom.video.hasAttribute=name=>name==='src'&&!!dom.video.src;
  dom.video.duration=3.5;
  window.subtool.probe.mockResolvedValueOnce({duration:3,video:{codec:'vp9',fps:30,width:64,height:48,timestampOffset:-.5},audio:[]});
  await Media.loadDesktopMedia('C:/first.webm');
  expect(dom.video.currentTime).toBe(.5);expect(Media.vTime()).toBe(0);
  expect(State.clips[0]).toMatchObject({dur:3,in:0,out:3});expect(State.duration).toBe(3);
  window.subtool.probe.mockResolvedValueOnce({duration:3,video:{codec:'vp9',fps:30,width:64,height:48,timestampOffset:-.25},audio:[]});
  const second=await Media.addClipDesktop('C:/second.webm',{offset:3,vtrack:0,in:0,out:3});
  dom.video.duration=3.25;
  await expect(Media.requestPresentation(5.8)).resolves.toMatchObject({status:'presented',presentedTime:5.8,source:'html5'});
  expect(dom.video.currentTime).toBeCloseTo(3.05,10);expect(Media.vTime()).toBeCloseTo(2.8,10);
  expect(second.dur).toBe(3);expect(State.duration).toBe(6);
 }finally{runtime.mockRestore();proxy.mockRestore();dom.video.duration=12;dom.video.hasAttribute=attribute;}
});
it('重開24fps專案保留專案格網，母素材仍記錄30fps',async()=>{
 const data={app:'SUB Tool',version:3,media:{name:'source.webm',path:'C:/source.webm',size:1024},fps:24,dropFrame:false,duration:12,tracks:[{name:'sub',visible:true}],cues:[],clips:[{id:'s',name:'source.webm',path:'C:/source.webm',primary:true,dur:12,in:0,out:12,offset:0}],notes:[]};
 const b64=Buffer.concat([Buffer.from([255,254]),Buffer.from(JSON.stringify(data),'utf16le')]).toString('base64');
 await Project.loadDesktop({path:'C:/project.subtool',b64});
 expect(State.fps).toBe(24);
 expect(State.clips[0].fps).toBe(30);
});
it('桌面來源probe等待期間明確選取同值DF格網，舊來源FPS不再覆寫',async()=>{
 setFps('29.97df');
 let resolveProbe,notifyStarted;
 const started=new Promise(resolve=>{notifyStarted=resolve;});
 const pending=new Promise(resolve=>{resolveProbe=resolve;});
 window.subtool.probe.mockImplementationOnce(()=>{notifyStarted();return pending;});
 const load=Media.loadDesktopMedia('C:/source.webm');
 await started;setFps('29.97df');
 resolveProbe({duration:12,video:{codec:'vp9',fps:30,width:1920,height:1080},audio:[]});
 await load;
 expect(State.fps).toBe(29.97);expect(State.dropFrame).toBe(true);
 expect(State.clips[0].fps).toBe(30);
});
it('瀏覽器取消主媒體重新連結會完成picker，讓後續新專案取得serialized load lane',async()=>{
 const data={app:'SUB Tool',version:3,media:{name:'missing.webm'},fps:24,duration:12,tracks:[],cues:[],notes:[]};
 const bytes=Buffer.concat([Buffer.from([255,254]),Buffer.from(JSON.stringify(data),'utf16le')]);
 await Project.load(new File([bytes],'browser.subtool'));
 const relink=Project.pendingMediaRelink();expect(relink).not.toBeNull();
 const input=document.createElement('input');input.type='file';input.multiple=true;input.click=vi.fn();
 const continuation=Project.continueLoad(relink.generation,()=>pickMediaFiles(input));
 await vi.waitFor(()=>expect(input.click).toHaveBeenCalledTimes(1));
 const next=vi.fn();const newProject=Project.startNewProject(next);
 expect(next).not.toHaveBeenCalled();
 input.dispatchEvent(new Event('cancel'));
 expect(await continuation).toEqual([]);await newProject;expect(next).toHaveBeenCalledTimes(1);
});
it('原生主影片疊合的各聲道沿用母素材路由，遵守bus mute/solo/volume及channel disabled',()=>{
 Media.ensureCtx();
 Seq.add({id:'pri',name:'pri',primary:true,web:{url:'blob:pri'},dur:12,in:0,out:12,offset:0,audioSrc:'video',audioSourceId:'pri-source'});
 const overlay=Seq.add({id:'over',name:'over',primary:false,web:{url:'blob:over'},dur:12,in:0,out:12,offset:0,audioSrc:'clip:over',audioSourceId:'over-source'});
 ensureAudioSourceMap('pri-source',[{sourceStream:0,sourceChannel:0},{sourceStream:0,sourceChannel:1}]);
 const native={kind:'native',source:'video',audioSourceId:'pri-source',sourceStream:0,sourceChannel:0,gain:AudioEngine.createGain(),volume:1,muted:false,solo:true};
 Media.tracks.push(native);
 for(const bus of State.audioProject.buses)bus.muted=true;
 Media._applyClipAudio(overlay,2);
 const alt=Media.tracks.find(track=>track._altPrimary);
 expect(alt).toBeDefined();expect(alt.audioSourceId).toBe('pri-source');
 expect(Media.projectAudioInterpretation().trackState(alt)).toEqual({audible:false,gain:0});
 expect(alt.gain.gain.value).toBe(0);
 expect(native._srcHidden).toBe(true);expect(native.gain.gain.value).toBe(0);
 expect(Media.tracks.filter(track=>track._altPrimary)).toHaveLength(2);
 Media._applyClipAudio(overlay,3);expect(Media.tracks.filter(track=>track._altPrimary)).toHaveLength(2);
 State.audioProject.buses[0].muted=false;State.audioProject.buses[0].volume=.4;Media.applyGains();
 expect(alt.gain.gain.value).toBe(.4);
 expect(alt.solo).toBe(true);expect(native.gain.gain.value).toBe(0);
 State.audioProject.sourceMaps['pri-source'].channels[0].gain=.5;Media.applyGains();expect(alt.gain.gain.value).toBe(.2);
 State.audioProject.buses[1].solo=true;Media.applyGains();expect(alt.gain.gain.value).toBe(0);
 State.audioProject.buses[0].solo=true;Media.applyGains();expect(alt.gain.gain.value).toBe(.2);
 State.audioProject.sourceMaps['pri-source'].channels[0].enabled=false;Media.applyGains();expect(alt.gain.gain.value).toBe(0);
 State.audioProject.sourceMaps['pri-source'].channels[0].enabled=true;overlay.offset=6;
 Media._applyClipAudio(State.clips[0],3);
 expect(alt._srcHidden).toBe(true);expect(native._srcHidden).toBe(false);expect(native.gain.gain.value).toBe(.2);
});
it('reset後舊canplay不再播已釋放來源，新群組仍可校正播放',()=>{
 Media.ensureCtx();
 Seq.add({id:'pri',primary:true,web:{url:'blob:old'},dur:12,in:0,out:12,offset:0,audioSrc:'video'});
 const old=Media._ensureAltPrimaryEl();
 Media.reset();
 Seq.add({id:'pri2',primary:true,web:{url:'blob:new'},dur:12,in:0,out:12,offset:0,audioSrc:'video'});
 const current=Media._ensureAltPrimaryEl();current._srcHidden=false;
 Media.playing=true;Media.activeClipId='pri2';dom.video.currentTime=2;
 old.el.dispatchEvent(new Event('canplay'));
 expect(old.el.play).not.toHaveBeenCalled();
 current.el.dispatchEvent(new Event('canplay'));expect(current.el.play).toHaveBeenCalledTimes(1);
});
it('主影片Audio node建構失敗會立即釋放已建立播放器，之後可重新建立',()=>{
 Media.ensureCtx();
 Seq.add({id:'pri',primary:true,web:{url:'blob:pri'},dur:12,in:0,out:12,offset:0,audioSrc:'video'});
 const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const failedNode=vi.spyOn(AudioEngine,'createMediaElementSource').mockImplementationOnce(()=>{throw new Error('test node failure');});
 expect(Media._ensureAltPrimaryEl()).toBeNull();
 expect(audioElements[0].pause).toHaveBeenCalled();expect(audioElements[0].src).toBe('');
 failedNode.mockRestore();warning.mockRestore();
 expect(Media._ensureAltPrimaryEl()).not.toBeNull();
 expect(Media.tracks.filter(track=>track._altPrimary)).toHaveLength(2);
});

it.each([0,5])('a full ten-second waveform preserves a two-second external placement at %s',async offset=>{
 Media.externalAudioSources=[{id:'trimmed',audioSourceId:'trimmed-source',audioSrc:'ext-trim',duration:10,in:4,out:6,offset}];
 const asset=Media.externalAudioSources[0];Media.recomputeTimelineDuration();
 expect(State.duration).toBe(offset+2);
 const buffer={duration:10,sampleRate:100,length:1000,numberOfChannels:1,getChannelData:()=>new Float32Array(1000).fill(0.25)};
 const decode=vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValueOnce(buffer);
 try{
  expect(await Wave.fromFile(new File([new Uint8Array(4)],'source.wav'),asset)).toBe(true);
  expect(State.duration).toBe(offset+2);
  const peaks=Wave.getSourceWaveform(asset).peaks;
  expect(peaks.length).toBe(10*Wave.resolution*2);expect(Math.max(...peaks)).toBe(0.25);
 }finally{decode.mockRestore();}
});

it('public original-file waveform commits source-zero PCM rather than the earlier audio epoch',async()=>{
 const asset={id:'epoch-wave',audioSourceId:'epoch-wave-source',audioSrc:'ext-epoch',duration:1,in:0,out:1,offset:0};
 Media.externalAudioSources=[asset];
 const pcm=data=>({duration:data.length/1000,sampleRate:1000,length:data.length,numberOfChannels:1,getChannelData:()=>data});
 const original=pcm(Float32Array.from([...Array(500).fill(.2),...Array(1000).fill(.8)]));
 const decode=vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValueOnce(original);
 const metadata=vi.spyOn(AudioEngine,'_sourceMetadata').mockResolvedValueOnce({
  presentationTimestampOffset:-5.5,audioPresentationTimestampOffset:-5,decoderAudioPresentationTimestampOffsets:[-5],duration:1});
 const create=vi.spyOn(AudioEngine,'createBuffer').mockImplementation((_channels,length)=>pcm(new Float32Array(length)));
 try{
  expect(await Wave.fromFile(new File([new Uint8Array(4)],'original.mov'),asset)).toBe(true);
  const peaks=Wave.getSourceWaveform(asset).peaks;
  expect(peaks.length).toBe(200);expect(peaks[1]).toBeCloseTo(.8,6);expect(Math.min(...peaks.filter((_,index)=>index%2))).toBeCloseTo(.8,6);
  expect(State.duration).toBe(1);
 }finally{decode.mockRestore();metadata.mockRestore();create.mockRestore();}
});

it('composition snapshot is immutable, retained only for its physical frame, and cleared on reset',()=>{
 const ids=['image'];Media.setWebCodecsComposited(true,{time:1,imageIds:ids,imagesComposited:true});
 const snapshot=Media.previewComposition();ids.push('new-image');
 expect(Object.isFrozen(snapshot)).toBe(true);expect(Object.isFrozen(snapshot.imageIds)).toBe(true);
 expect(snapshot.imageIds).toEqual(['image']);
 Media.setWebCodecsComposited(true);expect(Media.previewComposition()).toBe(snapshot);
 Media.reset();expect(Media.previewComposition()).toBeNull();
});

const pendingImport=()=>{
 let resolve;
 const promise=new Promise(done=>{resolve=done;});
 return {promise,resolve};
};

async function incomingModal(){
 const {openModal}=await import('../src/ui.js');
 let modal;
 openModal.mockImplementationOnce((title,html,buttons,options)=>{
  let current=true;
  const session={isCurrent:()=>current,close:vi.fn(()=>{current=false;})};
  modal={buttons,options,session};return session;
 });
 return {wait:async()=>{await vi.waitFor(()=>expect(modal).toBeDefined());return modal;}};
}

it('單支影片取代完成後才匯入同批音檔與圖片，保留所有本次選取的素材',async()=>{
 Seq.add({id:'old-primary',primary:true,path:'C:/old.webm',dur:12,in:0,out:12,offset:0});
 const modal=await incomingModal();
 const add=vi.spyOn(Media,'addAudioFileDesktop').mockImplementation(async path=>
  Media.createExternalAudioSource({name:path,path,duration:12,in:0,out:12}));
 const image=vi.spyOn(Media,'addImageDesktop').mockImplementation(async path=>
  Seq.add({type:'image',name:path,path,dur:36000,in:0,out:10,offset:0}));
 try{
  const importing=importDesktopMediaFiles(['C:/new.webm','C:/voice.wav','C:/image.png']);
  const dialog=await modal.wait();
  expect(add).not.toHaveBeenCalled();expect(image).not.toHaveBeenCalled();
  await dialog.buttons.find(button=>button.label==='取代目前影片').act();
  await importing;
  expect(State.clips.filter(clip=>clip.type!=='image').map(clip=>clip.path)).toEqual(['C:/new.webm']);
  expect(Media.externalAudioSources.map(asset=>asset.path)).toEqual(['C:/voice.wav']);
  expect(State.clips.filter(clip=>clip.type==='image').map(clip=>clip.path)).toEqual(['C:/image.png']);
 }finally{add.mockRestore();image.mockRestore();}
});

it.each(['desktop','browser'])('%s 單影片選加入序列後仍等待影片完成，再准入同批其他素材',async mode=>{
 Seq.add({id:'old-primary',primary:true,dur:12,in:0,out:12,offset:0});
 const modal=await incomingModal(),pending=pendingImport(),order=[];
 const importer=mode==='desktop'?importDesktopMediaFiles:importBrowserMediaFiles;
 const make=name=>mode==='desktop'?'C:/'+name:{name};
 const methods=mode==='desktop'?['addClipDesktop','addAudioFileDesktop','addImageDesktop']:['addClipWeb','addAudioFile','addImageWeb'];
 const add=vi.spyOn(Media,methods[0]).mockImplementation(async()=>{order.push('video-start');await pending.promise;order.push('video-ready');});
 const audio=vi.spyOn(Media,methods[1]).mockImplementation(async()=>{order.push('audio');});
 const image=vi.spyOn(Media,methods[2]).mockImplementation(async()=>{order.push('image');});
 try{
  const importing=importer(['next.webm','voice.wav','image.png'].map(make));
  const dialog=await modal.wait();expect(order).toEqual([]);
  const choosing=dialog.buttons.find(button=>button.label.includes('加入序列')).act();
  await vi.waitFor(()=>expect(add).toHaveBeenCalledOnce());expect(order).toEqual(['video-start']);
  pending.resolve();await choosing;await importing;
  expect(order).toEqual(['video-start','video-ready','audio','image']);
 }finally{pending.resolve();add.mockRestore();audio.mockRestore();image.mockRestore();}
});

it.each(['desktop','browser'].flatMap(mode=>['button','dismiss'].map(cancel=>({mode,cancel}))))('$mode 以 $cancel 取消影片選擇仍匯入同批獨立音檔，維持既有取消語意',async({mode,cancel})=>{
 Seq.add({id:'old-primary',primary:true,dur:12,in:0,out:12,offset:0});
 const modal=await incomingModal(),importer=mode==='desktop'?importDesktopMediaFiles:importBrowserMediaFiles;
 const make=name=>mode==='desktop'?'C:/'+name:{name};
 const method=mode==='desktop'?'addAudioFileDesktop':'addAudioFile';
 const load=vi.spyOn(Media,mode==='desktop'?'loadDesktopMedia':'loadVideoFile').mockResolvedValue();
 const add=vi.spyOn(Media,method).mockResolvedValue(null);
 try{
  const importing=importer(['next.webm','voice.wav'].map(make));
  const dialog=await modal.wait();expect(add).not.toHaveBeenCalled();
  if(cancel==='button') await dialog.buttons.find(button=>button.label==='取消').act();
  else dialog.options.onDismiss();
  await importing;
  expect(load).not.toHaveBeenCalled();expect(add).toHaveBeenCalledWith(make('voice.wav'));
 }finally{load.mockRestore();add.mockRestore();}
});

it.each(['replaced','workspace'])('媒體選擇視窗 %s 失效後，舊按鈕與剩餘批次都不能改新工作區',async reason=>{
 Seq.add({id:'old-primary',primary:true,dur:12,in:0,out:12,offset:0});
 const modal=await incomingModal();
 const load=vi.spyOn(Media,'loadDesktopMedia').mockResolvedValue();
 const audio=vi.spyOn(Media,'addAudioFileDesktop').mockResolvedValue(null);
 try{
  const importing=importDesktopMediaFiles(['C:/next.webm','C:/voice.wav']);
  const dialog=await modal.wait();
  if(reason==='replaced')dialog.options?.onReplaced?.();
  else await Project.startNewProject(()=>resetProject());
  await importing;
  await dialog.buttons.find(button=>button.label==='取代目前影片').act();
  expect(load).not.toHaveBeenCalled();expect(audio).not.toHaveBeenCalled();
 }finally{load.mockRestore();audio.mockRestore();}
});

it.each(['resolve','reject'])('取代影片等待 %s 期間換專案，晚到結果不准入同批音檔也不覆寫新狀態',async outcome=>{
 Seq.add({id:'old-primary',primary:true,dur:12,in:0,out:12,offset:0});
 const modal=await incomingModal();let settle;
 const load=vi.spyOn(Media,'loadDesktopMedia').mockImplementation(()=>{
  Media.reset();return new Promise((resolve,reject)=>{settle=()=>outcome==='reject'?reject(new Error('old intake failure')):resolve();});
 });
 const audio=vi.spyOn(Media,'addAudioFileDesktop').mockResolvedValue(null);
 const {showToast}=await import('../src/ui.js');showToast.mockClear();
 try{
  const importing=importDesktopMediaFiles(['C:/next.webm','C:/voice.wav']);
  const dialog=await modal.wait();
  const choosing=dialog.buttons.find(button=>button.label==='取代目前影片').act();
  await vi.waitFor(()=>expect(load).toHaveBeenCalledOnce());
  await Project.startNewProject(()=>{resetProject();Media.reset();});
  settle();await choosing;await importing;
  expect(audio).not.toHaveBeenCalled();expect(showToast).not.toHaveBeenCalled();
 }finally{settle?.();load.mockRestore();audio.mockRestore();}
});

it('單檔媒體選擇的非同步載入錯誤由入口回報，不留下未處理的拒絕',async()=>{
 Seq.add({id:'old-primary',primary:true,dur:12,in:0,out:12,offset:0});
 const modal=await incomingModal();
 const load=vi.spyOn(Media,'loadDesktopMedia').mockRejectedValueOnce(new Error('disk disappeared'));
 const {showToast}=await import('../src/ui.js');showToast.mockClear();
 try{
  const importing=Media.openIncoming({path:'C:/next.webm'});
  const dialog=await modal.wait();
  await expect(dialog.buttons.find(button=>button.label==='取代目前影片').act()).resolves.toBe(false);
  await expect(importing).resolves.toBe(false);
  expect(showToast).toHaveBeenCalledWith(expect.stringContaining('disk disappeared'));
 }finally{load.mockRestore();}
});

it.each(['desktop','browser'])('%s 批次第一素材失去專案所有權後不把剩餘音檔加入新專案',async mode=>{
 const pending=pendingImport(),applied=[];
 const importer=mode==='desktop'?importDesktopMediaFiles:importBrowserMediaFiles;
 const method=mode==='desktop'?'addAudioFileDesktop':'addAudioFile';
 const files=mode==='desktop'?['C:/first.wav','C:/second.wav']:[{name:'first.wav'},{name:'second.wav'}];
 const add=vi.spyOn(Media,method).mockImplementation(async item=>{
  const owns=Project.captureWorkspaceOwnership();
  if(item===files[0])await pending.promise;
  if(!owns())return null;
  applied.push(item);return item;
 });
 try{
  const importing=importer(files);
  await vi.waitFor(()=>expect(add).toHaveBeenCalledTimes(1));
  await Project.startNewProject(()=>resetProject());
  pending.resolve();await importing;
  expect(add).toHaveBeenCalledTimes(1);
  expect(applied).toEqual([]);
 }finally{pending.resolve();add.mockRestore();}
});

it.each(['desktop','browser'])('%s 母影片載入等待期間換專案，不准入剩餘影片、音檔或圖片',async mode=>{
 const pending=pendingImport();
 const importer=mode==='desktop'?importDesktopMediaFiles:importBrowserMediaFiles;
 const methods=mode==='desktop'?['loadDesktopMedia','addClipDesktop','addAudioFileDesktop','addImageDesktop']:
  ['loadVideoFile','addClipWeb','addAudioFile','addImageWeb'];
 const files=['first.webm','second.webm','voice.wav','image.png'].map(name=>mode==='desktop'?'C:/'+name:{name});
 const spies=methods.map((method,index)=>vi.spyOn(Media,method).mockImplementation(()=>index===0?pending.promise:Promise.resolve()));
 try{
  const importing=importer(files);
  await vi.waitFor(()=>expect(spies[0]).toHaveBeenCalledOnce());
  await Project.startNewProject(()=>resetProject());
  pending.resolve();await importing;
  for(const spy of spies.slice(1))expect(spy).not.toHaveBeenCalled();
 }finally{pending.resolve();spies.forEach(spy=>spy.mockRestore());}
});

it.each(['desktop','browser'])('%s 同一專案追加新批次時保留前一批已准入素材與後續合法項目',async mode=>{
 const pending=pendingImport(),applied=[];
 const importer=mode==='desktop'?importDesktopMediaFiles:importBrowserMediaFiles;
 const method=mode==='desktop'?'addAudioFileDesktop':'addAudioFile';
 const make=name=>mode==='desktop'?'C:/'+name:{name};
 const first=make('first.wav'),second=make('second.wav'),next=make('next.wav');
 const add=vi.spyOn(Media,method).mockImplementation(async item=>{
  applied.push(item);
  if(item===first)await pending.promise;
  return item;
 });
 try{
  const previous=importer([first,second]);
  await vi.waitFor(()=>expect(add).toHaveBeenCalledOnce());
  await importer([next]);
  pending.resolve();await previous;
  expect(applied).toEqual([first,next,second]);
 }finally{pending.resolve();add.mockRestore();}
});

it('過期 restore plan 不准入批次第一筆素材，即使 workspace 本身未換代',async()=>{
 const add=vi.spyOn(Media,'addAudioFileDesktop').mockResolvedValue(null);
 try{
  await importDesktopMediaFiles(['C:/old.wav'],{generation:0,plan:{owns:()=>false}});
  expect(add).not.toHaveBeenCalled();
 }finally{add.mockRestore();}
});

it('一般媒體 picker 晚返回時不把舊專案選的檔案加入目前專案',async()=>{
 const pending=pendingImport();
 window.subtool.openMedia=vi.fn(()=>pending.promise);
 const add=vi.spyOn(Media,'addAudioFileDesktop').mockResolvedValue(null);
 try{
  const picking=openMedia();
  await vi.waitFor(()=>expect(window.subtool.openMedia).toHaveBeenCalledOnce());
  await Project.startNewProject(()=>resetProject());
  pending.resolve(['C:/old.wav']);await picking;
  expect(add).not.toHaveBeenCalled();
 }finally{pending.resolve([]);add.mockRestore();delete window.subtool.openMedia;}
});

it('一般媒體入口 lazy import 尚未完成就換專案，不能再啟動舊 picker',async()=>{
 window.subtool.openMedia=vi.fn(async()=>['C:/old.wav']);
 const add=vi.spyOn(Media,'addAudioFileDesktop').mockResolvedValue(null);
 try{
  const picking=openMedia();
  resetProject();
  await picking;
  expect(window.subtool.openMedia).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
 }finally{add.mockRestore();delete window.subtool.openMedia;}
});

describe('反向音訊來源準備與替換',()=>{
 let timelineClock,sourceClock;
 beforeEach(()=>{
  globalThis.Audio.prototype.readyState=1;
  window.subtool.reverseAudio=vi.fn(async({path,in:start,out:end})=>({path:path+'.reverse.wav',duration:end-start}));
  timelineClock=vi.spyOn(Media,'tlTime').mockReturnValue(20.5);sourceClock=vi.spyOn(Media,'vTime').mockReturnValue(3);
 });
 afterEach(()=>{timelineClock.mockRestore();sourceClock.mockRestore();delete globalThis.Audio.prototype.readyState;delete window.subtool.reverseAudio;});
 function reverseSource(){
  Media.ensureCtx();
  const clip=Seq.add({id:'reverse-preview',name:'reverse',primary:true,path:'C:/original.mov',dur:12,
   in:1,out:4,offset:20,speed:2,reverse:true,audioSrc:'video',audioSourceId:'reverse-source'});
  ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:1,sourceChannel:0},{sourceStream:1,sourceChannel:1}]);
  const track={kind:'element',source:'video',audioSourceId:clip.audioSourceId,sourceStream:1,sourceChannel:1,
   file:'C:/mono-cache.wav',el:new Audio(),gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),
   volume:1,muted:false,solo:false,_srcHidden:false};
  Media.tracks.push(track);Media.activeClipId=clip.id;dom.video.currentTime=3;
  return {clip,track};
 }
 it('cached mono 以stream0/channel0讀取；反向來源時鐘、route M/S與gain保留',async()=>{
  const {clip,track}=reverseSource();
  expect(Media.audioSourcePlayback('video',20.5)).toEqual({clip,reverse:true,sourceTime:3,offset:1,rate:2});
  expect(await Media.prepareClipReverseAudio(clip)).toBe(true);
  expect(window.subtool.reverseAudio).toHaveBeenCalledWith({path:track.file,in:1,out:4,sourceStream:0});
  const gain=track.gain;Media.applyGains();expect(Media.trackAudible(track)).toBe(true);expect(gain.gain.value).toBeGreaterThan(0);
  track.muted=true;Media.applyGains();expect(gain.gain.value).toBe(0);
  track.muted=false;Media.applyGains();expect(track.gain).toBe(gain);expect(gain.gain.value).toBeGreaterThan(0);
 });
 it('播放中安裝音效會準備新multichannel stream並沿用新聲道gain，不再靜音',async()=>{
  const {clip,track}=reverseSource();
  await Media.prepareClipReverseAudio(clip);Media.playing=true;Media.startElementSources(3,20.5);
  const oldReverse=audioElements.find(el=>el.src==='file:///'+track.file+'.reverse.wav');
  await vi.waitFor(()=>expect(oldReverse.play).toHaveBeenCalled());
  const effectEl=new Audio();
  const prepared={streams:[{sourceStream:1,outputPath:'C:/processed-stereo.wav',el:effectEl,
   node:AudioEngine.createMediaElementSource(effectEl),descriptors:[{sourceStream:1,sourceChannel:0},{sourceStream:1,sourceChannel:1}]}],
   outputPath:'C:/processed-stereo.wav',peaks:null};
  Media._installAudioEffect(clip,prepared,{mode:'limiter'});
  await vi.waitFor(()=>expect(window.subtool.reverseAudio).toHaveBeenCalledWith({path:'C:/processed-stereo.wav',in:1,out:4,sourceStream:0}));
  await vi.waitFor(()=>{
   const reverse=audioElements.filter(el=>el.src==='file:///C:/processed-stereo.wav.reverse.wav');expect(reverse).toHaveLength(2);
   for(const el of reverse) expect(el.play).toHaveBeenCalled();
  });
  expect(Media.tracks.filter(t=>t._audioEffect)).toHaveLength(2);
  for(const current of Media.tracks){expect(current.gain.gain.value).toBeGreaterThan(0);expect(current.el.play).not.toHaveBeenCalled();}
  expect(oldReverse.src).toBe('');expect(oldReverse.pause).toHaveBeenCalled();
 });
 it('播放中晚到原音cache替換會重新準備反向音源，原正向element不播放',async()=>{
  const {clip,track}=reverseSource();
  await Media.prepareClipReverseAudio(clip);Media.playing=true;Media.startElementSources(3,20.5);
  const oldReverse=audioElements.find(el=>el.src==='file:///'+track.file+'.reverse.wav');
  await vi.waitFor(()=>expect(oldReverse.play).toHaveBeenCalled());
  const incoming={...track,file:'C:/late-mono-cache.wav',el:new Audio(),gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser()};
  Media._commitOriginalAudioTracks(clip,[incoming],{replace:true});Media.syncMuteState();Media._restartElements();
  await vi.waitFor(()=>expect(audioElements.find(el=>el.src==='file:///'+incoming.file+'.reverse.wav')?.play).toHaveBeenCalled());
  expect(oldReverse.src).toBe('');expect(incoming.el.play).not.toHaveBeenCalled();expect(incoming.gain.gain.value).toBeGreaterThan(0);
 });
 it('同ID新片段取代後，晚到reverse cache不能安裝或啟動',async()=>{
  const {clip}=reverseSource();let resolveCache;
  window.subtool.reverseAudio.mockImplementationOnce(()=>new Promise(resolve=>{resolveCache=resolve;}));
  const pending=Media.prepareClipReverseAudio(clip);State.clips=[{...clip}];
  resolveCache({path:'C:/late-reverse.wav',duration:3});
  expect(await pending).toBe(false);expect(audioElements.some(el=>el.src==='file:///C:/late-reverse.wav')).toBe(false);
 });
 it('native反向音源在late獨立cache接管時失去所有權，不會因新track靜音而漏聲',async()=>{
  const {clip,track}=reverseSource();track.kind='native';delete track.file;
  await Media.prepareClipReverseAudio(clip);Media.playing=true;Media.startElementSources(3,20.5);
  const oldReverse=audioElements.find(el=>el.src==='file:///C:/original.mov.reverse.wav');
  await vi.waitFor(()=>expect(oldReverse.play).toHaveBeenCalled());
  const incoming={...track,kind:'element',file:'C:/late-native-cache.wav',el:new Audio(),
   gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser()};
  Media._commitOriginalAudioTracks(clip,[incoming]);incoming.muted=true;Media.applyGains();
  expect(track.gain.gain.value).toBeGreaterThan(0);expect(incoming.gain.gain.value).toBe(0);
  expect(oldReverse.src).toBe('');expect(oldReverse.pause).toHaveBeenCalled();
  const plays=oldReverse.play.mock.calls.length;
  expect(await Media.prepareClipReverseAudio(clip)).toBe(true);Media.startElementSources(3,20.5);
  await vi.waitFor(()=>expect(audioElements.find(el=>el.src==='file:///C:/late-native-cache.wav.reverse.wav')?.play).toHaveBeenCalled());
  expect(oldReverse.play).toHaveBeenCalledTimes(plays);expect(incoming.el.play).not.toHaveBeenCalled();
 });
 it('同track graph被替換後晚到cache不會接到舊gain，下一次可重建',async()=>{
  const {clip,track}=reverseSource();let resolveCache;
  window.subtool.reverseAudio.mockImplementationOnce(()=>new Promise(resolve=>{resolveCache=resolve;}));
  const pending=Media.prepareClipReverseAudio(clip);track.gain=AudioEngine.createGain();track.analyser=AudioEngine.createAnalyser();
  resolveCache({path:'C:/old-graph-reverse.wav',duration:3});
  expect(await pending).toBe(false);expect(audioElements.some(el=>el.src==='file:///C:/old-graph-reverse.wav')).toBe(false);
  expect(await Media.prepareClipReverseAudio(clip)).toBe(true);
 });
 it('固定畫面与解除音訊連結不準備反向音源，也不提供source playback',async()=>{
  const {clip}=reverseSource();clip.audioDetached=true;
  expect(await Media.prepareClipReverseAudio(clip)).toBe(true);expect(Media.audioSourcePlayback('video',20.5)).toBeNull();
  clip.audioDetached=false;clip.freezeTime=2;
  expect(await Media.prepareClipReverseAudio(clip)).toBe(true);expect(Media.audioSourcePlayback('video',20.5)).toBeNull();
  expect(window.subtool.reverseAudio).not.toHaveBeenCalled();
 });
});
