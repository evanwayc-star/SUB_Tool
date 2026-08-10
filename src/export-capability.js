const WEB_VIDEO_EXPORT_MESSAGE = '網頁版不支援影片／多聲道 WAV 交付，請使用 Electron 桌面版';

export function videoExportCapability(isDesktop) {
  return isDesktop
    ? Object.freeze({ supported: true, message: '' })
    : Object.freeze({ supported: false, message: WEB_VIDEO_EXPORT_MESSAGE });
}

export async function runVideoExportCommand({
  isDesktop,
  openExport,
  notify = () => {},
  reportError = () => {},
} = {}) {
  const capability = videoExportCapability(isDesktop);
  if (!capability.supported) {
    notify(capability.message);
    return false;
  }
  try {
    await openExport();
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export { WEB_VIDEO_EXPORT_MESSAGE };
