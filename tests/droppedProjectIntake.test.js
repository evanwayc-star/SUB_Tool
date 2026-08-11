import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { authorizeDroppedMediaPath } = require('../electron/dropped-file-admission.js');

describe('dropped desktop project intake', () => {
  it('generic media-drop admission cannot pre-authorize project files or their screenshot directory', () => {
    const grantRead = vi.fn(() => true);
    const grantScreenshotDirectory = vi.fn();

    expect(authorizeDroppedMediaPath('D:\\Projects\\edit.subtool', {
      grantRead, grantScreenshotDirectory,
    })).toBeNull();
    expect(authorizeDroppedMediaPath('D:\\Projects\\legacy.json', {
      grantRead, grantScreenshotDirectory,
    })).toBeNull();
    expect(grantRead).not.toHaveBeenCalled();
    expect(grantScreenshotDirectory).not.toHaveBeenCalled();

    expect(authorizeDroppedMediaPath('D:\\Media\\program.mov', {
      grantRead, grantScreenshotDirectory, pathModule: path.win32
    })).toBe('D:\\Media\\program.mov');
    expect(grantRead).toHaveBeenCalledWith('D:\\Media\\program.mov');
    expect(grantScreenshotDirectory).toHaveBeenCalledWith('D:\\Media');
  });
});
