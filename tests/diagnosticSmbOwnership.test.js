import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../scripts/diagnostics/watch-smb-latency.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest' });
const tick = ast.body.find(node => node.type === 'VariableDeclaration'
  && node.declarations[0]?.id.name === 'tick').declarations[0].init;

function sample({ openError, readError, closeError, listError } = {}) {
  const calls = [], output = [];
  const context = vm.createContext({
    process: { hrtime: { bigint: () => 0n } },
    fs: {
      readdirSync() {
        if (listError) throw Object.assign(new Error('list failed'), { code: listError });
        return [{ name: 'mother.mov', isFile: () => true }];
      },
      openSync() {
        calls.push('open');
        if (openError) throw Object.assign(new Error('open failed'), { code: openError });
        return 7;
      },
      readSync(fd) {
        expect(fd).toBe(7); calls.push('read');
        if (readError) throw Object.assign(new Error('read failed'), { code: readError });
      },
      closeSync(fd) {
        expect(fd).toBe(7); calls.push('close');
        if (closeError) throw Object.assign(new Error('close failed'), { code: closeError });
      },
    },
    DIR: 'fixture', path, Buffer, hhmmss: () => '', busyProcs: () => '',
    console: { log: text => output.push(text) },
  });
  vm.runInContext('let n = 0; (' + source.slice(tick.start, tick.end) + ')()', context);
  return { calls, output: output.join('\n') };
}

describe('SMB 診斷檔案採樣所有權', () => {
  it('網路讀取 EIO 仍關閉已開啟的 descriptor 並顯示錯誤', () => {
    const result = sample({ readError: 'EIO' });
    expect(result.calls).toEqual(['open', 'read', 'close']);
    expect(result.output).toContain('READ ERR EIO');
  });

  it('開檔失敗不能關閉別人的 descriptor', () => {
    const result = sample({ openError: 'EACCES' });
    expect(result.calls).toEqual(['open']);
    expect(result.output).toContain('READ ERR EACCES');
  });

  it('成功採樣關閉一次，收尾失敗仍明確回報', () => {
    const success = sample();
    expect(success.calls).toEqual(['open', 'read', 'close']);
    expect(success.output).not.toContain('ERR');
    const failure = sample({ closeError: 'EIO' });
    expect(failure.calls).toEqual(['open', 'read', 'close']);
    expect(failure.output).toContain('READ ERR EIO');
  });

  it('列目錄失敗時不讀取其他來源，也不偽裝成成功採樣', () => {
    const result = sample({ listError: 'ENETUNREACH' });
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('LIST ERR ENETUNREACH');
  });
});
