import { clamp } from './util.js';

const schedulers = new WeakMap();

class ElementScrubber {
  constructor(sourceEl) {
    this.sourceEl = sourceEl;
    this.scrubEl = document.createElement(sourceEl.tagName);
    this.scrubEl.preload = 'auto';
    this.playPromise = null;
    this.pauseTimer = null;
    this.pending = null;
  }
  
  scrub(targetT, { rate = 1, preservesPitch = false, isMuted = false, durationMs = 150 }) {
    if (!this.sourceEl.src) return;
    
    this.pending = { targetT, rate, preservesPitch, isMuted, durationMs };
    
    if (this.playPromise) {
      // Let the current play finish, the pending one will be picked up
      return;
    }
    
    this._processPending();
  }
  
  _processPending() {
    if (!this.pending) return;
    const task = this.pending;
    this.pending = null;
    
    if (this.scrubEl.src !== this.sourceEl.src) {
      this.scrubEl.src = this.sourceEl.src;
      this.scrubEl.onloadedmetadata = () => {
        this.scrubEl.onloadedmetadata = null;
        this._execute(task);
      };
    } else if (this.scrubEl.readyState >= 1) {
      this._execute(task);
    } else {
      this.scrubEl.onloadedmetadata = () => {
        this.scrubEl.onloadedmetadata = null;
        this._execute(task);
      };
    }
  }
  
  _execute(task) {
    clearTimeout(this.pauseTimer);
    
    this.scrubEl.playbackRate = task.rate;
    if ('preservesPitch' in this.scrubEl) {
      this.scrubEl.preservesPitch = task.preservesPitch;
    }
    
    this.scrubEl.currentTime = clamp(task.targetT, 0, this.sourceEl.duration || task.targetT);
    this.scrubEl.volume = task.isMuted ? 0 : 1;
    
    const p = this.scrubEl.play();
    if (p !== undefined) {
      this.playPromise = p;
      p.then(() => {
        this.playPromise = null;
        if (this.pending) {
          // If a new scrub request came in while we were playing, execute it immediately instead of pausing
          this.scrubEl.pause();
          this._processPending();
        } else {
          // No pending scrubs, schedule the pause
          this.pauseTimer = setTimeout(() => {
            this.scrubEl.pause();
          }, task.durationMs);
        }
      }).catch(() => {
        this.playPromise = null;
        if (this.pending) this._processPending();
      });
    } else {
      // For older browsers where play() doesn't return a promise
      this.pauseTimer = setTimeout(() => {
        this.scrubEl.pause();
      }, task.durationMs);
    }
  }
  
  destroy() {
    clearTimeout(this.pauseTimer);
    this.scrubEl.src = '';
  }
}

export function scheduleScrub(sourceEl, targetT, options = {}) {
  let scrubber = schedulers.get(sourceEl);
  if (!scrubber) {
    scrubber = new ElementScrubber(sourceEl);
    schedulers.set(sourceEl, scrubber);
  }
  scrubber.scrub(targetT, options);
}

export function destroyScrubber(sourceEl) {
  const scrubber = schedulers.get(sourceEl);
  if (scrubber) {
    scrubber.destroy();
    schedulers.delete(sourceEl);
  }
}
