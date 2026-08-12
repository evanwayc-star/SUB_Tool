import { State, clearSelection } from '../state.js';
import { Media } from '../media.js';
import { drawTimeline, addTrack, setZoom, zoomFit, zoomFitVideo } from '../timeline.js';
import { recordHistory } from '../history.js';
import { emit } from '../events.js';
import { refreshMpvSubs } from '../video-renderer.js';

export function doAddTrack() {
  addTrack();
}

export function zoomIn() {
  setZoom(State.pxPerSec * 1.3);
}

export function zoomOut() {
  setZoom(State.pxPerSec * 0.77);
}

export function toggleZoomFit() {
  if (window._lastZoomMode === 'fit') { zoomFitVideo(); window._lastZoomMode = 'video'; }
  else { zoomFit(); window._lastZoomMode = 'fit'; }
}

export function toggleVideoTracks() {
  State.vtracksCollapsed = !State.vtracksCollapsed;
  const btn = document.getElementById('btnToggleVtracks');
  if (btn) btn.style.opacity = State.vtracksCollapsed ? '0.4' : '1';
  drawTimeline();
}

export function toggleAllVisibility() {
  const buses = State.audioProject?.buses || [];
  const anyVis = State.tracks.some(t => t.visible !== false) || State.videoTracks.some(t => t.visible !== false) || buses.some(t => t.visible !== false);
  State.tracks.forEach(t => t.visible = !anyVis);
  State.videoTracks.forEach(t => t.visible = !anyVis);
  buses.forEach(t => t.visible = !anyVis);
  recordHistory(anyVis ? '隱藏全部軌道' : '顯示全部軌道');
  drawTimeline(); emit('render:videoSub'); refreshMpvSubs();
}

export function toggleAllLock() {
  const buses = State.audioProject?.buses || [];
  const extAudio = Media.externalAudioSources || [];
  const anyUnlocked = State.tracks.some(t => !t.locked) || State.videoTracks.some(t => !t.locked) || buses.some(t => !t.locked) || State.clips.some(c => !c.locked) || extAudio.some(a => !a.locked);
  State.tracks.forEach(t => t.locked = anyUnlocked);
  State.videoTracks.forEach(t => t.locked = anyUnlocked);
  buses.forEach(t => t.locked = anyUnlocked);
  State.clips.forEach(c => c.locked = anyUnlocked);
  extAudio.forEach(a => a.locked = anyUnlocked);
  recordHistory(anyUnlocked ? '鎖定全部軌道' : '解鎖全部軌道');
  if (!anyUnlocked) { clearSelection(); const el = document.getElementById('stSel'); if (el) el.textContent = ''; }
  drawTimeline();
}
