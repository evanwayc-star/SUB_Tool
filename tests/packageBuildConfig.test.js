import { readFileSync } from 'node:fs';
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
