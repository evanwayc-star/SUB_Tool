import { State } from './state.js';
import { $ } from './dom.js';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { emit } from './events.js';
import { secToEncore } from './time.js';
import { showToast, openModal, closeModal } from './ui.js';
import { escapeHTML } from './util.js';
import { recordHistory } from './history.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';
import { fitClipToStage, crossfadeWithPrev } from './clip-model.js';

export function showImageGeom(c){
  if(!c) return;
  if(State.videoTracks[c.vtrack||0]?.locked){ showToast('此視訊軌已鎖定'); return; }
  const S=Math.round((c.scale??1)*100), X=Math.round((c.posX??0.5)*100), Y=Math.round((c.posY??0.5)*100);
  const row=(id,label,val,min,max,unit)=>
    `<div>${label}：<input type="range" id="ig${id}R" min="${min}" max="${max}" step="1" value="${val}" style="width:180px;vertical-align:middle">`+
    ` <input type="number" id="ig${id}" min="${min}" max="${max}" step="1" value="${val}" style="width:64px">${unit}</div>`;
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

export function showClipFade(c){
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

export function showClipDuration(c){
  if(!c) return;
  if(State.videoTracks[c.vtrack||0]?.locked){ showToast('此視訊軌已鎖定'); return; }
  const isImg = c.type === 'image';
  const cur = Seq.len(c);
  const maxBySource = Math.max(0.001, (+c.dur || 0) - (+c.in || 0));
  const maxByNeighbor = Seq.maxLengthOnTrack(c);
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
        Media.seek(Math.min(Media.displayTime(), State.duration||0));
        emit('media:timeline'); emit('render:videoSub'); emit('mpv:refreshSubs');
        recordHistory('修改持續時間：'+(c.name||''));
        if(clamped < v - 1e-6) showToast(`已設為可用的最長 ${secToEncore(clamped, State.fps, State.dropFrame)}${limitNote}`);
     }}]);
  setTimeout(()=>{ const el=$('cdVal'); if(el){ setupTimecodeInput(el); el.focus(); el.select(); } },0);
}

export function showCrossfade(c){
  if(!c) return;
  const prev=Seq.trackClips(c.vtrack||0).filter(x=>x!==c && x.offset < c.offset - 1e-4).sort((a,b)=>b.offset-a.offset)[0] || null;
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
