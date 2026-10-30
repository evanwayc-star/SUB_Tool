import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

it('完整測試先完成 portable 群，再讓桌面測試獨占同一份資源', () => {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(path.join(parent, 'subtool-test-execution-'));
  try {
    mkdirSync(path.join(directory, 'tests'));
    // Use actual Windows-classified filenames with tiny fixtures. The real
    // config, discovery and Vitest scheduler decide which project runs them.
    for (const [file, label] of [
      ['testExecutionPortable.test.js', 'portable'],
      ['compareWindowScroll.test.js', 'desktop-a'],
      ['previewSubtitleMenu.test.js', 'desktop-b'],
    ]) {
      writeFileSync(path.join(directory, 'tests', file), `
        import {it,expect} from 'vitest';
        import {openSync,closeSync,unlinkSync,appendFileSync,writeFileSync,readFileSync} from 'node:fs';
        import path from 'node:path';
        it('owns the desktop resource', async () => {
          const lock=path.join(process.cwd(),'desktop.lock');
          const descriptor=openSync(lock,'wx');
          try {
            writeFileSync(descriptor,${JSON.stringify(label)});
            appendFileSync(path.join(process.cwd(),'events'),${JSON.stringify(label + ':start\n')});
            await new Promise(resolve=>setTimeout(resolve,150));
            expect(readFileSync(lock,'utf8')).toBe(${JSON.stringify(label)});
            appendFileSync(path.join(process.cwd(),'events'),${JSON.stringify(label + ':end\n')});
          } finally {closeSync(descriptor);unlinkSync(lock);}
        });
      `);
    }
    const run = spawnSync(process.execPath, [
      path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run',
      '--config', path.join(ROOT, 'vitest.config.mjs'), '--root', directory,
      '--maxWorkers=3',
    ], { cwd: directory, encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(run.error, run.stdout + run.stderr).toBeUndefined();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const events = readFileSync(path.join(directory, 'events'), 'utf8').trim().split('\n');
    expect(events.slice(0, 2)).toEqual(['portable:start', 'portable:end']);
    expect(events.slice(2)).toHaveLength(4);
    expect(events[2].split(':')[0]).toBe(events[3].split(':')[0]);
    expect(events[4].split(':')[0]).toBe(events[5].split(':')[0]);
    expect(new Set(events.map(event => event.split(':')[0])).size).toBe(3);
  } finally {
    const resolved = realpathSync(directory);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('subtool-test-execution-')) {
      throw new Error('拒絕清除未驗證的測試目錄');
    }
    rmSync(resolved, { recursive: true, force: true });
  }
}, 20000);
