/* SUB Tool — 時間 / 時碼換算 */
import { pad } from './util.js';

/* 秒 -> 各格式時碼 */
function fmtClock(s){ // 00:00:00.000 (UI)
  if(!isFinite(s)||s<0)s=0;
  const ms=Math.round(s*1000);
  return `${pad(ms/3600000)}:${pad((ms/60000)%60)}:${pad((ms/1000)%60)}.${pad(ms%1000,3)}`;
}
function secToSRT(s){
  if(s<0)s=0; const ms=Math.round(s*1000);
  return `${pad(ms/3600000)}:${pad((ms/60000)%60)}:${pad((ms/1000)%60)},${pad(ms%1000,3)}`;
}
function secToASS(s){
  if(s<0)s=0; const cs=Math.floor(s*100); // ASS 使用百分秒
  return `${Math.floor(cs/360000)}:${pad((cs/6000)%60)}:${pad((cs/100)%60)}.${pad(cs%100,2)}`;
}
function secToEncore(s,fps){
  if(s<0)s=0;
  let tf=Math.round(s*fps);
  const ff=tf%Math.round(fps); tf=Math.floor(tf/Math.round(fps));
  const ss=tf%60; tf=Math.floor(tf/60);
  const mm=tf%60; const hh=Math.floor(tf/60);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
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
function encoreToSec(t,fps){
  const m=t.trim().match(/(\d+):(\d+):(\d+)[:;](\d+)/); if(!m)return 0;
  return +m[1]*3600+ +m[2]*60+ +m[3]+ (+m[4])/fps;
}

export { fmtClock, secToSRT, secToASS, secToEncore, srtToSec, assToSec, encoreToSec };
