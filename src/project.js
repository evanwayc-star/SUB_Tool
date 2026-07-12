/* SUB Tool — 專案存讀 (.subtool) */
import { State, IS_DESKTOP, DESK, snapFps, setFps, newId, ensureTrackCount, ensureVideoTrackCount, resetVideoTracks } from './state.js';
import { $ } from './dom.js';
import { encodeUTF16LE, decodeText, bytesToB64, b64ToBytes, downloadBytes, readFile, escapeHTML } from './util.js';
import { Media } from './media.js';
import { drawTimeline } from './timeline.js';
import { History } from './history.js';
import { renderNotes } from './notes.js';
import { emit } from './events.js';
import { openModal, closeModal, showToast, setStatus } from './ui.js';

/* ===== 自動備份狀態 ===== */
let _editGuardDone = false;  // 本 session 是否已顯示過「請先儲存」提示
let _savePath      = null;   // 上次儲存的完整路徑（desktop only）
let _saveBaseName  = null;   // 基礎名稱（不含副檔名），自動備份用
let _autoSaveTimer = null;
let _lastSavedDataStr = null; // 用於判斷專案是否被修改

function _defaultSaveName(){
  return (State.mediaName ? State.mediaName.replace(/\.[^.]+$/,'') : 'project')+'.subtool';
}

function _buildProjectData(){
  return {
    app:'SUB Tool', version:2,
    media:{name:State.mediaName,size:State.mediaSize,path:IS_DESKTOP?State.mediaPath:null},
    fps:State.fps, dropFrame:State.dropFrame, duration:State.duration, trackCount:State.trackCount,
    tracks:State.tracks.map(t=>({name:t.name,visible:t.visible!==false,fontSize:t.fontSize||60,posPct:t.posPct!=null?t.posPct:100,align:t.align||'center',locked:!!t.locked,color:t.color||'#ffffff'})),
    pxPerSec:State.pxPerSec,
    // 影片序列（v4.5.0；v4.10.0 起含多視訊軌）：各段的來源路徑與幾何；網頁版無路徑（開啟時需手動重加）
    videoTracks:State.videoTracks.map(t=>({name:t.name,visible:t.visible!==false,locked:!!t.locked,
      ...(t.scale!=null?{scale:t.scale}:{}),...(t.opacity!=null?{opacity:t.opacity}:{}),...(t.posX!=null?{posX:t.posX}:{}),...(t.posY!=null?{posY:t.posY}:{})})),
    videoTrackCount:State.videoTracks.length||1, // 向下相容：舊版讀取用
    clips:State.clips.map(c=>({name:c.name,path:c.path||null,dur:c.dur,in:c.in,out:c.out,offset:c.offset,vtrack:c.vtrack||0,fps:c.fps||0,primary:!!c.primary,
      ...(c.fadeIn?{fadeIn:c.fadeIn}:{}),...(c.fadeOut?{fadeOut:c.fadeOut}:{})})),
    notes:State.notes.map(n=>({time:n.time,text:n.text,done:!!n.done})),
    cues:State.cues.map(c=>({start:c.start,end:c.end,text:c.text,track:(c.track||0)+1,timed:c.timed!==false}))
  };
}
function _buildBytes(){ return encodeUTF16LE(JSON.stringify(_buildProjectData(),null,1)); }

function _timestamp(){
  const n=new Date();
  return String(n.getMonth()+1).padStart(2,'0')+String(n.getDate()).padStart(2,'0')+
         '-'+String(n.getHours()).padStart(2,'0')+String(n.getMinutes()).padStart(2,'0');
}

function _onSaved(fullPath, webName){
  if(fullPath){
    _savePath=fullPath;
    _saveBaseName=fullPath.replace(/\\/g,'/').split('/').pop().replace(/\.subtool$/i,'');
    setStatus('專案已儲存：'+fullPath,'ok');
  } else {
    _saveBaseName=(webName||'').replace(/\.subtool$/i,'');
    setStatus('專案已儲存：'+webName,'ok');
  }
  _lastSavedDataStr = JSON.stringify(_buildProjectData());
  if(!_autoSaveTimer) _autoSaveTimer=setInterval(_autoSave, 3*60*1000);
}

async function _autoSave(){
  if(!_saveBaseName) return;
  const name=`${_saveBaseName}_${_timestamp()}.subtool`;
  const bytes=_buildBytes();
  if(IS_DESKTOP && DESK.writeProject && _savePath){
    const dir=_savePath.replace(/[^\\/]+$/,'');
    const autoSaveDir=dir+'.subtool_AutoSave/';
    const res=await DESK.writeProject(autoSaveDir+name, bytesToB64(bytes)).catch(()=>null);
    if(res) setStatus('自動備份：'+name,'ok');
  } else {
    // Fix #2：瀏覽器版改用 localStorage 避免每 3 分鐘觸發下載干擾工作流
    try{
      localStorage.setItem('subtool_autosave_data', bytesToB64(bytes));
      localStorage.setItem('subtool_autosave_name', name);
      setStatus('自動備份已存（瀏覽器本地）','ok');
    }catch(e){
      // localStorage 額度已滿時靜默失敗，不干擾使用者
      console.warn('auto-save localStorage failed:', e);
    }
  }
}

/* 第一次編輯前的儲存提示（非同步，await 使用） */
function ensureProjectSaved(){
  if(_editGuardDone) return Promise.resolve();
  _editGuardDone=true;
  return new Promise(resolve=>{
    openModal('開始前先儲存專案',
      `<p style="margin:0 0 10px;font-size:13px;color:var(--text-faint)">開始編輯前建議先儲存專案，<br>儲存後每 3 分鐘自動備份一份。</p>`,
      [{label:'立即儲存',primary:true,act:async()=>{
        closeModal();
        const name=_defaultSaveName();
        if(IS_DESKTOP){
          const pth=await DESK.saveProject(name,bytesToB64(_buildBytes()));
          if(pth) _onSaved(pth);
        } else {
          downloadBytes(_buildBytes(),name,'application/json');
          _onSaved(null,name);
        }
        resolve();
      }},
      {label:'稍後再說',act:()=>{ closeModal(); resolve(); }}]
    );
  });
}

/* 同步版本：用於不適合 await 的地方（timeline 拖曳） */
function isProjectGuardDone(){ return _editGuardDone; }

/* 開新專案時重置所有儲存狀態 */
function resetProject(){
  _editGuardDone=false;
  _savePath=null;
  _saveBaseName=null;
  _lastSavedDataStr=null;
  if(_autoSaveTimer){ clearInterval(_autoSaveTimer); _autoSaveTimer=null; }
}

function isProjectDirty() {
  if (State.cues.length === 0 && State.notes.length === 0) return false;
  if (!_lastSavedDataStr) return true;
  return JSON.stringify(_buildProjectData()) !== _lastSavedDataStr;
}

/* ===== 8. 專案 .subtool ============================================== */
const Project = {
  // save/saveAs 回傳 Promise<路徑|名稱|null>：null=失敗或使用者取消。
  // 呼叫端（如關閉前儲存流程）可 await 確認真正寫入完成後再繼續。
  save(){
    const bytes=_buildBytes();
    if(IS_DESKTOP && _savePath){
      return DESK.writeProject(_savePath, bytesToB64(bytes)).then(pth=>{
        if(pth){ _onSaved(pth); setStatus('已儲存專案', 'ok'); showToast('已儲存專案'); return pth; }
        showToast('儲存專案失敗，請嘗試「另存新檔」'); return null;
      });
    } else {
      return this.saveAs();
    }
  },
  saveAs(){
    const bytes=_buildBytes();
    const name=_defaultSaveName();
    if(IS_DESKTOP){ return DESK.saveProject(name,bytesToB64(bytes)).then(pth=>{ if(pth) { _onSaved(pth); setStatus('已另存新檔', 'ok'); showToast('已另存新檔'); } return pth||null; }); }
    downloadBytes(bytes,name,'application/json'); _onSaved(null,name); return Promise.resolve(name);
  },
  apply(data){
    _editGuardDone = true; // 開啟舊檔後不需再次跳出存檔提示
    // Fix #19：明確排除 undefined/null，避免 version:0 被誤判為 v1（0 是 falsy）
    const isV1 = data.version === undefined || data.version === null || data.version === 1;
    State.cues=(data.cues||[]).map(c=>{
      let tk = c.track||0;
      if (!isV1 && c.track !== undefined) tk = Math.max(0, c.track - 1);
      return {id:newId(),start:c.start||0,end:c.end||0,text:c.text||'',track:tk,timed:c.timed!==false};
    });
    setFps(data.dropFrame?String(data.fps||24)+'df':String(data.fps||24));
    const maxTk=State.cues.length > 0 ? State.cues.reduce((m,c)=>Math.max(m,c.track||0),0) : -1;
    if(Array.isArray(data.tracks)&&data.tracks.length) State.tracks=data.tracks.map((t,i)=>({name:t.name||('軌道 '+(i+1)),visible:t.visible!==false,fontSize:t.fontSize||(t.fontScale?Math.round(60*t.fontScale):60),
      posPct:t.posPct!=null?t.posPct:90,align:t.align||'center',locked:!!t.locked,color:t.color||'#ffffff'}));
    else State.tracks=[];
    ensureTrackCount(Math.max(data.trackCount!==undefined?data.trackCount:0, maxTk+1));
    State.notes=(data.notes||[]).map(n=>({id:newId(),time:n.time||0,text:n.text||'',done:!!n.done}));
    // 影片序列：先暫存，待第一支影片載入完成（Media._registerPrimary）時還原幾何並補載其餘段
    // 視訊軌：新版存 videoTracks 陣列（名稱/顯示/鎖定）；舊版只有 videoTrackCount → 補足空軌
    if(Array.isArray(data.videoTracks) && data.videoTracks.length)
      State.videoTracks = data.videoTracks.map((t,i)=>({name:t.name||('視訊軌 '+(i+1)),visible:t.visible!==false,locked:!!t.locked,
        ...(t.scale!=null?{scale:t.scale}:{}),...(t.opacity!=null?{opacity:t.opacity}:{}),...(t.posX!=null?{posX:t.posX}:{}),...(t.posY!=null?{posY:t.posY}:{})}));
    else { resetVideoTracks(); ensureVideoTrackCount(Math.max(1, data.videoTrackCount || 1)); }
    State._pendingClips = (Array.isArray(data.clips) && data.clips.length) ? data.clips : null;
    if(!State._pendingClips) delete State._pendingClips;
    State.duration=data.duration||State.duration;
    State.pxPerSec=data.pxPerSec||80;
    State.listTrack=0;
    State.selectedId=null; State.selectedIds=[]; // 開啟專案後預設不選取任何字幕
    emit('render:listTrackSel'); emit('render:all'); drawTimeline(); renderNotes(); History.reset();
    _lastSavedDataStr = JSON.stringify(_buildProjectData());
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
    // 載入既有專案時記錄儲存路徑，自動備份用
    if(r.path){ _savePath=r.path; _saveBaseName=r.path.replace(/\\/g,'/').split('/').pop().replace(/\.subtool$/i,''); if(!_autoSaveTimer) _autoSaveTimer=setInterval(_autoSave,3*60*1000); }
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

export { Project, ensureProjectSaved, isProjectGuardDone, resetProject, isProjectDirty };
