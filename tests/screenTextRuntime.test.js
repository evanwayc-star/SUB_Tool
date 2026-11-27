import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createScreenTextRuntime } = require('../electron/screen-text-runtime.js');
const { parse } = require('acorn');
const sender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false });
const request = () => ({ path: path.resolve('韓文片段.mkv'), start: 2, end: 6, requestId: 'screen-1',
  sourceLang: 'ko', provider: 'openai', model: 'gpt-5.4-mini', frameWidth: 1280, smartAccuracy: true });
const cues = [{ text: '오프닝 OPEN', start: 2, end: 3.5, kind: 'card' },
  { text: '對白', start: 3, end: 4, kind: 'dialogue' }];

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
  });
  const spawnChild = vi.fn(() => child), onProgress = vi.fn(), terminateChild = vi.fn();
  const executable = path.resolve('electron/card-vision/bin/win32-x64/subtool-card-vision.exe');
  const readSourceEvidence = vi.fn(() => ({ size: 100, mtimeNs: 1, ctimeNs: 1, dev: 1, ino: 1 }));
  const runtime = createScreenTextRuntime({ executable, settings: { apiKey: () => 'private-test-key' },
    cacheDir: 'private-cache', ffmpegPath: 'private-ffmpeg', ffprobePath: 'private-ffprobe',
    onProgress, spawnChild, terminateChild, readSourceEvidence });
  const message = data => child.stdout.write(JSON.stringify(data) + '\n');
  return { runtime, child, spawnChild, onProgress, executable, terminateChild, message, readSourceEvidence };
}

describe('畫面文字辨識 Rust/VLM 原生工作', () => {
  it('離線預覽不傳金鑰，回傳實際影格、尚待送出的張次及最多複檢數', async () => {
    const { runtime, child, message } = fixture();
    const pending = runtime.recognize(sender(), request(), true);
    await Promise.resolve();
    expect(JSON.parse(child.stdin.read().toString())).toMatchObject({operation:'plan', apiKey:''});
    const metrics = {windows:6, cachedWindows:2, pendingWindows:4, pendingImageAppearances:80, reviewMaxWindows:2};
    message({type:'plan', metrics, previewJpeg:'/9j/AA==', previewTime:2.5});
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({metrics, previewTime:2.5});
  });

  it('只用快取不提供金鑰，可讀回實際零費用', async () => {
    const { runtime, child, message } = fixture();
    const pending = runtime.recognize(sender(), {...request(), maxNewRequests:0});
    await Promise.resolve();
    expect(JSON.parse(child.stdin.read().toString())).toMatchObject({maxNewRequests:0, apiKey:''});
    message({type:'result', cues:[], processedEnd:6, metrics:{newRequests:0, estimatedCostUsd:0}});
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({metrics:{newRequests:0, estimatedCostUsd:0}});
  });

  it('雲端錯誤仍帶回前段字幕與最後一次請求數，避免下個素材少扣額度', async () => {
    const { runtime, child, message } = fixture();
    const pending = runtime.recognize(sender(), request());
    await Promise.resolve();
    message({type:'progress', progress:.2, metrics:{windows:3, newRequests:1}});
    message({type:'checkpoint', cues, processedEnd:4});
    message({type:'error', message:'HTTP 429', metrics:{newRequests:2}});
    child.emit('close', 1);
    await expect(pending).resolves.toMatchObject({cancelled:true, cues, processedEnd:4,
      error:'HTTP 429', metrics:{windows:3, newRequests:2}});
  });

  it('跨程序缺省請求使用旗艦1920及每秒10張，私有遷移記號不傳入原生程式', async () => {
    const { runtime, child, message } = fixture();
    const pending = runtime.recognize(sender(), { path:request().path, start:2, end:6, requestId:'defaults', qualityDefaultsVersion:1 });
    await Promise.resolve();
    const input = JSON.parse(child.stdin.read().toString());
    expect(input).toMatchObject({ provider:'openai', model:'gpt-5.4', frameWidth:1920, samplesPerSecond:10, smartAccuracy:true });
    expect(input).not.toHaveProperty('qualityDefaultsVersion');
    message({ type:'result', cues:[], processedEnd:6 });
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ cues:[], processedEnd:6 });
  });

  it('NTSC 輸出範圍的結果不得因跨行程一個 ULP 差異被當成程序清理失敗', async () => {
    const { runtime, child, message, terminateChild } = fixture();
    const start = 314 / (30000 / 1001), end = 1410 / (30000 / 1001);
    const recognized = [{ start: 47.014, end: 47.047, text: '으앗!!!', kind: 'card', slot: 'floating' }];
    terminateChild.mockRejectedValue(new Error('無法確認畫面辨識的影音子程序已停止，請重新啟動 SUB Tool 後再試'));
    const pending = runtime.recognize(sender(), { ...request(), start, end });
    await Promise.resolve();
    message({ type: 'result', cues: recognized, processedEnd: 47.047 });
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ cues: recognized, processedEnd: end });
    expect(terminateChild).not.toHaveBeenCalled();
  });

  it('只修正邊界的浮點誤差，保留範圍內時間並拒絕真正越界', async () => {
    const { runtime, child, message } = fixture();
    const pending = runtime.recognize(sender(), request());
    await Promise.resolve();
    const nearBoundary = [
      { start: 2 - Number.EPSILON, end: 3.14159, text: '起點', kind: 'card' },
      { start: 5.12345, end: 6 + 4 * Number.EPSILON, text: '終點', kind: 'dialogue' },
    ];
    message({ type: 'result', cues: nearBoundary, processedEnd: 6 + 4 * Number.EPSILON });
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ processedEnd: 6, cues: [
      { ...nearBoundary[0], start: 2 }, { ...nearBoundary[1], end: 6 },
    ] });

    const second = fixture();
    const rejected = second.runtime.recognize(sender(), request());
    await Promise.resolve();
    second.message({ type: 'result', processedEnd: 6,
      cues: [{ start: 2, end: 6 + 1e-7, text: '真正越界', kind: 'card' }] });
    second.child.emit('close', 0);
    await expect(rejected).rejects.toThrow('無效結果');
  });

  it('可信任工具與金鑰只走 stdin，分段 UTF-8 與兩種重疊字幕均保留', async () => {
    const { runtime, child, spawnChild, onProgress, executable } = fixture();
    const owner = sender(), input = request();
    const pending = runtime.recognize(owner, { ...input, apiKey: 'foreign', ffmpegPath: 'foreign', cacheDir: 'foreign', qualityDefaultsVersion: 1 });
    await Promise.resolve();
    expect(spawnChild).toHaveBeenCalledWith(executable, [], expect.objectContaining({ windowsHide: true }));
    expect(JSON.parse(child.stdin.read().toString())).toEqual({ ...input, samplesPerSecond: 10,
      apiKey: 'private-test-key', cacheDir: 'private-cache', ffmpegPath: 'private-ffmpeg', ffprobePath: 'private-ffprobe' });
    child.stdout.write('{"type":"progr');
    child.stdout.write('ess","progress":0.5,"message":"正在複檢"}\n');
    expect(onProgress).toHaveBeenCalledWith(owner, { requestId: input.requestId, progress: .5, message: '正在複檢' });
    const data = Buffer.from(JSON.stringify({ type: 'result', cues, processedEnd: 6 }) + '\n');
    const split = data.indexOf(Buffer.from('오')) + 1;
    child.stdout.write(data.subarray(0, split));
    child.stdout.write(data.subarray(split));
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ cues, processedEnd: 6 });
    expect(owner.listenerCount('destroyed')).toBe(0);
  });

  it('錯誤工作及其他視窗不能取消，取消後等整棵程序樹關閉才接受新工作', async () => {
    const { runtime, child, terminateChild } = fixture(), owner = sender();
    let finishTree;
    terminateChild.mockReturnValue(new Promise(resolve => { finishTree = resolve; }));
    const pending = runtime.recognize(owner, request());
    await Promise.resolve();
    expect(runtime.cancel(sender(), 'screen-1')).toBe(false);
    expect(runtime.cancel(owner, 'other')).toBe(false);
    expect(runtime.cancel(owner, 'screen-1')).toBe(true);
    await expect(runtime.recognize(owner, request())).rejects.toThrow('進行中');
    const draining = runtime.cancelAllAndWait();
    expect(terminateChild).toHaveBeenCalledTimes(1);
    child.emit('close', null);
    await expect(runtime.recognize(owner, request())).rejects.toThrow('進行中');
    finishTree();
    await expect(pending).rejects.toThrow('取消');
    await draining;
  });

  it('手動保留凍結已完成連續視窗，晚到回覆不越過保留邊界且不再開雲端程序', async () => {
    const { runtime, child, spawnChild, message, terminateChild } = fixture(), owner = sender();
    const pending = runtime.recognize(owner, request());
    await Promise.resolve();
    message({ type: 'checkpoint', cues, processedEnd: 4 });
    expect(runtime.cancel(owner, 'screen-1', true)).toBe(true);
    expect(runtime.cancel(owner, 'screen-1', true)).toBe(false);
    message({ type: 'result', cues: [...cues, { start: 5, end: 6, text: '晚到', kind: 'card' }], processedEnd: 6 });
    child.emit('close', null);
    await expect(pending).resolves.toEqual({ cancelled: true, processedEnd: 4, cues });
    expect(spawnChild).toHaveBeenCalledOnce();
    expect(terminateChild).toHaveBeenCalledOnce();
  });

  it('開始前取消沒有可加入字幕，完整結果到達後取消仍要讓使用者決定', async () => {
    for (const complete of [false, true]) {
      const { runtime, child, message } = fixture(), owner = sender();
      const pending = runtime.recognize(owner, request());
      await Promise.resolve();
      if (complete) message({ type: 'result', cues, processedEnd: 6 });
      runtime.cancel(owner, 'screen-1', true);
      child.emit('close', null);
      await expect(pending).resolves.toEqual({ cancelled: true, cues: complete ? cues : [], processedEnd: complete ? 6 : 2 });
    }
  });

  it.each([[{}, 'about:blank', false, true], [{isMainFrame:true, isSameDocument:false}]])(
    '保留期間換頁會捨棄資料，清除 sender 事件訂閱', async (...navigation) => {
    const { runtime, child, message } = fixture(), owner = sender();
    const pending = runtime.recognize(owner, request());
    await Promise.resolve();
    message({ type: 'checkpoint', cues, processedEnd: 4 });
    runtime.cancel(owner, 'screen-1', true);
    owner.emit('did-start-navigation', ...navigation);
    child.emit('close', null);
    await expect(pending).rejects.toThrow('取消');
    expect(owner.listenerCount('did-start-navigation')).toBe(0);
  });

  it.each([
    { type: 'checkpoint', cues, processedEnd: 3 },
    { type: 'checkpoint', cues: [], processedEnd: 8 },
    { type: 'result', cues, processedEnd: 4 },
    { type: 'result', cues: [{ start: 0, end: 8, text: '越界', kind: 'card' }], processedEnd: 6 },
    { type: 'result', cues: [{ start: 2, end: 3, text: '未知', kind: 'unknown' }], processedEnd: 6 },
  ])('拒絕超範圍或不完整結果：%j', async invalid => {
    const { runtime, child, message, terminateChild } = fixture();
    const pending = runtime.recognize(sender(), request());
    await Promise.resolve();
    message(invalid);
    expect(terminateChild).toHaveBeenCalledOnce();
    child.emit('close', 0);
    await expect(pending).rejects.toThrow('無效');
  });

  it('進度和錯誤訊息不可洩漏 API 金鑰', async () => {
    const { runtime, child, message, onProgress } = fixture();
    const pending = runtime.recognize(sender(), request());
    await Promise.resolve();
    message({ type: 'progress', progress: .1, message: 'private-test-key' });
    expect(onProgress.mock.calls[0][1].message).not.toContain('private-test-key');
    message({ type: 'error', message: 'failed private-test-key' });
    child.emit('close', 1);
    await expect(pending).rejects.toThrow('failed [已隱藏金鑰]');
  });

  it('額度不足顯示可處理的原因並等原生正常錯誤退出，不競爭殺掉已結束程序', async () => {
    const { runtime, child, message, terminateChild } = fixture();
    const pending = runtime.recognize(sender(), request());
    await Promise.resolve();
    message({ type: 'error', message: 'HTTP 429: project_spend_limit_exceeded' });
    child.emit('close', 1);
    await expect(pending).rejects.toThrow('專案支出上限已達');
    expect(terminateChild).not.toHaveBeenCalled();
  });

  it('未知供應商、語言、模型路徑和非法取樣率在啟動前拒絕', async () => {
    const { runtime, spawnChild } = fixture();
    for (const invalid of [{ sourceLang: 'xx' }, { provider: 'other' }, { model: '../secret' }, { samplesPerSecond: 0 }, { smartAccuracy: 'true' }]) {
      await expect(runtime.recognize(sender(), { ...request(), ...invalid })).rejects.toThrow();
    }
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it('來源在取消保留前被替換時拒絕匯入', async () => {
    const { runtime, child, message, readSourceEvidence } = fixture(), owner = sender();
    const pending = runtime.recognize(owner, request());
    await Promise.resolve();
    message({ type: 'checkpoint', cues, processedEnd: 4 });
    runtime.cancel(owner, 'screen-1', true);
    readSourceEvidence.mockReturnValue({ size: 101, mtimeNs: 2, ctimeNs: 2, dev: 1, ino: 1 });
    child.emit('close', null);
    await expect(pending).rejects.toThrow('來源影片已變更');
  });

  it('樹狀終止失敗不放行下一工作，也不把退出清理宣告成功', async () => {
    const { runtime, child, message, terminateChild } = fixture(), owner = sender();
    terminateChild.mockRejectedValue(new Error('無法確認影音子程序已停止'));
    const pending = runtime.recognize(owner, request());
    await Promise.resolve();
    runtime.cancel(owner, 'screen-1', true);
    message({ type:'checkpoint', requested:true, cues, processedEnd:4 });
    child.emit('close', null);
    await expect(pending).rejects.toThrow('無法確認');
    await expect(runtime.recognize(owner, request())).rejects.toThrow('進行中');
    await expect(runtime.cancelAllAndWait()).rejects.toThrow('無法確認');
  });

  it('main 拒絕其他視窗、未授權來源與退出中的工作', () => {
    const code = readFileSync('electron/main.js', 'utf8');
    const node = parse(code, { ecmaVersion: 'latest' }).body.find(item => item.expression?.arguments?.[0]?.value === 'ocr:recognize');
    const recognize = vi.fn(), main = sender(), input = request();
    let handler;
    const context = { ipcMain: { handle: (_, fn) => { handler = fn; } }, screenTextRuntime: { recognize },
      _isAppQuitting: false, isMainWindowSender: e => e.sender === main, requireReadablePath: vi.fn(() => { throw Error('未授權'); }) };
    runInNewContext(code.slice(node.start, node.end), context);
    expect(() => handler({ sender: sender() }, input)).toThrow('視窗');
    expect(() => handler({ sender: main }, input)).toThrow('未授權');
    expect(context.requireReadablePath).toHaveBeenCalledWith('ocr:recognize', input.path);
    context.requireReadablePath = vi.fn();
    context._isAppQuitting = true;
    expect(() => handler({ sender: main }, input)).toThrow();
    expect(recognize).not.toHaveBeenCalled();
    context._isAppQuitting = false;
    handler({ sender: main }, input);
    expect(recognize).toHaveBeenCalledWith(main, input);
  });
});
