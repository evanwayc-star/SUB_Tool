import { State } from './state.js';
import { Media, Wave } from './media.js';
import { $, video } from './dom.js';
import { secToEncore } from './time.js';
import { updatePlayhead, drawWave } from './timeline.js';
import { WCPreview } from './decode/player.js';
import { renderSeekBar } from './seekbar.js';
import { updateNoteActive } from './notes.js';
import { updateMeters } from './mixer.js';
import { selectCueSingle } from './subtitles.js';

let rafOn = false, rafFrame = 0, _rafLastIdx = 0;
let _rafId = null;

// Extracted from app.js line 266-321
export function rafLoop(renderVideoSubCallback) {
  if (Media.playing) {
    Media.seqTick();
    const t = Media.displayTime();
    if (!video.src || Media.inGap()) {
      $('tcCur').textContent = secToEncore(t, State.fps, State.dropFrame);
      renderSeekBar($('seekBar'), t);
    }
    // app.js has ensurePlayheadVisible() here. We'll pass it as callback.
    if (window._ensurePlayheadVisible) window._ensurePlayheadVisible();
    updatePlayhead();
    renderVideoSubCallback();
    if (Wave.live) { Wave.captureLive(); if ((rafFrame++ % 6) === 0) drawWave(); }
    
    const _t = t + 0.001;
    let act = null;
    if (_rafLastIdx >= 0 && _rafLastIdx < State.cues.length) {
      const lc = State.cues[_rafLastIdx];
      if (lc.timed !== false && _t >= lc.start && _t <= lc.end) act = lc;
    }
    if (!act) {
      const lo = Math.max(0, _rafLastIdx - 2), hi = Math.min(State.cues.length - 1, _rafLastIdx + 2);
      for (let i = lo; i <= hi; i++) {
        const c = State.cues[i]; if (c && c.timed !== false && _t >= c.start && _t <= c.end) { act = c; _rafLastIdx = i; break; }
      }
    }
    if (!act) {
      for (let i = 0; i < State.cues.length; i++) {
        const c = State.cues[i]; if (c.timed !== false && _t >= c.start && _t <= c.end) { act = c; _rafLastIdx = i; break; }
      }
    }
    if (act && act.id !== State.activeId) {
      State.activeId = act.id;
      if (window._markActiveRow) window._markActiveRow(act.id);
    }

    if (State.autoSelect) {
      const tk = State.listTrack || 0;
      if (act && (act.track || 0) === tk && act.id !== State.selectedId) {
        const editing = document.activeElement && document.activeElement.classList.contains('txt') && document.activeElement.contentEditable === 'true';
        if (!editing) {
          selectCueSingle(act.id, false);
        }
      }
    }

    if (State.notes.length && $('notesPanel').classList.contains('show')) updateNoteActive(t);
    Media.syncAudioDrift();
  }
  try { WCPreview.tick(); } catch (e) {}
  try { Media.applyPreviewFade(); } catch (e) {}
  updateMeters();
  _rafId = requestAnimationFrame(() => rafLoop(renderVideoSubCallback));
}

export function startAppTicker(renderVideoSubCallback) {
  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = requestAnimationFrame(() => rafLoop(renderVideoSubCallback));
}

export function stopAppTicker() {
  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = null;
}
