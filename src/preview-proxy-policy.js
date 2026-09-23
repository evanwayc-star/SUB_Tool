// 大型 Canopus HQ AVI 已是逐格獨立編碼，單片 mpv 預覽不需先重編整片 Proxy。
// 待使用者加入第二支影片、需要疊層合成時才建立 Proxy。
const LARGE_CANOPUS_AVI_BYTES = 8 * 1024 ** 3;

export function isLargeCanopusAvi({ codec, extension, size } = {}) {
  return String(extension).toLowerCase() === 'avi'
    && String(codec).toLowerCase() === 'hq_hqa'
    && Number(size) >= LARGE_CANOPUS_AVI_BYTES;
}

export function autoBuildPreviewProxy(source) {
  return !isLargeCanopusAvi(source);
}
