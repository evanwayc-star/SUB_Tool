import { State } from './state.js';
import { clamp } from './util.js';
import { Seq } from './sequence.js';
import { anySourceSolo, sourceTrackAudible } from './project-audio.js';
import { scheduleScrub } from './scrub-scheduler.js';

/* AudioContext 的建立是這個模組唯一的外部相依，也是它長期【零測試】的原因：
   模組層直接 `new AudioContext()`，vitest 的 node 環境起不動它，jsdom 也沒有
   Web Audio。於是這 250 多行——播放起停、序列時間域換算、scrub、可聽性篩選
   ——一行測試都碰不到。

   把「怎麼生出一個 AudioContext」變成注入點就夠了：生產環境維持原本的行為
   （不傳就用 window.AudioContext），測試傳一個假的進來。這是模組的【內部接縫】，
   不是公開介面的一部分——呼叫端仍然只用匯出的 AudioEngine 單例。 */
const defaultCreateContext = () => new (window.AudioContext || window.webkitAudioContext)();

/* 未 bind 時的預設環境：沒有音軌、非序列、沒有時間域轉換。
   讓 transport 方法在還沒接上 Media 時是安全的 no-op，而不是丟例外。 */
const UNBOUND = Object.freeze({
  tracks: () => [],
  seqOn: () => false,
  playing: () => false,
  muted: () => false,
  activeSource: () => null,
  activeClipId: () => null,
  playbackRate: () => 1,
  timelineTime: () => 0,
  sourceTimeFor: () => null,
  externalSourceTimeFor: () => null,
  clipSourceTimeFor: () => 0,
});

class AudioEngineCore {
  constructor({ createContext = defaultCreateContext } = {}) {
    this._createContext = createContext;
    this._env = UNBOUND;
    this.ctx = null;
    this.master = null;
    this.analyser = null;
    this._anBuf = null;
    this._bufferClock = null;
  }

  /* 接上播放狀態的來源。

     【為什麼是 bind 而不是每次傳參數】
     transport 方法需要的東西——音軌清單、是不是序列模式、播放速率、
     時間域轉換函式——【全部】來自 Media，而且在整個播放期間都是同一組。
     以前是每次呼叫都推一次：scrubAudio 收 11 個參數（其中 3 個是回呼）、
     startElementSources 收 7 個。位置或名字寫錯時型別又都對得上
     （數字／布林／函式），會靜默跑出錯的行為。

     改成注入一次之後，呼叫端只需要傳「這一刻要做什麼」：
       startBuffers(offset) / startElements(localT, tlT) / scrub(at, duration)
     介面從 11 個參數縮到 2 個，而模組能做的事沒有變少——這就是深度。

     env 的每一項都是 getter（不是值），因為 Media 的狀態一直在變；
     存值會拿到 bind 當下的快照。 */
  bind(env) {
    this._env = { ...UNBOUND, ...(env || {}) };
    return this;
  }

  ensureCtx() {
    if (!this.ctx) {
      this.ctx = this._createContext();
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

  /* 電平表用的 analyser。wrapper 先前【沒有】這一支，於是呼叫端只好走
     `AudioEngine.context.createAnalyser()` 繞過去——封裝一旦不完整，
     呼叫端就會自己開洞，而那個洞會擴散（媒體來源與解碼也被順手繞過）。 */
  createAnalyser({ fftSize = 1024, smoothingTimeConstant = 0.3 } = {}) {
    this.ensureCtx();
    const an = this.ctx.createAnalyser();
    an.fftSize = fftSize;
    an.smoothingTimeConstant = smoothingTimeConstant;
    return an;
  }

  /* 接到主輸出。取代散在各處的 `node.connect(AudioEngine.master)`（13 處）——
     那要求呼叫端知道「主輸出叫 master 而且是個 GainNode」，等於把內部結構
     變成介面的一部分。 */
  connectToMaster(node) {
    this.ensureCtx();
    try { node.connect(this.master); } catch (e) {}
    return node;
  }

  /* 音訊圖建好了沒。取代散在各處的 `if(!AudioEngine.context) return`——
     呼叫端要問的是「能不能用」，不是「有沒有那個叫 context 的欄位」。 */
  get isReady() { return !!this.ctx; }

  /* 主輸出音量（靜音是 0）。取代 `AudioEngine.master.gain.value = …`。 */
  setMasterGain(value) {
    if (!this.master) return;
    this.master.gain.value = Math.max(0, Number(value) || 0);
  }

  /* ── transport：呼叫端只傳「這一刻要做什麼」 ────────────────────────────
     其餘（音軌、序列模式、播放速率、時間域轉換）由 bind() 注入的 env 提供。
     時間域見鐵律 §0.5：localT 是來源時間、tlT／at 是時間軸時間，不可互換。 */
  startBuffers(offset) {
    if (!this.ctx) return null;
    const env = this._env;
    const tracks = env.tracks();
    const playbackRate = env.playbackRate();
    let off = offset;
    if (env.seqOn()) {
      const lt = env.sourceTimeFor('video', env.timelineTime());
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
    this._bufferClock = { startCtxTime, startMediaTime: off };
    return { ...this._bufferClock };
  }

  stopBuffers() {
    for (const tr of this._env.tracks()) {
      if (tr.srcNode) {
        try { tr.srcNode.stop(); } catch (e) {}
        try { tr.srcNode.disconnect(); } catch (e) {}
        tr.srcNode = null;
      }
    }
    this._bufferClock = null;
  }

  /* buffer sources 沒有可讀的 currentTime；它們的播放時鐘必須由
     擁有 AudioContext 的同一個模組維護。currentMediaTime 是播放器內的來源時間
     （鐵律 §0.5）；間隙中影片時鐘停住，不可為了校正而誤啟動音訊。 */
  syncBuffers(currentMediaTime, { inGap = false } = {}) {
    if (!this.ctx || !this._bufferClock || inGap) return false;
    const current = Number(currentMediaTime);
    if (!Number.isFinite(current)) return false;
    const rate = this._env.playbackRate() || 1;
    const expected = this._bufferClock.startMediaTime
      + (this.ctx.currentTime - this._bufferClock.startCtxTime) * rate;
    if (Math.abs(expected - current) <= 0.25) return false;
    this.stopBuffers();
    this.startBuffers(current);
    return true;
  }

  /* localT＝目前 clip 的來源時間；tlT＝時間軸時間（ext-* 參考音用）。兩者不可互換，見 §0.5。 */
  startElements(localT, tlT) {
    const env = this._env;
    const seqOn = env.seqOn();
    const playbackRate = env.playbackRate();
    if (tlT === undefined) tlT = seqOn ? env.timelineTime() : localT;
    for (const tr of env.tracks()) {
      if (tr.kind !== 'element' || !tr.el) continue;
      if (tr._srcHidden) {
        try { tr.el.pause(); } catch (e) {}
        continue;
      }
      const s = tr.source || 'video';
      let off;
      if (s.startsWith('ext-')) {
        off = env.externalSourceTimeFor(s, tlT);
        if (off == null) {
          try { tr.el.pause(); } catch (e) {}
          continue;
        }
      } else if (seqOn) {
        const lt = env.sourceTimeFor(s, tlT);
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

  stopElements() {
    for (const tr of this._env.tracks()) {
      if (tr.kind === 'element' && tr.el) {
        try { tr.el.pause(); } catch (e) {}
      }
    }
  }

  /* at＝【時間軸時間】（鐵律 §0.5）。序列模式下才轉成來源時間。
     回傳 { scrubMainVideo, localT }：scrubMainVideo=true 代表沒有任何可聽的
     Web Audio 軌，呼叫端要改為 scrub 主 <video>。 */
  scrub(at, duration = 0.15) {
    const env = this._env;
    if (env.playing() || env.muted()) return;
    const tracks = env.tracks();
    const playbackRate = env.playbackRate();
    const activeSource = env.activeSource();
    const t = at;
    let localT = t;
    if (env.seqOn()) {
      const c = Seq.clipAt(t);
      if (!c || c.id !== env.activeClipId()) return;
      localT = env.clipSourceTimeFor(t, c);
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
          const off = source.startsWith('ext-') ? env.externalSourceTimeFor(source, t) : localT;
          if (off != null) {
            const rate = env.playbackRate();
            const preservesPitch = rate >= 0.25 && rate <= 4;
            scheduleScrub(tr.el, off, { rate, preservesPitch, isMuted: env.muted(), durationMs: duration * 1000 });
          }
        }
      }
    }
    return { scrubMainVideo: false, localT };
  }
}

/* 生產環境用的單例——呼叫端一律用這個。 */
export const AudioEngine = new AudioEngineCore();

/* 測試用的建構入口（內部接縫，見檔頭 defaultCreateContext 的註解）。
   生產程式碼【不應該】呼叫它：多個 AudioEngine 等於多個 AudioContext，
   而瀏覽器對同時存在的 AudioContext 數量有上限。 */
export function createAudioEngineForTest(deps) {
  return new AudioEngineCore(deps);
}
