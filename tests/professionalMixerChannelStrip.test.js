// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  applyGains: vi.fn(),
  activeSource: null,
  getSources: () => [],
  tracks: [],
  projectAudioInterpretation: vi.fn(),
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
  const { createProjectAudioInterpretation } = await import('../src/project-audio.js');
  mediaMock.tracks = [];
  mediaMock.projectAudioInterpretation.mockImplementation(() => createProjectAudioInterpretation({
    audioProject: State.audioProject, mediaTracks: mediaMock.tracks,
  }));
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

describe('音量表實際電平', () => {
  function sourceTrack({ channel = 0, name = 'L', level = 0.5, busIds = ['ab1'] } = {}) {
    const track = {
      name, sourceChannel: channel, sourceStream: 0, audioSourceId: 'meter-source',
      kind: 'element', volume: 1,
      analyser: { fftSize: 32, getFloatTimeDomainData: data => data.fill(level) },
    };
    mediaMock.tracks.push(track);
    State.audioProject.sourceMaps['meter-source'] = { channels: [
      { sourceStream: 0, sourceChannel: channel, enabled: true, gain: 1, busIds },
    ] };
    return track;
  }

  const firstStrip = () => document.querySelector('#mixerStrips .mx-strip');
  const visibleHeight = strip => 100 - parseFloat(strip.querySelector('.mx-mask').style.height);

  it('同一音軌由小聲變大聲時，數字與音柱同步升高，靜音後回到底部', () => {
    const track = sourceTrack({ level: 0.01 });
    renderMixer();
    updateMeters();
    const strip = firstStrip();
    expect(strip.querySelector('.mx-meter-val').textContent).toBe('-40.0');
    const quietHeight = visibleHeight(strip);

    track.analyser.getFloatTimeDomainData = data => data.fill(0.5);
    updateMeters();
    expect(strip.querySelector('.mx-meter-val').textContent).toBe('-6.0');
    expect(visibleHeight(strip)).toBeGreaterThan(quietHeight);

    State.audioProject.buses[0].muted = true;
    for (let i = 0; i < 60; i++) updateMeters();
    expect(strip.querySelector('.mx-meter-val').textContent).toBe('-∞');
    expect(visibleHeight(strip)).toBe(0);
  });

  it('同一來源配到不同 bus，分別顯示該 bus 推子套用後的電平', () => {
    sourceTrack({ busIds: ['ab1', 'ab2'] });
    State.audioProject.buses[1].pan = 0;
    renderMixer();
    updateMeters();
    const strips = document.querySelectorAll('#mixerStrips .mx-strip');
    expect(strips[0].querySelector('.mx-meter-val').textContent).toBe('-6.0');
    expect(strips[1].querySelector('.mx-meter-val').textContent).toBe('-12.0');
    expect(visibleHeight(strips[0])).toBeGreaterThan(visibleHeight(strips[1]));
  });

  it.each([
    { channel: 0, name: 'L', pan: 1 },
    { channel: 1, name: 'R', pan: -1 },
  ])('單聲道 bus 不因來源 $name 或舊 pan=$pan 設定而漏顯示', ({ channel, name, pan }) => {
    sourceTrack({ channel, name });
    State.audioProject.buses[0].pan = pan;
    renderMixer();
    updateMeters();
    expect(firstStrip().querySelector('.mx-meter-val').textContent).toBe('-6.0');
    expect(visibleHeight(firstStrip())).toBeGreaterThan(0);
  });
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
    const bus = State.audioProject.buses[0]; // 當前專案的 A1，0 dB
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
