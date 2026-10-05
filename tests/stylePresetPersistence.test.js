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
  it.each([false,true])('欄位型別與有限數在load邊界正規化，合法legacy範圍保留（desktop=%s）',async desktop=>{
    const {presets,styles}=await readPresets([{name:'typed',style:{posX:'30',posY:0,bold:'false',italic:false,
      color:'#ABCD12',outline:-1,font:'unsafe\'font',align:'none',fontSize:600,angle:360,letterSpacing:-2,lineSpacing:0.8}}],desktop);
    expect(presets[0].style).toEqual({posY:0,italic:false,color:'#abcd12',fontSize:600,angle:360,letterSpacing:-2,lineSpacing:0.8});
    expect(styles.normalizeStyleRecord({fontSize:600},true,true)).toBeNull();
    expect(styles.normalizeStyleRecord({posX:Infinity,shadow:NaN})).toEqual({});
    styles.savePresets(presets);
    presets[0].style.posY=30;
    expect(styles.getPresets()[0].style.posY).toBe(0);
  });

  it('preset identity區分資料夾、builtin並避免分隔符碰撞',async()=>{
    const {styles}=await readPresets([],false);
    expect(styles.presetIdentity({name:'same',group:'A'})).not.toBe(styles.presetIdentity({name:'same',group:'B'}));
    expect(styles.presetIdentity({name:'a|b',group:'c'})).not.toBe(styles.presetIdentity({name:'b',group:'c|a'}));
    expect(styles.presetIdentity({name:'same'})).toBe(styles.presetIdentity({name:'same',group:''}));
    expect(styles.presetIdentity({name:'預設',builtin:true})).not.toBe(styles.presetIdentity({name:'預設'}));
  });
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
      { name: '空樣式', style: null },
    ], desktop);
    expect(presets).toEqual([
      { name: '英文', group: '影片', style: { fontSize: 44, posY: 82 } },
      { name: '中文', group: '預告', style: { color: '#ffee00' } },
      { name: '稀疏預設' },
      { name: '空樣式', style: null },
    ]);
    expect(save).toHaveBeenCalledOnce();
  });
});
