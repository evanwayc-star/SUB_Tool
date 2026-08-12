import { $, video } from '../dom.js';
import { State, ensureTrackCount, clearSelection, IS_DESKTOP, DESK } from '../state.js';
import { pickFile } from '../util.js';
import { emit } from '../events.js';
import { Project, resetProject, confirmDiscardUnsaved } from '../project.js';
import { Media } from '../media.js';
import { History } from '../history.js';
import { setFirstLoad } from '../video-renderer.js';
import { renderAudioTracks } from '../mixer.js';
import { renderNotes } from '../notes.js';
import { drawTimeline } from '../timeline.js';
import { setStatus, openModal, closeModal } from '../ui.js';
import { pickMediaFiles, importDesktopMediaFiles, importBrowserMediaFiles } from './media-ingest-actions.js';

export async function openMedia() {
  const relink = Project.pendingMediaRelink?.() || null;
  if (relink) {
    await Project.continueLoad(relink.generation, async isCurrent => {
      const picked = IS_DESKTOP ? await DESK.openMedia() : await pickMediaFiles($('fileMedia'));
      if (!isCurrent()) return;
      if (IS_DESKTOP) await importDesktopMediaFiles(picked, relink);
      else await importBrowserMediaFiles(picked, relink);
    });
  } else if (IS_DESKTOP) await importDesktopMediaFiles(await DESK.openMedia());
  else await importBrowserMediaFiles(await pickMediaFiles($('fileMedia')));
}

export async function openProject() {
  if (!await confirmDiscardUnsaved()) return;
  if (IS_DESKTOP) { const r = await DESK.openProject(); if (r) Project.loadDesktop(r); }
  else { const f = await pickFile($('fileProject')); if (f) Project.load(f); }
}

export function saveProject() { Project.save(); }
export function saveAsProject() { Project.saveAs(); }

export function startNewProject() {
  openModal('開新專案',
    '<p>確定清空目前專案？字幕、備註與已載入的影音都將清除（未存檔的話）。</p>',
    [{ label: '取消', act: closeModal },
     { label: '確定清空', primary: true, act: () => {
       closeModal();
       return Project.startNewProject(() => {
         State.cues = []; State.notes = [];
         clearSelection();
         State.listTrack = 0; State.tracks = []; ensureTrackCount(0);
         if (State.subMode) emit('action', 'sub-mode');
         resetProject(); setFirstLoad(true);
         video.pause(); video.removeAttribute('src'); video.load();
         State.mediaName = ''; State.mediaPath = ''; State.mediaSize = 0;
         Media.reset();
         History.reset();
         const nv = $('noVideo'); if (nv) nv.style.display = '';
         emit('duration:known'); renderAudioTracks();
         emit('render:listTrackSel'); emit('render:all'); renderNotes(); drawTimeline();
         setStatus('新專案', 'ok');
       });
     } }]);
}
