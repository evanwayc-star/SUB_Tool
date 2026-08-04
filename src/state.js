/* ==============================================================================
   SUB Tool — 全域狀態管理與單一真相來源 (State Management)
   ==============================================================================
   
   【架構與職責總覽】
   本檔案 (state.js) 是本專案的「資料核心 (Single Source of Truth)」。
   所有關於字幕資料 (Cues)、多媒體片段 (Clips)、軌道設定 (Tracks)、
   與專案設定 (Config) 的結構都定義於此。
   
   1. 無渲染相依性
      本檔案純粹負責狀態的讀寫與基本的 Helper Function，【絕對不可】在此檔案中
      引入 `app.js` 或直接操作 DOM (如 document.getElementById)。
      
   2. 與 History (Undo/Redo) 的配合
      專案狀態的異動，如果需要被記錄在歷史堆疊中，會交由 `history.js` 
      進行深拷貝 (Deep Copy) 保存。因此本檔案中輸出的 State 物件，
      其內層屬性必須是可序列化的 (Serializable JSON Object)。

   【維護鐵律】
   - 擴充新的資料欄位時，請務必更新最上方的 `@typedef`，以保持 JSDoc 提示的準確性。
   - 所有牽涉跨模組資料變更的操作，請實作在對應模組 (如 subtitles.js)，
     然後修改 `State`，最後再發送 `emit('event')` 通知 `app.js` 重新渲染。
============================================================================== */
/**
 * @typedef {Object} Cue
 * @property {string} id - 字幕唯一識別碼
 * @property {number} start - 起始時間 (秒)
 * @property {number} end - 結束時間 (秒)
 * @property {string} text - 字幕內文
 * @property {number} [track=0] - 所屬字幕軌索引 (0-based)
 * @property {boolean} [timed=true] - 是否具有有效時間碼
 * @property {Object} [style] - 逐句覆蓋樣式
 */

/**
 * @typedef {Object} Track
 * @property {string} name - 字幕軌名稱
 * @property {boolean} [visible=true] - 是否顯示
 * @property {boolean} [locked=false] - 是否鎖定
 * @property {number} [height] - 軌道顯示高度
 */

/**
 * @typedef {Object} VideoTrack
 * @property {string} name - 視訊軌名稱
 * @property {boolean} [visible=true] - 是否顯示
 * @property {boolean} [locked=false] - 是否鎖定
 * @property {number} [height] - 軌道高度
 */

/**
 * @typedef {Object} AppState
 * @property {Cue[]} cues - 全專案字幕列表
 * @property {Track[]} tracks - 字幕軌道定義
 * @property {VideoTrack[]} videoTracks - 視訊軌道定義
 * @property {Array} notes - 專案備忘錄
 * @property {string|null} selectedId - 單選的字幕 ID
 * @property {string[]} selectedIds - 多選的字幕 ID 集合
 * @property {number} listTrack - 當前控制台檢視的軌道
 * @property {number} fps - 專案影格率
 * @property {boolean} dropFrame - 是否使用 Drop Frame 時間碼
 */

/* SUB Tool — 全域狀態 + 軌道/影格率 模型
   State：唯一的可變狀態來源（cues 字幕、tracks 軌道、notes 備忘、選取集、fps/dropFrame、
   時間軸視窗 viewStart/pxPerSec、媒體資訊…）。各模組直接讀寫 State，再 emit 觸發重繪。
   工具：newTrack/syncTrackCount/ensureTrackCount(軌道)、snapFps/setFps(影格率，setFps 會一併
   更新 UI 並依 'df' 後綴設定 dropFrame)、newId(遞增 cue id)、isSel/cueSuffix、DESK/IS_DESKTOP(Electron 偵測)。 */
import { emit } from './events.js';
import { makeSettingsStore } from './settings-store.js';

/* ===== 專案音訊路由 ====================================================
   音訊資料刻意與 Media（AudioContext、HTMLAudioElement、ffmpeg 暫存檔）分離：
   - buses 是專案層的單聲道軌；
   - sourceMaps 是每個匯入音源的來源聲道 -> bus 路由；
   - exportLayout 是專案 bus -> 匯出音訊 stream 的編組。
   sourceStream / sourceChannel 均採 0-based，畫面顯示時再 +1。
   這些 helper 只操作可序列化的 State.audioProject，讓媒體載入、時間軸與匯出可共用同一份設定。 */
let _audioBusSeq = 1;
let _audioStreamSeq = 1;

function _finiteNumber(v, fallback){ const n=Number(v); return Number.isFinite(n)?n:fallback; }
function _nonNegativeInt(v, fallback){ return Math.max(0, Math.floor(_finiteNumber(v, fallback))); }
function _cleanId(v){ return typeof v==='string' ? v.trim() : (v==null ? '' : String(v).trim()); }
function _cleanName(v, fallback){ const s=typeof v==='string'?v.trim():''; return s||fallback; }

function _reserveAudioBusId(id){
  const m=/^ab(\d+)$/i.exec(id||'');
  if(m) _audioBusSeq=Math.max(_audioBusSeq,Number(m[1])+1);
}
function _reserveAudioStreamId(id){
  const m=/^out(\d+)$/i.exec(id||'');
  if(m) _audioStreamSeq=Math.max(_audioStreamSeq,Number(m[1])+1);
}
function _nextAudioBusId(used){
  let id='';
  do { id='ab'+(_audioBusSeq++); } while(used.has(id));
  used.add(id); return id;
}
function _nextAudioStreamId(used){
  let id='';
  do { id='out'+(_audioStreamSeq++); } while(used.has(id));
  used.add(id); return id;
}
function _claimAudioBusId(rawId, used){
  const id=_cleanId(rawId);
  if(id&&!used.has(id)){ used.add(id); _reserveAudioBusId(id); return id; }
  return _nextAudioBusId(used);
}
function _claimAudioStreamId(rawId, used){
  const id=_cleanId(rawId);
  if(id&&!used.has(id)){ used.add(id); _reserveAudioStreamId(id); return id; }
  return _nextAudioStreamId(used);
}

function _normalBus(raw, index, used, forceName, forceId){
  raw=(raw&&typeof raw==='object')?raw:{};
  const id=_claimAudioBusId(forceId!=null?forceId:raw.id,used);
  return {
    id,
    name:_cleanName(forceName!=null?forceName:raw.name,'音訊軌 '+(index+1)),
    visible:raw.visible!==false,
    locked:!!raw.locked,
    muted:!!raw.muted,
    solo:!!raw.solo,
    volume:Math.max(0,_finiteNumber(raw.volume,1)),
    height:Math.max(24,_finiteNumber(raw.height,42))
  };
}

function _normalBusIds(value, validIds){
  const list=Array.isArray(value)?value:(value==null?[]:[value]);
  const seen=new Set(), out=[];
  for(const v of list){
    const id=_cleanId(v);
    if(id&&validIds.has(id)&&!seen.has(id)){ seen.add(id); out.push(id); }
  }
  return out;
}

function _normalChannels(value){
  if(typeof value==='number'){
    const count=_nonNegativeInt(value,0);
    return Array.from({length:count},(_,i)=>({sourceStream:0,sourceChannel:i}));
  }
  if(!Array.isArray(value)) return [];
  const out=[];
  value.forEach((raw,index)=>{
    if(raw&&typeof raw==='object'){
      out.push({
        sourceStream:_nonNegativeInt(raw.sourceStream,0),
        sourceChannel:_nonNegativeInt(raw.sourceChannel,index)
      });
    } else if(typeof raw==='number') {
      out.push({sourceStream:0,sourceChannel:_nonNegativeInt(raw,index)});
    }
  });
  const seen=new Set();
  return out.filter(ch=>{
    const key=ch.sourceStream+':'+ch.sourceChannel;
    if(seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a,b)=>a.sourceStream-b.sourceStream||a.sourceChannel-b.sourceChannel);
}

function _normalSourceMaps(rawMaps, buses){
  const validIds=new Set(buses.map(b=>b.id));
  const out={};
  if(!rawMaps||typeof rawMaps!=='object'||Array.isArray(rawMaps)) return out;
  for(const [rawSourceId,rawMap] of Object.entries(rawMaps)){
    const sourceId=_cleanId(rawSourceId);
    if(!sourceId) continue;
    const rawChannels=Array.isArray(rawMap)?rawMap:rawMap?.channels;
    if(!Array.isArray(rawChannels)) { out[sourceId]={channels:[]}; continue; }
    const byKey=new Map();
    rawChannels.forEach((raw,index)=>{
      raw=(raw&&typeof raw==='object')?raw:{};
      const sourceStream=_nonNegativeInt(raw.sourceStream,0);
      const sourceChannel=_nonNegativeInt(raw.sourceChannel,index);
      const key=sourceStream+':'+sourceChannel;
      const route={
        sourceStream,
        sourceChannel,
        busIds:_normalBusIds(raw.busIds,validIds),
        gain:Math.max(0,_finiteNumber(raw.gain,1)),
        enabled:raw.enabled!==false
      };
      const prior=byKey.get(key);
      if(prior){
        // 同一來源聲道的複製路由以 busIds 表示；讀取重複列時合併，避免靜默遺失輸出。
        for(const id of route.busIds) if(!prior.busIds.includes(id)) prior.busIds.push(id);
      } else byKey.set(key,route);
    });
    out[sourceId]={channels:[...byKey.values()].sort((a,b)=>a.sourceStream-b.sourceStream||a.sourceChannel-b.sourceChannel)};
  }
  return out;
}

function _normalExportLayout(rawLayout, buses){
  const validIds=new Set(buses.map(b=>b.id));
  const rawStreams=Array.isArray(rawLayout?.streams)?rawLayout.streams:[];
  const used=new Set(), streams=[];
  rawStreams.forEach(raw=>{
    raw=(raw&&typeof raw==='object')?raw:{};
    const layout=_cleanName(raw.layout,'mono');
    // Stream labels are optional metadata.  Keep only a trimmed string so
    // project JSON remains safe and old unnamed layouts stay unchanged.
    const name=_cleanName(raw.name,'');
    const stream={
      id:_claimAudioStreamId(raw.id,used),
      layout,
      busIds:_normalBusIds(raw.busIds,validIds)
    };
    if(name) stream.name=name;
    streams.push(stream);
  });
  return {streams};
}

function _emptyAudioProject(){ return {mode:'auto',buses:[],sourceMaps:{},exportLayout:{streams:[]}}; }

/* 回傳全新的、可序列化且已去除無效 bus 參照的音訊專案物件。
   不帶參數時同時正規化 State.audioProject。 */
function normalizeAudioProject(project){
  const raw=(project&&typeof project==='object'&&!Array.isArray(project))?project:{};
  const used=new Set();
  const buses=(Array.isArray(raw.buses)?raw.buses:[]).map((bus,index)=>_normalBus(bus,index,used));
  const normalized={
    mode:raw.mode==='manual'?'manual':'auto',
    buses,
    sourceMaps:_normalSourceMaps(raw.sourceMaps,buses),
    exportLayout:_normalExportLayout(raw.exportLayout,buses)
  };
  // 有 bus 卻沒有輸出設定時，使用「每條 bus 一個 mono stream」的安全預設。
  if(!normalized.exportLayout.streams.length&&buses.length){
    const streamIds=new Set();
    normalized.exportLayout.streams=buses.map(bus=>({id:_nextAudioStreamId(streamIds),layout:'mono',busIds:[bus.id]}));
  }
  if(arguments.length===0){ State.audioProject=normalized; }
  return normalized;
}

function newAudioBus(name, id){
  const used=new Set((State.audioProject?.buses||[]).map(bus=>bus?.id).filter(Boolean));
  return _normalBus({},used.size,used,name,id);
}

function resetAudioProject(){
  _audioBusSeq=1; _audioStreamSeq=1;
  State.audioProject=_emptyAudioProject();
  return State.audioProject;
}

function _isDefaultMonoLayout(streams, buses){
  if(streams.length!==buses.length) return false;
  return buses.every((bus,index)=>{
    const stream=streams[index];
    return stream&&stream.layout==='mono'&&stream.busIds.length===1&&stream.busIds[0]===bus.id;
  });
}

/* 補足專案單聲道 bus（只增不減）。若輸出仍是系統預設 mono 配置，新 bus 也會加入預設輸出；
   已被使用者改成 5.1/stereo 等配置時，則不覆寫其編組。 */
function ensureAudioBusCount(count, options={}){
  const wanted=_nonNegativeInt(count,0);
  State.audioProject=normalizeAudioProject(State.audioProject);
  const project=State.audioProject;
  const before=project.buses.slice();
  const wasDefault=_isDefaultMonoLayout(project.exportLayout.streams,before);
  let added=false;
  while(project.buses.length<wanted){
    const used=new Set(project.buses.map(bus=>bus.id));
    project.buses.push(_normalBus({},project.buses.length,used));
    added=true;
  }
  if(added&&options.exportDefaults!==false&&(wasDefault||options.appendExportDefaults===true))
    ensureAudioExportDefaults({appendMissing:true});
  return added;
}

/* 補足匯出預設：每個尚未被任何 stream 使用的 project bus 都會得到一條 mono stream。
   UI 在使用者建立自訂編組後可傳 {appendMissing:false}，僅確保空設定有可用預設。 */
function ensureAudioExportDefaults(options={}){
  State.audioProject=normalizeAudioProject(State.audioProject);
  const project=State.audioProject;
  const streams=project.exportLayout.streams;
  const appendMissing=options.appendMissing!==false;
  if(!streams.length){
    const used=new Set();
    project.exportLayout.streams=project.buses.map(bus=>({id:_nextAudioStreamId(used),layout:'mono',busIds:[bus.id]}));
    return project.exportLayout;
  }
  if(appendMissing){
    const assigned=new Set(streams.flatMap(stream=>stream.busIds));
    const used=new Set(streams.map(stream=>stream.id));
    for(const bus of project.buses){
      if(!assigned.has(bus.id)) streams.push({id:_nextAudioStreamId(used),layout:'mono',busIds:[bus.id]});
    }
  }
  return project.exportLayout;
}

/* 減少專案音軌數之後，把指向已消失 bus 的參照全部清乾淨。

   §0.8：素材聲道／專案音軌／輸出 stream 是三件事。刪掉一條專案音軌時，
   **兩個地方**會留下指向它的 id——來源聲道的 `sourceMaps[].channels[].busIds`
   與輸出編組的 `exportLayout.streams[].busIds`。漏掉任一個都不會報錯：
   配線面板看起來正常，匯出時那條 stream 卻對應到一個不存在的 bus，
   結果是靜音或聲道數不對，而且要把成品放進播放器才聽得出來。

   輸出 stream 清空後要移除，但**至少保留一條**——一條都不留的話，
   匯出會產生沒有音訊軌的檔案。

   純函式（只動傳進來的 project 物件，不碰 State）：這條規則以前住在
   audio-routing.js 的 setBusCount 裡，和對話框 DOM 綁在一起，沒有測試。 */
function pruneRemovedAudioBuses(project, removedIds){
  if(!project) return project;
  const gone = removedIds instanceof Set ? removedIds : new Set(removedIds || []);
  if(!gone.size) return project;
  const drop = ids => (Array.isArray(ids) ? ids.filter(id => !gone.has(id)) : ids);

  Object.values(project.sourceMaps || {}).forEach(map => {
    if(map && Array.isArray(map.channels))
      map.channels.forEach(route => { if(route.busIds) route.busIds = drop(route.busIds); });
  });

  const streams = project.exportLayout && project.exportLayout.streams;
  if(Array.isArray(streams)){
    streams.forEach(stream => { if(stream.busIds) stream.busIds = drop(stream.busIds); });
    project.exportLayout.streams = streams.filter((stream, index) => (stream.busIds || []).length > 0 || index === 0);
  }
  return project;
}

/* 為指定音源建立不覆寫既有設定的一對一路由。channels 可為聲道數字或
   [{sourceStream,sourceChannel}]；兩個索引皆為 0-based。auto 模式會依聲道數自動補足 bus。 */
function ensureAudioSourceMap(audioSourceId, channels, options={}){
  const sourceId=_cleanId(audioSourceId);
  if(!sourceId) return null;
  const descriptors=_normalChannels(channels);
  State.audioProject=normalizeAudioProject(State.audioProject);
  if((State.audioProject.mode==='auto'||options.forceBusCount===true)&&options.ensureBuses!==false)
    ensureAudioBusCount(descriptors.length,options);
  const project=State.audioProject;
  const existing=options.reset?[]:(project.sourceMaps[sourceId]?.channels||[]);
  const byKey=new Map(existing.map(route=>[route.sourceStream+':'+route.sourceChannel,route]));
  descriptors.forEach((channel,index)=>{
    const key=channel.sourceStream+':'+channel.sourceChannel;
    if(!byKey.has(key)){
      const bus=project.buses[index];
      byKey.set(key,{sourceStream:channel.sourceStream,sourceChannel:channel.sourceChannel,busIds:bus?[bus.id]:[],gain:1,enabled:true});
    }
  });
  project.sourceMaps[sourceId]={channels:[...byKey.values()].sort((a,b)=>a.sourceStream-b.sourceStream||a.sourceChannel-b.sourceChannel)};
  State.audioProject=normalizeAudioProject(project);
  return State.audioProject.sourceMaps[sourceId];
}

/* 取得單一來源聲道的 route；不存在（或尚未匯入此音源）時回傳 null。 */
function routeForChannel(audioSourceId, sourceStream=0, sourceChannel=0){
  const sourceId=_cleanId(audioSourceId);
  if(!sourceId) return null;
  State.audioProject=normalizeAudioProject(State.audioProject);
  const stream=_nonNegativeInt(sourceStream,0);
  const channel=_nonNegativeInt(sourceChannel,0);
  return State.audioProject.sourceMaps[sourceId]?.channels.find(route=>
    route.sourceStream===stream&&route.sourceChannel===channel
  )||null;
}

const State = {
  cues: [],            // {id,start,end,text,track}
  tracks: [],          // 字幕軌道
  notes: [],           // 備註 {id,time,text,done}
  trackCount: 0,       // = tracks.length（同步用）
  listTrack: 0,        // 字幕列表顯示的軌道
  fps: 24,
  dropFrame: false,
  duration: 0,
  // 外部音訊素材的最右緣（時間軸秒數）。它是 Media runtime registry 的可讀摘要，
  // 讓 sequence.js 不必反向 import media.js，也不會在移動／刪除影片片段時把
  // 時間軸長度縮回影片結尾。
  externalAudioEnd: 0,
  // 僅保存外部音訊的可編輯資料（不含 Audio / Web Audio / 波形等 runtime 物件）。
  // Media 每次編輯時同步它，供 History 還原幾何與靜音狀態。
  externalAudioState: [],
  autoSelect: false,   // 播放時是否自動選取對應字幕
  selectedId: null,    // 主選取（鍵盤/IO 對象）
  selectedIds: [],     // 多選集合
  activeEdge: 'start', // 上下鍵步進中目前停在 start 或 end
  activeId: null,      // 目前播放位置對應的字幕
  pxPerSec: 80,
  viewStart: 0,        // 時間軸左緣對應秒數
  // 輸出範圍（播放器的 [In]／[Out]）；必須是可復原的專案狀態。
  exportIn: null,
  exportOut: null,
  inPoint: null,       // I 標記但尚未 O 的暫存起點
  subMode: false,      // 上字幕模式（O 後自動前進到下一句）
  mediaName: null,
  mediaSize: 0,
  videoWidth: 0,
  videoHeight: 0,
  muted:false, lastVol:1,
  mediaPath:null,
  clipboard:[],  // copied cues for paste
  overwriteMode: false, // 允許重疊（不可覆蓋/可覆蓋）
  overwriteKeep: true,  // 可覆蓋模式下：true=保留被包含句, false=刪除被包含句
  // 播放器監看用疊層。這是使用者偏好，不屬於專案／匯出資料，故只由 config 保存。
  timecodeWatermark: false,
  activeTrackKind: 'sub', // 目前焦點軌道類型：'sub' | 'video' | 'audio'
  activeSubTrack: 0,      // 目前選取的字幕軌道（用於上下鍵導航）
  clips: [],            // 影片序列（時間軸上的影片區塊，含 vtrack 視訊轨）：見 sequence.js
  selectedClipId: null, // 目前選取的影片段（點選後可用上下鍵切換、Del 刪除）
  selectedAudioClipId: null, // 目前選取的外部音訊素材（與影片／字幕選取互斥）
  videoTracks: [{name:'視訊軌 1',visible:true,locked:false}], // 視訊軌（獨立成列，比照字幕軌 tracks[]；索引越大越上層＝越優先覆蓋）
  vtracksCollapsed: false, // 是否收合視訊軌區塊
  audioExpanded: {},    // 音訊軌（每音源一列）是否展開成各聲道控制列：{ srcId: true }
  audioProject: _emptyAudioProject() // 專案音訊 bus / 來源路由 / 匯出 stream（不存 Media runtime）
};
/* 軌道工具 */
function newTrack(name){ return {name:name||('軌道 '+(State.tracks.length+1)),visible:true,locked:false}; }
function syncTrackCount(){ State.trackCount=State.tracks.length; }
/* 視訊軌工具（比照字幕軌）：newVideoTrack 建一條、ensureVideoTrackCount 補足數量（只增不減）、
   videoTrackVisible 顯示查詢、resetVideoTracks 回到單軌初始。索引 0＝最底/基底，越大越上層。 */
function newVideoTrack(name){ return {name:name||('視訊軌 '+(State.videoTracks.length+1)),visible:true,locked:false}; }
function ensureVideoTrackCount(n){ let added=false; while(State.videoTracks.length<n){ State.videoTracks.push(newVideoTrack()); added=true; } return added; }
function videoTrackVisible(i){ return !State.videoTracks[i] || State.videoTracks[i].visible!==false; }
function resetVideoTracks(){ State.videoTracks=[{name:'視訊軌 1',visible:true,locked:false}]; }
/* 允許的影格率（下拉選單） */
const FPS_SET=[23.976,24,25,29.97,30];
function snapFps(v){ let best=24,bd=1e9; for(const f of FPS_SET){const d=Math.abs(f-v);if(d<bd){bd=d;best=f;}} return best; }
// A1：純函式 — 只改 State、零 DOM 相依，可在 node 環境單元測試
function applyFps(v){
  let df=false;
  if(typeof v==='string'&&v.endsWith('df')){ df=true; v=parseFloat(v); }
  State.fps=snapFps(typeof v==='number'?v:parseFloat(v)||24); State.dropFrame=df;
  return { fps:State.fps, dropFrame:State.dropFrame };
}
// 套用後發出事件；DOM 同步（fpsSel/tcCur/tcDur）改由 app.js 的 'fps:changed' 訂閱負責，
// 切斷 state.js → dom.js 的隱性相依。
function setFps(v){ const r=applyFps(v); emit('fps:changed', r); return r; }
function ensureTrackCount(n){ 
  let added = false;
  while(State.tracks.length<n){ State.tracks.push(newTrack()); added = true; }
  syncTrackCount();
  return added;
}
function trackVisible(i){ return !State.tracks[i] || State.tracks[i].visible!==false; }
let cueSeq = 1;
const newId = () => 'c' + (cueSeq++);

/* 桌面 (Electron) 整合：偵測 preload 暴露的 window.subtool */
const _subtool = (typeof window !== 'undefined') ? window.subtool : null;
const DESK = (_subtool && _subtool.isDesktop) ? _subtool : null;
const IS_DESKTOP = !!DESK;

/* 設定的落點（桌面 IPC vs localStorage）已收斂到 settings-store.js。
   這裡只剩「哪些欄位、什麼型別」——而且【只寫一份】，不再桌面／網頁各一份。 */
const _settings = makeSettingsStore(DESK);

/* conf 物件 → State 的欄位映射。抽成純函式：以前這段在 loadConfig 裡寫了兩次
   （DESK 一份、localStorage 一份），改欄位漏改一處就會兩邊行為不一致。 */
function applyConfig(conf) {
  if (!conf || typeof conf !== 'object') return;
  if (typeof conf.autoSelect === 'boolean') State.autoSelect = conf.autoSelect;
  if (typeof conf.overwriteMode === 'boolean') State.overwriteMode = conf.overwriteMode;
  if (typeof conf.overwriteKeep === 'boolean') State.overwriteKeep = conf.overwriteKeep;
  if (typeof conf.safeFrame === 'boolean') State.safeFrame = conf.safeFrame;
  if (typeof conf.timecodeWatermark === 'boolean') State.timecodeWatermark = conf.timecodeWatermark;
}

async function loadConfig() {
  applyConfig(await _settings.load('config'));
}

function saveConfig() {
  return _settings.save('config', {
    autoSelect: State.autoSelect,
    overwriteMode: State.overwriteMode,
    overwriteKeep: State.overwriteKeep,
    safeFrame: State.safeFrame,
    timecodeWatermark: State.timecodeWatermark
  });
}

State.defaultKeymap = {
  // Enter 在非編輯狀態下＝播放/暫停（編輯中的 Enter 由 contenteditable handler 處理：確認離開/換行/切分）；
  // 開啟字幕文字編輯改以雙擊列表列
  'toggle_play_pause': [{key:' '}, {key:'enter'}],
  'rewind': [{key:'j'}],
  'pause': [{key:'k'}],
  'forward': [{key:'l'}],
  'zoom_out': [{key:'1'}, {key:'-'}, {code:'NumpadSubtract'}],
  'zoom_in': [{key:'2'}, {key:'='}, {key:'+'}, {code:'NumpadAdd'}],
  'zoom_fit': [{key:'`'}, {key:'\\'}, {code:'NumpadMultiply'}],
  // 主鍵盤與數字鍵盤分離：數字鍵盤一律以 code（NumpadX）綁定，主鍵盤數字以 key 綁定。
  // matchAction（keyboard.js）配合此約定：含 code 的綁定只比對 code；
  // 數字鍵盤產生的字元鍵不會命中 key 綁定（所以 zoom_in 的 '2' 只吃主鍵盤 2）。
  'prev_cue_5f': [{code:'Numpad5'}],
  'next_cue_5f': [{code:'Numpad2'}],
  'toggle_history': [{code:'Numpad7'}],
  'toggle_notes': [{code:'Numpad8'}],
  'toggle_check_panel': [{code:'Numpad9'}],
  'search': [{key:'f', ctrl:true}],
  'toggle_sub_mode': [{key:'y'}],
  'set_in': [{key:'i'}, {key:'q'}],
  'set_out': [{key:'o'}, {key:'w'}],
  'exp_in': [{key:'['}],
  'exp_out': [{key:']'}],
  'exp_clear': [],
  'nudge_left_1f': [{key:'arrowleft'}],
  'nudge_left_1s': [{key:'arrowleft', shift:true}],
  'nudge_left_5s': [{key:'arrowleft', ctrl:true, shift:true}],
  'nudge_right_1f': [{key:'arrowright'}],
  'nudge_right_1s': [{key:'arrowright', shift:true}],
  'nudge_right_5s': [{key:'arrowright', ctrl:true, shift:true}],
  'prev_note': [{key:'arrowleft', ctrl:true}],
  'next_note': [{key:'arrowright', ctrl:true}],
  'seek_home': [{key:'home'}, {key:'arrowup', shift:true}],
  'seek_end': [{key:'end'}, {key:'arrowdown', shift:true}],
  'step_boundary_prev': [{key:'arrowup'}, {key:'e'}],
  'step_boundary_next': [{key:'arrowdown'}, {key:'d'}],
  'first_cue': [{key:'arrowup', ctrl:true, shift:true}],
  'last_cue': [{key:'arrowdown', ctrl:true, shift:true}],
  'prev_cue': [{key:'arrowup', ctrl:true}],
  'next_cue': [{key:'arrowdown', ctrl:true}],
  'jump_cue_start': [{key:'a'}],
  'jump_cue_end': [{key:'s'}],
  'select_all': [{key:'a', ctrl:true}],
  'save_project': [{key:'s', ctrl:true}],
  'save_as': [{key:'s', ctrl:true, shift:true}],
  'delete_selected': [{key:'delete'}],
  'cancel': [{key:'escape'}],
  'confirm': [{key:'enter'}],
  'newline': [{key:'enter', shift:true}],
  'split_cue': [{key:'enter', ctrl:true}],
  'shift_timecode': [{key:'p'}, {key:'r'}],
  'undo': [{key:'z', ctrl:true}],
  'redo': [{key:'z', ctrl:true, shift:true}],
  'toggle_auto_select': [{key:'z'}],
  'toggle_overwrite': [{key:'x'}],
  'toggle_overwrite_keep': [{key:'c'}],
  'copy_cues': [{key:'c', ctrl:true}],
  'paste_cues': [{key:'v', ctrl:true}],
  'select_current': [{key:'g'}],
  'add_note': [{key:'v'}, {key:'m'}],
  'split_clip': [{key:'k', ctrl:true}], // 在播放點切割影片段（影片序列）
  'toggle_safe_frame': [{key:'g', ctrl:true}],
  'toggle_mixer': [{key:'u'}],
  'screenshot': [{key:'t'}],
  'screenshot_tc': [{key:'t', ctrl:true}],
  'export_video': [{key:'/'}],          // 匯出影片（交付清單）
  'open_queue_monitor': [{key:'.'}],     // 監控匯出佇列（桌面版）
  'copy_style': [{key:'c', ctrl:true, shift:true}],
  'paste_style': [{key:'v', ctrl:true, shift:true}],
};
State.keymap = JSON.parse(JSON.stringify(State.defaultKeymap));

async function loadKeys() {
  const loaded = await _settings.load('keys');
  if (loaded && Object.keys(loaded).length > 0) {
    State.keymap = Object.assign(JSON.parse(JSON.stringify(State.defaultKeymap)), loaded);
    _migrateKeymap(State.keymap);
  }
}

/* 鍵位遷移（v4.4.2 主鍵盤/數字鍵盤分離）：舊存檔裡的「舊版預設綁定」改為新的 Numpad code 形式。
   只在綁定仍等於舊版預設值時轉換，使用者自訂過的一律不動。 */
function _migrateKeymap(km){
  const OLD = {
    toggle_history:     '[{"key":"7"}]',
    toggle_notes:       '[{"key":"8"}]',
    toggle_check_panel: '[{"key":"9"}]',
    prev_cue_5f:        '[{"key":"5","code":"Numpad5"}]',
    next_cue_5f:        '[{"key":"2","code":"Numpad2"}]',
    toggle_play_pause:  '[{"key":" "}]', // v4.4.3：Enter 併入播放/暫停
  };
  for(const [act, oldJson] of Object.entries(OLD)){
    try{
      if(JSON.stringify(km[act]) === oldJson)
        km[act] = JSON.parse(JSON.stringify(State.defaultKeymap[act]));
    }catch(e){}
  }
  // v4.4.3：confirm（Enter 開啟編輯）已移除，Enter 讓給播放/暫停；編輯中行為不受 keymap 控制
  delete km.confirm;
}

function saveKeys() {
  return _settings.save('keys', State.keymap);
}

function isSel(id){ return State.selectedIds.includes(id); }

/* 選取狀態的單一入口。這裡守兩條【真的不變量】，以前它們散在約 97 個裸賦值裡
   由各處自行維持：

     ① 三種選取互斥 —— 字幕（selectedId/selectedIds）、視訊片段（selectedClipId）、
        音訊片段（selectedAudioClipId）不可同時有值。漏清一個，
        Delete 或 Ctrl+K 就會作用在使用者以為沒選中的東西上。
     ② activeTrackKind 必須與被選中的 id 同類，否則鍵盤導航（↑／↓）會跳到別種軌。

   典型呼叫：
     setSelection({ kind:'sub',   ids:[a,b], primary:b })  多選字幕
     setSelection({ kind:'video', ids:clipId })            選一個視訊片段
     setSelection({ kind:'audio', ids:[] })                切到音訊軌並清空選取

   注意：這裡【只管狀態】，不重繪。呼叫端仍要自己叫 refreshSelectionUI() 等，
   維持與既有程式碼相同的節奏（一次操作可能改多項狀態後才重繪一次）。 */
const SELECTION_KINDS = new Set(['sub', 'video', 'audio']);

function setSelection({ kind = null, ids = [], primary } = {}){
  /* 只認得這三種。未知的 kind 一律視為清空，且【不可】寫進 activeTrackKind——
     它被宣告為 'sub' | 'video' | 'audio'，塞進別的值會讓鍵盤導航的分支全部落空，
     而且不會有任何錯誤訊息。 */
  const k = SELECTION_KINDS.has(kind) ? kind : null;
  const list = Array.isArray(ids) ? ids.filter(v => v != null) : (ids == null ? [] : [ids]);
  State.selectedIds        = k === 'sub'   ? list : [];
  State.selectedId         = k === 'sub'   ? (primary !== undefined ? primary : (list.length ? list[list.length - 1] : null)) : null;
  State.selectedClipId     = k === 'video' ? (list.length ? list[0] : null) : null;
  State.selectedAudioClipId= k === 'audio' ? (list.length ? list[0] : null) : null;
  if(k) State.activeTrackKind = k;
  return State;
}

/* 清空三種選取但【保留】activeTrackKind——點時間軸空白處的語意是
   「取消選取，但這一軌仍是目前焦點軌」（見 docs/開發與驗證.md §4.13）。 */
function clearSelection(){ return setSelection({ kind: null }); }

/* 只放掉其中一種選取，其他兩種不動。
   給了 id 就只在「目前選的正好是它」時才放掉——這是刪除素材、
   取消單一片段時最常見的形狀，以前每個呼叫端各自寫一次 if 比對。
   不動 activeTrackKind，理由同 clearSelection()。 */
function deselect(kind, id){
  if(!SELECTION_KINDS.has(kind)) return State;
  if(kind === 'sub'){
    if(id == null){ State.selectedIds = []; State.selectedId = null; return State; }
    if(!State.selectedIds.includes(id) && State.selectedId !== id) return State;
    State.selectedIds = State.selectedIds.filter(x => x !== id);
    if(State.selectedId === id) State.selectedId = State.selectedIds[State.selectedIds.length - 1] ?? null;
    return State;
  }
  const field = kind === 'video' ? 'selectedClipId' : 'selectedAudioClipId';
  if(id == null || State[field] === id) State[field] = null;
  return State;
}

/* 字幕集合變動後（undo/redo、刪除、匯入）把選取修剪回仍然存在的 id。
   主選取消失時退回剩下的第一個，而不是連同其他選取一起丟掉——
   以前 history.js 丟、subtitles.js 與 timeline-renderer.js 留，三處寫法不一致。 */
function pruneSelection(){
  const alive = new Set(State.cues.map(c => c.id));
  const ids = State.selectedIds.filter(id => alive.has(id));
  State.selectedIds = ids;
  State.selectedId = alive.has(State.selectedId) ? State.selectedId : (ids[0] ?? null);
  return State;
}

/* 每種焦點軌類別各有一個「是哪一軌」的夥伴欄位。這三個欄位與 activeTrackKind
   是【同一條複合不變量】——refreshTrackGutterActive() 就是證據，它把兩者成對比對：
     activeTrackKind==='sub'   && dataset.track        === listTrack
     activeTrackKind==='video' && dataset.vtrack       === activeVtrack
     activeTrackKind==='audio' && dataset.audioSourceId=== activeAudioTrackId
   但圍籬只守了 activeTrackKind，三個夥伴欄位在圍籬外，其中 listTrack 有 13 處寫入。 */
const FOCUS_INDEX_FIELD = { sub: 'listTrack', video: 'activeVtrack', audio: 'activeAudioTrackId' };

/* 只換焦點軌類別，不動任何選取——點軌道列頭的語意。
   給了 index 就連夥伴欄位一起寫，讓「焦點在哪一種軌的哪一軌」是一次寫入。 */
function focusTrackKind(kind, index){
  if(!SELECTION_KINDS.has(kind)) return State;
  State.activeTrackKind = kind;
  if(index !== undefined) State[FOCUS_INDEX_FIELD[kind]] = index;
  return State;
}

function cueSuffix(c){
  if(!c) return '';
  const tk=c.track||0;
  const name=State.tracks[tk]?.name||('軌道 '+(tk+1));
  const sorted=State.cues.filter(x=>(x.track||0)===tk);
  const idx=sorted.findIndex(x=>x.id===c.id);
  return ` - ${name} - 第${idx+1}句`;
}

export { State, newTrack, syncTrackCount, newVideoTrack, ensureVideoTrackCount, videoTrackVisible, resetVideoTracks,
  newAudioBus, normalizeAudioProject, resetAudioProject, ensureAudioBusCount, ensureAudioExportDefaults,
  ensureAudioSourceMap, routeForChannel, pruneRemovedAudioBuses,
  FPS_SET, snapFps, applyFps, setFps, ensureTrackCount, trackVisible, newId, DESK, IS_DESKTOP, isSel,
  setSelection, clearSelection, deselect, pruneSelection, focusTrackKind, cueSuffix,
  loadConfig, saveConfig, loadKeys, saveKeys };
