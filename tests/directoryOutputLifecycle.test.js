import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { it } from 'vitest';

const run = promisify(execFile);

it.each(['success','failure','worker-error'])('目錄輸出 shutdown 與 worker 結束的真實時序（%s）', async scenario => {
  await run(process.execPath, [
    '-r',path.resolve('tests/fixtures/directory-output-lifecycle-gate.cjs'),
    path.resolve('tests/fixtures/directory-output-lifecycle.cjs'),scenario,
  ], {cwd:process.cwd(),timeout:20000});
}, 30000);
