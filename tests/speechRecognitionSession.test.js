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
