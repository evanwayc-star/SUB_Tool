// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { URL as NodeURL } from 'node:url';
import { Blob as NodeBlob } from 'node:buffer';
const speechMock=vi.hoisted(()=>({transcribe:vi.fn()}));
vi.mock('../src/speech-recognition-engine.js',async original=>({...await original(),transcribeAudioStream:speechMock.transcribe}));

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const desktopMock = vi.hoisted(() => ({
  isDesktop: true,
  fileURL: vi.fn(),
  ingest: vi.fn(),
  probe: vi.fn(),
}));

const domMock = vi.hoisted(() => {
  const listeners = new Map();
  const video = {
    style: {}, src: '', readyState: 0, duration: 5, videoWidth: 1920, videoHeight: 1080,
    playbackRate: 1, currentTime: 0, muted: false,
    pause: vi.fn(), play: vi.fn(), load: vi.fn(),
    hasAttribute: name => name === 'src' && !!video.src,
    removeAttribute: name => { if (name === 'src') video.src = ''; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) { for (const listener of [...(listeners.get(type) || [])]) listener({ type }); },
    dispatchEvent(event) { video.dispatch(event.type); return true; },
    resetEvents() { listeners.clear(); },
  };
  const elements = new Map();
  return {
    video,
    $(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          style: {}, textContent: '', innerHTML: '', value: '', addEventListener: vi.fn(),
          classList: { add: vi.fn(), remove: vi.fn() },
          querySelectorAll: () => [],
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
        });
      }
      return elements.get(id);
    },
  };
});

const eventMock = vi.hoisted(() => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/dom.js', async original => ({...await original(),...domMock}));
vi.mock('../src/events.js', () => eventMock);
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

let Media, State, resetPlayerAdapter;

describe('辨識素材網址所有權', () => {
  beforeAll(async () => {
    window.subtool = desktopMock;
    window.AudioContext = class {
      constructor(){ this.state = 'running'; this.destination = {}; this.currentTime = 0; }
      createGain(){ return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createAnalyser(){ return { connect: vi.fn(), disconnect: vi.fn(), fftSize: 32 }; }
      createMediaElementSource(){ return { channelCount: 2, connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelSplitter(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
      decodeAudioData(){ return Promise.resolve({
        duration: 1, numberOfChannels: 1, sampleRate: 100,
        getChannelData: () => new Float32Array(100),
      }); }
      resume(){}
    };
    ({ Media } = await import('../src/media.js'));
    ({ State } = await import('../src/state.js'));
    ({ resetPlayerAdapter } = await import('../src/media-player-adapter.js'));
  });

  beforeEach(() => {
    Media.reset();
    Media.ctx = null;
    Media.master = null;
    Media.tracks = [];
    State.clips = [];
    desktopMock.fileURL.mockReset();
    desktopMock.ingest.mockReset();
    desktopMock.probe.mockReset();
    desktopMock.probe.mockResolvedValue({ duration: 8, audio: [{ channels: 1 }] });
    eventMock.emit.mockClear();
    domMock.video.src = '';
    domMock.video.readyState = 0;
    domMock.video.duration = 5;
    domMock.video.resetEvents();
    delete desktopMock.mpv;
    resetPlayerAdapter(desktopMock);
  });

  it('真實接受工作後執行 Media reset 保留 Blob 音訊供後續素材辨識', async()=>{
    const ui=await import('../src/ui.js');
    const speech=await import('../src/speech-recognition.js');
    const {AudioEngine}=await import('../src/audio-engine.js');
    const oldCreate=Object.getOwnPropertyDescriptor(URL,'createObjectURL');
    const oldRevoke=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
    Object.defineProperty(URL,'createObjectURL',{configurable:true,value:NodeURL.createObjectURL.bind(NodeURL)});
    Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:NodeURL.revokeObjectURL.bind(NodeURL)});
    const file=new NodeBlob([new Uint8Array([11,22,33,44])],{type:'audio/wav'});
    const url=URL.createObjectURL(file);Media.objectURLs.push(url);
    const pcm=value=>({sampleRate:16000,numberOfChannels:1,length:160,duration:.01,getChannelData:()=>new Float32Array(160).fill(value)});
    const first={id:'first',name:'first.wav',audioBuffer:pcm(.2),in:0,out:.01,dur:.01,offset:0,vtrack:0};
    const second={id:'second',name:'second.wav',web:{url},audioSrc:'clip:second',audioSourceId:'second-source',in:0,out:.01,dur:.01,offset:0,vtrack:1};
    State.clips=[first,second];Media.tracks=[{audioSourceId:'second-source',source:'clip:second',sourceStream:0,sourceChannel:0,file,el:{src:url}}];
    const decode=vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValue(pcm(.6));
    const normalize=vi.spyOn(AudioEngine,'normalizeSourceAudioBuffer').mockImplementation(async buffer=>buffer);
    let finishFirst;speechMock.transcribe.mockReset().mockImplementationOnce(()=>new Promise(resolve=>{finishFirst=resolve;})).mockResolvedValue([]);
    ui.openModal.mockImplementation((_title,html)=>{document.body.innerHTML=html+'<div id="modalFoot"></div>';});
    try{
      speech.saveAsrConfig({...speech.getAsrConfig(),provider:'builtin'});
      speech.openSpeechRecognitionDialog([first,second]);await new Promise(resolve=>setTimeout(resolve,0));
      const pending=ui.openModal.mock.calls.at(-1)[2].find(button=>button.primary).act();
      await vi.waitFor(()=>expect(finishFirst).toBeTypeOf('function'));
      expect([...new Uint8Array(await (await fetch(url)).arrayBuffer())]).toEqual([11,22,33,44]);
      Media.reset();
      expect([...new Uint8Array(await (await fetch(url)).arrayBuffer())]).toEqual([11,22,33,44]);
      finishFirst([]);await pending;
      await expect(fetch(url)).rejects.toThrow();
      expect(speechMock.transcribe).toHaveBeenCalledTimes(2);
      expect([...new Uint8Array(decode.mock.calls[0][0])]).toEqual([11,22,33,44]);
      expect(speechMock.transcribe.mock.calls[1][0].audioBuffer.getChannelData(0)[0]).toBeCloseTo(.6);
    }finally{
      speech.clearAsrSession();decode.mockRestore();normalize.mockRestore();
      if(oldCreate)Object.defineProperty(URL,'createObjectURL',oldCreate);else delete URL.createObjectURL;
      if(oldRevoke)Object.defineProperty(URL,'revokeObjectURL',oldRevoke);else delete URL.revokeObjectURL;
    }
  });

  it('重複持有僅在最後持有人釋放後撤銷，外部網址不由 Media 撤銷',async()=>{
    const original=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
    const revoke=vi.fn(NodeURL.revokeObjectURL.bind(NodeURL));
    Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revoke});
    const owned=NodeURL.createObjectURL(new NodeBlob(['owned']));
    const external=NodeURL.createObjectURL(new NodeBlob(['external']));
    Media.objectURLs.push(owned);
    try{
      const releaseA=Media.retainObjectURLs([owned,owned,external]);
      const releaseB=Media.retainObjectURLs([owned]);
      Media._releaseObjectURL(owned);
      expect(await (await fetch(owned)).text()).toBe('owned');
      releaseA();releaseA();
      expect(await (await fetch(owned)).text()).toBe('owned');
      releaseB();releaseB();
      await expect(fetch(owned)).rejects.toThrow();
      expect(revoke.mock.calls).toEqual([[owned]]);
      expect(await (await fetch(external)).text()).toBe('external');
    }finally{
      NodeURL.revokeObjectURL(owned);NodeURL.revokeObjectURL(external);
      if(original)Object.defineProperty(URL,'revokeObjectURL',original);else delete URL.revokeObjectURL;
    }
  });

  it.each(['完成','失敗','取消','取代'])('%s 時釋放辨識工作的延遲撤銷網址',async outcome=>{
    const {startAsrWork,clearAsrSession}=await import('../src/speech-recognition-session.js');
    const original=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
    const revoke=vi.fn(NodeURL.revokeObjectURL.bind(NodeURL));
    Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revoke});
    const url=NodeURL.createObjectURL(new NodeBlob(['source']));Media.objectURLs.push(url);
    let finish,fail;
    const work=startAsrWork({clips:[{id:'a',in:0,out:1}]},{
      extractAudio:async()=>({duration:1}),
      transcribe:()=>new Promise((resolve,reject)=>{finish=resolve;fail=reject;}),
      commit:()=>({count:0}),releaseResources:Media.retainObjectURLs([url]),
    });
    try{
      await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
      Media.reset();expect(await (await fetch(url)).text()).toBe('source');
      if(outcome==='完成')finish([]);
      if(outcome==='失敗')fail(new Error('decode failed'));
      if(outcome==='取消')work.cancel();
      if(outcome==='取代')startAsrWork({clips:[]},{extractAudio:()=>{},transcribe:()=>{},commit:()=>0});
      if(outcome==='取消'||outcome==='取代'){
        await expect(fetch(url)).rejects.toThrow(); // provider 不回應也必須立刻釋放
        finish([]);
      }
      if(outcome==='失敗')await expect(work.promise).rejects.toThrow('decode failed');
      else await work.promise;
      await expect(fetch(url)).rejects.toThrow();
      expect(revoke.mock.calls).toEqual([[url]]);
    }finally{
      clearAsrSession();NodeURL.revokeObjectURL(url);
      if(original)Object.defineProperty(URL,'revokeObjectURL',original);else delete URL.revokeObjectURL;
    }
  });
});
