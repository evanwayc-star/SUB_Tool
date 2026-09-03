/* 截圖的存放位置與檔名規則。

   這些規則以前住在 app.js 的 takeScreenshot() 裡。app.js 是組裝根，
   全專案唯一不可被其他模組 import 的檔案，所以住在那裡的東西
   **結構上就測不到**——搬出來之後才有這支測試。 */
import { describe, expect, it } from 'vitest';
import { fallbackScreenshotName, screenshotDir, timecodeSuffix } from '../src/commands.js';

describe('時間碼後綴', () => {
  it('冒號換成連字號（Windows 檔名不允許冒號）', () => {
    expect(timecodeSuffix('01:23:45:06')).toBe('_01-23-45-06');
  });

  it('drop-frame 的分號也要換掉', () => {
    expect(timecodeSuffix('01:23:45;06')).toBe('_01-23-45-06');
  });

  it('沒有要求時間碼時回空字串', () => {
    expect(timecodeSuffix('')).toBe('');
    expect(timecodeSuffix(null)).toBe('');
    expect(timecodeSuffix(undefined)).toBe('');
  });
});

describe('存放目錄', () => {
  it('優先使用專案檔所在目錄', () => {
    expect(screenshotDir({ projectDir: 'D:\\專案\\', mediaPath: 'E:\\素材\\a.mxf' }))
      .toBe('D:\\專案');
  });

  it('沒有專案檔時退回母素材所在目錄', () => {
    expect(screenshotDir({ projectDir: null, mediaPath: 'E:\\素材\\a.mxf' }))
      .toBe('E:\\素材');
  });

  it('正斜線路徑也要處理', () => {
    expect(screenshotDir({ projectDir: null, mediaPath: 'E:/素材/a.mxf' }))
      .toBe('E:/素材');
  });

  it('結尾的分隔符一律去掉，避免接檔名時變成雙分隔符', () => {
    expect(screenshotDir({ projectDir: 'D:\\專案\\\\' })).toBe('D:\\專案');
    expect(screenshotDir({ projectDir: 'D:/專案///' })).toBe('D:/專案');
  });

  it('兩者都沒有時回 null（網頁版或未存檔的空白專案）', () => {
    expect(screenshotDir({ projectDir: null, mediaPath: null })).toBeNull();
    expect(screenshotDir({})).toBeNull();
  });

  it('母素材沒有目錄部分時不會誤切出空字串', () => {
    expect(screenshotDir({ projectDir: null, mediaPath: 'a.mxf' })).toBeNull();
  });
});

describe('瀏覽器 fallback 檔名', () => {
  it('以播放點的整秒命名', () => {
    expect(fallbackScreenshotName(12.9)).toBe('Shot-12.jpg');
  });

  it('帶時間碼後綴', () => {
    expect(fallbackScreenshotName(12.9, '_01-23-45-06')).toBe('Shot-12_01-23-45-06.jpg');
  });

  it('負數與非數字都夾成 0，不會產生 Shot-NaN.jpg', () => {
    expect(fallbackScreenshotName(-5)).toBe('Shot-0.jpg');
    expect(fallbackScreenshotName(undefined)).toBe('Shot-0.jpg');
    expect(fallbackScreenshotName('壞值')).toBe('Shot-0.jpg');
  });
});
