import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('font loading ownership', () => {
  it('waits for font registration when a second caller checks during startup', async () => {
    vi.resetModules();
    let complete;
    const loaded = new Promise(resolve => { complete = resolve; });
    const add = vi.fn();
    const list = [{ name: 'Test Font', file: 'font.ttf' }];
    const fontsList = vi.fn().mockResolvedValue({ fonts: list });
    vi.stubGlobal('window', { subtool: { fontsList, fileURL: async () => 'font-url' } });
    vi.stubGlobal('fetch', async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }));
    vi.stubGlobal('document', { fonts: { add } });
    vi.stubGlobal('FontFace', class {
      load() { return loaded; }
    });
    const { loadFonts } = await import('../src/substyle.js');
    const first = loadFonts();
    let secondDone = false;
    const second = loadFonts().then(result => { secondDone = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(secondDone).toBe(false);
    expect(add).not.toHaveBeenCalled();
    complete();
    expect(await first).toEqual(list);
    expect(await second).toEqual(list);
    expect(add).toHaveBeenCalledOnce();
    expect(fontsList).toHaveBeenCalledOnce();
    await loadFonts();
    expect(fontsList).toHaveBeenCalledOnce();
  });
});
