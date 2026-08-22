/* ==============================================================================
   SUB Tool — 指令註冊與派送中心 (Command Registry & Dispatch)
   ==============================================================================
   深層模組：集中註冊並派送全專案指令，直接串接各領域核心模組。
   ============================================================================== */
import { emit } from './events.js';
import { State, IS_DESKTOP, DESK } from './state.js';
import { Media } from './media.js';
import { AudioRouting } from './audio-routing.js';
import { runVideoExportCommand } from './export-capability.js';
import { showToast, openModal, closeModal, togglePanel, openCacheDialog } from './ui.js';
import { showSettingsModal } from './settings.js';
import { importSub, showExportDialog, showExportVideoDialog, showFpsConvertDialog, applyTcShift, applyDurAdjTc, applyDurAdjPct } from './subio.js';
import { renderCheckPanel, deleteSelected } from './subtitles.js';
import {
  addCueRelative,
  trimTrackSpaces,
  removeSrtTags,
  toggleSubMode,
  toggleAutoSelect,
  toggleOverwriteMode,
  toggleOverwriteKeep,
  doCopyTrack,
  doCompareTrack,
} from './subtitle-model.js';
import {
  searchNext,
  searchPrev,
  searchClear,
  doSearchSelectAll,
  replaceOne,
  replaceAll,
} from './subtitle-search.js';
import {
  togglePlayPause,
  nudge,
  setIn,
  setOut,
  setExportIn,
  setExportOut,
  clearExport,
} from './transport-controller.js';
import {
  doAddTrack,
  zoomIn,
  zoomOut,
  toggleZoomFit,
  toggleVideoTracks,
  toggleAllVisibility,
  toggleAllLock,
} from './timeline.js';
import {
  openMedia,
  openProject,
  saveProject,
  saveAsProject,
  startNewProject,
} from './project.js';
import { takeScreenshot } from './screenshot-target.js';
import { copySelectedStyle, pasteStyleToSelected } from './style-commands.js';
import { addNote, renderNotes, clearAllNotes, exportNotes } from './notes.js';
import { renderMixer, mixerReset, mixerMuteAll } from './mixer.js';
import { toggleSafeFrame, toggleTimecodeWatermark, _syncMpvPanel } from './video-renderer.js';
import { History, renderHistory } from './history.js';
import { $ } from './dom.js';

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
    'open-media': openMedia,
    'open-project': openProject,
    'save-project': saveProject,
    'save-as-project': saveAsProject,
    'new': startNewProject,
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
    'queue-monitor': () => {
      if (!IS_DESKTOP || typeof DESK?.openQueueMonitor !== 'function') { showToast('匯出佇列只在桌面版提供'); return; }
      DESK.openQueueMonitor();
    },
    'audio-project-settings': () => {
      AudioRouting.openOutputSettings();
    },

    // Clips
    'split-clip': () => {
      if (State.selectedAudioClipId && typeof Media.splitExternalAudio === 'function')
        void Media.splitExternalAudio(State.selectedAudioClipId, Media.displayTime());
      else Media.splitClipAt(Media.displayTime());
    },
    'unlink-clip-audio': () => {
      const id = State.selectedClipId || Media.activeClip?.()?.id;
      if (!id) { showToast('請先選取要解除連結的影片段'); return; }
      if (typeof Media.detachClipAudio !== 'function') { showToast('影音解除連結功能尚未就緒'); return; }
      void Media.detachClipAudio(id);
    },

    // Timecode
    'fps-convert': showFpsConvertDialog,
    'shift-tc': () => togglePanel('shiftPanel'),
    'shift-back': () => applyTcShift(-1),
    'shift-fwd': () => applyTcShift(1),
    'dur-adj-sub': () => applyDurAdjTc(-1),
    'dur-adj-add': () => applyDurAdjTc(1),
    'dur-adj-pct': () => applyDurAdjPct(),

    // Subtitle Mode
    'sub-mode': () => toggleSubMode(false),

    // Playback
    'playpause': togglePlayPause,
    'back1': () => nudge(-1),
    'fwd1': () => nudge(1),
    'frame-back': () => nudge(-1 / (State.fps || 30)),
    'frame-fwd': () => nudge(1 / (State.fps || 30)),
    'set-in': setIn,
    'set-out': setOut,

    // Export Range
    'exp-in': setExportIn,
    'exp-out': setExportOut,
    'exp-clear': clearExport,

    // Subtitle Edit
    'add-cue-above': () => addCueRelative(-1),
    'add-cue-below': () => addCueRelative(1),
    'del-cue': () => deleteSelected(),
    'trim-track': () => trimTrackSpaces(),
    'copy-style': copySelectedStyle,
    'paste-style': pasteStyleToSelected,
    'remove-srt-tags': removeSrtTags,

    // Timeline & Tracks
    'add-track': doAddTrack,
    'copy-track': doCopyTrack,
    'compare-track': doCompareTrack,
    'zoom-in': zoomIn,
    'zoom-out': zoomOut,
    'zoom-fit': toggleZoomFit,
    'toggle-vtracks': toggleVideoTracks,
    'toggle-all-vis': toggleAllVisibility,
    'toggle-all-lock': toggleAllLock,

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
    'search-open': () => {
      const sd = $('searchDialog');
      if (sd) {
        sd.style.display = 'flex';
        emit('render:searchCount');
        $('searchInput').focus();
        emit('mpv:sync');
      }
    },
    'search-close': () => { const sd = $('searchDialog'); if (sd) { sd.style.display = 'none'; emit('mpv:sync'); } },
    'search-next': searchNext,
    'search-prev': searchPrev,
    'search-clear': searchClear,
    'search-select-all': doSearchSelectAll,
    'replace-one': replaceOne,
    'replace-all': replaceAll,

    // Settings / Dialogs
    'settings': showSettingsModal,
    'modal-close': closeModal,

    // Toggles
    'toggle-auto-select': toggleAutoSelect,
    'toggle-overwrite': toggleOverwriteMode,
    'toggle-ow-keep': toggleOverwriteKeep,
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
