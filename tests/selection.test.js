/* 選取狀態的兩條不變量。

   ① 三種選取互斥：字幕（selectedId/selectedIds）、視訊片段（selectedClipId）、
      音訊片段（selectedAudioClipId）不可同時有值。漏清一個，Delete 或 Ctrl+K
      就會作用在使用者以為沒選中的東西上——畫面不會報錯，資料卻被改掉。
   ② activeTrackKind 必須與被選中的 id 同類，否則 ↑／↓ 會跳到別種軌。

   這兩條以前散在約 97 個裸賦值裡由各處自行維持，沒有任何一處負責它們。
   已收斂到 setSelection()／clearSelection()。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { State, setSelection, clearSelection, deselect, pruneSelection, focusTrackKind } from '../src/state.js';

/* 每種選取都放進值，任何遺漏的清空都會在斷言裡現形。 */
const dirty = () => {
  State.selectedId = 'cue9';
  State.selectedIds = ['cue8', 'cue9'];
  State.selectedClipId = 'clip9';
  State.selectedAudioClipId = 'aclip9';
  State.activeTrackKind = 'video';
};

const snapshot = () => ({
  selectedId: State.selectedId,
  selectedIds: State.selectedIds,
  selectedClipId: State.selectedClipId,
  selectedAudioClipId: State.selectedAudioClipId,
  activeTrackKind: State.activeTrackKind,
});

beforeEach(() => { dirty(); });

describe('三種選取互斥', () => {
  it('選字幕會清掉視訊與音訊片段選取', () => {
    setSelection({ kind: 'sub', ids: ['a', 'b'] });
    expect(snapshot()).toMatchObject({
      selectedIds: ['a', 'b'], selectedId: 'b',
      selectedClipId: null, selectedAudioClipId: null,
      activeTrackKind: 'sub',
    });
  });

  it('選視訊片段會清掉字幕與音訊選取', () => {
    setSelection({ kind: 'video', ids: 'clip1' });
    expect(snapshot()).toMatchObject({
      selectedClipId: 'clip1',
      selectedId: null, selectedIds: [], selectedAudioClipId: null,
      activeTrackKind: 'video',
    });
  });

  it('選音訊片段會清掉字幕與視訊選取', () => {
    setSelection({ kind: 'audio', ids: 'aclip1' });
    expect(snapshot()).toMatchObject({
      selectedAudioClipId: 'aclip1',
      selectedId: null, selectedIds: [], selectedClipId: null,
      activeTrackKind: 'audio',
    });
  });

  it('任何時刻最多只有一種選取有值', () => {
    for (const kind of ['sub', 'video', 'audio']) {
      dirty();
      setSelection({ kind, ids: ['x'] });
      const s = snapshot();
      const filled = [
        s.selectedIds.length > 0 || s.selectedId != null,
        s.selectedClipId != null,
        s.selectedAudioClipId != null,
      ].filter(Boolean).length;
      expect(filled, `kind=${kind} 時有 ${filled} 種選取同時有值`).toBe(1);
    }
  });
});

describe('activeTrackKind 與選取同步', () => {
  it.each(['sub', 'video', 'audio'])('選 %s 時 activeTrackKind 跟著切', kind => {
    setSelection({ kind, ids: ['x'] });
    expect(State.activeTrackKind).toBe(kind);
  });

  /* 點時間軸空白處＝取消選取，但那一軌仍是目前焦點軌（見 開發與驗證.md §4.13）。
     若這裡把 activeTrackKind 也清掉，鍵盤導航會失去焦點軌。 */
  it('clearSelection 保留 activeTrackKind', () => {
    State.activeTrackKind = 'audio';
    clearSelection();
    expect(State.activeTrackKind).toBe('audio');
    expect(snapshot()).toMatchObject({
      selectedId: null, selectedIds: [], selectedClipId: null, selectedAudioClipId: null,
    });
  });
});

describe('primary（主選取）的規則', () => {
  it('未指定時取最後一個——與既有的「最後點到的成為主選取」一致', () => {
    setSelection({ kind: 'sub', ids: ['a', 'b', 'c'] });
    expect(State.selectedId).toBe('c');
  });

  it('可明確指定 primary', () => {
    setSelection({ kind: 'sub', ids: ['a', 'b', 'c'], primary: 'a' });
    expect(State.selectedId).toBe('a');
    expect(State.selectedIds).toEqual(['a', 'b', 'c']);
  });

  it('空集合時 primary 為 null', () => {
    setSelection({ kind: 'sub', ids: [] });
    expect(State.selectedId).toBeNull();
    expect(State.selectedIds).toEqual([]);
  });
});

describe('輸入防禦（呼叫端傳什麼都不該讓狀態變成半殘）', () => {
  it('單一 id 可不包成陣列', () => {
    setSelection({ kind: 'video', ids: 'clip1' });
    expect(State.selectedClipId).toBe('clip1');
  });

  it('null / undefined 的 id 會被濾掉，不會變成選取值', () => {
    setSelection({ kind: 'sub', ids: ['a', null, undefined, 'b'] });
    expect(State.selectedIds).toEqual(['a', 'b']);
  });

  it('完全不給參數＝清空，且不丟例外', () => {
    expect(() => setSelection()).not.toThrow();
    expect(snapshot()).toMatchObject({
      selectedId: null, selectedIds: [], selectedClipId: null, selectedAudioClipId: null,
    });
  });

  it('未知的 kind 視為清空，且不會亂設 activeTrackKind', () => {
    State.activeTrackKind = 'sub';
    setSelection({ kind: 'nonsense', ids: ['x'] });
    expect(State.activeTrackKind).toBe('sub');
    expect(snapshot()).toMatchObject({
      selectedId: null, selectedIds: [], selectedClipId: null, selectedAudioClipId: null,
    });
  });

  it('selectedIds 永遠是陣列（呼叫端會直接 .includes / .length）', () => {
    for (const ids of [null, undefined, 'x', ['a']]) {
      setSelection({ kind: 'sub', ids });
      expect(Array.isArray(State.selectedIds)).toBe(true);
    }
  });
});

/* 以下三個是把「只放掉一種」「集合變動後修剪」「只換焦點軌」這三種呼叫端
   以前各自手寫的形狀收進來的結果。它們過去分散在 media.js / menus.js /
   keyboard.js / history.js / timeline-renderer.js，寫法彼此不一致。 */
describe('deselect：只放掉一種選取', () => {
  it.each([
    ['video', 'selectedClipId'],
    ['audio', 'selectedAudioClipId'],
  ])('deselect(%s) 只清自己，其他兩種不動', (kind, field) => {
    deselect(kind);
    expect(State[field]).toBeNull();
    expect(State.selectedId).toBe('cue9');           // 字幕選取原封不動
    expect(State.selectedIds).toEqual(['cue8', 'cue9']);
  });

  it('給 id 時只在「目前選的正好是它」才放掉', () => {
    deselect('audio', '別的素材');
    expect(State.selectedAudioClipId).toBe('aclip9'); // 不是它，不動
    deselect('audio', 'aclip9');
    expect(State.selectedAudioClipId).toBeNull();
  });

  it('deselect(sub) 不給 id＝整組清掉', () => {
    deselect('sub');
    expect(State.selectedId).toBeNull();
    expect(State.selectedIds).toEqual([]);
  });

  it('deselect(sub, id) 只從多選裡拿掉那一條，主選取退給剩下的最後一條', () => {
    setSelection({ kind: 'sub', ids: ['a', 'b', 'c'] }); // primary = 'c'
    deselect('sub', 'c');
    expect(State.selectedIds).toEqual(['a', 'b']);
    expect(State.selectedId).toBe('b');
  });

  it('不動 activeTrackKind（焦點軌留在原處，與 clearSelection 一致）', () => {
    State.activeTrackKind = 'audio';
    deselect('audio');
    expect(State.activeTrackKind).toBe('audio');
  });

  it('未知的 kind 什麼都不做，且不丟例外', () => {
    const before = snapshot();
    expect(() => deselect('nonsense')).not.toThrow();
    expect(snapshot()).toEqual(before);
  });
});

describe('pruneSelection：字幕集合變動後修剪選取', () => {
  beforeEach(() => { State.cues = [{ id: 'a' }, { id: 'b' }]; });

  it('丟掉已不存在的 id', () => {
    setSelection({ kind: 'sub', ids: ['a', 'ghost', 'b'] });
    pruneSelection();
    expect(State.selectedIds).toEqual(['a', 'b']);
  });

  /* 這裡以前有三種寫法：history.js 連同其他選取一起丟、另外兩處退給第一個。
     統一成「退給第一個」——undo 之後不該連沒被刪的選取也一起消失。 */
  it('主選取消失時退給剩下的第一個，而不是整組清空', () => {
    setSelection({ kind: 'sub', ids: ['a', 'b'], primary: 'ghost' });
    pruneSelection();
    expect(State.selectedIds).toEqual(['a', 'b']);
    expect(State.selectedId).toBe('a');
  });

  it('全部都不存在時才清空', () => {
    setSelection({ kind: 'sub', ids: ['ghost1', 'ghost2'] });
    pruneSelection();
    expect(State.selectedIds).toEqual([]);
    expect(State.selectedId).toBeNull();
  });

  it('主選取還在就不動它', () => {
    setSelection({ kind: 'sub', ids: ['a', 'b'], primary: 'a' });
    pruneSelection();
    expect(State.selectedId).toBe('a');
  });
});

describe('focusTrackKind：只換焦點軌', () => {
  it('換 activeTrackKind 但不碰任何選取', () => {
    focusTrackKind('sub');
    expect(State.activeTrackKind).toBe('sub');
    expect(State.selectedClipId).toBe('clip9');
    expect(State.selectedAudioClipId).toBe('aclip9');
  });

  it('未知的 kind 不會寫進 activeTrackKind', () => {
    State.activeTrackKind = 'video';
    focusTrackKind('nonsense');
    expect(State.activeTrackKind).toBe('video');
  });
});

/* 焦點軌的「哪一種」與「哪一軌」是同一條複合不變量。

   refreshTrackGutterActive()（timeline-renderer.js）是證據：它把兩者成對比對
     activeTrackKind==='sub'   && dataset.track         === listTrack
     activeTrackKind==='video' && dataset.vtrack        === activeVtrack
     activeTrackKind==='audio' && dataset.audioSourceId === activeAudioTrackId
   但 eslint 圍籬只守了 activeTrackKind，三個夥伴欄位在圍籬外（listTrack 有 13 處寫入）。
   於是曾出現「先寫夥伴欄位、再呼叫 setSelection」與「先 focusTrackKind、再裸寫夥伴欄位」
   兩種順序並存的寫法。focusTrackKind(kind, index) 讓它變成一次寫入。 */
describe('focusTrackKind：類別與夥伴欄位一次寫入', () => {
  beforeEach(() => {
    State.listTrack = 0;
    State.activeVtrack = 0;
    State.activeAudioTrackId = null;
    State.activeTrackKind = 'sub';
  });

  it('sub 的夥伴欄位是 listTrack', () => {
    focusTrackKind('sub', 3);
    expect(State.activeTrackKind).toBe('sub');
    expect(State.listTrack).toBe(3);
  });

  it('video 的夥伴欄位是 activeVtrack', () => {
    focusTrackKind('video', 2);
    expect(State.activeTrackKind).toBe('video');
    expect(State.activeVtrack).toBe(2);
  });

  it('audio 的夥伴欄位是 activeAudioTrackId（字串 id，不是索引）', () => {
    focusTrackKind('audio', 'ext-7');
    expect(State.activeTrackKind).toBe('audio');
    expect(State.activeAudioTrackId).toBe('ext-7');
  });

  it('不給 index 就只換類別，夥伴欄位不動（點軌道列頭以外的語意）', () => {
    State.listTrack = 5;
    focusTrackKind('sub');
    expect(State.activeTrackKind).toBe('sub');
    expect(State.listTrack).toBe(5);
  });

  it('未知的 kind 連夥伴欄位都不可以寫', () => {
    State.listTrack = 5;
    focusTrackKind('nonsense', 9);
    expect(State.activeTrackKind).toBe('sub');
    expect(State.listTrack).toBe(5);
  });
});
