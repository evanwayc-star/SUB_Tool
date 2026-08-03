/* clip-model.js — 影片段域邏輯（選取、刪除、轉場、幾何）
   從 timeline-renderer.js 抽出，使渲染引擎不再包含域操作。
   渲染需求透過 emit() 事件觸發，由 timeline-renderer.js 訂閱。 */
import { State, setSelection, deselect, ensureVideoTrackCount } from './state.js';
import { $ } from './dom.js';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { emit } from './events.js';
import { refreshSelectionUI, refreshTrackGutterActive } from './subtitles.js';
import { secToEncore } from './time.js';
import { showToast, openModal, closeModal } from './ui.js';
import { escapeHTML } from './util.js';
import { recordHistory } from './history.js';
import { fitScale } from './imagegeom.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';

function showImageGeom(c){
  if(!c) return;
  if(State.videoTracks[c.vtrack||0]?.locked){ showToast('此視訊軌已鎖定'); return; }
  const S=Math.round((c.scale??1)*100), X=Math.round((c.posX??0.5)*100), Y=Math.round((c.posY??0.5)*100);
  const row=(id,label,val,min,max,unit)=>
    `<div>${label}：<input type="range" id="ig${id}R" min="${min}" max="${max}" step="1" value="${val}" style="width:180px;vertical-align:middle">`+
    ` <input type="number" id="ig${id}" min="${min}" max="${max}" step="1" value="${val}" style="width:64px">${unit}</div>`;
  /* 即時預覽是直接改 c 的欄位（預覽三路都讀 c），所以【必須】先留一份原值：
     取消／Esc／點遮罩關閉時要還原回去。v5.7.0 前沒有還原也沒有取消鈕——調完滑桿
     按 Esc，看起來是取消了，值其實已經被寫進去了。 */
  const snap={ scale:c.scale??1, posX:c.posX??0.5, posY:c.posY??0.5 };
  const restore=()=>{ c.scale=snap.scale; c.posX=snap.posX; c.posY=snap.posY;
    emit('media:timeline'); emit('render:videoSub'); };
  const commit=label=>{ closeModal({committed:true}); emit('media:timeline'); emit('render:videoSub'); recordHistory(label); };
  const syncInputs=()=>{
    const set=(id,val)=>{ const r=$('ig'+id+'R'), n=$('ig'+id); if(r)r.value=val; if(n)n.value=val; };
    set('S',Math.round((c.scale??1)*100)); set('X',Math.round((c.posX??0.5)*100)); set('Y',Math.round((c.posY??0.5)*100));
  };
  openModal(`${c.type==='image'?'圖片':'影片'}大小與位置 — ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.2">`+
    row('S','大小',S,2,800,'%')+row('X','水平位置',X,0,100,'%')+row('Y','垂直位置',Y,0,100,'%')+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">`+
    `大小＝素材框佔軌影格的比例（素材依原始比例縮入該框）；位置＝素材<b>中心</b>在影格上的座標。`+
    `${c.natW>0?`原始尺寸 ${c.natW}×${c.natH}。`:''}預覽與匯出使用同一組數值。<br>`+
    `<b>符合視窗</b>＝維持目前位置，等比例放大到上下左右最先碰到的那個邊界為止。</div>`+
    `</div>`,
    [{label:'符合視窗',act:()=>{ fitClipToStage(c); syncInputs(); emit('render:videoSub'); }},
     {label:'重設',act:()=>{ c.scale=1; c.posX=0.5; c.posY=0.5; commit('重設大小與位置：'+(c.name||'')); }},
     {label:'取消',act:()=>{ closeModal(); }},
     {label:'套用',primary:true,act:()=>{
        const v=(id,d)=>{ const n=+($(('ig'+id))?.value); return Number.isFinite(n)?n:d; };
        c.scale=Math.max(0.02,Math.min(8, v('S',S)/100));
        c.posX =Math.max(0,Math.min(1, v('X',X)/100));
        c.posY =Math.max(0,Math.min(1, v('Y',Y)/100));
        commit('大小與位置：'+(c.name||''));
     }}],
    { onDismiss:restore });
  // 滑桿與數字框雙向同步，並即時預覽（不入 undo，套用時才記一筆）
  setTimeout(()=>{
    for(const id of ['S','X','Y']){
      const r=$('ig'+id+'R'), n=$('ig'+id); if(!r||!n) continue;
      const live=()=>{ const val=+n.value;
        if(id==='S') c.scale=Math.max(0.02,Math.min(8,val/100));
        else if(id==='X') c.posX=Math.max(0,Math.min(1,val/100));
        else c.posY=Math.max(0,Math.min(1,val/100));
        emit('render:videoSub'); };
      r.oninput=()=>{ n.value=r.value; live(); };
      n.oninput=()=>{ r.value=n.value; live(); };
    }
  },0);
}

/* 「符合視窗」：幾何計算在 imagegeom.js fitScale()（三路共用的唯一公式所在），
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


/* 影片段轉場（階段5）：淡入／淡出（秒）——匯出時影像 alpha 淡變＋音訊 afade 同步。
   淡到透明會露出下層／黑底；上層片段與下層重疊時的淡變即為軌間溶接（crossfade）。 */
function showClipFade(c){
  if(!c) return;
  const len=Math.max(0.1, Seq.len(c));
  const maxF=Math.max(0.1, +len.toFixed(1));
  const fi=Math.min(+(c.fadeIn||0), maxF), fo=Math.min(+(c.fadeOut||0), maxF);
  openModal(`淡入淡出（轉場）— ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.2">`+
    `<div>淡入：<input type="range" id="cfIn" min="0" max="${maxF}" step="0.001" value="${fi}" style="width:180px;vertical-align:middle"> <input type="text" id="cfInV" value="${secToEncore(fi, State.fps, State.dropFrame)}" style="width:100px;background:var(--bg-b);color:var(--text);border:1px solid var(--border);padding:2px 4px;border-radius:3px;text-align:center"></div>`+
    `<div>淡出：<input type="range" id="cfOut" min="0" max="${maxF}" step="0.001" value="${fo}" style="width:180px;vertical-align:middle"> <input type="text" id="cfOutV" value="${secToEncore(fo, State.fps, State.dropFrame)}" style="width:100px;background:var(--bg-b);color:var(--text);border:1px solid var(--border);padding:2px 4px;border-radius:3px;text-align:center"></div>`+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">淡入從透明漸顯、淡出漸隱到透明（露出下層／黑底），音訊同步淡變。<b>匯出時生效</b>。若此片段在上層視訊軌且與下層重疊，淡變即為<b>軌間溶接</b>。</div>`+
    `</div>`,
    [{label:'清除',act:()=>{ c.fadeIn=0; c.fadeOut=0; closeModal(); emit('media:timeline'); recordHistory('清除轉場：'+(c.name||'')); }},
     {label:'套用',primary:true,act:()=>{
        let vi = parseTimecodeInput($('cfInV').value);
        if(vi===null) vi = parseFloat($('cfInV').value);
        if(isNaN(vi)) vi = +$('cfIn').value;

        let vo = parseTimecodeInput($('cfOutV').value);
        if(vo===null) vo = parseFloat($('cfOutV').value);
        if(isNaN(vo)) vo = +$('cfOut').value;

        c.fadeIn=Math.max(0,Math.min(maxF,vi)); c.fadeOut=Math.max(0,Math.min(maxF,vo));
        closeModal(); emit('media:timeline'); recordHistory('轉場：'+(c.name||''));
     }}]);
  setTimeout(()=>{
    const a=$('cfIn'), b=$('cfOut'), aV=$('cfInV'), bV=$('cfOutV');
    if(aV) setupTimecodeInput(aV);
    if(bV) setupTimecodeInput(bV);
    if(a) a.oninput=()=>{ if(aV) aV.value=secToEncore(+a.value, State.fps, State.dropFrame); };
    if(b) b.oninput=()=>{ if(bV) bV.value=secToEncore(+b.value, State.fps, State.dropFrame); };
    if(aV) aV.onchange=()=>{
        let v = parseTimecodeInput(aV.value);
        if(v===null) v = parseFloat(aV.value);
        if(!isNaN(v)) { a.value = Math.max(0, Math.min(maxF, v)); aV.value = secToEncore(+a.value, State.fps, State.dropFrame); }
    };
    if(bV) bV.onchange=()=>{
        let v = parseTimecodeInput(bV.value);
        if(v===null) v = parseFloat(bV.value);
        if(!isNaN(v)) { b.value = Math.max(0, Math.min(maxF, v)); bV.value = secToEncore(+b.value, State.fps, State.dropFrame); }
    };
  },0);
}
/* 修改片段的持續時間（右鍵選單）。

   兩個上限，取較小者：
     ① 來源長度：影片不能播超過素材本身（c.dur − c.in）。靜態圖片的 dur 是
        10 小時，實務上等同無上限。
     ② 同軌下一段的起點：同一視訊軌不可重疊（不同軌重疊＝疊層，是正常用法，
        所以【只】看同軌，不能像「重設修剪」那樣掃全部 clips 而誤擋疊層）。

   改的是 out（in 不動），因為使用者要的是「這段播多久」而不是「從哪裡開始播」。 */
function showClipDuration(c){
  if(!c) return;
  if(State.videoTracks[c.vtrack||0]?.locked){ showToast('此視訊軌已鎖定'); return; }
  const isImg = c.type === 'image';
  const cur = Seq.len(c);
  const maxBySource = Math.max(0.001, (+c.dur || 0) - (+c.in || 0));
  const maxByNeighbor = Seq.maxLengthOnTrack(c);   // 同軌鄰居的事實只有 sequence.js 一份
  const maxLen = Math.min(maxBySource, maxByNeighbor);
  const limitNote = maxByNeighbor < maxBySource
    ? '（受同軌下一段起點限制）'
    : (isImg ? '（圖片可自由延長）' : '（受來源素材長度限制）');

  openModal(`修改持續時間 — ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.2">`+
    `<div>持續時間：<input type="text" id="cdVal" value="${secToEncore(cur, State.fps, State.dropFrame)}" `+
    `style="width:120px;background:var(--bg-b);color:var(--text);border:1px solid var(--border);padding:3px 4px;border-radius:3px;text-align:center;font-family:'Cascadia Mono','JetBrains Mono',Consolas,monospace"></div>`+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">`+
    `最長 <b>${secToEncore(Math.min(maxLen, 359999.9), State.fps, State.dropFrame)}</b> ${limitNote}<br>`+
    `可直接輸入時碼，或用上下方向鍵微調。起點不變，只調整這一段播多久。</div>`+
    `</div>`,
    [{label:'取消',act:()=>{ closeModal(); }},
     {label:'套用',primary:true,act:()=>{
        let v = parseTimecodeInput($('cdVal').value);
        if(v===null) v = parseFloat($('cdVal').value);
        if(!Number.isFinite(v) || v<=0){ showToast('請輸入有效的持續時間'); return; }
        const clamped = Math.min(v, maxLen);
        c.out = (+c.in || 0) + clamped;
        Seq.recomputeDuration();
        closeModal({committed:true});
        Media.seek(Math.min(Media.displayTime(), State.duration||0)); // 幾何變了→重新解析映射
        emit('media:timeline'); emit('render:videoSub'); emit('mpv:refreshSubs');
        recordHistory('修改持續時間：'+(c.name||''));
        if(clamped < v - 1e-6) showToast(`已設為可用的最長 ${secToEncore(clamped, State.fps, State.dropFrame)}${limitNote}`);
     }}]);
  setTimeout(()=>{ const el=$('cdVal'); if(el){ setupTimecodeInput(el); el.focus(); el.select(); } },0);
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
function showCrossfade(c){
  if(!c) return;
  const prev=_prevTrackClip(c);
  if(!prev){ showToast('前面沒有可溶接的片段（同一視訊軌）'); return; }
  const maxT=Math.max(0.2, Math.min(Seq.len(c), Seq.len(prev)));
  const defT=Math.min(1, maxT);
  openModal(`交叉溶接 — ${escapeHTML(prev.name||'')} → ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.1">`+
    `<div>溶接時間：<input type="range" id="xfT" min="0.001" max="${maxT.toFixed(3)}" step="0.001" value="${defT}" style="width:180px;vertical-align:middle"> <input type="text" id="xfTV" value="${secToEncore(defT, State.fps, State.dropFrame)}" style="width:100px;background:var(--bg-b);color:var(--text);border:1px solid var(--border);padding:2px 4px;border-radius:3px;text-align:center"></div>`+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">會把此片段移到<b>上一層視訊軌</b>並提前與前一段尾端重疊，兩段在重疊處淡出／淡入＝交叉溶接（匯出時合成）。</div>`+
    `</div>`,
    [{label:'取消',act:closeModal},
     {label:'建立溶接',primary:true,act:()=>{
         let T = parseTimecodeInput($('xfTV').value);
         if(T===null) T = parseFloat($('xfTV').value);
         if(isNaN(T)) T = +$('xfT').value;
         closeModal(); crossfadeWithPrev(c, T);
     }}]);
  setTimeout(()=>{
    const s=$('xfT'), sV=$('xfTV');
    if(sV) setupTimecodeInput(sV);
    if(s) s.oninput=()=>{ if(sV) sV.value=secToEncore(+s.value, State.fps, State.dropFrame); };
    if(sV) sV.onchange=()=>{
        let v = parseTimecodeInput(sV.value);
        if(v===null) v = parseFloat(sV.value);
        if(!isNaN(v)) { s.value = Math.max(0.001, Math.min(maxT, v)); sV.value = secToEncore(+s.value, State.fps, State.dropFrame); }
    };
  },0);
}

/* ===== 影片段選取（點選高亮、上下鍵切換、Del 刪除；行為比照字幕列） ===== */
function selectClip(id, opts={}){
  const c=Seq.byId(id); if(!c) return;
  if(!opts.force && State.videoTracks[c.vtrack||0]?.locked) return; // 鎖定軌：不可選取中間的影像片段
  setSelection({ kind:'video', ids:id }); // 互斥（避免 Del/上下鍵語意衝突）由 setSelection 保證
  State.activeVtrack = c.vtrack || 0;
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
  showClipFade, showCrossfade, showImageGeom, showClipDuration };
