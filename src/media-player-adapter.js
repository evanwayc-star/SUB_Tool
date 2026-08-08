// media-player-adapter.js
// Adapter pattern：將播放器操作抽象為統一介面。
// MpvAdapter 封裝桌面版 mpv IPC，Html5Adapter 封裝 <video> 元素，
// BaseMediaPlayerAdapter 是所有方法都是 no-op 的基底類別。

export class BaseMediaPlayerAdapter {
  constructor() {}
  get type() { return 'base'; }
  get isAvailable() { return true; }
  async subSet(assStr) { return Promise.resolve(); }
  async subVisible(v) { return Promise.resolve(); }
  async show(v) { return Promise.resolve(); }
  async setGuide(data) { return Promise.resolve(); }
  async setImageGuide(data) { return Promise.resolve(); }
  async screenshot(path) { return Promise.resolve(); }
  async setTimecodeWatermark(payload) { return Promise.resolve(); }
  async detect() { return Promise.resolve(); }
  async setBounds(bounds) { return Promise.resolve(); }
  async launch(opts) { return Promise.resolve(); }
  onEvent(cb) {}
  async mute(m) { return Promise.resolve(); }
  brightness(b) {}
  async pause() { return Promise.resolve(); }
  async play() { return Promise.resolve(); }
  async loadfile(path) { return Promise.resolve(); }
  async seek(t) { return Promise.resolve(); }
  async rate(r) { return Promise.resolve(); }
  async quit() { return Promise.resolve(); }
}

export class Html5Adapter extends BaseMediaPlayerAdapter {
  constructor(videoEl) {
    super();
    this._video = videoEl;
  }
  get type() { return 'html5'; }
  async play() { 
    try { 
      const result = this._video.play(); 
      if (result?.catch) result.catch(()=>{});
      return result;
    } catch(e) {} 
  }
  async pause() { try { this._video.pause(); } catch(e) {} }
  async seek(t) { try { this._video.currentTime = t; } catch(e) {} }
  async rate(r) { 
    try { 
      this._video.playbackRate = r; 
      if('preservesPitch' in this._video) this._video.preservesPitch = (r >= 0.25 && r <= 4); 
    } catch(e) {} 
  }
}

export class MpvAdapter extends BaseMediaPlayerAdapter {
  constructor(desk) {
    super();
    this.desk = desk;
    this.mpv = desk?.mpv;
  }
  get type() { return 'mpv'; }
  get isAvailable() { return !!this.mpv; }
  async subSet(assStr) { return this.mpv?.subSet(assStr).catch(()=>{}); }
  async subVisible(v) { return this.mpv?.subVisible?.(v).catch(()=>{}); }
  async show(v) { return this.mpv?.show(v).catch(()=>{}); }
  async setGuide(data) { return this.mpv?.setGuide?.(data).catch(()=>{}); }
  async setImageGuide(data) { return this.mpv?.setImageGuide(data).catch(()=>{}); }
  async screenshot(path) { return this.mpv?.screenshot(path); }
  async setTimecodeWatermark(payload) { return this.mpv?.setTimecodeWatermark(payload); }
  async detect() { return this.mpv?.detect(); }
  async setBounds(bounds) { return this.mpv?.setBounds(bounds).catch(()=>{}); }
  async launch(opts) { return this.mpv?.launch(opts); }
  onEvent(cb) { this.mpv?.onEvent(cb); }
  async mute(m) { return this.mpv?.mute(m).catch(()=>{}); }
  brightness(b) { try{ this.mpv?.brightness(b); }catch(e){} }
  async pause() { return this.mpv?.pause?.().catch(()=>{}); }
  async play() { return this.mpv?.play?.().catch(()=>{}); }
  async loadfile(path) { return this.mpv?.loadfile(path); }
  async seek(t) { return this.mpv?.seek(t).catch(()=>{}); }
  async rate(r) { return this.mpv?.rate(r).catch(()=>{}); }
  async quit() { return this.mpv?.quit().catch(()=>{}); }
}

let activeAdapter = null;

export function getPlayerAdapter() {
  if (!activeAdapter) activeAdapter = new MpvAdapter(window.subtool);
  return activeAdapter;
}

export function resetPlayerAdapter(desk) {
  activeAdapter = new MpvAdapter(desk);
}

export function setPlayerAdapter(adapter) {
  activeAdapter = adapter;
}

/* ── 這裡曾有 WebCodecsAdapter ─────────────────────────────────────────────
   一個把 base adapter 全部轉呼叫的 decorator：39 個方法逐一 `return this.base.X(…)`，
   唯一自己做事的是 setCompositing()，而它做的三件事在唯一的呼叫端
   （decode/player.js `_setTakeover`）緊接著又原樣做了一次。

   更關鍵的是它在生產環境【從未存在】：
     - 9 個 setPlayerAdapter() 呼叫點全部裝 `new Html5Adapter(video)` 或
       `new MpvAdapter(window.subtool)`，把 wrapper 整個換掉；
     - 唯一會產生它的 resetPlayerAdapter() 只有測試在呼叫。
   於是任何媒體載入之後 getPlayerAdapter().setCompositing 都是 undefined，
   呼叫時丟 TypeError，被 app.js 的 `try{ WCPreview.tick(); }catch(e){}` 吞掉；
   下游讀 isCompositing 拿到 undefined，mpvPresenting() 因此永遠回 true。
   它的 `window.dispatchEvent(new CustomEvent('mpv:sync'))` 也是死的——
   'mpv:sync' 的唯一訂閱者在 events.js 的匯流排上，不是 window。

   合成旗標已搬回它該在的地方（Media._wcTakeover，公開入口
   webCodecsTakeover() / setWebCodecsTakeover()，正是 eslint 圍籬點名的那組）。
   ── 若日後真的需要一個 decorator，先確認它會被【裝上】：
      兩個 adapter 才是真接縫，零個不是。 */
