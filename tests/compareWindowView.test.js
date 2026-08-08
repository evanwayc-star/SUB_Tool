import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../electron/compare.html', import.meta.url), 'utf8');

function openCompareView() {
  const callbacks = [];
  const commands = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.subtool = {
        onUpdateData: callback => callbacks.push(callback),
        sendCommand: command => commands.push(command),
      };
    },
  });
  return { dom, callbacks, commands };
}

function planPayload(overrides = {}) {
  return {
    revision: 4,
    plan: {
      tracks: [{ index: 0, name: 'Left' }, { index: 1, name: 'Right' }],
      selection: { leftTrack: 0, rightTrack: 1 },
      checks: { time: true, text: true, style: true },
      rows: [{
        left: { id: 'left', startTimecode: '00:59:56:12', endTimecode: '01:00:00:00', text: '左' },
        right: { id: 'right', startTimecode: '00:59:56:12', endTimecode: '01:00:00;00', text: '右' },
        leftIndex: 1,
        rightIndex: 1,
        difference: { missing: false, time: true, text: true, style: true, styleKeys: ['fontSize'], any: true },
        active: { missing: false, time: true, text: true, style: true, any: true },
      }],
      ...overrides,
    },
  };
}

describe('字幕比對視窗 view adapter', () => {
  it('只渲染 session 傳來的 plan，不自行重算時碼', () => {
    const { dom, callbacks } = openCompareView();
    callbacks[0](planPayload());

    expect(dom.window.document.querySelector('.tc').textContent).toContain('00:59:56:12');
    expect(dom.window.document.querySelectorAll('.cell[data-cue-id]')).toHaveLength(2);
    dom.window.close();
  });

  it('點擊與樣式匹配只送 stable ID + revision command', () => {
    const { dom, callbacks, commands } = openCompareView();
    callbacks[0](planPayload());
    const left = dom.window.document.querySelector('[data-cue-id="left"]');
    left.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(commands).toEqual([{ type: 'seek', revision: 4, cueId: 'left' }]);

    left.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 30 }));
    dom.window.document.getElementById('miMatchStyle')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(commands[1]).toEqual({
      type: 'match-style', revision: 4, targetCueId: 'left', sourceCueId: 'right',
    });
    dom.window.close();
  });
});
