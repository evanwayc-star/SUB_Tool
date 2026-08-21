import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function channelsIn(source, expression) {
  return [...source.matchAll(expression)].map(match => match[1]);
}

describe('Electron invoke interface', () => {
  it('preload 暴露的每一條 invoke channel 都有主程序 handler', () => {
    const preloadSources = ['preload.js', 'queue-preload.js', 'compare-preload.js']
      .map(file => fs.readFileSync(path.join(ROOT, 'electron', file), 'utf8'));
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    const invoked = new Set(preloadSources.flatMap(source =>
      channelsIn(source, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)));
    const handled = new Set(channelsIn(main, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g));

    expect([...invoked].filter(channel => !handled.has(channel)).sort()).toEqual([]);
  });
});
