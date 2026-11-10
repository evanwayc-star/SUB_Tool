import { State } from './state.js';
import { on } from './events.js';
import { getNativePreviewRuntime } from './media-player-adapter.js';
import { setStatus } from './ui.js';
import { Media } from './media.js';

let revision = 0;
let previewPending = false;
let applied = null;

// The same owner serves UI drafts and committed project/history restoration.
// A late native receipt can never commit a dismissed dialog or replace newer work.
export async function prepareProjectCanvasPreview(canvas, owns = () => true) {
  const runtime = getNativePreviewRuntime();
  const key = canvas ? `${canvas.width}x${canvas.height}` : 'auto';
  if (!previewPending && applied?.runtime === runtime && applied.key === key) return owns();
  const request = ++revision;
  const ownsMedia = Media.captureMediaOwnership?.() || (() => true);
  previewPending = true;
  applied = null;
  try {
    // FPS-SYNC: filter refresh never owns a second clock. Pause using the normal
    // transport, then re-present that timeline target only if no later seek won.
    let target = null, ownsTarget = () => false;
    if (Media.mpvMode) {
      Media.pause({ seekOnPause: false });
      target = Media.displayTime();
      ownsTarget = Media.capturePlaybackTargetOwnership();
      await runtime.pause();
      if (request !== revision || !owns()) return false;
    }
    const result = await runtime.setProjectCanvas(canvas);
    if (request !== revision || !owns()) return false;
    if (result !== true && result?.ok !== true) throw new Error(result?.error || '原生播放器未確認畫布已套用');
    if (target != null && ownsTarget() && !Media.playing) {
      const presented = await Media.seek(target);
      if (request !== revision || !owns()) return false;
      if (presented?.status === 'failed') throw new Error('畫布已更新，但播放器無法重新呈現目前畫格');
    }
    applied = { runtime, key };
    return true;
  } catch (error) {
    // Project restore may release the previous native source immediately after
    // its canvas event. The next launch carries that project's canvas itself.
    if (request !== revision || !owns() || !ownsMedia()) return false;
    throw error;
  } finally {
    if (request === revision) previewPending = false;
  }
}

export function syncProjectCanvasPreview() {
  const next = revision + 1;
  return prepareProjectCanvasPreview(State.projectCanvas ?? null).catch(error => {
    if (next === revision) setStatus('專案畫布預覽失敗：' + (error?.message || error), 'err');
    return false;
  });
}

export function cancelProjectCanvasPreview() {
  if (previewPending) void syncProjectCanvasPreview();
}

on('project:canvasChanged', () => { void syncProjectCanvasPreview(); });
