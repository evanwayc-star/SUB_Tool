import { beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { Worker } from 'node:worker_threads';
import { State, ensureAudioBusCount, ensureAudioExportDefaults, ensureAudioSourceMap, normalizeAudioProject, resetAudioProject, routeForChannel } from '../src/state.js';

let stateBundle;
async function normalizeIsolated(input) {
  // An allocator regression must fail this test rather than hang Vitest itself.
  stateBundle ||= buildSync({ entryPoints: ['src/state.js'], bundle: true, write: false,
    format: 'cjs', platform: 'node' }).outputFiles[0].text;
  const worker = new Worker(stateBundle + `
    const {parentPort}=require('node:worker_threads');
    const api=module.exports;
    const first=api.normalizeAudioProject(${JSON.stringify(input)});
    const second=api.normalizeAudioProject(JSON.parse(JSON.stringify(first)));
    api.State.audioProject=second;
    api.ensureAudioBusCount(5);
    api.ensureAudioExportDefaults({appendMissing:true});
    parentPort.postMessage({first,second:JSON.parse(JSON.stringify(api.State.audioProject))});
  `, { eval: true });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
      timer = setTimeout(() => reject(new Error('音訊正規化未在三秒內結束')), 3000);
    });
  } finally { clearTimeout(timer); await worker.terminate(); }
}

describe('大數音訊 ID 的有限分配', () => {
  it.each(['buses', 'streams'].flatMap(kind =>
    ['9007199254740990', '9007199254740992', '9'.repeat(320)].map(suffix => ({ kind, suffix }))))(
    '$kind 保留原字串 ID，補建與重載仍有唯一識別字（$suffix）', async ({ kind, suffix }) => {
      const id = (kind === 'buses' ? 'ab' : 'out') + suffix;
      const input = kind === 'buses' ? { buses: [{ id }, {}, {}] }
        : { buses: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], exportLayout: { streams: [
          { id, busIds: ['a'] }, { busIds: ['b'] }, { busIds: ['c'] },
        ] } };
      const { first, second } = await normalizeIsolated(input);
      const entries = project => kind === 'buses' ? project.buses : project.exportLayout.streams;
      const original = entries(first), expanded = entries(second);
      expect(original).toHaveLength(3);
      expect(original[0].id).toBe(id);
      expect(new Set(original.map(entry => entry.id)).size).toBe(3);
      expect(expanded.slice(0, 3)).toEqual(original);
      expect(new Set(expanded.map(entry => entry.id)).size).toBe(expanded.length);
      expect(expanded.every(entry => typeof entry.id === 'string' && !entry.id.includes('Infinity'))).toBe(true);
      expect(second.buses).toHaveLength(5);
    });
});

describe('project audio routing', () => {
  beforeEach(() => resetAudioProject());

  it('creates identity routes and mono export streams from an 8-channel source', () => {
    const channels=Array.from({length:8},(_,sourceChannel)=>({sourceStream:0,sourceChannel}));
    ensureAudioSourceMap('asset-a',channels);

    expect(State.audioProject.buses).toHaveLength(8);
    expect(State.audioProject.exportLayout.streams).toHaveLength(8);
    expect(routeForChannel('asset-a',0,0).busIds).toEqual([State.audioProject.buses[0].id]);
    expect(routeForChannel('asset-a',0,7).busIds).toEqual([State.audioProject.buses[7].id]);
  });

  it('auto mode grows only to the largest imported source channel count', () => {
    ensureAudioSourceMap('eight',Array.from({length:8},(_,sourceChannel)=>({sourceStream:0,sourceChannel})));
    ensureAudioSourceMap('ten',Array.from({length:10},(_,sourceChannel)=>({sourceStream:0,sourceChannel})));

    expect(State.audioProject.buses).toHaveLength(10);
    expect(routeForChannel('eight',0,7).busIds).toEqual([State.audioProject.buses[7].id]);
    expect(routeForChannel('ten',0,9).busIds).toEqual([State.audioProject.buses[9].id]);
  });

  it('keeps every imported source file on its own routing map', () => {
    const channels=Array.from({length:8},(_,sourceChannel)=>({sourceStream:0,sourceChannel}));
    ensureAudioSourceMap('interview-a',channels);
    ensureAudioSourceMap('interview-b',channels);
    const ids=State.audioProject.buses.map(bus=>bus.id);

    State.audioProject.sourceMaps['interview-b'].channels[0].busIds=[ids[6]];
    State.audioProject.sourceMaps['interview-b'].channels[1].busIds=[ids[7]];

    expect(routeForChannel('interview-a',0,0).busIds).toEqual([ids[0]]);
    expect(routeForChannel('interview-a',0,1).busIds).toEqual([ids[1]]);
    expect(routeForChannel('interview-b',0,0).busIds).toEqual([ids[6]]);
    expect(routeForChannel('interview-b',0,1).busIds).toEqual([ids[7]]);
  });

  it('does not silently expand a manual project when a larger source is added', () => {
    ensureAudioBusCount(8);
    State.audioProject.mode='manual';
    ensureAudioSourceMap('ten',Array.from({length:10},(_,sourceChannel)=>({sourceStream:0,sourceChannel})));

    expect(State.audioProject.buses).toHaveLength(8);
    expect(routeForChannel('ten',0,7).busIds).toEqual([State.audioProject.buses[7].id]);
    expect(routeForChannel('ten',0,8).busIds).toEqual([]);
  });

  it('keeps a custom 5.1 + stereo output layout through normalization', () => {
    ensureAudioBusCount(8);
    const ids=State.audioProject.buses.map(bus=>bus.id);
    State.audioProject.exportLayout={streams:[
      {id:'surround',name:'  主聲道 5.1  ',layout:'5.1',busIds:ids.slice(0,6)},
      {id:'lt-rt',layout:'stereoLtRt',busIds:ids.slice(6,8)}
    ]};

    // Simulate writing and reopening a project: optional stream names must
    // survive serialisation as sanitized strings alongside their routing.
    State.audioProject=normalizeAudioProject(JSON.parse(JSON.stringify(State.audioProject)));
    ensureAudioExportDefaults({appendMissing:true});

    expect(State.audioProject.exportLayout.streams).toEqual([
      {id:'surround',name:'主聲道 5.1',layout:'5.1',busIds:ids.slice(0,6)},
      {id:'lt-rt',layout:'stereoLtRt',busIds:ids.slice(6,8)}
    ]);
  });
});
