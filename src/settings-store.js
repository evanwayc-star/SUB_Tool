/* 小型設定的鍵值儲存。這是本專案少數【真的】有兩個 adapter 的接縫：
     桌面版：走 Electron IPC（DESK.configLoad / configSave / keysLoad / keysSave）
     網頁版：走 localStorage
   兩者存的都是同一份可序列化 JSON，只是落點不同。

   為什麼值得抽出來：以前這個「桌面 IPC 還是 localStorage」的判斷在
   loadConfig／saveConfig／loadKeys／saveKeys 各手寫一次，而 loadConfig 更把
   欄位映射【寫了兩份】（DESK 一份、localStorage 一份）——改欄位時要記得改兩處，
   漏一處就會「桌面存得到、網頁存不到」而畫面完全正常。收斂成一份後只剩一個判斷點。

   注意 mpv／ingest／probe 那些【不是】這種接縫：它們只有桌面一種實作，
   為只有一種實作的東西建 adapter 是投機的抽象（見架構審查）。這裡只收設定儲存。

   本模組刻意【不 import DESK】——desk 由呼叫端注入（makeSettingsStore(desk)），
   才能在測試裡塞一個假的桌面橋接或純 localStorage。 */

/* 邏輯名稱 → 兩個 adapter 各自的落點。新增一種設定只要在這裡加一列。 */
export const SETTINGS_SLOTS = {
  config: { deskLoad: 'configLoad', deskSave: 'configSave', lsKey: 'subtool_config' },
  keys:   { deskLoad: 'keysLoad',   deskSave: 'keysSave',   lsKey: 'subtool_keys' },
};

/* desk：Electron 橋接物件（桌面版），或 null（網頁版）。
   storage：localStorage 或相容物件；預設取全域的 localStorage，測試可注入假的。 */
export function makeSettingsStore(desk, storage) {
  const ls = storage || (typeof localStorage !== 'undefined' ? localStorage : null);

  /* 讀取設定。回傳存的物件，或 null（沒有、壞掉、或讀取失敗）。
     永遠不丟例外——設定讀不到時應回到預設值，而不是讓整個啟動流程崩掉。 */
  async function load(name) {
    const slot = SETTINGS_SLOTS[name];
    if (!slot) return null;
    if (desk && typeof desk[slot.deskLoad] === 'function') {
      try {
        const obj = await desk[slot.deskLoad]();
        return (obj && typeof obj === 'object') ? obj : null;
      } catch (e) {
        console.error('讀取設定失敗（桌面）:', name, e);
        return null;
      }
    }
    if (!ls) return null;
    try {
      const raw = ls.getItem(slot.lsKey);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch (e) {
      return null;
    }
  }

  /* 寫入設定。fire-and-forget：桌面端非同步、失敗只記錄（不阻塞 UI）；
     網頁端同步寫 localStorage。回傳 Promise 讓需要等待的呼叫端可以 await。 */
  async function save(name, data) {
    const slot = SETTINGS_SLOTS[name];
    if (!slot) return false;
    if (desk && typeof desk[slot.deskSave] === 'function') {
      try {
        await desk[slot.deskSave](data);
        return true;
      } catch (e) {
        console.error('儲存設定失敗（桌面）:', name, e);
        return false;
      }
    }
    if (!ls) return false;
    try {
      ls.setItem(slot.lsKey, JSON.stringify(data));
      return true;
    } catch (e) {
      return false;
    }
  }

  return { load, save };
}
