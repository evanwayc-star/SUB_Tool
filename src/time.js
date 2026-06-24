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
  if(s<0)s=0; const cs=Math.round(s*100); // ASS 使用百分秒
  return `${Math.floor(cs/360000)}:${pad((cs/6000)%60)}:${pad((cs/100)%60)}.${pad(cs%100,2)}`;
}
function secToEncore(s,fps,df=false){
  if(s<0)s=0;
  if(df && Math.abs(fps-29.97)<0.01){
    const n=Math.round(s*30000/1001);
    const D=Math.floor(n/17982), F=n%17982;
    const adj=F<2?0:Math.floor((F-2)/1798);
    const a=n+2*(D*9+adj);
    const ff=a%30, rest=Math.floor(a/30);
    const ss=rest%60, mm=Math.floor(rest/60)%60, hh=Math.floor(rest/3600);
    return `${pad(hh)}:${pad(mm)}:${pad(ss)};${pad(ff)}`;
  }
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
function encoreToSec(t,fps,df=false){
  const m=t.trim().match(/(\d+):(\d+):(\d+)[:;](\d+)/); if(!m)return 0;
  const hh=+m[1],mm=+m[2],ss=+m[3],ff=+m[4];
  if(df && Math.abs(fps-29.97)<0.01){
    const totalMin=60*hh+mm;
    const n=30*3600*hh+30*60*mm+30*ss+ff-2*(totalMin-Math.floor(totalMin/10));
    return n*1001/30000;
  }
  return hh*3600+mm*60+ss+ff/fps;
}

export { fmtClock, secToSRT, secToASS, secToEncore, srtToSec, assToSec, encoreToSec };
