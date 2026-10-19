import { State } from './state.js';
import { Project } from './project.js';
import { History } from './history.js';
import { openModal, showToast } from './ui.js';
import { escapeHTML } from './util.js';

// Consent belongs to the displayed document, including in-place edits that do
// not replace an id. Undo can recreate an identical-looking, different object.
export function captureSubtitleRemovalOwnership(targets = null) {
  const ownsWorkspace = Project.captureWorkspaceOwnership();
  // A direct delete owns only the displayed targets. A later unrelated addition
  // has its own History entry and must survive this deletion and its Undo.
  if (targets) {
    const cues = [...targets], tracks = cues.map(cue => State.tracks[cue.track || 0]);
    const snapshot = () => JSON.stringify({cues, tracks, fps:State.fps,dropFrame:State.dropFrame});
    const data = snapshot();
    return () => ownsWorkspace() && cues.every((cue,i) => State.cues.find(item=>item.id===cue.id)===cue
      && State.tracks[cue.track || 0]===tracks[i]) && snapshot()===data;
  }
  const cues = [...State.cues], tracks = [...State.tracks];
  const revision = History.stack[History.hi];
  const snapshot=()=>JSON.stringify({ cues:State.cues, tracks:State.tracks, fps:State.fps,dropFrame:State.dropFrame,
    overwriteMode:State.overwriteMode,overwriteKeep:State.overwriteKeep,subMode:State.subMode });
  const data = snapshot();
  return () => ownsWorkspace() && History.stack[History.hi] === revision
    && State.cues.length === cues.length && cues.every((cue, i) => State.cues[i] === cue)
    && State.tracks.length === tracks.length && tracks.every((track, i) => State.tracks[i] === track)
    && snapshot() === data;
}

// UI admission only: models remain synchronous and own their one History step.
export function requestSubtitleRemoval({ targets, title = '移除字幕', detail = '',
  confirmLabel = '確定刪除', commit, isCurrent = () => true, onCancel = () => {}, targetOnly = false }) {
  const removed = [...new Set(targets || [])].filter(cue => State.cues.includes(cue));
  if (!removed.length) return isCurrent() ? commit() : false;
  const owns = captureSubtitleRemovalOwnership(targetOnly ? removed : null);
  let settled = false;
  const cancel = () => { if (!settled) { settled = true; onCancel(); } };
  const session = openModal(title,
    `<p>${escapeHTML(detail || '這項操作會移除既有字幕。')}</p><p>將移除 <b>${removed.length}</b> 條既有字幕。確認後才會套用；取消保留原內容。</p>`,
    [{ label: '取消', act: () => session.close() },
      { label: confirmLabel, primary: true, act: () => {
        if (settled || !session.isCurrent()) return false;
        if (!owns() || !isCurrent()) {
          showToast('字幕或專案已變更，請重新執行並確認');
          session.close(); return false;
        }
        settled = true;
        session.close({ committed: true });
        return commit();
      } }], { onDismiss: cancel, onReplaced: cancel });
  return session;
}
