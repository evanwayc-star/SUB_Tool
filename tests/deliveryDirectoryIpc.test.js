import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function bridge(authority, io = fs) {
  const source = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const statement = ast.body.find(node => node.type === 'ExpressionStatement'
    && node.expression?.callee?.object?.name === 'ipcMain'
    && node.expression.callee.property?.name === 'handle'
    && node.expression.arguments[0]?.value === 'fs:listDir');
  expect(statement).toBeDefined();
  let handler, api;
  vm.runInNewContext(source.slice(statement.start, statement.end), {
    ipcMain: { handle: (channel, fn) => { handler = fn; } }, fileAuthority: authority, fs: io,
    console: { warn() {} }, Error,
  });
  vm.runInNewContext(fs.readFileSync(path.resolve('electron/preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, exposed) => { if (name === 'subtool') api = exposed; } },
      ipcRenderer: { invoke: (channel, ...args) => Promise.resolve().then(() => handler({}, ...args)), on() {}, send() {} }, webUtils: {} }),
    ArrayBuffer, Uint8Array, Promise, TypeError, RangeError,
  });
  return api;
}

describe('交付目錄檢查 IPC 契約', () => {
  it('真實空目錄與已有檔案保持陣列結果', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-list-ipc-')); roots.push(root);
    const authority = new FileAuthority(); authority.grantDeliveryDirectory(root);
    const api = bridge(authority);
    expect(Array.from(await api.listDir(root))).toEqual([]);
    fs.writeFileSync(path.join(root, 'existing.mp4'), 'existing content');
    expect(Array.from(await api.listDir(root))).toEqual(['existing.mp4']);
  });

  it('目錄失去授權後不得把未知內容回報成空清單', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-list-ipc-')); roots.push(root);
    const authority = new FileAuthority(); const api = bridge(authority);
    await expect(api.listDir(root)).rejects.toThrow(/無法檢查交付資料夾/);
  });

  it('已授權但檔案系統讀取失敗時回傳錯誤，不能視為空清單', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-list-ipc-')); roots.push(root);
    const authority = new FileAuthority(); authority.grantDeliveryDirectory(root);
    const io = { ...fs, readdirSync() { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); } };
    await expect(bridge(authority, io).listDir(root)).rejects.toThrow(/無法檢查交付資料夾/);
  });

  it('列舉時目錄被換成 junction，不把過期結果當作有效清單', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-list-ipc-')); roots.push(root);
    const selected = path.join(root, 'selected'), outside = path.join(root, 'outside');
    fs.mkdirSync(selected); fs.mkdirSync(outside);
    const authority = new FileAuthority(); authority.grantDeliveryDirectory(selected);
    const io = { ...fs, readdirSync(directory) {
      const old = fs.readdirSync(directory);
      fs.renameSync(selected, path.join(root, 'original'));
      fs.symlinkSync(outside, selected, process.platform === 'win32' ? 'junction' : 'dir');
      return old;
    } };
    await expect(bridge(authority, io).listDir(selected)).rejects.toThrow(/無法檢查交付資料夾/);
  });
});
