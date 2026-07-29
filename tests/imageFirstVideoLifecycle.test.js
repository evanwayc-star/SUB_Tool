// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const domMock=vi.hoisted(()=>{
  const video={style:{},playbackRate:1,hasAttribute:()=>false};
  const elements=new Map();
  return {
    video,
    $(id){
      if(!elements.has(id)) elements.set(id,{style:{},textContent:'',classList:{add:vi.fn(),remove:vi.fn()}});
      return elements.get(id);
    }
  };
});

vi.mock('../src/dom.js',()=>domMock);
vi.mock('../src/events.js',()=>({emit:vi.fn(),on:vi.fn()}));
vi.mock('../src/ui.js',()=>({setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/mixer.js',()=>({renderAudioTracks:vi.fn(),clearMeterStrips:vi.fn()}));
vi.mock('../src/timeline.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));

import { State } from '../src/state.js';
import { Media } from '../src/media.js';
import { ProjectLoadSession } from '../src/project-load-session.js';

describe('first video after image-only timeline',()=>{
  beforeEach(()=>{
    State.clips=[{
      id:'image-a',type:'image',name:'Card',path:'C:/source/card.png',web:{url:'blob:image-a'},
      dur:36000,in:0,out:8,offset:3,vtrack:1,scale:0.4,posX:0.2,posY:0.8
    }];
    State.videoTracks=[
      {name:'視訊軌 1',visible:true,locked:false},
      {name:'圖片',visible:true,locked:true,opacity:0.7}
    ];
    State.cues=[];
    State.externalAudioEnd=0;
    Media.objectURLs=['blob:image-a'];
    Media.tracks=[];
    Media.externalAudioSources=[];
    Media._preservedImageTimeline=null;
    Media.activeClipId=null;
    Media.playing=false;
  });

  it('keeps existing image clips and their object URLs when the first video is registered',()=>{
    expect(Media._resetForFirstVideo()).toBe(true);
    expect(State.clips).toEqual([]);
    expect(Media.objectURLs).toEqual(['blob:image-a']);

    Media._registerPrimary({id:'video-a',name:'Program',path:'C:/source/program.mov',dur:12,fps:25});

    expect(State.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({id:'video-a',primary:true}),
      expect.objectContaining({id:'image-a',type:'image',offset:3,out:8,vtrack:1,scale:0.4,posX:0.2,posY:0.8})
    ]));
    expect(State.videoTracks[1]).toMatchObject({name:'圖片',locked:true,opacity:0.7});
  });

  it('takes project restore identity from an explicit plan instead of State',()=>{
    const session=new ProjectLoadSession();
    const generation=session.begin();
    const plan=session.createRestorePlan(generation,{
      mediaRelink:true,
      clips:[{
        id:'saved-primary',primary:true,path:'C:/source/program.mov',dur:12,
        in:2,out:10,offset:4,vtrack:1,audioSourceId:'project-primary'
      }]
    });

    Media._resetForFirstVideo();
    const primary=Media._registerPrimary({id:'runtime-primary',name:'Program',path:'C:/source/program.mov',dur:12,fps:25},plan);

    expect(primary).toMatchObject({primary:true,audioSourceId:'project-primary'});
    expect(plan.pendingClips()).toEqual([]);
    expect(State).not.toHaveProperty('_pendingClips');
  });
});
