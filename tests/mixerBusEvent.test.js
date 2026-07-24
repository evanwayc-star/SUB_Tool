/* 專案音訊 bus 變更的通知路徑。
   ── 背景：mixer.js 的 notifyBusChange 以前同時發 events.js 的 `audio:busChanged`
      與 window CustomEvent `audio-project:bus-change`。前者【從來沒有訂閱者】，
      實際生效的是後者；而 events.js 的 emit 在無 handler 時是靜默 no-op，
      所以這個死事件一直沒被發現。已收斂成單一路徑（events.js），本檔鎖住它。
   ── live=true（拖曳推桿中）刻意【不】發事件：每次 input 都重繪整條時間軸太貴，
      只套增益即可。這個區分也一併鎖住，避免日後「順手統一」而讓拖曳變卡。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({ applyGains: vi.fn(), tracks: [] }));
vi.mock('../src/media.js', () => ({ Media: mediaMock, Wave: {} }));
vi.mock('../src/dom.js', () => ({ $: () => null }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn() }));

let emit, on, State, notifyBusChangeViaUI;

beforeEach(async () => {
  vi.resetModules();
  mediaMock.applyGains.mockClear();
  ({ emit, on } = await import('../src/events.js'));
  ({ State } = await import('../src/state.js'));
});

describe('audio:busChanged 事件連線', () => {
  it('emit 後訂閱者會收到，且帶上 busId / field / value', () => {
    const seen = [];
    on('audio:busChanged', d => seen.push(d));
    emit('audio:busChanged', { busId: 'ab1', bus: { id: 'ab1' }, field: 'muted', value: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ busId: 'ab1', field: 'muted', value: true });
  });

  it('沒有訂閱者時 emit 是靜默 no-op（這正是死事件當初沒被發現的原因）', () => {
    expect(() => emit('audio:nobodyListens', { x: 1 })).not.toThrow();
  });
});

/* 以原始碼斷言鎖住兩端的連線——直接 import mixer.js 會把整個 DOM 渲染層拉進來，
   而這裡要守的是「發送端與接收端都還在、且沒有退回 window 事件」這個契約。 */
describe('通知路徑沒有退回 window CustomEvent', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.resolve(__dirname, '..');
  const mixer = fs.readFileSync(path.join(ROOT, 'src/mixer.js'), 'utf8');
  const media = fs.readFileSync(path.join(ROOT, 'src/media.js'), 'utf8');

  it('mixer.js 以 events.js 發送', () => {
    expect(mixer).toMatch(/emit\('audio:busChanged'/);
  });

  it('media.js 確實有訂閱它', () => {
    expect(media).toMatch(/on\('audio:busChanged'/);
  });

  it('不再有人 dispatch 或監聽 audio-project:bus-change（註解除外）', () => {
    const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(strip(mixer)).not.toContain('audio-project:bus-change');
    expect(strip(media)).not.toContain('audio-project:bus-change');
  });

  it('live=true 仍走「只套增益、不發事件」的快路徑', () => {
    const fn = mixer.slice(mixer.indexOf('function notifyBusChange'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/if\(live\)\{\s*Media\.applyGains\(\);\s*return;/);
  });
});
