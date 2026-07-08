/* SUB Tool — 影片序列模型（時間軸上的影片區塊）
   每個 clip = { id, name, path(桌面)|web:{url}(網頁), dur(來源總長), in, out(修剪), offset(時間軸位置),
                 fps(來源實測), peaks(波形 Float32Array|null), primary(第一支影片) }
   時間域約定：
     - 「時間軸時間 t」= 全工具的權威時間（字幕/播放頭/時碼都用它）
     - 「來源時間 s」 = 影片檔內部時間；s = t - offset + in
   不變量：clip 彼此在時間軸上不重疊；offset ≥ 0；0 ≤ in < out ≤ dur。
   單一 clip 且 offset=0、in=0 時映射為恆等 → 與舊版行為完全相容。 */
import { State } from './state.js';
import { emit } from './events.js';

let _clipSeq = 1;
const EPS = 1e-6;

const Seq = {
  /* ---- 查詢 ---- */
  active(){ return State.clips.length > 0; },
  multi(){ return State.clips.length > 1; },
  len(c){ return Math.max(0, c.out - c.in); },
  clipEnd(c){ return c.offset + this.len(c); },
  /* 序列結尾（所有 clip 的最右緣；無 clip 回 0） */
  end(){ return State.clips.reduce((m, c) => Math.max(m, this.clipEnd(c)), 0); },
  byId(id){ return State.clips.find(c => c.id === id) || null; },
  primary(){ return State.clips.find(c => c.primary) || State.clips[0] || null; },
  /* 時間軸時間 t 落在哪個 clip（半開區間 [offset, end)） */
  clipAt(t){
    for(const c of State.clips){ if(t >= c.offset - EPS && t < this.clipEnd(c) - EPS) return c; }
    return null;
  },
  /* t 之後（不含）下一個開始的 clip；間隙播放時用來得知何時切入 */
  nextAfter(t){
    let best = null;
    for(const c of State.clips){ if(c.offset > t + EPS && (!best || c.offset < best.offset)) best = c; }
    return best;
  },
  /* ---- 時間映射 ---- */
  toSource(t, c){ return t - c.offset + c.in; },
  toTimeline(s, c){ return s - c.in + c.offset; },

  /* ---- 變更 ---- */
  add(meta){
    const c = { id: 'clip' + (_clipSeq++), in: 0, peaks: null, primary: false, ...meta };
    if(c.out == null) c.out = c.dur;
    if(c.offset == null) c.offset = this.end();   // 預設接在序列尾端
    State.clips.push(c);
    this.sort(); this.recomputeDuration();
    return c;
  },
  remove(id){
    const i = State.clips.findIndex(c => c.id === id);
    if(i >= 0) State.clips.splice(i, 1);
    this.recomputeDuration();
  },
  clear(){ State.clips.length = 0; },
  sort(){ State.clips.sort((a, b) => a.offset - b.offset); },
  /* 來源實際長度更新（mpv/元素回報比 probe 準時）：未修剪過的 out 跟著延伸 */
  updateSourceDur(c, dur){
    if(!dur || Math.abs(dur - c.dur) < 0.01) return;
    const untrimmed = Math.abs(c.out - c.dur) < 0.01;
    c.dur = dur;
    if(untrimmed) c.out = dur;          // 未修剪過：out 跟著新長度延伸
    else if(c.out > dur) c.out = dur;   // 修剪點超出新長度：夾回
    if(c.in >= c.out) c.in = Math.max(0, c.out - 0.2);
    this.recomputeDuration();
  },
  /* 拖曳邊界：回傳 clip 於「時間軸」上可移動的 offset 範圍（不與鄰居重疊；拖曳開始時計算一次） */
  neighborBounds(c){
    const L = this.len(c);
    let lo = 0, hi = Infinity;
    for(const o of State.clips){
      if(o === c) continue;
      const oEnd = this.clipEnd(o);
      if(oEnd <= c.offset + EPS) lo = Math.max(lo, oEnd);                    // 左鄰的右緣
      if(o.offset >= this.clipEnd(c) - EPS) hi = Math.min(hi, o.offset - L); // 右鄰的左緣 − 自身長度
    }
    return { lo, hi: Math.max(lo, hi) };
  },
  /* 磁吸目標：其他 clip 的邊緣 */
  snapEdges(excludeId){
    const arr = [];
    for(const c of State.clips){ if(c.id === excludeId) continue; arr.push(c.offset, this.clipEnd(c)); }
    return arr;
  },
  /* 序列長度改變時同步 State.duration（影片總長 = 序列最右緣） */
  recomputeDuration(){
    if(!this.active()) return;
    const e = this.end();
    if(Math.abs((State.duration || 0) - e) > 1e-9){ State.duration = e; emit('duration:known'); }
  },
  /* 歷史快照：幾何 + 成員（切割/移除/加入才能正確 undo）。
     peaks（Float32Array）不入快照（大且可再共享）；還原時依來源（path/url）從現存 clip 重新連結。 */
  snapshot(){
    return State.clips.map(c => ({ id: c.id, name: c.name, path: c.path || null,
      web: c.web ? { url: c.web.url } : null, dur: c.dur, fps: c.fps || 0,
      primary: !!c.primary, audioSrc: c.audioSrc || null,
      in: c.in, out: c.out, offset: c.offset }));
  },
  restore(list){
    if(!Array.isArray(list)) return;
    if(list.length === 0){
      // 快照建立於影片載入前（如「初始」）：媒體載入不入 undo →
      // 保留主媒體片段並還原為載入時的完整狀態，而非清空序列
      const pri = State.clips.find(c => c.primary);
      State.clips.length = 0;
      if(pri){ pri.in = 0; pri.out = pri.dur; pri.offset = 0; State.clips.push(pri); }
      this.sort(); this.recomputeDuration(); return;
    }
    const old = new Map(State.clips.map(c => [c.id, c]));
    const peaksBySrc = new Map();
    for(const c of State.clips){ const k = c.path || (c.web && c.web.url); if(k && c.peaks && !peaksBySrc.has(k)) peaksBySrc.set(k, c.peaks); }
    State.clips.length = 0;
    for(const s of list){
      const ex = old.get(s.id);
      if(ex){ ex.in = s.in; ex.out = s.out; ex.offset = s.offset; State.clips.push(ex); }
      else{
        const k = s.path || (s.web && s.web.url);
        State.clips.push({ ...s, web: s.web ? { url: s.web.url } : null, peaks: (k && peaksBySrc.get(k)) || null });
      }
    }
    this.sort(); this.recomputeDuration();
  },
};

export { Seq };
