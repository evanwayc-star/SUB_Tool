/* 播放器全螢幕只管理瀏覽器 Fullscreen API 與雙擊手勢；
   影片、字幕、圖片與 mpv bounds 仍由各自既有的 renderer/runtime 負責。 */
export function bindPlayerFullscreen({
  element,
  documentTarget = typeof document !== 'undefined' ? document : null,
  onChange = () => {},
  onError = error => console.warn('[player] 無法切換全螢幕：', error),
} = {}) {
  if (!element?.addEventListener || !documentTarget?.addEventListener) {
    throw new TypeError('播放器全螢幕需要有效的 element 與 document');
  }

  let transition = Promise.resolve();

  const isActive = () => documentTarget.fullscreenElement === element;

  function toggle() {
    const operation = async () => {
      if (documentTarget.fullscreenElement) {
        if (typeof documentTarget.exitFullscreen !== 'function') return false;
        await documentTarget.exitFullscreen();
        return false;
      }
      if (typeof element.requestFullscreen !== 'function') return false;
      await element.requestFullscreen();
      return true;
    };
    const result = transition.then(operation, operation);
    transition = result.then(() => undefined, () => undefined);
    return result;
  }

  function handleDoubleClick(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    void toggle().catch(onError);
  }

  function handleFullscreenChange() {
    onChange(isActive());
  }

  element.addEventListener('dblclick', handleDoubleClick);
  documentTarget.addEventListener('fullscreenchange', handleFullscreenChange);

  return {
    isActive,
    toggle,
    dispose() {
      element.removeEventListener('dblclick', handleDoubleClick);
      documentTarget.removeEventListener('fullscreenchange', handleFullscreenChange);
    },
  };
}
