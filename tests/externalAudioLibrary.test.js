/* 外部音訊素材庫（src/external-audio.js）。

   這些規則以前是 Media 上的 15 個方法，和序列播放時鐘、WebCodecs 接管、
   Web Audio 增益、波形快取共用同一個物件——想測「修剪不能把素材裁到 0 長」
   得先造出一個能播放的 Media。搬成獨立模組後，這裡零 mock、零 DOM。

   對應 CONTEXT.md「來源聲道／專案音軌」與 docs/技術架構說明.md §0.8。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ExternalAudioLibrary, sourceChannelDescriptors, assetRange } from '../src/external-audio.js';

let lib;
const add = (over = {}) => lib.add({
  name: 'Music', path: 'C:/master/music.wav', duration: 12,
  offset: 10, in: 3, out: 8, gain: 0.5, fadeIn: 1, fadeOut: 2, fallbackCount: 2, ...over,
});

beforeEach(() => { lib = new ExternalAudioLibrary(); });

describe('建立素材', () => {
  it('id 一律另發，不由檔名推導（同名檔不會互相覆蓋路由）', () => {
    const a = add({ name: '同名', path: 'C:/a/same.wav' });
    const b = add({ name: '同名', path: 'C:/b/same.wav' });
    expect(a.audioSourceId).not.toBe(b.audioSourceId);
    expect(a.audioSrc).toBe('ext-' + a.audioSourceId);
  });

  it('要求的 id 只有沒被佔用時才採納', () => {
    const a = add({ audioSourceId: 'asset-fixed' });
    expect(a.audioSourceId).toBe('asset-fixed');
    const b = add({ audioSourceId: 'asset-fixed' });
    expect(b.audioSourceId).not.toBe('asset-fixed');
  });

  /* 切開的兩段要各自有獨立 AudioElement（才能同時播），但時間軸 UI 應留在同一列。 */
  it('timelineLaneId 預設等於自己，切割時可指定成原段的列', () => {
    const a = add();
    expect(a.timelineLaneId).toBe(a.audioSourceId);
    const b = add({ timelineLaneId: a.audioSourceId });
    expect(b.timelineLaneId).toBe(a.audioSourceId);
    expect(b.audioSourceId).not.toBe(a.audioSourceId);
  });

  it('out 不會超過 duration', () => {
    expect(add({ duration: 5, in: 0, out: 99 }).out).toBe(5);
  });
});

describe('範圍正規化（不變量①②）', () => {
  it('out=0 是合法的空範圍，不會被回退成整段 duration', () => {
    expect(assetRange({ duration: 12, offset: 0, in: 0, out: 0 })).toMatchObject({ out: 0, length: 0 });
  });

  it('in 超過 out 時以 in 為準，長度不會變成負的', () => {
    expect(assetRange({ duration: 12, in: 9, out: 4 }).length).toBe(0);
  });

  it('淡入淡出不超過素材本身長度', () => {
    const asset = add({ in: 0, out: 2, fadeIn: 99, fadeOut: 99 });
    lib.normalize(asset);
    expect(asset.fadeIn).toBe(2);
    expect(asset.fadeOut).toBe(2);
  });

  it('負的 offset／gain 會被夾回 0', () => {
    const asset = add({ offset: -5, gain: -1 });
    lib.normalize(asset);
    expect(asset.offset).toBe(0);
    expect(asset.gain).toBe(0);
  });
});

describe('查詢：key 可以是四種識別之一', () => {
  it.each(['id', 'audioSourceId', 'audioSrc', 'source'])('用 %s 找得到', field => {
    const asset = add();
    expect(lib.find(asset[field])).toBe(asset);
  });

  it('找不到時回 null，不丟例外', () => {
    expect(lib.find('沒有這個')).toBeNull();
    expect(lib.get('沒有這個')).toBeNull();
  });

  /* 不變量④：吐出去的資料不可以帶 File。它會被寫進 State 與 History 快照。 */
  it('對外的資料剝掉 _file，且 descriptors 是複本', () => {
    const asset = add({ file: { name: 'fake-File' } });
    const plain = lib.get(asset.id);
    expect(plain._file).toBeUndefined();
    plain.descriptors[0].sourceChannel = 99;
    expect(asset.descriptors[0].sourceChannel).toBe(0);
  });
});

describe('修剪', () => {
  it('拉頭：offset 與 in 同步移動，來源內容不位移', () => {
    const asset = add({ offset: 10, in: 3, out: 8 });   // 時間軸 10→15
    lib.trim(asset.id, 'start', 12);
    expect(asset.offset).toBe(12);
    expect(asset.in).toBe(5);                            // 3 + (12-10)
    expect(asset.out).toBe(8);
  });

  it('拉尾：只改 out', () => {
    const asset = add({ offset: 10, in: 3, out: 8 });
    lib.trim(asset.id, 'end', 13);
    expect(asset.offset).toBe(10);
    expect(asset.in).toBe(3);
    expect(asset.out).toBe(6);                           // 3 + (13-10)
  });

  /* 拖過頭會把素材裁成 0 長 → 它從時間軸上消失，而且沒有任何錯誤訊息。 */
  it('永遠留下最小長度，不會被拖成 0', () => {
    const asset = add({ offset: 10, in: 3, out: 8 });
    lib.trim(asset.id, 'end', 10);                       // 拉到跟頭一樣的位置
    expect(asset.out - asset.in).toBeGreaterThan(0);
    lib.trim(asset.id, 'start', 999);                    // 拉過尾
    expect(assetRange(asset).length).toBeGreaterThan(0);
  });

  it('已經短到極限就不再修剪', () => {
    const asset = add({ duration: 0.05, in: 0, out: 0.02 });
    const before = { ...asset };
    lib.trim(asset.id, 'end', 0);
    expect(asset.in).toBe(before.in);
    expect(asset.out).toBe(before.out);
  });

  it('key 不存在時回 null', () => {
    expect(lib.trim('沒有這個', 'start', 1)).toBeNull();
  });
});

describe('切割：只算數字，不開檔', () => {
  it('回傳左段的新 out 與右段的完整規格', () => {
    const asset = add({ offset: 10, in: 3, out: 8 });    // 時間軸 10→15
    const plan = lib.planSplit(asset.id, 12);

    expect(plan.cut).toBe(5);                            // 3 + (12-10)
    expect(plan.left).toEqual({ out: 5, fadeOut: 0 });
    expect(plan.right).toMatchObject({ offset: 12, in: 5, out: 8, fadeIn: 0, fadeOut: 2 });
    expect(plan.previous).toEqual({ out: 8, fadeOut: 2 });
    // 還沒真的改動任何東西——執行是呼叫端的事
    expect(asset.out).toBe(8);
  });

  it('右段沿用同一條素材列與聲道座標', () => {
    const asset = add({ offset: 10, in: 3, out: 8 });
    const plan = lib.planSplit(asset.id, 12);
    expect(plan.right.timelineLaneId).toBe(asset.timelineLaneId);
    expect(plan.right.descriptors).toEqual(asset.descriptors);
    expect(plan.right.descriptors).not.toBe(asset.descriptors); // 複本
  });

  it('切點太靠近邊界時回 null', () => {
    const asset = add({ offset: 10, in: 3, out: 8 });
    expect(lib.planSplit(asset.id, 10.05)).toBeNull();
    expect(lib.planSplit(asset.id, 14.99)).toBeNull();
    expect(lib.planSplit(asset.id, 0)).toBeNull();
  });
});

describe('時間軸換算', () => {
  it('範圍內：時間軸時間 → 來源時間', () => {
    const asset = add({ offset: 10, in: 3, out: 8 });
    expect(lib.sourceTime(asset.audioSrc, 12)).toBe(5);
  });

  it('範圍外回 null（不該播）', () => {
    const asset = add({ offset: 10, in: 3, out: 8 });
    expect(lib.sourceTime(asset.audioSrc, 9.9)).toBeNull();
    expect(lib.sourceTime(asset.audioSrc, 15)).toBeNull();
  });

  it('靜音的素材不發聲', () => {
    const asset = add({ offset: 10, in: 3, out: 8, enabled: false });
    expect(lib.sourceTime(asset.audioSrc, 12)).toBeNull();
  });

  /* 沒有 asset 的舊 ext-* runtime track 保持「從 0 秒跟著時間軸」的行為。 */
  it('沒有對應素材時退回時間軸時間本身', () => {
    expect(lib.sourceTime('ext-unknown', 7)).toBe(7);
  });

  /* 靜音只是不發聲；素材仍佔著時間軸長度，輸出的黑畫面／總長不能因此縮短。 */
  it('總長包含被靜音的素材', () => {
    add({ offset: 10, in: 3, out: 8 });                  // 尾端 15
    add({ offset: 20, in: 0, out: 5, enabled: false });  // 尾端 25
    expect(lib.timelineEnd()).toBe(25);
  });

  it('空的素材庫總長是 0', () => {
    expect(lib.timelineEnd()).toBe(0);
  });
});

describe('History 還原：算出留下／移除／重建三份名單', () => {
  it('快照裡沒有的素材列進 removed', () => {
    const keep = add({ audioSourceId: 'asset-keep' });
    const drop = add({ audioSourceId: 'asset-drop' });
    const plan = lib.planRestore([{ audioSourceId: 'asset-keep', offset: 0, in: 0, out: 4, duration: 12 }]);
    expect(plan.removed).toEqual([drop]);
    expect(plan.kept.map(k => k.asset)).toEqual([keep]);
    expect(plan.pending).toEqual([]);
  });

  it('runtime 已不在但快照有 path 的，列進 pending 等待重建', () => {
    const plan = lib.planRestore([{ audioSourceId: 'asset-gone', path: 'C:/master/gone.wav', offset: 0, in: 0, out: 4, duration: 4 }]);
    expect(plan.pending).toHaveLength(1);
    expect(plan.kept).toEqual([]);
  });

  /* 沒有 path 就重建不回來；列進 pending 只會製造一次注定失敗的非同步載入。 */
  it('沒有 path 的殘缺快照不列進 pending', () => {
    const plan = lib.planRestore([{ audioSourceId: 'asset-nopath', offset: 0, in: 0, out: 4 }]);
    expect(plan.pending).toEqual([]);
  });

  /* undo 之後時間軸不可以先縮短再變回來——重建是非同步的，中間那一幀會被看見。 */
  it('timelineEnd 直接由快照算出，不等重建完成', () => {
    const plan = lib.planRestore([
      { audioSourceId: 'a', path: 'C:/a.wav', offset: 30, in: 0, out: 5, duration: 5 },
    ]);
    expect(plan.timelineEnd).toBe(35);
  });

  it('applyRestored 套回欄位並重新正規化', () => {
    const asset = add({ audioSourceId: 'asset-keep' });
    lib.applyRestored(asset, { audioSourceId: 'asset-keep', name: '新名字', offset: 1, in: 0, out: 2, duration: 12, gain: 1, fadeIn: 99, fadeOut: 0 });
    expect(asset.name).toBe('新名字');
    expect(asset.offset).toBe(1);
    expect(asset.fadeIn).toBe(2); // 被夾到素材長度
  });

  it('壞掉的快照條目（沒有 audioSourceId）整筆略過', () => {
    const plan = lib.planRestore([null, {}, { audioSourceId: '' }, 'x']);
    expect(plan.wanted).toEqual([]);
  });
});

describe('高度調整（setHeight）', () => {
  it('可設定素材高度並限制在 32~160 範圍內', () => {
    const a = add();
    lib.setHeight(a.id, 80);
    expect(a.height).toBe(80);

    lib.setHeight(a.id, 10);
    expect(a.height).toBe(32);

    lib.setHeight(a.id, 300);
    expect(a.height).toBe(160);

    lib.setHeight(a.id, null);
    expect(a.height).toBeUndefined();
  });

  it('同一個 timelineLaneId 的所有切片片段高度同步更新', () => {
    const a = add({ timelineLaneId: 'lane-1' });
    const b = add({ timelineLaneId: 'lane-1' });
    const c = add({ timelineLaneId: 'lane-2' });

    lib.setHeight(a.id, 96);
    expect(a.height).toBe(96);
    expect(b.height).toBe(96);
    expect(c.height).toBeUndefined();
  });

  it('切割時右段繼承原段高度', () => {
    const a = add({ height: 75, duration: 10, in: 0, out: 10, offset: 0 });
    const plan = lib.planSplit(a.id, 4);
    expect(plan.right.height).toBe(75);
  });

  it('還原快照時恢復高度設定', () => {
    const a = add({ height: 90 });
    lib.applyRestored(a, { ...a, height: 60 });
    expect(a.height).toBe(60);

    lib.applyRestored(a, { ...a, height: null });
    expect(a.height).toBeUndefined();
  });
});

describe('音訊軌鎖定（setLocked 與 locked 狀態維護）', () => {
  it('建立時若傳入 locked: true 則正確初始化為 locked', () => {
    const a = add({ locked: true });
    expect(a.locked).toBe(true);
  });

  it('setLocked 可切換同 laneId 所有切片的鎖定狀態', () => {
    const a1 = add({ audioSourceId: 'a1', timelineLaneId: 'lane-1', locked: false });
    const a2 = add({ audioSourceId: 'a2', timelineLaneId: 'lane-1', locked: false });
    lib.setLocked(a1.id, true);
    expect(a1.locked).toBe(true);
    expect(a2.locked).toBe(true);

    lib.setLocked(a2.id, false);
    expect(a1.locked).toBe(false);
    expect(a2.locked).toBe(false);
  });

  it('planSplit 切割時右段會繼承左段的 locked 狀態', () => {
    const a = add({ duration: 10, offset: 0, in: 0, out: 10, locked: true });
    const plan = lib.planSplit(a.id, 5);
    expect(plan.right.locked).toBe(true);
  });

  it('applyRestored 會還原快照中的 locked 狀態', () => {
    const a = add({ audioSourceId: 'a', locked: false });
    lib.applyRestored(a, { audioSourceId: 'a', locked: true });
    expect(a.locked).toBe(true);
  });
});

describe('sourceChannelDescriptors', () => {
  it('有明細時逐一正規化，缺 sourceChannel 用索引補', () => {
    expect(sourceChannelDescriptors([{ sourceStream: 1 }, { sourceStream: 1, sourceChannel: 3 }]))
      .toEqual([{ sourceStream: 1, sourceChannel: 0 }, { sourceStream: 1, sourceChannel: 3 }]);
  });

  it('沒有明細時依 fallbackCount 產生 0..n-1', () => {
    expect(sourceChannelDescriptors(null, 3))
      .toEqual([{ sourceStream: 0, sourceChannel: 0 }, { sourceStream: 0, sourceChannel: 1 }, { sourceStream: 0, sourceChannel: 2 }]);
  });

  it('兩者都沒有時回空陣列，不是 undefined', () => {
    expect(sourceChannelDescriptors()).toEqual([]);
  });
});

/* 這個模組能不能被無 mock 測試，取決於它有沒有偷偷把 runtime 拉進來。 */
describe('模組本身保持純淨', () => {
  it('不 import Media／Wave／Seq，也不碰 DOM', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
    const src = fs.readFileSync(path.join(root, 'src/external-audio.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\bdocument\b/);
    expect(code).not.toMatch(/\bState\b/);
  });
});
