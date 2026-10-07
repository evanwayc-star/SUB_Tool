import { waitForOwnedMediaMetadata } from './media-intake-engine.js';

/* 反轉的是片段範圍內的 PCM，不是播放器方向。音源準備只屬於 AudioEngine，
   每個聲道沿用原 gain／analyser；過期載入不得安裝到另一個專案或效果。 */
function reverseWindow(context, buffer, start, end, channel = null) {
  const rate = buffer.sampleRate;
  const count = Math.max(1, Math.round((end - start) * rate));
  const channels = channel == null ? buffer.numberOfChannels : 1;
  const reversed = context.createBuffer(channels, count, rate);
  const last = Math.round(end * rate) - 1;
  for (let ch = 0; ch < channels; ch++) {
    const source = buffer.getChannelData(channel == null ? ch : channel);
    const output = reversed.getChannelData(ch);
    for (let i = 0; i < count; i++) output[i] = source[last - i] || 0;
  }
  return reversed;
}

function wavBlob(buffer) {
  const channels = buffer.numberOfChannels, frames = buffer.length;
  const data = new ArrayBuffer(44 + frames * channels * 2), view = new DataView(data);
  const str = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); str(36, 'data');
  view.setUint32(40, data.byteLength - 44, true);
  const samples = Array.from({ length: channels }, (_, ch) => buffer.getChannelData(ch));
  for (let i = 0; i < frames; i++) for (let ch = 0; ch < channels; ch++) {
    const value = Math.max(-1, Math.min(1, samples[ch][i]));
    view.setInt16(44 + (i * channels + ch) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Blob([data], { type: 'audio/wav' });
}

export class ReverseAudioPlayback {
  constructor(context, {
    createAudio = () => new Audio(), createURL = blob => URL.createObjectURL(blob), revokeURL = url => URL.revokeObjectURL(url),
    disposeElement = () => {},
  } = {}) {
    this.context = context;
    this.createAudio = createAudio; this.createURL = createURL; this.revokeURL = revokeURL;
    this.disposeElement = disposeElement;
    this.entries = new Map();
  }

  prepare(track, { key, clip, start, end, load, owns = () => true }) {
    const previous = this.entries.get(track);
    if (previous?.key === key && previous.clip === clip && previous.owns() && owns()) return previous.pending;
    this.release(track);
    const entry = { key, clip, start, end, owns, controller: new AbortController(), ready: false };
    this.entries.set(track, entry);
    const current = () => this.entries.get(track) === entry && owns();
    entry.pending = (async () => {
      try {
        const loaded = track.kind === 'buffer' ? { buffer: track.buffer } : await load(entry.controller.signal);
        if (!current()) return false;
        if (loaded.buffer) {
          entry.buffer = reverseWindow(this.context, loaded.buffer, start, end, track.kind === 'buffer' ? null : loaded.channel || 0);
          if (track.kind === 'buffer') { entry.ready = true; return true; }
          entry.objectURL = this.createURL(wavBlob(entry.buffer));
        }
        const el = this.createAudio(); entry.el = el;
        el.preload = 'auto'; el.src = entry.objectURL || loaded.url;
        if (await waitForOwnedMediaMetadata(el, { owns: current, signal: entry.controller.signal }) !== 'ready' || !current()) return false;
        entry.node = this.context.createMediaElementSource(el);
        const channel = loaded.buffer ? 0 : loaded.channel || 0;
        entry.channel = channel;
        entry.splitter = this.context.createChannelSplitter(channel + 1);
        entry.node.connect(entry.splitter);
        entry.splitter.connect(track.gain, channel);
        if (track.analyser) entry.splitter.connect(track.analyser, channel);
        entry.ready = true;
        return true;
      } finally {
        if (!entry.ready || !current()) {
          this.dispose(entry);
          if (this.entries.get(track) === entry) this.entries.delete(track);
        }
      }
    })();
    return entry.pending;
  }

  get(track, playback) {
    const entry = this.entries.get(track);
    if (entry && !entry.owns()) { this.release(track); return null; }
    return playback?.reverse && entry?.ready && entry.clip === playback.clip
      && entry.start === playback.clip.in && entry.end === playback.clip.out ? entry : null;
  }

  stopTrack(track) { try { this.entries.get(track)?.el?.pause(); } catch (_) {} }
  stop() { for (const track of this.entries.keys()) this.stopTrack(track); }
  prune(tracks) {
    const live = new Set(tracks);
    for (const [track, entry] of this.entries) if (!live.has(track) || !entry.owns()) this.release(track);
  }
  dispose(entry) {
    entry.controller.abort();
    if (entry.el) this.disposeElement(entry.el);
    try { entry.el?.pause(); if (entry.el) { entry.el.src = ''; entry.el.load?.(); } } catch (_) {}
    try { entry.node?.disconnect(); entry.splitter?.disconnect(); } catch (_) {}
    if (entry.objectURL) { this.revokeURL(entry.objectURL); entry.objectURL = null; }
    entry.ready = false;
  }
  release(track) { const entry = this.entries.get(track); if (entry) { this.entries.delete(track); this.dispose(entry); } }
  clear() { for (const track of [...this.entries.keys()]) this.release(track); }
}
