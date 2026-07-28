// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const ExportPlan=createRequire(import.meta.url)('../electron/export-plan.js');

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
vi.mock('../src/substyle.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, ASS_PLAY_RES:{x:1920,y:1080} };
});
vi.mock('../src/subtitles.js',()=>({snapAllCuesToFrames:vi.fn(),sortCues:vi.fn()}));
vi.mock('../src/history.js',()=>({recordHistory:vi.fn()}));
vi.mock('../src/timeline.js',()=>({drawTimeline:vi.fn(),layoutTimeline:vi.fn()}));
vi.mock('../src/project.js',()=>({Project:{}}));
vi.mock('../src/tcparse.js',()=>({parseTimecodeInput:vi.fn()}));
vi.mock('../src/notes.js',()=>({getNotesGeneralFileData:vi.fn(),getNotesEdiusFileData:vi.fn()}));
vi.mock('../src/audio-routing.js',()=>({AudioRouting:{openOutputSettings:vi.fn()}}));

import { State, ensureAudioBusCount, ensureAudioSourceMap, resetAudioProject } from '../src/state.js';
import { _buildExportData, _buildProjectAudioPlan, _composeDeliveryAudioPlan } from '../src/subio.js';

describe('external audio project export plan',()=>{
  beforeEach(()=>{
    resetAudioProject();
    State.clips=[];
    State.cues=[];
    State.exportIn=null;
    State.exportOut=null;
    State.externalAudioEnd=0;
    State.externalAudioState=[];
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
      audioSrc:'ext-asset-external',path:'C:/master/music.wav',offset:10,in:3,out:8,duration:12,gain:0.5,fadeIn:1,fadeOut:2,enabled:true
    }];
  });

  it('places an external routed source on the timeline directly from its master and preserves stream labels',()=>{
    const plan=_buildProjectAudioPlan([],mediaMock.getExternalAudioSources());

    expect(plan.buses[0].inputs).toEqual([{
      file:'C:/master/music.wav',sourceStream:0,sourceChannel:0,
      offset:10,trimStart:3,trimEnd:8,volume:0.5,fadeIn:1,fadeOut:2
    }]);
    expect(plan.buses[1].inputs).toEqual([{
      file:'C:/master/music.wav',sourceStream:0,sourceChannel:1,
      offset:10,trimStart:3,trimEnd:8,volume:0.5,fadeIn:1,fadeOut:2
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

  it('passes static-image identity and per-clip geometry to the ffmpeg export plan',()=>{
    mediaMock.externalAudioSources=[];
    State.clips=[{
      id:'clip-image',type:'image',name:'Card',path:'C:/source/card.png',dur:36000,
      in:0,out:8,offset:3,vtrack:2,scale:0.42,posX:0.2,posY:0.8
    }];

    const data=_buildExportData();

    expect(data.duration).toBe(11);
    expect(data.clips).toEqual([expect.objectContaining({
      path:'C:/source/card.png',type:'image',in:0,out:8,offset:3,vtrack:2,
      scale:0.42,posX:0.2,posY:0.8
    })]);
  });

  it('keeps the original export In point for delivery metadata after slicing the timeline',()=>{
    mediaMock.externalAudioSources=[];
    State.clips=[{
      id:'clip-image',type:'image',path:'C:/source/card.png',dur:36000,
      in:0,out:20,offset:0,vtrack:0
    }];
    State.exportIn=4;
    State.exportOut=12;

    const data=_buildExportData();

    expect(data.timelineStart).toBe(4);
    expect(data.duration).toBe(8);
    expect(data.clips[0]).toMatchObject({in:4,out:12,offset:0});
  });

  it('reports unresolved routed sources instead of silently exporting silence',()=>{
    mediaMock.externalAudioSources[0]={...mediaMock.externalAudioSources[0],path:null};
    const plan=_buildProjectAudioPlan([],mediaMock.getExternalAudioSources());

    expect(plan.unresolvedSources).toEqual([
      {audioSourceId:'asset-external',name:'Music'}
    ]);
  });

  it('uses the video master in the legacy mixer fallback, never its AAC preview cache',()=>{
    resetAudioProject();
    mediaMock.externalAudioSources=[];
    State.clips=[{
      id:'clip-master',path:'C:/master/program.mxf',in:2,out:8,offset:4,vtrack:0,
      audioSrc:'clip:clip-master',audioSourceId:'asset-video'
    }];
    mediaMock.tracks=[{
      file:'C:/cache/program-ch3.m4a',source:'clip:clip-master',audioSourceId:'asset-video',
      sourceStream:1,sourceChannel:2,kind:'element',muted:false,solo:false,volume:0.75
    }];

    const data=_buildExportData();

    expect(data.audioPlan).toBeNull();
    expect(data.clips[0].audio).toEqual([{
      file:'C:/master/program.mxf',sourceStream:1,sourceChannel:2,volume:0.75
    }]);
  });

  it('keeps compiled A7/A8 source inputs when restoring a Stereo delivery record',()=>{
    const compiled={
      buses:Array.from({length:8},(_,index)=>({
        id:`a${index+1}`,
        inputs:[{
          file:'C:/master/program.mxf',sourceStream:0,sourceChannel:index,
          offset:0,trimStart:0,trimEnd:10,volume:1,fadeIn:0,fadeOut:0
        }]
      })),
      streams:[{id:'all-mono',layout:'mono',busIds:['a1']}]
    };
    const deliveryRecord={
      audioBuses:compiled.buses.map(bus=>({id:bus.id,name:bus.id,muted:false,solo:false,volume:1})),
      audioPlan:{streams:[{id:'program',layout:'stereo',busIds:['a7','a8']}]}
    };

    const finalPlan=_composeDeliveryAudioPlan(compiled,deliveryRecord);
    const normalized=ExportPlan._normalizeAudioPlan(finalPlan);
    const inputs=[];
    const filtergraph=[];
    ExportPlan._buildPlannedAudio(normalized,inputs,filtergraph,0,10);

    expect(finalPlan.buses[6].inputs[0]).toMatchObject({sourceChannel:6});
    expect(finalPlan.buses[7].inputs[0]).toMatchObject({sourceChannel:7});
    expect(finalPlan.streams).toEqual([{id:'program',layout:'stereo',busIds:['a7','a8']}]);
    expect(inputs).toEqual(['-i','C:/master/program.mxf']);
    expect(filtergraph.join('\n')).toContain('pan=mono|c0=c6');
    expect(filtergraph.join('\n')).toContain('pan=mono|c0=c7');
    expect(filtergraph.join('\n')).toContain('[apB6][apB7]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR');
    expect(filtergraph.join('\n')).not.toContain('anullsrc');
  });

  it('uses an explicitly configured WAV bus subset in its selected order',()=>{
    const compiled={
      buses:Array.from({length:8},(_,index)=>({
        id:`a${index+1}`,
        inputs:[{
          file:'C:/master/program.mxf',sourceStream:0,sourceChannel:index,
          offset:0,trimStart:0,trimEnd:10,volume:1,fadeIn:0,fadeOut:0
        }]
      })),
      streams:[{id:'all-mono',layout:'mono',busIds:['a1']}]
    };
    const deliveryRecord={
      format:'wav',
      audioBuses:compiled.buses.map(bus=>({id:bus.id,name:bus.id,muted:false,solo:false,volume:1})),
      wavBusIds:['a7','a8'],
      audioPlan:{streams:[{id:'program',layout:'stereo',busIds:['a7','a8']}]}
    };

    const finalPlan=_composeDeliveryAudioPlan(compiled,deliveryRecord);
    const normalized=ExportPlan._normalizeAudioPlan(finalPlan,{requireStreams:false});
    const inputs=[];
    const filtergraph=[];
    const planned=ExportPlan._buildPlannedAudio(normalized,inputs,filtergraph,0,10);
    const wav=ExportPlan._buildWavOutput(planned.busLabels,normalized,filtergraph);

    expect(finalPlan.buses.map(bus=>bus.id)).toEqual(['a7','a8']);
    expect(wav.channels).toBe(2);
    expect(inputs).toEqual(['-i','C:/master/program.mxf']);
    expect(filtergraph.join('\n')).toContain('pan=mono|c0=c6');
    expect(filtergraph.join('\n')).toContain('pan=mono|c0=c7');
    expect(filtergraph.join('\n')).toContain('join=inputs=2:channel_layout=FL+FR');
    expect(filtergraph.join('\n')).not.toContain('anullsrc');
  });
});
