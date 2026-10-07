import { beforeEach, describe, expect, it } from 'vitest';
import { State, resetAudioProject, ensureAudioBusCount, ensureAudioSourceMap } from '../src/state.js';
import { Seq } from '../src/sequence.js';
import { visualStackPlan, imageSourceUrl } from '../src/image-compositor-engine.js';
import { buildProjectAudioPlan } from '../src/project-audio.js';
import { fixedFrameTime, lastSourceFrameIndex } from '../shared/clip-visual.cjs';

beforeEach(()=>{State.clips=[];State.videoTracks=[{visible:true},{visible:true}];State.cues=[];State.externalAudioEnd=0;});

describe('固定畫面的視覺來源與剪輯時間分離',()=>{
  it.each([[2.033333,60],[2.066667,61]])('微秒捨入的 %s 秒來源仍停在最後實際影格 %s', (duration,index)=>{
    expect(lastSourceFrameIndex(duration,30)).toBe(index);
  });
  it('固定0秒仍有效，靜態層不接管播放器，其他影片仍按軌道合成',()=>{
    const fixed={id:'fixed',path:'source.mp4',in:2,out:8,dur:10,offset:3,vtrack:0,speed:2,freezeTime:0,freezeWeb:{url:'blob:frame'}};
    const moving={id:'moving',path:'second.mp4',in:0,out:3,dur:3,offset:3,vtrack:1};
    State.clips=[fixed,moving];
    expect(fixedFrameTime(fixed)).toBe(0);expect(fixedFrameTime({freezeTime:null})).toBeNull();
    expect(fixedFrameTime({freezeTime:-1})).toBeNull();
    expect(Seq.len(fixed)).toBe(3);expect(Seq.toSource(4,fixed)).toBe(4);
    expect(Seq.clipAt(4)).toBe(moving);
    expect(imageSourceUrl(fixed)).toBe('blob:frame');
    const plan=visualStackPlan(Seq.clipsAt(4),State.videoTracks);
    expect(plan.images.map(c=>c.id)).toEqual(['fixed']);expect(plan.videos.map(c=>c.id)).toEqual(['moving']);
    expect(plan.mixedImages).toBe(true);expect(plan.needsComposite).toBe(true);
    expect(fixed.type).toBeUndefined();expect(fixed.path).toBe('source.mp4');
    State.clips=[fixed];expect(Seq.clipAt(4)).toBeNull();expect(Seq.nextAfter(0)).toBeNull();
  });
  it('切割固定段沿用原固定來源幀，即使來源幀落在新修剪區間之外',()=>{
    const fixed={id:'fixed',path:'source.mp4',in:0,out:8,dur:10,offset:3,vtrack:0,speed:2,freezeTime:1};
    State.clips=[fixed];
    const split=Seq.planSplit(fixed,5);
    expect(split.left.out).toBe(4);expect(split.right).toMatchObject({in:4,out:8,offset:5,freezeTime:1,speed:2});
    const snapshot=Seq.snapshot();expect(snapshot[0]).toMatchObject({freezeTime:1});
    expect(snapshot[0]).not.toHaveProperty('freezeWeb');
    Seq.restore([{...snapshot[0],freezeTime:0}]);expect(Seq.byId('fixed').freezeTime).toBe(0);
    const normal={...snapshot[0]};delete normal.freezeTime;Seq.restore([normal]);expect(Seq.byId('fixed').freezeTime).toBeUndefined();
  });
  it('固定段原音從交付配線排除，正常同來源段仍可發聲',()=>{
    resetAudioProject();ensureAudioBusCount(1);ensureAudioSourceMap('source-id',[{sourceStream:0,sourceChannel:0}]);
    const source={path:'source.mp4',audioSrc:'video',audioSourceId:'source-id',primary:true,in:0,out:3,offset:0};
    const plan=buildProjectAudioPlan({audioProject:State.audioProject,clips:[{...source,freezeTime:0},{...source,offset:3}],mediaTracks:[{source:'video',audioSourceId:'source-id',file:'source.mp4',sourceStream:0,sourceChannel:0,volume:1}]});
    const inputs=plan.buses.flatMap(bus=>bus.inputs);
    expect(inputs).not.toHaveLength(0);expect(inputs.every(input=>input.offset===3)).toBe(true);
  });
});
