/* Media 的內部 implementation，不是另一個可替換的播放引擎。
   FPS-SYNC：片段配線、element 起播與 tick 共用同一份活動證據；
   畫格完成及最新播放意圖仍由 media-presentation-core 的 session 決定。 */
import { State } from './state.js';
import { Seq } from './sequence.js';
import { getPlayerAdapter } from './media-player-adapter.js';

export class MediaPlaybackRuntime {
  #overlapKey = null;
  #externalKey = null;
  #elementWork = null;
  #versions = { element: 0, buffer: 0 };

  constructor(media) { this.media = media; }

  reset() {
    this.#overlapKey = null;
    this.invalidateExternalActivity();
    this.#versions.element++;
    this.#versions.buffer++;
  }

  invalidateExternalActivity() {
    this.#externalKey = null;
    this.#elementWork = null;
  }

  #overlapAt(time) {
    return Seq.clipsAt(time).filter(clip => clip.type !== 'image').map(clip => clip.id).join('|');
  }

  #externalAt(time) {
    return this.media.tracks.filter(track => track.kind === 'element' && track.el && (track.source || '').startsWith('ext-'))
      .map(track => `${track.source}:${!track._srcHidden && this.media.externalAudio.sourceTime(track.source, time) != null ? '1' : '0'}`).join('|');
  }

  // 配線與其證據一起提交；同步通知若建立新 seek，舊工作不能留下已套用的證據。
  prepareClip(clip, time, owns, { force = false } = {}) {
    const media = this.media;
    if (!owns() || media._activeClip() !== clip) return false;
    const key = this.#overlapAt(time);
    if (force || key !== this.#overlapKey) {
      media._applyClipAudio(clip, time);
      if (!owns() || media._activeClip() !== clip) return false;
      this.#overlapKey = key;
    }
    return true;
  }

  #prepareAt(time, owns) {
    const media = this.media;
    if (!owns()) return false;
    if (!media.seqOn() || media.inGap()) return true;
    // 合成預覽的最上層可能不是目前 clock carrier；沿用已接受的 active clip。
    const clip = media._activeClip();
    return !!clip && this.prepareClip(clip, time, owns);
  }

  // 呈現後起播、跨段及 tick 都從此處提交 followers，不由 caller 維護活動 key。
  startFollowers(sourceTime, time, { owns = this.media.capturePlaybackTargetOwnership(), buffers = true, restartBuffers = false, elementsPrepared = false } = {}) {
    const media = this.media;
    const current = () => owns() && media.playing && !media.playbackTransitionPending();
    if (!this.#prepareAt(time, current)) return;
    if (restartBuffers) {
      if(!elementsPrepared)this.startElements(sourceTime, time);
      if (!current()) return;
      this.stopBuffers();
    }
    if (!current()) return;
    if (buffers && media.tracks.some(track => track.kind === 'buffer' && !track._srcHidden)) this.startBuffers(sourceTime);
    if (!current()) return;
    if (!restartBuffers&&!elementsPrepared) this.startElements(sourceTime, time);
  }

  async prepareFollowers(sourceTime,time,{owns}) {
    const media=this.media,version=++this.#versions.element;
    const current=()=>version===this.#versions.element&&owns();
    if(!this.#prepareAt(time,current))return null;
    const reversed=[...Seq.clipsAt(time).filter(clip=>clip.reverse&&!clip.audioDetached&&!Seq.isStill(clip)),
      ...media.externalAudioSources.filter(asset=>asset.reverse&&media.externalAudio.sourceTime(asset.audioSrc,time)!=null)];
    if(reversed.length){
      const ready=await Promise.all(reversed.map(clip=>media.prepareClipReverseAudio(clip)));
      if(!current())return null;
      if(ready.some(value=>!value))throw new Error('反轉音訊尚未就緒');
    }
    const active=media._activeClip(),source=active?(active.audioSrc||(active.primary?'video':`clip:${active.id}`)):'video';
    if(media.mpvMode&&!media.inGap()&&media.tracks.some(track=>(track.kind==='element'||track.kind==='buffer')&&!track._srcHidden
      &&(track.source||'video')===source)){
      await getPlayerAdapter().mute(true);
      if(!current())return null;
    }
    const key=this.#externalAt(time),overlap=this.#overlapAt(time);
    const prepared=media._audioRouter.prepareElementSources(sourceTime,time,{owns:current});
    const result=await prepared.ready;
    if(!current()){prepared.cancel();return null;}
    if(result.status==='cancelled')throw new Error('音訊來源已變更');
    if(result.status==='failed')throw result.error;
    return {cancel:prepared.cancel,
      requiresPlayingClock:prepared.hasElements||media.tracks.some(track=>track.kind==='buffer'&&!track._srcHidden),
      matches:(actualSource,actualTime)=>Math.abs(actualSource-sourceTime)<=.12&&Math.abs(actualTime-time)<=.12
        &&this.#externalAt(actualTime)===key&&this.#overlapAt(actualTime)===overlap,
      commit:async()=>{
        if(!current()){prepared.cancel();return false;}
        const started=await prepared.commit();
        if(!current())return false;
        if(!started)throw new Error('音訊聲道已失去起播資格');
        this.#externalKey=key;this.#elementWork=null;return true;
      }};
  }

  #afterMpvMute(kind, start) {
    const media = this.media, version = ++this.#versions[kind];
    const active = media._activeClip(), ownsTarget = media.capturePlaybackTargetOwnership();
    const owns = () => version === this.#versions[kind] && ownsTarget();
    const source = active ? (active.audioSrc || (active.primary ? 'video' : `clip:${active.id}`)) : 'video';
    const replacesCarrier = media.mpvMode && !media.inGap() && media.tracks.some(track =>
      (track.kind === 'element' || track.kind === 'buffer') && !track._srcHidden && (track.source || 'video') === source);
    if (!replacesCarrier) return start(false, owns);
    const adapter = getPlayerAdapter();
    // 必須等命令 ACK；pipe write 或較舊的靜音回覆不能讓第二個聲源起播。
    return adapter.mute(true).then(() => {
      if (!owns() || !media.playing || media.playbackTransitionPending() || media.reverseShuttleMuted()
        || !media.mpvMode || getPlayerAdapter() !== adapter || media._activeClip() !== active) return;
      return start(true, owns);
    }).catch(error => console.warn('mpv 音訊接管失敗：', error));
  }

  startElements(sourceTime, time) {
    const media = this.media;
    if (media.playbackTransitionPending()) return;
    const timeline = time ?? (media.seqOn() ? media.tlTime() : sourceTime);
    const work = { key: this.#externalAt(timeline) };
    this.#elementWork = work;
    const pending = this.#afterMpvMute('element', (delayed, ownsStart) => {
      const owns = () => this.#elementWork === work && ownsStart();
      if (!owns()) return;
      const local = delayed ? media.vTime() : sourceTime;
      const currentTime = delayed ? media.tlTime() : timeline;
      const reversed = [...Seq.clipsAt(currentTime).filter(clip => clip.reverse && !clip.audioDetached && !Seq.isStill(clip)),
        ...media.externalAudioSources.filter(asset => asset.reverse && media.externalAudio.sourceTime(asset.audioSrc, currentTime) != null)];
      if (!reversed.length) { this.#commitAudio('element', local, currentTime, owns, { refreshRouting: delayed }); return; }
      return Promise.all(reversed.map(clip => media.prepareClipReverseAudio(clip))).then(ready => {
        if (!owns() || !media.playing || media.playbackTransitionPending() || media.reverseShuttleMuted() || ready.some(value => !value)) return;
        const actualTime = media.tlTime();
        this.#commitAudio('element', media.vTime(), actualTime, owns, { refreshRouting: true, restartBuffers: true });
      }).catch(error => console.warn('reverse audio playback:', error));
    });
    // 失敗或取消只撤回自己的 pending 證據，不能卡住下一個 tick 或新工作。
    Promise.resolve(pending).finally(() => { if (this.#elementWork === work) this.#elementWork = null; });
  }

  #commitAudio(kind, sourceTime, time, owns, { refreshRouting = false, restartBuffers = false } = {}) {
    // canplay 只補啟動已接受的配線；真正等待 mute ACK／反轉解碼後，
    // 播放位置可能已跨片段，才用完成時的位置重算並提交活動證據。
    const previousOverlap = this.#overlapKey;
    if (!owns() || (refreshRouting && !this.#prepareAt(time, owns))) return false;
    const changed = previousOverlap !== this.#overlapKey;
    // 只有首次提交新活動的一方補齊另一種 follower；後續同一 key 的
    // ACK 不再互相重建。被取代的 request 由各 kind version 撤銷。
    if (kind === 'buffer') {
      if (changed) this.startElements(sourceTime, time);
      if (!owns()) return false;
      this.media._audioRouter.startBufferSources(sourceTime);
      return owns();
    }
    const key = this.#externalAt(time);
    this.media._audioRouter.startElementSources(sourceTime, time);
    if (!owns()) return false;
    if (changed || restartBuffers) {
      this.stopBuffers();
      if (!owns()) return false;
      if (this.media.tracks.some(track => track.kind === 'buffer' && !track._srcHidden)) this.startBuffers(sourceTime);
      if (!owns()) return false;
    }
    this.#externalKey = key;
    this.#elementWork = null;
    return true;
  }

  stopElements() {
    this.#versions.element++;
    this.invalidateExternalActivity();
    this.media._audioRouter.stopElementSources();
  }

  startBuffers(sourceTime) {
    const media = this.media;
    if (media.playbackTransitionPending()) return;
    this.#afterMpvMute('buffer', (delayed, owns) => {
      this.#commitAudio('buffer', delayed ? media.vTime() : sourceTime, delayed ? media.tlTime() : null,
        owns, { refreshRouting: delayed });
    });
  }

  stopBuffers() {
    this.#versions.buffer++;
    this.media._audioRouter.stopBufferSources();
  }

  #syncExternal(time) {
    const key = this.#externalAt(time);
    // 尚未起播的活動要先被新位置取代；離開再回到舊 committed key
    // 不代表 pending 仍有效，否則晚到反轉解碼會重啟已恢復的聲音。
    if (this.#elementWork) {
      if (key !== this.#elementWork.key) this.startElements(this.media.vTime(), time);
      return;
    }
    if (!key && this.#externalKey === null) { this.#externalKey = key; return; }
    if (key === this.#externalKey) return;
    this.startElements(this.media.vTime(), time);
  }

  #enterGap(time, owns) {
    this.media._enterGap(time, owns);
    if (owns()) this.#overlapKey = null;
  }

  tick() {
    const media = this.media;
    if (!media.playing || media._seqSwitching || !media.presenterClockMoving()) return;
    const owns = media.capturePlaybackTargetOwnership();
    const current = () => owns() && media.playing && !media._seqSwitching && media.presenterClockMoving();
    const time = media.tlTime();
    if (media.audioOnlyTimeline()) {
      this.#syncExternal(time);
      if (!current()) return;
      if (time >= Math.max(0, State.duration) - 0.02) {
        media.pause();
        if (owns()) media.seek(State.duration);
      }
      return;
    }
    if (!media.seqOn()) return;
    if (!media.inGap() && !media._activeClip() && !Seq.clipAt(time)) this.#enterGap(time, current);
    if (!current()) return;
    const clips = State.clips.filter(clip => clip.type !== 'image'), only = clips[0];
    if (clips.length === 1 && only && !media.inGap() && only.offset === 0 && only.in === 0
      && !only.reverse && !(Number(only.speed) > 0 && Number(only.speed) !== 1)
      && Math.abs(only.out - only.dur) <= Number.EPSILON * Math.max(1, Math.abs(only.dur)) * 4
      && media.activeClipId === only.id) {
      this.#syncExternal(time);
      return;
    }
    if (media.inGap()) {
      this.#syncExternal(time);
      if (!current()) return;
      const next = Seq.clipAt(time);
      if (next) { media._ensureClip(next, Seq.toSource(time, next), true); return; }
      if (!Seq.nextAfter(time) && time >= Math.max(0, State.duration) - 0.02) media.pause();
      return;
    }
    const clip = media._activeClip();
    if (!clip) {
      this.#syncExternal(time);
      if (!current()) return;
      const next = Seq.clipAt(time);
      if (next) media._ensureClip(next, Seq.toSource(time, next), true);
      else this.#enterGap(time, current);
      return;
    }
    const end = Seq.clipEnd(clip);
    if (time >= end - 0.02) {
      if (!this.#continueAtEnd(clip, current)) {
        media.pause();
        if (owns()) media.seek(end);
      }
      return;
    }
    if (this.#overlapAt(time) !== this.#overlapKey) {
      this.startFollowers(media.vTime(), time, { owns: current, restartBuffers: true });
    } else this.#syncExternal(time);
  }

  continueAtEnd() {
    const media = this.media;
    if (!media.seqOn() || !media.playing || media._seqSwitching) return false;
    const clip = media._activeClip();
    if (!clip) return false;
    const owns = media.capturePlaybackTargetOwnership();
    return this.#continueAtEnd(clip, () => owns() && media.playing && !media._seqSwitching);
  }

  #continueAtEnd(clip, current) {
    const end = Seq.clipEnd(clip), next = Seq.clipAt(end + 0.001);
    if (next) { this.media._ensureClip(next, Seq.toSource(end, next), true); return true; }
    if (Seq.nextAfter(end) || State.duration > end + 0.001) {
      this.#enterGap(end, current);
      if (current()) this.startFollowers(end, end, { owns: current, buffers: false });
      return true;
    }
    return false;
  }
}
