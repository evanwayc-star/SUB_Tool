import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('font loading ownership', () => {
  async function fontEnvironment(fontsList) {
    vi.resetModules();
    vi.stubGlobal('window', { subtool: { fontsList, fileURL: async () => 'font-url' } });
    vi.stubGlobal('fetch', async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }));
    vi.stubGlobal('document', { fonts: { add: vi.fn(), delete: vi.fn() } });
    vi.stubGlobal('FontFace', class { async load() { return this; } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    return import('../src/substyle.js');
  }

  it('keeps the complete accepted family mapping while a font refresh is pending', async () => {
    const original = [{ name: '原字幕字型', file: 'old.ttf', family: 'Original Internal Family' }];
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const fontsList = vi.fn().mockResolvedValueOnce({ fonts: original }).mockReturnValueOnce(pending);
    const fonts = await fontEnvironment(fontsList);
    await fonts.loadFonts();
    const { renderASS } = await import('../src/formats.js');
    const refresh = fonts.loadFonts(true);
    expect(fonts.getFonts()).toEqual(original);
    expect(fonts.assFontName('原字幕字型')).toBe('Original Internal Family');
    expect(fonts.uiFontNameFromAss('Original Internal Family')).toBe('原字幕字型');
    const ass = renderASS([{ start: 0, end: 1, text: '字幕', track: 0 }], {
      fps: 25, tracks: [{ font: '原字幕字型' }],
    });
    expect(ass).toMatch(/^Style: [^,]+,Original Internal Family,/m);
    const next = [...original, { name: '新字幕字型', file: 'new.ttf', family: 'New Internal Family' }];
    finish({ fonts: next });
    expect(await refresh).toEqual(next);
    expect(fonts.assFontName('新字幕字型')).toBe('New Internal Family');
  });

  it('a failed refresh retains the last accepted family mapping', async () => {
    const original = [{ name: '原字幕字型', file: 'old.ttf', family: 'Original Internal Family' }];
    const fontsList = vi.fn().mockResolvedValueOnce({ fonts: original })
      .mockRejectedValueOnce(new Error('font directory temporarily unavailable'));
    const fonts = await fontEnvironment(fontsList);
    await fonts.loadFonts();
    expect(await fonts.loadFonts(true)).toEqual(original);
    expect(fonts.assFontName('原字幕字型')).toBe('Original Internal Family');
  });

  it('retries an initial list failure instead of caching an empty successful load', async () => {
    const original = [{ name: '原字幕字型', file: 'old.ttf', family: 'Original Internal Family' }];
    const fontsList = vi.fn().mockRejectedValueOnce(new Error('font IPC temporarily unavailable'))
      .mockResolvedValueOnce({ fonts: original });
    const fonts = await fontEnvironment(fontsList);
    expect(await fonts.loadFonts()).toEqual([]);
    expect(await fonts.loadFonts()).toEqual(original);
    expect(fonts.assFontName('原字幕字型')).toBe('Original Internal Family');
    expect(fontsList).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers both receive an empty list after initial failure and can retry', async () => {
    let fail;
    const pending = new Promise((_, reject) => { fail = reject; });
    const fontsList = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce({ fonts: [] });
    const fonts = await fontEnvironment(fontsList);
    const first = fonts.loadFonts(), second = fonts.loadFonts();
    fail(new Error('font list unavailable'));
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(await fonts.loadFonts()).toEqual([]);
    expect(fontsList).toHaveBeenCalledTimes(2);
  });

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

  it('replaces its registered faces on refresh without accumulating copies or deleting other owners', async () => {
    const list = [{ name: '字幕字型', file: 'font.ttf', family: 'Internal Family' }];
    const fontsList = vi.fn().mockResolvedValue({ fonts: list });
    const fonts = await fontEnvironment(fontsList);
    const unrelated = { family: 'Other Owner' }, registered = new Set([unrelated]);
    document.fonts = registered;
    await fonts.loadFonts();
    const initial = [...registered].find(face => face !== unrelated);
    for (let refresh = 0; refresh < 3; refresh++) await fonts.loadFonts(true);
    expect(registered.size).toBe(2);
    expect(registered.has(initial)).toBe(false);
    expect(registered.has(unrelated)).toBe(true);
    fontsList.mockResolvedValue({ fonts: [] });
    await fonts.loadFonts(true);
    expect([...registered]).toEqual([unrelated]);
  });

  it('retains usable faces through a pending or failed refresh and replaces them after retry', async () => {
    const list = [{ name: '字幕字型', file: 'font.ttf', family: 'Internal Family' }];
    const fonts = await fontEnvironment(vi.fn().mockResolvedValue({ fonts: list }));
    const registered = new Set(); document.fonts = registered;
    await fonts.loadFonts();
    const original = [...registered][0];
    let rejectLoad;
    vi.stubGlobal('FontFace', class { load() { return new Promise((_, reject) => { rejectLoad = reject; }); } });
    const pending = fonts.loadFonts(true);
    await vi.waitFor(() => expect(rejectLoad).toBeTypeOf('function'));
    expect([...registered]).toEqual([original]);
    rejectLoad(new Error('temporarily unreadable font'));
    await pending;
    expect([...registered]).toEqual([original]);
    expect(fonts.assFontName('字幕字型')).toBe('Internal Family');
    vi.stubGlobal('FontFace', class { async load() { return this; } });
    await fonts.loadFonts(true);
    expect(registered.size).toBe(1);
    expect(registered.has(original)).toBe(false);
  });
});
