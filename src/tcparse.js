/* SUB Tool — 時間碼輸入解析（葉模組：字串 → 秒，支援絕對/緊湊/Drop-frame） */
import { State } from './state.js';
import { pad } from './util.js';
import { encoreToSec } from './time.js';

function parseTimecodeInput(str){
  str=String(str).trim(); if(!str)return null;
  let h=0,m=0,s=0,f=0;
  if(str.includes(':')||str.includes(';')){
    const p=str.split(/[:;]/).map(x=>parseInt(x,10)||0);
    // 由右至左：格, 秒, 分, 時
    f=p[p.length-1]||0; s=p[p.length-2]||0; m=p[p.length-3]||0; h=p[p.length-4]||0;
    if(State.dropFrame)
      return encoreToSec(`${pad(h)}:${pad(m)}:${pad(s)};${pad(f)}`,State.fps,true);
  }else{
    if(!/^\d+$/.test(str))return null;
    const g=[]; let r=str; while(r.length>2){ g.unshift(r.slice(-2)); r=r.slice(0,-2); } g.unshift(r);
    // g = [..., mm, ss, ff]  （由右至左對應 格/秒/分/時）
    f=+(g[g.length-1]||0); s=+(g[g.length-2]||0); m=+(g[g.length-3]||0); h=+(g[g.length-4]||0);
    if(State.dropFrame)
      return encoreToSec(`${pad(h)}:${pad(m)}:${pad(s)};${pad(f)}`,State.fps,true);
  }
  const fpsR=Math.round(State.fps)||24;
  return h*3600 + m*60 + s + Math.min(f,fpsR-1)/State.fps;
}

export { parseTimecodeInput };
