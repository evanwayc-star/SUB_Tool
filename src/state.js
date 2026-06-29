/* SUB Tool — 全域狀態 + 軌道/影格率 模型
   State：唯一的可變狀態來源（cues 字幕、tracks 軌道、notes 備忘、選取集、fps/dropFrame、
   時間軸視窗 viewStart/pxPerSec、媒體資訊…）。各模組直接讀寫 State，再 emit 觸發重繪。
   工具：newTrack/syncTrackCount/ensureTrackCount(軌道)、snapFps/setFps(影格率，setFps 會一併
   更新 UI 並依 'df' 後綴設定 dropFrame)、newId(遞增 cue id)、isSel/cueSuffix、DESK/IS_DESKTOP(Electron 偵測)。 */
import { emit } from './events.js';

const State = {
  cues: [],            // {id,start,end,text,track}
  tracks: [],          // 字幕軌道
  notes: [],           // 備忘錄 {id,time,text,done}
  trackCount: 0,       // = tracks.length（同步用）
  listTrack: 0,        // 字幕列表顯示的軌道
  fps: 24,
  dropFrame: false,
  duration: 0,
  autoSelect: false,   // 播放時是否自動選取對應字幕
  selectedId: null,    // 主選取（鍵盤/IO 對象）
  selectedIds: [],     // 多選集合
  activeEdge: 'start', // 上下鍵步進中目前停在 start 或 end
  activeId: null,      // 目前播放位置對應的字幕
  pxPerSec: 80,
  viewStart: 0,        // 時間軸左緣對應秒數
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
};
/* 軌道工具 */
function newTrack(name){ return {name:name||('軌道 '+(State.tracks.length+1)),visible:true,fontSize:60,posPct:90,align:'center',locked:false,color:'#ffffff'}; }
function syncTrackCount(){ State.trackCount=State.tracks.length; }
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

function isSel(id){ return State.selectedIds.includes(id); }

function cueSuffix(c){
  if(!c) return '';
  const tk=c.track||0;
  const name=State.tracks[tk]?.name||('軌道 '+(tk+1));
  const sorted=State.cues.filter(x=>(x.track||0)===tk).sort((a,b)=>a.start-b.start);
  const idx=sorted.findIndex(x=>x.id===c.id);
  return ` - ${name} - 第${idx+1}句`;
}

export { State, newTrack, syncTrackCount, FPS_SET, snapFps, applyFps, setFps, ensureTrackCount, trackVisible, newId, DESK, IS_DESKTOP, isSel, cueSuffix };
