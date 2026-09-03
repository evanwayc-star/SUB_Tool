/* ==============================================================================
   SUB Tool — 專案檔案讀寫與狀態快照模組 (Project I/O Layer)
   ==============================================================================
   
   【架構與職責總覽】
   本檔案 (project.js) 負責將記憶體中的 `State` 序列化並寫入硬碟的 `.subtool` 專案檔，
   同時也負責專案載入時的逆向還原與資料結構升級。
   
   1. 序列化與 Base64 封裝
      `.subtool` 是一個純 JSON 檔案。但為了讓專案能夠單檔流傳，
      若使用者載入了圖片或小型字型檔，本模組會將這類小型二進位檔案轉為
      Base64 字串並直接包裹進 JSON 中存檔。大型影音檔則僅儲存絕對路徑。
      
   2. 自動備份機制 (Auto Save)
      為防止當機，本模組實作了定時自動備份。會定期比較 `_lastSavedDataStr` 
      是否被修改，若有變更則將專案寫入備份目錄中，並加入時間戳記防撞。

   【維護鐵律】
   - 當您在 `state.js` 新增了任何專案層級的欄位時，請務必回來這裡確認
     `makeProjectData` (存檔) 與 `loadProjectData` (讀檔) 是否有涵蓋到該欄位。
     尤其是讀檔時，必須做好舊版專案檔缺乏該欄位的防呆保護 (Fallback)。
============================================================================== */
import { State, IS_DESKTOP, DESK, snapFps, setFps, newId, ensureTrackCount, ensureVideoTrackCount, resetVideoTracks,
  normalizeAudioProject, resetAudioProject, deselect } from './state.js';
import { $ } from './dom.js';
import { encodeUTF16LE, decodeText, bytesToB64, b64ToBytes, downloadBytes, readFile, escapeHTML } from './util.js';
import { Media } from './media.js';
import { drawTimeline } from './timeline-renderer.js';
import { History } from './history.js';
import { renderNotes } from './notes.js';
import { emit } from './events.js';
import { openModal, closeModal, showToast, setStatus } from './ui.js';
import { getAllPresets, effStyle, trackStyleSnapshot, STYLE_DEFAULTS, isBuiltinPresetName, savePresets, getPresets, loadFonts } from './substyle.js';
import { ProjectLoadSession } from './project-intake-engine.js';
export const CURRENT_PROJECT_SCHEMA_VERSION = 3;
const PROJECT_APP = 'SUB Tool';

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneProjectValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 將已由 project.js 蒐集好的專案純資料封裝為目前 .subtool 格式。
 * 不加儲存時間，否則 dirty 判斷會在未編輯時持續變動。
 */
function createProjectSnapshot(document = {}) {
  const data = isRecord(document) ? cloneProjectValue(document) : {};
  return {
    ...data,
    app: PROJECT_APP,
    version: CURRENT_PROJECT_SCHEMA_VERSION,
  };
}

/**
 * 將歷史檔案整理成 Project.apply 可消費的資料形狀；不改寫既有欄位語意。
 * 缺少版本的舊檔保留為 v1，讓既有字幕軌索引轉換繼續生效。
 */
function migrateProjectSchema(rawProject) {
  if (!isRecord(rawProject)) return null;
  const data = cloneProjectValue(rawProject);
  const rawVersion = data.version;
  if (rawVersion === undefined || rawVersion === null) data.version = 1;
  else {
    const version = Number(rawVersion);
    data.version = Number.isFinite(version) && version >= 1 ? Math.floor(version) : 1;
  }

  data.tracks = arrayOrEmpty(data.tracks);
  if (!data.tracks.length) data.tracks = [{ name: '軌道 1', visible: true, locked: false }];
  data.cues = arrayOrEmpty(data.cues);
  data.clips = arrayOrEmpty(data.clips);
  data.videoTracks = arrayOrEmpty(data.videoTracks);
  data.notes = arrayOrEmpty(data.notes);
  data.usedPresets = arrayOrEmpty(data.usedPresets);
  data.externalAudioSources = arrayOrEmpty(data.externalAudioSources);
  if (!isRecord(data.media)) data.media = {};
  if (!isRecord(data.audioProject)) delete data.audioProject;
  return data;
}

/** 驗證正規化後仍可安全套用的最低契約；不以嚴格 schema 阻斷舊檔。 */
function validateProjectIntegrity(projectData) {
  const errors = [];
  if (!isRecord(projectData)) return { valid: false, errors: ['專案資料必須是 JSON 物件'] };
  if (!Number.isFinite(Number(projectData.version)) || Number(projectData.version) < 1) {
    errors.push('專案版本必須是大於等於 1 的數值');
  }
  if (projectData.fps !== undefined && (!Number.isFinite(Number(projectData.fps)) || Number(projectData.fps) <= 0)) {
    errors.push('專案 FPS 必須為大於 0 的數值');
  }
  for (const key of ['tracks', 'cues', 'clips']) {
    if (!Array.isArray(projectData[key])) errors.push(`專案 ${key} 必須為陣列`);
  }
  return { valid: errors.length === 0, errors };
}


/* ===== 自動備份狀態 ===== */
let _editGuardDone = false;  // 本 session 是否已顯示過「請先儲存」提示
let _savePath      = null;   // 上次儲存的完整路徑（desktop only）
let _saveBaseName  = null;   // 基礎名稱（不含副檔名），自動備份用
let _autoSaveTimer = null;
let _lastSavedDataStr = null; // 用於判斷專案是否被修改
const _projectLoadSession = new ProjectLoadSession();

function _defaultSaveName(){
  return (State.mediaName ? State.mediaName.replace(/\.[^.]+$/,'') : 'project')+'.subtool';
}

export function getProjectDir() {
  if (!_savePath) return null;
  return _savePath.replace(/[^\\/]+$/, '');
}

/* 專案檔只保留外部音檔可重建所需的純資料；Audio / WebAudio / wave cache 等 runtime
   物件一律不寫入。瀏覽器版不保留本機絕對路徑，與主影片的儲存規則一致。 */
function _normalExternalAudioSources(rawSources){
  const seen=new Set();
  const safeNumber=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
  const nonNegative=(value,fallback=0)=>Math.max(0,safeNumber(value,fallback));
  const sources=[];
  for(const raw of (Array.isArray(rawSources)?rawSources:[])){
    if(!raw||typeof raw!=='object') continue;
    const audioSourceId=typeof raw.audioSourceId==='string'?raw.audioSourceId.trim():'';
    if(!audioSourceId||seen.has(audioSourceId)) continue;
    seen.add(audioSourceId);
    const timelineLaneId=typeof raw.timelineLaneId==='string'&&raw.timelineLaneId.trim()
      ? raw.timelineLaneId.trim() : audioSourceId;
    const inPoint=nonNegative(raw.in??raw.trimStart);
    const rawOut=safeNumber(raw.out??raw.trimEnd,NaN);
    const duration=nonNegative(raw.duration);
    const out=Number.isFinite(rawOut)?Math.max(inPoint,duration?Math.min(rawOut,duration):rawOut):duration;
    const descriptors=(Array.isArray(raw.descriptors)?raw.descriptors:[]).map((channel,index)=>({
      sourceStream:Math.max(0,Math.floor(safeNumber(channel?.sourceStream,0))),
      sourceChannel:Math.max(0,Math.floor(safeNumber(channel?.sourceChannel,index)))
    }));
    sources.push({
      name:(typeof raw.name==='string'&&raw.name.trim())||'外部音訊',
      // 網頁版不會保存或重開本機路徑；使用者仍可自行重新匯入。
      path:IS_DESKTOP&&typeof raw.path==='string'&&raw.path?raw.path:null,
      audioSourceId, timelineLaneId,
      offset:nonNegative(raw.offset), in:inPoint, out, duration,
      gain:nonNegative(raw.gain,1), fadeIn:nonNegative(raw.fadeIn), fadeOut:nonNegative(raw.fadeOut),
      enabled:raw.enabled!==false, locked:!!raw.locked,
      // 已解除自影片容器的音訊必須在重開專案時仍直接走 ffmpeg cache；否則 MXF／
      // 部分 MOV 會再次被 Chromium <audio> 拒絕，讓「解除影音」看似消失。
      ...(raw.preferCache===true?{preferCache:true}:{}),
      descriptors
    });
  }
  return sources;
}
function _externalAudioEnd(sources){
  return (Array.isArray(sources)?sources:[]).reduce((end,source)=>{
    const offset=Math.max(0,Number(source?.offset)||0);
    const inPoint=Math.max(0,Number(source?.in??source?.trimStart)||0);
    const rawOut=Number(source?.out??source?.trimEnd??source?.duration);
    const out=Number.isFinite(rawOut)?Math.max(inPoint,rawOut):inPoint;
    return Math.max(end,offset+Math.max(0,out-inPoint));
  },0);
}

function _savedExternalAudioSources(){
  let live=[];
  try{ live=Media.externalAudio?.list?.() || []; }catch(e){}
  // 尚未能重新開啟（例如暫時找不到檔案）的來源也要繼續留在專案檔，避免下一次儲存遺失。
  const pending=_projectLoadSession.activePlan?.pendingExternalAudioSources?.()||[];
  return _normalExternalAudioSources([...(Array.isArray(live)?live:[]), ...pending]);
}
/* 開啟專案到主影片尚未重建的短暫期間，clip 會保存在 ProjectLoadSession 的 restore plan。
   儲存／dirty 判斷都必須把它們算進去，否則純圖片專案會在重開後尚未還原
   畫面前就被當成空專案覆寫。 */
function _savedClips(){
  const live=Array.isArray(State.clips)?State.clips:[];
  const pending=_projectLoadSession.activePlan?.pendingClips?.()||[];
  if(!pending.length) return live;
  const liveIds=new Set(live.map(clip=>clip?.id).filter(Boolean));
  return [...live,...pending.filter(clip=>!clip?.id||!liveIds.has(clip.id))];
}

function _normalisedProjectData(rawData){
  const data=migrateProjectSchema(rawData);
  const integrity=validateProjectIntegrity(data);
  if(integrity.valid) return data;
  console.warn('invalid project document:',integrity.errors);
  showToast('專案檔格式不完整，無法開啟');
  return null;
}

async function _restorePendingExternalAudioSources(plan=_projectLoadSession.activePlan){
  const ownsPlan=()=>_projectLoadSession.activePlan===plan&&(!plan?.owns||plan.owns());
  const pending=_normalExternalAudioSources(plan?.pendingExternalAudioSources?.());
  if(!pending.length){ plan?.replaceExternalAudioSources?.([]); return {restored:0,pending:0}; }
  if(!IS_DESKTOP||typeof Media.restoreExternalAudioSource!=='function') return {restored:0,pending:pending.length};

  const existing=new Set();
  try{
    for(const source of (Media.externalAudio?.list?.() || [])){
      if(source?.audioSourceId) existing.add(String(source.audioSourceId));
    }
  }catch(e){}

  const unresolved=[];
  let restored=0;
  for(const source of pending){
    if(!ownsPlan()) return {restored:0,pending:pending.length,cancelled:true};
    if(existing.has(source.audioSourceId)){ restored++; continue; }
    if(!source.path){ unresolved.push(source); continue; }
    let exists=true;
    if(typeof DESK?.stat==='function'){
      try{ exists=!!(await DESK.stat(source.path))?.exists; }catch(e){ exists=false; }
    }
    if(!ownsPlan()) return {restored:0,pending:pending.length,cancelled:true};
    if(!exists){
      console.warn('external audio source is unavailable:',source.path);
      unresolved.push(source);
      continue;
    }
    try{
      // _restore 避免每支外部音檔重新載入時搶走主影片的目前音源選取。
      const asset=await Media.restoreExternalAudioSource({...source,_restore:true},null,ownsPlan);
      if(!ownsPlan()){
        // Production restore returns the exact runtime object it inserted.  A
        // test adapter may ignore the upstream lease, so only remove by id
        // when object identity proves the stale asset is still registered.
        if(asset&&Array.isArray(Media.externalAudioSources)&&Media.externalAudioSources.includes(asset)){
          Media.removeExternalAudio?.(asset.id,{record:false});
        }
        return {restored:0,pending:pending.length,cancelled:true};
      }
      if(asset){ existing.add(source.audioSourceId); restored++; }
      else unresolved.push(source);
    }catch(e){
      if(!ownsPlan()) return {restored:0,pending:pending.length,cancelled:true};
      console.warn('restore external audio source:',source.path,e);
      unresolved.push(source);
    }
  }
  if(!ownsPlan()) return {restored:0,pending:pending.length,cancelled:true};
  plan?.replaceExternalAudioSources?.(unresolved);
  // 未找到檔案的來源仍要保留其可編輯 timeline metadata；否則一開專案就會被
  // 影片長度截短，下一次另行重新連結音檔時位置也會看起來消失。
  let live=[];
  try{ live=Media.externalAudio?.list?.() || []; }catch(e){}
  if(!ownsPlan()) return {restored:0,pending:pending.length,cancelled:true};
  State.externalAudioState=[...(Array.isArray(live)?live:[]),...unresolved];
  State.externalAudioEnd=_externalAudioEnd(State.externalAudioState);
  return {restored,pending:unresolved.length};
}

function _buildProjectData(){
  const usedPresets = [];
  const allPresets = getAllPresets();
  const keys = Object.keys(STYLE_DEFAULTS);
  
  const checkStyle = (st) => {
    for (const p of allPresets) {
      if (p.builtin) continue;
      const ps = p.style || {};
      const match = keys.every(k => (ps[k] != null ? ps[k] : STYLE_DEFAULTS[k]) === st[k]);
      if (match && !usedPresets.some(x => x.name === p.name)) {
        usedPresets.push({ name: p.name, style: p.style });
      }
    }
  };
  
  for (const t of State.tracks) checkStyle(effStyle(null, t));
  for (const c of State.cues) checkStyle(effStyle(c, State.tracks[c.track || 0]));

  return createProjectSnapshot({
    playhead: Math.max(0, Media.displayTime() || 0),
    media:{name:State.mediaName,size:State.mediaSize,path:IS_DESKTOP?State.mediaPath:null},
    fps:State.fps, dropFrame:State.dropFrame, duration:State.duration, trackCount:State.trackCount,
    // 存檔時固定展開「當下生效樣式」，避免日後 STYLE_DEFAULTS 調整後讓既有專案外觀漂移。
    // posPct 僅供舊版 SUB Tool 讀取；新版以同值的 posY 為準。
    tracks:State.tracks.map(t=>{
      const st=trackStyleSnapshot(t);
      return {name:t.name,visible:t.visible!==false,locked:!!t.locked,...st,posPct:st.posY};
    }),
    pxPerSec:State.pxPerSec,
    ...(State.exportIn!=null?{exportIn:State.exportIn}:{}),
    ...(State.exportOut!=null?{exportOut:State.exportOut}:{}),
    // 影片序列（v4.5.0；v4.10.0 起含多視訊軌）：各段的來源路徑與幾何；網頁版無路徑（開啟時需手動重加）
    videoTracks:State.videoTracks.map(t=>({name:t.name,visible:t.visible!==false,locked:!!t.locked,
      ...(t.scale!=null?{scale:t.scale}:{}),...(t.opacity!=null?{opacity:t.opacity}:{}),...(t.posX!=null?{posX:t.posX}:{}),...(t.posY!=null?{posY:t.posY}:{})})),
    videoTrackCount:State.videoTracks.length||1, // 向下相容：舊版讀取用
    vtracksCollapsed:!!State.vtracksCollapsed,
    clips:_savedClips().map(c=>({name:c.name,path:c.path||null,dur:c.dur,in:c.in,out:c.out,offset:c.offset,vtrack:c.vtrack||0,fps:c.fps||0,primary:!!c.primary,locked:!!c.locked,
      // 圖片需保留型別與自己的幾何。少了 type 會在重開專案時被誤當成影片
      // 丟給 ffprobe；少了 scale/posX/posY 則會回到預設滿版中央。
      // natW/natH＝圖片原始像素尺寸；少了它重開專案要等背景重量一次才對得準互動框。
      ...(c.type==='image'?{type:'image',scale:c.scale!=null?c.scale:1,posX:c.posX!=null?c.posX:0.5,posY:c.posY!=null?c.posY:0.5,
        ...(c.natW>0&&c.natH>0?{natW:c.natW,natH:c.natH}:{})}:{}),
      ...(c.audioSourceId!=null?{audioSourceId:String(c.audioSourceId)}:(c.audioSrc!=null?{audioSourceId:String(c.audioSrc)}:{})),
      ...(c.audioDetached?{audioDetached:true}:{}),
      ...(c.muted?{muted:true}:{}),
      ...(c.fadeIn?{fadeIn:c.fadeIn}:{}),...(c.fadeOut?{fadeOut:c.fadeOut}:{})})),
    // v3：只存純資料的 project bus / source routing / export stream；Media 的 runtime 資源絕不寫入專案檔。
    audioProject:normalizeAudioProject(State.audioProject),
    // v3：外部音檔獨立於影片 clip，路徑只在桌面版用來重開。
    externalAudioSources:_savedExternalAudioSources(),
    notes:State.notes.map(n=>({time:n.time,text:n.text,done:!!n.done})),
    cues:State.cues.map(c=>({start:c.start,end:c.end,text:c.text,track:(c.track||0)+1,timed:c.timed!==false,
      ...(c.style&&Object.keys(c.style).length?{style:c.style}:{})})), // v4.23 逐句樣式覆蓋（有才存）
    usedPresets
  });
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

/* 會丟棄目前專案的動作（開啟另一個專案）之前的確認。
   回傳 true＝可以繼續，false＝使用者取消。

   為什麼要有這個：關閉視窗時會問「要不要存」（app.js 的 onAppRequestClose），
   但「開啟另一個專案」原本【完全沒有問】——三條開啟路徑（選單開啟、Explorer 雙擊
   .subtool、瀏覽器版選檔）都直接 Project.load*()，未存檔的內容就這樣沒了，
   而且沒有任何提示。這裡把那個提示補上，並讓三條路徑共用同一份。 */
function confirmDiscardUnsaved(title = '開啟另一個專案'){
  if(!isProjectDirty()) return Promise.resolve(true);
  return new Promise(resolve=>{
    openModal(title,
      '<p>目前的專案有未儲存的變更，開啟另一個專案會失去這些變更。<br>要先儲存嗎？</p>',
      [
        // 等儲存真正完成（拿到路徑）才繼續；使用者取消存檔對話框則留在原專案，
        // 與關閉視窗時的處理一致，避免「以為存好了其實沒有」。
        {label:'儲存後開啟',primary:true,act:async()=>{
          const pth=await Project.save();
          if(pth){ closeModal(); resolve(true); }
          else closeModal(), resolve(false);
        }},
        {label:'不儲存直接開啟',act:()=>{ closeModal(); resolve(true); }},
        {label:'取消',act:()=>{ closeModal(); resolve(false); }},
      ]);
  });
}

/* 開新專案時重置所有儲存狀態 */
function resetProject(){
  _editGuardDone=false;
  _savePath=null;
  _saveBaseName=null;
  _lastSavedDataStr=null;
  if(_autoSaveTimer){ clearInterval(_autoSaveTimer); _autoSaveTimer=null; }
  resetAudioProject();
  State.vtracksCollapsed=false;
  State.exportIn=null;
  State.exportOut=null;
  _projectLoadSession.clearPlan();
}

function _hasAudioProjectData(){
  const ap=normalizeAudioProject(State.audioProject);
  return ap.mode!=='auto'||ap.buses.length>0||Object.keys(ap.sourceMaps).length>0||ap.exportLayout.streams.length>0;
}

function isProjectDirty() {
  // v3 的 bus / routing / export layout 是可獨立於字幕存在的專案內容，不能被舊的「無字幕＝未修改」捷徑忽略。
  // 圖片／影片 clip 也是專案內容；尤其圖片大小或位置被調整後，不能因為沒有字幕
  // 就讓關閉視窗流程誤判為未修改。
  if (State.cues.length === 0 && State.notes.length === 0 && !_hasAudioProjectData() && _savedClips().length===0) return false;
  if (!_lastSavedDataStr) return true;
  
  const currentStr = JSON.stringify(_buildProjectData());
  if (currentStr === _lastSavedDataStr) return false;
  
  // 忽略 playhead 的差異（播放點改變不應視為專案已修改而阻擋關閉）
  try {
    const current = JSON.parse(currentStr);
    const last = JSON.parse(_lastSavedDataStr);
    current.playhead = 0;
    last.playhead = 0;
    return JSON.stringify(current) !== JSON.stringify(last);
  } catch (e) {
    return true;
  }
}

function _finishProjectLoad(){
  // Undo 的「初始」必須以媒體與所有 pending clip 都完成還原後的序列為準。
  // 若在 apply() 當下建立，第一個影片編輯再 Undo 會回到空序列。
  History.reset();
  _lastSavedDataStr = JSON.stringify(_buildProjectData());
  setStatus('專案已載入','ok');
}

function _restorePendingPlayhead(plan=_projectLoadSession.activePlan){
  const raw=plan?.peekPlayhead?.();
  if(!Number.isFinite(raw)) return false;
  const target=Math.max(0,raw);
  try{
    Media.seek(target);
    plan?.clearPlayhead?.();
    return true;
  }catch(error){
    console.warn('restore project playhead:',error);
    return false;
  }
}

/* ProjectLoadSession owns the latest-wins generation, serial runtime tail, and
   temporary restore material. Project and Media exchange the plan explicitly
   instead of smuggling it through State. */
function _isCurrentProjectLoad(generation){ return _projectLoadSession.isCurrent(generation); }
function _appendProjectLoad(generation,work){ return _projectLoadSession.append(generation,work); }
function _queueProjectLoad(work){
  const generation=_projectLoadSession.begin();
  return _appendProjectLoad(generation,()=>work(generation));
}

function _restoreSubtitleTrack(raw,index){
  const saved=raw&&typeof raw==='object'?raw:{};
  const track={
    name:saved.name||('軌道 '+(index+1)),
    visible:saved.visible!==false,
    locked:!!saved.locked
  };
  // 只還原專案內實際存在的 canonical 欄位；缺值繼續交由 effStyle 的單一預設來源處理。
  for(const key of Object.keys(STYLE_DEFAULTS)){
    if(saved[key]!=null) track[key]=saved[key];
  }
  // 舊格式別名只在 canonical 欄位不存在時遷移，不能覆蓋使用者曾明確存下的 65／91.2037。
  if(track.fontSize==null&&saved.fontScale!=null){
    const scale=Number(saved.fontScale);
    if(Number.isFinite(scale)) track.fontSize=Math.round(60*scale);
  }
  if(track.posY==null&&saved.posPct!=null) track.posY=saved.posPct;
  return track;
}

/* ===== 8. 專案 .subtool ============================================== */

async function _autoRelinkMissingMedia(data, projectPath) {
  if (!IS_DESKTOP || typeof DESK.findRelinkTarget !== 'function') return;
  
  async function checkAndRelink(obj, pathKey) {
    if (!obj || !obj[pathKey]) return;
    const p = obj[pathKey];
    try {
      const stat = await DESK.stat(p);
      if (!stat.exists) {
        const newPath = await DESK.findRelinkTarget(projectPath, p);
        if (newPath) obj[pathKey] = newPath;
      }
    } catch(e) {}
  }
  
  if (data.media) await checkAndRelink(data.media, 'path');
  
  if (Array.isArray(data.clips)) {
    for (const clip of data.clips) {
      await checkAndRelink(clip, 'path');
      await checkAndRelink(clip, 'audioSrc');
    }
  }
  
  if (Array.isArray(data.externalAudioSources)) {
    for (const src of data.externalAudioSources) {
      await checkAndRelink(src, 'path');
    }
  }
}

const Project = {
  // save/saveAs 回傳 Promise<路徑|名稱|null>：null=失敗或使用者取消。
  // 呼叫端（如關閉前儲存流程）可 await 確認真正寫入完成後再繼續。
  continueLoad(generation,work){
    return _appendProjectLoad(generation,()=>work(()=>_isCurrentProjectLoad(generation)));
  },
  /* 專案主媒體暫時找不到、使用者按稍後或取消檔案選擇器時，restore plan 必須保留到
     下一次真正載入主影片。這是顯式 hand-off，不再把 pending material 塞回 State。 */
  pendingMediaRelink(){
    const plan=_projectLoadSession.activePlan;
    if(!plan?.needsMediaRelink?.()) return null;
    return { generation:_projectLoadSession.generation, plan };
  },
  /* 瀏覽器版重選媒體沒有桌面版的 loadDesktopMedia await 鏈。
     由 app 在同一個 latest-wins transaction 內呼叫，等 Media 已完成其 pending
     restore 後才還原播放點；不能再靠已移除的全域 media:projectReady 訂閱。 */
  async finishMediaRelink(generation,plan){
    if(!_isCurrentProjectLoad(generation)||_projectLoadSession.activePlan!==plan) return false;
    try{ await Media.waitForPendingProjectRestore?.(); }catch(error){ console.warn('restore browser project clips:',error); }
    if(!_isCurrentProjectLoad(generation)||_projectLoadSession.activePlan!==plan) return false;
    await _restorePendingExternalAudioSources(plan);
    if(!_isCurrentProjectLoad(generation)||_projectLoadSession.activePlan!==plan) return false;
    _restorePendingPlayhead(plan);
    _finishProjectLoad();
    return true;
  },
  // 保留明確名稱給既有 browser 呼叫端；實際語意由同一個跨平台 completion 收斂。
  finishBrowserMediaRelink(generation,plan){ return this.finishMediaRelink(generation,plan); },
  startNewProject(work){
    const generation=_projectLoadSession.begin();
    return _appendProjectLoad(generation,work);
  },
  async _checkMissingFonts(data) {
    const requiredFonts = new Set();
    if (Array.isArray(data.tracks) && data.tracks.length > 0) {
      for (const t of data.tracks) {
        if (t.font) requiredFonts.add(t.font);
        else requiredFonts.add(STYLE_DEFAULTS.font);
      }
    } else {
      requiredFonts.add(STYLE_DEFAULTS.font);
    }
    if (Array.isArray(data.cues)) {
      for (const c of data.cues) {
        if (c.style && c.style.font) requiredFonts.add(c.style.font);
      }
    }
    const missing = [];
    for (const font of requiredFonts) {
      if (!this._isFontAvailable(font)) {
        missing.push(font);
      }
    }
    return missing;
  },
  _isFontAvailable(fontName) {
    if (!fontName) return true;
    try {
      if (typeof document !== 'undefined' && document.fonts && document.fonts.check(`12px "${fontName}"`)) return true;
    } catch(e) {}
    if (typeof document === 'undefined') return true;
    
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return true;
    
    const text = "abcdefghijklmnopqrstuvwxyz0123456789";
    
    context.font = "72px monospace";
    const baselineMono = context.measureText(text).width;
    context.font = `72px "${fontName}", monospace`;
    const newMono = context.measureText(text).width;
    if (newMono !== baselineMono) return true;
    
    context.font = "72px sans-serif";
    const baselineSans = context.measureText(text).width;
    context.font = `72px "${fontName}", sans-serif`;
    const newSans = context.measureText(text).width;
    if (newSans !== baselineSans) return true;
    
    return false;
  },
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
  apply(data,generation=null){
    data=_normalisedProjectData(data);
    if(!data) return false;
    _editGuardDone = true; // 開啟舊檔後不需再次跳出存檔提示
    // Fix #19：明確排除 undefined/null，避免 version:0 被誤判為 v1（0 是 falsy）
    const isV1 = data.version === undefined || data.version === null || data.version === 1;
    // Media.reset() 會釋放播放器資源，但不覆寫專案顯示名稱／路徑；讀取新專案時
    // 必須以檔案內 metadata 取代它，否則「純音訊」或主影片遺失的專案下次儲存
    // 可能錯把前一個專案的影片路徑寫回去。
    const savedMedia=(data.media&&typeof data.media==='object')?data.media:{};
    State.mediaName=typeof savedMedia.name==='string'&&savedMedia.name?savedMedia.name:null;
    State.mediaSize=Math.max(0,Number(savedMedia.size)||0);
    State.mediaPath=IS_DESKTOP&&typeof savedMedia.path==='string'&&savedMedia.path?savedMedia.path:null;
    const mediaRelink=!!(State.mediaPath||State.mediaName);
    State.cues=(data.cues||[]).map(c=>{
      let tk = c.track||0;
      if (!isV1 && c.track !== undefined) tk = Math.max(0, c.track - 1);
      return {id:newId(),start:c.start||0,end:c.end||0,text:c.text||'',track:tk,timed:c.timed!==false,
        ...(c.style&&typeof c.style==='object'?{style:{...c.style}}:{})}; // v4.23 逐句樣式覆蓋
    });
    setFps(data.dropFrame?String(data.fps||24)+'df':String(data.fps||24));
    const maxTk=State.cues.length > 0 ? State.cues.reduce((m,c)=>Math.max(m,c.track||0),0) : -1;
    if(Array.isArray(data.tracks)&&data.tracks.length) State.tracks=data.tracks.map(_restoreSubtitleTrack);
    else State.tracks=[];
    ensureTrackCount(Math.max(data.trackCount!==undefined?data.trackCount:1, maxTk+1));
    State.notes=(data.notes||[]).map(n=>({id:newId(),time:n.time||0,text:n.text||'',done:!!n.done}));

    // v3 專案音訊資料；v1/v2 沒有可可靠還原的來源聲道資訊，安全遷移為空的 auto 專案。
    // 待媒體重新載入時，Media 會以來源 metadata 呼叫 ensureAudioSourceMap 建立一對一預設路由。
    if(data.audioProject&&typeof data.audioProject==='object') State.audioProject=normalizeAudioProject(data.audioProject);
    else resetAudioProject();
    // 外部音檔不屬於 video clip，先保留成 pending；桌面版在主影片完成載入後再依 path 還原。
    // 瀏覽器版刻意不自動重開本機檔案，讓使用者自行重新選取。
    const pendingExternal=_normalExternalAudioSources(data.externalAudioSources);
    State.externalAudioState=pendingExternal;
    State.externalAudioEnd=_externalAudioEnd(pendingExternal);
    
    if (Array.isArray(data.usedPresets) && data.usedPresets.length > 0) {
      const list = [...getPresets()];
      let changed = false;
      for (const p of data.usedPresets) {
        if (!p.name || !p.style || isBuiltinPresetName(p.name)) continue;
        const ex = list.findIndex(x => x.name === p.name);
        if (ex >= 0) {
           const isDiff = Object.keys(STYLE_DEFAULTS).some(k => (list[ex].style[k]!=null?list[ex].style[k]:STYLE_DEFAULTS[k]) !== (p.style[k]!=null?p.style[k]:STYLE_DEFAULTS[k]));
           if (isDiff) {
              p.name = p.name + ' (專案)';
              const ex2 = list.findIndex(x => x.name === p.name);
              if (ex2 >= 0) list[ex2] = p; else list.push(p);
              changed = true;
           }
        } else {
           list.push(p);
           changed = true;
        }
      }
      if (changed) {
        savePresets(list);
        emit('render:trackStyle');
      }
    }

    // 影片序列：先暫存，待第一支影片載入完成（Media._registerPrimary）時還原幾何並補載其餘段
    // 視訊軌：新版存 videoTracks 陣列（名稱/顯示/鎖定）；舊版只有 videoTrackCount → 補足空軌
    if(Array.isArray(data.videoTracks) && data.videoTracks.length)
      State.videoTracks = data.videoTracks.map((t,i)=>({name:t.name||('視訊軌 '+(i+1)),visible:t.visible!==false,locked:!!t.locked,
        ...(t.scale!=null?{scale:t.scale}:{}),...(t.opacity!=null?{opacity:t.opacity}:{}),...(t.posX!=null?{posX:t.posX}:{}),...(t.posY!=null?{posY:t.posY}:{})}));
    else { resetVideoTracks(); ensureVideoTrackCount(Math.max(1, data.videoTrackCount || 1)); }
    // 視訊軌收合屬於專案工作區狀態；舊專案沒有此欄位時維持原本的展開預設。
    State.vtracksCollapsed=data.vtracksCollapsed===true;
    const pendingClips = (Array.isArray(data.clips) && data.clips.length) ? data.clips.map(raw=>{
      const clip=(raw&&typeof raw==='object')?{...raw}:{};
      // audioSrc 是 v4.35 runtime 名稱；v3 專案檔改存 audioSourceId，讀舊資料時保留相同來源識別。
      if(clip.audioSourceId==null&&clip.audioSrc!=null) clip.audioSourceId=String(clip.audioSrc);
      return clip;
    }) : [];
    State.duration=data.duration||State.duration;
    State.pxPerSec=data.pxPerSec||80;
    State.exportIn=data.exportIn!=null?data.exportIn:null;
    State.exportOut=data.exportOut!=null?data.exportOut:null;
    State.listTrack=0;
    deselect('sub'); // 開啟專案後預設不選取任何字幕
    const playhead=data.playhead != null&&typeof data.playhead==='number' ? Math.max(0,data.playhead) : null;
    _projectLoadSession.createRestorePlan(generation,{clips:pendingClips,externalAudioSources:pendingExternal,playhead,mediaRelink});
    emit('render:listTrackSel'); emit('render:all'); drawTimeline(); renderNotes();
    return true;
  },
  load(file){
    return _queueProjectLoad(generation=>this._load(file,generation));
  },
  async _load(file,generation){
    const buf=await readFile(file);
    if(!_isCurrentProjectLoad(generation)) return;
    let data; try{ data=_normalisedProjectData(JSON.parse(decodeText(buf))); }catch(e){ showToast('無法解析專案檔'); return; }
    if(!data) return;
    
    let missing = await this._checkMissingFonts(data);
    while (missing.length > 0) {
      const proceed = await new Promise(resolve => {
        const buttons = [];
        if (IS_DESKTOP && DESK && DESK.importFont) {
          buttons.push({label:'匯入字體檔案', act: async ()=>{
            const imported = await DESK.importFont();
            if (imported) {
              await loadFonts(true);
              closeModal();
              resolve('recheck');
            }
          }});
        }
        buttons.push({label:'先退出', primary:true, act:()=>{ closeModal(); resolve('cancel'); }});
        buttons.push({label:'強制繼續開啟', act:()=>{ closeModal(); resolve('continue'); }});
        
        openModal('缺少字體',
          `此專案使用了您電腦上尚未安裝的字體：<br><br><b>${missing.map(escapeHTML).join(', ')}</b><br><br>繼續開啟可能會導致字形樣式被破壞。您要先退出以匯入該字體檔案，還是強制繼續開啟？`,
          buttons
        );
      });
      if (proceed === 'cancel') return;
      if (proceed === 'continue') break;
      if (proceed === 'recheck') {
        missing = await this._checkMissingFonts(data);
      }
    }

    // 載入另一個專案必須先清掉舊的 runtime 媒體。尤其當新專案的主影片暫時
    // 找不到時，後續還原外部音檔不能和前一個專案殘留的 asset 混在一起。
    try{ Media.reset(); }catch(e){ console.warn('reset media before project load:',e); }
    if(!this.apply(data,generation)) return;
    if(!_isCurrentProjectLoad(generation)) return;
    if(data.media&&data.media.name){
      const plan=_projectLoadSession.activePlan;
      const extCount=plan?.pendingExternalAudioSources?.().length||0;
      openModal('請重新選取影音檔',
        `此專案對應的影音檔為：<br><br><b>${escapeHTML(data.media.name)}</b><br><br>`+
        `基於瀏覽器安全限制，無法自動開啟原始檔路徑，請手動重新匯入同一支影片以還原預覽與波形。`+
        (extCount?`<br><br>此外有 ${extCount} 支外部音檔，亦請在載入後手動重新匯入。`:``)+
        `<br><br>字幕內容已完整還原。`,
        [{label:'立即匯入影音',primary:true,act:()=>{
          closeModal();
          if(_isCurrentProjectLoad(generation)) emit('project:relinkBrowserMedia',generation,plan);
        }},{label:'稍後',act:closeModal}]);
    }
    if(_isCurrentProjectLoad(generation)) _finishProjectLoad();
  },
  loadDesktop(r){
    return _queueProjectLoad(generation=>this._loadDesktop(r,generation));
  },
  async _loadDesktop(r,generation){
    let data; try{ data=_normalisedProjectData(JSON.parse(decodeText(b64ToBytes(r.b64).buffer))); }catch(e){ showToast('無法解析專案檔'); return; }
    if(!data) return;
    
    let missing = await this._checkMissingFonts(data);
    while (missing.length > 0) {
      const proceed = await new Promise(resolve => {
        const buttons = [];
        if (IS_DESKTOP && DESK && DESK.importFont) {
          buttons.push({label:'匯入字體檔案', act: async ()=>{
            const imported = await DESK.importFont();
            if (imported) {
              await loadFonts(true);
              closeModal();
              resolve('recheck');
            }
          }});
        }
        buttons.push({label:'先退出', primary:true, act:()=>{ closeModal(); resolve('cancel'); }});
        buttons.push({label:'強制繼續開啟', act:()=>{ closeModal(); resolve('continue'); }});
        
        openModal('缺少字體',
          `此專案使用了您電腦上尚未安裝的字體：<br><br><b>${missing.map(escapeHTML).join(', ')}</b><br><br>繼續開啟可能會導致字形樣式被破壞。您要先退出以匯入該字體檔案，還是強制繼續開啟？`,
          buttons
        );
      });
      if (proceed === 'cancel') return;
      if (proceed === 'continue') break;
      if (proceed === 'recheck') {
        missing = await this._checkMissingFonts(data);
      }
    }

    await _autoRelinkMissingMedia(data, r.path);
    if(!_isCurrentProjectLoad(generation)) return;
    const mp=data.media&&data.media.path;
    // stat 是唯讀，可在碰 State 之前先完成；若期間有更新請求，舊專案完全不進入 runtime。
    let mediaStat=null;
    if(mp){
      mediaStat=await DESK.stat(mp);
      if(!_isCurrentProjectLoad(generation)) return;
    }
    // 同上：即使原主影片不存在或使用者選擇「稍後」，也不能讓舊專案的
    // externalAudioSources 留在目前專案、造成播放或匯出重複音訊。
    try{ Media.reset(); }catch(e){ console.warn('reset media before desktop project load:',e); }
    if(!this.apply(data,generation)) return;
    const plan=_projectLoadSession.activePlan;
    // 載入既有專案時記錄儲存路徑，自動備份用
    if(r.path){ _savePath=r.path; _saveBaseName=r.path.replace(/\\/g,'/').split('/').pop().replace(/\.subtool$/i,''); if(!_autoSaveTimer) _autoSaveTimer=setInterval(_autoSave,3*60*1000); }
    if(mp){
      if(mediaStat?.exists){
        // 等主影片完成初始化後才掛外部音檔，避免 Media.loadDesktopMedia 的 reset 清掉剛重建的音源。
        try{ await Media.loadDesktopMedia(mp,plan); }catch(e){ console.warn('load project media:',e); }
        // _registerPrimary 會背景還原其餘影片／圖片；Undo 基準必須等它們全部完成。
        try{ await Media.waitForPendingProjectRestore?.(); }catch(e){ console.warn('restore project clips:',e); }
        if(!_isCurrentProjectLoad(generation)) return;
        await _restorePendingExternalAudioSources(plan);
        if(!_isCurrentProjectLoad(generation)) return;
        _restorePendingPlayhead(plan);
      }
      else openModal('找不到原影片',
        `專案紀錄的影片路徑不存在：<br><br><b>${escapeHTML(mp)}</b><br><br>請手動重新匯入。字幕已還原。`,
        [{label:'匯入影音',primary:true,act:()=>{
          if(!_isCurrentProjectLoad(generation)){ closeModal(); return Promise.resolve(); }
          return _appendProjectLoad(generation,async()=>{
          closeModal();
          const picked=await DESK.openMedia();
          if(!_isCurrentProjectLoad(generation)) return;
          // 開啟影音現在可多選；這個「找回原主影片」流程只需要第一個檔案。
          const p=Array.isArray(picked)?picked[0]:picked;
          if(p){
            try{ await Media.loadDesktopMedia(p,plan); }catch(e){ console.warn('load replacement media:',e); }
            try{ await Media.waitForPendingProjectRestore?.(); }catch(e){ console.warn('restore replacement clips:',e); }
            if(!_isCurrentProjectLoad(generation)) return;
          }
          await _restorePendingExternalAudioSources(plan);
          if(_isCurrentProjectLoad(generation)) _restorePendingPlayhead(plan);
          });
        }},{label:'稍後',act:()=>{
          if(!_isCurrentProjectLoad(generation)){ closeModal(); return Promise.resolve(); }
          return _appendProjectLoad(generation,async()=>{
            closeModal();
            await _restorePendingExternalAudioSources(plan);
          });
        }}]);
    }else{
      // 純音訊專案沒有主影片可觸發 reset，因此先清舊媒體，再重建外部音檔。
      try{ Media.reset(); }catch(e){}
      // 純圖片專案同樣沒有主影片可觸發 _registerPrimary；直接從 restore plan
      // 資料重建圖片，否則重開後只剩空時間軸。
      try{ await Media.restorePendingImageClips?.(plan); }catch(e){ console.warn('restore pending image clips:',e); }
      if(!_isCurrentProjectLoad(generation)) return;
      await _restorePendingExternalAudioSources(plan);
      if(!_isCurrentProjectLoad(generation)) return;
      _restorePendingPlayhead(plan);
    }
    if(_isCurrentProjectLoad(generation)) _finishProjectLoad();
  }
};

async function openMedia({ relink: requestedRelink = null } = {}) {
  const { pickMediaFiles, importDesktopMediaFiles, importBrowserMediaFiles } = await import('./media-loader.js');
  const relink = requestedRelink || Project.pendingMediaRelink?.() || null;
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

async function openProject() {
  const { pickFile } = await import('./util.js');
  if (!await confirmDiscardUnsaved()) return;
  if (IS_DESKTOP) { const r = await DESK.openProject(); if (r) Project.loadDesktop(r); }
  else { const f = await pickFile($('fileProject')); if (f) Project.load(f); }
}

function saveProject() { Project.save(); }
function saveAsProject() { Project.saveAs(); }

function startNewProject() {
  openModal('開新專案',
    '<p>確定清空目前專案？字幕、備註與已載入的影音都將清除（未存檔的話）。</p>',
    [{ label: '取消', act: closeModal },
     { label: '確定清空', primary: true, act: () => {
       closeModal();
       return Project.startNewProject(async () => {
         const { clearSelection, ensureTrackCount: ensureTk } = await import('./state.js');
         const { video } = await import('./dom.js');
         const { setFirstLoad } = await import('./video-renderer.js');
         const { renderAudioTracks } = await import('./mixer.js');
         const { toggleSubMode } = await import('./subtitle-model.js');
         State.cues = []; State.notes = [];
         clearSelection();
         State.listTrack = 0; State.tracks = []; ensureTk(0);
         if (State.subMode) toggleSubMode();
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

export {
  Project,
  ensureProjectSaved,
  isProjectGuardDone,
  resetProject,
  isProjectDirty,
  confirmDiscardUnsaved,
  openMedia,
  openProject,
  saveProject,
  saveAsProject,
  startNewProject,
  createProjectSnapshot,
  migrateProjectSchema,
  validateProjectIntegrity,
};

