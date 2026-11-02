// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const ui=vi.hoisted(()=>({setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
const dom=vi.hoisted(()=>{
  const video={style:{},src:'',currentTime:0,duration:10,playbackRate:1,muted:false,
    hasAttribute:()=>false,pause:vi.fn(),dispatchEvent:vi.fn()};
  const elements=new Map();
  return {video,sublist:null,tlScroll:null,tlLayer:null,tlTracks:null,rulerCv:null,imageLayer:null,
    $(id){if(!elements.has(id))elements.set(id,{style:{},textContent:'',value:'',innerHTML:'',
      classList:{add:vi.fn(),remove:vi.fn()},addEventListener:vi.fn(),removeEventListener:vi.fn(),
      querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:640,height:360})});return elements.get(id);}};
});
vi.mock('../src/dom.js',()=>dom);
vi.mock('../src/ui.js',()=>new Proxy(ui,{get:(target,key)=>key==='then'?undefined:(target[key]||vi.fn())}));
vi.mock('../src/timeline-renderer.js',()=>new Proxy({drawTimeline:vi.fn(),updatePlayhead:vi.fn()},
  {get:(target,key)=>key==='then'?undefined:(target[key]||vi.fn())}));
vi.mock('../src/mixer.js',()=>({renderAudioTracks:vi.fn(),clearMeterStrips:vi.fn()}));

afterEach(()=>{vi.restoreAllMocks();delete window.subtool;});

it.each(['playing','gap','audio-only','pending','reentry-stop','reentry-seek','reentry-status'])(
  '來源失連的 %s 情境保持播放工作及專案所有權',async scenario=>{
  vi.resetModules();vi.clearAllMocks();
  let deliver;
  const bridge={launch:vi.fn(async()=>({ok:true,duration:10,sourceSessionId:'A'})),
    loadfile:vi.fn(async()=>({ok:true,duration:10,sourceSessionId:'B'})),
    onEvent:vi.fn(callback=>{deliver=callback;}),quit:vi.fn(async()=>true),
    pause:vi.fn(async()=>true),present:vi.fn(()=>new Promise(()=>{})),cancelPresent:vi.fn(async()=>true),
    setGuide:vi.fn(async()=>true),setImageGuide:vi.fn(async()=>true)};
  window.subtool={isDesktop:true,mpv:bridge,configSave:vi.fn()};
  const {State}=await import('../src/state.js');
  const {Project,isProjectDirty}=await import('../src/project.js');
  const {History}=await import('../src/history.js');
  const {Media}=await import('../src/media.js');
  const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
  const runtime=resetPlayerAdapter(window.subtool,dom.video);
  const clip={id:'B',name:'B.mov',path:'C:/B.mov',dur:10,in:0,out:10,offset:0,vtrack:0};
  Object.assign(State,{clips:[clip],cues:[{id:'c',text:'未遺失的字幕',start:1,end:2,track:0}],notes:[],duration:10,
    tracks:[{name:'字幕',visible:true}],videoTracks:[{name:'V1',visible:true}],fps:25});
  History.reset();Project.establishCleanBaseline();
  await runtime.enterMpv({src:'C:/A.mov'});
  const onEvent=vi.fn(event=>Media.observeMpvEvent(event));
  runtime.onEvent(onEvent);
  await runtime.loadfile('C:/B.mov');
  Media.activeClipId='B';Media._mpvPath='C:/B.mov';Media._mpvTime=2;Media.playing=true;
  if(scenario==='audio-only'){
    State.clips=[];Media.activeClipId=null;
    Media.createExternalAudioSource({name:'voice.wav',duration:10,in:0,out:10,offset:0,fallbackCount:1});
    expect(Media.audioOnlyTimeline()).toBe(true);
    History.reset();Project.establishCleanBaseline();vi.clearAllMocks();
  }
  const stopBuffers=vi.spyOn(Media,'stopBufferSources').mockImplementation(()=>{});
  let inNewSeek=false,stopsOutsideNewSeek=0;
  const stopElements=vi.spyOn(Media,'stopElementSources').mockImplementation(()=>{
    if(!inNewSeek)stopsOutsideNewSeek++;
  });
  try{
    // Outside the adapter's synchronous verified delivery even an identical
    // payload does not own the live source.
    Media.observeMpvEvent({event:'disconnected',sourceSessionId:'B'});
    expect(Media.playing).toBe(true);expect(stopBuffers).not.toHaveBeenCalled();
    deliver({event:'disconnected',sourceSessionId:'A'});
    expect(Media.playing).toBe(true);expect(stopBuffers).not.toHaveBeenCalled();expect(ui.showToast).not.toHaveBeenCalled();expect(onEvent).not.toHaveBeenCalled();
    let pending;
    if(scenario==='gap') Media._gap=true;
    if(scenario==='pending'){
      const session=Media._ensurePresentationSession();
      pending=session.requestPlayback(2);session.setPlaybackIntent(true);
      expect(Media.playbackTransitionPending()).toBe(true);
      stopBuffers.mockClear();stopElements.mockClear();
    }
    if(scenario==='reentry-stop') stopBuffers.mockImplementationOnce(()=>{runtime.selectHtml5(dom.video);Media.playing=true;});
    if(scenario==='reentry-seek') stopBuffers.mockImplementationOnce(()=>{
      inNewSeek=true;
      try{Media.playing=false;void Media.seek(4);Media.playing=true;}
      finally{inNewSeek=false;}
    });
    if(scenario==='reentry-status') ui.setStatus.mockImplementationOnce(()=>{runtime.selectHtml5(dom.video);Media.playing=true;});
    deliver({event:'disconnected',sourceSessionId:'B'});
    if(scenario==='gap'||scenario==='audio-only'){
      expect(Media.playing).toBe(true);expect(stopBuffers).not.toHaveBeenCalled();expect(stopElements).not.toHaveBeenCalled();
    }else if(scenario==='reentry-stop'||scenario==='reentry-seek'){
      expect(Media.playing).toBe(true);expect(stopsOutsideNewSeek).toBe(0);expect(ui.showToast).not.toHaveBeenCalled();
    }else if(scenario==='reentry-status'){
      expect(Media.playing).toBe(true);expect(ui.showToast).not.toHaveBeenCalled();
    }else{
      expect(Media.playing).toBe(false);
      expect(stopBuffers).toHaveBeenCalled();expect(stopElements).toHaveBeenCalled();
    }
    if(scenario==='pending') await expect(pending).resolves.toMatchObject({status:'cancelled',reason:'player-error'});
    if(!scenario.startsWith('reentry')) expect(ui.showToast.mock.calls.flat().join(' ')).toMatch(/中斷|失去連線|無法播放/);
    expect(State.clips).toEqual(scenario==='audio-only'?[]:[clip]);expect(State.cues[0].text).toBe('未遺失的字幕');
    expect(isProjectDirty()).toBe(false);
  }finally{Media.reset();runtime.stopBoundsFeeder();}
});
