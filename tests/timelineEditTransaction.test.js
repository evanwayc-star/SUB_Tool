// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const domMock = vi.hoisted(() => ({
  $: vi.fn(() => ({ innerHTML: '', querySelectorAll: () => [] })),
}));

vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
vi.mock('../src/ui.js', () => ({ setStatus: vi.fn() }));

let History;
let State;
let beginTimelineTrackEdit;
let updateTimelineTrack;
let beginGeometryEdit;
let timelineInvalidations;
let mpvRefreshes;
let clearedClips;

describe('timeline track edit transaction', () => {
  beforeAll(async () => {
    ({ History } = await import('../src/history.js'));
    ({ State } = await import('../src/state.js'));
    ({ beginTimelineTrackEdit, updateTimelineTrack, beginGeometryEdit } = await import('../src/timeline-edit-transaction.js'));
    const { on } = await import('../src/events.js');
    on('history:record', label => History.record(label));
    on('timeline:invalidate', detail => timelineInvalidations.push(detail));
    on('mpv:refreshSubs', () => mpvRefreshes.push(true));
    on('selection:clipCleared', detail => clearedClips.push(detail));
  });

  beforeEach(() => {
    State.cues = [];
    State.notes = [];
    State.tracks = [{ name: '字幕軌 1', visible: true, locked: false }];
    State.trackCount = 1;
    State.videoTracks = [{ name: '視訊軌 1', visible: true, locked: false }];
    State.clips = [{ id: 'clip-a', vtrack: 0, in: 0, out: 5, offset: 0, dur: 5 }];
    State.selectedClipId = 'clip-a';
    History.stack = [];
    History.hi = -1;
    History.reset();
    timelineInvalidations = [];
    mpvRefreshes = [];
    clearedClips = [];
  });

  it('records visibility immediately so the next unrelated action cannot swallow it', () => {
    updateTimelineTrack({ kind: 'subtitle', index: 0, field: 'visible', value: false });

    expect(State.tracks[0].visible).toBe(false);
    expect(History.stack.at(-1).label).toBe('隱藏字幕軌：字幕軌 1');

    History.undo();
    expect(State.tracks[0].visible).toBe(true);
  });

  it('previews a resize continuously but commits exactly one undo step', () => {
    const edit = beginTimelineTrackEdit({ kind: 'video', index: 0, field: 'height' });

    edit.preview(72);
    edit.preview(84);
    expect(State.videoTracks[0].height).toBe(84);
    expect(History.stack).toHaveLength(1);
    expect(timelineInvalidations).toEqual([]);

    expect(edit.commit()).toBe(true);
    expect(History.stack).toHaveLength(2);
    expect(timelineInvalidations).toHaveLength(1);
    History.undo();
    expect(State.videoTracks[0].height).toBeUndefined();
  });

  it('locking a video track clears a selected clip that belongs to that track', () => {
    updateTimelineTrack({ kind: 'video', index: 0, field: 'locked', value: true });

    expect(State.videoTracks[0].locked).toBe(true);
    expect(State.selectedClipId).toBeNull();
    expect(clearedClips).toEqual([{ id: 'clip-a', reason: 'track-locked' }]);
  });

  it('video visibility does not request an unrelated mpv subtitle refresh', () => {
    updateTimelineTrack({ kind: 'video', index: 0, field: 'visible', value: false });

    expect(mpvRefreshes).toEqual([]);
  });

  it('previews and commits audio track height with undo/redo support', () => {
    State.externalAudioState = [{ id: 'ext-asset-1', audioSourceId: 'asset-1', name: '配樂' }];
    const onApply = vi.fn();
    const edit = beginTimelineTrackEdit({ kind: 'audio', id: 'ext-asset-1', field: 'height', onApply });

    edit.preview(88);
    expect(State.externalAudioState[0].height).toBe(88);
    expect(onApply).toHaveBeenCalledWith(88, State.externalAudioState[0]);
    expect(History.stack).toHaveLength(1);

    expect(edit.commit()).toBe(true);
    expect(History.stack).toHaveLength(2);
    expect(History.stack.at(-1).label).toBe('調整音訊軌高度：配樂');

    // Resetting height back to default
    updateTimelineTrack({ kind: 'audio', id: 'ext-asset-1', field: 'height', value: undefined, onApply });
    expect(State.externalAudioState[0].height).toBeUndefined();
  });

  it('cancels a queued resize preview frame before the commit redraw', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/timeline-renderer.js'), 'utf8');
    const body = src.slice(src.indexOf('function _onRowResizeUp'));
    const fn = body.slice(0, body.indexOf('\n}') + 2);

    expect(fn).toMatch(/cancelAnimationFrame\(resize\._raf\)/);
  });

  it('幾何交易提交先移除草稿投影，只建立一筆可復原的編輯', () => {
    const target=State.clips[0];
    const edit=beginGeometryEdit({target,beginPreview:History.beginPreview.bind(History)});
    edit.preview({posX:.6,posY:.7});edit.preview({posX:.8,posY:.9});
    expect(History.committedSnapshot().clips[0].posX).toBeUndefined();
    expect(edit.commit('片段位置')).toBe(true);
    expect(History.stack).toHaveLength(2);
    expect(History.committedSnapshot().clips[0]).toMatchObject({posX:.8,posY:.9});
    History.undo();expect(State.clips[0].posX).toBe(.5);
    History.redo();expect(State.clips[0]).toMatchObject({posX:.8,posY:.9});
  });

  it('沒有實際變更的幾何預覽不建立 Undo', () => {
    const edit=beginGeometryEdit({target:State.clips[0],beginPreview:History.beginPreview.bind(History)});
    expect(edit.commit('位置未變')).toBe(true);
    expect(History.stack).toHaveLength(1);
  });

  it('片段同欄位被背景修改後，取消只回復仍由自己擁有的座標', () => {
    const target=State.clips[0];
    const edit=beginGeometryEdit({target,beginPreview:History.beginPreview.bind(History)});
    edit.preview({posX:.6,posY:.7});
    target.posX=.8;target.name='背景名稱';History.record('背景位置');
    expect(History.committedSnapshot().clips[0]).toMatchObject({posX:.8,name:'背景名稱'});
    expect(History.committedSnapshot().clips[0].posY).toBeUndefined();
    expect(edit.preview({posX:.9,posY:.9})).toBe(false);
    expect(target).toMatchObject({posX:.8,name:'背景名稱'});expect(target.posY).toBeUndefined();
    History.undo();expect(State.clips[0].posX).toBe(.5);
    History.redo();expect(State.clips[0]).toMatchObject({posX:.8,name:'背景名稱'});
  });

  it('字幕子欄位投影與 cancel 保留背景顏色，不會把整包 style 覆蓋回去', () => {
    const target={id:'cue',track:0,start:0,end:1,text:'字幕',style:{color:'#ff0000'}};
    State.cues=[target];History.reset();
    const edit=beginGeometryEdit({kind:'cue',target,fields:['posX','posY'],beginPreview:History.beginPreview.bind(History)});
    edit.preview({posX:60,posY:70});target.style.color='#0000ff';History.record('背景顏色');
    expect(History.committedSnapshot().cues[0].style).toEqual({color:'#0000ff'});
    edit.cancel();expect(target.style).toEqual({color:'#0000ff'});
    History.undo();History.redo();expect(State.cues[0].style).toEqual({color:'#0000ff'});
  });

  it('字幕原本未設定 style，取消仍保留未設定的語意', () => {
    const target={id:'cue',track:0,start:0,end:1,text:'字幕'};State.cues=[target];History.reset();
    const edit=beginGeometryEdit({kind:'cue',target,fields:['angle'],beginPreview:History.beginPreview.bind(History)});
    edit.preview({angle:15});edit.cancel();
    expect(Object.hasOwn(target,'style')).toBe(false);
    expect(History.stack).toHaveLength(1);
  });

  it.each([
    ['不存在',false,undefined],['own undefined',true,undefined],['null',true,null],['空物件',true,{}],
  ])('字幕 style %s 的幾何投影與取消不會製造零變更 Undo', (_name,present,style) => {
    const target={id:'cue',track:0,start:0,end:1,text:'字幕',...(present?{style}:{})};
    const original=structuredClone(target);State.cues=[target];History.reset();
    const edit=beginGeometryEdit({kind:'cue',target,fields:['posX','posY'],beginPreview:History.beginPreview.bind(History)});
    edit.preview({posX:60,posY:70});
    const committed=History.committedSnapshot().cues[0];
    expect(Object.hasOwn(committed,'style')).toBe(present);expect(committed.style).toStrictEqual(original.style);
    History.record('預覽期間零變更');expect(History.stack).toHaveLength(1);
    edit.cancel();expect(target).toStrictEqual(original);expect(Object.hasOwn(target,'style')).toBe(present);
    History.record('取消後零變更');expect(History.stack).toHaveLength(1);
  });

  it('own undefined style 的預覽取消保留背景新增顏色與同欄位座標', () => {
    const target={id:'cue',track:0,start:0,end:1,text:'貼上的字幕',style:undefined};
    State.cues=[target];History.reset();
    const edit=beginGeometryEdit({kind:'cue',target,fields:['posX','posY'],beginPreview:History.beginPreview.bind(History)});
    edit.preview({posX:60,posY:70});target.style.posX=77;target.style.color='#0000ff';History.record('背景樣式');
    expect(History.committedSnapshot().cues[0].style).toEqual({posX:77,color:'#0000ff'});
    edit.cancel();expect(target.style).toEqual({posX:77,color:'#0000ff'});
    History.record('取消後零變更');expect(History.stack).toHaveLength(2);
  });

  it('背景整包清成空 style 後，取消不會把自己的 original undefined 寫回去', () => {
    const target={id:'cue',track:0,start:0,end:1,text:'貼上的字幕',style:undefined};
    State.cues=[target];History.reset();
    const edit=beginGeometryEdit({kind:'cue',target,fields:['posX','posY'],beginPreview:History.beginPreview.bind(History)});
    edit.preview({posX:60,posY:70});target.style={};History.record('背景清空樣式');
    expect(History.committedSnapshot().cues[0].style).toStrictEqual({});
    edit.cancel();expect(target.style).toStrictEqual({});
    History.record('取消後零變更');expect(History.stack).toHaveLength(2);
  });

  it.each(['clip-lock','track-lock'])('%s 阻止幾何提交但取消仍回復自己的預覽', reason => {
    const target=State.clips[0];
    const edit=beginGeometryEdit({target,beginPreview:History.beginPreview.bind(History)});
    edit.preview({scale:2});
    if(reason==='clip-lock') target.locked=true;else State.videoTracks[0].locked=true;
    target.name='背景';History.record('背景鎖定');
    expect(edit.commit('不得提交')).toBe(false);
    expect(target.scale).toBeUndefined();expect(target.name).toBe('背景');
    expect(History.stack).toHaveLength(2);
  });

  it.each(['clip','track','history-reset'])('%s replacement 撤銷舊幾何 owner，取消不得改寫替代內容', reason => {
    const target=State.clips[0];
    const edit=beginGeometryEdit({target,beginPreview:History.beginPreview.bind(History)});
    edit.preview({scale:2});
    if(reason==='clip') State.clips=[{...target,scale:3}];
    else if(reason==='track') State.videoTracks[0]={name:'替代來源軌',visible:true,locked:false};
    else History.reset();
    expect(edit.commit('舊交易')).toBe(false);
    expect(State.clips[0].scale).toBe(reason==='clip'?3:2);
  });

  it('常用樣式草稿的幾何提交只修改草稿，不建立專案 History', () => {
    const draft={posX:50,posY:80};const recordHistory=vi.fn();
    let live=true;
    const edit=beginGeometryEdit({kind:'draft',target:draft,fields:['posX','posY'],owns:()=>live,recordHistory});
    edit.preview({posX:60,posY:70});expect(edit.commit('草稿位置')).toBe(true);
    expect(draft).toEqual({posX:60,posY:70});expect(recordHistory).not.toHaveBeenCalled();
    const stale=beginGeometryEdit({kind:'draft',target:draft,owns:()=>live});
    stale.preview({angle:15});live=false;stale.cancel();expect(draft.angle).toBe(15);
  });

  it.each(['clip','cue'])('來源軌不存在時拒絕開啟 %s 幾何交易', kind => {
    const target=kind==='clip' ? State.clips[0] : {id:'cue',track:0};
    if(kind==='clip') State.videoTracks=[];else {State.cues=[target];State.tracks=[];}
    expect(beginGeometryEdit({kind,target})).toBeNull();
  });
});
