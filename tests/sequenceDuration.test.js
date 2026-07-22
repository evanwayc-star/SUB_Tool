import { beforeEach, describe, expect, it } from 'vitest';
import { State } from '../src/state.js';
import { Seq } from '../src/sequence.js';

describe('sequence duration with external audio',()=>{
  beforeEach(()=>{
    State.clips=[];
    State.cues=[];
    State.duration=0;
    State.externalAudioEnd=0;
  });

  it('does not shorten the timeline below an external audio placement when video changes',()=>{
    State.clips=[{id:'video-a',in:0,out:5,offset:0,vtrack:0}];
    State.externalAudioEnd=18;

    Seq.recomputeDuration();
    expect(State.duration).toBe(18);

    State.clips=[];
    Seq.recomputeDuration();
    expect(State.duration).toBe(18);
  });

  it('restores image size and position from a sequence history snapshot',()=>{
    State.clips=[{
      id:'image-a',type:'image',path:'C:/source/card.png',dur:36000,
      in:0,out:6,offset:2,vtrack:1,scale:0.35,posX:0.25,posY:0.75
    }];
    const snapshot=Seq.snapshot();

    State.clips[0].scale=1;
    State.clips[0].posX=0.5;
    State.clips[0].posY=0.5;
    Seq.restore(snapshot);

    expect(State.clips[0]).toMatchObject({
      type:'image',scale:0.35,posX:0.25,posY:0.75
    });
  });
});
