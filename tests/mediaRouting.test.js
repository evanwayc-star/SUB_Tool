// @vitest-environment jsdom
/* 「這條聲道現在聽得到嗎」的判定必須只有一份。

   以前有兩份：media.js 的 projectRouteState（applyGains 用，含外部素材的
   placement gain）與 mixer.js 的 _busRouteTracks（電平表用，重寫了一份且漏掉
   placement gain）。兩者回答同一個問題卻各寫一次——外部音檔被停用時，
   實際增益是 0 但電平表照樣把它算進來，於是【表在跳、卻沒有聲音】。

   已收斂到 Media.trackAudible() / Media.routedTracksForBus()。
   這支測試鎖住那個修復，並鎖住 mixer 不會再自己過濾 Media.tracks。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* media.js 一路 import 到 ui.js，而 ui.js 在模組頂層就 $('modalBg').addEventListener()
   ——import 即產生副作用，所以必須把有 DOM 副作用的模組換成替身。
   這組替身沿用 tests/imageFirstVideoLifecycle.test.js 已建立的慣例。 */
const domMock = vi.hoisted(() => {
  const video = { style: {}, playbackRate: 1, hasAttribute: () => false };
  const elements = new Map();
  return {
    video,
    $(id) {
      if (!elements.has(id)) {
        elements.set(id, { style: {}, textContent: '', classList: { add: vi.fn(), remove: vi.fn() } });
      }
      return elements.get(id);
    },
  };
});
vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

let Media, State;

/* 只帶 routedTracksForBus 會讀到的欄位，其餘不建——這樣測試在
   Media 長出新欄位時不會無謂地壞掉。 */
const track = over => ({
  analyser: {}, audioSourceId: 'src1', sourceStream: 0, sourceChannel: 0,
  solo: false, muted: false, _srcHidden: false, volume: 1, ...over,
});

const projectWith = over => ({
  buses: [{ id: 'a1', name: 'A1', muted: false, solo: false, volume: 1 }],
  sourceMaps: {
    src1: { channels: [{ sourceStream: 0, sourceChannel: 0, enabled: true, gain: 1, busIds: ['a1'] }] },
  },
  ...over,
});

beforeEach(async () => {
  document.body.innerHTML = '';
  ({ Media } = await import('../src/media.js'));
  ({ State } = await import('../src/state.js'));
  State.audioProject = projectWith({});
  Media.tracks = [track()];
  Media.externalAudioSources = [];
});

describe('Media.routedTracksForBus', () => {
  it('正常配線的聲道會被算進該 bus', () => {
    expect(Media.routedTracksForBus('a1')).toHaveLength(1);
  });

  it('bus 靜音時不算', () => {
    State.audioProject.buses[0].muted = true;
    expect(Media.routedTracksForBus('a1')).toHaveLength(0);
  });

  it('別的 bus 獨奏時不算', () => {
    State.audioProject.buses.push({ id: 'a2', muted: false, solo: true, volume: 1 });
    expect(Media.routedTracksForBus('a1')).toHaveLength(0);
  });

  it('聲道自己靜音時不算', () => {
    Media.tracks = [track({ muted: true })];
    expect(Media.routedTracksForBus('a1')).toHaveLength(0);
  });

  it('有其他聲道獨奏時，未獨奏的不算', () => {
    Media.tracks = [track({ audioSourceId: 'src1' }), track({ solo: true, sourceChannel: 1 })];
    State.audioProject.sourceMaps.src1.channels.push(
      { sourceStream: 0, sourceChannel: 1, enabled: true, gain: 1, busIds: ['a1'] });
    const got = Media.routedTracksForBus('a1');
    expect(got).toHaveLength(1);
    expect(got[0].solo).toBe(true);
  });

  it('沒有 analyser 的聲道不算（電平表讀不到它）', () => {
    Media.tracks = [track({ analyser: null })];
    expect(Media.routedTracksForBus('a1')).toHaveLength(0);
  });

  it('配線被停用時不算', () => {
    State.audioProject.sourceMaps.src1.channels[0].enabled = false;
    expect(Media.routedTracksForBus('a1')).toHaveLength(0);
  });

  it('沒有 busId 就回空陣列，不會丟例外', () => {
    expect(Media.routedTracksForBus('')).toEqual([]);
    expect(Media.routedTracksForBus(null)).toEqual([]);
    expect(Media.routedTracksForBus(undefined)).toEqual([]);
  });
});

describe('Media.routedTrackStatesForBus', () => {
  it('回傳該 bus 真正收到的完整增益，不漏 route、placement 或 bus gain', () => {
    Media.tracks = [track({ volume: 0.5 })];
    Media.externalAudioSources = [{ audioSourceId: 'src1', enabled: true, gain: 0.5 }];
    State.audioProject.sourceMaps.src1.channels[0].gain = 0.25;
    State.audioProject.buses[0].volume = 0.8;

    const states = Media.routedTrackStatesForBus('a1');

    expect(states).toHaveLength(1);
    expect(states[0].track).toBe(Media.tracks[0]);
    expect(states[0].gain).toBeCloseTo(0.05);
  });
});

/* 這一組就是這次要修的 bug：外部素材的 placement gain 以前只有 applyGains 看得到。 */
describe('外部音訊素材的 placement gain（以前電平表看不到）', () => {
  beforeEach(() => {
    Media.externalAudioSources = [{ audioSourceId: 'src1', enabled: true, gain: 1 }];
  });

  it('外部素材啟用時算進去', () => {
    expect(Media.routedTracksForBus('a1')).toHaveLength(1);
  });

  it('外部素材【停用】時不算——修復前這裡表會跳但沒有聲音', () => {
    Media.externalAudioSources[0].enabled = false;
    expect(Media.routedTracksForBus('a1')).toHaveLength(0);
  });

  it('外部素材增益為 0 時不算', () => {
    Media.externalAudioSources[0].gain = 0;
    expect(Media.routedTracksForBus('a1')).toHaveLength(0);
  });
});

describe('trackAudible 與 applyGains 是同一套規則', () => {
  it('_srcHidden 的聲道一律不可聽', () => {
    expect(Media.trackAudible(track({ _srcHidden: true }))).toBe(false);
  });

  it('null / undefined 不丟例外', () => {
    expect(Media.trackAudible(null)).toBe(false);
    expect(Media.trackAudible(undefined)).toBe(false);
  });

  it('暫時隱藏的來源即使有 Solo，也不會讓目前監聽來源整組靜音', () => {
    Media.tracks = [
      track({ sourceChannel: 0 }),
      track({ sourceChannel: 1, solo: true, _srcHidden: true }),
    ];
    State.audioProject.sourceMaps.src1.channels.push(
      { sourceStream: 0, sourceChannel: 1, enabled: true, gain: 1, busIds: ['a1'] });

    expect(Media.trackAudible(Media.tracks[0])).toBe(true);
    expect(Media.trackAudible(Media.tracks[1])).toBe(false);
  });
});

describe('mixer.js 不再自己解讀 Media.tracks 的路由與增益', () => {
  /* 這是這次收斂的契約：判定的家在 media.js。
     若有人又在 mixer.js 重寫一份 solo/mute/busIds 判定，這裡就會紅。 */
  it('_busRouteStates 只使用 ProjectAudioInterpretation 編好的 bus 輸入', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/mixer.js'), 'utf8');
    const body = src.slice(src.indexOf('function _busRouteStates'));
    const fn = body.slice(0, body.indexOf('\n}') + 2);

    expect(fn).toMatch(/interpretation\.routedTrackStatesForBus\(/);
    expect(fn).not.toMatch(/Media\.tracks\.filter/);
    expect(fn).not.toMatch(/sourceMaps/);
    expect(src.match(/Media\.projectAudioInterpretation\(\)/g)).toHaveLength(1);
    expect(src).toMatch(/_trackLevel\(input\.track\)\s*\*\s*input\.gain/);
    expect(src).not.toMatch(/_trackLevel\(track\).*track\.volume.*busGain/);
  });
});
