// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AudioEngine,createAudioEngineForTest,destroyScrubber} from '../src/audio-engine.js';
import {MediaAudioRouter} from '../src/audio-routing-engine.js';
import {createMediaPresentationSession} from '../src/media-presentation-core.js';

let source,clone,engine,completePlay;
beforeEach(()=>{
  source={tagName:'AUDIO',src:'file:///audio.wav',duration:10,pause:vi.fn(),play:vi.fn(),readyState:1};
  clone={src:'',readyState:0,play:vi.fn(()=>new Promise(resolve=>{completePlay=resolve;})),pause:vi.fn(),currentTime:0};
  vi.spyOn(document,'createElement').mockReturnValue(clone);
  engine=createAudioEngineForTest({createContext:()=>({})});
  engine.bind({tracks:()=>[{kind:'element',el:source}]});
});
afterEach(()=>{engine.stopScrubs();AudioEngine.stopScrubs();destroyScrubber(source);AudioEngine.bind();vi.restoreAllMocks();});

describe('audio transport owns detached scrub voices',()=>{
  it.each(['stopElements','stopBuffers','startElements','startBuffers'])('%s取消尚未收到metadata的scrub',async action=>{
    engine.scrub(3);
    const lateMetadata=clone.onloadedmetadata;
    expect(lateMetadata).toBeTypeOf('function');
    engine[action](4,4);
    lateMetadata();
    await Promise.resolve();
    expect(clone.play).not.toHaveBeenCalled();
  });
  it('停止後舊play Promise不能重新啟動pending；新逐格scrub仍可使用同clone',async()=>{
    engine.scrub(1);clone.onloadedmetadata();
    const oldPlay=completePlay;
    engine.scrub(2);
    engine.stopElements();
    oldPlay();await Promise.resolve();await Promise.resolve();
    expect(clone.play).toHaveBeenCalledOnce();
    clone.readyState=1;
    engine.scrub(4);
    expect(clone.play).toHaveBeenCalledTimes(2);
    expect(clone.currentTime).toBe(4);
  });
  it('新聲音啟動後舊play Promise才結束，也不可留下會暫停新聲音的timer',async()=>{
    vi.useFakeTimers();
    try{
      engine.scrub(1);clone.onloadedmetadata();
      const oldPlay=completePlay;
      engine.stopElements();
      clone.readyState=1;engine.scrub(4);
      clone.pause.mockClear();
      oldPlay();await Promise.resolve();await Promise.resolve();
      vi.advanceTimersByTime(200);
      expect(clone.play).toHaveBeenCalledTimes(2);
      expect(clone.pause).not.toHaveBeenCalled();
    }finally{vi.useRealTimers();}
  });
  it('主video fallback scrub也由router的停止入口取消',()=>{
    source.tagName='VIDEO';source.playbackRate=1;
    const media={tracks:[],seqOn:()=>false,playing:false,activeSource:'video',tlTime:()=>0,applyGains:vi.fn(),projectAudioInterpretation:()=>({trackState:()=>({audible:true,gain:1})})};
    const router=new MediaAudioRouter(media,source,{muted:false});
    router.bindEngine();
    router.scrubAudio(3);
    const lateMetadata=clone.onloadedmetadata;
    router.stopElementSources();
    lateMetadata();
    expect(clone.play).not.toHaveBeenCalled();
  });
  it.each(['request','requestPlayback'])('已暫停的%s也取消舊scrub，不必再次起播才失效',async entry=>{
    engine.scrub(1);
    const lateMetadata=clone.onloadedmetadata;
    const session=createMediaPresentationSession({
      getTolerance:()=>0.05,
      timeline:{normalizeTarget:time=>time},
      player:{adapter:()=>({type:'html5',present:async time=>({presentedSourceTime:time})})},
      playback:{cancelScrubs:()=>engine.stopScrubs()},
      commitPresented:time=>time,
    });
    await session[entry](5);
    lateMetadata();
    expect(clone.play).not.toHaveBeenCalled();
  });
  it('停止buffer transport同時停止短促buffer聲音',()=>{
    const node={stop:vi.fn(),disconnect:vi.fn()};
    const track={kind:'buffer',_scrubNode:node};
    engine.bind({tracks:()=>[track]});
    engine.stopBuffers();
    expect(node.stop).toHaveBeenCalledOnce();expect(node.disconnect).toHaveBeenCalledOnce();
    expect(track._scrubNode).toBeNull();
  });
});
