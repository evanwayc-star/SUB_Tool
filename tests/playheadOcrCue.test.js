// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitPlayheadOcrCue } from '../src/playhead-ocr-cue.js';
import { State, setSelection, syncTrackCount } from '../src/state.js';
import { History } from '../src/history.js';
import { emit } from '../src/events.js';
import { getExactFps, secToEncore } from '../src/time.js';
import { SubFormats } from '../src/formats.js';

vi.mock('../src/events.js', () => ({on:vi.fn(), emit:vi.fn()}));
vi.mock('../src/timeline-renderer.js', async original => ({...(await original()), drawTimeline:vi.fn()}));

const previous = {id:'original', track:0, timed:true, start:3, end:5, text:'原有對白', style:{bold:true}};
beforeEach(() => {
  Object.assign(State, {fps:25, dropFrame:false, duration:10, listTrack:0, subMode:false,
    tracks:[{name:'對白', locked:false, visible:true}], cues:[structuredClone(previous)],
    clips:[], notes:[], videoTracks:[], externalAudioState:[], overwriteMode:true, overwriteKeep:false});
  syncTrackCount();
  setSelection({kind:'sub', ids:[previous.id]});
  State.activeEdge = 'end';
  History.reset();
  vi.clearAllMocks();
});

describe('確認目前畫格 OCR 字幕', () => {
  it('在按鍵時間新增兩秒字幕，保留辨識文字與人工換行，整筆軌道及字幕可一次復原／重做', () => {
    const base = History.stack.length;
    const cue = commitPlayheadOcrCue({time:3.217, text:'人工改字\n第二行', originalText:'辨識原字', provider:'openai'});
    expect(cue).toMatchObject({start:3.2, end:5.2, track:1, text:'人工改字\n第二行', timed:true,
      recognition:{kind:'screen', provider:'openai', timingEvidence:'frame', originalText:'辨識原字'}});
    expect(State.cues).toEqual([previous, cue]);
    expect(State.tracks[1]).toMatchObject({name:'OCR', visible:true, locked:false});
    expect(State).toMatchObject({listTrack:1, trackCount:2, selectedIds:[cue.id], activeTrackKind:'sub', activeEdge:'start'});
    for (const event of ['timeline:invalidate','render:listTrackSel','render:all','render:selection']) {
      expect(emit).toHaveBeenCalledWith(event);
    }
    expect(History.stack).toHaveLength(base + 1);
    History.undo();
    expect(State.cues).toEqual([previous]); expect(State.trackCount).toBe(1);
    History.redo();
    expect(State.cues).toEqual([previous, cue]); expect(State.tracks[1].name).toBe('OCR');
    const srt = SubFormats.toSRT(State.cues.filter(c => c.track === 1));
    expect(srt).toBe('1\r\n00:00:03,200 --> 00:00:05,200\r\n人工改字\r\n第二行\r\n\r\n');
  });

  it('重用同名 OCR 軌，開啟覆寫也保留同軌的原句及其他軌道', () => {
    const track = {name:'OCR', visible:false, locked:false, fontSize:54};
    const existing = {...previous, id:'old-ocr', text:'既有辨識', track:1, start:3.4, end:3.8};
    const saved = structuredClone(existing);
    State.tracks[0].locked = true;
    State.tracks.push(track); State.cues.push(existing); syncTrackCount(); History.reset();
    const cue = commitPlayheadOcrCue({time:3, text:'新辨識'});
    expect(State.tracks).toHaveLength(2); expect(State.tracks[1]).toBe(track);
    expect(cue).toMatchObject({track:1, start:3, end:5, recognition:{originalText:'新辨識'}});
    expect(State.cues).toEqual(expect.arrayContaining([previous, saved, cue]));
    expect(State.tracks[1]).toMatchObject({visible:false, fontSize:54});
    History.undo();
    expect(State.cues).toEqual([previous, saved]); expect(State.tracks[1]).toEqual(track);
  });

  it('無字幕軌的專案只從第一次確認建立 OCR 軌，再確認同個播放點可逐次復原', () => {
    State.tracks = []; State.cues = []; syncTrackCount(); setSelection({kind:'sub', ids:[]}); History.reset();
    const first = commitPlayheadOcrCue({time:1, text:'第一段'});
    const second = commitPlayheadOcrCue({time:1, text:'第二段'});
    expect(State.cues).toHaveLength(2); expect(first.id).not.toBe(second.id);
    expect(State.tracks.map(t => t.name)).toEqual(['OCR']);
    History.undo(); expect(State.cues).toEqual([first]); expect(State.trackCount).toBe(1);
    History.undo(); expect(State.cues).toEqual([]); expect(State.trackCount).toBe(0);
  });

  it.each([[23.976,false],[29.97,true],[59.94,true]])('按 %s fps / DF %s 的精確格網提交長片播放點', (fps, dropFrame) => {
    State.fps = fps; State.dropFrame = dropFrame;
    const exact = getExactFps(fps), index = Math.round(exact * 21600) - 1;
    const cue = commitPlayheadOcrCue({time:(index + .49) / exact, text:'片尾', fps, dropFrame});
    expect(cue.start).toBeCloseTo(index / exact, 9);
    expect(cue.end).toBeCloseTo((index + Math.round(2 * exact)) / exact, 9);
    expect(secToEncore(cue.start, fps, dropFrame)).toBe(secToEncore(index / exact, fps, dropFrame));
    expect(State.duration).toBe(cue.end);
  });

  it.each([
    [{text:' \n ', time:0}, /字幕文字/], [{text:'一', time:-1}, /時間/],
    [{text:'一', time:NaN}, /時間/], [{text:'一', time:Infinity}, /時間/],
    [{text:'一', time:0, fps:24}, /格率/], [{text:'一', time:0, dropFrame:true}, /時碼/],
  ])('拒絕無效或已過期的確認，不建立軌道、字幕或歷程', (options, message) => {
    const base = History.stack.length;
    expect(() => commitPlayheadOcrCue(options)).toThrow(message);
    expect(State.trackCount).toBe(1); expect(State.cues).toEqual([previous]);
    expect(State.selectedId).toBe(previous.id); expect(History.stack).toHaveLength(base);
    expect(emit).not.toHaveBeenCalled();
  });

  it('鎖定 OCR 軌時保留候選可重試，解鎖後寫入既有軌道', () => {
    State.tracks.push({name:'OCR', locked:true}); syncTrackCount(); History.reset();
    const base = History.stack.length;
    const options = {time:0, text:'字幕'};
    expect(() => commitPlayheadOcrCue(options)).toThrow(/已鎖定/);
    expect(State.trackCount).toBe(2); expect(State.cues).toEqual([previous]);
    expect(History.stack).toHaveLength(base);
    State.tracks[1].locked = false;
    expect(commitPlayheadOcrCue(options)).toMatchObject({track:1, start:0, end:2});
    expect(History.stack).toHaveLength(base + 1);
  });
});
