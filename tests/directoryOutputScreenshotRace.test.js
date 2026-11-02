import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('舊字幕另存 worker 不能覆蓋回報成功的較新截圖', async () => {
  const {stdout}=await promisify(execFile)(process.execPath,[
    '-r',path.resolve('tests/fixtures/directory-output-worker-gate.cjs'),
    path.resolve('tests/fixtures/directory-output-screenshot-race.cjs'),
  ],{cwd:process.cwd(),timeout:20000});
  const result=JSON.parse(stdout);
  expect(result.saved).toBe(true);
  expect(result.name).toBe('Shot-002.jpg');
  expect(result.content).toBe('new screenshot');
},30000);

it('截圖先保留後目的檔被較早提交的字幕取代，寫入明確失敗', async () => {
  const {stdout}=await promisify(execFile)(process.execPath,[
    '-r',path.resolve('tests/fixtures/directory-output-worker-gate.cjs'),
    path.resolve('tests/fixtures/directory-output-screenshot-race.cjs'),'reserved-first',
  ],{cwd:process.cwd(),timeout:20000});
  const result=JSON.parse(stdout);
  expect(result.saved).toBe(false);
  expect(result.content).toBe('old subtitle');
},30000);
