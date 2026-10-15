// @subtool-ci windows
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'win32')('Windows 網頁啟動器的失敗結果', () => {
  function launch(name, failAt, installed = false) {
    const dir = mkdtempSync(join(tmpdir(), 'subtool-web-launcher-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'launch.bat'), readFileSync(new URL(`../${name}`, import.meta.url)));
    writeFileSync(join(dir, 'npm.cmd'), `@echo off\r\necho %*>>"%~dp0calls.txt"\r\nif "%*"=="${failAt}" exit /b 73\r\nexit /b 0\r\n`);
    if (installed) mkdirSync(join(dir, 'node_modules'));
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'launch.bat'], {
      cwd: dir, input: '', encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PATH: `${dir};${process.env.PATH}` }, timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(existsSync(join(dir, 'calls.txt')), result.stdout + result.stderr).toBe(true);
    return { ...result, calls: readFileSync(join(dir, 'calls.txt'), 'utf8').trim().split(/\r?\n/u) };
  }

  it.each(['啟動網頁版.bat', '啟動網頁開發版.bat'])('%s 安裝失敗後不啟動後續工作且回傳失敗', name => {
    const result = launch(name, 'install');
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual(['install']);
    expect(result.stdout).toContain('[ERROR] npm install failed.');
  });

  it('建置失敗不打開舊的網頁產物且回傳失敗', () => {
    const result = launch('啟動網頁版.bat', 'run build', true);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual(['run build']);
    expect(result.stdout).toContain('[ERROR] build failed');
    expect(result.stdout).not.toContain('Done.');
  });

  it('開發伺服器失敗不被 pause 覆蓋成成功', () => {
    const result = launch('啟動網頁開發版.bat', 'run dev', true);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual(['run dev']);
    expect(result.stdout).toContain('[ERROR] dev server failed');
  });
});
