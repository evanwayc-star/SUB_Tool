// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getScreenTextPlan, recognizeClipText } from '../src/screen-text-recognition.js';
import { State, setSelection } from '../src/state.js';
import { History, recordHistory } from '../src/history.js';
import { Project } from '../src/project.js';
import { beginCueEdit } from '../src/subtitle-model.js';
import * as timeline from '../src/timeline-renderer.js';

vi.mock('../src/history.js', async importOriginal => {
  const history = await importOriginal();
  return { ...history, recordHistory:vi.fn(history.recordHistory) };
});
vi.mock('../src/events.js', () => ({ emit:vi.fn(), on:vi.fn() }));

let clip, bridge, progress, releaseProgress, finish;
const options = { provider:'openai',model:'gpt-5.4-mini',sourceLang:'auto' };
beforeEach(() => {
  vi.clearAllMocks();
  clip = { id:'clip', path:'preview.mov', _originalPath:'mother.mov', in:3, out:7, offset:10, speed:2 };
  Object.assign(State, { clips:[clip], tracks:[{ name:'原有字幕' }], cues:[], listTrack:0, trackCount:1,
    duration:12, fps:25, dropFrame:false, activeEdge:'end', videoTracks:[], externalAudioState:[], exportIn:null, exportOut:null });
  setSelection({ kind:'video', ids:[clip.id] });
  releaseProgress = vi.fn();
  bridge = {
    recognizeScreenText:vi.fn(() => new Promise(resolve => { finish = resolve; })),
    cancelScreenText:vi.fn(async () => true),
    onScreenTextProgress:vi.fn(callback => { progress = callback; return releaseProgress; }),
  };
  window.subtool = bridge;
});

describe('整條時間軸與輸出範圍的畫面文字辨識', () => {
  function secondClip(changes = {}) {
    const second = { id:'second', name:'第二段', path:'second.mov', in:0, out:2, offset:12, ...changes };
    State.clips.push(second);
    return second;
  }

  it('跨片扣除本次新增請求，保存原文、來源秒數及相同片段的新位置',async()=>{
    secondClip();
    bridge.recognizeScreenText.mockResolvedValueOnce({cues:[{start:3,end:5,text:'原片字卡',kind:'card'}],metrics:{newRequests:2}})
      .mockResolvedValueOnce({cues:[{start:0,end:1,text:'對白',kind:'dialogue'}],metrics:{newRequests:1}});
    let review;
    await recognizeClipText(null,{...options,scope:'all',contentMode:'faithful',region:{x:0,y:.5,width:1,height:.5},maxNewRequests:3,
      reviewMode:true,stageReview:args=>{review=args;return 2;}});
    expect(bridge.recognizeScreenText.mock.calls.map(([req])=>req.maxNewRequests)).toEqual([3,1]);
    expect(State.cues).toHaveLength(0);
    clip.offset+=5;expect(review.changed()).toBe(true);
    const current=review.rebase(review.groups);expect(current).not.toBeNull();expect(review.apply(current)).toBe(2);
    expect(State.cues.find(c=>c.text==='原片字卡')).toMatchObject({start:15,end:16,recognition:{kind:'screen',sourceId:'clip',sourceStart:3,sourceEnd:5}});
  });

  it.each([[0,.00001,.00001],[.001,.002,.003],[.1,null,null],[null,.2,null],[undefined,undefined,undefined]])(
    '完成多來源估價 %s 與 %s，只加已回傳價格且未知保持未知',async(a,b,total)=>{
      secondClip();
      const metrics=value=>value===undefined?{windows:1}:{windows:1,estimatedCostUsd:value};
      bridge.recognizeScreenText.mockResolvedValueOnce({cues:[],metrics:metrics(a)}).mockResolvedValueOnce({cues:[],metrics:metrics(b)});
      const done=await recognizeClipText(null,{...options,scope:'all'});
      expect(done.metrics.estimatedCostUsd).toBe(total);
    });

  it('以可見影片分段，跳過純外音尾段、空白、隱藏軌與疊圖，保留片段參照', () => {
    Object.assign(clip, { offset:1, in:100, out:124 });
    const top = secondClip({ in:20, out:24, offset:4, speed:2, reverse:true, vtrack:1 });
    secondClip({ id:'hidden', offset:2, out:8, vtrack:2 });
    secondClip({ id:'overlay', offset:3, out:8, vtrack:3, type:'image' });
    State.videoTracks = [{},{},{ visible:false },{}];
    State.externalAudioState = [{ id:'music', in:0, out:15, offset:1 }];
    const { range, windows } = getScreenTextPlan(null, 'all');
    expect(range).toEqual({ start:0, end:16 });
    expect(windows.map(item => item.clip)).toEqual([clip,top,clip]);
    expect(windows.map(({ path,start,end,placement }) => [path,start,end,placement.offset])).toEqual([
      ['mother.mov',100,106,1], ['second.mov',20,24,4], ['mother.mov',110,124,6],
    ]);
  });

  it('舊影片的 start/dur 也使用相同的可見切點及母素材時間', () => {
    const old = { id:'legacy', path:'legacy.mov', start:4, dur:6, speed:2, reverse:true };
    State.clips = [old];
    const selected = getScreenTextPlan(old, 'clip');
    expect(selected.range).toEqual({ start:4, end:7 });
    expect(selected.windows[0]).toMatchObject({ clip:old, start:0, end:6, placement:{ offset:4, reverse:true } });
    State.exportIn = 5;
    State.exportOut = 6.5;
    expect(getScreenTextPlan(null, 'export').windows[0]).toMatchObject({
      start:1, end:4, placement:{ offset:5, speed:2, reverse:true },
    });
  });

  it('輸出 In/Out 裁切快轉及倒播上層，一次寫入原時間軸格點，背景更改輸出標記不影響工作', async () => {
    Object.assign(clip, { offset:0, in:100, out:124 });
    secondClip({ in:20, out:24, offset:3, speed:2, reverse:true, vtrack:1 });
    State.exportIn = 2.01;
    State.exportOut = 4.5;
    const plan = getScreenTextPlan(null,'export');
    const selectedElsewhere = { id:'removed' };
    const work = recognizeClipText(selectedElsewhere,{ ...options, plan });
    expect(bridge.recognizeScreenText.mock.calls[0][0]).toMatchObject({ path:'mother.mov', start:104.02, end:106 });
    finish({ cues:[{ start:104.02,end:106,text:'下層' }] });
    await Promise.resolve();
    expect(State.tracks).toHaveLength(1);
    expect(bridge.recognizeScreenText.mock.calls[1][0]).toMatchObject({ path:'second.mov', start:21, end:24 });
    State.exportOut = 9;
    State.fps = 30;
    finish({ cues:[{ start:21,end:22,text:'後半字卡' }, { start:22,end:24,text:'前半字卡' }] });
    await expect(work).resolves.toEqual({ count:3 });
    expect(State.cues.map(cue => [cue.start,cue.end,cue.text,cue.track])).toEqual([
      [2.04,3,'下層',1], [3,4,'前半字卡',1], [4,4.48,'後半字卡',1],
    ]);
    expect(recordHistory).toHaveBeenCalledOnce();
  });

  it('同母檔連續切點的字卡接為一句，文字曾消失或換鏡仍分句', async () => {
    vi.spyOn(timeline, 'drawTimeline').mockImplementation(() => {});
    Object.assign(clip, { in:0, out:2, offset:0, speed:1 });
    secondClip({ id:'b', path:'mother.mov', in:2, out:4, offset:2 });
    secondClip({ id:'c', path:'mother.mov', in:4, out:6, offset:4 });
    secondClip({ id:'d', path:'another.mov', in:6, out:8, offset:6 });
    secondClip({ id:'e', path:'another.mov', in:8, out:10, offset:10 });
    History.reset();
    bridge.recognizeScreenText.mockImplementation(async ({ start,end }) => ({
      cues:[{ start:start === 4 ? 4.5 : start, end, text:'同張字卡' }],
    }));
    await expect(recognizeClipText(null,{ ...options,scope:'all' })).resolves.toEqual({ count:4 });
    expect(State.cues.map(cue => [cue.start,cue.end])).toEqual([[0,4],[4.52,6],[6,8],[10,12]]);
    expect(recordHistory).toHaveBeenCalledOnce();
    History.undo();
    expect(State.tracks).toHaveLength(1);
    expect(State.cues).toHaveLength(0);
    History.redo();
    expect(State.cues.map(cue => [cue.start,cue.end])).toEqual([[0,4],[4.52,6],[6,8],[10,12]]);
  });

  it.each([
    ['center','card',1], ['top_left','card',2], ['center','dialogue',2],
  ])('連續母片跨切點的同文字依位置 %s 與分類 %s 決定是否合併', async (slot, kind, count) => {
    Object.assign(clip, { in:0, out:2, offset:0, speed:1 });
    secondClip({ id:'b', path:'mother.mov', in:2, out:4, offset:2 });
    bridge.recognizeScreenText.mockImplementation(async ({ start,end }) => ({
      cues:[{ start, end, text:'相同文字', kind:start === 0 ? 'card' : kind, slot:start === 0 ? 'center' : slot }],
    }));
    await expect(recognizeClipText(null,{ ...options,scope:'all' })).resolves.toEqual({ count });
    expect(State.cues.map(cue => [cue.start,cue.end])).toEqual(count === 1 ? [[0,4]] : [[0,2],[2,4]]);
  });

  it('進度依母素材窗長度加權，識別不同請求並忽略已完成窗口的遲到通知', async () => {
    secondClip();
    const onProgress = vi.fn();
    const work = recognizeClipText(null,{ ...options,scope:'all',onProgress });
    const first = bridge.recognizeScreenText.mock.calls[0][0];
    progress({ requestId:first.requestId,progress:0.5 });
    finish({ cues:[] });
    await Promise.resolve();
    const second = bridge.recognizeScreenText.mock.calls[1][0];
    expect(second.requestId).not.toBe(first.requestId);
    progress({ requestId:first.requestId,progress:1 });
    progress({ requestId:second.requestId,progress:0.5,message:'辨識中' });
    expect(onProgress.mock.calls.map(([value]) => value.progress)).toEqual([2/6,5/6]);
    expect(onProgress.mock.calls.at(-1)[0].message).toContain('2／2');
    finish({ cues:[] });
    await expect(work).resolves.toEqual({ count:0 });
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it('將完成的影片及停止點前的字幕保留到確認，依凍結格網一次加入與復原', async () => {
    vi.spyOn(timeline, 'drawTimeline').mockImplementation(() => {});
    secondClip();
    History.reset();
    const controller = new AbortController();
    const work = recognizeClipText(null, { ...options, scope:'all', signal:controller.signal });
    finish({ cues:[{ start:3, end:5, text:'第一段' }] });
    await Promise.resolve();
    const request = bridge.recognizeScreenText.mock.calls[1][0];
    controller.abort({ keepScreenTextResults:true });
    expect(bridge.cancelScreenText).toHaveBeenCalledWith(request.requestId, true);
    finish({ cancelled:true, processedEnd:0.93, cues:[{ start:0, end:0.93, text:'第二段開頭' }] });
    const draft = await work;
    expect(draft.count).toBe(2);
    expect(State.tracks).toHaveLength(1);
    expect(recordHistory).not.toHaveBeenCalled();
    State.fps = 30;
    expect(draft.commitPartial()).toBe(2);
    expect(State.cues.map(c => [c.start,c.end,c.text])).toEqual([[10,11,'第一段'],[12,12.92,'第二段開頭']]);
    expect(draft.commitPartial()).toBe(0);
    expect(recordHistory).toHaveBeenCalledOnce();
    History.undo();
    expect(State.tracks).toHaveLength(1);
    expect(State.cues).toHaveLength(0);
  });

  it('倒播的第一個窗口已讀到的來源前段映到片段尾端，起點不超出已讀範圍', async () => {
    clip.reverse = true;
    const controller = new AbortController();
    const work = recognizeClipText(clip, { ...options, signal:controller.signal });
    controller.abort({ keepScreenTextResults:true });
    finish({ cancelled:true, processedEnd:6.03, cues:[{ start:3, end:6.03, text:'部分結果' }] });
    const draft = await work;
    expect(State.cues).toHaveLength(0);
    expect(draft.commitPartial()).toBe(1);
    expect(State.cues[0]).toMatchObject({ start:10.52, end:12, text:'部分結果' });
  });

  it.each(['變更母片', '切換專案'])('確認前%s會撤銷部分結果的提交資格', async change => {
    let owns = true;
    vi.spyOn(Project,'captureWorkspaceOwnership').mockImplementation(() => () => owns);
    const controller = new AbortController();
    const work = recognizeClipText(clip, { ...options, signal:controller.signal });
    controller.abort({ keepScreenTextResults:true });
    finish({ cancelled:true, processedEnd:4, cues:[{ start:3, end:4, text:'部分結果' }] });
    const draft = await work;
    if (change === '變更母片') clip._originalPath = 'changed.mov';
    else owns = false;
    expect(() => draft.commitPartial()).toThrow();
    expect(State.tracks).toHaveLength(1);
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it('目前窗口剛完成才傳回取消時，結果仍須由使用者確認且不啟動後續窗口', async () => {
    secondClip();
    const controller = new AbortController();
    const work = recognizeClipText(null, { ...options, scope:'all', signal:controller.signal });
    finish({ cues:[{ start:3,end:7,text:'已完成' }] });
    controller.abort({ keepScreenTextResults:true });
    const draft = await work;
    expect(draft.count).toBe(1);
    expect(bridge.recognizeScreenText).toHaveBeenCalledOnce();
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it('停止前沒有字卡時不產生候選軌道', async () => {
    const controller = new AbortController();
    const work = recognizeClipText(clip, { ...options, signal:controller.signal });
    controller.abort({ keepScreenTextResults:true });
    finish({ cancelled:true, processedEnd:3, cues:[] });
    await expect(work).rejects.toMatchObject({ name:'AbortError' });
    expect(State.tracks).toHaveLength(1);
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it('停止整理中切換專案，強制丟棄遲到的部分結果', async () => {
    let invalidate;
    vi.spyOn(Project, 'onWorkspaceInvalidated').mockImplementation(callback => { invalidate = callback; return () => {}; });
    const controller = new AbortController();
    const work = recognizeClipText(clip, { ...options, signal:controller.signal });
    const { requestId } = bridge.recognizeScreenText.mock.calls[0][0];
    controller.abort({ keepScreenTextResults:true });
    invalidate();
    expect(bridge.cancelScreenText.mock.calls).toEqual([[requestId, true], [requestId]]);
    finish({ cancelled:true, processedEnd:4, cues:[{ start:3, end:4, text:'舊專案' }] });
    await expect(work).rejects.toMatchObject({ name:'AbortError' });
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it.each(['取消','換專案','解碼失敗','遮擋改變'])('第二段遇到%s，不新增先前完成的字幕', async action => {
    secondClip();
    let invalidate, reject;
    vi.spyOn(Project, 'onWorkspaceInvalidated').mockImplementation(callback => { invalidate = callback; return () => {}; });
    bridge.recognizeScreenText.mockResolvedValueOnce({ cues:[{ start:3,end:4,text:'不應插入' }] })
      .mockImplementationOnce(() => new Promise((resolve,fail) => { finish = resolve; reject = fail; }));
    const controller = new AbortController();
    const work = recognizeClipText(null,{ ...options,scope:'all',signal:controller.signal });
    await Promise.resolve();
    const second = bridge.recognizeScreenText.mock.calls[1][0];
    expect(State.tracks).toHaveLength(1);
    if (action === '取消') controller.abort();
    if (action === '換專案') invalidate();
    if (action === '遮擋改變') secondClip({ id:'cover', offset:10, vtrack:1 });
    if (action === '解碼失敗') reject(new Error('讀取失敗'));
    else finish({ cues:[{ start:0,end:1,text:'第二張' }] });
    if(action==='解碼失敗'){
      await expect(work).resolves.toMatchObject({count:1,error:'讀取失敗',commitPartial:expect.any(Function)});
    }else await expect(work).rejects.toThrow();
    if (action === '取消' || action === '換專案') expect(bridge.cancelScreenText).toHaveBeenCalledWith(second.requestId);
    expect(State.tracks).toHaveLength(1);
    expect(State.cues).toEqual([]);
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it('未重連影片僅在可見範圍內阻擋辨識，無影片或錯置 In/Out 在啟動前診斷', () => {
    const offline = { id:'offline', name:'離線鏡頭', path:'lost.mov', offset:10, in:0, out:2, vtrack:0 };
    vi.spyOn(Project,'unrestoredClips').mockReturnValue([offline]);
    clip.vtrack = 1;
    expect(getScreenTextPlan(null,'all').windows.map(item => item.clip)).toEqual([clip]);
    State.videoTracks = [{}, { visible:false }];
    expect(() => getScreenTextPlan(null,'all')).toThrow('重新連結影片「離線鏡頭」');
    State.exportIn = 2;
    State.exportOut = 5;
    expect(() => getScreenTextPlan(null,'export')).toThrow(expect.objectContaining({ range:{ start:2,end:5 } }));
    State.exportOut = 1;
    expect(() => getScreenTextPlan(null,'export')).toThrow('輸出範圍無效');
    expect(bridge.recognizeScreenText).not.toHaveBeenCalled();
  });
});
afterEach(() => { delete window.subtool; vi.restoreAllMocks(); });

describe('畫面文字辨識寫入時間軸', () => {
  it('同時出現的字卡和對白完整分軌，一次復原與重做保留分類及凍結時序', async () => {
    vi.spyOn(timeline, 'drawTimeline').mockImplementation(() => {});
    History.reset();
    const work = recognizeClipText(clip, options);
    State.fps = 30;
    finish({ cues:[
      { start:3.04, end:6.04, text:'主標題', kind:'card' },
      { start:3.12, end:5.12, text:'第二張字卡', kind:'card' },
      { start:3.2, end:6.2, text:'畫面上的對白', kind:'dialogue' },
    ] });
    await expect(work).resolves.toEqual({ count:3 });
    expect(State.tracks.map(track => track.name)).toEqual(['原有字幕','畫面字卡','畫面對白']);
    expect(State.cues.map(cue => [cue.track,cue.kind,cue.start,cue.end])).toEqual([
      [1,'card',10.04,11.52], [1,'card',10.08,11.08], [2,'dialogue',10.12,11.6],
    ]);
    expect(recordHistory).toHaveBeenCalledOnce();
    History.undo();
    expect(State.tracks.map(track => track.name)).toEqual(['原有字幕']);
    expect(State.cues).toHaveLength(0);
    History.redo();
    expect(State.tracks).toHaveLength(3);
    expect(State.cues.map(cue => cue.kind)).toEqual(['card','card','dialogue']);
  });

  it.each([
    [false, 10.52, 11.52],
    [true, 10.48, 11.48],
  ])('裁切片段使用母素材，依倍速與反轉 %s 吸附到專案格網', async (reverse, start, end) => {
    clip.reverse = reverse;
    const onProgress = vi.fn();
    const work = recognizeClipText(clip, { ...options, onProgress });
    const [request] = bridge.recognizeScreenText.mock.calls[0];
    expect(request).toMatchObject({ path:'mother.mov', start:3, end:7, provider:'openai',model:'gpt-5.4-mini',sourceLang:'auto', samplesPerSecond:10, frameWidth:1920 });
    progress({ requestId:'another', progress:0.1 });
    progress({ requestId:request.requestId, progress:0.5 });
    expect(onProgress).toHaveBeenCalledTimes(1);
    finish({ cues:[{ start:4.04, end:6.04, text:'안녕 Hello\nWOW' }] });
    await expect(work).resolves.toEqual({ count:1 });
    expect(State.tracks.map(track => track.name)).toEqual(['原有字幕','畫面字卡']);
    expect(State.cues).toEqual([expect.objectContaining({ text:'안녕 Hello\nWOW', track:1, start, end })]);
    expect(State).toMatchObject({ listTrack:1, selectedIds:[State.cues[0].id], activeTrackKind:'sub', activeEdge:'start' });
    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(releaseProgress).toHaveBeenCalledOnce();
  });

  it.each(['sub','video','audio'])('收起後保留完成當下的 %s 選取及字幕列表', async kind => {
    State.tracks.push({ name:'第二軌' });
    State.trackCount = 2;
    const workInBackground = vi.fn(() => false);
    const work = recognizeClipText(clip, { ...options, preserveSelection:workInBackground });
    expect(workInBackground).not.toHaveBeenCalled();
    workInBackground.mockReturnValue(true);
    State.listTrack = 1;
    State.cues.push({ id:'a', track:1, start:0, end:1, text:'第一句' }, { id:'b', track:1, start:1, end:2, text:'第二句' });
    const ids = kind === 'sub' ? ['a','b'] : kind === 'video' ? [clip.id] : ['music'];
    setSelection({ kind, ids, primary:ids[0] });
    finish({ cues:[{ start:4, end:5, text:'新增字卡' }] });
    await expect(work).resolves.toEqual({ count:1 });
    expect(workInBackground).toHaveBeenCalledOnce();
    expect(State).toMatchObject({ listTrack:1, activeTrackKind:kind, activeEdge:'end',
      selectedId:kind === 'sub' ? 'a' : null, selectedIds:kind === 'sub' ? ids : [],
      selectedClipId:kind === 'video' ? clip.id : null, selectedAudioClipId:kind === 'audio' ? 'music' : null });
    expect(State.cues.find(cue => cue.text === '新增字卡')?.track).toBe(2);
    expect(recordHistory).toHaveBeenCalledTimes(1);
  });

  it('背景提交保留文字草稿，復原時一次移除整軌且草稿沒有進入 OCR 的紀錄', async () => {
    vi.spyOn(timeline, 'drawTimeline').mockImplementation(() => {});
    const original = { id:'original', track:0, start:0, end:1, text:'原字幕' };
    State.cues.push(original);
    History.reset();
    const work = recognizeClipText(clip, { ...options, preserveSelection:() => true });
    setSelection({ kind:'sub', ids:[original.id] });
    const editor = beginCueEdit(original, { preview:true });
    try {
      editor.previewText('正在輸入的草稿');
      finish({ cues:[{ start:3, end:4, text:'第一張' }, { start:5, end:6, text:'第二張' }] });
      await expect(work).resolves.toEqual({ count:2 });
      expect(editor.isCurrent()).toBe(true);
      expect(original.text).toBe('正在輸入的草稿');
      expect(State).toMatchObject({ listTrack:0, selectedId:original.id, activeEdge:'end' });
      expect(History.stack.map(entry => entry.label)).toEqual(['初始','辨識畫面文字']);
      expect(History.stack[1].snap.cues.find(cue => cue.id === original.id).text).toBe('原字幕');
    } finally { editor.cancel(); }
    History.undo();
    expect(State.tracks.map(track => track.name)).toEqual(['原有字幕']);
    expect(State.cues).toEqual([{ ...original, text:'原字幕' }]);
    History.redo();
    expect(State.cues.map(cue => cue.text)).toEqual(['原字幕','第一張','第二張']);
  });

  it('空結果保留既有軌道與 History', async () => {
    const work = recognizeClipText(clip, options);
    finish({ cues:[] });
    await expect(work).resolves.toEqual({ count:0 });
    expect(State.tracks).toHaveLength(1);
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it('舊專案的主片段可用專案母檔，其他遺失路徑的片段不可借用', async () => {
    delete clip.path;
    delete clip._originalPath;
    State.mediaPath = 'primary.mov';
    try {
      await expect(recognizeClipText(clip, options)).rejects.toThrow('原始檔案');
      clip.primary = true;
      const work = recognizeClipText(clip, options);
      expect(bridge.recognizeScreenText).toHaveBeenCalledWith(expect.objectContaining({ path:'primary.mov' }));
      finish({ cues:[] });
      await work;
    } finally { State.mediaPath = null; }
  });

  it('背景復原另一筆字幕編輯時，舊片段的預設位置、速度及方向仍對應同一段畫面', async () => {
    vi.spyOn(timeline, 'drawTimeline').mockImplementation(() => {});
    clip.offset = 0;
    delete clip.speed;
    History.reset();
    State.cues.push({ id:'unrelated', track:0, start:0, end:1, text:'要復原的字幕' });
    History.record('新增字幕');
    delete clip.offset;
    const work = recognizeClipText(clip, { ...options, preserveSelection:() => true });
    History.undo();
    expect(State.clips[0]).toBe(clip);
    expect(clip).toMatchObject({ offset:0, speed:1, reverse:false });
    finish({ cues:[{ start:4, end:5, text:'字卡' }] });
    await expect(work).resolves.toEqual({ count:1 });
    expect(State.cues).toEqual([expect.objectContaining({ start:1, end:2, track:1, text:'字卡' })]);
    expect(History.stack.map(entry => entry.label)).toEqual(['初始','辨識畫面文字']);
  });

  it.each(['取消', '換專案', '修剪', '移動', '變速', '反轉', '移除'])('%s 後遲到的結果不建立字幕軌', async action => {
    let invalidated;
    const release = vi.fn();
    vi.spyOn(Project, 'onWorkspaceInvalidated').mockImplementation(callback => { invalidated = callback; return release; });
    const controller = new AbortController();
    const work = recognizeClipText(clip, { ...options, signal:controller.signal });
    if (action === '取消') controller.abort();
    if (action === '換專案') invalidated();
    if (action === '修剪') clip.out = 6;
    if (action === '移動') clip.offset = 1;
    if (action === '變速') clip.speed = 0.5;
    if (action === '反轉') clip.reverse = true;
    if (action === '移除') State.clips = [];
    finish({ cues:[{ start:3, end:4, text:'A' }] });
    await expect(work).rejects.toThrow();
    if (action === '取消' || action === '換專案') {
      expect(bridge.cancelScreenText).toHaveBeenCalledWith(bridge.recognizeScreenText.mock.calls[0][0].requestId);
    }
    expect(State.cues).toEqual([]);
    expect(State.tracks).toHaveLength(1);
    expect(releaseProgress).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
