// @vitest-environment jsdom
/* 復原快照的**往返**：snap() 寫進去的每一個欄位，restore() 都要讀回來。

   History.snap() 目前收 12 個欄位。它與 restore() 是兩份手寫清單，
   彼此沒有任何機制對齊：

     - 在 snap() 加了欄位、忘了在 restore() 讀 → 快照變大，Ctrl+Z 卻不還原那一項。
     - 在 restore() 讀了 snap() 沒寫的欄位 → 永遠是 undefined，等於把該項清空。

   兩種都**不會報錯**，只會在使用者按下 Ctrl+Z 之後發現「有一半沒回來」。
   這支測試對每個欄位跑「設成 A → 記錄 → 設成 B → 記錄 → undo → 應為 A →
   redo → 應為 B」，任何一邊漏掉就紅。

   同時也守住 Seq.snapshot() ↔ Seq.restore()：clipGeo 是 12 個欄位裡唯一
   由另一支模組序列化的，兩邊同樣是兩份手寫清單。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
vi.mock('../src/ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/media.js', () => ({ Media: {mpvPresenting:()=>false} }));

import { State, syncTrackCount } from '../src/state.js';
import { History } from '../src/history.js';
import { beginTimelineGestureLifecycle } from '../src/timeline-gesture-transaction.js';
import { beginTimelineTrackEdit } from '../src/timeline-edit-transaction.js';
import { createPreviewDrag } from '../src/timeline-interaction-engine.js';

const cue = (start, end, text) => ({ id: 'c' + start, start, end, text, track: 0, timed: true });

const videoClip = (over = {}) => ({
  id: 'v1', name: 'a.mov', path: 'C:/a.mov', web: null, dur: 60, fps: 25, primary: true,
  audioSrc: 'video', audioSourceId: 'src-1', audioDetached: false,
  in: 0, out: 10, offset: 0, vtrack: 0, fadeIn: 0, fadeOut: 0, ...over,
});

const imageClip = (over = {}) => ({
  id: 'i1', name: 'logo.png', path: 'C:/logo.png', web: null, dur: 5, fps: 0, primary: false,
  type: 'image', scale: 1, posX: 0.5, posY: 0.5, natW: 800, natH: 600,
  audioSrc: null, audioSourceId: null, audioDetached: false,
  in: 0, out: 5, offset: 0, vtrack: 0, fadeIn: 0, fadeOut: 0, ...over,
});

function resetState() {
  document.body.innerHTML = '<div id="historyList"></div>';
  State.cues = [];
  State.tracks = [{ name: '軌道 1', visible: true, locked: false }];
  State.notes = [];
  State.clips = [];
  State.videoTracks = [{ name: '視訊軌 1', visible: true, locked: false, opacity: 1 }];
  State.audioProject = null;
  State.externalAudioState = [];
  State.externalAudioEnd = 0;
  State.exportIn = null;
  State.exportOut = null;
  State.duration = 0;
  History.stack = [];
  History.hi = -1;
}

/* 每一列是一個快照欄位的往返案例：把 State 設成 a、設成 b，各記一步，
   再用 read() 取出目前的值來比對。read 回傳可比較的純資料。 */
const FIELDS = [
  {
    name: '影片音訊效果（不包含可重建的快取）',
    a: () => { State.clips=[videoClip()]; },
    b: () => { Object.assign(State.clips[0],{hasAudioLimiter:true,audioLimiterSpec:{max:-6,min:-12,inputBoost:0},normalizedAudioPath:'C:/temp/effect.wav'}); },
    read: () => State.clips.map(c=>c.audioLimiterSpec?.max ?? null),
    expectA: [null], expectB: [-6],
  },
  {
    name: 'cues（字幕）',
    a: () => { State.cues = [cue(0, 2, '第一句')]; },
    b: () => { State.cues = [cue(0, 2, '第一句'), cue(3, 5, '第二句')]; },
    read: () => State.cues.map(c => c.text),
    expectA: ['第一句'], expectB: ['第一句', '第二句'],
  },
  {
    name: 'tracks（字幕軌）',
    a: () => { State.tracks = [{ name: '軌道 1', visible: true, locked: false }]; },
    b: () => { State.tracks = [{ name: '軌道 1', visible: true, locked: false },
      { name: '軌道 2', visible: true, locked: true }]; },
    read: () => State.tracks.map(t => t.name + (t.locked ? '(鎖)' : '')),
    expectA: ['軌道 1'], expectB: ['軌道 1', '軌道 2(鎖)'],
  },
  {
    name: 'notes（備註）',
    a: () => { State.notes = []; },
    b: () => { State.notes = [{ id: 'n1', t: 3.5, text: '這裡要重配' }]; },
    read: () => State.notes.map(n => `${n.t}:${n.text}`),
    expectA: [], expectB: ['3.5:這裡要重配'],
  },
  {
    name: 'videoTracks（視訊軌，含透明度）',
    a: () => { State.videoTracks = [{ name: '視訊軌 1', visible: true, locked: false, opacity: 1 }]; },
    b: () => {
      State.videoTracks = [
        { name: '視訊軌 1', visible: true, locked: false, opacity: 1 },
        { name: '視訊軌 2', visible: false, locked: true, opacity: 0.35 },
      ];
    },
    read: () => State.videoTracks.map(v => `${v.name}/${v.visible}/${v.locked}/${v.opacity}`),
    expectA: ['視訊軌 1/true/false/1'],
    expectB: ['視訊軌 1/true/false/1', '視訊軌 2/false/true/0.35'],
  },
  {
    name: 'audioProject（專案音訊 bus 的音量與靜音）',
    a: () => { State.audioProject = { buses: [{ id: 'b1', name: '主混音', volume: 1, muted: false }], sourceMaps: {}, exportLayout: { streams: [] } }; },
    b: () => {
      State.audioProject = {
        buses: [
          { id: 'b1', name: '主混音', volume: 0.5, muted: true },
          { id: 'b2', name: '旁白', volume: 1, muted: false },
        ],
        sourceMaps: {}, exportLayout: { streams: [] },
      };
    },
    read: () => (State.audioProject?.buses || []).map(b => `${b.name}/${b.volume}/${b.muted}`),
    expectA: ['主混音/1/false'],
    expectB: ['主混音/0.5/true', '旁白/1/false'],
  },
  {
    name: 'externalAudioState（外部音訊素材）',
    a: () => { State.externalAudioState = []; },
    b: () => { State.externalAudioState = [{ key: 'ext-1', name: 'bgm.wav', path: 'C:/bgm.wav', offset: 2, in: 0, out: 30, gain: 0.8, fadeIn: 1, fadeOut: 1, enabled: true }]; },
    read: () => State.externalAudioState.map(s => `${s.name}@${s.offset}/${s.gain}`),
    expectA: [], expectB: ['bgm.wav@2/0.8'],
  },
  {
    name: 'fps 與 dropFrame',
    a: () => { State.fps = 25; State.dropFrame = false; },
    b: () => { State.fps = 29.97; State.dropFrame = true; },
    read: () => `${Math.round(State.fps * 100) / 100}/${State.dropFrame}`,
    expectA: '25/false', expectB: '29.97/true',
  },
  {
    name: 'exportIn 與 exportOut（輸出範圍）',
    a: () => { State.exportIn = null; State.exportOut = null; },
    b: () => { State.exportIn = 12.5; State.exportOut = 48; },
    read: () => `${State.exportIn}/${State.exportOut}`,
    expectA: 'null/null', expectB: '12.5/48',
  },
  {
    name: 'clipGeo（影片片段的位置與修剪）',
    a: () => { State.clips = [videoClip()]; },
    b: () => { State.clips = [videoClip({ in: 2, out: 8, offset: 30, vtrack: 1 })]; },
    read: () => State.clips.map(c => `${c.in}/${c.out}/${c.offset}/${c.vtrack}`),
    expectA: ['0/10/0/0'], expectB: ['2/8/30/1'],
  },
  {
    name: 'clipGeo：淡入淡出',
    a: () => { State.clips = [videoClip()]; },
    b: () => { State.clips = [videoClip({ fadeIn: 1.5, fadeOut: 2.5 })]; },
    read: () => State.clips.map(c => `${c.fadeIn}/${c.fadeOut}`),
    expectA: ['0/0'], expectB: ['1.5/2.5'],
  },
  {
    name: 'clipGeo：圖片幾何（縮放與位置）',
    a: () => { State.clips = [imageClip()]; },
    b: () => { State.clips = [imageClip({ scale: 2.4, posX: 0.2, posY: 0.8 })]; },
    read: () => State.clips.map(c => `${c.scale}/${c.posX}/${c.posY}`),
    expectA: ['1/0.5/0.5'], expectB: ['2.4/0.2/0.8'],
  },
  {
    name: 'clipGeo：成員增減（切割／刪除也要能復原）',
    a: () => { State.clips = [videoClip()]; },
    b: () => { State.clips = [videoClip({ out: 4 }), videoClip({ id: 'v2', in: 4, out: 10, offset: 4 })]; },
    read: () => State.clips.map(c => c.id),
    expectA: ['v1'], expectB: ['v1', 'v2'],
  },
  {
    name: 'clipGeo：音訊分離旗標',
    a: () => { State.clips = [videoClip()]; },
    b: () => { State.clips = [videoClip({ audioDetached: true })]; },
    read: () => State.clips.map(c => !!c.audioDetached),
    expectA: [false], expectB: [true],
  },
];

describe('復原快照往返：snap() 寫的每個欄位，restore() 都要讀回來', () => {
  beforeEach(resetState);

  for (const f of FIELDS) {
    it(f.name, () => {
      f.a();
      History.reset();
      f.b();
      History.record('改成 B');

      /* 前提：兩個狀態必須真的不同，否則 record() 會判定沒變動而不記錄，
         往返測試就會在「兩邊都一樣」的情況下假性通過。 */
      expect(History.stack.length, '兩個狀態必須不同才測得出往返').toBe(2);
      expect(f.read()).toEqual(f.expectB);

      History.undo();
      expect(f.read(), 'undo 沒有把 A 還原回來').toEqual(f.expectA);

      History.redo();
      expect(f.read(), 'redo 沒有把 B 還原回來').toEqual(f.expectB);
    });
  }
});

describe('快照欄位清單', () => {
  beforeEach(resetState);

  /* 這一條是「有沒有人偷加欄位卻沒接進 restore()」的哨兵。
     加欄位是好事——但加完必須同時（a）在 restore() 讀回來、
     （b）在上面的 FIELDS 表補一列往返案例、（c）更新這裡的清單。 */
  it('目前是這 12 個欄位；要增減請一併補上往返案例', () => {
    State.cues = [cue(0, 1, 'x')];
    State.clips = [videoClip()];
    expect(Object.keys(History.snap()).sort()).toEqual([
      'audioProject', 'clipGeo', 'cues', 'dropFrame', 'exportIn', 'exportOut',
      'externalAudioState', 'fps', 'notes', 'trackCount', 'tracks', 'videoTracks',
    ]);
  });

  /* trackCount 是 12 個欄位裡唯一**寫進去卻不讀回來**的：restore() 改叫
     syncTrackCount() 從 tracks.length 推導。這是刻意的（軌數是衍生值，
     不是獨立事實），寫在這裡是為了讓下一個人知道那不是漏掉的。 */
  it('trackCount 由 tracks 推導而非從快照讀回', () => {
    State.tracks = [{ name: '軌道 1', visible: true, locked: false }];
    syncTrackCount();
    History.reset();
    State.tracks = [
      { name: '軌道 1', visible: true, locked: false },
      { name: '軌道 2', visible: true, locked: false },
    ];
    syncTrackCount();
    History.record('加一軌');
    expect(State.trackCount).toBe(2);

    /* 還原時不讀 d.trackCount，而是從還原後的 tracks 重算。
       把 trackCount 故意設錯再 undo，仍應回到 1。 */
    State.trackCount = 99;
    History.undo();
    expect(State.tracks).toHaveLength(1);
    expect(State.trackCount).toBe(1);
  });

  it('快照是深拷貝：之後改動 State 不會回頭汙染已記錄的步驟', () => {
    State.cues = [cue(0, 2, '原文')];
    History.reset();
    State.cues[0].text = '改過的';
    History.record('改字');
    History.undo();
    expect(State.cues[0].text).toBe('原文');
  });
});

describe('即時預覽與背景 History 的隔離',()=>{
  beforeEach(()=>{resetState();History.reset();});

  it('取消時間軸移動後，Undo/Redo 保留背景修改且不恢復暫存時間或 copy cue',()=>{
    const original=cue(1,3,'原字幕');State.cues=[original];History.reset();
    const gesture=beginTimelineGestureLifecycle({mode:'move',targets:[{target:original,fields:['start','end','track']}],effects:{beginPreview:targets=>History.beginPreview(targets)}});
    gesture.startPreview();
    gesture.preview(()=>{original.start=9;original.end=11;});
    const copied={...original,id:'copy'};State.cues.push(copied);
    gesture.addPreviewTarget(copied,[],{added:true});
    gesture.addRollback(()=>{State.cues=State.cues.filter(item=>item!==copied);});
    original.text='背景修改';History.record('背景工作');
    expect(History.stack.at(-1).snap.cues).toEqual([{...original,start:1,end:3}]);
    gesture.cancel();History.undo();History.redo();
    expect(State.cues).toEqual([{...original,start:1,end:3}]);
  });

  it('圖片直接拖曳期間的背景紀錄只保存原幾何，失焦取消後 Undo/Redo 不恢復草稿',()=>{
    State.clips=[imageClip()];History.reset();
    const layer=document.createElement('div');layer.id='imageLayer';document.body.appendChild(layer);
    const drag=createPreviewDrag({getStageRect:()=>({w:1000,h:500}),imageBoxOf:()=>({w:200,h:100}),beginPreview:targets=>History.beginPreview(targets),recordHistory:label=>History.record(label)});
    drag.bind({imageLayer:layer});drag.startImageDrag({id:'i1',x:0,y:0});drag.moveImageDrag(100,50);
    expect(State.clips[0].posX).toBe(0.6);
    State.notes=[{id:'background',text:'背景完成',t:1}];History.record('背景工作');
    window.dispatchEvent(new Event('blur'));
    History.undo();History.redo();
    expect(State.clips[0]).toMatchObject({posX:0.5,posY:0.5,scale:1});
    expect(State.notes[0].text).toBe('背景完成');
  });

  it('背景插入軌道後依目前位置投影高度，不能改到前一條軌',()=>{
    const track=State.tracks[0];track.height=64;History.reset();
    const release=History.beginPreview([{target:track,fields:['height']}]);
    track.height=120;
    State.tracks.unshift({name:'背景新增軌',height:48,visible:true});
    History.record('背景新增軌');
    expect(History.stack.at(-1).snap.tracks.map(item=>item.height)).toEqual([48,64]);
    track.height=64;release();History.undo();History.redo();
    expect(State.tracks.map(item=>item.height)).toEqual([48,64]);
  });

  it('外部音訊每次重序列化仍由 runtime owner 投影已提交高度，取消保留背景欄位',()=>{
    const asset={id:'audio',name:'配樂'};
    State.externalAudioState=[{...asset}];History.reset();
    const current=()=>State.externalAudioState.find(item=>item.id===asset.id);
    const edit=beginTimelineTrackEdit({kind:'audio',id:'audio',field:'height',target:asset,
      onApply:value=>{State.externalAudioState=State.externalAudioState.map(item=>({...item,...(typeof value==='symbol'?{}:{height:value})}));if(typeof value==='symbol')delete current().height;},
      beginPreview:()=>History.beginPreview([{target:current(),fields:['height'],resolveTarget:current}],()=>asset.id==='audio'),
    });
    edit.preview(100);current().name='背景重新命名';History.record('背景工作');
    expect(History.stack.at(-1).snap.externalAudioState[0]).toEqual({id:'audio',name:'背景重新命名'});
    edit.cancel();History.undo();History.redo();
    expect(State.externalAudioState[0]).toEqual({id:'audio',name:'背景重新命名'});
  });

  it('Undo 撤銷草稿 owner，舊手勢不能提交到同 ID 的新物件且常用樣式草稿清除',()=>{
    State.cues=[cue(1,3,'原文')];History.reset();
    State.cues[0].text='已提交';History.record('改字');
    const old=State.cues[0];
    const gesture=beginTimelineGestureLifecycle({mode:'move',targets:[{target:old,fields:['start']}],effects:{beginPreview:targets=>History.beginPreview(targets)}});
    gesture.startPreview();gesture.preview(()=>{old.start=9;});State.presetEdit={draft:{fontSize:99}};
    History.undo();
    expect(gesture.commit(()=>History.record('舊手勢')).committed).toBe(false);
    expect(State.cues[0]).toMatchObject({text:'原文',start:1});
    expect(State.presetEdit).toBeNull();
    expect(History.stack).toHaveLength(2);
  });
});
