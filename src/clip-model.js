/* clip-model.js — 影片段域邏輯（選取、刪除、轉場、幾何）
   從 timeline-renderer.js 抽出，使渲染引擎不再包含域操作。
   渲染需求透過 emit() 事件觸發，由 timeline-renderer.js 訂閱。 */
import { State, setSelection, deselect, focusTrackKind, ensureVideoTrackCount } from './state.js';
import { $ } from './dom.js';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { emit } from './events.js';
import { refreshSelectionUI } from './subtitles.js';
import { refreshTrackGutterActive } from './timeline.js';
import { secToEncore } from './time.js';
import { showToast, openModal, closeModal } from './ui.js';
import { escapeHTML } from './util.js';
import { recordHistory } from './history.js';
import { fitScale } from './image-compositor-engine.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';



/* 「符合視窗」：幾何計算在 image-geometry.js fitScale()（三路共用的唯一公式所在），
   這裡只負責套用結果與回報。 */
function fitClipToStage(c){
  const { scale, recentred } = fitScale({
    stageW: State.videoWidth || 1920, stageH: State.videoHeight || 1080,
    natW: c.natW, natH: c.natH, posX: c.posX ?? 0.5, posY: c.posY ?? 0.5,
  });
  if (recentred) { c.posX = 0.5; c.posY = 0.5; }
  c.scale = scale;
  showToast(recentred
    ? `已置中並符合視窗（大小 ${Math.round(scale * 100)}%）`
    : `已符合視窗（大小 ${Math.round(scale * 100)}%）`);
  return scale;
}




/* 交叉溶接（階段5.1）：把此片段移到上一層視訊軌、提前與「同軌前一段」尾端重疊 T 秒，
   前段淡出／此段淡入＝交叉溶接。完全複用「多軌 overlay＋淡變」的匯出（不改 filtergraph）。 */
function _prevTrackClip(c){
  return Seq.trackClips(c.vtrack||0).filter(x=>x!==c && x.offset < c.offset - 1e-4).sort((a,b)=>b.offset-a.offset)[0] || null;
}
function crossfadeWithPrev(c, T){
  const prev=_prevTrackClip(c);
  if(!prev){ showToast('前面沒有可溶接的片段（同一視訊軌）'); return; }
  T=Math.max(0.1, Math.min(T, Seq.len(c), Seq.len(prev)));
  const prevEnd=Seq.clipEnd(prev);
  const nv=(c.vtrack||0)+1; c.vtrack=nv; ensureVideoTrackCount(nv+1);
  c.offset=Math.max(0, prevEnd - T);
  // 只淡入上層（此段）：下層(前段)維持不透明當底，重疊處 50%A+50%B＝乾淨溶接（避免經過黑而變暗）
  c.fadeIn=T;
  Seq.sort(); Seq.recomputeDuration();
  recordHistory('交叉溶接：'+(prev.name||'')+'→'+(c.name||''));
  Media.seek(Math.min(Media.displayTime(), State.duration||0));
  emit('media:timeline'); emit('render:videoSub'); emit('mpv:refreshSubs');
  showToast(`已建立交叉溶接 ${T.toFixed(1)}s（${prev.name} → ${c.name}）`);
}


/* ===== 影片段選取（點選高亮、上下鍵切換、Del 刪除；行為比照字幕列） ===== */
function selectClip(id, opts={}){
  const c=Seq.byId(id); if(!c) return;
  if(!opts.force && State.videoTracks[c.vtrack||0]?.locked) return; // 鎖定軌：不可選取中間的影像片段
  setSelection({ kind:'video', ids:id }); // 互斥（避免 Del/上下鍵語意衝突）由 setSelection 保證
  focusTrackKind('video', c.vtrack || 0);  // 焦點類別＋哪一軌是同一條不變量
  refreshSelectionUI(); // 清除字幕列高亮
  $('stSel').textContent='已選影片段：'+c.name;
  refreshTrackGutterActive();
  if(opts.seek){ Media.seek(c.offset); emit('playhead:ensure'); emit('render:videoSub'); }
  emit('clip:blocksChanged');
}
function clearClipSelection(){
  if(State.selectedClipId==null) return;
  deselect('video');
  $('stSel').textContent='';
  emit('clip:blocksChanged');
}
/* 影片段的上/下鍵導航曾經住在這裡（navigateClip）。v4.37 起上下鍵統一交給
   keyboard.js 的「媒體片段邊界」快捷鍵處理，讓已選取影片時也能跳到音訊片段邊界，
   這個函式就再也沒有呼叫端了；接縫收窄時一併移除，避免看起來還有兩套導航。 */
/* 關閉選取影片段「前方」的空白：把它往左移到緊貼前一段結尾；前面沒有素材則移到 00:00:00:00 */
function closeClipGapLeft(){
  const id=State.selectedClipId; if(id==null) return;
  const c=Seq.byId(id); if(!c) return;
  const sorted=Seq.trackClips(c.vtrack||0).sort((a,b)=>a.offset-b.offset); // 同一視訊軌內
  const idx=sorted.findIndex(x=>x.id===id);
  const target = idx>0 ? Seq.clipEnd(sorted[idx-1]) : 0; // 前一段（同軌）結尾，或軌道開頭
  if(Math.abs(c.offset - target) < 1e-4) return; // 已無空白
  c.offset = target;
  Seq.sort(); Seq.recomputeDuration();
  recordHistory('關閉前方空白：'+c.name);
  Media.seek(Math.min(Media.displayTime(), State.duration||0)); // 幾何變了→重新解析映射
  emit('media:timeline'); emit('render:videoSub'); emit('mpv:refreshSubs');
}
/* 刪除選取的影片段（至少保留一段），並選取相鄰段方便連續刪除 */
function deleteSelectedClip(){
  const id=State.selectedClipId; if(id==null) return;
  const sorted=[...State.clips].sort((a,b)=>a.offset-b.offset);
  const idx=sorted.findIndex(c=>c.id===id);
  const c=Seq.byId(id);
  if(c && State.videoTracks[c.vtrack||0]?.locked){ showToast('此視訊軌已鎖定，無法刪除片段'); return; }
  if(Media.removeClip(id)){
    recordHistory('刪除影片段：'+(c?c.name:''));
    const rest=[...State.clips].sort((a,b)=>a.offset-b.offset);
    const next=rest[Math.min(idx, rest.length-1)];
    if(next){ setSelection({ kind:'video', ids:next.id }); $('stSel').textContent='已選影片段：'+next.name; }
    else deselect('video');
    emit('media:timeline');
  }
}


export { selectClip, clearClipSelection, deleteSelectedClip, closeClipGapLeft,
  fitClipToStage, crossfadeWithPrev };
