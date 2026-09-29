import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); });

async function readPresets(value, desktop) {
  vi.resetModules();
  const save = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('window', desktop ? { subtool: { configLoad: async () => ({ subPresets: value }), configSave: save } } : {});
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(value), setItem: save });
  const styles = await import('../src/substyle.js');
  return { styles, presets: await styles.loadPresets(), save };
}

describe('常用字幕樣式的持久化邊界', () => {
  it.each([false, true])('非陣列設定不會中斷啟動（desktop=%s）', async desktop => {
    const { presets, styles, save } = await readPresets({ name: 'broken' }, desktop);
    expect(presets).toEqual([]);
    expect(styles.getAllPresets().map(p => p.name)).toEqual(['預設']);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([false, true])('略過毀損項目並保留合法樣式與舊名稱遷移（desktop=%s）', async desktop => {
    const { presets, save } = await readPresets([
      null, 1, 'bad', [], { name: 23 }, { name: 'bad group', group: {} },
      { name: 'bad style', style: [] },
      { name: '英文', group: '影片', style: { fontSize: 44, posY: 82 } },
      { name: '預告-中文', style: { color: '#ffee00' } },
      { name: '稀疏預設' },
    ], desktop);
    expect(presets).toEqual([
      { name: '英文', group: '影片', style: { fontSize: 44, posY: 82 } },
      { name: '中文', group: '預告', style: { color: '#ffee00' } },
      { name: '稀疏預設' },
    ]);
    expect(save).toHaveBeenCalledOnce();
  });
});
