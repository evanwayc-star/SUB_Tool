/* npm run dist 之前的內建執行檔核對（scripts/verify-native-binaries.ps1）。

   electron/ffmpeg/ 與 electron/mpv/ 合計約 538 MB，刻意不進版控（.gitignore）。
   package.json 的 asarUnpack 明列這四個路徑要被打進安裝檔，但 electron-builder
   對「asarUnpack 沒 match 到任何檔案」是靜默的——npm run dist 對這件事完全不會
   報錯，產物只是單純少了 ffmpeg 或 mpv。detect()（electron/main.js）找不到內建
   版時會靜靜退回系統 PATH，使用者不會看到任何錯誤訊息。這正是 AGENTS.md §0.6
   「有產出不等於對」的形狀，只是發生在發版流程而不是程式邏輯。

   這裡跟 tests/packageBuildConfig.test.js 對 release:verify-install 的做法不同：
   那邊只斷言「script 字串裡有這個檔名」，腳本整支換掉測試照樣綠。這裡真的執行
   腳本、真的餵它缺檔/殘檔的情境，斷言退出碼與訊息內容。 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-native-binaries.ps1');

function run(repoRoot) {
  return spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-RepositoryRoot', repoRoot],
    { encoding: 'utf8', windowsHide: true });
}

/* 腳本本身只做檔案系統檢查，沒有任何 Windows 專屬語法，但 CI（.github/workflows/ci.yml）
   跑在 ubuntu-latest。比照 tests/electronQueueLifecycle.test.js 既有的 describeElectron
   慣例：真的執行外部程序的測試只在 win32 本機跑，其餘平台整組略過而不是假裝通過。 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;

describeOnWindows('verify-native-binaries.ps1：真的執行，不只比對字串', () => {
  it('對目前真實的 repo 執行會通過（本機已放好 ffmpeg/mpv）', () => {
    const r = run(ROOT);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('核對通過');
  });

  it('四個檔案全缺時，失敗且逐一點名', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'verify-native-empty-'));
    try {
      const r = run(empty);
      expect(r.status).not.toBe(0);
      for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'mpv.exe', 'd3dcompiler_43.dll']) {
        expect(r.stderr, `訊息裡應該點名 ${name}`).toContain(name);
      }
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
      const r = run(dir);
      expect(r.status).not.toBe(0);
      expect(r.stderr, '應點名 ffmpeg.exe 太小').toContain('損毀或未下載完整');
      expect(r.stderr, '應同時點名完全沒放的 ffprobe').toContain('ffprobe.exe');
      expect(r.stderr, '應同時點名完全沒放的 mpv').toContain('mpv.exe');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('package.json：predist 有接上這支腳本', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  it('npm run dist 之前一定會先跑 verify-native-binaries.ps1', () => {
    expect(pkg.scripts.predist).toContain('verify-native-binaries.ps1');
  });

  /* npm 對「pre<script>」的自動掛勾只認腳本名稱字面相符，asarUnpack 涵蓋的四個
     路徑改了名字或搬了位置卻沒同步這裡，這條防線就會安靜地失效。 */
  it('腳本檢查的四個路徑與 package.json 的 asarUnpack 一致', () => {
    const scriptSrc = readFileSync(SCRIPT, 'utf8');
    const nativeUnpackPaths = pkg.build.asarUnpack.filter(p => /ffmpeg|mpv/.test(p));
    expect(nativeUnpackPaths).toEqual(['electron/mpv/**', 'electron/ffmpeg/**']);
    for (const dir of ['ffmpeg', 'mpv']) {
      expect(scriptSrc).toContain(`electron\\${dir}\\`);
    }
  });
});
