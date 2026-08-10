import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
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
    const authority = makeAuthority();
    const project = 'E:\\Projects\\cut.subtool';

    authority.grantProjectFile(project);

    expect(authority.canRead(project)).toBe(true);
    expect(authority.canWriteProject(project)).toBe(true);
    expect(authority.canWriteProject('E:\\Projects\\other.subtool')).toBe(false);
    expect(authority.canWriteProject('E:\\Projects\\.subtool_AutoSave\\backup.subtool')).toBe(true);
    expect(authority.canRead('E:\\Projects\\private.txt')).toBe(false);
    expect(authority.canWriteDelivery(project)).toBe(false);
    expect(authority.canWriteDelivery('E:\\Projects\\master.mov')).toBe(false);
  });

  it('交付與截圖各自是受限能力，截圖暫存只加精確 read 不讀整個目錄', () => {
    const authority = makeAuthority();
    authority.grantDeliveryDirectory('F:\\Deliverables');
    authority.grantScreenshotDirectory('E:\\Projects');

    expect(authority.canWriteDelivery('F:\\Deliverables\\master.mov')).toBe(true);
    expect(authority.canWriteDelivery('F:\\Elsewhere\\master.mov')).toBe(false);
    expect(authority.canRevealDeliveryOutput('F:\\Deliverables\\master.mov')).toBe(false);
    authority.grantDeliveryFile('F:\\Deliverables\\master.mov');
    expect(authority.canRevealDeliveryOutput('F:\\Deliverables\\master.mov')).toBe(true);
    expect(authority.canRevealDeliveryOutput('F:\\Deliverables\\unrelated.exe')).toBe(false);
    expect(authority.canWriteScreenshot('E:\\Projects\\Shot-001.jpg')).toBe(true);
    expect(authority.canRead('E:\\Projects\\Shot-001.jpg')).toBe(false);
    expect(authority.grantTemporaryScreenshotRead('E:\\Projects\\.subtool_temp_shot.jpg')).toBe(true);
    expect(authority.canRead('E:\\Projects\\.subtool_temp_shot.jpg')).toBe(true);
    expect(authority.canRead('E:\\Projects\\private.jpg')).toBe(false);
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

  it('支援 SUB Tool UTF-16LE 與舊式 UTF-8 專案，讓可信開檔保留媒體重載流程', () => {
    const project = { media: { path: 'D:\\Media\\master.mxf' } };
    const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(JSON.stringify(project), 'utf16le')]);
    const utf16WithoutBom = Buffer.from(JSON.stringify(project), 'utf16le');
    const utf8 = Buffer.from(JSON.stringify(project), 'utf8');

    expect(collectProjectMediaPathsFromBuffer(utf16)).toEqual(['D:\\Media\\master.mxf']);
    expect(collectProjectMediaPathsFromBuffer(utf16WithoutBom)).toEqual(['D:\\Media\\master.mxf']);
    expect(collectProjectMediaPathsFromBuffer(utf8)).toEqual(['D:\\Media\\master.mxf']);
    expect(collectProjectMediaPathsFromBuffer(Buffer.from('{broken json'))).toEqual([]);
    expect(parseProjectBuffer(utf16)).toEqual(project);
    expect(parseProjectBuffer(Buffer.from('{broken json'))).toBeNull();
  });

  it('主程序的 file URL 與兩種截圖寫入都委派給同一個權威，而不是查詢時擴權', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
    const media = fs.readFileSync(path.join(ROOT, 'src', 'media.js'), 'utf8');
    const subio = fs.readFileSync(path.join(ROOT, 'src', 'subio.js'), 'utf8');

    expect(main).toMatch(/ipcMain\.handle\('fs:fileURL',[\s\S]{0,180}fileAuthority\.canExposeFileURL/);
    expect(main).not.toMatch(/ipcMain\.handle\('fs:fileURL',[\s\S]{0,180}allowFileDir/);
    expect(main).toMatch(/ipcMain\.handle\('fs:writeScreenshot',[\s\S]{0,180}fileAuthority\.canWriteScreenshot/);
    expect(main).toMatch(/ipcMain\.handle\('mpv:screenshot',[\s\S]{0,180}fileAuthority\.canWriteScreenshot/);
    expect(main).toMatch(/ipcMain\.handle\('mpv:launch',[\s\S]{0,180}requireReadablePath\('mpv:launch', src\)/);
    expect(main).toMatch(/cache clear source blocked/);
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
