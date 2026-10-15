// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ElementPlacementPlayback} from '../src/audio-placement-playback.js';
import {getPlayerAdapter,resetPlayerAdapter} from '../src/media-player-adapter.js';

describe('overlapping element placements with a late MOV duration',()=>{
  let owner,track,clip,playback,element,tracks,muted;
  beforeEach(()=>{
    const source={src:'subtool-local://source/origin-five.mov'};
    getPlayerAdapter().registerSourceClock(source.src,{timestampOffset:-.5,presentationTimestampOffset:-5.5});
    track={kind:'element',el:source};tracks=[track];muted=false;
    clip={in:0,out:3,offset:0,speed:1,fadeIn:.1};playback={clip,sourceTime:2.8,rate:1};
    element=new EventTarget();Object.assign(element,{duration:3.5,readyState:1,paused:true});
    let current=0;Object.defineProperty(element,'currentTime',{get:()=>current,set:value=>{current=Math.min(value,element.duration);}});
    element.play=vi.fn(()=>{element.paused=false;return Promise.resolve();});element.pause=vi.fn(()=>{element.paused=true;});
    const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
    owner=new ElementPlacementPlayback({createMediaElementSource:node,createChannelSplitter:node},{
      environment:()=>({tracks:()=>tracks,timelineTime:()=>0,transportMuted:()=>muted}),
      playbacks:()=>playback?[playback]:[],gainFor:()=>node(),createAudio:()=>element,
    });
    expect(owner.element(track,playback,[playback])).toBe(element);
  });
  afterEach(()=>{owner.clear();resetPlayerAdapter(null);});
  const expand=async element=>{element.duration=8.5;element.dispatchEvent(new Event('durationchange'));await Promise.resolve();await Promise.resolve();};

  it('starts a detached placement only at its mapped raw source position',async()=>{
    owner.start(element,0);expect(element.currentTime).toBe(3.5);expect(element.play).not.toHaveBeenCalled();
    await expand(element);expect(element.currentTime).toBe(8.3);expect(element.play).toHaveBeenCalledOnce();
  });
  it('keeps only the latest pending placement position',async()=>{
    playback.sourceTime=0;owner.start(element,0);playback.sourceTime=2.8;owner.sync(0);
    await expand(element);expect(element.currentTime).toBe(8.3);expect(element.play).toHaveBeenCalledOnce();
  });
  it.each(['stop','release','replace','remove','hide','mute','gap'])('%s invalidates a pending detached voice',async action=>{
    owner.start(element,0);
    if(action==='stop')owner.stop();
    if(action==='release')owner.release(track.el,clip);
    if(action==='replace')track.el.src='subtool-local://source/replaced.mov';
    if(action==='remove')tracks=[];
    if(action==='hide')track._srcHidden=true;
    if(action==='mute')muted=true;
    if(action==='gap')playback=null;
    await expand(element);expect(element.play).not.toHaveBeenCalled();
    if(action==='stop'||action==='release')expect(element.currentTime).toBe(3.5);
  });
});
