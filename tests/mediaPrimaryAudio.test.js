// @vitest-environment jsdom
import {vi,beforeAll,beforeEach,afterEach,it,expect} from 'vitest';
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
vi.mock('../src/subtitle-model.js',()=>({addCue:vi.fn(),cueTrackLocked:vi.fn()}));
let Media,Wave,State,setFps,resetAudioProject,ensureAudioSourceMap,Project,resetProject,Seq,AudioEngine,pickMediaFiles;
const audioElements=[];
beforeAll(async()=>{
 Object.defineProperty(window,'subtool',{configurable:true,value:{isDesktop:true,stat:vi.fn(async()=>({exists:true,size:1024})),probe:vi.fn(async()=>({duration:12,video:{codec:'vp9',fps:30,width:1920,height:1080},audio:[]})),fileURL:vi.fn(async path=>'file:///'+path)}});
 window.AudioContext=class {constructor(){this.state='running';this.destination={};this.currentTime=0;}createGain(){return {connect:vi.fn(),disconnect:vi.fn(),gain:{value:1}};}createAnalyser(){return {connect:vi.fn(),fftSize:0};}createMediaElementSource(){return {channelCount:2,connect:vi.fn(),disconnect:vi.fn()};}createChannelSplitter(){return {connect:vi.fn(),disconnect:vi.fn()};}createChannelMerger(){return {connect:vi.fn(),disconnect:vi.fn()};}resume(){}};
 globalThis.Audio=class extends EventTarget {constructor(){super();this.src='';this.duration=12;this.currentTime=0;this.playbackRate=1;this.play=vi.fn(async()=>{});this.pause=vi.fn();audioElements.push(this);}removeAttribute(){}load(){}};
 ({Media,Wave}=await import('../src/media.js'));
 ({State,setFps,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js'));
 ({Project,resetProject}=await import('../src/project.js'));
 ({Seq}=await import('../src/sequence.js'));
 ({AudioEngine}=await import('../src/audio-engine.js'));
 ({pickMediaFiles}=await import('../src/media-loader.js'));
 vi.spyOn(Project,'_checkMissingFonts').mockResolvedValue([]);
});
beforeEach(()=>{Media.reset();resetAudioProject();State.cues=[];State.clips=[];State.notes=[];dom.video.src='';dom.video.currentTime=0;audioElements.length=0;});
afterEach(()=>{Media.reset();resetProject();});
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

it('composition snapshot is immutable, retained only for its physical frame, and cleared on reset',()=>{
 const ids=['image'];Media.setWebCodecsComposited(true,{time:1,imageIds:ids,imagesComposited:true});
 const snapshot=Media.previewComposition();ids.push('new-image');
 expect(Object.isFrozen(snapshot)).toBe(true);expect(Object.isFrozen(snapshot.imageIds)).toBe(true);
 expect(snapshot.imageIds).toEqual(['image']);
 Media.setWebCodecsComposited(true);expect(Media.previewComposition()).toBe(snapshot);
 Media.reset();expect(Media.previewComposition()).toBeNull();
});
