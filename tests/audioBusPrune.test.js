/* 減少專案音軌數之後，指向已消失 bus 的參照要全部清乾淨。

   §0.8：素材聲道／專案音軌／輸出 stream 是三件事。刪掉一條專案音軌時，
   **兩個地方**會留下指向它的 id——來源聲道的 sourceMaps 與輸出編組的 exportLayout。
   漏掉任一個都不會報錯：配線面板看起來正常，匯出時那條 stream 卻對應到不存在的 bus，
   結果是靜音或聲道數不對，而且要把成品放進播放器才聽得出來。

   這條規則以前住在 audio-routing.js 的 setBusCount 裡（565 行、25 個 DOM 觸點、
   沒有任何測試）。 */
import { describe, expect, it } from 'vitest';
import { pruneRemovedAudioBuses } from '../src/state.js';

const project = () => ({
  buses: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
  sourceMaps: {
    'src-1': { channels: [
      { sourceStream: 0, sourceChannel: 0, busIds: ['b1'] },
      { sourceStream: 0, sourceChannel: 1, busIds: ['b2', 'b3'] },
    ] },
    'src-2': { channels: [
      { sourceStream: 0, sourceChannel: 0, busIds: ['b3'] },
    ] },
  },
  exportLayout: { streams: [
    { id: 's1', layout: 'stereo', busIds: ['b1', 'b2'] },
    { id: 's2', layout: 'mono', busIds: ['b3'] },
  ] },
});

describe('pruneRemovedAudioBuses', () => {
  it('來源配線裡指向已刪 bus 的 id 會被清掉', () => {
    const p = project();
    pruneRemovedAudioBuses(p, new Set(['b3']));
    expect(p.sourceMaps['src-1'].channels[1].busIds).toEqual(['b2']);
    expect(p.sourceMaps['src-2'].channels[0].busIds).toEqual([]);
  });

  it('輸出編組裡指向已刪 bus 的 id 也會被清掉', () => {
    const p = project();
    pruneRemovedAudioBuses(p, new Set(['b2']));
    expect(p.exportLayout.streams[0].busIds).toEqual(['b1']);
  });

  /* 這一條是重點：只清 sourceMaps 而漏了 exportLayout（或反過來）不會報錯，
     但匯出會對應到不存在的 bus。 */
  it('兩個地方都要清——只清一邊就算漏', () => {
    const p = project();
    pruneRemovedAudioBuses(p, new Set(['b1', 'b2', 'b3']));
    const 全部殘留 = [
      ...Object.values(p.sourceMaps).flatMap(m => m.channels.flatMap(r => r.busIds)),
      ...p.exportLayout.streams.flatMap(s => s.busIds),
    ];
    expect(全部殘留).toEqual([]);
  });

  it('清空的輸出 stream 會被移除', () => {
    const p = project();
    pruneRemovedAudioBuses(p, new Set(['b3']));
    expect(p.exportLayout.streams.map(s => s.id)).toEqual(['s1']);
  });

  /* 一條 stream 都不留的話，匯出會產生沒有音訊軌的檔案。 */
  it('全部清空時至少保留一條輸出 stream', () => {
    const p = project();
    pruneRemovedAudioBuses(p, new Set(['b1', 'b2', 'b3']));
    expect(p.exportLayout.streams).toHaveLength(1);
    expect(p.exportLayout.streams[0].busIds).toEqual([]);
  });

  it('沒有被刪的 bus 時完全不動', () => {
    const p = project();
    const snapshot = JSON.stringify(p);
    pruneRemovedAudioBuses(p, new Set());
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it('接受陣列或 Set', () => {
    const p = project();
    pruneRemovedAudioBuses(p, ['b1']);
    expect(p.exportLayout.streams[0].busIds).toEqual(['b2']);
  });

  it('缺欄位時不炸開', () => {
    expect(() => pruneRemovedAudioBuses({}, ['b1'])).not.toThrow();
    expect(() => pruneRemovedAudioBuses({ sourceMaps: null, exportLayout: null }, ['b1'])).not.toThrow();
    expect(pruneRemovedAudioBuses(null, ['b1'])).toBeNull();
  });
});
