// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock=vi.hoisted(()=>({
  tracks:[],
  externalAudioSources:[],
  getExternalAudioSources(){ return this.externalAudioSources; }
}));

// subio.js also pulls in timeline.js, which imports Wave alongside Media.
vi.mock('../src/media.js',()=>({Media:mediaMock,Wave:{}}));
vi.mock('../src/ui.js',()=>({
  setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()
}));
vi.mock('../src/substyle.js',()=>({ASS_PLAY_RES:{x:1920,y:1080}}));
vi.mock('../src/subtitles.js',()=>({snapAllCuesToFrames:vi.fn(),sortCues:vi.fn()}));
vi.mock('../src/history.js',()=>({recordHistory:vi.fn()}));
vi.mock('../src/timeline.js',()=>({drawTimeline:vi.fn(),layoutTimeline:vi.fn()}));
vi.mock('../src/project.js',()=>({Project:{}}));
vi.mock('../src/tcparse.js',()=>({parseTimecodeInput:vi.fn()}));
vi.mock('../src/notes.js',()=>({getNotesGeneralFileData:vi.fn(),getNotesEdiusFileData:vi.fn()}));

import { State, ensureAudioBusCount, ensureAudioSourceMap, resetAudioProject } from '../src/state.js';
import { _buildExportData, _buildProjectAudioPlan } from '../src/subio.js';

describe('external audio project export plan',()=>{
  beforeEach(()=>{
    resetAudioProject();
    State.clips=[];
    ensureAudioBusCount(2);
    ensureAudioSourceMap('asset-external',[
      {sourceStream:0,sourceChannel:0},
      {sourceStream:0,sourceChannel:1}
    ]);
    const ids=State.audioProject.buses.map(bus=>bus.id);
    State.audioProject.sourceMaps['asset-external'].channels[0].busIds=[ids[0]];
    State.audioProject.sourceMaps['asset-external'].channels[1].busIds=[ids[1]];
    State.audioProject.exportLayout={streams:[{
      id:'program',name:'  外部主輸出  ',layout:'stereo',busIds:ids
    }]};
    mediaMock.tracks=[
      {file:'C:/cache/ext-ch1.m4a',audioSourceId:'asset-external',sourceStream:0,sourceChannel:0,muted:false,solo:false,volume:1},
      {file:'C:/cache/ext-ch2.m4a',audioSourceId:'asset-external',sourceStream:0,sourceChannel:1,muted:false,solo:false,volume:1}
    ];
    mediaMock.externalAudioSources=[{
      id:'external:asset-external',kind:'external-audio',name:'Music',audioSourceId:'asset-external',
      audioSrc:'ext-asset-external',offset:10,in:3,out:8,duration:12,gain:0.5,fadeIn:1,fadeOut:2,enabled:true
    }];
  });

  it('places an external routed source on the timeline and preserves stream labels',()=>{
    const plan=_buildProjectAudioPlan([],mediaMock.getExternalAudioSources());

    expect(plan.buses[0].inputs).toEqual([{
      file:'C:/cache/ext-ch1.m4a',offset:10,trimStart:3,trimEnd:8,volume:0.5,fadeIn:1,fadeOut:2
    }]);
    expect(plan.buses[1].inputs).toEqual([{
      file:'C:/cache/ext-ch2.m4a',offset:10,trimStart:3,trimEnd:8,volume:0.5,fadeIn:1,fadeOut:2
    }]);
    expect(plan.streams).toEqual([{
      id:'program',name:'外部主輸出',layout:'stereo',busIds:State.audioProject.buses.map(bus=>bus.id)
    }]);
  });

  it('builds a WAV-capable audio-only export with the external placement duration',()=>{
    const data=_buildExportData();

    expect(data.audioOnly).toBe(true);
    expect(data.clips).toEqual([]);
    expect(data.duration).toBe(15);
    expect(data.audioPlan.buses.flatMap(bus=>bus.inputs)).toHaveLength(2);
  });

  it('keeps a muted external source in the exported timeline length without routing its sound',()=>{
    State.clips=[{id:'clip-video',path:'C:/source/video.mov',in:0,out:8,offset:0,vtrack:0}];
    mediaMock.externalAudioSources[0]={
      ...mediaMock.externalAudioSources[0],enabled:false,offset:20,in:2,out:7
    };

    const data=_buildExportData();

    expect(data.duration).toBe(25);
    expect(data.audioPlan.buses.flatMap(bus=>bus.inputs)).toHaveLength(0);
  });

  it('keeps a detached video picture but routes only its independent external audio',()=>{
    State.clips=[{
      id:'clip-video',path:'C:/source/video.mov',in:0,out:8,offset:0,vtrack:0,
      audioSourceId:'asset-video',audioDetached:true
    }];

    const data=_buildExportData();

    expect(data.audioOnly).toBe(false);
    expect(data.clips).toHaveLength(1);
    expect(data.clips[0].audio).toEqual([]);
    expect(data.audioPlan.buses.flatMap(bus=>bus.inputs)).toHaveLength(2);
  });

  it('reports unresolved routed sources instead of silently exporting silence',()=>{
    mediaMock.tracks=[];
    const plan=_buildProjectAudioPlan([],mediaMock.getExternalAudioSources());

    expect(plan.unresolvedSources).toEqual([
      {audioSourceId:'asset-external',name:'Music'}
    ]);
  });
});
