/* 時間軸 transport：唯一負責來源時間、時間軸時間、虛擬時鐘與 gap 時鐘的映射。 */
import { snapTimeToFrame } from './time.js';

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
