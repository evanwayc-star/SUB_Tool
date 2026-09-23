import { describe, expect, it } from 'vitest';
import { SubtitlePreviewIndex } from '../src/subtitle-preview-index.js';

describe('subtitle preview interval index',()=>{
  it('matches the frame renderer for overlapping, unsorted and untimed cues while seeking both ways',()=>{
    const cues=[
      {id:'late',start:3,end:5,track:1},
      {id:'first',start:0,end:4,track:0},
      {id:'untimed',start:0,end:99,timed:false},
      {id:'overlap',start:2.04,end:3.04,track:0},
      {id:'short',start:3,end:3.04,track:1},
    ];
    const index=new SubtitlePreviewIndex(), fps=25;
    for(const frame of [0,50,75,76,125,10,74,120,0]){
      const expected=cues.filter(c=>c.timed!==false&&frame>=Math.round(c.start*fps)&&frame<Math.round(c.end*fps));
      expect(index.visibleAtFrame(cues,fps,frame)).toEqual(expected);
    }
  });

  it('preserves active-row preference and refreshes after an in-place edit',()=>{
    const cues=[
      {id:'a',start:0,end:10},
      {id:'b',start:2,end:8},
    ];
    const index=new SubtitlePreviewIndex();
    expect(index.activeAtTime(cues,25,3,1)).toEqual({cue:cues[1],index:1});
    expect(index.activeAtTime(cues,25,3,-1)).toEqual({cue:cues[0],index:0});
    cues[0].start=5;
    index.invalidate();
    expect(index.visibleAtFrame(cues,25,75)).toEqual([cues[1]]);
    expect(index.activeAtTime(cues,25,3,-1)).toEqual({cue:cues[1],index:1});
    cues.push({id:'c',start:0,end:1});
    expect(index.visibleAtFrame(cues,25,0)).toEqual([cues[2]]);
  });

  it('uses exact frame rounding for fractional rates',()=>{
    const fps=30000/1001;
    const cues=[{id:'edge',start:100/fps,end:102/fps}];
    const index=new SubtitlePreviewIndex();
    expect(index.visibleAtFrame(cues,fps,99)).toEqual([]);
    expect(index.visibleAtFrame(cues,fps,100)).toEqual(cues);
    expect(index.visibleAtFrame(cues,fps,102)).toEqual([]);
  });
});
