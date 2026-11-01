import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { FileAuthority, collectProjectMediaPaths, collectProjectMediaPathsFromBuffer, parseProjectBuffer } = require('../electron/file-authority.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const makeAuthority = () => new FileAuthority({
  pathModule: path.win32,
  internalDirectories: ['C:\\SUB Tool\\cache', 'C:\\Temp\\subtool_cache'],
});

describe('FileAuthority', () => {
  it('只讓內部快取根及其子項目讀寫，不接受相同前綴的旁支路徑', () => {
    const authority = makeAuthority();

    expect(authority.canRead('C:\\SUB Tool\\cache\\wave.wav')).toBe(true);
    expect(authority.canWrite('C:\\Temp\\subtool_cache\\shot.jpg')).toBe(true);
    expect(authority.canManageInternalFile('C:\\Temp\\subtool_cache\\shot.jpg')).toBe(true);
    expect(authority.canRead('C:\\SUB Tool\\cache-copy\\secret.txt')).toBe(false);
    expect(authority.canWrite('C:\\Users\\Evan\\Desktop\\secret.txt')).toBe(false);
    expect(authority.canManageInternalFile('C:\\Users\\Evan\\Desktop\\secret.txt')).toBe(false);
  });

  it('只由可信對話框授予資料夾時，才讓該資料夾中的檔案可存取', () => {
    const authority = makeAuthority();
    const rendererChosenPath = 'D:\\Untrusted\\movie.mov';

    // fs:fileURL 之類的純查詢不可以把 renderer 傳入路徑變成新的授權根。
    expect(authority.canExposeFileURL(rendererChosenPath)).toBe(false);
    expect(authority.canRead(rendererChosenPath)).toBe(false);

    authority.grantTrustedDirectory('D:\\Media');
    expect(authority.canExposeFileURL('D:\\Media\\movie.mov')).toBe(true);
    expect(authority.canRead('D:\\Media-archive\\movie.mov')).toBe(false);
  });

  it('專案內已宣告的外部媒體只取得單一檔案的唯讀能力，不會連帶授權同目錄其他檔案', () => {
    const authority = makeAuthority();
    authority.grantTrustedFile('E:\\Archive\\episode-01.mxf');

    expect(authority.canRead('E:\\Archive\\episode-01.mxf')).toBe(true);
    expect(authority.canRead('E:\\Archive\\private-notes.txt')).toBe(false);
    expect(authority.canWrite('E:\\Archive\\episode-01.mxf')).toBe(false);
  });

  it('專案檔只可寫回自身與 autosave 子目錄，不能成為同層交付覆寫權', () => {
    const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-project-grant-'));
    try {
      const authority = new FileAuthority();
      const project = path.join(directory,'cut.subtool');
      expect(authority.grantProjectFile(project)).toBe(true);
      expect(authority.canRead(project)).toBe(true);
      expect(authority.canWriteProject(project)).toBe(true);
      expect(authority.canWriteProject(path.join(directory,'other.subtool'))).toBe(false);
      expect(authority.canWriteProject(path.join(directory,'.subtool_AutoSave','backup.subtool'))).toBe(true);
      expect(authority.canRead(path.join(directory,'private.txt'))).toBe(false);
      expect(authority.canWriteDelivery(project)).toBe(false);
      expect(authority.canWriteDelivery(path.join(directory,'master.mov'))).toBe(false);
    } finally {
      const actual=fs.realpathSync(directory);
      if(path.dirname(actual)!==fs.realpathSync(os.tmpdir())||!path.basename(actual).startsWith('subtool-project-grant-')) throw new Error('拒絕清理不屬於測試的目錄');
      fs.rmSync(actual,{recursive:true,force:true});
    }
  });

  it('交付與截圖各自是受限能力，截圖暫存只加精確 read 不讀整個目錄', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-delivery-grant-'));
    try {
      const authority = new FileAuthority(), delivery = new FileAuthority(), outPath = path.join(directory, 'master.mov');
      expect(authority.grantScreenshotDirectory(directory)).toBe(true);
      delivery.grantDeliveryDirectory(directory);
      expect(delivery.canWriteDelivery(outPath)).toBe(true);
      expect(delivery.canWriteDelivery(path.join(directory, '..', 'elsewhere.mov'))).toBe(false);
      expect(delivery.canRevealDeliveryOutput(outPath)).toBe(false);
      delivery.grantDeliveryFile(outPath);
      expect(delivery.canRevealDeliveryOutput(outPath)).toBe(true);
      expect(delivery.canRevealDeliveryOutput(path.join(directory, 'unrelated.exe'))).toBe(false);
      expect(authority.canWriteScreenshot(path.join(directory, 'Shot-001.jpg'))).toBe(true);
      expect(authority.canRead(path.join(directory, 'Shot-001.jpg'))).toBe(false);
      expect(authority.grantTemporaryScreenshotRead(path.join(directory, '.subtool_temp_shot.jpg'))).toBe(true);
      expect(authority.canRead(path.join(directory, '.subtool_temp_shot.jpg'))).toBe(true);
      expect(authority.canRead(path.join(directory, 'private.jpg'))).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('系統開啟只接受受控佇列 log，不把 queue 的其他內部檔案交給 shell', () => {
    const authority = makeAuthority();
    authority.grantQueueLogDirectory('C:\\SUB Tool\\profile\\export-queue');

    expect(authority.canOpenQueueLog('C:\\SUB Tool\\profile\\export-queue\\export-a.log')).toBe(true);
    expect(authority.canOpenQueueLog('C:\\SUB Tool\\profile\\export-queue\\export-a.json')).toBe(false);
    expect(authority.canOpenQueueLog('C:\\SUB Tool\\profile\\export-queue-copy\\export-a.log')).toBe(false);
  });

  it('主程序產生的旁置快取可個別升格為內部檔案，無須授權整個媒體資料夾', () => {
    const authority = makeAuthority();
    authority.grantTrustedFile('E:\\Archive\\episode-01.mxf');

    expect(authority.canExposeFileURL('E:\\Archive\\.subtool_Cache\\abc\\proxy.mp4')).toBe(false);
    authority.grantManagedCacheDirectory('E:\\Archive\\.subtool_Cache\\abc');
    expect(authority.canExposeFileURL('E:\\Archive\\.subtool_Cache\\abc\\proxy.mp4')).toBe(true);
    expect(authority.canManageInternalFile('E:\\Archive\\.subtool_Cache\\abc\\proxy.mp4')).toBe(true);
    expect(authority.canRead('E:\\Archive\\private-notes.txt')).toBe(false);
  });

  it('主程序保留的診斷只授精確 log 開啟能力，不授同目錄、read 或 write', () => {
    const authority = makeAuthority();
    const file = 'C:\\SUB Tool\\profile\\export-owned.log';
    expect(authority.grantDiagnosticLogFile(file)).toBe(true);
    expect(authority.canOpenQueueLog(file)).toBe(true);
    expect(authority.canOpenQueueLog('C:\\SUB Tool\\profile\\export-other.log')).toBe(false);
    expect(authority.canRead(file)).toBe(false);
    expect(authority.canWrite(file)).toBe(false);
    expect(authority.grantDiagnosticLogFile('C:\\SUB Tool\\profile\\program.exe')).toBe(false);
    expect(authority.grantDiagnosticLogFile(null)).toBe(false);
    expect(authority.canOpenQueueLog('C:\\SUB Tool\\profile\\program.exe')).toBe(false);
  });

  it('專案與截圖寫入同時需要副檔名和既有寫入授權', () => {
    const authority = makeAuthority();
    authority.grantTrustedDirectory('F:\\Deliverables');

    expect(authority.canWriteProject('F:\\Deliverables\\edit.subtool')).toBe(true);
    expect(authority.canWriteProject('F:\\Deliverables\\edit.txt')).toBe(false);
    expect(authority.canWriteScreenshot('F:\\Deliverables\\Shot-001.jpg')).toBe(true);
    expect(authority.canWriteScreenshot('F:\\Deliverables\\Shot-001.exe')).toBe(false);
    expect(authority.canWriteScreenshot('G:\\Elsewhere\\Shot-001.png')).toBe(false);
  });

  it('從使用者選取的專案只收集宣告的媒體檔，供主程序授予精確唯讀能力', () => {
    const paths = collectProjectMediaPaths({
      media: { path: 'D:\\Media\\master.mxf' },
      clips: [
        { path: 'D:\\Media\\master.mxf' },
        { path: 'E:\\B-roll\\shot-01.mov' },
        { path: null },
      ],
      externalAudioSources: [
        { path: 'F:\\Audio\\voice.wav' },
        { path: 'E:\\B-roll\\shot-01.mov' },
      ],
      cues: [{ text: 'C:\\Users\\Evan\\secret.txt' }],
    });

    expect(paths).toEqual([
      'D:\\Media\\master.mxf',
      'E:\\B-roll\\shot-01.mov',
      'F:\\Audio\\voice.wav',
    ]);
  });

  it('容忍專案中非陣列的 clip/audio 欄位，不把舊專案形狀錯誤變成主程序例外', () => {
    expect(collectProjectMediaPaths({
      media: { path: 'D:\\Media\\master.mxf' },
      clips: {},
      externalAudioSources: 'legacy',
    })).toEqual(['D:\\Media\\master.mxf']);
  });

  it('UTF-8 與兩種 UTF-16 位元序含／不含 BOM 都保留專案文字及精確媒體路徑', () => {
    const project = { media: { path: 'D:\\素材\\𠮷😀.mxf' }, cues: [{ text: '繁體字幕𠮷😀' }] };
    const json = JSON.stringify(project);
    const utf16LE = Buffer.from(json, 'utf16le');
    const utf16BE = Buffer.from(utf16LE).swap16();
    const utf8 = Buffer.from(json, 'utf8');
    for (const bytes of [utf8, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), utf8]),
      utf16LE, Buffer.concat([Buffer.from([0xFF, 0xFE]), utf16LE]),
      utf16BE, Buffer.concat([Buffer.from([0xFE, 0xFF]), utf16BE])]) {
      const storage = Buffer.concat([Buffer.from('before'), bytes, Buffer.from('after')]);
      const view = storage.subarray(6, 6 + bytes.length);
      expect(collectProjectMediaPathsFromBuffer(view)).toEqual(['D:\\素材\\𠮷😀.mxf']);
      expect(parseProjectBuffer(view)).toEqual(project);
    }
    expect(collectProjectMediaPathsFromBuffer(Buffer.from('{broken json'))).toEqual([]);
    expect(parseProjectBuffer(Buffer.from('{broken json'))).toBeNull();
  });

  it('主程序的 file URL 與兩種截圖寫入都委派給同一個權威，而不是查詢時擴權', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    const localResource = fs.readFileSync(path.join(ROOT, 'electron', 'local-resource.js'), 'utf8');
    const screenshotOutput = fs.readFileSync(path.join(ROOT, 'electron', 'screenshot-output.js'), 'utf8');
    const mediaIntakeRuntime = fs.readFileSync(path.join(ROOT, 'electron', 'media-intake-runtime.js'), 'utf8');
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
    const media = fs.readFileSync(path.join(ROOT, 'src', 'media.js'), 'utf8');
    const subio = fs.readFileSync(path.join(ROOT, 'src', 'subio.js'), 'utf8');

    expect(main).toMatch(/ipcMain\.handle\('fs:fileURL',[\s\S]{0,180}localResourceServer\.urlFor/);
    expect(main).not.toMatch(/ipcMain\.handle\('fs:fileURL',[\s\S]{0,180}allowFileDir/);
    expect(localResource).toMatch(/urlFor\(file\)[\s\S]{0,180}fileAuthority\.canExposeFileURL/);
    expect(main).toMatch(/createScreenshotOutput\(\{ fileAuthority, tempDir: TMP \}\)/);
    expect(main).toMatch(/ipcMain\.handle\('fs:writeScreenshot',[\s\S]{0,180}screenshotOutput\.write/);
    expect(screenshotOutput).toMatch(/function write\(file, b64\)[\s\S]{0,180}fileAuthority\.canWriteScreenshot/);
    expect(main).toMatch(/ipcMain\.handle\('mpv:screenshot',[\s\S]{0,180}fileAuthority\.canWriteScreenshot/);
    expect(main).toMatch(/ipcMain\.handle\('mpv:launch',[\s\S]{0,180}requireReadablePath\('mpv:launch', src\)/);
    expect(main).toMatch(/cache:clearAll[\s\S]{0,180}mediaIntakeRuntime\.clearAll/);
    expect(mediaIntakeRuntime).toMatch(/currentSrc && fileAuthority\.canRead\(currentSrc\)/);
    expect(mediaIntakeRuntime).toMatch(/cache clear source blocked/);
    expect(main).toMatch(/QueueManager\.assertJobCapabilities\(\{ payload: authorizationPayload \}\)/);
    expect(main).toMatch(/fileAuthority\.canWriteDelivery/);
    expect(main).toMatch(/app:openPath[\s\S]{0,180}requirePermittedShellOpenPath/);
    expect(main).toMatch(/app:showItemInFolder[\s\S]{0,180}requirePermittedDeliveryRevealPath/);
    expect(main).toMatch(/expectedExportExtension\(format\)/);
    expect(preload).toMatch(/authorizeDroppedFile:\s*\(file\)[\s\S]{0,180}webUtils\.getPathForFile\(file\)/);
    expect(subio).toMatch(/await DESK\.authorizeDroppedFile\(f\)/);
    expect(media).toMatch(/async addImageDesktop[\s\S]{0,360}DESK\?\.fileURL/);
    expect(media).not.toMatch(/async addImageDesktop[\s\S]{0,600}url = 'file:\/\/\//);
  });
});
