/* 專案媒體復原的完成語意。由 ProjectLoadSession 持有；不另建全域 owner。
   adapter 負責實際媒體 I/O，本 module 負責完成順序、未解素材與 stale 清理。
   不等待一般背景 Proxy／人聲工作；只等待既有 pending placement/freeze 復原。 */
export class ProjectMediaRestoration {
  #baselinedPlans = new WeakSet();
  #begunPlans = new WeakMap();
  #positionedPlans = new WeakSet();

  constructor({ media, desktop = false, stat = null, normalizeExternalSources = sources => sources,
    publishExternalSources = () => {}, beginProject = () => null, finishProject = () => {}, report = () => {} } = {}) {
    this.media = media;
    this.desktop = desktop;
    this.stat = stat;
    this.normalizeExternalSources = normalizeExternalSources;
    this.publishExternalSources = publishExternalSources;
    this.beginProject = beginProject;
    this.finishProject = finishProject;
    this.report = report;
  }

  // 新開啟尚未取代目前文件時，保留其已建立的 History／定位進度。
  // 只交接資料與完成紀錄；舊 restore 的 owns 與進行中的 I/O 不會被重用。
  inheritPlanProgress(previous, next) {
    if (this.#begunPlans.has(previous)) this.#begunPlans.set(next, this.#begunPlans.get(previous));
    if (this.#baselinedPlans.has(previous)) this.#baselinedPlans.add(next);
    if (this.#positionedPlans.has(previous)) this.#positionedPlans.add(next);
  }

  async restore(plan, request, owns) {
    if (!owns()) return false;
    const { kind = 'images', path = null } = request;
    if (!['load', 'ready', 'images', 'deferred', 'audio'].includes(kind)) throw new TypeError('unknown project media restore kind');
    if (kind === 'load' && (typeof path !== 'string' || !path)) throw new TypeError('project primary media path is required');
    // 文件已顯示，使用者從第一個 await 起就能編輯；初始基準必須先建立。
    if (!this.#begunPlans.has(plan)) this.#begunPlans.set(plan, this.beginProject());
    const stage = async (name, work) => {
      if (!owns()) return false;
      try { await work(); }
      catch (error) { if (owns()) this.report(name, error); }
      return owns();
    };
    let ownsInitialTarget = this.media.capturePlaybackTargetOwnership?.() || (() => true);
    let restoredImages = 0;

    // 主素材載入會 reset runtime，必須先於所有外部音訊。load 完成不等於
    // placement 完成：pending restore 還包含圖片與可重建的固定幀 PNG。
    if (kind === 'load' && !await stage('load project media', () => {
      const loading = this.media.loadDesktopMedia(path, plan);
      // 真 loader 在第一個 await 前同步 reset。從 reset 後捕獲，才能區分
      // 素材初始化與使用者在 probe／placement／音訊等待期間較新的定位。
      ownsInitialTarget = this.media.capturePlaybackTargetOwnership?.() || (() => true);
      return loading;
    })) return false;
    if ((kind === 'load' || kind === 'ready')
      && !await stage('restore project clips', () => this.media.waitForPendingProjectRestore?.())) return false;
    if (kind === 'images'
      && !await stage('restore pending image clips', async () => {
        const result = await this.media.restorePendingImageClips?.(plan);
        restoredImages = result?.restored || 0;
      })) return false;

    // deferred 只建立已還原文件的基準；原媒體找不到或 browser 尚未選 File
    // 時，不消耗 playhead，也不搶先啟動將被後續 primary reset 清掉的音訊。
    if (kind !== 'deferred' && !await this.#restoreAudio(plan, owns)) return false;
    if (!owns()) return false;
    if (kind !== 'deferred' && kind !== 'audio' && !this.#positionedPlans.has(plan)) {
      const playhead = plan.peekPlayhead();
      const hasVisual = this.media.seqOn?.() || restoredImages > 0;
      if (!ownsInitialTarget()) {
        // 使用者已選了更新的位置；後續 ready／重連不能再套回舊的初始位置。
        this.#positionedPlans.add(plan);
      } else if (Number.isFinite(playhead) || hasVisual) {
        this.#positionedPlans.add(plan);
        // FPS-SYNC: 仍由 Media 的既有 presentation/seek owner 處理時間軸目標。
        // 未保存播放點時取時間軸 0，包含裁切、開頭間隙及圖片，不直接 seek 母素材 0。
        // 保留非同步 completion policy；只有實際呈現且仍屬原 plan／seek 才消耗保存值。
        try {
          const presenting = this.media.seek(Number.isFinite(playhead) ? Math.max(0, playhead) : 0);
          const ownsPresentation = this.media.capturePlaybackTargetOwnership?.() || (() => true);
          Promise.resolve(presenting).then(result => {
            if (!owns() || !ownsPresentation() || plan.peekPlayhead() !== playhead) return;
            if (result?.status === 'presented') plan.clearPlayhead();
          }).catch(error => { if (owns() && ownsPresentation()) this.report('restore project playhead', error); });
        }
        catch (error) { this.report('restore project playhead', error); }
      }
    }
    if (!owns()) return false;
    // deferred 已建立文件的初始基準後，找回媒體是同一個專案的 continuation。
    // Media 的 projectReady/rebase 處理新增 placements；不能再次 reset History
    // 或把等待期間使用者的編輯標成已保存。browser File relink 也遵守同一政策。
    if (!this.#baselinedPlans.has(plan)) {
      this.finishProject(this.#begunPlans.get(plan));
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
