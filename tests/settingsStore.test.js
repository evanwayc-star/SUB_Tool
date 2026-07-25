/* 設定鍵值儲存的兩個 adapter（桌面 IPC / 網頁 localStorage）。

   這是本專案少數【真的】有兩個 adapter 的接縫，所以值得抽出來測——
   而它可測的前提是不 import DESK：desk 與 storage 都由 makeSettingsStore 注入，
   測試才能塞假的桌面橋接或假的 localStorage，不必真的跑 Electron。

   對應 docs/技術架構說明.md 的桌面／網頁分支，以及架構審查候選項 6。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSettingsStore, SETTINGS_SLOTS } from '../src/settings-store.js';

/* 假的 localStorage：只要有 getItem/setItem 就夠。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

describe('網頁 adapter（localStorage）', () => {
  let ls, store;
  beforeEach(() => {
    ls = fakeStorage();
    store = makeSettingsStore(null, ls);   // desk=null → 走 localStorage
  });

  it('save 寫進 localStorage 的正確鍵，load 讀得回來', async () => {
    await store.save('config', { autoSelect: true });
    expect(ls._map.get('subtool_config')).toBe('{"autoSelect":true}');
    expect(await store.load('config')).toEqual({ autoSelect: true });
  });

  it('config 與 keys 存在不同的鍵，不會互相覆蓋', async () => {
    await store.save('config', { a: 1 });
    await store.save('keys', { b: 2 });
    expect(await store.load('config')).toEqual({ a: 1 });
    expect(await store.load('keys')).toEqual({ b: 2 });
  });

  it('沒存過時回 null', async () => {
    expect(await store.load('config')).toBeNull();
  });

  it('localStorage 裡是壞掉的 JSON 時回 null，不丟例外', async () => {
    ls.setItem('subtool_config', '{壞掉的');
    expect(await store.load('config')).toBeNull();
  });

  it('localStorage.setItem 丟例外（如配額滿）時 save 回 false，不炸掉呼叫端', async () => {
    const throwing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } };
    const s = makeSettingsStore(null, throwing);
    expect(await s.save('config', { a: 1 })).toBe(false);
  });
});

describe('桌面 adapter（IPC）', () => {
  it('有 desk 時走 desk 的方法，完全不碰 localStorage', async () => {
    const ls = fakeStorage();
    const desk = {
      configLoad: vi.fn(async () => ({ autoSelect: false })),
      configSave: vi.fn(async () => {}),
    };
    const store = makeSettingsStore(desk, ls);

    expect(await store.load('config')).toEqual({ autoSelect: false });
    await store.save('config', { autoSelect: false });

    expect(desk.configLoad).toHaveBeenCalledOnce();
    expect(desk.configSave).toHaveBeenCalledWith({ autoSelect: false });
    expect(ls._map.size).toBe(0);   // 桌面模式下 localStorage 一次都沒被寫
  });

  it('keys 走 keysLoad / keysSave', async () => {
    const desk = { keysLoad: vi.fn(async () => ({ x: 1 })), keysSave: vi.fn(async () => {}) };
    const store = makeSettingsStore(desk);
    await store.load('keys');
    await store.save('keys', { x: 1 });
    expect(desk.keysLoad).toHaveBeenCalled();
    expect(desk.keysSave).toHaveBeenCalledWith({ x: 1 });
  });

  it('desk 的方法丟例外時，load 回 null、save 回 false（不讓啟動流程崩掉）', async () => {
    const desk = {
      configLoad: async () => { throw new Error('IPC 斷線'); },
      configSave: async () => { throw new Error('IPC 斷線'); },
    };
    const store = makeSettingsStore(desk);
    expect(await store.load('config')).toBeNull();
    expect(await store.save('config', {})).toBe(false);
  });

  it('desk 存在但缺少該方法時，退回 localStorage', async () => {
    const ls = fakeStorage();
    const desk = {};   // 桌面橋接存在，但沒有 configLoad/Save（舊版本相容）
    const store = makeSettingsStore(desk, ls);
    await store.save('config', { a: 9 });
    expect(ls._map.get('subtool_config')).toBe('{"a":9}');
  });
});

describe('防禦', () => {
  it('未知的設定名回 null / false，不丟例外', async () => {
    const store = makeSettingsStore(null, fakeStorage());
    expect(await store.load('不存在')).toBeNull();
    expect(await store.save('不存在', {})).toBe(false);
  });

  it('desk 回傳非物件（如 undefined）時視為沒有設定', async () => {
    const store = makeSettingsStore({ configLoad: async () => undefined });
    expect(await store.load('config')).toBeNull();
  });

  it('SETTINGS_SLOTS 涵蓋 config 與 keys 兩種', () => {
    expect(Object.keys(SETTINGS_SLOTS).sort()).toEqual(['config', 'keys']);
  });
});
