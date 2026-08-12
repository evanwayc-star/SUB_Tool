import { State, saveConfig } from '../state.js';
import { Media } from '../media.js';
import { emit } from '../events.js';
import { setStatus } from '../ui.js';
import { recordHistory } from '../history.js';
import { addCueRelative, deleteSelected, sortCues, trimTrackSpaces } from '../subtitles.js';
import { searchNav, searchUpdate, searchSelectAll, searchReplace } from '../subtitles.js';
import { $ } from '../dom.js';

export function doAddCueAbove() { addCueRelative(-1); }
export function doAddCueBelow() { addCueRelative(1); }
export function doDeleteSelectedCues() { deleteSelected(); }
export function doTrimTrackSpaces() { trimTrackSpaces(); }

export function removeSrtTags() {
  let changed = false;
  State.cues.forEach(c => {
    if (c.text) {
      const nt = c.text.replace(/<[^>]+>|\{\\[^}]+\}/g, '');
      if (nt !== c.text) { c.text = nt; changed = true; }
    }
  });
  if (changed) { recordHistory('清除 SRT 標籤'); emit('render:all'); setStatus('已清除所有標籤', 'ok'); }
  else setStatus('未發現可清除的標籤', '');
}

export function toggleSubMode(force = false) {
  State.subMode = !State.subMode;
  { const smb = $('subModeBtn'); if (smb) smb.classList.toggle('sub-active', State.subMode); }
  document.body.classList.toggle('sub-mode-on', State.subMode);
  
  if (State.subMode) {
    State._prevAutoSelect = State.autoSelect;
    State._prevOverwriteMode = State.overwriteMode;
    State._prevOverwriteKeep = State.overwriteKeep;
    if (State.autoSelect) toggleAutoSelect({ force: true });
    if (State.overwriteMode) toggleOverwriteMode({ force: true });
    if (!State.overwriteKeep) toggleOverwriteKeep({ force: true });

    State._subModeSequence = State.cues.map(c => c.id);
    State._subModeTouchedIds = new Set();
    setStatus('🎯 上字幕模式 ON — I 設起點，O 設終點後自動前進', 'ok');
  } else {
    if (State._prevAutoSelect !== undefined && State.autoSelect !== State._prevAutoSelect) toggleAutoSelect({ force: true });
    if (State._prevOverwriteMode !== undefined && State.overwriteMode !== State._prevOverwriteMode) toggleOverwriteMode({ force: true });
    if (State._prevOverwriteKeep !== undefined && State.overwriteKeep !== State._prevOverwriteKeep) toggleOverwriteKeep({ force: true });

    let changed = false;
    State.cues.forEach(cue => {
      if (cue._tempEnd) {
        cue.end = Math.min(cue.start + 2.0, (State.duration || Infinity));
        delete cue._tempEnd;
        changed = true;
      }
    });
    if (State._subModeTouchedIds && State._subModeTouchedIds.size > 0) {
      const maxReasonableDur = 600;
      State.cues.forEach(cue => {
        if (State._subModeTouchedIds.has(cue.id)) {
          const dur = cue.end - cue.start;
          if (dur > maxReasonableDur) {
            cue.end = Math.min(cue.start + 2.0, (State.duration || Infinity));
            changed = true;
          }
        }
      });
      delete State._subModeTouchedIds;
    }
    sortCues();
    if (changed) { emit('render:videoSub'); emit('mpv:refreshSubs'); }
    emit('render:all');
    Media.pause(); setStatus('上字幕模式 OFF', '');
  }
}

export function toggleAutoSelect({ force } = {}) {
  if (State.subMode && !force) { setStatus('上字幕模式中強制關閉自動選取', 'err'); return; }
  State.autoSelect = !State.autoSelect;
  document.querySelectorAll('.auto-select-btn').forEach(btn => {
    btn.textContent = State.autoSelect ? '自動選取' : '不自動選取';
    btn.classList.toggle('on', State.autoSelect);
  });
  setStatus(`播放時自動選取：${State.autoSelect ? '開' : '關'}`, 'ok');
  saveConfig();
}

export function toggleOverwriteMode({ force } = {}) {
  if (State.subMode && !force) { setStatus('上字幕模式中強制鎖定不可覆蓋', 'err'); return; }
  State.overwriteMode = !State.overwriteMode;
  document.querySelectorAll('.ow-toggle-btn').forEach(btn => {
    btn.textContent = State.overwriteMode ? '🔓 可覆蓋' : '🔒 不覆蓋';
    btn.classList.toggle('primary', State.overwriteMode);
  });
  document.querySelectorAll('.ow-keep-btn').forEach(btn => {
    btn.classList.toggle('inactive-mode', !State.overwriteMode);
  });
  setStatus(`覆蓋模式：${State.overwriteMode ? '解鎖 (可自由重疊)' : '鎖定 (不可覆蓋)'}`, 'ok');
  saveConfig();
}

export function toggleOverwriteKeep({ force } = {}) {
  if (State.subMode && !force) { setStatus('上字幕模式中強制鎖定保留', 'err'); return; }
  State.overwriteKeep = !State.overwriteKeep;
  document.querySelectorAll('.ow-keep-btn').forEach(btn => {
    btn.textContent = State.overwriteKeep ? '⚪ 保留' : '❌ 刪除';
    btn.classList.toggle('del', !State.overwriteKeep);
  });
  setStatus(`完全覆蓋時：${State.overwriteKeep ? '保留' : '刪除'} 被包含的字幕`, 'ok');
  saveConfig();
}

export function searchNext() { searchNav(1); }
export function searchPrev() { searchNav(-1); }
export function searchClear() { $('searchInput').value = ''; searchUpdate(); $('searchInput').focus(); }
export function doSearchSelectAll() { searchSelectAll(); }
export function replaceOne() { searchReplace(false); }
export function replaceAll() { searchReplace(true); }
