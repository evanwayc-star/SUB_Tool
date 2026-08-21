import { AudioEngine } from './audio-engine.js';
import { clamp } from './util.js';
import { Seq } from './sequence.js';
import { scheduleScrub } from './scrub-scheduler.js';

export class MediaAudioRouter {
  constructor(media, video, stateObj) {
    this.media = media;
    this.video = video;
    this.state = stateObj;
    this._audioEngineBound = false;
  }

  /* 把播放狀態接給 AudioEngine（只做一次）。 */
  bindEngine() {
    if(this._audioEngineBound) return;
    this._audioEngineBound = true;
    AudioEngine.bind({
      tracks: () => this.media.tracks,
      seqOn: () => this.media.seqOn(),
      playing: () => this.media.playing,
      muted: () => this.state.muted,
      activeSource: () => this.media.activeSource,
      activeClipId: () => this.media.activeClipId,
      playbackRate: () => this.video.playbackRate || 1,
      timelineTime: () => this.media.tlTime(),
      sourceTimeFor: (s, t) => this.media._srcLocalT(s, t),
      externalSourceTimeFor: (s, t) => this.media.externalAudio.sourceTime(s, t),
      clipSourceTimeFor: (t, c) => this.media._transport.sourceTime(t, c),
    });
  }

  ensureCtx() {
    this.bindEngine();
    return AudioEngine.ensureCtx();
  }

  startElementSources(localT, tlT) {
    AudioEngine.startElements(localT, tlT);
  }

  stopElementSources() {
    AudioEngine.stopElements();
  }

  restartElements() {
    if(!this.media.playing) return;
    const c = this.media.seqOn() ? this.media._activeClip() : null;
    const tl = this.media.tlTime();
    this.startElementSources(c ? Seq.toSource(tl, c) : this.media.vTime(), tl);
  }

  startBufferSources(offset) {
    AudioEngine.startBuffers(offset);
  }

  stopBufferSources() {
    AudioEngine.stopBuffers();
  }

  scrubAudio(t, duration = 0.15) {
    const res = AudioEngine.scrub(t, duration);
    if (res && res.scrubMainVideo) {
      if(!this.video.src) return;
      const rate = this.video.playbackRate || 1;
      const preservesPitch = rate >= 0.25 && rate <= 4;
      scheduleScrub(this.video, res.localT, {
        rate,
        preservesPitch,
        isMuted: this.state.muted,
        durationMs: duration * 1000
      });
    }
  }

  /* 從 app.js 提取過來的 drift 修正邏輯 */
  syncDrift() {
    // buffer 音軌 drift 校正（序列間隙中不校正——影片已暫停，重啟音源會誤出聲）
    if(this.media.tracks.some(t=>t.kind==='buffer'&&!t._srcHidden)){
      // vTime() 是播放器公開的來源時鐘：HTML5 時讀 video.currentTime，mpv 時讀
      // native time-pos。不可固定讀隱藏的 HTML video，否則 mpv 播放時它停在 0，
      // 每次 drift tick 都會把正常前進的 buffer 誤判成漂移並重啟。
      AudioEngine.syncBuffers(this.media.vTime(), { inGap: this.media.inGap() });
    }
    // element 音軌 drift 校正（多軌同步）：ext-* 參考音對其來源時間（含 offset/in）；clip 綁定音軌對【各自音源】的來源時間
    for(const tr of this.media.tracks){ 
      if(tr.kind==='element' && tr.el && !tr.el.paused){
        const s = tr.source||'';
        let ref;
        if(s.startsWith('ext-')){
          const st = this.media.externalAudio?.sourceTime?.(s, this.media.tlTime());
          if(st == null){
            try{ tr.el.pause(); }catch(e){}
            continue;
          }
          ref = st;
        }
        else if(this.media.seqOn()){ 
          const lt = this.media.sourceLocalTime(s||'video', this.media.tlTime()); 
          if(lt==null) continue; 
          ref = lt; 
        }
        else ref = this.media.vTime();
        
        if(Math.abs(tr.el.currentTime - ref) > 0.12){ 
          try{ tr.el.currentTime = ref; }catch(e){} 
        }
      }
    }
  }
}
