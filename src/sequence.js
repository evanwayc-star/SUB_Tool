/* SUB Tool — 影片序列模型（時間軸上的影片區塊，v4.10.0 起支援多視訊軌）
   每個 clip = { id, name, path(桌面)|web:{url}(網頁), dur(來源總長), in, out(修剪), offset(時間軸位置),
                 vtrack(視訊軌索引，0=最底/基底，數字越大越上層＝越優先覆蓋),
                 fps(來源實測), peaks(波形 Float32Array|null), primary(第一支影片) }
   時間域約定：
     - 「時間軸時間 t」= 全工具的權威時間（字幕/播放頭/時碼都用它）
     - 「來源時間 s」 = 影片檔內部時間；s = t - offset + in
   不變量：同一 vtrack 的 clip 彼此不重疊（不同軌可重疊＝疊層）；offset ≥ 0；0 ≤ in < out ≤ dur。
   單一 clip 且 offset=0、in=0、vtrack=0 時映射為恆等 → 與舊版行為完全相容。
   ★ clipAt(t) 回傳「最上層」的作用中 clip（top-occludes）；播放預覽即顯示它。 */
import { State, ensureVideoTrackCount, videoTrackVisible } from './state.js';
import { emit } from './events.js';

let _clipSeq = 1;
const EPS = 1e-6;
const vt = c => c.vtrack || 0;

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
  /* 視訊軌數：至少 State.videoTracks.length，且涵蓋現有 clip 的最高軌 */
  trackCount(){ let m = 0; for(const c of State.clips) m = Math.max(m, vt(c) + 1); return Math.max(State.videoTracks.length || 1, m); },
  trackClips(v){ return State.clips.filter(c => vt(c) === v); },
  trackEnd(v){ return this.trackClips(v).reduce((m, c) => Math.max(m, this.clipEnd(c)), 0); },
  isActiveAt(c, t){ return t >= c.offset - EPS && t < this.clipEnd(c) - EPS; },
  /* 指定軌上，t 所在的 clip */
  clipAtOnTrack(t, v){ for(const c of State.clips){ if(vt(c) === v && this.isActiveAt(c, t)) return c; } return null; },
  /* t 所在、所有軌的作用中 clip（依 vtrack 由下而上排序，供匯出疊層與音訊混音） */
  clipsAt(t){ return State.clips.filter(c => this.isActiveAt(c, t)).sort((a, b) => vt(a) - vt(b)); },
  /* ★ 最上層「可見」的作用中 clip（top-occludes）：播放預覽顯示它；隱藏的視訊軌不列入（跳到下一層） */
  clipAt(t){ const a = this.clipsAt(t); for(let i = a.length - 1; i >= 0; i--){ if(videoTrackVisible(vt(a[i]))) return a[i]; } return null; },
  /* t 之後（不含）下一個開始的 clip（任一軌）；間隙播放時用來得知何時有內容切入 */
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
    const c = { id: 'clip' + (_clipSeq++), in: 0, vtrack: 0, peaks: null, primary: false, ...meta };
    if(c.out == null) c.out = c.dur;
    if(c.offset == null) c.offset = this.trackEnd(vt(c));   // 預設接在「同軌」尾端
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
  sort(){ State.clips.sort((a, b) => (vt(a) - vt(b)) || (a.offset - b.offset)); },
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
  /* 拖曳邊界：回傳 clip 於「時間軸」上可移動的 offset 範圍（只受【同軌】鄰居限制；拖曳開始時計算一次） */
  neighborBounds(c, v){
    v = (v === undefined) ? vt(c) : v;
    const L = this.len(c);
    let lo = 0, hi = Infinity;
    for(const o of State.clips){
      if(o === c || vt(o) !== v) continue;
      const oEnd = this.clipEnd(o);
      if(oEnd <= c.offset + EPS) lo = Math.max(lo, oEnd);                    // 左鄰的右緣
      if(o.offset >= this.clipEnd(c) - EPS) hi = Math.min(hi, o.offset - L); // 右鄰的左緣 − 自身長度
    }
    return { lo, hi: Math.max(lo, hi) };
  },
  /* 自由拖放後的重疊解算（插入語義）：只在【被拖 clip 所在軌】內處理。
     同軌依 offset 排序（同位時被拖段優先），由左至右掃描——真的重疊才把後面段推到前段結尾。
     不同軌可自由重疊（＝疊層），不受影響。 */
  resolveOverlaps(moved){
    const v = vt(moved);
    const sorted = this.trackClips(v).sort((a, b) => (a.offset - b.offset) || (a === moved ? -1 : b === moved ? 1 : 0));
    let prevEnd = -Infinity;
    for(const c of sorted){
      if(c.offset < prevEnd - EPS) c.offset = prevEnd;
      prevEnd = Math.max(prevEnd, this.clipEnd(c));
    }
    this.sort(); this.recomputeDuration();
  },
  /* 把 clip 移到指定 vtrack（並在新軌解算重疊）；不足則補足視訊軌（只增不減） */
  moveToTrack(c, v){
    v = Math.max(0, Math.round(v));
    c.vtrack = v;
    ensureVideoTrackCount(v + 1);
    this.resolveOverlaps(c);
  },
  /* 補足視訊軌數以涵蓋現有 clip 的最高軌（只增不減；空軌由使用者手動刪除，比照字幕軌） */
  compact(){ let m = 0; for(const c of State.clips) m = Math.max(m, vt(c) + 1); ensureVideoTrackCount(m); },
  /* 磁吸目標：所有軌 clip 的邊緣（跨軌對齊很實用） */
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
      in: c.in, out: c.out, offset: c.offset, vtrack: vt(c), fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 }));
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
      if(ex){ ex.in = s.in; ex.out = s.out; ex.offset = s.offset; ex.vtrack = s.vtrack || 0; ex.fadeIn = s.fadeIn || 0; ex.fadeOut = s.fadeOut || 0; State.clips.push(ex); }
      else{
        const k = s.path || (s.web && s.web.url);
        State.clips.push({ ...s, vtrack: s.vtrack || 0, web: s.web ? { url: s.web.url } : null, peaks: (k && peaksBySrc.get(k)) || null });
      }
    }
    this.sort(); this.compact(); this.recomputeDuration();
  },
};

export { Seq };
