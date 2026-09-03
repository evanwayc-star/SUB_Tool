/* npm run dist 之前的內建執行檔核對（scripts/release/verify-native-binaries.js）。

   electron/ffmpeg/ 與 electron/mpv/ 合計約 538 MB，刻意不進版控（.gitignore）。
   package.json 的 asarUnpack 明列這四個路徑要被打進安裝檔，但 electron-builder
   對「asarUnpack 沒 match 到任何檔案」是靜默的——npm run dist 對這件事完全不會
   報錯，產物只是單純少了 ffmpeg 或 mpv。detectNativeTool() 找不到內建
   版時會退回系統 PATH。這正是 AGENTS.md §0.6
   「有產出不等於對」的形狀，只是發生在發版流程而不是程式邏輯。

   這裡跟 tests/packageBuildConfig.test.js 對 release:verify-install 的做法不同：
   那邊只斷言「script 字串裡有這個檔名」，腳本整支換掉測試照樣綠。這裡真的執行
   腳本、真的餵它缺檔/殘檔的情境，斷言退出碼與訊息內容。 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_SCRIPT = path.join(ROOT, 'scripts', 'release', 'verify-native-binaries.js');
const require = createRequire(import.meta.url);
const { bundledNativeRequirements } = require('../electron/ffmpeg-execution-engine.js');

function run(repoRoot, platform, arch) {
  return spawnSync(process.execPath, [
    NODE_SCRIPT,
    '--repository-root', repoRoot,
    '--platform', platform,
    '--arch', arch,
  ], { encoding: 'utf8', windowsHide: true });
}

/* 只有「核對目前工作機的忽略檔」需要限 Windows；模擬平台的缺檔/殘檔案例可在 CI 執行。 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;

describe('跨平台原生執行檔核對', () => {
  it('darwin-arm64 缺檔時只要求 ffmpeg/ffprobe，不誤列 Windows mpv', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'verify-native-mac-empty-'));
    try {
      const r = run(empty, 'darwin', 'arm64');

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('electron/ffmpeg/darwin-arm64/ffmpeg');
      expect(r.stderr).toContain('electron/ffmpeg/darwin-arm64/ffprobe');
      expect(r.stderr).not.toContain('mpv');
      expect(r.stderr).not.toContain('.exe');
      expect(r.stderr).toContain('npm run native:prepare:mac');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('四個檔案全缺時，失敗且逐一點名', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'verify-native-empty-'));
    try {
      const r = run(empty, 'win32', 'x64');
      expect(r.status).not.toBe(0);
      for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'mpv.exe', 'd3dcompiler_43.dll']) {
        expect(r.stderr, `訊息裡應該點名 ${name}`).toContain(name);
      }
      expect(r.stderr).toContain('docs/Electron_維護手冊.md');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  /* 下載中斷的殘檔比「完全沒有」更危險——目錄結構看起來對，內容是壞的。
     這條驗證「太小」與「缺少」兩種訊息會同時、正確地分開回報。 */
  it('檔案存在但明顯是下載中斷的殘檔（低於門檻大小）也會被擋下', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'verify-native-truncated-'));
    try {
      mkdirSync(path.join(dir, 'electron', 'ffmpeg'), { recursive: true });
      writeFileSync(path.join(dir, 'electron', 'ffmpeg', 'ffmpeg.exe'), Buffer.alloc(1024));
      const r = run(dir, 'win32', 'x64');
      expect(r.status).not.toBe(0);
      expect(r.stderr, '應點名 ffmpeg.exe 太小').toContain('損毀或未下載完整');
      expect(r.stderr, '應同時點名完全沒放的 ffprobe').toContain('ffprobe.exe');
      expect(r.stderr, '應同時點名完全沒放的 mpv').toContain('mpv.exe');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeOnWindows('本機 Windows 原生執行檔', () => {
  it('對目前真實的 repo 執行會通過（本機已放好 ffmpeg/mpv）', () => {
    const r = run(ROOT, 'win32', process.arch);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('核對通過');
  });
});

describe('package.json：predist 有接上這支腳本', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  it('npm run dist 之前使用跨平台 Node 腳本，不依賴 PowerShell', () => {
    expect(pkg.scripts.predist).toContain('node scripts/release/verify-native-binaries.js');
    expect(pkg.scripts.predist).not.toContain('powershell');
  });

  /* asarUnpack 或需求清單搬了位置卻沒同步，electron-builder 仍可能靜默產出缺功能的包。 */
  it('Windows 與 macOS 的原生需求都落在 package.json 的 asarUnpack 內', () => {
    const nativeUnpackPaths = pkg.build.asarUnpack.filter(p => /ffmpeg|mpv/.test(p));
    const requirements = [
      ...bundledNativeRequirements({ platform: 'win32', arch: 'x64' }),
      ...bundledNativeRequirements({ platform: 'darwin', arch: 'arm64' }),
    ];

    expect(nativeUnpackPaths).toEqual(['electron/mpv/**', 'electron/ffmpeg/**']);
    for (const requirement of requirements) {
      expect(
        nativeUnpackPaths.some(pattern => requirement.relativePath.startsWith(pattern.slice(0, -2))),
        `${requirement.relativePath} 必須被 asarUnpack 涵蓋`,
      ).toBe(true);
    }
  });
});
