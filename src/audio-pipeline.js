/* ==============================================================================
   SUB Tool — 素材聲道登錄（"src/audio-pipeline.js"）
   ==============================================================================
   把某個素材的來源聲道對應登錄進專案的 audio source map。
   只做這件事——**這裡不是音訊路由的規則所在**，規則在 `project-audio.js`
   （母素材聲道 Solo/Mute、bus 路由、placement gain 的唯一來源，見鐵律 §0.8）。

   【v6.1.2 移除了一個零 adapter 的接縫】
   本模組原本帶有一整套 adapter 註冊機制：`registerAdapter()`／`notifyAdapters()`／
   `buildExportArgs()`，外加 `emit('audio:pipelineUpdated')`。全部**零呼叫點**：
     - `registerAdapter` 從未被呼叫，所以 `adapters` 永遠是空集合；
     - `notifyAdapters` 從未被呼叫，`audio:pipelineUpdated` 因此從未被發送
       （即使發送了也沒有訂閱者）；
     - `buildExportArgs` 尋找 `a.name === 'FFmpegAdapter'`，而**全 repo 沒有
       任何東西叫這個名字**，所以它只會回 null。
   唯一存在過的 adapter（`audio-adapter-web.js`）從未被任何檔案 import，
   以 `null` 建構，且守衛 `this.media.ctx`——那個欄位在同一批重構裡就被搬進
   `AudioEngine` 了。整支檔案是死碼，已一併刪除。

   接縫的判準是「有沒有東西真的在那裡變化」：一個 adapter 是假設性接縫，
   兩個才是真接縫。這裡連一個都沒有。
============================================================================== */
import { ensureAudioSourceMap } from './state.js';
import { sourceChannelDescriptors } from './external-audio.js';

class AudioPipelineManager {
  /**
   * 登錄某素材的來源聲道，回傳正規化後的 descriptor 陣列。
   * @param {object} clip 素材（需有 audioSourceId 或 audioSrc）
   * @param {Array} channels ffprobe／ingest 得到的聲道清單
   * @param {number} fallbackCount channels 為空時的聲道數推測值
   */
  registerSource(clip, channels, fallbackCount = 0) {
    if (!clip) return [];
    const sourceId = clip.audioSourceId || clip.audioSrc || null;
    if (!sourceId) return [];
    const descriptors = sourceChannelDescriptors(channels, fallbackCount);
    ensureAudioSourceMap(sourceId, descriptors);
    /* 這裡原本還有一段 `if (window.Wave) window.Wave.registerSourceWaveforms(...)`。
       `Wave` 掛的是 `window.SUB.Wave`（app.js），**沒有** `window.Wave`，
       所以那段從未執行過。波形登錄實際發生在 media.js 內部
       （Wave.registerSourceWaveforms 的四個呼叫點），不需要這條旁路。 */
    return descriptors;
  }

  /** 由聲道 descriptor 導出 track 上的來源座標（audioSourceId / sourceStream / sourceChannel）。 */
  sourceDescriptorFor(clip, channel, index = 0) {
    const sourceId = clip?.audioSourceId || clip?.audioSrc || null;
    return {
      audioSourceId: sourceId,
      sourceStream: Math.max(0, Math.floor(Number(channel?.sourceStream ?? 0) || 0)),
      sourceChannel: Math.max(0, Math.floor(Number(channel?.sourceChannel ?? index) || 0)),
    };
  }

  /**
   * 取得專案音訊總線之標準化串流佈局。
   * @param {object} audioProject 專案音訊物件（可選，預設讀取 State.audioProject）
   */
  getStreamLayout(audioProject = null) {
    const proj = audioProject || null;
    return proj?.exportLayout?.streams || [];
  }
}

export const AudioPipeline = new AudioPipelineManager();
