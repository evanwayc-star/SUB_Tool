import { State } from './state.js';
import { clamp } from './util.js';
import { Seq } from './sequence.js';
import { anySourceSolo, sourceTrackAudible } from './project-audio.js';

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

  /* 讀 master analyser 的時域取樣。回傳內部緩衝區（呼叫端只讀不存）；
     還沒有 AudioContext 時回傳 null。

     【為什麼是這裡】ctx / analyser / _anBuf 原本住在 media.js，v5.11.8 的
     「深度解耦」把它們搬進本模組，但 Wave.captureLive() 的讀取端留在原地，
     繼續讀早已不存在的 Media.analyser / Media._anBuf——於是它的守衛
     `if(!Media.analyser) return;` 永遠成立，長檔的即時波形產生靜默失效。
     搬狀態就要一起搬讀取端；讀取端沒有入口可用時，就會像那次一樣留在原地爛掉。 */
  readTimeDomain() {
    if (!this.analyser || !this._anBuf) return null;
    this.analyser.getFloatTimeDomainData(this._anBuf);
    return this._anBuf;
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

    /* 預覽語意：被來源篩選藏起來的聲道不算進 Solo（respectHidden:true）。
       這一行以前寫 `tracks.some(x => x.solo)`——沒有排除 _srcHidden，
       與同一個函式下方第二處判斷【不一致】。規則現在只有 project-audio.js 一份。 */
    const anySolo = anySourceSolo(tracks, { respectHidden: true });

    if (this.ctx) {
      for (const tr of tracks) {
        if (tr._srcHidden) continue;
        if (tr.kind === 'buffer') {
          const audible = sourceTrackAudible(tr, anySolo);
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

    const activeMix = tracks.some(tr =>
      (tr.kind === 'buffer' || tr.kind === 'element') && !tr._srcHidden && sourceTrackAudible(tr, anySolo));


    if (!activeMix && (activeSource === 'video' || activeSource === null)) {
      // Return true to indicate main video should be scrubbed
      return { scrubMainVideo: true, localT };
    }
    
    for (const tr of tracks) {
      if (tr._srcHidden) continue;
      if (tr.kind === 'element' && tr.el) {
        const audible = sourceTrackAudible(tr, anySolo);
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
