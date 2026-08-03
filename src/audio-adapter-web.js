import { AudioPipeline } from './audio-pipeline.js';
import { getPlayerAdapter } from './media-player-adapter.js';

class WebAudioAdapter {
  constructor(mediaEngine) {
    this.name = 'WebAudioAdapter';
    this.media = mediaEngine; // Ref to media.js instance for now
    this.gainNodes = new Map();
  }

  sync(project) {
    // When the pipeline updates, we need to rebuild the WebAudio graph
    if (!this.media || !this.media.ctx) return;
    
    // In a full refactor, this adapter would manage the AudioContext entirely.
    // For now, we delegate back to media.js to recreate the tracks 
    // to maintain compatibility with the UI.
    if (this.media.hasMix()) {
      this.media.applyGains();
      // Ensure UI is notified
      if (typeof window !== 'undefined') {
        const evt = new CustomEvent('audio:graphRebuilt', { detail: project });
        window.dispatchEvent(evt);
      }
    }
  }
}

export const webAudioAdapter = new WebAudioAdapter(null);
