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
  onImagePointer(cb) {}
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
  onImagePointer(cb) { this.mpv?.onImagePointer?.(cb); }
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
