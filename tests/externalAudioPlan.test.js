/* 匯出快照與專案音軌路由編譯（src/delivery-job.js）。

   【這個檔案的 mock 數量本身就是斷言】
   這些測試以前要先 vi.mock 掉 media／ui／substyle／subtitles／history／timeline／
   project／tcparse／notes／audio-routing 共十個模組，還得跑在 jsdom 底下——不是因為
   被測的邏輯需要它們，而是因為它撞在 subio.js 裡，而 subio.js 有 21 個 import。
   為了讓測試構得到那些純函式，subio.js 的對外清單上還被迫多掛五個底線名稱。

   邏輯搬進 delivery-job.js（不 import State／Media／Seq，也不碰 DOM）之後：
   零個 vi.mock、零個 jsdom。**如果哪天這個檔案又需要 mock 了，那是接縫破掉的信號，
   不是測試該遷就的事。**

   對應 CONTEXT.md「匯出工作」「母素材／Proxy」與 docs/技術架構說明.md §0.8。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import { State, ensureAudioBusCount, ensureAudioSourceMap, resetAudioProject } from '../src/state.js';
import { Seq } from '../src/sequence.js';
import { buildExportSnapshot, buildProjectAudioPlan } from '../src/delivery-job.js';
import { createProjectAudioInterpretation } from '../src/project-audio.js';
import { composeDeliveryAudioPlan } from '../src/delivery-audio.js';

const ExportPlan = createRequire(import.meta.url)('../electron/export-plan.js');

/* 呼叫端在正式程式裡是 subio.js 的 _exportSnapshot()：把 State／Media／Seq 交給模組。
   測試裡由這兩個小工具扮演同一個角色，Media 只是一組普通陣列。 */
let mediaTracks = [];
let liveExternalSources = [];

const snapshot = () => buildExportSnapshot({
  state: State,
  mediaTracks,
  liveExternalSources,
  sequenceEnd: Seq.end(),
});

const audioPlan = (clips = [], externalSources = liveExternalSources) => buildProjectAudioPlan({
  audioProject: State.audioProject,
  mediaTracks,
  clips,
  externalSources,
});

describe('external audio project export plan', () => {
  beforeEach(() => {
    resetAudioProject();
    State.clips = [];
    State.cues = [];
    State.exportIn = null;
    State.exportOut = null;
    State.externalAudioEnd = 0;
    State.externalAudioState = [];
    State.videoTracks = [];
    ensureAudioBusCount(2);
    ensureAudioSourceMap('asset-external', [
      { sourceStream: 0, sourceChannel: 0 },
      { sourceStream: 0, sourceChannel: 1 },
    ]);
    const ids = State.audioProject.buses.map(bus => bus.id);
    State.audioProject.sourceMaps['asset-external'].channels[0].busIds = [ids[0]];
    State.audioProject.sourceMaps['asset-external'].channels[1].busIds = [ids[1]];
    State.audioProject.exportLayout = { streams: [{
      id: 'program', name: '  外部主輸出  ', layout: 'stereo', busIds: ids,
    }] };
    mediaTracks = [
      { file: 'C:/cache/ext-ch1.m4a', audioSourceId: 'asset-external', sourceStream: 0, sourceChannel: 0, muted: false, solo: false, volume: 1 },
      { file: 'C:/cache/ext-ch2.m4a', audioSourceId: 'asset-external', sourceStream: 0, sourceChannel: 1, muted: false, solo: false, volume: 1 },
    ];
    liveExternalSources = [{
      id: 'external:asset-external', kind: 'external-audio', name: 'Music', audioSourceId: 'asset-external',
      audioSrc: 'ext-asset-external', path: 'C:/master/music.wav', offset: 10, in: 3, out: 8, duration: 12, gain: 0.5, fadeIn: 1, fadeOut: 2, enabled: true,
    }];
  });

  it('places an external routed source on the timeline directly from its master and preserves stream labels', () => {
    const plan = audioPlan();

    expect(plan.buses[0].inputs).toEqual([{
      file: 'C:/master/music.wav', sourceStream: 0, sourceChannel: 0,
      offset: 10, trimStart: 3, trimEnd: 8, volume: 0.5, fadeIn: 1, fadeOut: 2,
    }]);
    expect(plan.buses[1].inputs).toEqual([{
      file: 'C:/master/music.wav', sourceStream: 0, sourceChannel: 1,
      offset: 10, trimStart: 3, trimEnd: 8, volume: 0.5, fadeIn: 1, fadeOut: 2,
    }]);
    expect(plan.streams).toEqual([{
      id: 'program', name: '外部主輸出', layout: 'stereo', busIds: State.audioProject.buses.map(bus => bus.id),
    }]);
  });

  it('builds a WAV-capable audio-only export with the external placement duration', () => {
    const data = snapshot();

    expect(data.audioOnly).toBe(true);
    expect(data.clips).toEqual([]);
    expect(data.duration).toBe(15);
    expect(data.audioPlan.buses.flatMap(bus => bus.inputs)).toHaveLength(2);
  });

  it('keeps a muted external source in the exported timeline length without routing its sound', () => {
    State.clips = [{ id: 'clip-video', path: 'C:/source/video.mov', in: 0, out: 8, offset: 0, vtrack: 0 }];
    liveExternalSources[0] = { ...liveExternalSources[0], enabled: false, offset: 20, in: 2, out: 7 };

    const data = snapshot();

    expect(data.duration).toBe(25);
    expect(data.audioPlan.buses.flatMap(bus => bus.inputs)).toHaveLength(0);
  });

  it('keeps a detached video picture but routes only its independent external audio', () => {
    State.clips = [{
      id: 'clip-video', path: 'C:/source/video.mov', in: 0, out: 8, offset: 0, vtrack: 0,
      audioSourceId: 'asset-video', audioDetached: true,
    }];

    const data = snapshot();

    expect(data.audioOnly).toBe(false);
    expect(data.clips).toHaveLength(1);
    expect(data.clips[0].audio).toEqual([]);
    expect(data.audioPlan.buses.flatMap(bus => bus.inputs)).toHaveLength(2);
  });

  it('passes static-image identity and per-clip geometry to the ffmpeg export plan', () => {
    liveExternalSources = [];
    State.clips = [{
      id: 'clip-image', type: 'image', name: 'Card', path: 'C:/source/card.png', dur: 36000,
      in: 0, out: 8, offset: 3, vtrack: 2, scale: 0.42, posX: 0.2, posY: 0.8,
    }];

    const data = snapshot();

    expect(data.duration).toBe(11);
    expect(data.clips).toEqual([expect.objectContaining({
      path: 'C:/source/card.png', type: 'image', in: 0, out: 8, offset: 3, vtrack: 2,
      scale: 0.42, posX: 0.2, posY: 0.8,
    })]);
  });

  it('keeps the original export In point for delivery metadata after slicing the timeline', () => {
    liveExternalSources = [];
    State.clips = [{
      id: 'clip-image', type: 'image', path: 'C:/source/card.png', dur: 36000,
      in: 0, out: 20, offset: 0, vtrack: 0,
    }];
    State.exportIn = 4;
    State.exportOut = 12;

    const data = snapshot();

    expect(data.timelineStart).toBe(4);
    expect(data.duration).toBe(8);
    expect(data.clips[0]).toMatchObject({ in: 4, out: 12, offset: 0 });
  });

  it('reports unresolved routed sources instead of silently exporting silence', () => {
    liveExternalSources[0] = { ...liveExternalSources[0], path: null };
    const plan = audioPlan();

    expect(plan.unresolvedSources).toEqual([
      { audioSourceId: 'asset-external', name: 'Music' },
    ]);
  });

  it('uses the video master in the legacy mixer fallback, never its AAC preview cache', () => {
    resetAudioProject();
    liveExternalSources = [];
    State.clips = [{
      id: 'clip-master', path: 'C:/master/program.mxf', in: 2, out: 8, offset: 4, vtrack: 0,
      audioSrc: 'clip:clip-master', audioSourceId: 'asset-video',
    }];
    mediaTracks = [{
      file: 'C:/cache/program-ch3.m4a', source: 'clip:clip-master', audioSourceId: 'asset-video',
      sourceStream: 1, sourceChannel: 2, kind: 'element', muted: false, solo: false, volume: 0.75,
    }];

    const data = snapshot();

    expect(data.audioPlan).toBeNull();
    expect(data.clips[0].audio).toEqual([{
      file: 'C:/master/program.mxf', sourceStream: 1, sourceChannel: 2, volume: 0.75,
    }]);
  });

  it('applies source-channel Solo globally in preview and delivery, not once per mother source', () => {
    resetAudioProject();
    ensureAudioBusCount(2);
    const [a1, a2] = State.audioProject.buses.map(bus => bus.id);
    ensureAudioSourceMap('source-a', [{ sourceStream: 0, sourceChannel: 0 }]);
    ensureAudioSourceMap('source-b', [{ sourceStream: 0, sourceChannel: 0 }]);
    State.audioProject.sourceMaps['source-a'].channels[0].busIds = [a1];
    State.audioProject.sourceMaps['source-b'].channels[0].busIds = [a2];
    State.audioProject.exportLayout = { streams: [
      { id: 'a', layout: 'mono', busIds: [a1] },
      { id: 'b', layout: 'mono', busIds: [a2] },
    ] };
    mediaTracks = [
      // 原生 Stereo 會先建立控制軌，逐聲道 cache 稍後才完成；Solo/Mute 不得依賴 file。
      { audioSourceId: 'source-a', sourceStream: 0, sourceChannel: 0, muted: false, solo: true, volume: 1 },
      { audioSourceId: 'source-b', sourceStream: 0, sourceChannel: 0, muted: false, solo: false, volume: 1 },
    ];
    const clips = [
      { name: 'A', path: 'C:/master/a.mov', audioSourceId: 'source-a', in: 0, out: 5, offset: 0 },
      { name: 'B', path: 'C:/master/b.mov', audioSourceId: 'source-b', in: 0, out: 5, offset: 0 },
    ];

    const plan = audioPlan(clips, []);
    const preview = createProjectAudioInterpretation({
      audioProject: State.audioProject,
      mediaTracks,
      externalSources: [],
    });

    expect(preview.trackState(mediaTracks[0]).audible).toBe(true);
    expect(preview.trackState(mediaTracks[1]).audible).toBe(false);
    expect(plan.buses.find(bus => bus.id === a1).inputs).toHaveLength(1);
    expect(plan.buses.find(bus => bus.id === a2).inputs).toEqual([]);
  });

  /* 專案的 externalAudioState（可序列化）與 Media 目前實際持有的素材是兩份資料。
     runtime 有實體檔與最新編輯，優先採用；只存在於專案檔的那些仍要留著，
     否則檔案暫時離線時會靜默少掉一段音訊、總長也跟著縮短。 */
  it('merges the persisted external placements with the live ones, live winning on id', () => {
    State.externalAudioState = [
      { audioSourceId: 'asset-external', name: 'Music（專案檔）', path: 'C:/master/music.wav', offset: 0, in: 0, out: 4, enabled: true },
      { audioSourceId: 'asset-offline', name: 'Offline', path: 'C:/master/offline.wav', offset: 30, in: 0, out: 5, enabled: true },
    ];

    const data = snapshot();

    // live 的 asset-external（offset 10、長 5）覆蓋專案檔那筆，離線的 asset-offline 仍算進總長
    expect(data.duration).toBe(35);
  });
});

describe('交付編組（composeDeliveryAudioPlan）接上 export-plan 的 filtergraph', () => {
  it('keeps compiled A7/A8 source inputs when restoring a Stereo delivery record', () => {
    const compiled = {
      buses: Array.from({ length: 8 }, (_, index) => ({
        id: `a${index + 1}`,
        inputs: [{
          file: 'C:/master/program.mxf', sourceStream: 0, sourceChannel: index,
          offset: 0, trimStart: 0, trimEnd: 10, volume: 1, fadeIn: 0, fadeOut: 0,
        }],
      })),
      streams: [{ id: 'all-mono', layout: 'mono', busIds: ['a1'] }],
    };
    const deliveryRecord = {
      audioBuses: compiled.buses.map(bus => ({ id: bus.id, name: bus.id, muted: false, solo: false, volume: 1 })),
      audioPlan: { streams: [{ id: 'program', layout: 'stereo', busIds: ['a7', 'a8'] }] },
    };

    const finalPlan = composeDeliveryAudioPlan(compiled, deliveryRecord);
    const normalized = ExportPlan._normalizeAudioPlan(finalPlan);
    const inputs = [];
    const filtergraph = [];
    ExportPlan._buildPlannedAudio(normalized, inputs, filtergraph, 0, 10);

    expect(finalPlan.buses[6].inputs[0]).toMatchObject({ sourceChannel: 6 });
    expect(finalPlan.buses[7].inputs[0]).toMatchObject({ sourceChannel: 7 });
    expect(finalPlan.streams).toEqual([{ id: 'program', layout: 'stereo', busIds: ['a7', 'a8'] }]);
    expect(inputs).toEqual(['-i', 'C:/master/program.mxf']);
    expect(filtergraph.join('\n')).toContain('pan=mono|c0=c6');
    expect(filtergraph.join('\n')).toContain('pan=mono|c0=c7');
    expect(filtergraph.join('\n')).toContain('[apB6][apB7]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR');
    expect(filtergraph.join('\n')).not.toContain('anullsrc');
  });

  it('uses an explicitly configured WAV bus subset in its selected order', () => {
    const compiled = {
      buses: Array.from({ length: 8 }, (_, index) => ({
        id: `a${index + 1}`,
        inputs: [{
          file: 'C:/master/program.mxf', sourceStream: 0, sourceChannel: index,
          offset: 0, trimStart: 0, trimEnd: 10, volume: 1, fadeIn: 0, fadeOut: 0,
        }],
      })),
      streams: [{ id: 'all-mono', layout: 'mono', busIds: ['a1'] }],
    };
    const deliveryRecord = {
      format: 'wav',
      audioBuses: compiled.buses.map(bus => ({ id: bus.id, name: bus.id, muted: false, solo: false, volume: 1 })),
      wavBusIds: ['a7', 'a8'],
      audioPlan: { streams: [{ id: 'program', layout: 'stereo', busIds: ['a7', 'a8'] }] },
    };

    const finalPlan = composeDeliveryAudioPlan(compiled, deliveryRecord);
    const normalized = ExportPlan._normalizeAudioPlan(finalPlan, { requireStreams: false });
    const inputs = [];
    const filtergraph = [];
    const planned = ExportPlan._buildPlannedAudio(normalized, inputs, filtergraph, 0, 10);
    const wav = ExportPlan._buildWavOutput(planned.busLabels, normalized, filtergraph);

    expect(finalPlan.buses.map(bus => bus.id)).toEqual(['a7', 'a8']);
    expect(wav.channels).toBe(2);
    expect(inputs).toEqual(['-i', 'C:/master/program.mxf']);
    expect(filtergraph.join('\n')).toContain('pan=mono|c0=c6');
    expect(filtergraph.join('\n')).toContain('pan=mono|c0=c7');
    expect(filtergraph.join('\n')).toContain('join=inputs=2:channel_layout=FL+FR');
    expect(filtergraph.join('\n')).not.toContain('anullsrc');
  });
});

/* 這兩個模組能不能被無 mock 測試，取決於它們有沒有偷偷 import 副作用來源。
   delivery-job 只准依賴純資料的 project-audio；後者本身必須是依賴葉節點。 */
describe('模組本身保持純淨', () => {
  it('delivery-job.js 只依賴純音訊解讀器，兩者都不碰 State／Media／Seq／DOM', () => {
    const fs = createRequire(import.meta.url)('node:fs');
    const path = createRequire(import.meta.url)('node:path');
    const url = createRequire(import.meta.url)('node:url');
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
    const src = fs.readFileSync(path.join(root, 'src/delivery-job.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const interpretation = fs.readFileSync(path.join(root, 'src/project-audio.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect([...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]))
      .toEqual(['./project-audio.js']);
    for (const pureCode of [code, interpretation]) {
      expect(pureCode).not.toMatch(/from\s+['"].*(state|media|sequence|dom)/i);
      expect(pureCode).not.toMatch(/\bdocument\b/);
      expect(pureCode).not.toMatch(/\bwindow\b/);
    }
  });
});
