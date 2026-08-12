import { State } from './state.js';
import { Seq } from './sequence.js';
import { emit } from './events.js';
import { getPlayerAdapter } from './media-player-adapter.js';
import { clamp } from './util.js';
import { video } from './dom.js';

export class PlaybackSyncEngine {
    constructor(mediaAdapter) {
        this.media = mediaAdapter;
    }

    start() {
        setInterval(() => {
            try { this.seqTick(); } catch (e) {}
        }, 500);
    }

    
  _syncSeqElements(t){
    for(const tr of this.media.tracks){
      if(tr.kind!=='element'||!tr.el) continue;
      if(tr._srcHidden || (tr.source||'').startsWith('ext-')) continue;
      const lt = this.media._srcLocalT(tr.source || 'video', t);
      if(lt == null) continue;
      try{ tr.el.currentTime = clamp(lt, 0, tr.el.duration || lt); }catch(e){}
    }
  }

    
  seqTick(){
    if(!this.media.playing || this.media._seqSwitching) return;
    // 純音訊專案（或影片全數刪除後）以虛擬時鐘繼續走到所有音訊素材的最右端。
    if(this.media.audioOnlyTimeline()){
      const t=this.media.tlTime();
      this.media._syncExternalElementActivity(t);
      if(t >= Math.max(0,State.duration)-0.02){ this.media.pause(); this.media.seek(State.duration); }
      return;
    }
    if(!this.media.seqOn()) return;
    const t = this.media.tlTime();
    // 外部音檔可在影片播放中、影片間隙，或影片結束後才開始／結束；其邊界
    // 不會改變 video clip 集合，因此必須獨立偵測。
    this.media._syncExternalElementActivity(t);
    // 恆等模式（單一未修剪 clip 從 0 開始）：完全交給原生 ended / mpv keep-open，行為與舊版一致
    // 圖片不計入：它們是純視覺疊層，不影響影片播放引擎
    const _videoClips = State.clips.filter(c => c.type !== 'image');
    const c0 = _videoClips[0];
    if(_videoClips.length === 1 && c0 && !this.media._gap && c0.offset === 0 && c0.in === 0
       && Math.abs(c0.out - c0.dur) < 0.05 && this.media.activeClipId === c0.id) return;
    if(this.media._gap){
      const hit = Seq.clipAt(t);
      if(hit){ this.media._ensureClip(hit, this.media._transport.sourceTime(t,hit), true); return; }
      if(!Seq.nextAfter(t) && t >= Math.max(0,State.duration)-0.02){ this.media.pause(); } // 影片結束後仍可能有外部音訊
      return;
    }
    const c = this.media._activeClip();
    if(!c){ const hit = Seq.clipAt(t); if(hit) this.media._ensureClip(hit, this.media._transport.sourceTime(t,hit), true); else this.media._enterGap(t); return; }
    // 疊合試聽：作用中片段集合變化 → 重設可聽音源並同步各自 element/buffer（讓滑入/滑出重疊的片段跟著出/停聲）。
    // okey 相同時不動，避免逐幀 churn；不改變影像的 active clip。
    const okey = Seq.clipsAt(t).filter(x=>x.type !== 'image').map(x=>x.id).join('|');
    if(okey !== this.media._lastOverlapKey){
      this.media._lastOverlapKey = okey;
      this.media._applyClipAudio(c, t);
      this.media.startElementSources(this.media.vTime(), t);
      this.media.stopBufferSources();
      if(this.media.tracks.some(x=>x.kind==='buffer'&&!x._srcHidden)) this.media.startBufferSources(this.media.vTime());
    }
    const end = Seq.clipEnd(c);
    if(t >= end - 0.02){
      const nxt = Seq.clipAt(end + 0.001);
      if(nxt) this.media._ensureClip(nxt, this.media._transport.sourceTime(end,nxt), true);
      else if(Seq.nextAfter(end)) this.media._enterGap(end);
      else if(State.duration > end + 0.001){
        this.media._enterGap(end);
        this.media.startElementSources(end,end); // 黑畫面期間外部音訊仍依時間軸繼續播
      }else { this.media.pause(); this.media.seek(end); }
    }
  }

    
  seqContinueAtEnd(){
    if(!this.media.seqOn() || !this.media.playing || this.media._seqSwitching) return false;
    const c = this.media._activeClip(); if(!c) return false;
    const end = Seq.clipEnd(c);
    const nxt = Seq.clipAt(end + 0.001);
    if(nxt){ this.media._ensureClip(nxt, this.media._transport.sourceTime(end,nxt), true); return true; }
    if(Seq.nextAfter(end)){ this.media._enterGap(end); return true; }
    if(State.duration > end + 0.001){ this.media._enterGap(end); this.media.startElementSources(end,end); return true; }
    return false;
  }

    
  _syncExternalElementActivity(t){
    const active=[];
    for(const tr of this.media.tracks){
      if(tr.kind!=='element'||!tr.el) continue;
      const source=tr.source||'';
      if(!source.startsWith('ext-')) continue;
      active.push(`${source}:${!tr._srcHidden&&this.media.externalAudio.sourceTime(source,t)!=null?'1':'0'}`);
    }
    const key=active.join('|');
    if(key===this.media._externalActivityKey) return;
    this.media._externalActivityKey=key;
    for(const tr of this.media.tracks){
      if(tr.kind!=='element'||!tr.el) continue;
      const source=tr.source||'';
      if(!source.startsWith('ext-')) continue;
      const off=!tr._srcHidden?this.media.externalAudio.sourceTime(source,t):null;
      try{
        if(off==null){ tr.el.pause(); continue; }
        tr.el.currentTime=clamp(off,0,tr.el.duration||off);
        tr.el.playbackRate=video.playbackRate||1;
        if('preservesPitch' in tr.el) tr.el.preservesPitch = (tr.el.playbackRate >= 0.25 && tr.el.playbackRate <= 4);
        const result=tr.el.play(); if(result?.catch) result.catch(()=>{});
      }catch(e){}
    }
  }
}