// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let Commands;
let State;
let clearSelection;
let setSelection;

beforeAll(async () => {
  document.documentElement.innerHTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  Object.defineProperty(window, 'subtool', { configurable: true, value: undefined });
  const gradient = { addColorStop: vi.fn() };
  const canvasContext = new Proxy({
    canvas: { width: 1920, height: 1080 },
    createLinearGradient: () => gradient,
    measureText: text => ({ width: String(text || '').length * 8 }),
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => undefined;
    },
  });
  HTMLCanvasElement.prototype.getContext = () => canvasContext;
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
  ({ State, clearSelection, setSelection } = await import('../src/state.js'));
  const { createCommands } = await import('../src/commands.js');
  Commands = createCommands();
});

beforeEach(() => {
  State.tracks = [{ name: '來源', fontSize: 60 }, { name: '目標', fontSize: 60 }];
  State.cues = [
    { id: 'source', track: 0, start: 0, end: 1, text: '來源', style: { fontSize: 80 } },
    { id: 'target', track: 1, start: 1, end: 2, text: '目標', style: { fontSize: 70 } },
  ];
  State.listTrack = 0;
  State.duration = 0;
  State.mediaPath = '';
  State.subMode = false;
  document.body.classList.remove('sub-mode-on');
  document.querySelectorAll('.float-panel.show').forEach(panel => panel.classList.remove('show'));
  clearSelection();
});

describe('command registry dispatch', () => {
  it('open-media 會把明確 relink 交給 project transaction，過期 generation 不開 picker', async () => {
    const picker = document.getElementById('fileMedia');
    const pickerClick = vi.spyOn(picker, 'click').mockImplementation(() => picker.onchange?.());
    try {
      await Commands.run('open-media', {
        relink: { generation: Number.MIN_SAFE_INTEGER, plan: {} },
      });
      expect(pickerClick).not.toHaveBeenCalled();
    } finally {
      pickerClick.mockRestore();
    }
  });

  it('copy-style → paste-style 透過公開指令介面套用最小 cue override', () => {
    setSelection({ kind: 'sub', ids: ['source'] });
    Commands.run('copy-style');
    setSelection({ kind: 'sub', ids: ['target'] });

    Commands.run('paste-style');

    expect(State.cues[1].style).toEqual({ fontSize: 80 });
    expect(document.getElementById('stMsg').textContent).toBe('已貼上樣式');
  });

  it('new 指令自行關閉上字幕模式，不依賴 app.js 再分派一次', async () => {
    State.subMode = true;
    document.body.classList.add('sub-mode-on');

    Commands.run('new');
    const confirm = [...document.querySelectorAll('#modalFoot button')]
      .find(button => button.textContent.includes('確定清空'));
    expect(confirm).toBeTruthy();

    await confirm.onclick();

    expect(State.subMode).toBe(false);
    expect(document.body.classList.contains('sub-mode-on')).toBe(false);
  });

  it('shift-tc 經 registry 使用同一個 panel action 開關面板', () => {
    const panel = document.getElementById('shiftPanel');

    Commands.run('shift-tc');
    expect(panel.classList.contains('show')).toBe(true);

    Commands.run('shift-tc');
    expect(panel.classList.contains('show')).toBe(false);
  });

  it('copy-track 經 registry 複製目前軌道與字幕並切到新軌', async () => {
    State.tracks = [{ name: '對白', fontSize: 72 }];
    State.cues = [{ id: 'cue-1', track: 0, start: 1, end: 2, text: '內容', timed: true }];

    Commands.run('copy-track');
    const confirm = [...document.querySelectorAll('#modalFoot button')]
      .find(button => button.textContent.includes('含文字內容'));
    expect(confirm).toBeTruthy();
    await confirm.onclick();

    expect(State.tracks).toHaveLength(2);
    expect(State.tracks[1]).toMatchObject({ name: '對白_複製', fontSize: 72 });
    expect(State.cues.find(cue => cue.track === 1)).toMatchObject({ text: '內容', start: 1, end: 2 });
    expect(State.listTrack).toBe(1);
  });

  it('桌面限定 action 都由 registry 回報可觀察的 fallback', async () => {
    await Commands.run('screenshot');
    expect(document.getElementById('toast').textContent).toBe('尚未載入影音');

    await Commands.run('cache-manage');
    expect(document.getElementById('toast').textContent).toBe('快取管理僅在桌面版可用');
  });
});
