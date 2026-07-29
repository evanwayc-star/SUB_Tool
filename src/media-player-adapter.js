// media-player-adapter.js
// Adapter pattern to abstract away the direct usage of MPV and Desktop IPC.
// Future WebCodecs or alternative players will implement this interface.

class MediaPlayerAdapter {
  constructor(desk) {
    this.desk = desk;
    this.mpv = desk?.mpv;
  }
  
  get isAvailable() { return !!this.mpv; }
  
  // UI & Overlay
  async subSet(assStr) { return this.mpv?.subSet(assStr).catch(()=>{}); }
  async subVisible(v) { return this.mpv?.subVisible?.(v).catch(()=>{}); }
  async show(v) { return this.mpv?.show(v).catch(()=>{}); }
  async setGuide(data) { return this.mpv?.setGuide?.(data).catch(()=>{}); }
  async setImageGuide(data) { return this.mpv?.setImageGuide(data).catch(()=>{}); }
  onImagePointer(cb) { this.mpv?.onImagePointer?.(cb); }
  async screenshot(path) { return this.mpv?.screenshot(path); }
  async setTimecodeWatermark(payload) { return this.mpv?.setTimecodeWatermark(payload); }
  
  // Core Playback
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
  if (!activeAdapter) activeAdapter = new MediaPlayerAdapter(window.subtool);
  return activeAdapter;
}

export function resetPlayerAdapter(desk) {
  activeAdapter = new MediaPlayerAdapter(desk);
}
