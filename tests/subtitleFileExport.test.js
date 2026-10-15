import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { State } from '../src/state.js';
import { buildXLSX } from '../src/xlsx-export.js';
import { bytesToB64, baseName } from '../src/util.js';

const source = fs.readFileSync(new URL('../src/subio.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const names = ['executeBatchExport', 'getXLSXFileData', 'doExportXLSX'];
const functions = names.map(name => {
  const declaration = ast.body.find(node => node.type === 'ExportNamedDeclaration'
    && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id.name === name)?.declaration;
  if (!declaration) throw new Error(`缺少公開匯出入口：${name}`);
  return source.slice(declaration.start, declaration.end);
}).join('\n');

// Observe the public Promise consumer without creating an unhandled rejection
// in the pre-fix regression run. Async await also assimilates this thenable.
class RejectedWriter {
  constructor(error) { this.error = error; this.handled = false; }
  then(_resolve, reject) {
    if (typeof reject === 'function') { this.handled = true; reject(this.error); }
    return this;
  }
  catch(reject) {
    if (typeof reject === 'function') { this.handled = true; reject(this.error); }
    return this;
  }
}

function publicExports(desk, desktop = true) {
  const setStatus = vi.fn(), showToast = vi.fn(), downloadBytes = vi.fn();
  const context = vm.createContext({ State, IS_DESKTOP: desktop, DESK: desk, buildXLSX,
    bytesToB64, baseName, b64ToBytes: value => new Uint8Array(Buffer.from(value, 'base64')),
    downloadBytes, setStatus, showToast });
  vm.runInContext(`${functions}\n globalThis.exports = {${names.join(',')}};`, context);
  return { ...context.exports, setStatus, showToast, downloadBytes };
}

const subtitle = { name: 'caption.srt', content: bytesToB64(new TextEncoder().encode('字幕')),
  ext: 'srt', mime: 'text/plain;charset=utf-16le' };
const tracks = [{ name: '軌道1', cues: [{ start: 0, end: 1, text: '字幕' }] }];

describe('字幕檔案匯出的公開完成回報', () => {
  it.each(['single', 'batch', 'xlsx'])('%s 寫入拒絕 EACCES 會接住錯誤並顯示失敗', async branch => {
    const before = JSON.stringify(State);
    const writer = new RejectedWriter(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const desk = { exportSub: vi.fn(() => writer), exportDirectory: vi.fn(() => writer) };
    const api = publicExports(desk);
    await (branch === 'xlsx' ? api.doExportXLSX(tracks)
      : api.executeBatchExport(branch === 'single' ? [subtitle] : [subtitle, { ...subtitle, name: 'notes.csv' }]));
    expect(writer.handled).toBe(true);
    expect(api.setStatus).toHaveBeenCalledWith(expect.stringMatching(/匯出失敗.*EACCES/), 'err');
    expect(api.showToast).toHaveBeenCalledWith(expect.stringMatching(/匯出失敗.*EACCES/));
    expect(api.setStatus.mock.calls.some(([, kind]) => kind === 'ok')).toBe(false);
    expect(JSON.stringify(State)).toBe(before);
  });

  it.each([1, 2])('取消 %s 檔的 native picker 不顯示成功或失敗', async count => {
    const desk = { exportSub: vi.fn().mockResolvedValue(null), exportDirectory: vi.fn().mockResolvedValue(null) };
    const api = publicExports(desk);
    await api.executeBatchExport(Array.from({ length: count }, () => subtitle));
    expect(api.setStatus).not.toHaveBeenCalled();
    expect(api.showToast).not.toHaveBeenCalled();
  });

  it.each([1, 2])('完成 %s 檔的 native 寫入後才顯示成功', async count => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const desk = { exportSub: vi.fn(() => pending), exportDirectory: vi.fn(() => pending) };
    const api = publicExports(desk);
    const completed = api.executeBatchExport(Array.from({ length: count }, () => subtitle));
    let settled = false;
    const observed = Promise.resolve(completed).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(api.setStatus).not.toHaveBeenCalled();
    finish(count === 1 ? 'C:/picked/caption.srt' : 'C:/picked');
    await observed;
    expect(api.setStatus).toHaveBeenCalledWith(expect.stringContaining('已'), 'ok');
    expect(api.showToast).toHaveBeenCalledOnce();
  });

  it('XLSX native 路徑使用真正的工作簿 bytes 並與批次匯出共用完成回報', async () => {
    const desk = { exportSub: vi.fn().mockResolvedValue('C:/picked/captions.xlsx') };
    const api = publicExports(desk);
    await api.doExportXLSX(tracks);
    const [name, b64, extension] = desk.exportSub.mock.calls[0];
    expect(name).toMatch(/\.xlsx$/);
    expect(extension).toBe('xlsx');
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(buildXLSX(tracks, State.fps, State.dropFrame)));
    expect(api.setStatus).toHaveBeenCalledWith('已匯出：C:/picked/captions.xlsx', 'ok');
  });

  it('網頁批次仍下載每一份檔案；XLSX 仍顯示分頁數', async () => {
    const api = publicExports(null, false);
    await api.executeBatchExport([subtitle, { ...subtitle, name: 'other.srt' }]);
    expect(api.downloadBytes).toHaveBeenCalledTimes(2);
    expect(api.setStatus).toHaveBeenLastCalledWith('已下載 2 個檔案', 'ok');
    await api.doExportXLSX(tracks);
    expect(api.downloadBytes).toHaveBeenCalledTimes(3);
    expect(api.setStatus).toHaveBeenLastCalledWith('已匯出 XLSX（1 個分頁）', 'ok');
  });
});
