/* SUB Tool — 全域狀態 + 軌道/影格率 模型 */
import { $, video } from './dom.js';
import { secToEncore } from './time.js';

const State = {
  cues: [],            // {id,start,end,text,track}
  tracks: [],          // 字幕軌道
  notes: [],           // 備忘錄 {id,time,text,done}
  trackCount: 0,       // = tracks.length（同步用）
  listTrack: 0,        // 字幕列表顯示的軌道
  fps: 24,
  duration: 0,
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
  muted:false, lastVol:1,
  mediaPath:null,
  clipboard:[],  // copied cues for paste
};
/* 軌道工具 */
function newTrack(name){ return {name:name||('軌道 '+(State.tracks.length+1)),visible:true,fontScale:1,posPct:10,align:'center',locked:false,color:'#ffffff'}; }
function syncTrackCount(){ State.trackCount=State.tracks.length; }
/* 允許的影格率（下拉選單） */
const FPS_SET=[23.976,24,25,29.97,30];
function snapFps(v){ let best=24,bd=1e9; for(const f of FPS_SET){const d=Math.abs(f-v);if(d<bd){bd=d;best=f;}} return best; }
function setFps(v){ State.fps=snapFps(v); const sel=$('fpsSel'); if(sel)sel.value=String(State.fps);
  $('tcCur').textContent=secToEncore(video.currentTime||0,State.fps); $('tcDur').textContent=secToEncore(State.duration,State.fps); }
function ensureTrackCount(n){ while(State.tracks.length<n)State.tracks.push(newTrack()); syncTrackCount(); }
function trackVisible(i){ return !State.tracks[i] || State.tracks[i].visible!==false; }
let cueSeq = 1;
const newId = () => 'c' + (cueSeq++);

/* 桌面 (Electron) 整合：偵測 preload 暴露的 window.subtool */
const DESK = (window.subtool && window.subtool.isDesktop) ? window.subtool : null;
const IS_DESKTOP = !!DESK;

function isSel(id){ return State.selectedIds.includes(id); }

export { State, newTrack, syncTrackCount, FPS_SET, snapFps, setFps, ensureTrackCount, trackVisible, newId, DESK, IS_DESKTOP, isSel };
