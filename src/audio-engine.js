import { State } from './state.js';
import { clamp } from './util.js';
import { Seq } from './sequence.js';

class AudioEngineCore {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.analyser = null;
    this._anBuf = null;
  }

  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.master.connect(this.analyser);
      this._anBuf = new Float32Array(this.analyser.fftSize);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get context() {
    return this.ctx;
  }

  createGain() {
    this.ensureCtx();
    return this.ctx.createGain();
  }

  decodeAudioData(buffer) {
    this.ensureCtx();
    return this.ctx.decodeAudioData(buffer);
  }

  createMediaElementSource(el) {
    this.ensureCtx();
    return this.ctx.createMediaElementSource(el);
  }

  createChannelSplitter(num) {
    this.ensureCtx();
    return this.ctx.createChannelSplitter(num);
  }

  createChannelMerger(num) {
    this.ensureCtx();
    return this.ctx.createChannelMerger(num);
  }

  startBufferSources(tracks, offset, playbackRate, seqOn, tlTime, srcLocalTFn) {
    if (!this.ctx) return null;
    let off = offset;
    if (seqOn) {
      const lt = srcLocalTFn('video', tlTime);
      if (lt != null) off = lt;
    }
    const startCtxTime = this.ctx.currentTime;
    
    for (const tr of tracks) {
      if (tr.kind !== 'buffer') continue;
      if (tr._srcHidden) continue;
      try {
        const src = this.ctx.createBufferSource();
        src.buffer = tr.buffer;
        src.playbackRate.value = playbackRate || 1;
        src.connect(tr.gain);
        tr.srcNode = src;
        src.start(0, clamp(off, 0, tr.buffer.duration));
      } catch (e) {}
    }
    return { startCtxTime, startMediaTime: off };
  }

  stopBufferSources(tracks) {
    for (const tr of tracks) {
      if (tr.srcNode) {
        try { tr.srcNode.stop(); } catch (e) {}
        try { tr.srcNode.disconnect(); } catch (e) {}
        tr.srcNode = null;
      }
    }
  }

  startElementSources(tracks, localT, tlT, seqOn, srcLocalTFn, extSourceTimeFn, playbackRate) {
    for (const tr of tracks) {
      if (tr.kind !== 'element' || !tr.el) continue;
      if (tr._srcHidden) {
        try { tr.el.pause(); } catch (e) {}
        continue;
      }
      const s = tr.source || 'video';
      let off;
      if (s.startsWith('ext-')) {
        off = extSourceTimeFn(s, tlT);
        if (off == null) {
          try { tr.el.pause(); } catch (e) {}
          continue;
        }
      } else if (seqOn) {
        const lt = srcLocalTFn(s, tlT);
        if (lt == null) {
          try { tr.el.pause(); } catch (e) {}
          continue;
        }
        off = lt;
      } else {
        off = localT;
      }
      
      try {
        tr.el.currentTime = clamp(off, 0, tr.el.duration || off);
        tr.el.playbackRate = playbackRate || 1;
        if ('preservesPitch' in tr.el) {
          tr.el.preservesPitch = (tr.el.playbackRate >= 0.25 && tr.el.playbackRate <= 4);
        }
        tr.el.play();
      } catch (e) {}
    }
  }

  stopElementSources(tracks) {
    for (const tr of tracks) {
      if (tr.kind === 'element' && tr.el) {
        try { tr.el.pause(); } catch (e) {}
      }
    }
  }

  scrubAudio(tracks, t, duration, seqOn, activeClipId, transportSourceTimeFn, playing, muted, extSourceTimeFn, activeSource, playbackRate) {
    if (playing || muted) return;
    let localT = t;
    if (seqOn) {
      const c = Seq.clipAt(t);
      if (!c || c.id !== activeClipId) return;
      localT = transportSourceTimeFn(t, c);
    }

    if (this.ctx) {
      for (const tr of tracks) {
        if (tr._srcHidden) continue;
        if (tr.kind === 'buffer') {
          const audible = tracks.some(x => x.solo) ? tr.solo : !tr.muted;
          if (audible) {
            if (tr._scrubNode) { try { tr._scrubNode.stop(); } catch (e) {} }
            try {
              const src = this.ctx.createBufferSource();
              src.buffer = tr.buffer;
              src.playbackRate.value = playbackRate || 1;
              src.connect(tr.gain);
              src.start(0, clamp(localT, 0, tr.buffer.duration), duration);
              tr._scrubNode = src;
            } catch (e) {}
          }
        }
      }
    }

    const scrubEl = (el, tt) => {
      if (!el.src) return;
      if (!el._scrubEl) {
        el._scrubEl = document.createElement('video');
        el._scrubEl.preload = 'auto';
      }

      const doPlay = () => {
        el._scrubEl.playbackRate = el.playbackRate || 1;
        if ('preservesPitch' in el._scrubEl) {
          el._scrubEl.preservesPitch = (el._scrubEl.playbackRate >= 0.25 && el._scrubEl.playbackRate <= 4);
        }
        el._scrubEl.currentTime = clamp(tt, 0, el.duration || tt);
        el._scrubEl.volume = muted ? 0 : 1;
        const p = el._scrubEl.play();
        if (p !== undefined) {
          p.then(() => {
            clearTimeout(el._scrubTimer);
            el._scrubTimer = setTimeout(() => { el._scrubEl.pause(); }, 150);
          }).catch(() => {});
        }
      };

      if (el._scrubEl.src !== el.src) {
        el._scrubEl.src = el.src;
        el._scrubEl.onloadedmetadata = () => {
          el._scrubEl.onloadedmetadata = null;
          doPlay();
        };
      } else if (el._scrubEl.readyState >= 1) {
        doPlay();
      } else {
        el._scrubEl.onloadedmetadata = () => {
          el._scrubEl.onloadedmetadata = null;
          doPlay();
        };
      }
    };

    const anySolo = tracks.some(tr => tr.solo && !tr._srcHidden);
    const activeMix = anySolo
      ? tracks.some(tr => (tr.kind === 'buffer' || tr.kind === 'element') && !tr._srcHidden && tr.solo)
      : tracks.some(tr => (tr.kind === 'buffer' || tr.kind === 'element') && !tr._srcHidden && !tr.muted);
      
    if (!activeMix && (activeSource === 'video' || activeSource === null)) {
      // Return true to indicate main video should be scrubbed
      return { scrubMainVideo: true, localT };
    }
    
    for (const tr of tracks) {
      if (tr._srcHidden) continue;
      if (tr.kind === 'element' && tr.el) {
        const audible = anySolo ? tr.solo : !tr.muted;
        if (audible) {
          const source = tr.source || '';
          const off = source.startsWith('ext-') ? extSourceTimeFn(source, t) : localT;
          if (off != null) scrubEl(tr.el, off);
        }
      }
    }
    return { scrubMainVideo: false, localT };
  }
}

export const AudioEngine = new AudioEngineCore();
