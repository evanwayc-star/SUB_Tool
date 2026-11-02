import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it.each(['active','queued'])('較早的樣式批次（%s）與較新的專案存檔共用目標，保存成功或明確回報衝突', async scenario => {
  const { stdout } = await run(process.execPath, [
    '-r', path.resolve('tests/fixtures/directory-output-worker-gate.cjs'),
    path.resolve('tests/fixtures/directory-output-cross-writer.cjs'),
    scenario,
  ], {cwd:process.cwd(),timeout:20000});
  const result = JSON.parse(stdout);
  expect(['saved','PROJECT_DESTINATION_CHANGED']).toContain(result.saved);
  if (result.saved === 'saved') expect(result.finalName).toBe('new project');
  else expect(result.finalIsStyle).toBe(true);
}, 30000);

it('已排隊的批次含越界及 junction 時只輸出合法項，並回報實際 blocked 數量', async () => {
  const {stdout} = await run(process.execPath, [
    '-r', path.resolve('tests/fixtures/directory-output-worker-gate.cjs'),
    path.resolve('tests/fixtures/directory-output-cross-writer.cjs'),
    'mixed',
  ], {cwd:process.cwd(),timeout:20000});
  const result=JSON.parse(stdout);
  expect(result.mixedResult).toEqual({written:1,blocked:2});
  expect(result.exportResult.error).toContain('已寫入 1 個檔案，略過 2 個');
  expect(result.finalIsStyle).toBe(true);
  expect(result.outside).toBe('outside unchanged');
  expect(result.escape).toBe('escape unchanged');
},30000);

it('排隊混合批次遇較新專案存檔時，無資格的項目不能晚到覆寫', async () => {
  const {stdout} = await run(process.execPath, [
    '-r', path.resolve('tests/fixtures/directory-output-worker-gate.cjs'),
    path.resolve('tests/fixtures/directory-output-cross-writer.cjs'),
    'mixed-conflict',
  ], {cwd:process.cwd(),timeout:20000});
  const result=JSON.parse(stdout);
  expect(['saved','PROJECT_DESTINATION_CHANGED']).toContain(result.saved);
  if(result.saved==='saved') expect(result.finalName).toBe('new project');
  else {
    expect(result.finalIsStyle).toBe(true);
    expect(result.mixedResult).toEqual({written:1,blocked:2});
  }
  expect(result.outside).toBe('outside unchanged');
  expect(result.escape).toBe('escape unchanged');
},30000);
