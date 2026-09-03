/* ==============================================================================
   SUB Tool — Audio Routing & Layout Engine ("src/audio-routing-engine.js")
   ==============================================================================
   深層音訊路由拓撲、聲道佈局與串流引擎 (Audio Routing Engine)。
   嚴格守護鐵律 §0.8（素材聲道／專案總線／匯出串流三者分離）：
   1. 來源聲道展開與標籤生成 (flattenSourceChannels / channelFileName / sourceChannelLabels)
   2. 匯出音訊 Stream 聲道佈局修復器 (OUTPUT_LAYOUT_WIDTH / repairAudioExportStreams)
   3. 媒體播放音訊路由協調器 (MediaAudioRouter)
   ============================================================================== */

import { flattenSourceChannels, channelFileName } from '../shared/channel-layout.cjs';
import { AudioEngine } from './audio-engine.js';
import { Seq } from './sequence.js';
import { scheduleScrub } from './audio-engine.js';

export { flattenSourceChannels, channelFileName };

/**
 * 取得展開後各聲道於 UI 介面上的繁體中文顯示標籤清單。
 */
export function sourceChannelLabels(audio) {
  return flattenSourceChannels(audio).map(c => `聲道${c.index + 1}`);
}

/** 各聲道佈局名稱與所需聲道數寬度對應表 */
export const OUTPUT_LAYOUT_WIDTH = Object.freeze({
  mono: 1,
  stereo: 2,
  stereoLtRt: 2,
  '5.1': 6,
});

/**
 * 檢查並修復音訊匯出 Stream 清單中的佈局配置。
 */
export function repairAudioExportStreams(rawStreams) {
  const streams = Array.isArray(rawStreams) ? rawStreams : [];
  const reservedIds = new Set(streams.map(stream => stream?.id).filter(Boolean));
  const emittedIds = new Set();

  const uniqueGeneratedId = base => {
    let index = 1;
    let id = `${base}-mono-${index}`;
    while (reservedIds.has(id) || emittedIds.has(id)) {
      id = `${base}-mono-${++index}`;
    }
    emittedIds.add(id);
    return id;
  };

  const withoutMisleadingName = stream => {
    const { name, ...rest } = stream || {};
    return rest;
  };

  const repaired = [];
  for (const stream of streams) {
    const busIds = Array.isArray(stream?.busIds) ? stream.busIds : [];
    if (!busIds.length) continue;

    const expected = OUTPUT_LAYOUT_WIDTH[stream?.layout];
    if (expected === busIds.length) {
      repaired.push(stream);
      if (stream.id) emittedIds.add(stream.id);
      continue;
    }

    const base = withoutMisleadingName(stream);
    if (busIds.length === 1) {
      repaired.push({ ...base, layout: 'mono', busIds: [busIds[0]] });
      if (base.id) emittedIds.add(base.id);
      continue;
    }

    if (busIds.length === 2) {
      repaired.push({ ...base, layout: 'stereo', busIds: busIds.slice() });
      if (base.id) emittedIds.add(base.id);
      continue;
    }

    busIds.forEach((busId, index) => {
      const id = index === 0 && base.id ? base.id : uniqueGeneratedId(base.id || 'out');
      emittedIds.add(id);
      repaired.push({ ...base, id, layout: 'mono', busIds: [busId] });
    });
  }

  return repaired;
}

export class MediaAudioRouter {
  constructor(media, video, stateObj) {
    this.media = media;
    this.video = video;
    this.state = stateObj;
    this._audioEngineBound = false;
  }

  bindEngine() {
    if (this._audioEngineBound) return;
    this._audioEngineBound = true;
    AudioEngine.bind({
      tracks: () => this.media.tracks,
      seqOn: () => this.media.seqOn(),
      playing: () => this.media.playing,
      muted: () => this.state.muted,
      activeSource: () => this.media.activeSource,
      activeClipId: () => this.media.activeClipId,
      playbackRate: () => this.video.playbackRate || 1,
      timelineTime: () => this.media.tlTime(),
      sourceTimeFor: (s, t) => this.media._srcLocalT(s, t),
      externalSourceTimeFor: (s, t) => this.media.externalAudio.sourceTime(s, t),
      clipSourceTimeFor: (t, c) => this.media._transport.sourceTime(t, c),
    });
  }

  ensureCtx() {
    this.bindEngine();
    return AudioEngine.ensureCtx();
  }

  startElementSources(localT, tlT) {
    AudioEngine.startElements(localT, tlT);
  }

  stopElementSources() {
    AudioEngine.stopElements();
  }

  restartElements() {
    if (!this.media.playing) return;
    const c = this.media.seqOn() ? this.media._activeClip() : null;
    const tl = this.media.tlTime();
    this.startElementSources(c ? Seq.toSource(tl, c) : this.media.vTime(), tl);
  }

  startBufferSources(offset) {
    AudioEngine.startBuffers(offset);
  }

  stopBufferSources() {
    AudioEngine.stopBuffers();
  }

  scrubAudio(t, duration = 0.15) {
    const res = AudioEngine.scrub(t, duration);
    if (res && res.scrubMainVideo) {
      if (!this.video.src) return;
      const rate = this.video.playbackRate || 1;
      const preservesPitch = rate >= 0.25 && rate <= 4;
      scheduleScrub(this.video, res.localT, {
        rate,
        preservesPitch,
        isMuted: this.state.muted,
        durationMs: duration * 1000,
      });
    }
  }

  syncDrift() {
    // 呈現切換期間，video/mpv 的來源時間仍可能停在舊畫格。若拿這個停止的
    // clock 校正元素／buffer 音訊，會把同一小段聲音反覆拉回播放。
    if (this.media.presenterClockMoving?.() === false) return;
    if (this.media.tracks.some(t => t.kind === 'buffer' && !t._srcHidden)) {
      AudioEngine.syncBuffers(this.media.vTime(), { inGap: this.media.inGap() });
    }
    for (const tr of this.media.tracks) {
      if (tr.kind === 'element' && tr.el && !tr.el.paused) {
        const s = tr.source || '';
        let ref;
        if (s.startsWith('ext-')) {
          const st = this.media.externalAudio?.sourceTime?.(s, this.media.tlTime());
          if (st == null) {
            try { tr.el.pause(); } catch (e) {}
            continue;
          }
          ref = st;
        } else if (this.media.seqOn()) {
          const lt = this.media.sourceLocalTime(s || 'video', this.media.tlTime());
          if (lt == null) continue;
          ref = lt;
        } else {
          ref = this.media.vTime();
        }

        if (Math.abs(tr.el.currentTime - ref) > 0.12) {
          try { tr.el.currentTime = ref; } catch (e) {}
        }
      }
    }
  }
}
