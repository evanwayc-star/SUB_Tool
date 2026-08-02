/* ==============================================================================
   SUB Tool — 母素材載入工作階段（Media Intake Session）
   ==============================================================================
   使用者可以在 stat／probe／ingest／Audio metadata 尚未完成時立刻換檔。每個 await
   後都必須確認結果仍屬於目前的載入，否則舊素材會把新素材的播放器、片段與音軌覆寫。

   本模組不認識 State、Media、DOM 或 Electron；它只負責工作所有權與暫存 Audio
   元素生命週期。實際 I/O 與 Audio 建立函式由呼叫端注入，因此可直接做競態測試。
============================================================================== */

function disposeAudioElements(elements){
  for (const element of (Array.isArray(elements) ? elements : [])) {
    if (!element) continue;
    try { element.pause?.(); } catch { /* 已失效的 element 不影響清理 */ }
    try { element.src = ''; } catch { /* 同上 */ }
  }
}

function waitForMetadata(element, timeoutMs){
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(element);
    };
    const timer = setTimeout(finish, timeoutMs);
    element.onloadedmetadata = finish;
    element.onerror = finish;
    if (element.readyState >= 1) finish();
  });
}

class MediaIntakeSession {
  constructor(){
    this.generation = 0;
    this.current = null;
    this._exclusiveTail = Promise.resolve();
  }

  begin(identity = null){
    const token = Object.freeze({ generation: ++this.generation, identity });
    this.current = token;
    return token;
  }

  invalidate(){
    this.generation++;
    this.current = null;
  }

  owns(token){
    return !!token && this.current === token && token.generation === this.generation;
  }

  /* mpv 等共享播放器不能同時 launch。新工作仍須排在舊 launch（含失去 ownership
     後的清理）之後，否則兩個 IPC handler 會交錯改寫同一組 native process/window。 */
  queueExclusive(work){
    const run = () => work();
    const result = this._exclusiveTail.then(run, run);
    this._exclusiveTail = result.then(() => undefined, () => undefined);
    return result;
  }

  runExclusive(token, work){
    return this.queueExclusive(() => this.owns(token) ? work() : null);
  }

  /* resolveFileURL 與 createAudio 都是 system boundary。owns 可換成素材仍存在、
     clip 尚未刪除等其他 ownership predicate，讓所有逐聲道 materialization 共用
     同一套「晚到即清理」規則。回傳 null 表示工作已失去所有權。 */
  async materializeAudioElements(channels, {
    token = null,
    owns = token ? () => this.owns(token) : () => true,
    resolveFileURL,
    createAudio,
    timeoutMs = 10000,
  } = {}){
    const list = Array.isArray(channels) ? channels : [];
    if (!owns()) return null;
    /* Promise.all 會在第一個 URL 失敗時立刻 reject，其他聲道已建立的元素因而無人
       清理。把每條結果收成 outcome，等全部 settle 後統一釋放，再拋回原始錯誤。 */
    const outcomes = await Promise.all(list.map(async channel => {
      try {
        const url = await resolveFileURL(channel.file);
        if (!owns()) return { element: null, error: null };
        const element = createAudio();
        element.src = url;
        element.preload = 'auto';
        return { element: await waitForMetadata(element, timeoutMs), error: null };
      } catch (error) {
        return { element: null, error };
      }
    }));
    const elements = outcomes.map(outcome => outcome.element);
    const failure = outcomes.find(outcome => outcome.error)?.error;
    if (failure || !owns()) {
      disposeAudioElements(elements);
      if (failure) throw failure;
      return null;
    }
    return elements;
  }
}

export { MediaIntakeSession };
