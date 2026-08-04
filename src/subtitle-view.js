import { State } from './state.js';
import { openModal, closeModal } from './ui.js';
import { deleteSelectedCues, cueTrackLocked } from './subtitle-model.js';

export function deleteSelectedWithPrompt() {
  const ids = State.selectedIds.length ? State.selectedIds.slice() : [State.selectedId].filter(Boolean);
  if (!ids.length) return;
  const onLocked = State.cues.find(c => ids.includes(c.id) && State.tracks[c.track||0]?.locked);
  if (onLocked && cueTrackLocked(onLocked, '刪除字幕')) return;

  if (ids.length > 1) {
    openModal(`刪除 ${ids.length} 條字幕`,
      `<p>確定要刪除選取的 <b>${ids.length}</b> 條字幕嗎？</p>`,
      [{label:'取消', act:closeModal},
       {label:'確定刪除', primary:true, act:()=>{ closeModal(); deleteSelectedCues(ids); }}]);
    return;
  }
  deleteSelectedCues(ids);
}
