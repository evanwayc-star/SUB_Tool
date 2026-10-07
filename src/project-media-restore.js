/* 專案媒體復原的完成語意。由 ProjectLoadSession 持有；不另建全域 owner。
   adapter 負責實際媒體 I/O，本 module 負責完成順序、未解素材與 stale 清理。
   不等待一般背景 Proxy／人聲工作；只等待既有 pending placement/freeze 復原。 */
export class ProjectMediaRestoration {
  #baselinedPlans = new WeakSet();

  constructor({ media, desktop = false, stat = null, normalizeExternalSources = sources => sources,
    publishExternalSources = () => {}, finishProject = () => {}, report = () => {} } = {}) {
    this.media = media;
    this.desktop = desktop;
    this.stat = stat;
    this.normalizeExternalSources = normalizeExternalSources;
    this.publishExternalSources = publishExternalSources;
    this.finishProject = finishProject;
    this.report = report;
  }

  async restore(plan, request, owns) {
    if (!owns()) return false;
    const { kind = 'images', path = null } = request;
    if (!['load', 'ready', 'images', 'deferred', 'audio'].includes(kind)) throw new TypeError('unknown project media restore kind');
    if (kind === 'load' && (typeof path !== 'string' || !path)) throw new TypeError('project primary media path is required');
    const stage = async (name, work) => {
      if (!owns()) return false;
      try { await work(); }
      catch (error) { if (owns()) this.report(name, error); }
      return owns();
    };

    // 主素材載入會 reset runtime，必須先於所有外部音訊。load 完成不等於
    // placement 完成：pending restore 還包含圖片與可重建的固定幀 PNG。
    if (kind === 'load' && !await stage('load project media', () => this.media.loadDesktopMedia(path, plan))) return false;
    if ((kind === 'load' || kind === 'ready')
      && !await stage('restore project clips', () => this.media.waitForPendingProjectRestore?.())) return false;
    if (kind === 'images'
      && !await stage('restore pending image clips', () => this.media.restorePendingImageClips?.(plan))) return false;

    // deferred 只建立已還原文件的基準；原媒體找不到或 browser 尚未選 File
    // 時，不消耗 playhead，也不搶先啟動將被後續 primary reset 清掉的音訊。
    if (kind !== 'deferred' && !await this.#restoreAudio(plan, owns)) return false;
    if (!owns()) return false;
    if (kind !== 'deferred' && kind !== 'audio') {
      const playhead = plan.peekPlayhead();
      if (Number.isFinite(playhead)) {
        // FPS-SYNC: 仍由 Media 的既有 presentation/seek owner 處理時間軸目標。
        try { this.media.seek(Math.max(0, playhead)); plan.clearPlayhead(); }
        catch (error) { this.report('restore project playhead', error); }
      }
    }
    if (!owns()) return false;
    // deferred 已建立文件的初始基準後，找回媒體是同一個專案的 continuation。
    // Media 的 projectReady/rebase 處理新增 placements；不能再次 reset History
    // 或把等待期間使用者的編輯標成已保存。browser File relink 也遵守同一政策。
    if (!this.#baselinedPlans.has(plan)) {
      this.finishProject();
      this.#baselinedPlans.add(plan);
    }
    return true;
  }

  async #restoreAudio(plan, owns) {
    const pending = this.normalizeExternalSources(plan.pendingExternalAudioSources());
    if (!pending.length) { plan.replaceExternalAudioSources([]); return owns(); }
    if (!this.desktop || typeof this.media.restoreExternalAudioSource !== 'function') return owns();

    const list = () => {
      try { return this.media.externalAudio?.list?.() || []; }
      catch (_) { return []; }
    };
    const existing = new Set(list().map(source => source?.audioSourceId).filter(Boolean).map(String));
    const unresolved = [];
    for (const source of pending) {
      if (!owns()) return false;
      if (existing.has(source.audioSourceId)) continue;
      if (!source.path) { unresolved.push(source); continue; }
      let exists = true;
      if (this.stat) {
        try { exists = !!(await this.stat(source.path))?.exists; }
        catch (_) { exists = false; }
      }
      if (!owns()) return false;
      if (!exists) { this.report('external audio source is unavailable', null, source.path); unresolved.push(source); continue; }
      try {
        const asset = await this.media.restoreExternalAudioSource({ ...source, _restore: true }, null, owns);
        if (!owns()) {
          // 只能撤銷本次回傳的實體；同 id 的新專案 asset 不能被舊工作刪除。
          if (asset && this.media.externalAudioSources?.includes(asset)) this.media.removeExternalAudio?.(asset.id, { record: false });
          return false;
        }
        if (asset) existing.add(source.audioSourceId);
        else unresolved.push(source);
      } catch (error) {
        if (!owns()) return false;
        this.report('restore external audio source', error, source.path);
        unresolved.push(source);
      }
    }
    if (!owns()) return false;
    plan.replaceExternalAudioSources(unresolved);
    const live = list();
    if (!owns()) return false;
    // 未解來源保留自己的 timeline metadata，後續存檔與重新連結不會截短它。
    this.publishExternalSources([...(Array.isArray(live) ? live : []), ...unresolved]);
    return true;
  }
}
