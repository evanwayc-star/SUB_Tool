import { State, normalizeAudioProject, ensureAudioSourceMap } from './state.js';
import { sourceChannelDescriptors } from './external-audio.js';
import { emit } from './events.js';

class AudioPipelineManager {
  constructor() {
    this.adapters = new Set();
  }
  
  registerAdapter(adapter) {
    this.adapters.add(adapter);
    if (adapter.sync) {
      adapter.sync(this.project());
    }
  }
  
  project() {
    State.audioProject = normalizeAudioProject(State.audioProject);
    return State.audioProject;
  }
  
  registerSource(clip, channels, fallbackCount=0) {
    if(!clip) return [];
    const sourceId = clip.audioSourceId || clip.audioSrc || null;
    if(!sourceId) return [];
    const descriptors = sourceChannelDescriptors(channels, fallbackCount);
    ensureAudioSourceMap(sourceId, descriptors);
    if(typeof window !== 'undefined' && window.Wave) {
      window.Wave.registerSourceWaveforms(clip, {channels: Array.isArray(channels)&&channels.length ? channels : descriptors});
    }
    return descriptors;
  }

  sourceDescriptorFor(clip, channel, index=0) {
    const sourceId = clip?.audioSourceId || clip?.audioSrc || null;
    return {
      audioSourceId: sourceId,
      sourceStream: Math.max(0, Math.floor(Number(channel?.sourceStream ?? 0) || 0)),
      sourceChannel: Math.max(0, Math.floor(Number(channel?.sourceChannel ?? index) || 0))
    };
  }

  
  notifyAdapters() {
    const proj = this.project();
    for (const adapter of this.adapters) {
      if (adapter.sync) adapter.sync(proj);
    }
    emit('audio:pipelineUpdated', proj);
  }

  // Gets the FFmpeg command line arguments required to map inputs to outputs
  // based on the current AudioProject routing configuration.
  buildExportArgs(deliverableIndex, deliverables, options) {
    const proj = this.project();
    let ffmpegAdapter = Array.from(this.adapters).find(a => a.name === 'FFmpegAdapter');
    if (!ffmpegAdapter) return null;
    return ffmpegAdapter.buildArgs(proj, deliverableIndex, deliverables, options);
  }
}

export const AudioPipeline = new AudioPipelineManager();
