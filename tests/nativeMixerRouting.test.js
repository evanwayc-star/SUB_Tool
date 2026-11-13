// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js',()=>({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();delete window.subtool;});

describe('快取前的音量表控制傳到原生聲音路徑',()=>{
  it('獨奏、複選獨奏、靜音及推子逐聲道控制 mpv，不能只改電平表',async()=>{
    vi.resetModules();
    document.body.innerHTML=readFileSync('index.html','utf8');
    const video=document.getElementById('video');
    video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
    const connect=()=>({connect:vi.fn(),disconnect:vi.fn()});
    window.AudioContext=function(){return {state:'running',currentTime:0,destination:{},resume:vi.fn(),
      createGain:()=>({...connect(),gain:{value:1}}),
      createAnalyser:()=>({...connect(),fftSize:32,getFloatTimeDomainData:buf=>buf.fill(0)})};};
    const mpv={detect:vi.fn(async()=>({available:true})),launch:vi.fn(async()=>({ok:true,duration:12,sourceSessionId:'native-fixture'})),
      quit:vi.fn(async()=>{}),onEvent:vi.fn(),mute:vi.fn(async()=>{}),audioMix:vi.fn(async()=>true)};
    Object.defineProperty(window,'subtool',{configurable:true,value:{isDesktop:true,mpv,
      stat:vi.fn(async()=>({exists:true,size:6_000_000_000})),
      probe:vi.fn(async()=>({duration:12,video:{codec:'mpeg2video',fps:25,width:1920,height:1080},audio:[{channels:1},{channels:1}]})),
      ingest:vi.fn(()=>new Promise(()=>{})),fileURL:vi.fn(async path=>`file:///${path}`)}});
    const {Media}=await import('../src/media.js');
    const {State}=await import('../src/state.js');
    try{
      await Media.loadDesktopMedia('C:/two-tones.mxf');
      expect(Media.mpvMode).toBe(true);
      expect(Media.tracks).toHaveLength(0);
      const [first,second]=State.audioProject.buses;
      const expectGains=async gains=>{
        await vi.waitFor(()=>expect(mpv.audioMix).toHaveBeenLastCalledWith({sourceSessionId:'native-fixture',channels:
          gains.map((gain,sourceStream)=>({sourceStream,sourceChannel:0,gain}))}));
      };
      Media.toggleProjectBusSolo(first.id);
      await expectGains([1,0]);
      Media.toggleProjectBusSolo(second.id);
      await expectGains([1,1]);
      Media.toggleProjectBusMute(first.id);
      await expectGains([0,1]);
      Media.setProjectBusVolume(second.id,.25);
      await expectGains([0,.25]);
      Media.toggleProjectBusMute(second.id);
      await expectGains([0,0]);
      await vi.waitFor(()=>expect(mpv.mute).toHaveBeenLastCalledWith(true));
      Media.toggleProjectBusMute(first.id);
      await expectGains([1,0]);
      await vi.waitFor(()=>expect(mpv.mute).toHaveBeenLastCalledWith(false));
    }finally{Media.reset();}
  });
});

describe('原生混音 ACK 與來源資格',()=>{
  const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
  it.each(['mute','source','newer','failure'])('等待混音完成期間的 %s 不得被舊回覆解除靜音',async action=>{
    vi.resetModules();
    const first=deferred();
    const bridge={launch:vi.fn(async()=>({ok:true,sourceSessionId:'one'})),
      loadfile:vi.fn(async()=>({ok:true,sourceSessionId:'two'})),
      audioMix:vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true),mute:vi.fn(async()=>{})};
    const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
    const runtime=resetPlayerAdapter({mpv:bridge});
    await runtime.enterMpv({src:'C:/first.mov'});
    const channels=[{sourceStream:0,sourceChannel:0,gain:1}];
    const pending=runtime.syncAudioMix(channels,false).catch(error=>error);
    expect(bridge.mute).not.toHaveBeenCalledWith(false);
    if(action==='mute') await runtime.mute(true);
    if(action==='source') await runtime.loadfile('C:/next.mov');
    if(action==='newer') await runtime.syncAudioMix([{...channels[0],gain:0}],true);
    if(action==='failure') first.reject(new Error('graph failed'));
    else first.resolve(true);
    const result=await pending;
    expect(bridge.mute).not.toHaveBeenCalledWith(false);
    if(action==='failure'){
      expect(result).toBeInstanceOf(Error);
      expect(bridge.mute).toHaveBeenLastCalledWith(true);
    }
    resetPlayerAdapter(null);
  });
});
