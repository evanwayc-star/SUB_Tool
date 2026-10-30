// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js',()=>({setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));

const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});

describe('mpv 背景聲道接管',()=>{
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

  it.each(['continue','buffer','pause','reset','seek','switch','failed'])('背景聲道接管等待 mpv 靜音回覆，並遵守 %s 意圖',async action=>{
    vi.resetModules();
    document.body.innerHTML=readFileSync('index.html','utf8');
    const video=document.getElementById('video');
    video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
    const ingest=deferred(),muteAck=deferred(),presented=deferred();
    const sounds=[];
    let nativeMuted=false;
    class AudioElement extends EventTarget{
      constructor(){super();this.src='';this.currentTime=0;this.duration=12;this.readyState=1;this.paused=true;this.playbackRate=1;}
      play=vi.fn(async()=>{this.paused=false;sounds.push({nativeMuted,elementPlaying:true,time:this.currentTime});});
      pause=vi.fn(()=>{this.paused=true;});load=vi.fn();
    }
    const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
      createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
      createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buf=>buf.fill(0)}),
      createMediaElementSource:()=>node(),createChannelSplitter:()=>node(),createChannelMerger:()=>node(),
      createBufferSource:()=>({...node(),playbackRate:{value:1},start:vi.fn((unused,time)=>sounds.push({nativeMuted,elementPlaying:true,time})),stop:vi.fn()})};
    window.AudioContext=function(){return context;};vi.stubGlobal('Audio',AudioElement);
    const mpv={detect:vi.fn(async()=>({available:true})),launch:vi.fn(async()=>({ok:true,duration:12})),
      play:vi.fn(async()=>{}),pause:vi.fn(async()=>{}),present:vi.fn(time=>['seek','switch'].includes(action)?presented.promise:Promise.resolve({backend:'mpv',presentedSourceTime:time})),
      loadfile:vi.fn(async()=>({ok:true,duration:9})),
      quit:vi.fn(async()=>{}),onEvent:vi.fn(),mute:vi.fn(async value=>{
        if(value){await muteAck.promise;nativeMuted=true;} else nativeMuted=false;
      })};
    Object.defineProperty(window,'subtool',{configurable:true,value:{isDesktop:true,mpv,
      stat:vi.fn(async()=>({exists:true,size:6_000_000_000})),
      probe:vi.fn(async()=>({duration:12,video:{codec:'mpeg2video',fps:25,width:1920,height:1080},audio:[{channels:1}]})),
      ingest:vi.fn(()=>ingest.promise),fileURL:vi.fn(async path=>`file:///${path}`)}});
    const {Media}=await import('../src/media.js');
    try{
      await Media.loadDesktopMedia('C:/large.mxf');
      expect(window.subtool.ingest).toHaveBeenCalledOnce();
      Media.play();
      ingest.resolve({channels:[{file:'C:/cache/mono.wav',label:'mono',sourceStream:0,sourceChannel:0}]});
      await vi.waitFor(()=>expect(Media.tracks.filter(track=>track.kind==='element')).toHaveLength(1));
      if(action==='buffer'){
        const track=Media.tracks.find(item=>item.kind==='element');track.kind='buffer';
        track.buffer={duration:12,length:120,sampleRate:10,numberOfChannels:1,getChannelData:()=>new Float32Array(120)};
        Media.startBufferSources(0);
      }
      Media.seqTick();Media.syncAudioDrift();
      await new Promise(resolve=>setTimeout(resolve,20));
      expect(sounds.filter(sound=>!sound.nativeMuted)).toEqual([]);
      if(action==='pause') Media.pause({seekOnPause:false});
      if(action==='reset') Media.reset();
      let seeking;
      if(action==='switch'){
        const {Seq}=await import('../src/sequence.js');
        const primary=Seq.primary();primary.out=3;
        Seq.add({id:'next-source',name:'next.mxf',path:'C:/next.mxf',dur:9,in:0,out:9,offset:3,vtrack:0,audioSrc:'clip:next-source',audioSourceId:'next-source'});
        Seq.recomputeDuration();
      }
      if(action==='seek'||action==='switch'){
        seeking=Media.seek(4);
        await vi.waitFor(()=>expect(Media.playbackTransitionPending()).toBe(true));
      }
      if(action==='failed') muteAck.reject(new Error('mpv rejected mute'));
      else muteAck.resolve();
      await new Promise(resolve=>setTimeout(resolve,20));
      expect(sounds.filter(sound=>!sound.nativeMuted)).toEqual([]);
      if(action==='continue'||action==='buffer') await vi.waitFor(()=>expect(sounds).toHaveLength(1));
      else if(action==='seek'||action==='switch'){
        expect(sounds).toHaveLength(0);
        presented.resolve({backend:'mpv',presentedSourceTime:action==='seek'?4:1});
        await seeking;
        if(action==='seek'){
          await vi.waitFor(()=>expect(sounds).toHaveLength(1));
          expect(sounds[0].time).toBeCloseTo(4);
        }else{
          expect(mpv.loadfile).toHaveBeenCalledWith('C:/next.mxf');
          expect(sounds).toHaveLength(0);
        }
      }else expect(sounds).toHaveLength(0);
    }finally{muteAck.resolve();Media.reset();delete window.subtool;}
  });
});
