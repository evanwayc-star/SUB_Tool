/* ==============================================================================
   SUB Tool — 指令表（"src/commands.js"）
   ==============================================================================
   全應用最寬的一個介面：index.html 的 79 個 `data-act` 按鈕、keyboard.js 的 22 個
   `emit('action', …)`、以及右鍵選單，全部靠同一組字串指令 id 觸發。

   【這個模組為什麼存在】
   這組指令原本是 app.js 裡一個 82 個 case 的 switch。app.js 有 2,805 行、28 個
   import、【零個 export】——於是這條全應用最寬的介面完全在測試之外，也沒有任何
   方法回答「index.html 上這顆按鈕的 data-act 真的有對應的實作嗎」。少一個 case
   的後果是：按鈕按下去什麼都不會發生，而且不會有錯誤訊息。

   攤成一張表之後：指令可列舉、可斷言完整性（見 tests/commands.test.js）。

   【依賴的兩種來源】
   - 能直接 import 的（Media、Project、字幕、時間軸、匯出…）就直接 import；
   - 只存在於 app.js 的畫面接線（togglePanel、renderAll、截圖…）由 createCommands(ctx)
     注入。ctx 是【有名字的一小組】，不是什麼都往裡塞的雜物袋——每加一個都代表
     app.js 又多一件事沒有自己的模組，該被看見。
============================================================================== */
import { $, video } from './dom.js';
import { State, ensureTrackCount, saveConfig, clearSelection, IS_DESKTOP, DESK } from './state.js';
import { pickFile } from './util.js';
import { fmtClock } from './time.js';
import { emit } from './events.js';
import { setStatus, showToast, openModal, closeModal } from './ui.js';
import { Project, resetProject, confirmDiscardUnsaved } from './project.js';
import { Media } from './media.js';
import { History, recordHistory, renderHistory } from './history.js';
import { AudioRouting } from './audio-routing.js';
import { showSettingsModal } from './settings.js';
import { importSub, showExportDialog, showExportVideoDialog,
  showFpsConvertDialog, applyTcShift, applyDurAdjTc, applyDurAdjPct } from './subio.js';
import { addCueRelative, deleteSelected, sortCues, renderCheckPanel,
  searchNav, searchUpdate, searchSelectAll, searchReplace, trimTrackSpaces } from './subtitles.js';
import { drawTimeline, addTrack, setZoom, zoomFit, zoomFitVideo } from './timeline.js';
import { addNote, renderNotes, clearAllNotes, exportNotes } from './notes.js';
import { renderMixer, mixerReset, mixerMuteAll, renderAudioTracks } from './mixer.js';
import { nudge, setIn, setOut, resetPlaybackSpeed } from './keyboard.js';

/* 面板關閉鈕：id → 要關掉的面板。四個都是同一件事，列成資料而不是四個 case。 */
const CLOSE_PANELS = {
  'close-shift': 'shiftPanel',
  'close-history': 'historyPanel',
  'close-notes': 'notesPanel',
  'close-mixer': 'mixerPanel',
};

function createCommands(ctx){
  /* 指令彼此呼叫（例如離開上字幕模式要把三個開關切回去）走這裡，
     而不是各自複製一份邏輯。 */
  const run = (id, opts) => registry.run(id, opts);

  const table = {
    /* ── 專案與媒體 ─────────────────────────────────────────────────── */
    'open-media': async () => {
      // 先在打開 picker 前凍結目前 restore transaction；否則使用者等檔案選擇器
      // 開著時載入另一個專案，回來的舊檔案會錯套到新專案的 restore plan。
      const relink = Project.pendingMediaRelink?.() || null;
      if (relink) {
        await Project.continueLoad(relink.generation, async isCurrent => {
          const picked = IS_DESKTOP ? await DESK.openMedia() : await ctx.pickMediaFiles($('fileMedia'));
          if (!isCurrent()) return;
          if (IS_DESKTOP) await ctx.importDesktopMediaFiles(picked, relink);
          else await ctx.importBrowserMediaFiles(picked, relink);
        });
      } else if (IS_DESKTOP) await ctx.importDesktopMediaFiles(await DESK.openMedia());
      else await ctx.importBrowserMediaFiles(await ctx.pickMediaFiles($('fileMedia')));
    },
    // 先問過再開檔案選擇器：讓使用者挑完檔案才說「你有未存檔的變更」很惱人。
    'open-project': async () => {
      if (!await confirmDiscardUnsaved()) return;
      if (IS_DESKTOP) { const r = await DESK.openProject(); if (r) Project.loadDesktop(r); }
      else { const f = await pickFile($('fileProject')); if (f) Project.load(f); }
    },
    'save-project': () => Project.save(),
    'save-as-project': () => Project.saveAs(),
    'new': () => {
      // Fix #15 同款：破壞性動作改用 openModal，風格一致且 Electron 不會截取原生 confirm
      openModal('開新專案',
        '<p>確定清空目前專案？字幕、備註與已載入的影音都將清除（未存檔的話）。</p>',
        [{ label: '取消', act: closeModal },
         { label: '確定清空', primary: true, act: () => {
           closeModal();
           return Project.startNewProject(() => {
             State.cues = []; State.notes = [];
             clearSelection();
             State.listTrack = 0; State.tracks = []; ensureTrackCount(0);
             if (State.subMode) run('sub-mode');
             // 先重置可持久專案資料（含 audioProject），再建立空白專案的 undo 基線；
             // 否則 Ctrl+Z 可能把上一個專案的聲道路由帶回新專案。
             resetProject(); ctx.resetFirstLoad();
             // 清除影音
             video.pause(); video.removeAttribute('src'); video.load();
             State.mediaName = ''; State.mediaPath = ''; State.mediaSize = 0;
             Media.reset();
             History.reset();
             const nv = $('noVideo'); if (nv) nv.style.display = '';
             ctx.onDurationKnown(); renderAudioTracks();
             ctx.renderListTrackSel(); ctx.renderAll(); renderNotes(); drawTimeline();
             setStatus('新專案', 'ok');
           });
         } }]);
    },
    'cache-manage': () => ctx.openCacheDialog(),

    /* ── 字幕匯入匯出 ───────────────────────────────────────────────── */
    'imp-auto': () => importSub(),
    'exp-dialog': () => showExportDialog(),
    'exp-video': () => showExportVideoDialog().catch(err => {
      console.error('匯出影片錯誤', err); showToast('匯出影片錯誤：' + err.message);
    }),
    'export-notes': () => exportNotes(),
    /* 監控序列：原本只有狀態列按鈕的 onclick 直接呼叫 DESK，沒有進指令表，
       所以沒辦法綁快捷鍵、也不在 tests/commands.test.js 的對稱檢查裡。 */
    'queue-monitor': () => {
      if (!IS_DESKTOP || typeof DESK.openQueueMonitor !== 'function') { showToast('匯出佇列只在桌面版提供'); return; }
      DESK.openQueueMonitor();
    },
    'audio-project-settings': () => AudioRouting.openOutputSettings(),

    /* ── 影片段 ─────────────────────────────────────────────────────── */
    // 同 Ctrl+K：音訊已選取時切音訊，否則切影片段
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

    /* ── 時碼工具 ───────────────────────────────────────────────────── */
    'fps-convert': () => showFpsConvertDialog(),
    'shift-tc': () => ctx.togglePanel('shiftPanel'),
    'shift-back': () => applyTcShift(-1),
    'shift-fwd': () => applyTcShift(1),
    'dur-adj-sub': () => applyDurAdjTc(-1),
    'dur-adj-add': () => applyDurAdjTc(1),
    'dur-adj-pct': () => applyDurAdjPct(),

    /* ── 上字幕模式 ─────────────────────────────────────────────────── */
    'sub-mode': () => {
      State.subMode = !State.subMode;
      { const smb = $('subModeBtn'); if (smb) smb.classList.toggle('sub-active', State.subMode); }
      document.body.classList.toggle('sub-mode-on', State.subMode);
      if (State.subMode) {
        State._prevAutoSelect = State.autoSelect;
        State._prevOverwriteMode = State.overwriteMode;
        State._prevOverwriteKeep = State.overwriteKeep;
        if (State.autoSelect) run('toggle-auto-select', { force: true });
        if (State.overwriteMode) run('toggle-overwrite', { force: true });
        if (!State.overwriteKeep) run('toggle-ow-keep', { force: true });

        // 擷取當時的完整字幕 ID 順序
        State._subModeSequence = State.cues.map(c => c.id);
        // 追蹤 subMode 期間被 I 鍵設定的字幕 ID（退出時作為安全網清理依據）
        State._subModeTouchedIds = new Set();

        setStatus('🎯 上字幕模式 ON — I 設起點，O 設終點後自動前進', 'ok');
      } else {
        if (State._prevAutoSelect !== undefined && State.autoSelect !== State._prevAutoSelect) run('toggle-auto-select', { force: true });
        if (State._prevOverwriteMode !== undefined && State.overwriteMode !== State._prevOverwriteMode) run('toggle-overwrite', { force: true });
        if (State._prevOverwriteKeep !== undefined && State.overwriteKeep !== State._prevOverwriteKeep) run('toggle-ow-keep', { force: true });

        // 清理殘留的未閉合超長字幕
        let changed = false;
        // 第一層：清理帶有 _tempEnd 標記的字幕
        State.cues.forEach(cue => {
          if (cue._tempEnd) {
            cue.end = Math.min(cue.start + 2.0, (State.duration || Infinity));
            delete cue._tempEnd;
            changed = true;
          }
        });
        // 第二層安全網：檢查所有在 subMode 期間被 I 鍵觸碰過的字幕
        // 即使 _tempEnd 已被意外清除，若 end 仍然異常長（>10 分鐘），也修正回來
        if (State._subModeTouchedIds && State._subModeTouchedIds.size > 0) {
          const maxReasonableDur = 600; // 10 分鐘，超過視為異常
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
        // 脫離上字幕模式後強制重新排序，並觸發重繪
        sortCues();
        if (changed) { emit('render:videoSub'); emit('mpv:refreshSubs'); }
        emit('render:all');

        Media.pause(); setStatus('上字幕模式 OFF', '');
      }
    },

    /* ── 播放與導航 ─────────────────────────────────────────────────── */
    'playpause': () => {
      resetPlaybackSpeed(); // 重置 JKL 穿梭速度回 1x（清掉殘留的倍率）
      Media.toggle();
      setStatus(Media.playing ? '▶ 正播' : '⏸ 暫停', Media.playing ? 'ok' : ''); // 狀態列同步播放/暫停（非僅 JKL）
    },
    'back1': () => nudge(-1),
    'fwd1': () => nudge(1),
    'frame-back': () => nudge(-1 / State.fps),
    'frame-fwd': () => nudge(1 / State.fps),
    'set-in': () => setIn(),
    'set-out': () => setOut(),

    /* ── 輸出範圍 ───────────────────────────────────────────────────── */
    'exp-in': () => { State.exportIn = Media.displayTime(); drawTimeline(); recordHistory('設定輸出起點 [In]'); setStatus(`輸出起點已設為 ${fmtClock(State.exportIn)}`, 'ok'); },
    'exp-out': () => { State.exportOut = Media.displayTime(); drawTimeline(); recordHistory('設定輸出終點 [Out]'); setStatus(`輸出終點已設為 ${fmtClock(State.exportOut)}`, 'ok'); },
    'exp-clear': () => { State.exportIn = null; State.exportOut = null; drawTimeline(); recordHistory('清除輸出範圍'); setStatus('輸出範圍已清除', 'ok'); },

    /* ── 字幕編輯 ───────────────────────────────────────────────────── */
    'add-cue-above': () => addCueRelative(-1),
    'add-cue-below': () => addCueRelative(1),
    'del-cue': () => deleteSelected(),
    'trim-track': () => trimTrackSpaces(),
    'copy-style': () => ctx.copySelectedStyle(),
    'paste-style': () => ctx.pasteStyleToSelected(),
    'remove-srt-tags': () => {
      let changed = false;
      State.cues.forEach(c => {
        if (c.text) {
          const nt = c.text.replace(/<[^>]+>|\{\\[^}]+\}/g, '');
          if (nt !== c.text) { c.text = nt; changed = true; }
        }
      });
      if (changed) { recordHistory('清除 SRT 標籤'); emit('render:all'); setStatus('已清除所有標籤', 'ok'); }
      else setStatus('未發現可清除的標籤', '');
    },

    /* ── 軌道與時間軸 ───────────────────────────────────────────────── */
    'add-track': () => addTrack(),
    'copy-track': () => ctx.doCopyTrack(),
    'compare-track': () => ctx.doCompareTrack(),
    'zoom-in': () => setZoom(State.pxPerSec * 1.3),
    'zoom-out': () => setZoom(State.pxPerSec * 0.77),
    'zoom-fit': () => {
      if (window._lastZoomMode === 'fit') { zoomFitVideo(); window._lastZoomMode = 'video'; }
      else { zoomFit(); window._lastZoomMode = 'fit'; }
    },
    'toggle-vtracks': () => {
      State.vtracksCollapsed = !State.vtracksCollapsed;
      const btn = document.getElementById('btnToggleVtracks');
      if (btn) btn.style.opacity = State.vtracksCollapsed ? '0.4' : '1';
      drawTimeline();
    },
    'toggle-all-vis': () => {
      const buses = State.audioProject?.buses || [];
      const anyVis = State.tracks.some(t => t.visible !== false) || State.videoTracks.some(t => t.visible !== false) || buses.some(t => t.visible !== false);
      State.tracks.forEach(t => t.visible = !anyVis);
      State.videoTracks.forEach(t => t.visible = !anyVis);
      buses.forEach(t => t.visible = !anyVis);
      recordHistory(anyVis ? '隱藏全部軌道' : '顯示全部軌道');
      drawTimeline(); ctx.renderVideoSub(); ctx.refreshMpvSubs();
    },
    'toggle-all-lock': () => {
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
    },

    /* ── 歷史 ───────────────────────────────────────────────────────── */
    'undo': () => History.undo(),
    'redo': () => History.redo(),
    'history': () => { ctx.togglePanel('historyPanel'); renderHistory(); },

    /* ── 備註 ───────────────────────────────────────────────────────── */
    'notes': () => { ctx.togglePanel('notesPanel'); renderNotes(); },
    'add-note': () => addNote(),
    'clear-notes': () => clearAllNotes(),

    /* ── 混音器 ─────────────────────────────────────────────────────── */
    'mixer': () => { ctx.togglePanel('mixerPanel'); renderMixer(); },
    'mixer-reset': () => mixerReset(),
    'mixer-muteall': () => mixerMuteAll(),

    /* ── 預覽輔助 ───────────────────────────────────────────────────── */
    'safe-frame': () => ctx.toggleSafeFrame(),
    'timecode-watermark': () => ctx.toggleTimecodeWatermark(),
    'screenshot': () => ctx.takeScreenshot(),
    'screenshot_tc': () => ctx.takeScreenshot(true),

    /* ── 檢查面板與搜尋 ─────────────────────────────────────────────── */
    'check-panel': () => {
      const btn = $('checkPanelBtn');
      const willShow = !$('checkPanel').classList.contains('show');
      ctx.togglePanel('checkPanel');
      if (btn) btn.classList.toggle('sub-active', willShow);
      if (willShow) renderCheckPanel();
    },
    'close-check': () => {
      $('checkPanel').classList.remove('show');
      const btn = $('checkPanelBtn'); if (btn) btn.classList.remove('sub-active');
      ctx.syncMpvPanel();
    },
    'search-open': () => {
      const sd = $('searchDialog');
      if (!sd) return;
      const show = sd.style.display === 'none' || !sd.style.display;
      sd.style.display = show ? 'flex' : 'none';
      if (show) setTimeout(() => $('searchInput')?.focus(), 20);
      ctx.syncMpvPanel();
    },
    'search-close': () => { const sd = $('searchDialog'); if (sd) { sd.style.display = 'none'; ctx.syncMpvPanel(); } },
    'search-next': () => searchNav(1),
    'search-prev': () => searchNav(-1),
    'search-clear': () => { $('searchInput').value = ''; searchUpdate(); $('searchInput').focus(); },
    'search-select-all': () => searchSelectAll(),
    'replace-one': () => searchReplace(false),
    'replace-all': () => searchReplace(true),

    /* ── 設定與對話框 ───────────────────────────────────────────────── */
    'settings': () => showSettingsModal(),
    'modal-close': () => closeModal(),

    /* ── 三個編輯開關 ───────────────────────────────────────────────────
       上字幕模式會強制固定這三個開關，只有 force（由 sub-mode 自己呼叫）
       才准在模式中切換——否則使用者在模式中按到按鈕就會破壞模式的前提。 */
    'toggle-auto-select': ({ force } = {}) => {
      if (State.subMode && !force) { setStatus('上字幕模式中強制關閉自動選取', 'err'); return; }
      State.autoSelect = !State.autoSelect;
      document.querySelectorAll('.auto-select-btn').forEach(btn => {
        btn.textContent = State.autoSelect ? '自動選取' : '不自動選取';
        btn.classList.toggle('on', State.autoSelect);
      });
      setStatus(`播放時自動選取：${State.autoSelect ? '開' : '關'}`, 'ok');
      saveConfig();
    },
    'toggle-overwrite': ({ force } = {}) => {
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
    },
    'toggle-ow-keep': ({ force } = {}) => {
      if (State.subMode && !force) { setStatus('上字幕模式中強制鎖定保留', 'err'); return; }
      State.overwriteKeep = !State.overwriteKeep;
      document.querySelectorAll('.ow-keep-btn').forEach(btn => {
        btn.textContent = State.overwriteKeep ? '⚪ 保留' : '❌ 刪除';
        btn.classList.toggle('del', !State.overwriteKeep);
      });
      setStatus(`完全覆蓋時：${State.overwriteKeep ? '保留' : '刪除'} 被包含的字幕`, 'ok');
      saveConfig();
    },
  };

  // 四個面板關閉鈕：同一個實作，只有目標 id 不同。
  for (const [id, panel] of Object.entries(CLOSE_PANELS)) {
    table[id] = () => { $(panel).classList.remove('show'); ctx.syncMpvPanel(); };
  }

  const registry = {
    ids(){ return Object.keys(table); },
    has(id){ return Object.prototype.hasOwnProperty.call(table, id); },
    /* 未知 id 一律不動作。以前的 switch 走到 default 也是靜默——差別在於現在
       可以先用 has() 問，而且測試能列舉整張表去比對 index.html 與快捷鍵。 */
    run(id, opts = {}){
      const fn = table[id];
      if (!fn) return undefined;
      return fn(opts);
    },
  };
  return registry;
}

export { createCommands, CLOSE_PANELS };
