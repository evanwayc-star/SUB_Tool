/* ==============================================================================
   SUB Tool — Playback Transport Engine ("src/playback-transport-engine.js")
   ==============================================================================
   深層播放傳輸與時鐘映射引擎 (Playback Transport Engine)。
   守護鐵律 §0.5（時間域分離）與 FPS-SYNC 8 條不變量：
   1. 來源時間 ↔ 時間軸時間精確映射 (TimelineTransport)
   2. 序列播放推進、間隙轉移與外部音訊同步 (PlaybackSyncEngine)
   3. Scrub 節流調度與音調保留排程 (scheduleScrub)
   ============================================================================== */

import { snapTimeToFrame } from './time.js';
import { State } from './state.js';
import { Seq } from './sequence.js';
import { clamp } from './util.js';
import { video } from './dom.js';
import { scheduleScrub } from './scrub-scheduler.js';

export { scheduleScrub };

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const nonNegative = value => Math.max(0, finite(value));
const rateOf = value => {
  const rate = finite(value, 1);
  return rate === 0 ? 1 : rate;
};

export class TimelineTransport {
  constructor({ now = defaultNow, snap = snapTimeToFrame, toTimeline = value => value, toSource = value => value } = {}) {
    this._now = now;
    this._snap = snap;
    this._toTimeline = toTimeline;
    this._toSource = toSource;
    this.reset();
  }

  reset() {
    this._virtualTime = 0;
    this._virtualStartedAt = null;
    this._gap = false;
    this._gapTime = 0;
    this._gapStartedAt = null;
    this._pausedTime = null;
  }

  get gap() { return this._gap; }
  set gap(value) { this._gap = !!value; }
  get gapTime() { return this._gapTime; }
  set gapTime(value) { this._gapTime = nonNegative(value); }
  get gapStartedAt() { return this._gapStartedAt; }
  set gapStartedAt(value) { this._gapStartedAt = value == null ? null : finite(value); }
  get virtualTime() { return this._virtualTime; }
  set virtualTime(value) { this._virtualTime = nonNegative(value); }
  get virtualStartedAt() { return this._virtualStartedAt; }
  set virtualStartedAt(value) { this._virtualStartedAt = value == null ? null : finite(value); }
  get pausedTime() { return this._pausedTime; }
  set pausedTime(value) { this._pausedTime = value == null ? null : nonNegative(value); }

  sourceTime(timelineTime, clip) {
    const t = nonNegative(timelineTime);
    return nonNegative(clip ? this._toSource(t, clip) : t);
  }

  _clockTime(anchor, startedAt, playbackRate) {
    if (startedAt == null) return anchor;
    return anchor + (Math.max(0, this._now() - startedAt) / 1000) * rateOf(playbackRate);
  }

  virtualTimeAt(playbackRate = 1) {
    return this._clockTime(this._virtualTime, this._virtualStartedAt, playbackRate);
  }

  gapTimeAt(playbackRate = 1) {
    return this._clockTime(this._gapTime, this._gapStartedAt, playbackRate);
  }

  timelineTime({ sourceTime = 0, clip = null, virtual = false, playbackRate = 1, useGap = true } = {}) {
    if (useGap && this._gap) return this.gapTimeAt(playbackRate);
    const source = virtual ? this.virtualTimeAt(playbackRate) : nonNegative(sourceTime);
    return nonNegative(clip ? this._toTimeline(source, clip) : source);
  }

  displayTime({ playing = false, ...position } = {}) {
    if (!playing && this._pausedTime !== null) return this._pausedTime;
    return this.timelineTime(position);
  }

  seek(time, { duration = 0, fps, dropFrame = false } = {}) {
    const max = nonNegative(duration);
    const bounded = max > 0 ? Math.min(nonNegative(time), max) : nonNegative(time);
    const snapped = this._snap(bounded, fps, dropFrame);
    this._pausedTime = nonNegative(snapped);
    return this._pausedTime;
  }

  clearPausedTime() { this._pausedTime = null; }

  startVirtual(time = this.virtualTimeAt(), { playbackRate = 1 } = {}) {
    this._virtualTime = nonNegative(time);
    this._virtualStartedAt = this._now();
    void playbackRate;
    return this._virtualTime;
  }

  resumeVirtual({ playbackRate = 1 } = {}) {
    return this.startVirtual(this.virtualTimeAt(playbackRate), { playbackRate });
  }

  freezeVirtual({ playbackRate = 1 } = {}) {
    this._virtualTime = this.virtualTimeAt(playbackRate);
    this._virtualStartedAt = null;
    return this._virtualTime;
  }

  seekVirtual(time, { running = this._virtualStartedAt !== null } = {}) {
    this._virtualTime = nonNegative(time);
    this._virtualStartedAt = running ? this._now() : null;
    return this._virtualTime;
  }

  reanchorVirtual({ playbackRate = 1 } = {}) {
    if (this._virtualStartedAt === null) return this._virtualTime;
    return this.resumeVirtual({ playbackRate });
  }

  enterGap(time, { running = false } = {}) {
    this._gap = true;
    this._gapTime = nonNegative(time);
    this._gapStartedAt = running ? this._now() : null;
    return this._gapTime;
  }

  leaveGap() {
    this._gap = false;
    this._gapStartedAt = null;
  }

  freezeGap({ playbackRate = 1 } = {}) {
    this._gapTime = this.gapTimeAt(playbackRate);
    this._gapStartedAt = null;
    return this._gapTime;
  }

  pause({ sourceTime = 0, clip = null, virtual = false, playbackRate = 1, useGap = true, fps, dropFrame = false } = {}) {
    const paused = this.seek(this.timelineTime({ sourceTime, clip, virtual, playbackRate, useGap }), { fps, dropFrame });
    if (useGap && this._gap) {
      this._gapTime = paused;
      this._gapStartedAt = null;
    }
    if (virtual) {
      this._virtualTime = clip ? this.sourceTime(paused, clip) : paused;
      this._virtualStartedAt = null;
    }
    return paused;
  }

  observeSourceTime(sourceTime, { clip = null, playing = false, fps, dropFrame = false, settleFrames = 4.0 } = {}) {
    let timeline = this.timelineTime({ sourceTime, clip });
    if (!playing) {
      const frame = 1 / (finite(fps, 25) || 25);
      if (this._pausedTime !== null && Math.abs(timeline - this._pausedTime) < settleFrames * frame) {
        timeline = this._pausedTime;
      } else {
        timeline = this.seek(timeline, { fps, dropFrame });
      }
    }
    return timeline;
  }
}

export class PlaybackSyncEngine {
  constructor(mediaAdapter) {
    this.media = mediaAdapter;
    this._externalActivityKey = null;
  }

  start() {
    setInterval(() => {
      try { this.seqTick(); } catch (e) {}
    }, 500);
  }

  _syncSeqElements(t) {
    for (const tr of this.media.tracks) {
      if (tr.kind !== 'element' || !tr.el) continue;
      if (tr._srcHidden || (tr.source || '').startsWith('ext-')) continue;
      const lt = this.media._srcLocalT(tr.source || 'video', t);
      if (lt == null) continue;
      try { tr.el.currentTime = clamp(lt, 0, tr.el.duration || lt); } catch (e) {}
    }
  }

  seqTick() {
    if (!this.media.playing || this.media._seqSwitching) return;
    if (this.media.audioOnlyTimeline()) {
      const t = this.media.tlTime();
      this._syncExternalElementActivity(t);
      if (t >= Math.max(0, State.duration) - 0.02) { this.media.pause(); this.media.seek(State.duration); }
      return;
    }
    if (!this.media.seqOn()) return;
    const t = this.media.tlTime();
    if (!this.media._gap && !this.media._activeClip() && !Seq.clipAt(t)) {
      this._enterGap(t);
    }
    this._syncExternalElementActivity(t);
    const _videoClips = State.clips.filter(c => c.type !== 'image');
    const c0 = _videoClips[0];
    if (_videoClips.length === 1 && c0 && !this.media._gap && c0.offset === 0 && c0.in === 0
       && Math.abs(c0.out - c0.dur) < 0.05 && this.media.activeClipId === c0.id) return;
    if (this.media._gap) {
      const hit = Seq.clipAt(t);
      if (hit) { this.media._ensureClip(hit, this.media._transport.sourceTime(t, hit), true); return; }
      if (!Seq.nextAfter(t) && t >= Math.max(0, State.duration) - 0.02) { this.media.pause(); }
      return;
    }
    const c = this.media._activeClip();
    if (!c) {
      const hit = Seq.clipAt(t);
      if (hit) this.media._ensureClip(hit, this.media._transport.sourceTime(t, hit), true);
      else this._enterGap(t);
      return;
    }
    const okey = Seq.clipsAt(t).filter(x => x.type !== 'image').map(x => x.id).join('|');
    if (okey !== this.media._lastOverlapKey) {
      this.media._lastOverlapKey = okey;
      this.media._applyClipAudio(c, t);
      this.media.startElementSources(this.media.vTime(), t);
      this.media.stopBufferSources();
      if (this.media.tracks.some(x => x.kind === 'buffer' && !x._srcHidden)) this.media.startBufferSources(this.media.vTime());
    }
    const end = Seq.clipEnd(c);
    if (t >= end - 0.02) {
      const nxt = Seq.clipAt(end + 0.001);
      if (nxt) this.media._ensureClip(nxt, this.media._transport.sourceTime(end, nxt), true);
      else if (Seq.nextAfter(end)) this._enterGap(end);
      else if (State.duration > end + 0.001) {
        this._enterGap(end);
        this.media.startElementSources(end, end);
      } else { this.media.pause(); this.media.seek(end); }
    }
  }

  seqContinueAtEnd() {
    if (!this.media.seqOn() || !this.media.playing || this.media._seqSwitching) return false;
    const c = this.media._activeClip(); if (!c) return false;
    const end = Seq.clipEnd(c);
    const nxt = Seq.clipAt(end + 0.001);
    if (nxt) { this.media._ensureClip(nxt, this.media._transport.sourceTime(end, nxt), true); return true; }
    if (Seq.nextAfter(end)) { this._enterGap(end); return true; }
    if (State.duration > end + 0.001) { this._enterGap(end); this.media.startElementSources(end, end); return true; }
    return false;
  }

  invalidateExternalActivity() {
    this._externalActivityKey = null;
  }

  _enterGap(t) {
    this.media._enterGap(t);
    this.invalidateExternalActivity();
  }

  _syncExternalElementActivity(t) {
    const active = [];
    for (const tr of this.media.tracks) {
      if (tr.kind !== 'element' || !tr.el) continue;
      const source = tr.source || '';
      if (!source.startsWith('ext-')) continue;
      active.push(`${source}:${!tr._srcHidden && this.media.externalAudio.sourceTime(source, t) != null ? '1' : '0'}`);
    }
    const key = active.join('|');
    if (key === this._externalActivityKey) return;
    this._externalActivityKey = key;
    for (const tr of this.media.tracks) {
      if (tr.kind !== 'element' || !tr.el) continue;
      const source = tr.source || '';
      if (!source.startsWith('ext-')) continue;
      const off = !tr._srcHidden ? this.media.externalAudio.sourceTime(source, t) : null;
      try {
        if (off == null) { tr.el.pause(); continue; }
        tr.el.currentTime = clamp(off, 0, tr.el.duration || off);
        tr.el.playbackRate = video.playbackRate || 1;
        if ('preservesPitch' in tr.el) tr.el.preservesPitch = (tr.el.playbackRate >= 0.25 && tr.el.playbackRate <= 4);
        const result = tr.el.play(); if (result?.catch) result.catch(() => {});
      } catch (e) {}
    }
  }
}
