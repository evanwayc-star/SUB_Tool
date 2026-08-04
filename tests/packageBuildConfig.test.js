import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('Windows 安裝檔設定', () => {
  it('預設採每台電腦安裝，讓正式程式落在 Program Files', () => {
    expect(packageJson.build.win.target).toBe('nsis');
    expect(packageJson.build.nsis.perMachine).toBe(true);
    expect(packageJson.build.nsis.allowToChangeInstallationDirectory).toBe(true);
  });

  it('發版前會檢查捷徑與解除安裝資訊沒有指向原始碼目錄', () => {
    expect(packageJson.scripts['release:verify-install']).toContain('verify-release-install.ps1');
  });

  it('既有 dist 指令明確維持 Windows x64，不會在 Mac 上產生未簽署的正式感產物', () => {
    expect(packageJson.scripts.predist).toContain('--platform win32 --arch x64');
    expect(packageJson.scripts.dist).toContain('electron-builder --win --x64');
  });

  it('Windows 產物只收 x64 原生工具，不夾帶 Mac build 留下的 arm64 檔', () => {
    expect(packageJson.build.win.files).toEqual([
      'dist/**/*',
      'shared/**/*.cjs',
      {
        from: 'electron',
        to: 'electron',
        filter: ['**/*', '!ffmpeg/**', '!mpv/**'],
      },
      {
        from: 'electron/ffmpeg',
        to: 'electron/ffmpeg',
        filter: ['ffmpeg.exe', 'ffprobe.exe'],
      },
      {
        from: 'electron/mpv',
        to: 'electron/mpv',
        filter: ['mpv.exe', 'd3dcompiler_43.dll'],
      },
    ]);
  });
});

describe('Apple Silicon 安裝檔設定', () => {
  it('同時產生 arm64 DMG 與 ZIP，供本機安裝驗收', () => {
    expect(packageJson.build.mac.target).toEqual([
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ]);
    expect(packageJson.build.mac.category).toBe('public.app-category.video');
  });

  it('Mac 產物只收 darwin-arm64 工具，不夾帶搬移資料夾中的 Windows exe/mpv', () => {
    expect(packageJson.build.files).toBeUndefined();
    expect(packageJson.build.mac.files).toEqual([
      'dist/**/*',
      'shared/**/*.cjs',
      {
        from: 'electron',
        to: 'electron',
        filter: ['**/*', '!ffmpeg/**', '!mpv/**'],
      },
      {
        from: 'electron/ffmpeg/darwin-arm64',
        to: 'electron/ffmpeg/darwin-arm64',
        filter: ['**/*'],
      },
    ]);
  });

  it('測試版建置會先準備靜態 arm64 工具，再明確要求 unsigned Mac target', () => {
    expect(packageJson.scripts['native:prepare:mac']).toBe(
      'node scripts/prepare-macos-native-binaries.js',
    );
    expect(packageJson.scripts['dist:mac:test']).toContain('npm run native:prepare:mac');
    expect(packageJson.scripts['dist:mac:test']).toContain('electron-builder --mac --arm64');
    expect(packageJson.scripts['dist:mac:test']).toContain('mac.identity=null');
    expect(packageJson.scripts['dist:mac']).toBeUndefined();
    expect(packageJson.devDependencies['ffmpeg-static']).toBe('5.3.0');
    expect(packageJson.devDependencies['@derhuerst/ffprobe-static']).toBe('5.3.0');
  });
});

/* shared/ 必須進安裝檔。

   主程序在啟動時就 `require('../shared/*.cjs')`（electron/channel-layout.js、
   electron/export-plan.js）。這個資料夾若沒被打包，開發機上完全正常——
   `npm run electron` 讀的是原始碼樹——但**安裝版一開就死**，而且是在
   任何 UI 出現之前。這正是 §0.6「有產出不等於對」與 v4.27 那次
   「打包後才壞」的形狀。

   這支測試守的是設定；真的有沒有進 asar 仍須 `npm run dist` 後實際安裝確認
   （AGENTS.md §4）。 */
describe('shared/ 跨行程共用模組的打包', () => {
  const SHARED = new URL('../shared/', import.meta.url);

  it('兩個平台的 files 都收了 shared/**/*.cjs', () => {
    expect(packageJson.build.win.files).toContain('shared/**/*.cjs');
    expect(packageJson.build.mac.files).toContain('shared/**/*.cjs');
  });

  it('shared/ 底下的實作一律是 .cjs（.js 會被 glob 漏掉而不進安裝檔）', () => {
    const stray = readdirSync(SHARED).filter(f => f.endsWith('.js'));
    // .md 之類的說明檔不算實作，不需要進安裝檔
    expect(stray, `這些檔案不會被 shared/**/*.cjs 收進安裝檔：${stray.join(', ')}`).toEqual([]);
  });

  /* shared/ 的每一支都必須零相依。
     eslint 擋得下 process／Buffer（沒給 node globals），但擋不下 require——
     `sourceType: 'commonjs'` 讓 require 成為已知全域。而這些檔案會被 Vite
     打包進 renderer，一旦 require 了 node 內建模組，**瀏覽器端才會爆**，
     桌面版完全正常。這條補上那個缺口。 */
  it('每一支 shared/*.cjs 都零相依（會被打包進 renderer，不可 require）', () => {
    const files = readdirSync(SHARED).filter(f => f.endsWith('.cjs'));
    expect(files.length, 'shared/ 是空的＝這條測試變成空轉').toBeGreaterThan(0);
    for (const name of files) {
      const src = readFileSync(new URL(name, SHARED), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src, `shared/${name} 不可 require 任何東西`).not.toMatch(/\brequire\s*\(/);
    }
  });
});
