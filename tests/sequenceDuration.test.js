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
});
