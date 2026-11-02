// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

const dom = vi.hoisted(() => {
  const video = { style:{}, src:'', readyState:1, duration:10, videoWidth:1920, videoHeight:1080,
    playbackRate:1, currentTime:0, muted:false, hasAttribute:()=>false, pause:vi.fn() };
  const elements = new Map();
  return { video, sublist:null, tlScroll:null, tlLayer:null, tlTracks:null, rulerCv:null, imageLayer:null,
    $(id){ if(!elements.has(id))elements.set(id,{style:{},textContent:'',innerHTML:'',value:'',
      classList:{add:vi.fn(),remove:vi.fn()},addEventListener:vi.fn(),removeEventListener:vi.fn(),
      querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:640,height:360})});return elements.get(id); } };
});
vi.mock('../src/dom.js',()=>dom);
vi.mock('../src/ui.js',()=>new Proxy({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()},
  {get:(target,key)=>key==='then'?undefined:(target[key]||vi.fn())}));
vi.mock('../src/timeline-renderer.js',()=>new Proxy({drawTimeline:vi.fn(),updatePlayhead:vi.fn()},
  {get:(target,key)=>key==='then'?undefined:(target[key]||vi.fn())}));
vi.mock('../src/mixer.js',()=>({renderAudioTracks:vi.fn(),clearMeterStrips:vi.fn()}));
vi.mock('../src/decode/source-frame-index.js',async importOriginal=>({
  ...await importOriginal(),sourcePresentationMetadata:vi.fn(async()=>null),
}));

it.each(['clean','subtitle','routing','save','replaced','cancel','reentry','event-edit','event-replace','silent'])(
  '舊專案重新連結需轉碼來源，期間 %s 的工作與編輯必須保有正確歸屬',async scenario=>{
  vi.resetModules();
  delete window.subtool;
  window.AudioContext=class {constructor(){this.state='running';this.destination={};this.currentTime=0;}
    createGain(){return {connect:vi.fn(),disconnect:vi.fn(),gain:{value:1}};}
    createAnalyser(){return {connect:vi.fn(),fftSize:0};} resume(){} };
  const {Media}=await import('../src/media.js');
  const {State,resetAudioProject}=await import('../src/state.js');
  const {Project,isProjectDirty}=await import('../src/project.js');
  const {History}=await import('../src/history.js');
  const {AudioEngine}=await import('../src/audio-engine.js');
  const {on}=await import('../src/events.js');
  const util=await import('../src/util.js');
  const download=vi.spyOn(util,'downloadBytes').mockImplementation(()=>{});
  Media.reset();Media.ctx=null;Media.master=null;Media.tracks=[];
  State.cues=[];State.clips=[];State.mediaPath=null;resetAudioProject();
  vi.spyOn(Project,'_checkMissingFonts').mockResolvedValue([]);
  const file=new File([new Uint8Array([1,2,3,4])],'A.mov',{type:'video/quicktime'});
  const data={version:3,fps:25,duration:10,media:{name:file.name,size:file.size},
    tracks:[{name:'字幕',visible:true}],cues:[{start:1,end:2,text:'原字幕',track:1}],notes:[],
    clips:[{name:file.name,primary:true,in:0,out:10,dur:10,offset:0}]};
  const probes=[],originalCreate=document.createElement.bind(document);
  const createDescriptor=Object.getOwnPropertyDescriptor(URL,'createObjectURL');
  const revokeDescriptor=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
  let nextUrl=0,logger=()=>{},releaseExtraction,signalExtraction;
  const extractionGate=new Promise(resolve=>{releaseExtraction=resolve;});
  const extractionStarted=new Promise(resolve=>{signalExtraction=resolve;});
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>`blob:test-${++nextUrl}`)});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
  vi.spyOn(document,'createElement').mockImplementation(tag=>{
    if(tag!=='video')return originalCreate(tag);
    const probe={readyState:0,onloadedmetadata:null,onerror:null};probes.push(probe);return probe;
  });
  const ff={setLogger:vi.fn(value=>{logger=value;}),FS:vi.fn(action=>action==='readFile'?new Uint8Array([0,1,2,3]):undefined),
    run:vi.fn(async(...args)=>{
      if(args.length===2){if(scenario!=='silent')logger({message:'Stream #0:1: Audio: aac'});}
      else if(args.at(-1)==='prev.mp4'&&scenario==='silent'){signalExtraction();await extractionGate;}
      else if(args.at(-1)==='a0.wav'){signalExtraction();await extractionGate;}
    })};
  vi.spyOn(Media,'_loadFFmpegForIntake').mockResolvedValue(ff);
  vi.spyOn(AudioEngine,'readSourceAudioClock').mockResolvedValue({duration:10});
  const buffer={numberOfChannels:2,length:4,sampleRate:48000,getChannelData:()=>new Float32Array(4)};
  vi.spyOn(AudioEngine,'decodeSourceAudioData').mockResolvedValue(buffer);
  vi.spyOn(AudioEngine,'createBuffer').mockImplementation(()=>({getChannelData:()=>new Float32Array(4)}));
  vi.spyOn(AudioEngine,'createGain').mockImplementation(()=>({connect:vi.fn(),disconnect:vi.fn(),gain:{value:1}}));
  vi.spyOn(AudioEngine,'connectToMaster').mockImplementation(()=>{});
  vi.spyOn(Media,'attachMeter').mockImplementation(()=>{});
  try{
    await Project.load(new File([JSON.stringify(data)],'project.subtool'));
    const {generation,plan}=Project.pendingMediaRelink();
    const registered=vi.fn();
    if(scenario==='reentry'){
      on('audio:sourceRegistered',registered);
      vi.spyOn(plan,'captureLegacySource').mockImplementation(()=>{
        Media.reset();State.cues=[{id:'new',start:0,end:1,text:'新工作區',track:0}];
        History.reset();Project.establishCleanBaseline();
      });
    }
    if(scenario==='event-edit') on('audio:sourceRegistered',detail=>{
      if(detail?.sourceId&&State.audioProject.buses[0]){
        State.audioProject.buses[0].name='同步修改的配線';History.record('同步修改配線');
      }
    });
    if(scenario==='event-replace') on('audio:sourceRegistered',()=>{
      Media.reset();State.cues=[{id:'new',start:0,end:1,text:'新工作區',track:0}];
      History.reset();Project.establishCleanBaseline();
    });
    const loading=Media.loadVideoFile(file,plan);
    await vi.waitFor(()=>expect(probes).toHaveLength(1));probes[0].onerror();
    await extractionStarted;
    if(scenario==='subtitle'){State.cues[0].text='轉檔期間修改';History.record('轉檔期間修改');}
    if(scenario==='routing'){State.audioProject.mode='manual';History.record('轉檔期間更改配線');}
    if(scenario==='save') await Project.saveAs();
    if(scenario==='replaced') await Project.startNewProject(()=>{
      Media.reset();State.cues=[{id:'new',start:0,end:1,text:'新工作區',track:0}];History.reset();
    });
    if(scenario==='cancel') Media.reset();
    releaseExtraction();
    await loading;await Media.waitForPendingProjectRestore();
    const finished=await Project.finishBrowserMediaRelink(generation,plan);
    expect(ff.run).toHaveBeenCalled();
    if(['replaced','cancel','reentry','event-replace'].includes(scenario)){
      if(scenario==='replaced'){
        expect(finished).toBe(false);expect(State.cues[0].text).toBe('新工作區');expect(isProjectDirty()).toBe(false);
      }else if(scenario==='reentry'||scenario==='event-replace'){
        expect(State.cues[0].text).toBe('新工作區');expect(isProjectDirty()).toBe(false);
        if(scenario==='reentry') expect(registered).not.toHaveBeenCalled();
      }else{
        expect(plan.legacyHandoffs().every(handoff=>handoff.evidence===null)).toBe(true);
      }
      expect(Media.tracks).toHaveLength(0);
      return;
    }
    expect(State.clips[0]?.audioSourceId).toBeTruthy();
    const count=scenario==='silent'?0:2;
    expect(State.audioProject.sourceMaps[State.clips[0].audioSourceId]?.channels).toHaveLength(count);
    expect(plan.legacyHandoffs()[0]?.evidence?.channels).toHaveLength(count);
    if(['subtitle','routing','event-edit'].includes(scenario)){
      expect(isProjectDirty()).toBe(true);
      History.undo();expect(isProjectDirty()).toBe(false);
      History.redo();expect(isProjectDirty()).toBe(true);
    }else if(scenario==='save'){
      expect(download).toHaveBeenCalledOnce();expect(isProjectDirty()).toBe(true);
    }else{
      expect(isProjectDirty()).toBe(false);
      State.cues[0].text='已確認的真實編輯';expect(isProjectDirty()).toBe(true);
    }
  }finally{
    releaseExtraction();
    Media.reset();vi.restoreAllMocks();
    if(createDescriptor)Object.defineProperty(URL,'createObjectURL',createDescriptor);else delete URL.createObjectURL;
    if(revokeDescriptor)Object.defineProperty(URL,'revokeObjectURL',revokeDescriptor);else delete URL.revokeObjectURL;
  }
});
