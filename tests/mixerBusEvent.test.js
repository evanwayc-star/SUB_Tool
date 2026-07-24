// @vitest-environment jsdom
/* 專案音訊 bus（A1…An）的 M／S／音量變更如何通知下游。
   來由與事件表見 docs/開發與驗證.md——那裡是唯一的完整說明，這裡只鎖行為。

   本檔【真的 import mixer.js 並點真實的 DOM 按鈕】，不是比對原始碼字串。
   上一版全部用 toMatch 掃原始碼，於是「測試全綠」只證明了字面沒被改掉，
   notifyBusChange 一次都沒被執行到——正是技術架構說明 §0.6
   「有產出不等於對」講的那種測了等於沒測。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* media.js 有 2800 行且與 mixer.js 互為 import，測試裡換成替身。
   它的訂閱端無法在這裡行為驗證，改以最後一節的原始碼契約 + 真機驗證涵蓋。 */
const mediaMock = vi.hoisted(() => ({
  applyGains: vi.fn(),
  activeSource: null,
  getSources: () => [],
  tracks: [],
}));
vi.mock('../src/media.js', () => ({ Media: mediaMock, Wave: {} }));

let on, State, renderAudioTracks, renderMixer, mixerMuteAll;
let seen;

beforeEach(async () => {
  vi.resetModules();
  mediaMock.applyGains.mockClear();
  document.body.innerHTML =
    '<div id="atList"></div>' +
    '<div id="mixerPanel" class="show"><div id="mixerStrips"></div></div>';

  ({ on } = await import('../src/events.js'));
  ({ State } = await import('../src/state.js'));
  ({ renderAudioTracks, renderMixer, mixerMuteAll } = await import('../src/mixer.js'));

  State.audioProject = {
    buses: [{ id: 'ab1', name: 'A1', muted: false, solo: false, volume: 1 }],
    sourceMaps: {},
  };
  seen = [];
  on('audio:busChanged', d => seen.push(d));
});

describe('混音器 UI → audio:busChanged', () => {
  it('點靜音鈕會翻轉狀態並發出事件（帶 busId / field / value）', () => {
    renderMixer();
    document.querySelector('#mixerStrips .mx-mute').click();

    expect(State.audioProject.buses[0].muted).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ busId: 'ab1', field: 'muted', value: true });
  });

  it('點獨奏鈕同樣發出事件', () => {
    renderMixer();
    document.querySelector('#mixerStrips .mx-solo').click();

    expect(State.audioProject.buses[0].solo).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ field: 'solo', value: true });
  });

  /* 音軌列（時間軸左側列頭）是第二個入口，與混音器面板共用 notifyBusChange。
     兩個入口都要測——只測一個的話，另一個被改壞不會有人發現。 */
  it('音軌列的靜音鈕走同一條路', () => {
    renderAudioTracks();
    document.querySelector('#atList .mute').click();

    expect(State.audioProject.buses[0].muted).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('全部靜音也發出事件', () => {
    mixerMuteAll();

    expect(State.audioProject.buses[0].muted).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ field: 'muteAll' });
  });
});

/* 拖曳推桿期間刻意【不】發事件：每次 input 都重繪整條時間軸太貴，只即時套增益，
   放開（change）才發事件做完整重繪。日後若有人「順手統一」成一律發事件，
   畫面不會壞、只會變卡——這種退步沒有測試就抓不到。 */
describe('拖曳音量推桿的快路徑', () => {
  it('拖曳中（input）只套增益，不發事件', () => {
    renderMixer();
    const fader = document.querySelector('#mixerStrips .mx-fader');
    fader.value = '40';
    fader.dispatchEvent(new Event('input'));

    expect(mediaMock.applyGains).toHaveBeenCalled();
    expect(State.audioProject.buses[0].volume).toBeCloseTo(0.4);
    expect(seen).toHaveLength(0);
  });

  it('放開（change）才發事件', () => {
    renderMixer();
    const fader = document.querySelector('#mixerStrips .mx-fader');
    fader.value = '40';
    fader.dispatchEvent(new Event('input'));
    fader.dispatchEvent(new Event('change'));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ field: 'volume' });
  });

  it('音量沒有實際變動時不發事件（避免空重繪）', () => {
    renderMixer();
    document.querySelector('#mixerStrips .mx-fader').dispatchEvent(new Event('change'));

    expect(seen).toHaveLength(0);
  });
});

describe('回歸防護', () => {
  /* 舊路徑必須真的不再有人發；在 jsdom 裡可直接行為驗證，不必比對原始碼。 */
  it('不再繞道 window CustomEvent', () => {
    const spy = vi.fn();
    window.addEventListener('audio-project:bus-change', spy);

    renderMixer();
    document.querySelector('#mixerStrips .mx-mute').click();

    expect(spy).not.toHaveBeenCalled();
  });

  it('沒有訂閱者時 emit 是靜默 no-op（這正是死事件當初沒被發現的原因）', async () => {
    const { emit } = await import('../src/events.js');
    expect(() => emit('audio:nobodyListens', { x: 1 })).not.toThrow();
  });

  /* 上面所有測試都把 media.js 換成替身，因此驗不到「真的有人訂閱」。
     這一條是唯一的原始碼契約：接收端還在，且沒有退回 window 事件。
     實際的重繪效果由真機驗證涵蓋（見 docs/開發與驗證.md §3）。 */
  it('media.js 仍訂閱 audio:busChanged，且兩端都無 window 事件殘留', () => {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const stripComments = s =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(read('src/media.js')).toMatch(/on\('audio:busChanged'/);
    expect(stripComments(read('src/media.js'))).not.toContain('audio-project:bus-change');
    expect(stripComments(read('src/mixer.js'))).not.toContain('audio-project:bus-change');
  });
});
