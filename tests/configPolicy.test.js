import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeRendererConfig } = require('../electron/ipc-guards.js');

describe('renderer config policy', () => {
  it('persists only supported preview modes without accepting a path or arbitrary mode', () => {
    expect(mergeRendererConfig({}, {previewMode:'original'})).toEqual({previewMode:'original'});
    expect(mergeRendererConfig({previewMode:'original'}, {previewMode:'smooth'})).toEqual({previewMode:'smooth'});
    for(const previewMode of ['C:/private.mov','auto',null,{},true])
      expect(mergeRendererConfig({previewMode:'original'}, {previewMode})).toEqual({previewMode:'original'});
  });
  it('keeps main-owned recent projects immutable while accepting renderer settings', () => {
    const current = {
      recentProjects: [{ path: 'C:\\Projects\\trusted.subtool' }],
      autoSelect: false,
    };
    const result = mergeRendererConfig(current, {
      recentProjects: [{ path: 'C:\\secret.json' }],
      autoSelect: true,
      pointerSeekPauses: true,
      arbitraryMainKey: 'injected',
    });

    expect(result).toEqual({
      recentProjects: [{ path: 'C:\\Projects\\trusted.subtool' }],
      autoSelect: true,
      pointerSeekPauses: true,
    });
  });

  it('accepts subtitle presets but rejects values with the wrong renderer-owned type', () => {
    const presets = [{ name: '對白' }];
    expect(mergeRendererConfig({ safeFrame: true }, {
      safeFrame: 'false',
      subPresets: presets,
    })).toEqual({ safeFrame: true, subPresets: presets });
  });
});
