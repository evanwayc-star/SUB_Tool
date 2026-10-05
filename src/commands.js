/* ==============================================================================
   SUB Tool — 指令註冊與派送中心 (Command Registry & Dispatch)
   ==============================================================================
   深層模組：集中註冊並派送全專案指令，直接串接各領域核心模組。
   ============================================================================== */
import { emit } from './events.js';
import { State, IS_DESKTOP, DESK } from './state.js';
import { Media } from './media.js';
import { AudioRouting } from './audio-routing.js';
import { runVideoExportCommand } from './export-job-engine.js';
import { showToast, openModal, closeModal, togglePanel, openCacheDialog } from './ui.js';
import { showSettingsModal } from './settings.js';
import { openSpeechRecognitionDialog } from './speech-recognition.js';
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
} from './timeline-renderer.js';
import {
  openMedia,
  openProject,
  saveProject,
  saveAsProject,
  startNewProject,
} from './project.js';
import { copySelectedStyle, pasteStyleToSelected } from './subtitles.js';
import { addNote, renderNotes, clearAllNotes, exportNotes } from './notes.js';
import { renderMixer, mixerReset, mixerMuteAll, mixerZeroFaders, mixerAdjustAllDb } from './mixer.js';
import { toggleSafeFrame, toggleTimecodeWatermark, _syncMpvPanel } from './video-renderer.js';
import { togglePointerSeekMode } from './timeline-interaction-engine.js';
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
    'asr-monitor': () => {
      openSpeechRecognitionDialog();
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
    'mixer-zero-faders': mixerZeroFaders,
    'mixer-step-down': () => mixerAdjustAllDb(-1),
    'mixer-step-up': () => mixerAdjustAllDb(1),

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
    'toggle-pointer-seek': togglePointerSeekMode,
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

export {
  createCommands,
  CLOSE_PANELS,
  timecodeSuffix,
  screenshotDir,
  fallbackScreenshotName,
  takeScreenshot,
};

/* ==============================================================================
   截圖檔名規則與編排實作 (Screenshot Target & Capture)
   ============================================================================== */

function timecodeSuffix(timecode) {
  if (!timecode) return '';
  return '_' + String(timecode).replace(/[:;]/g, '-');
}

function screenshotDir({ projectDir, mediaPath }) {
  let dir = projectDir || '';
  if (!dir && mediaPath) {
    const norm = String(mediaPath).replace(/\\/g, '/');
    const sep = norm.lastIndexOf('/');
    if (sep > 0) dir = String(mediaPath).substring(0, sep);
  }
  return dir ? dir.replace(/[\\/]+$/, '') : null;
}

function fallbackScreenshotName(displaySeconds, suffix = '') {
  return `Shot-${Math.floor(Math.max(0, +displaySeconds || 0))}${suffix}.jpg`;
}

let screenshotQueue=Promise.resolve();
function takeScreenshot(withTimecode=false){
  const task=screenshotQueue.then(()=>captureAndSaveScreenshot(withTimecode));
  screenshotQueue=task.catch(()=>{});
  return task;
}

async function captureAndSaveScreenshot(withTimecode){
  const { getProjectDir }=await import('./project.js');
  const { secToEncore }=await import('./time.js');
  const { setStatus }=await import('./ui.js');
  if(!State.duration&&!State.mediaPath){showToast('尚未載入影音');return;}
  const dir=screenshotDir({projectDir:getProjectDir(),mediaPath:State.mediaPath});
  let fullPath='';
  try{
    const {capturePreviewFrame}=await import('./video-renderer.js');
    const snapshot=await capturePreviewFrame({
      nativePath:dir&&IS_DESKTOP?dir+'/.subtool_temp_shot.jpg':null,
      readBase64:DESK?.readB64?path=>DESK.readB64(path):null,
    });
    const tc=withTimecode?secToEncore(snapshot.time,snapshot.fps,snapshot.dropFrame):'';
    const suffix=timecodeSuffix(tc);
    let name=fallbackScreenshotName(snapshot.time,suffix);
    if(dir&&IS_DESKTOP&&DESK?.reserveScreenshotPath){
      const reserved=await DESK.reserveScreenshotPath(dir,suffix);
      if(!reserved?.path) throw new Error('無法保留截圖檔名');
      fullPath=reserved.path;name=reserved.name;
    }
    const canvas=snapshot.canvas;
    if(withTimecode){
      const drawing=canvas.getContext('2d');
      const fontSize=Math.max(1,Math.floor(canvas.height*0.05));
      drawing.font='bold '+fontSize+'px monospace';drawing.textAlign='center';drawing.textBaseline='bottom';
      const x=canvas.width/2,y=canvas.height*0.95,textWidth=drawing.measureText(tc).width;
      drawing.fillStyle='rgba(0, 0, 0, 0.5)';
      drawing.fillRect(x-textWidth/2-10,y-fontSize-5,textWidth+20,fontSize+10);
      drawing.fillStyle='#fff';drawing.fillText(tc,x,y);
    }
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('無法編碼截圖')),'image/jpeg',0.9));
    if(fullPath&&DESK){
      const b64=await new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onloadend=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('無法讀取截圖'));
        reader.readAsDataURL(blob);
      });
      if(!await DESK.writeScreenshot(fullPath,b64)) throw new Error('截圖儲存失敗');
    }else{
      const url=URL.createObjectURL(blob);
      try{const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();}
      finally{URL.revokeObjectURL(url);}
    }
    setStatus(`截圖已儲存：${name}`,'ok');
  }catch(error){
    console.error('[screenshot]',error);showToast('截圖失敗：'+(error.message||String(error)));
  }finally{
    if(fullPath) await DESK?.releaseScreenshotPath?.(fullPath).catch(()=>{});
  }
}
