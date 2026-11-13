// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({
  applyGains: vi.fn(), activeSource: null, displayTime: () => 0, getSources: () => [],
  externalAudio: { list: () => [], get: () => null }, tracks: [],
  projectAudioInterpretation: vi.fn(), clearNativeMeter: vi.fn(),
}));
vi.mock('../src/media.js', () => ({ Media: media, Wave: {} }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), drawRuler: vi.fn() }));

let State, History, mixer;
const bus = index => State.audioProject.buses[index];
const strip = index => document.querySelectorAll('.mx-strip')[index];
const gainDb = volume => 20 * Math.log10(volume);
const press = (index, selector) => strip(index).querySelector(selector).click();
const wheel = (index, deltaY) => strip(index).querySelector('.mx-fader-val')
  .dispatchEvent(new WheelEvent('wheel', { deltaY, cancelable: true }));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="toast"></div><div id="atList"></div>'
    + '<div id="mixerPanel" class="show"><button data-act="mixer-muteall"></button><div id="mixerStrips"></div></div>';
  ({ State } = await import('../src/state.js'));
  ({ History } = await import('../src/history.js'));
  const { on } = await import('../src/events.js');
  const { createProjectAudioInterpretation } = await import('../src/project-audio.js');
  mixer = await import('../src/mixer.js');
  State.audioProject = {
    buses: [{ id: 'left', name: 'Left', volume: 1, muted: false, solo: false },
      { id: 'right', name: 'Right', volume: 1, muted: false, solo: false }],
    sourceMaps: { source: { channels: [
      { sourceStream: 0, sourceChannel: 0, enabled: true, gain: 1, busIds: ['left'] },
      { sourceStream: 0, sourceChannel: 1, enabled: true, gain: 1, busIds: ['right'] },
    ] } },
  };
  State.muted = false;
  media.tracks = [0, 1].map(sourceChannel => ({ kind: 'element', volume: 1,
    audioSourceId: 'source', sourceStream: 0, sourceChannel, meterPeak: sourceChannel ? .25 : .5 }));
  media.projectAudioInterpretation.mockImplementation(() => createProjectAudioInterpretation({
    audioProject: State.audioProject, mediaTracks: media.tracks,
  }));
  on('history:record', label => History.record(label));
  History.reset();
  mixer.renderAudioTracks();
});
afterEach(() => { History?.reset(); vi.restoreAllMocks(); });

describe('混音器完整控制與持久狀態', () => {
  const audible = () => media.tracks.map(track => media.projectAudioInterpretation().trackState(track).audible);

  it.each([.6, -.6])('同一 bus 的 WebAudio PCM .6 與 %s 先混合再量測，不能取來源最大峰值', second => {
    State.audioProject.sourceMaps.source.channels[1].busIds = ['left'];
    for (const [index, track] of media.tracks.entries()) {
      delete track.meterPeak;
      track.analyser = { fftSize: 32, getFloatTimeDomainData: values => values.fill(index ? second : .6) };
    }
    mixer.updateMeters();
    expect(strip(0).querySelector('.mx-meter-val').textContent).toBe(second > 0 ? '+1.6' : '-∞');
    expect(strip(0).querySelector('.mx-clip-led').classList.contains('clip')).toBe(second > 0);
  });

  it('全域靜音讓 WebAudio 音柱與即時讀數歸底，但保留曾經削波的提示', () => {
    media.tracks[0].meterPeak = 1.1; mixer.updateMeters(); State.muted = true;
    for (let index = 0; index < 70; index++) mixer.updateMeters();
    expect(strip(0).querySelector('.mx-meter-val').textContent).toBe('-∞');
    expect(strip(0).querySelector('.mx-mask').style.height).toBe('100%');
    expect(strip(0).querySelector('.mx-clip-led').classList.contains('clip')).toBe(true);
  });

  it('原生多聲道使用後端已混合的 bus 峰值一次，不再套用 gain 或取各聲道峰值', () => {
    State.audioProject.sourceMaps.source.channels[1].busIds = ['left']; bus(0).volume = .5;
    const busLevels = [{ busId: 'left', level: .6 }];
    for (const track of media.tracks) Object.assign(track, { meterPeak: .9, meterBusLevels: busLevels });
    mixer.updateMeters();
    expect(strip(0).querySelector('.mx-meter-val').textContent).toBe('-4.4');
  });

  it('原生與 WebAudio 交錯時不假造相位混音峰值，快取接管後恢復真實讀值', () => {
    State.audioProject.sourceMaps.source.channels[1].busIds = ['left'];
    Object.assign(media.tracks[0], { meterBusLevels: [{ busId: 'left', level: .6 }] });
    delete media.tracks[1].meterPeak;
    media.tracks[1].analyser = { fftSize: 32, getFloatTimeDomainData: values => values.fill(.6) };
    mixer.updateMeters();
    expect(strip(0).querySelector('.mx-meter-val').textContent).toBe('—');
    expect(strip(0).querySelector('.mx-meter-val').title).toContain('尚無同步電平資料');
    delete media.tracks[0].meterBusLevels; delete media.tracks[0].meterPeak;
    media.tracks[0].analyser = { fftSize: 32, getFloatTimeDomainData: values => values.fill(.6) };
    mixer.updateMeters();
    expect(strip(0).querySelector('.mx-meter-val').textContent).toBe('+1.6');
  });

  it('獨奏單一 bus 只保留對應來源，允許多選獨奏，M 仍優先，Undo/Redo 同步恢復', () => {
    press(0, '.mx-solo');
    expect(audible()).toEqual([true, false]);
    mixer.updateMeters();
    expect(strip(0).querySelector('.mx-meter-val').textContent).toBe('-6.0');
    expect(strip(1).querySelector('.mx-meter-val').textContent).toBe('-∞');
    press(1, '.mx-solo'); expect(audible()).toEqual([true, true]);
    press(0, '.mx-mute'); expect(audible()).toEqual([false, true]);
    History.undo(); expect(audible()).toEqual([true, true]);
    History.undo(); expect(audible()).toEqual([true, false]);
    History.redo(); expect(audible()).toEqual([true, true]);
    expect(History.stack).toHaveLength(4);
  });

  it.each([['.mx-mute', 'muted'], ['.mx-solo', 'solo']])('%s 切換及同步重繪後保留同 bus 的按鈕焦點與按下狀態', async (selector, field) => {
    const { on } = await import('../src/events.js');
    // 真 Media 的 bus-change 訂閱端會先同步重繪，click handler 隨後還會重繪。
    on('audio:busChanged', () => mixer.renderAudioTracks());
    const original = strip(1).querySelector(selector);
    original.focus(); original.click();
    const active = strip(1).querySelector(selector);
    expect(original.isConnected).toBe(false);
    expect(document.activeElement).toBe(active);
    expect(bus(1)[field]).toBe(true);
    expect(active.getAttribute('aria-pressed')).toBe('true');
    active.click();
    expect(document.activeElement).toBe(strip(1).querySelector(selector));
    expect(bus(1)[field]).toBe(false);
    expect(document.activeElement.getAttribute('aria-pressed')).toBe('false');
    expect(History.stack).toHaveLength(3);
  });

  it('M/S 按下狀態反映各自 bus truth，不把其他獨奏造成的不可聽當作靜音', () => {
    press(0, '.mx-solo');
    expect(audible()).toEqual([true, false]);
    expect(strip(0).querySelector('.mx-solo').getAttribute('aria-pressed')).toBe('true');
    expect(strip(1).querySelector('.mx-mute').getAttribute('aria-pressed')).toBe('false');
    expect(strip(1).querySelector('.mx-solo').getAttribute('aria-pressed')).toBe('false');
    History.undo(); mixer.renderMixer();
    expect(strip(0).querySelector('.mx-solo').getAttribute('aria-pressed')).toBe('false');
  });

  it('M/S 重繪以 bus.id 恢復焦點，不因音軌排序改到其他 bus', async () => {
    const { on } = await import('../src/events.js');
    on('audio:busChanged', () => State.audioProject.buses.reverse());
    const original = strip(1).querySelector('.mx-mute');
    original.focus(); original.click();
    expect(document.activeElement).toBe(strip(0).querySelector('.mx-mute'));
    expect(document.activeElement.closest('.mx-strip').dataset.busId).toBe('right');
    expect(bus(0).muted).toBe(true);
    expect(bus(1).muted).toBe(false);
  });

  it.each([false, true])('M/S 切換前或通知期間焦點交給其他控制時不搶回（通知期間：%s）', async duringChange => {
    const { on } = await import('../src/events.js');
    const outside = document.createElement('button'); document.body.append(outside);
    const original = strip(0).querySelector('.mx-mute');
    if (duringChange) {
      original.focus(); on('audio:busChanged', () => outside.focus());
    } else outside.focus();
    original.click();
    expect(bus(0).muted).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it('同 id 的 bus 被替換後不把舊按鈕焦點交給新物件', async () => {
    const { on } = await import('../src/events.js');
    on('audio:busChanged', () => { State.audioProject.buses[0] = { ...bus(0) }; });
    const original = strip(0).querySelector('.mx-solo');
    original.focus(); original.click();
    expect(original.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('時間軸列的 M/S 與混音器使用相同 bus，只有選中的來源可聽', () => {
    document.querySelectorAll('#atList .solo')[1].click();
    expect(audible()).toEqual([false, true]);
    expect(strip(1).querySelector('.mx-solo').classList.contains('on')).toBe(true);
    document.querySelectorAll('#atList .mute')[1].click();
    expect(audible()).toEqual([false, false]);
    expect(strip(1).querySelector('.mx-mute').classList.contains('on')).toBe(true);
  });

  it('全靜音切換會解除獨奏，保留增益，整次動作可復原', () => {
    bus(0).volume = .5; bus(0).solo = true; History.reset();
    mixer.mixerMuteAll();
    expect(State.audioProject.buses.map(({ muted, solo, volume }) => [muted, solo, volume]))
      .toEqual([[true, false, .5], [true, false, 1]]);
    expect(audible()).toEqual([false, false]);
    expect(document.querySelector('[data-act="mixer-muteall"]').textContent).toContain('取消靜音');
    mixer.mixerMuteAll(); expect(audible()).toEqual([true, true]);
    History.undo(); expect(audible()).toEqual([false, false]);
    History.undo(); expect(bus(0)).toMatchObject({ volume: .5, solo: true, muted: false });
  });

  it('歸零只恢復增益，完整重設另解除 M/S，保留來源配線及左右名稱', () => {
    bus(0).volume = .5; bus(0).muted = true; bus(1).solo = true;
    const routes = structuredClone(State.audioProject.sourceMaps); History.reset();
    mixer.mixerZeroFaders();
    expect(bus(0)).toMatchObject({ volume: 1, muted: true }); expect(bus(1).solo).toBe(true);
    mixer.mixerReset();
    expect(State.audioProject.buses.map(({ volume, muted, solo }) => [volume, muted, solo]))
      .toEqual([[1, false, false], [1, false, false]]);
    expect(State.audioProject.sourceMaps).toEqual(routes);
    expect(State.audioProject.buses.map(item => item.name)).toEqual(['Left', 'Right']);
    History.undo(); expect(bus(0).muted).toBe(true); expect(bus(1).solo).toBe(true);
    History.undo(); expect(bus(0).volume).toBe(.5);
  });

  it.each(['mixerZeroFaders', 'mixerReset'])('%s 不讓尚未放開的 0 dB 草稿取消已確認歸零', action => {
    bus(0).volume = .5; History.reset(); mixer.renderMixer();
    const fader = strip(0).querySelector('.mx-fader');
    fader.value = '100'; fader.dispatchEvent(new Event('input'));
    expect(bus(0).volume).toBe(1);
    mixer[action]();
    expect(bus(0).volume).toBe(1);
    expect(History.committedSnapshot().audioProject.buses[0].volume).toBe(1);
    expect(History.stack).toHaveLength(2);
    History.undo(); expect(bus(0).volume).toBe(.5);
    History.redo(); expect(bus(0).volume).toBe(1);
  });

  it.each(['.mx-fader', '#atList input[type=range]'])('%s 完整呈現 +12 dB 增益，未移動的 change 不偷改音量', selector => {
    mixer.applyDbStringToBus(bus(0), '12', 0);
    const previous = bus(0).volume, steps = History.stack.length;
    const fader = document.querySelector(selector);
    expect(Number(fader.value) / 100).toBeCloseTo(previous, 6);
    fader.dispatchEvent(new Event('change'));
    expect(bus(0).volume).toBe(previous); expect(History.stack).toHaveLength(steps);
    expect(strip(0).querySelector('.mx-fader-val').textContent).toBe('+12.0 dB');
  });

  it('低音量讀數使用完整 gain，兩處推子不把 -50 dB 截斷為零', () => {
    mixer.applyDbStringToBus(bus(0), '-50', 0);
    expect(strip(0).querySelector('.mx-fader-val').textContent).toBe('-50.0 dB');
    for (const selector of ['.mx-fader', '#atList input[type=range]']) {
      expect(Number(document.querySelector(selector).value) / 100).toBe(bus(0).volume);
    }
  });

  it('由 -∞ 向上滾輪可恢復非零增益，往下回到零且可 Undo', () => {
    bus(0).volume = 0; History.reset(); mixer.renderMixer();
    wheel(0, -1);
    expect(bus(0).volume).toBeGreaterThan(0);
    expect(gainDb(bus(0).volume)).toBeCloseTo(-59.5, 0);
    expect(strip(0).querySelector('.mx-fader-val').textContent).not.toContain('∞');
    wheel(0, 1); expect(bus(0).volume).toBe(0);
    History.undo(); expect(bus(0).volume).toBeGreaterThan(0);
  });

  it('手動 dB、+=/-=、滾輪、全體增減與雙擊均提交可復原的 gain', async () => {
    mixer.applyDbStringToBus(bus(0), '-6', 0);
    mixer.applyDbStringToBus(bus(0), '+2', 0); expect(gainDb(bus(0).volume)).toBeCloseTo(-4, 1);
    mixer.applyDbStringToBus(bus(0), '-=2', 0); expect(gainDb(bus(0).volume)).toBeCloseTo(-6, 1);
    mixer.applyDbStringToBus(bus(0), '+=1', 0); expect(gainDb(bus(0).volume)).toBeCloseTo(-5, 1);
    wheel(0, -1); expect(gainDb(bus(0).volume)).toBeCloseTo(-4.5, 1);
    await mixer.mixerAdjustAllDb(-1); expect(gainDb(bus(0).volume)).toBeCloseTo(-5.5, 1);
    expect(gainDb(bus(1).volume)).toBeCloseTo(-1, 1);
    strip(0).querySelector('.mx-fader').dispatchEvent(new MouseEvent('dblclick'));
    expect(bus(0).volume).toBe(1); History.undo(); expect(gainDb(bus(0).volume)).toBeCloseTo(-5.5, 1);
  });

  it('推子預覽 Escape 取消且不留 History；inline Escape 不提交', () => {
    const fader = strip(0).querySelector('.mx-fader');
    fader.value = '40'; fader.dispatchEvent(new Event('input'));
    fader.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(bus(0).volume).toBe(1); expect(History.stack).toHaveLength(1);
    press(0, '.mx-fader-val');
    const input = strip(0).querySelector('input[type=text]'); input.value = '-12';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(bus(0).volume).toBe(1); expect(History.stack).toHaveLength(1);
  });

  it('削波保持直到點擊清除，不被另一個 bus 的控制重繪清除', () => {
    media.tracks[0].meterPeak = 1.1; mixer.updateMeters();
    expect(strip(0).querySelector('.mx-clip-led').classList.contains('clip')).toBe(true);
    media.tracks[0].meterPeak = .1; mixer.updateMeters();
    press(1, '.mx-mute'); mixer.updateMeters();
    expect(strip(0).querySelector('.mx-clip-led').classList.contains('clip')).toBe(true);
    const steps = History.stack.length;
    press(0, '.mx-clip-indicators');
    expect(strip(0).querySelector('.mx-clip-led').classList.contains('clip')).toBe(false);
    expect(History.stack).toHaveLength(steps);
  });

  it('peak hold 至少保留 900 ms 後下降，左右來源只按配線進入各自 bus', () => {
    const time = vi.spyOn(performance, 'now').mockReturnValue(100);
    bus(0).pan = 1; bus(1).pan = -1;
    mixer.updateMeters();
    expect(strip(0).querySelector('.mx-meter-val').textContent).toBe('-6.0');
    expect(strip(1).querySelector('.mx-meter-val').textContent).toBe('-12.0');
    const peak = parseFloat(strip(0).querySelector('.mx-peak').style.bottom);
    media.tracks[0].meterPeak = .01; time.mockReturnValue(999); mixer.updateMeters();
    expect(parseFloat(strip(0).querySelector('.mx-peak').style.bottom)).toBe(peak);
    time.mockReturnValue(1001); mixer.updateMeters();
    expect(parseFloat(strip(0).querySelector('.mx-peak').style.bottom)).toBeLessThan(peak);
    const before = structuredClone(State.audioProject); mixer.mixerCenterPans();
    expect(State.audioProject).toEqual(before);
  });
});
