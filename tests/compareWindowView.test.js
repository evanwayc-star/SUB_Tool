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
  it('收到新plan時清掉舊選單，不得用最新revision包裝先前pair IDs', () => {
    const { dom, callbacks, commands } = openCompareView();
    callbacks[0](planPayload());
    const left = dom.window.document.querySelector('[data-cue-id="left"]');
    left.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
    expect(dom.window.document.getElementById('ctxMenu').classList.contains('show')).toBe(true);
    const next = planPayload();
    next.revision = 5;
    next.plan.rows[0].right.id = 'new-source';
    callbacks[0](next);
    expect(dom.window.document.getElementById('ctxMenu').classList.contains('show')).toBe(false);
    dom.window.document.getElementById('miMatchStyle').click();
    expect(commands).toEqual([]);
    const fresh = dom.window.document.querySelector('[data-cue-id="left"]');
    fresh.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
    dom.window.document.getElementById('miMatchStyle').click();
    expect(commands).toEqual([{ type: 'match-style', revision: 5, targetCueId: 'left', sourceCueId: 'new-source' }]);
    dom.window.close();
  });

  it('比對列重繪關閉舊選單與命令context', () => {
    const { dom, callbacks, commands } = openCompareView();
    callbacks[0](planPayload());
    dom.window.document.querySelector('[data-cue-id="left"]')
      .dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
    const toggle = dom.window.document.getElementById('hideIdentical');
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event('change'));
    dom.window.document.getElementById('miMatchStyle').click();
    expect(commands).toEqual([]);
    dom.window.close();
  });

  it.each([
    ['a&b', 'a<b'], ['&amp;', '&lt;'], ['"a\'b>', '"a\'b<'],
    ['前😀後', '前😁後'], ['', '<img src=x onerror="throw 1">'],
  ])('保留特殊字元原文並以完整字元標示差異：%s / %s', (left, right) => {
    const { dom, callbacks } = openCompareView();
    const payload = planPayload();
    payload.plan.rows[0].left.text = left;
    payload.plan.rows[0].right.text = right;
    callbacks[0](payload);
    const cells = [...dom.window.document.querySelectorAll('.txt')];
    expect(cells.map(cell => cell.textContent)).toEqual([left, right]);
    expect(dom.window.document.querySelector('img')).toBeNull();
    if (left.includes('😀')) expect(cells[0].querySelector('.diff-text').textContent).toBe('😀');
    dom.window.close();
  });

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
