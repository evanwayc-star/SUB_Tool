import { Project } from './project.js';
import { getScreenTextPlan, recognizeClipText } from './screen-text-recognition.js';
import { SCREEN_TEXT_DEFAULTS as DEFAULTS, SCREEN_TEXT_DEFAULT_MODELS } from '../shared/screen-text-options.cjs';

const listeners = new Set();
let current = null;

export function getScreenTextSession() {
  return current?.snapshot ?? null;
}

export function onScreenTextSessionChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  const snapshot = getScreenTextSession();
  for (const listener of [...listeners]) {
    if (snapshot !== getScreenTextSession()) break;
    try { listener(snapshot); }
    catch (error) { console.error('畫面文字辨識狀態通知失敗', error); }
  }
}

function update(run, changes) {
  if (current !== run) return;
  run.snapshot = Object.freeze({ ...run.snapshot, ...changes });
  notify();
}

function forget(run) {
  if (current !== run) return;
  current = null;
  run.releaseWorkspace();
  notify();
}

function isPending(status) {
  return status === 'running' || status === 'cancelling';
}

async function execute(run, clip, plan) {
  const { provider, model, sourceLang, sampleFps, frameWidth, smartAccuracy, scope } = run.snapshot;
  try {
    const { count, commitPartial } = await recognizeClipText(clip, {
      provider, model, sourceLang, sampleFps, frameWidth, smartAccuracy, scope, plan, signal: run.controller.signal,
      preserveSelection: () => run.backgrounded,
      onProgress({ progress, message }) {
        if (run.snapshot.status !== 'running' || !Number.isFinite(progress)) return;
        update(run, { progress, message: message || '正在辨識畫面文字' });
      },
    });
    if (current !== run) return;
    if (commitPartial) {
      run.commitPartial = commitPartial;
      update(run, { status:'partial', count, message:`已停止辨識，已辨識到 ${count} 則字幕。要將這些字幕加入新軌嗎？` });
      return;
    }
    update(run, { status: 'completed', count, progress: 1,
      message: count ? `畫面文字辨識完成，已新增字幕軌與 ${count} 則字幕。` : '這個範圍沒有辨識到文字。' });
  } catch (error) {
    if (error?.name === 'AbortError') {
      update(run, { status: 'cancelled', message: '已取消畫面文字辨識，沒有可加入的字幕。' });
    } else {
      update(run, { status: 'failed', message: error?.message || '畫面文字辨識失敗，請重試。' });
    }
  }
}

export function startScreenTextSession(clip, {
  provider = DEFAULTS.provider, model = SCREEN_TEXT_DEFAULT_MODELS[provider], sourceLang = DEFAULTS.sourceLang,
  sampleFps = DEFAULTS.sampleFps, frameWidth = DEFAULTS.frameWidth, smartAccuracy = DEFAULTS.smartAccuracy, scope = 'clip',
}) {
  if (current && (isPending(current.snapshot.status) || current.snapshot.status === 'partial')) return current.snapshot;
  const plan = getScreenTextPlan(clip, scope);
  const scopeName = { all: '全片', export: '輸出 In／Out 範圍' }[scope];
  const run = {
    controller: new AbortController(),
    backgrounded: false,
    commitPartial: null,
    snapshot: Object.freeze({
      id: crypto.randomUUID(), clipName: scopeName || clip?.name || '影片片段',
      scope, range: Object.freeze({ ...plan.range }), windowCount: plan.windows.length,
      fps: plan.fps, dropFrame: plan.dropFrame,
      provider, model, sourceLang, sampleFps, frameWidth, smartAccuracy, status: 'running',
      progress: null, message: '正在擷取畫面並準備雲端辨識…', count: 0, dialogOpen: true,
    }),
  };
  current?.releaseWorkspace();
  current = run;
  run.releaseWorkspace = Project.onWorkspaceInvalidated(() => {
    run.controller.abort();
    forget(run);
  });
  notify();
  if (current === run) void execute(run, clip, plan);
  return run.snapshot;
}

export function setScreenTextDialogOpen(id, open) {
  const run = current;
  if (!run || run.snapshot.id !== id || run.snapshot.dialogOpen === open) return;
  if (!open && (isPending(run.snapshot.status) || run.snapshot.status === 'partial')) run.backgrounded = true;
  update(run, { dialogOpen: open });
}

export function cancelScreenTextSession(id) {
  const run = current;
  if (!run || run.snapshot.id !== id || run.snapshot.status !== 'running') return;
  run.controller.abort({ keepScreenTextResults:true });
  update(run, { status: 'cancelling', message: '正在停止辨識並整理已辨識的字幕…' });
}

export function resolveScreenTextPartial(id, addToTrack) {
  const run = current;
  if (!run || run.snapshot.id !== id || run.snapshot.status !== 'partial' || !run.commitPartial) return;
  const commit = run.commitPartial;
  run.commitPartial = null;
  if (!addToTrack) { forget(run); return; }
  try {
    const count = commit();
    update(run, { status:'completed', count, message:count ? `已將 ${count} 則字幕加入新的畫面文字辨識軌。` : '已辨識的字幕未達一個可加入的畫格。' });
  } catch (error) {
    update(run, { status:'failed', message:error?.message || '無法加入已辨識的字幕。' });
  }
}

export function clearScreenTextSession(id) {
  const run = current;
  if (run && run.snapshot.id === id && !isPending(run.snapshot.status) && run.snapshot.status !== 'partial') forget(run);
}
