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
  it('互動保存等待實際寫入，失敗保留原樣式且同一更新可重試', async () => {
    const original = [{name:'原樣式',style:{fontSize:40}}];
    const {styles, save} = await readPresets(original, true);
    const update = styles.capturePresetUpdate(styles.getPresets()[0]);
    save.mockResolvedValueOnce(false);
    expect(await update({name:'新名稱'})).toMatchObject({ok:false,reason:'save-failed'});
    expect(styles.getPresets()).toEqual(original);
    expect(await update({name:'新名稱'})).toMatchObject({ok:true});
    expect(styles.getPresets()[0].name).toBe('新名稱');
  });

  it('較新保存成功後舊回覆不能覆蓋，目前 caller 也能看見已接受的新樣式', async () => {
    const {styles, save} = await readPresets([], true);
    const replies = [];
    save.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    const first = styles.savePresets([{name:'舊快照',style:{fontSize:40}}], {rollbackOnFailure:true});
    expect(styles.getPresets()[0].name).toBe('舊快照');
    const second = styles.savePresets([{name:'新快照',style:{fontSize:90}}], {rollbackOnFailure:true});
    replies[1](true); expect(await second).toMatchObject({ok:true});
    replies[0](true); expect(await first).toMatchObject({ok:false,reason:'changed'});
    expect(styles.getPresets()[0].name).toBe('新快照');
  });

  it.each(['false','reject','throw','undefined'])('桌面保存 %s 會回報失敗並還原原物件，之後仍可重試', async failure => {
    const {styles, save} = await readPresets([{name:'原樣式',style:{fontSize:40}}], true);
    const original = styles.getPresets();
    save.mockImplementationOnce(() => {
      if(failure==='throw') throw new Error('disk unavailable');
      if(failure==='reject') return Promise.reject(new Error('ipc unavailable'));
      return Promise.resolve(failure==='false' ? false : undefined);
    });
    expect(await styles.savePresets([], {rollbackOnFailure:true})).toMatchObject({ok:false,reason:'save-failed'});
    expect(styles.getPresets()).toBe(original);
    expect(await styles.savePresets([], {rollbackOnFailure:true})).toMatchObject({ok:true});
    expect(styles.getPresets()).toEqual([]);
  });

  it('localStorage 寫入例外也還原原清單並可重試', async () => {
    const {styles, save} = await readPresets([{name:'原樣式'}], false);
    const original = styles.getPresets();
    save.mockImplementationOnce(() => { throw new Error('quota exceeded'); });
    expect(await styles.savePresets([], {rollbackOnFailure:true})).toMatchObject({ok:false});
    expect(styles.getPresets()).toBe(original);
    expect(await styles.savePresets([], {rollbackOnFailure:true})).toMatchObject({ok:true});
  });

  it.each([false,true])('兩次已接受新增都失敗，依任一回覆順序還原最後成功清單（reverse=%s）', async reverse => {
    const {styles, save} = await readPresets([{name:'已保存'}], true);
    const original = styles.getPresets(), replies = [];
    save.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    const a = styles.savePresets([...styles.getPresets(),{name:'A'}], {rollbackOnFailure:true});
    const b = styles.savePresets([...styles.getPresets(),{name:'B'}], {rollbackOnFailure:true});
    const first = reverse ? 1 : 0, second = reverse ? 0 : 1;
    replies[first](false); await (reverse ? b : a);
    replies[second](false); await (reverse ? a : b);
    expect(styles.getPresets()).toBe(original);
  });

  it.each([false,true])('較新的合併成功保存全部已接受新增，不被舊失敗回覆撤回（reverse=%s）', async reverse => {
    const {styles, save} = await readPresets([], true);
    const replies = [];
    save.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    const a = styles.savePresets([{name:'A'}], {rollbackOnFailure:true});
    const b = styles.savePresets([...styles.getPresets(),{name:'B'}], {rollbackOnFailure:true});
    expect(save.mock.calls[1][0].subPresets.map(p=>p.name)).toEqual(['A','B']);
    if(reverse){ replies[1](true); await b; replies[0](false); await a; }
    else{ replies[0](false); await a; replies[1](true); await b; }
    expect(styles.getPresets().map(p=>p.name)).toEqual(['A','B']);
  });

  it('同步專案合併不因保存拒絕撤回，也不被前一次成功回覆覆蓋', async () => {
    const {styles, save} = await readPresets([], true);
    let finish;
    save.mockImplementationOnce(() => new Promise(resolve => { finish=resolve; }))
      .mockRejectedValueOnce(new Error('disk unavailable'));
    const first = styles.savePresets([{name:'已接受'}], {rollbackOnFailure:true});
    const project = styles.savePresets([...styles.getPresets(),{name:'專案合併'}]);
    expect(styles.getPresets().map(p=>p.name)).toEqual(['已接受','專案合併']);
    expect(await project).toMatchObject({ok:false});
    finish(true); await first;
    expect(styles.getPresets().map(p=>p.name)).toEqual(['已接受','專案合併']);
  });

  it('初始保存失敗後才載入的設定成為下一次失敗回滾基線', async () => {
    vi.resetModules();
    const original = [{name:'磁碟樣式',style:{fontSize:70}}];
    vi.stubGlobal('window', {subtool:{configLoad:async()=>({subPresets:original}),configSave:async()=>false}});
    const styles = await import('../src/substyle.js');
    await styles.savePresets([{name:'失敗新增'}], {rollbackOnFailure:true});
    expect(await styles.loadPresets()).toEqual(original);
    await styles.savePresets([], {rollbackOnFailure:true});
    expect(styles.getPresets()).toEqual(original);
  });

  it('並行讀取共用同一載入工作，完成後不再重讀設定', async () => {
    vi.resetModules();
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const load = vi.fn(() => pending);
    vi.stubGlobal('window', { subtool: { configLoad: load } });
    const styles = await import('../src/substyle.js');
    const first = styles.loadPresets(), second = styles.loadPresets();
    expect(load).toHaveBeenCalledOnce();
    finish({ subPresets: [{ name: '已載入', style: { fontSize: 90 } }] });
    const loaded = await first;
    expect(await second).toBe(loaded);
    expect(await styles.loadPresets()).toBe(loaded);
    expect(load).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'])('載入等待期間的新儲存不被遲到 %s 或舊名稱遷移覆蓋', async completion => {
    vi.resetModules();
    let finish, fail;
    const pending = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const save = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('window', { subtool: { configLoad: () => pending, configSave: save } });
    const styles = await import('../src/substyle.js');
    const loading = styles.loadPresets();
    const replacement = [{ name: '新儲存', style: { fontSize: 99 } }];
    styles.savePresets(replacement);
    expect(styles.getPresets()).toEqual(replacement);
    expect(await styles.loadPresets()).toEqual(replacement);
    if (completion === 'resolve') finish({ subPresets: [{ name: '舊資料夾-舊樣式', style: { fontSize: 80 } }] });
    else fail(new Error('late config read failure'));
    expect(await loading).toEqual(replacement);
    expect(styles.getPresets()).toEqual(replacement);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ subPresets: replacement });
  });

  it('讀取失敗後釋放載入工作，下一次仍能取得設定', async () => {
    vi.resetModules();
    const load = vi.fn().mockRejectedValueOnce(new Error('config temporarily unavailable'))
      .mockResolvedValueOnce({ subPresets: [{ name: '重試成功', style: { fontSize: 90 } }] });
    vi.stubGlobal('window', { subtool: { configLoad: load } });
    const styles = await import('../src/substyle.js');
    expect(await styles.loadPresets()).toEqual([]);
    expect(styles.getPresets()).toEqual([]);
    expect(await styles.loadPresets()).toEqual([{ name: '重試成功', style: { fontSize: 90 } }]);
    expect(load).toHaveBeenCalledTimes(2);
  });

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

  it.each([false, true])('略過毀損項目並保留合法樣式與完整名稱（desktop=%s）', async desktop => {
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
      { name: '預告-中文', style: { color: '#ffee00' } },
      { name: '稀疏預設' },
      { name: '空樣式', style: null },
    ]);
    expect(save).not.toHaveBeenCalled();
  });
});
