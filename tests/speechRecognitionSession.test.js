import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getAsrSession,
  setAsrSessionDialogOpen,
  cancelActiveAsrSession,
  onAsrSessionChange,
  clearAsrSession,
  startAsrWork
} from '../src/speech-recognition-session.js';

describe('語音辨識背景工作階段管理器 (speech-recognition-session)', () => {
  beforeEach(() => {
    clearAsrSession();
  });

  const startPendingWork = (initData = {}) => startAsrWork({
    clips: [{ id: 'pending', in: 0, out: 1 }],
    ...initData
  }, {
    extractAudio: async () => ({ duration: 1 }),
    transcribe: ({ signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve([]), { once: true });
    }),
    commit: vi.fn()
  });

  it('closes each bounded audio source after inference, including failure, without offsetting its source duration', async () => {
    const first = { duration: 100, readRange: vi.fn(), close: vi.fn() };
    const second = { duration: 200, readRange: vi.fn(), close: vi.fn() };
    const extractAudio = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const transcribe = vi.fn(async ({ clip, audioBuffer, inT, outT }) => {
      if (clip.id === 'one') { expect(outT).toBe(100); expect(inT).toBe(20); expect(audioBuffer).toBe(first); return []; }
      expect(first.close).toHaveBeenCalledTimes(1);
      throw new Error('provider failure');
    });
    const work = startAsrWork({ clips: [{ id: 'one', in: 20, dur: 3 }, { id: 'two', in: 30 }] }, {
      extractAudio, transcribe, commit: vi.fn()
    });
    await expect(work.promise).rejects.toThrow('provider failure');
    expect(first.close).toHaveBeenCalledTimes(1); expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('closes a late extracted reader when cancellation has already revoked its work', async () => {
    let resolve;
    const source = { duration: 10, readRange: vi.fn(), close: vi.fn() };
    const transcribe = vi.fn(), commit = vi.fn();
    const work = startAsrWork({ clips: [{ id: 'one', in: 0, out: 10 }] }, {
      extractAudio: () => new Promise(done => { resolve = done; }), transcribe, commit
    });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    work.cancel(); resolve(source);
    await expect(work.promise).resolves.toMatchObject({ status: 'cancelled' });
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(transcribe).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });

  it('同一工作同步更新對話框時，後續 listener 不得收到較舊快照',async()=>{
    let changed=false;
    const first=onAsrSessionChange(snapshot=>{
      if(snapshot?.progress.status==='preparing'&&!changed){changed=true;setAsrSessionDialogOpen(false,snapshot.id);}
    });
    const seen=[];const second=onAsrSessionChange(snapshot=>{
      if(snapshot?.progress.status==='preparing') seen.push(snapshot.dialogOpen);
    });
    const work=startPendingWork();
    try{
      expect(getAsrSession().dialogOpen).toBe(false);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(open=>open===false)).toBe(true);
    }finally{first();second();work.cancel();await work.promise;}
  });

  it.each([
    ['extracting','extractAudio'],['transcribing','transcribe'],['aligning','resolveAlignment'],
  ])('%s 通知同步取代工作時，不再呼叫舊 %s adapter',async(status,blockedAdapter)=>{
    let replacement,triggered=false;
    const release=vi.fn(),adapters={
      extractAudio:vi.fn(async()=>({duration:1})),
      transcribe:vi.fn(async()=>[]),
      resolveAlignment:vi.fn(async()=>({segments:[]})),
      commit:vi.fn(async()=>0),releaseResources:release,
    };
    const unsubscribe=onAsrSessionChange(snapshot=>{
      if(snapshot?.progress.status===status&&!triggered){
        triggered=true;replacement=startPendingWork({clips:[{id:'new',in:0,out:1}]});
      }
    });
    const old=startAsrWork({taskMode:'align',clips:[{id:'old',in:0,out:1}],transcript:'原稿'},adapters);
    try{
      await expect(old.promise).resolves.toMatchObject({status:'replaced'});
      expect(replacement).toBeTruthy();
      expect(adapters[blockedAdapter]).not.toHaveBeenCalled();
      expect(adapters.commit).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      expect(getAsrSession()?.id).toBe(replacement.id);
    }finally{unsubscribe();replacement?.cancel();if(replacement)await replacement.promise;}
  });

  it('準備通知同步啟動新工作時，舊 caller 不能取得新工作的 identity 或使用舊 adapters', async () => {
    let replacement;
    const oldExtract=vi.fn(async()=>({duration:1}));
    const unsubscribe=onAsrSessionChange(snapshot=>{
      if(snapshot?.progress.status==='preparing'&&!replacement){
        replacement=true;
        replacement=startPendingWork({clips:[{id:'replacement',in:0,out:1}]});
      }
    });
    const old=startAsrWork({clips:[{id:'original',in:0,out:1}]},{
      extractAudio:oldExtract,transcribe:async()=>[],commit:async()=>0,
    });
    unsubscribe();
    expect(old.id).not.toBe(replacement.id);
    expect(getAsrSession().id).toBe(replacement.id);
    await expect(old.promise).resolves.toMatchObject({status:'replaced'});
    expect(oldExtract).not.toHaveBeenCalled();
    replacement.cancel();await replacement.promise;
  });

  it('取消通知同步啟動新工作時，舊取消不能清除新工作', async () => {
    const old=startPendingWork({clips:[{id:'original',in:0,out:1}]});
    let replacement;
    const unsubscribe=onAsrSessionChange(snapshot=>{
      if(snapshot?.progress.status==='cancelled'&&!replacement){
        replacement=true;
        replacement=startPendingWork({clips:[{id:'replacement',in:0,out:1}]});
      }
    });
    old.cancel();unsubscribe();
    expect(getAsrSession()?.id).toBe(replacement.id);
    await expect(old.promise).resolves.toMatchObject({status:'cancelled'});
    replacement.cancel();await replacement.promise;
  });

  it('取消通知中再次取消同一工作時只通知及釋放一次', async () => {
    const releaseResources=vi.fn();
    const old=startAsrWork({clips:[{id:'original',in:0,out:1}]},{
      extractAudio:async()=>({duration:1}),
      transcribe:({signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true})),
      commit:vi.fn(),releaseResources,
    });
    let cancelledNotifications=0;
    const unsubscribe=onAsrSessionChange(snapshot=>{
      if(snapshot?.id===old.id&&snapshot.progress.status==='cancelled'){
        cancelledNotifications++;
        if(cancelledNotifications<4) cancelActiveAsrSession(old.id);
      }
    });
    old.cancel();unsubscribe();await old.promise;
    expect(cancelledNotifications).toBe(1);
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('已完成的工作收到遲到取消時保留成功結果', async () => {
    const work=startAsrWork({clips:[{id:'done',in:0,out:1}]},{
      extractAudio:async()=>({duration:1}),transcribe:async()=>[{start:0,end:1,text:'完成'}],
      commit:async()=>({count:1}),
    });
    await expect(work.promise).resolves.toMatchObject({status:'completed',count:1});
    work.cancel();
    expect(getAsrSession()).toMatchObject({id:work.id,progress:{status:'completed'},result:{count:1}});
  });

  it('清除通知中啟動新工作時，不再將舊的空快照送給後續訂閱者', async () => {
    const old=startPendingWork();let replacement,replaceOnce=false;
    const startNew=onAsrSessionChange(snapshot=>{
      if(!snapshot&&!replaceOnce){replaceOnce=true;replacement=startPendingWork();}
    });
    const observed=[];const observe=onAsrSessionChange(snapshot=>observed.push(snapshot?.id||null));
    clearAsrSession(old.id);startNew();observe();
    expect(getAsrSession()?.id).toBe(replacement.id);
    expect(observed.at(-1)).toBe(replacement.id);
    await old.promise;replacement.cancel();await replacement.promise;
  });

  it('清除通知中重複清除空工作時只通知一次', async () => {
    const work=startPendingWork();let notifications=0;
    const unsubscribe=onAsrSessionChange(snapshot=>{
      if(!snapshot){notifications++;if(notifications<4)clearAsrSession();}
    });
    clearAsrSession(work.id);unsubscribe();await work.promise;
    expect(notifications).toBe(1);
    expect(getAsrSession()).toBeNull();
  });

  it('重複設定相同視窗狀態不重入快照通知', async () => {
    const work=startPendingWork();let notifications=0;
    const unsubscribe=onAsrSessionChange(snapshot=>{
      if(snapshot?.id===work.id && !snapshot.dialogOpen){
        notifications++;
        if(notifications<4)setAsrSessionDialogOpen(false,work.id);
      }
    });
    expect(setAsrSessionDialogOpen(false,work.id)).toBe(true);
    unsubscribe();work.cancel();await work.promise;
    expect(notifications).toBe(1);
  });

  it('啟動完整工作時建立不可變初始快照並通知訂閱者', async () => {
    const events = [];
    const unsub = onAsrSessionChange(s => events.push(s ? { ...s } : null));

    const work = startPendingWork({
      taskMode: 'transcribe',
      provider: 'builtin',
      builtinModel: 'onnx-community/whisper-tiny',
      language: 'zh',
      clips: [{ id: 'clip-1', in: 0, out: 10, dur: 10 }],
      dialogOpen: true
    });
    const session = getAsrSession();

    expect(session).toBeTruthy();
    expect(session.id).toMatch(/^asr-\d+/);
    expect(session.progress.status).toBe('extracting');
    expect(session.progress.indeterminate).toBe(true);
    expect(session.dialogOpen).toBe(true);
    expect(getAsrSession()).toBe(session);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(event => event?.progress?.status === 'preparing')).toBe(true);

    unsub();
    work.cancel();
    await work.promise;
  });

  it('支援切換對話框開啟／背景執行狀態', async () => {
    const work = startPendingWork({ dialogOpen: true });
    expect(getAsrSession().dialogOpen).toBe(true);

    setAsrSessionDialogOpen(false, work.id);
    expect(getAsrSession().dialogOpen).toBe(false);

    setAsrSessionDialogOpen(true, work.id);
    expect(getAsrSession().dialogOpen).toBe(true);
    work.cancel();
    await work.promise;
  });

  it('辨識工作只公開不可變且不含密鑰、路徑或素材活物件的快照', async () => {
    const liveClip = {
      id: 'clip-private',
      name: 'private.mov',
      path: 'C:\\private\\private.mov',
      offset: 10,
      in: 2,
      out: 5,
      audioBuffer: { duration: 3 }
    };

    const work = startAsrWork({
      taskMode: 'transcribe',
      provider: 'openai',
      apiKey: 'secret-key',
      conf: { openaiApiKey: 'secret-key' },
      clips: [liveClip]
    }, {
      extractAudio: async clip => ({ duration: clip.out - clip.in }),
      transcribe: async () => [{ start: 0, end: 1, text: '完成' }],
      commit: async results => ({ count: results[0].segments.length })
    });

    const running = getAsrSession();
    expect(Object.isFrozen(running)).toBe(true);
    expect(Object.isFrozen(running.clips)).toBe(true);
    expect(running.clips[0]).not.toBe(liveClip);
    expect(running.clips[0]).toEqual(expect.objectContaining({
      id: 'clip-private', name: 'private.mov', offset: 10, in: 2, out: 5
    }));
    expect(running.clips[0]).not.toHaveProperty('path');
    expect(running.clips[0]).not.toHaveProperty('audioBuffer');
    expect(running).not.toHaveProperty('controller');
    expect(running).not.toHaveProperty('signal');
    expect(running).not.toHaveProperty('conf');
    expect(JSON.stringify(running)).not.toContain('secret-key');
    expect(JSON.stringify(running)).not.toContain('C:\\private');

    await expect(work.promise).resolves.toMatchObject({ status: 'completed', count: 1 });
  });

  it('公開失敗快照會遮蔽 provider 錯誤中的路徑、API key 與 URL', async () => {
    const work = startAsrWork({
      apiKey: 'api-key-123',
      clips: [{ id: 'private-error', path: 'C:\\private\\secret.mov', in: 0, out: 1 }]
    }, {
      extractAudio: async () => ({ duration: 1 }),
      transcribe: async () => {
        throw new Error('C:\\private\\secret.mov api-key-123 https://private.example/token');
      },
      commit: vi.fn()
    });

    await expect(work.promise).rejects.toThrow('secret.mov');
    const serialized = JSON.stringify(getAsrSession());
    expect(serialized).not.toContain('C:\\private');
    expect(serialized).not.toContain('api-key-123');
    expect(serialized).not.toContain('https://private.example');
    expect(getAsrSession().error.message).toContain('已隱藏');
  });

  it('工作開始時凍結時間軸 FPS，提交時不改讀外部狀態', async () => {
    const commit = vi.fn(() => ({ count: 1 }));
    const work = startAsrWork({
      timelineFps: 23.976,
      timelineDropFrame: true,
      clips: [{ id: 'fps-frozen', in: 0, out: 1 }]
    }, {
      extractAudio: async () => ({ duration: 1 }),
      transcribe: async () => [{ start: 0, end: 1, text: '完成' }],
      commit
    });

    await work.promise;

    expect(commit).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      timelineFps: 23.976,
      timelineDropFrame: true
    }));
  });

  it('session 邊界拒絕把同一份文本匹配稿套到多個素材', async () => {
    const commit = vi.fn();
    const work = startAsrWork({
      taskMode: 'align',
      transcript: '唯一一行',
      clips: [{ id: 'one' }, { id: 'two' }]
    }, {
      extractAudio: vi.fn(),
      transcribe: vi.fn(),
      commit
    });

    await expect(work.promise).rejects.toThrow('一次只能處理一個音訊來源');
    expect(commit).not.toHaveBeenCalled();
    expect(getAsrSession().progress.status).toBe('failed');
  });

  it('新工作取代舊工作後，忽略 abort 的晚到結果也不會提交', async () => {
    let releaseOld;
    const oldTranscription = new Promise(resolve => { releaseOld = resolve; });
    const oldCommit = vi.fn();
    const newCommit = vi.fn(() => ({ count: 1 }));
    const oldWork = startAsrWork({ clips: [{ id: 'old', in: 0, out: 1 }] }, {
      extractAudio: async () => ({ duration: 1 }),
      transcribe: () => oldTranscription,
      commit: oldCommit
    });
    await Promise.resolve();

    const newWork = startAsrWork({ clips: [{ id: 'new', in: 0, out: 1 }] }, {
      extractAudio: async () => ({ duration: 1 }),
      transcribe: async () => [{ start: 0, end: 1, text: '新結果' }],
      commit: newCommit
    });
    expect(setAsrSessionDialogOpen(false, oldWork.id)).toBe(false);
    expect(getAsrSession().dialogOpen).toBe(true);
    releaseOld([{ start: 0, end: 1, text: '舊結果' }]);

    await expect(oldWork.promise).resolves.toMatchObject({ status: 'replaced' });
    await expect(newWork.promise).resolves.toMatchObject({ status: 'completed' });
    expect(oldCommit).not.toHaveBeenCalled();
    expect(newCommit).toHaveBeenCalledOnce();
    expect(getAsrSession().result.count).toBe(1);
  });

  it('舊工作的晚到對齊結果不可覆蓋新工作的公開快照', async () => {
    let releaseAlignment;
    const oldWork = startAsrWork({
      taskMode: 'align',
      transcript: '舊文字',
      clips: [{ id: 'old-align', in: 0, out: 1 }]
    }, {
      extractAudio: async () => ({ duration: 1 }),
      transcribe: async () => [{ start: 0, end: 1, text: '舊證據' }],
      resolveAlignment: () => new Promise(resolve => { releaseAlignment = resolve; }),
      commit: vi.fn()
    });
    await vi.waitFor(() => expect(releaseAlignment).toBeTypeOf('function'));

    const newWork = startAsrWork({ clips: [{ id: 'new-active', in: 0, out: 1 }] }, {
      extractAudio: () => new Promise(() => {}),
      transcribe: vi.fn(),
      commit: vi.fn()
    });
    const newSessionId = getAsrSession().id;

    releaseAlignment({
      alignment: {
        status: 'recovered',
        segments: [{ alignment: { status: 'review' } }],
        summary: { reviewCount: 1 }
      },
      segments: [{ start: 0, end: 1, text: '舊文字' }]
    });

    await expect(oldWork.promise).resolves.toMatchObject({ status: 'replaced' });
    expect(getAsrSession().id).toBe(newSessionId);
    newWork.cancel();
  });

  it('使用者取消與新工作取代是不同的終止結果，且取消後不提交', async () => {
    let release;
    const commit = vi.fn();
    const work = startAsrWork({ clips: [{ id: 'cancelled', in: 0, out: 1 }] }, {
      extractAudio: async () => ({ duration: 1 }),
      transcribe: () => new Promise(resolve => { release = resolve; }),
      commit
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    cancelActiveAsrSession();
    release([{ start: 0, end: 1, text: '晚到' }]);

    await expect(work.promise).resolves.toMatchObject({ status: 'cancelled' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('多素材的公開進度保持單調，整批只提交一次', async () => {
    const percents = [];
    const unsubscribe = onAsrSessionChange(snapshot => {
      if (Number.isFinite(snapshot?.progress?.percent)) percents.push(snapshot.progress.percent);
    });
    const commit = vi.fn(() => ({ count: 2 }));
    let clipIndex = 0;
    const work = startAsrWork({
      clips: [
        { id: 'one', in: 0, out: 1 },
        { id: 'two', in: 0, out: 1 }
      ]
    }, {
      extractAudio: async () => ({ duration: 1 }),
      transcribe: async ({ onProgress }) => {
        onProgress({ status: 'transcribing', percent: clipIndex++ === 0 ? 100 : 5, indeterminate: false });
        return [{ start: 0, end: 1, text: '完成' }];
      },
      commit
    });

    await work.promise;
    unsubscribe();

    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents.at(-1)).toBe(100);
    expect(commit).toHaveBeenCalledOnce();
  });
});
