/* SUB Tool — 專案存讀 (.subtool) */
import { State, IS_DESKTOP, DESK, snapFps, newId, ensureTrackCount } from './state.js';
import { $ } from './dom.js';
import { encodeUTF16LE, decodeText, bytesToB64, b64ToBytes, downloadBytes, readFile, escapeHTML } from './util.js';
import { Media } from './media.js';
import { drawTimeline } from './timeline.js';
import { History } from './history.js';
import { renderNotes } from './notes.js';
import { renderListTrackSel, renderAll, openModal, closeModal, showToast, setStatus } from './app.js';

/* ===== 8. 專案 .subtool ============================================== */
const Project = {
  save(){
    const data={
      app:'SUB Tool', version:1,
      media:{name:State.mediaName,size:State.mediaSize,path:IS_DESKTOP?State.mediaPath:null},
      fps:State.fps, duration:State.duration, trackCount:State.trackCount,
      tracks:State.tracks.map(t=>({name:t.name,visible:t.visible!==false,fontScale:t.fontScale||1,posPct:t.posPct!=null?t.posPct:10,align:t.align||'center',locked:!!t.locked,color:t.color||'#ffffff'})),
      pxPerSec:State.pxPerSec,
      notes:State.notes.map(n=>({time:n.time,text:n.text,done:!!n.done})),
      cues:State.cues.map(c=>({start:c.start,end:c.end,text:c.text,track:c.track||0,timed:c.timed!==false}))
    };
    const json=JSON.stringify(data,null,1);
    const name=(State.mediaName? State.mediaName.replace(/\.[^.]+$/,'') : 'project')+'.subtool';
    const bytes=encodeUTF16LE(json);
    if(IS_DESKTOP){ DESK.saveProject(name,bytesToB64(bytes)).then(pth=>{ if(pth)setStatus('專案已儲存：'+pth,'ok'); }); }
    else { downloadBytes(bytes,name,'application/json'); setStatus('專案已儲存：'+name,'ok'); }
  },
  apply(data){
    State.cues=(data.cues||[]).map(c=>({id:newId(),start:c.start||0,end:c.end||0,text:c.text||'',track:c.track||0,timed:c.timed!==false}));
    State.fps=snapFps(data.fps||24); if($('fpsSel'))$('fpsSel').value=String(State.fps);
    const maxTk=State.cues.reduce((m,c)=>Math.max(m,c.track||0),0);
    if(Array.isArray(data.tracks)&&data.tracks.length) State.tracks=data.tracks.map((t,i)=>({name:t.name||('軌道 '+(i+1)),visible:t.visible!==false,fontScale:t.fontScale||1,
      posPct:t.posPct!=null?t.posPct:(t.posV==='top'?90:t.posV==='middle'?50:10), align:t.align||'center',locked:!!t.locked,color:t.color||'#ffffff'}));
    else State.tracks=[];
    ensureTrackCount(Math.max(data.trackCount||1,maxTk+1));
    State.notes=(data.notes||[]).map(n=>({id:newId(),time:n.time||0,text:n.text||'',done:!!n.done}));
    State.duration=data.duration||State.duration;
    State.pxPerSec=data.pxPerSec||80;
    State.listTrack=0;
    State.selectedId=State.cues[0]?.id||null; State.selectedIds=State.selectedId?[State.selectedId]:[];
    renderListTrackSel(); renderAll(); drawTimeline(); renderNotes(); History.reset();
    setStatus('專案已載入','ok');
  },
  async load(file){
    const buf=await readFile(file);
    let data; try{ data=JSON.parse(decodeText(buf)); }catch(e){ showToast('無法解析專案檔'); return; }
    this.apply(data);
    if(data.media&&data.media.name){
      openModal('請重新選取影音檔',
        `此專案對應的影音檔為：<br><br><b>${escapeHTML(data.media.name)}</b><br><br>`+
        `基於瀏覽器安全限制，無法自動開啟原始檔路徑，請手動重新匯入同一支影片以還原預覽與波形。`+
        `<br><br>字幕內容已完整還原。`,
        [{label:'立即匯入影音',primary:true,act:()=>{closeModal();$('fileMedia').click();}},{label:'稍後',act:closeModal}]);
    }
  },
  async loadDesktop(r){
    let data; try{ data=JSON.parse(decodeText(b64ToBytes(r.b64).buffer)); }catch(e){ showToast('無法解析專案檔'); return; }
    this.apply(data);
    const mp=data.media&&data.media.path;
    if(mp){
      const st=await DESK.stat(mp);
      if(st.exists){ Media.loadDesktopMedia(mp); }
      else openModal('找不到原影片',
        `專案紀錄的影片路徑不存在：<br><br><b>${escapeHTML(mp)}</b><br><br>請手動重新匯入。字幕已還原。`,
        [{label:'匯入影音',primary:true,act:async()=>{closeModal();const p=await DESK.openMedia();if(p)Media.loadDesktopMedia(p);}},{label:'稍後',act:closeModal}]);
    }
  }
};

export { Project };
