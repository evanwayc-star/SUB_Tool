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
});
