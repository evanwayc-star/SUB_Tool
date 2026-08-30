/* 序列播放協調器。它擁有 clip/gap/外部音訊的轉移順序，但不擁有時鐘：
   app-ticker.js 是唯一排程器，Media 只透過下列 port 提供即時狀態與動作。 */
import { clamp } from './util.js';

function requirePort(port) {
  for (const name of ['clock', 'sequence', 'audio', 'actions']) {
    if (!port?.[name]) throw new TypeError(`PlaybackSyncEngine 缺少 ${name} port`);
  }
  return port;
}

export class PlaybackSyncEngine {
  constructor(port) {
    this.port = requirePort(port);
    this._externalActivityKey = null;
  }

  syncSequenceElements(t) {
    const { audio } = this.port;
    for (const track of audio.tracks()) {
      if (track.kind !== 'element' || !track.el) continue;
      if (track._srcHidden || (track.source || '').startsWith('ext-')) continue;
      const localTime = audio.sourceLocalTime(track.source || 'video', t);
      if (localTime == null) continue;
      try { track.el.currentTime = clamp(localTime, 0, track.el.duration || localTime); } catch (error) {}
    }
  }

  seqTick() {
    const { clock, sequence, audio, actions } = this.port;
    if (!clock.isPlaying() || clock.isSwitching() || clock.presenterMoving() === false) return;

    if (sequence.audioOnly()) {
      const time = clock.timelineTime();
      this._syncExternalElementActivity(time);
      if (time >= Math.max(0, sequence.duration()) - 0.02) {
        actions.pause();
        actions.seek(sequence.duration());
      }
      return;
    }
    if (!sequence.enabled()) return;

    const time = clock.timelineTime();
    if (!sequence.inGap() && !sequence.activeClip() && !sequence.clipAt(time)) this._enterGap(time);
    this._syncExternalElementActivity(time);

    const videoClips = sequence.videoClips();
    const onlyClip = videoClips[0];
    if (videoClips.length === 1 && onlyClip && !sequence.inGap()
      && onlyClip.offset === 0 && onlyClip.in === 0
      && Math.abs(onlyClip.out - onlyClip.dur) < 0.05
      && sequence.activeClipId() === onlyClip.id) return;

    if (sequence.inGap()) {
      const hit = sequence.clipAt(time);
      if (hit) {
        actions.ensureClip(hit, sequence.sourceTime(time, hit), true);
        return;
      }
      if (!sequence.nextAfter(time) && time >= Math.max(0, sequence.duration()) - 0.02) actions.pause();
      return;
    }

    const clip = sequence.activeClip();
    if (!clip) {
      const hit = sequence.clipAt(time);
      if (hit) actions.ensureClip(hit, sequence.sourceTime(time, hit), true);
      else this._enterGap(time);
      return;
    }

    const overlapKey = sequence.clipsAt(time)
      .filter(item => item.type !== 'image')
      .map(item => item.id)
      .join('|');
    if (overlapKey !== actions.overlapKey()) {
      actions.setOverlapKey(overlapKey);
      actions.applyClipAudio(clip, time);
      actions.startElementSources(clock.sourceTime(), time);
      actions.stopBufferSources();
      if (audio.tracks().some(track => track.kind === 'buffer' && !track._srcHidden)) {
        actions.startBufferSources(clock.sourceTime());
      }
    }

    const end = sequence.clipEnd(clip);
    if (time < end - 0.02) return;
    const next = sequence.clipAt(end + 0.001);
    if (next) actions.ensureClip(next, sequence.sourceTime(end, next), true);
    else if (sequence.nextAfter(end)) this._enterGap(end);
    else if (sequence.duration() > end + 0.001) {
      this._enterGap(end);
      actions.startElementSources(end, end);
    } else {
      actions.pause();
      actions.seek(end);
    }
  }

  seqContinueAtEnd() {
    const { clock, sequence, actions } = this.port;
    if (!sequence.enabled() || !clock.isPlaying() || clock.isSwitching()) return false;
    const clip = sequence.activeClip();
    if (!clip) return false;
    const end = sequence.clipEnd(clip);
    const next = sequence.clipAt(end + 0.001);
    if (next) {
      actions.ensureClip(next, sequence.sourceTime(end, next), true);
      return true;
    }
    if (sequence.nextAfter(end)) {
      this._enterGap(end);
      return true;
    }
    if (sequence.duration() > end + 0.001) {
      this._enterGap(end);
      actions.startElementSources(end, end);
      return true;
    }
    return false;
  }

  invalidateExternalActivity() {
    this._externalActivityKey = null;
  }

  _enterGap(time) {
    this.port.actions.enterGap(time);
    this.invalidateExternalActivity();
  }

  _syncExternalElementActivity(time) {
    const { clock, audio } = this.port;
    const active = [];
    for (const track of audio.tracks()) {
      if (track.kind !== 'element' || !track.el) continue;
      const source = track.source || '';
      if (!source.startsWith('ext-')) continue;
      active.push(`${source}:${!track._srcHidden && audio.externalSourceTime(source, time) != null ? '1' : '0'}`);
    }
    const key = active.join('|');
    if (key === this._externalActivityKey) return;
    this._externalActivityKey = key;

    for (const track of audio.tracks()) {
      if (track.kind !== 'element' || !track.el) continue;
      const source = track.source || '';
      if (!source.startsWith('ext-')) continue;
      const offset = !track._srcHidden ? audio.externalSourceTime(source, time) : null;
      try {
        if (offset == null) { track.el.pause(); continue; }
        track.el.currentTime = clamp(offset, 0, track.el.duration || offset);
        track.el.playbackRate = clock.playbackRate();
        if ('preservesPitch' in track.el) {
          track.el.preservesPitch = track.el.playbackRate >= 0.25 && track.el.playbackRate <= 4;
        }
        const result = track.el.play();
        if (result?.catch) result.catch(() => {});
      } catch (error) {}
    }
  }
}
