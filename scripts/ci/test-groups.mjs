import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTestFiles(absolute);
    return entry.name.endsWith('.test.js') ? [absolute] : [];
  });
}

// Local Vitest and CI must classify the same files. Desktop/native tests share
// OS focus, visible painting and native resources even with separate profiles.
export function windowsTestFiles(root) {
  return collectTestFiles(path.join(root, 'tests'))
    .filter(file => readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] === '// @subtool-ci windows')
    .map(file => path.relative(root, file).replaceAll('\\', '/'))
    .sort();
}
