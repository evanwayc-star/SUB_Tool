// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  applyGains: vi.fn(),
  activeSource: null,
  getSources: () => [],
  tracks: [],
  projectAudioInterpretation: () => ({
    routedTrackStatesForBus: () => [],
  }),
}));
vi.mock('../src/media.js', () => ({ Media: mediaMock, Wave: {} }));

let State, renderMixer, mixerZeroFaders, mixerCenterPans, mixerAdjustAllDb, applyDbStringToBus, updateMeters;
let seen;

beforeEach(async () => {
  vi.resetModules();
  mediaMock.applyGains.mockClear();
  document.body.innerHTML = `
    <div id="mixerPanel" class="show">
      <div id="mixerStrips"></div>
    </div>
  `;

  const { on } = await import('../src/events.js');
  ({ State } = await import('../src/state.js'));
  ({ renderMixer, mixerZeroFaders, mixerCenterPans, mixerAdjustAllDb, applyDbStringToBus, updateMeters } = await import('../src/mixer.js'));

  State.audioProject = {
    buses: [
      { id: 'ab1', name: 'Audio 1', muted: false, solo: false, volume: 1.0, pan: 0 },
      { id: 'ab2', name: 'Audio 2', muted: false, solo: false, volume: 0.5, pan: -0.5 },
    ],
    sourceMaps: {},
  };
  seen = [];
  on('audio:busChanged', d => seen.push(d));
});

describe('專業 DAW 調音台通道條 (Channel Strip) 介面與功能', () => {
  it('渲染通道條且不含聲像旋鈕與左右回中（依使用者聲道分配設置）', () => {
    renderMixer();

    const strips = document.querySelectorAll('#mixerStrips .mx-strip');
    expect(strips.length).toBe(2);

    // 檢查 A1 的精簡實用元件
    const strip1 = strips[0];
    // 已移除無用之 Mix 下拉、Read 模式、Rec 錄音鈕與聲像旋鈕
    expect(strip1.querySelector('.mx-dropdown-btn')).toBeNull();
    expect(strip1.querySelector('.mx-rec')).toBeNull();
    expect(strip1.querySelector('.mx-mode-badge')).toBeNull();
    expect(strip1.querySelector('.mx-pan-knob')).toBeNull();
    expect(strip1.querySelector('.mx-pan-container')).toBeNull();

    // 檢查真實有用的 M (靜音) 與 S (獨奏) 按鈕
    expect(strip1.querySelector('.mx-mute')).not.toBeNull();
    expect(strip1.querySelector('.mx-solo')).not.toBeNull();

    // 檢查推子與單音軌高解析波形電平表（預設單音軌，無左右雙條分裂）
    expect(strip1.querySelector('.mx-fader-scale')).not.toBeNull();
    expect(strip1.querySelector('.mx-fader')).not.toBeNull();
    expect(strip1.querySelector('.mx-clip-indicators')).not.toBeNull();
    expect(strip1.querySelector('.mx-channel-meter')).not.toBeNull();
    expect(strip1.querySelector('.mx-channel-meter.l')).toBeNull();
    expect(strip1.querySelector('.mx-channel-meter.r')).toBeNull();
    expect(strip1.querySelector('.mx-meter-scale')).not.toBeNull();

    // 檢查讀數標籤
    expect(strip1.querySelector('.mx-fader-val').textContent).toBe('0.0 dB');
    expect(strip1.querySelector('.mx-meter-val')).not.toBeNull();

    // 檢查頂部軌道標籤
    expect(strip1.querySelector('.mx-bus-label').textContent).toBe('A1');
    expect(strip1.querySelector('.mx-bus-name').textContent).toBe('Audio 1');
  });

  it('雙擊推子手柄回歸 0.0 dB (Unity Gain 1.0)', () => {
    renderMixer();
    const strip2 = document.querySelectorAll('#mixerStrips .mx-strip')[1];
    const fader = strip2.querySelector('.mx-fader');
    expect(fader.value).toBe('50');

    fader.dispatchEvent(new MouseEvent('dblclick'));

    expect(State.audioProject.buses[1].volume).toBe(1.0);
    expect(seen.some(e => e.busId === 'ab2' && e.field === 'volume' && e.value === 1.0)).toBe(true);
  });

  it('mixerZeroFaders 將所有音訊軌推子重設為 1.0 (0 dB)', () => {
    renderMixer();
    expect(State.audioProject.buses[1].volume).toBe(0.5);

    mixerZeroFaders();

    expect(State.audioProject.buses[0].volume).toBe(1.0);
    expect(State.audioProject.buses[1].volume).toBe(1.0);
    expect(seen.some(e => e.field === 'zeroFaders')).toBe(true);
  });

  it('mixerCenterPans 作為安全相容 safe no-op 不拋出異常', () => {
    expect(() => mixerCenterPans()).not.toThrow();
  });

  it('點擊削波指示燈可重設清除過載警示', () => {
    renderMixer();
    const strip = document.querySelector('#mixerStrips .mx-strip');
    const led = strip.querySelector('.mx-clip-led');
    led.classList.add('clip');
    expect(led.classList.contains('clip')).toBe(true);

    strip.querySelector('.mx-clip-indicators').click();
    expect(led.classList.contains('clip')).toBe(false);
  });

  it('個別軌道點擊讀數可輸入目標 dB 或相對增減 dB', () => {
    renderMixer();
    const strip1 = document.querySelector('#mixerStrips .mx-strip');
    const faderValEl = strip1.querySelector('.mx-fader-val');
    expect(faderValEl.textContent).toBe('0.0 dB');

    // 點擊觸發就地輸入
    faderValEl.click();
    const inlineInput = faderValEl.querySelector('.mx-fader-inline-input');
    expect(inlineInput).not.toBeNull();

    // 輸入 -6 dB
    inlineInput.value = '-6';
    inlineInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    // 驗證音量已換算為約 0.501 (-6 dB)
    expect(State.audioProject.buses[0].volume).toBeCloseTo(0.501, 2);
    expect(seen.some(e => e.busId === 'ab1' && e.field === 'volume')).toBe(true);
  });

  it('applyDbStringToBus 正確處理絕對 dB、相對增減與靜音', () => {
    const bus = { id: 'ab1', volume: 1.0 }; // 0 dB
    // 絕對值 -12 dB
    applyDbStringToBus(bus, '-12 dB', 0);
    expect(20 * Math.log10(bus.volume)).toBeCloseTo(-12, 1);

    // 相對增加 +2 dB -> -10 dB
    applyDbStringToBus(bus, '+2', 0);
    expect(20 * Math.log10(bus.volume)).toBeCloseTo(-10, 1);

    // 相對減少 -=3 dB -> -13 dB
    applyDbStringToBus(bus, '-=3', 0);
    expect(20 * Math.log10(bus.volume)).toBeCloseTo(-13, 1);

    // 靜音
    applyDbStringToBus(bus, '-inf', 0);
    expect(bus.volume).toBe(0);
  });

  it('mixerAdjustAllDb 一次對所有音訊軌同時增加或減少指定 dB 數', () => {
    renderMixer();
    // A1 原本為 1.0 (0.0 dB)，A2 原本為 0.5 (-6.02 dB)
    expect(State.audioProject.buses[0].volume).toBe(1.0);
    expect(State.audioProject.buses[1].volume).toBe(0.5);

    // 所有軌道同時 -3 dB
    mixerAdjustAllDb(-3);

    // A1: 0 - 3 = -3 dB (約 0.7079)
    // A2: -6.02 - 3 = -9.02 dB (約 0.354)
    expect(20 * Math.log10(State.audioProject.buses[0].volume)).toBeCloseTo(-3.0, 1);
    expect(20 * Math.log10(State.audioProject.buses[1].volume)).toBeCloseTo(-9.02, 1);
    expect(seen.some(e => e.field === 'adjustAllDb' && e.value === -3)).toBe(true);

    // 所有軌道同時 +2 dB
    mixerAdjustAllDb(2);
    expect(20 * Math.log10(State.audioProject.buses[0].volume)).toBeCloseTo(-1.0, 1);
    expect(20 * Math.log10(State.audioProject.buses[1].volume)).toBeCloseTo(-7.02, 1);
  });
});
