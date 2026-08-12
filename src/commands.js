import { emit } from './events.js';
import { IS_DESKTOP } from './state.js';
import { runVideoExportCommand } from './export-capability.js';
import { showToast, openModal, closeModal } from './ui.js';
import { showSettingsModal } from './settings.js';
import { importSub, showExportDialog, showExportVideoDialog, showFpsConvertDialog, applyTcShift, applyDurAdjTc, applyDurAdjPct } from './subio.js';
import { renderCheckPanel } from './subtitles.js';
import { addNote, renderNotes, clearAllNotes, exportNotes } from './notes.js';
import { renderMixer, mixerReset, mixerMuteAll } from './mixer.js';
import { togglePanel } from './actions/panel-actions.js';
import { takeScreenshot } from './actions/screenshot-actions.js';
import { openCacheDialog } from './actions/cache-actions.js';
import { copySelectedStyle, pasteStyleToSelected } from './actions/style-actions.js';
import { doCopyTrack, doCompareTrack } from './actions/track-actions.js';
import { toggleSafeFrame, toggleTimecodeWatermark, _syncMpvPanel } from './video-renderer.js';
import { History, renderHistory } from './history.js';
import { $ } from './dom.js';

import * as ProjectActions from './actions/project-actions.js';
import * as PlaybackActions from './actions/playback-actions.js';
import * as TimelineActions from './actions/timeline-actions.js';
import * as SubtitleActions from './actions/subtitle-actions.js';

const CLOSE_PANELS = {
  'close-shift': 'shiftPanel',
  'close-history': 'historyPanel',
  'close-notes': 'notesPanel',
  'close-mixer': 'mixerPanel',
};

function createCommands() {
  const run = (id, opts) => registry.run(id, opts);

  const table = {
    // Project & Media
    'open-media': ProjectActions.openMedia,
    'open-project': ProjectActions.openProject,
    'save-project': ProjectActions.saveProject,
    'save-as-project': ProjectActions.saveAsProject,
    'new': ProjectActions.startNewProject,
    'cache-manage': openCacheDialog,

    // Subtitle I/O
    'imp-auto': importSub,
    'exp-dialog': showExportDialog,
    'exp-video': () => runVideoExportCommand({
      isDesktop: IS_DESKTOP,
      openExport: () => showExportVideoDialog(),
      notify: showToast,
      reportError: err => { console.error('匯出影片錯誤', err); showToast('匯出影片錯誤：' + err.message); },
    }),
    'export-notes': exportNotes,
    'queue-monitor': PlaybackActions.openQueueMonitor,
    'audio-project-settings': PlaybackActions.openAudioProjectSettings,

    // Clips
    'split-clip': PlaybackActions.splitClip,
    'unlink-clip-audio': PlaybackActions.unlinkClipAudio,

    // Timecode
    'fps-convert': showFpsConvertDialog,
    'shift-tc': () => togglePanel('shiftPanel'),
    'shift-back': () => applyTcShift(-1),
    'shift-fwd': () => applyTcShift(1),
    'dur-adj-sub': () => applyDurAdjTc(-1),
    'dur-adj-add': () => applyDurAdjTc(1),
    'dur-adj-pct': () => applyDurAdjPct(),

    // Subtitle Mode
    'sub-mode': () => SubtitleActions.toggleSubMode(false),

    // Playback
    'playpause': PlaybackActions.togglePlayPause,
    'back1': PlaybackActions.back1,
    'fwd1': PlaybackActions.fwd1,
    'frame-back': PlaybackActions.frameBack,
    'frame-fwd': PlaybackActions.frameFwd,
    'set-in': PlaybackActions.setInPoint,
    'set-out': PlaybackActions.setOutPoint,

    // Export Range
    'exp-in': PlaybackActions.setExportIn,
    'exp-out': PlaybackActions.setExportOut,
    'exp-clear': PlaybackActions.clearExport,

    // Subtitle Edit
    'add-cue-above': SubtitleActions.doAddCueAbove,
    'add-cue-below': SubtitleActions.doAddCueBelow,
    'del-cue': SubtitleActions.doDeleteSelectedCues,
    'trim-track': SubtitleActions.doTrimTrackSpaces,
    'copy-style': copySelectedStyle,
    'paste-style': pasteStyleToSelected,
    'remove-srt-tags': SubtitleActions.removeSrtTags,

    // Timeline & Tracks
    'add-track': TimelineActions.doAddTrack,
    'copy-track': doCopyTrack,
    'compare-track': doCompareTrack,
    'zoom-in': TimelineActions.zoomIn,
    'zoom-out': TimelineActions.zoomOut,
    'zoom-fit': TimelineActions.toggleZoomFit,
    'toggle-vtracks': TimelineActions.toggleVideoTracks,
    'toggle-all-vis': TimelineActions.toggleAllVisibility,
    'toggle-all-lock': TimelineActions.toggleAllLock,

    // History
    'undo': () => History.undo(),
    'redo': () => History.redo(),
    'history': () => { togglePanel('historyPanel'); renderHistory(); },

    // Notes
    'notes': () => { togglePanel('notesPanel'); renderNotes(); },
    'add-note': addNote,
    'clear-notes': clearAllNotes,

    // Mixer
    'mixer': () => { togglePanel('mixerPanel'); renderMixer(); },
    'mixer-reset': mixerReset,
    'mixer-muteall': mixerMuteAll,

    // Preview Tools
    'safe-frame': toggleSafeFrame,
    'timecode-watermark': toggleTimecodeWatermark,
    'screenshot': () => takeScreenshot(),
    'screenshot_tc': () => takeScreenshot(true),

    // Search and Validation
    'check-panel': () => {
      const btn = $('checkPanelBtn');
      const willShow = !$('checkPanel').classList.contains('show');
      togglePanel('checkPanel');
      if (btn) btn.classList.toggle('sub-active', willShow);
      if (willShow) renderCheckPanel();
    },
    'close-check': () => {
      $('checkPanel').classList.remove('show');
      const btn = $('checkPanelBtn'); if (btn) btn.classList.remove('sub-active');
      emit('mpv:sync');
    },
    'search-open': () => { const sd = $('searchDialog'); if (sd) { sd.style.display = 'flex'; $('searchInput').focus(); emit('mpv:sync'); } },
    'search-close': () => { const sd = $('searchDialog'); if (sd) { sd.style.display = 'none'; emit('mpv:sync'); } },
    'search-next': SubtitleActions.searchNext,
    'search-prev': SubtitleActions.searchPrev,
    'search-clear': SubtitleActions.searchClear,
    'search-select-all': SubtitleActions.doSearchSelectAll,
    'replace-one': SubtitleActions.replaceOne,
    'replace-all': SubtitleActions.replaceAll,

    // Settings / Dialogs
    'settings': showSettingsModal,
    'modal-close': closeModal,

    // Toggles
    'toggle-auto-select': SubtitleActions.toggleAutoSelect,
    'toggle-overwrite': SubtitleActions.toggleOverwriteMode,
    'toggle-ow-keep': SubtitleActions.toggleOverwriteKeep,
  };

  for (const [id, panel] of Object.entries(CLOSE_PANELS)) {
    table[id] = () => { $(panel).classList.remove('show'); _syncMpvPanel(); };
  }

  const registry = {
    ids() { return Object.keys(table); },
    has(id) { return Object.prototype.hasOwnProperty.call(table, id); },
    run(id, opts = {}) {
      const fn = table[id];
      if (!fn) return undefined;
      return fn(opts);
    },
  };
  return registry;
}

export { createCommands, CLOSE_PANELS };
