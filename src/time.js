/* SUB Tool — 時間 / 時碼換算（秒 ↔ 各字幕格式時碼）
   匯出：
     秒→時碼  fmtClock(UI 顯示) / secToSRT / secToASS / secToEncore
     時碼→秒  srtToSec / assToSec / encoreToSec
     snapTimeToFrame：把任意秒數對齊到最近的影格邊界
   注意 Drop-frame(DF)僅適用 29.97fps；df 旗標由 State.dropFrame 決定。

   ┌─ FPS-SYNC（FPS / 時碼一致性）★ 改這裡前務必先讀 FPS_時碼一致性.md ──────────┐
   │ encoreParts() 是「秒 → 時:分:秒:格」的【唯一】換算來源；secToEncore（播放器、 │
   │ 字幕列表、匯出）與 timeline.js 的 fmtTick（時間軸刻度）都共用它，三者才會永遠一致。│
   │ snapTimeToFrame() 是【唯一】的影格格網；seek/pause/拖曳/逐格都用它對齊。          │
   │ 千萬不要在別處自行用 Math.floor(s/3600)…拼時碼，或自訂格網——會造成差一格。        │
   └──────────────────────────────────────────────────────────────────┘ */
import { pad } from './util.js';

/* 秒 -> 各格式時碼 */
function fmtClock(s){ // 00:00:00.000 (UI 用毫秒制)
  if(!isFinite(s)||s<0)s=0;
  const ms=Math.round(s*1000);
  return `${pad(ms/3600000)}:${pad((ms/60000)%60)}:${pad((ms/1000)%60)}.${pad(ms%1000,3)}`;
}
function secToSRT(s){
  if(s<0)s=0; const ms=Math.round(s*1000);
  return `${pad(ms/3600000)}:${pad((ms/60000)%60)}:${pad((ms/1000)%60)},${pad(ms%1000,3)}`;
}
function secToASS(s){
  if(s<0)s=0; const cs=Math.floor(s*100 + 0.0001); // 避免浮點數四捨五入導致 ASS 時間大於實際影格時間，造成 MPV 晚一格
  return `${Math.floor(cs/360000)}:${pad((cs/6000)%60)}:${pad((cs/100)%60)}.${pad(cs%100,2)}`;
}
/* FPS-SYNC：秒 → Encore 時碼分量(時/分/秒/格)。所有「數影格」的時碼顯示都【必須】走這裡，
   確保播放器、字幕列表、時間軸刻度等各處對同一秒數得到完全一致的時:分:秒:格。
   非 DF 的 29.97 會刻意「數影格」而非「數真實秒數」，因此長時碼會比牆鐘秒數慢幾秒——
   這是非 drop-frame 時碼的正常特性（詳見 FPS_時碼一致性.md）。 */
function encoreParts(s,fps,df=false){
  if(s<0)s=0;
  if(df && Math.abs(fps-29.97)<0.01){
    // SMPTE 29.97 DF：實際影格號 n（30000/1001 fps）→ 顯示用的 30fps 時碼號 a。
    // 規則：每分鐘開頭丟掉 ;00、;01 兩格，但每 10 分鐘那一刻不丟。
    // 每 10 分鐘 = 17982 個實際影格；每 1 分鐘補回 2 格、每 10 分鐘區塊補 2*9 格。
    const n=Math.round(s*30000/1001);              // 實際影格序號
    const D=Math.floor(n/17982), F=n%17982;        // D=完整 10 分鐘區塊數，F=區塊內餘格
    const adj=F<2?0:Math.floor((F-2)/1798);        // 區塊內已跨過的「丟格分鐘」數
    const a=n+2*(D*9+adj);                          // 加回被丟掉的格數 → 顯示時碼號
    const ff=a%30, rest=Math.floor(a/30);
    const ss=rest%60, mm=Math.floor(rest/60)%60, hh=Math.floor(rest/3600);
    return {hh,mm,ss,ff,df:true};
  }
  // 非 DF：整數 fps 四捨五入，逐位進位
  const fpsR=Math.round(fps);
  let tf=Math.round(s*fps);
  const ff=tf%fpsR; tf=Math.floor(tf/fpsR);
  const ss=tf%60; tf=Math.floor(tf/60);
  const mm=tf%60; const hh=Math.floor(tf/60);
  return {hh,mm,ss,ff,df:false};
}
/* 秒 → Encore 時碼(時:分:秒:格)。df=true 時用 SMPTE 29.97 Drop-frame，分隔符為 ';' */
function secToEncore(s,fps,df=false){
  const p=encoreParts(s,fps,df);
  return `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}${p.df?';':':'}${pad(p.ff)}`;
}
/* 時碼 -> 秒 */
function srtToSec(t){
  const m=t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/); if(!m)return 0;
  return +m[1]*3600+ +m[2]*60+ +m[3]+ (+m[4])/Math.pow(10,m[4].length);
}
function assToSec(t){
  const m=t.trim().match(/(\d+):(\d+):(\d+)[.,](\d+)/); if(!m)return 0;
  return +m[1]*3600+ +m[2]*60+ +m[3]+ (+m[4])/Math.pow(10,m[4].length);
}
/* Encore 時碼 → 秒。df=true 為 secToEncore DF 的反運算。 */
function encoreToSec(t,fps,df=false){
  const m=t.trim().match(/(\d+):(\d+):(\d+)[:;](\d+)/); if(!m)return 0;
  const hh=+m[1],mm=+m[2],ss=+m[3],ff=+m[4];
  if(df && Math.abs(fps-29.97)<0.01){
    // 反推實際影格號 n：先當成 30fps 算總格數，再扣掉每分鐘丟的 2 格（每 10 分鐘那刻不扣）
    const totalMin=60*hh+mm;
    const n=30*3600*hh+30*60*mm+30*ss+ff-2*(totalMin-Math.floor(totalMin/10));
    return n*1001/30000;
  }
  return hh*3600+mm*60+ss+ff/fps;
}

/* FPS-SYNC：把秒數對齊到最近的影格邊界（唯一的影格格網；seek/pause/拖曳/逐格都用它，
   確保播放點永遠落在整格上、且與時間軸刻度同格。詳見 FPS_時碼一致性.md） */
function snapTimeToFrame(t, fps, df=false) {
  if(!fps) return t;
  if(df && Math.abs(fps-29.97)<0.01) return Math.round(t*30000/1001)*1001/30000;
  return Math.round(t*fps)/fps;
}

export { fmtClock, secToSRT, secToASS, secToEncore, encoreParts, srtToSec, assToSec, encoreToSec, snapTimeToFrame };
